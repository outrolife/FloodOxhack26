#!/usr/bin/env python3
"""Team status board for River Clock.

Every Claude session (and every human) has ONE status file, status/<name>.md,
stored on a dedicated `status` branch on origin. Nobody ever edits another
person's file, so concurrent pushes never conflict: on a rejected push we just
re-fetch and re-apply our single file on top.

The `status` branch is written with git plumbing, so this never touches your
working tree, your index, or the branch you are working on.

Commands
  whoami NAME ROLE [--force] set this checkout's identity (stored in .claude/agent.json, gitignored)
  board                     fetch origin and print the team board (used by hooks)
  set [--state S] [--issue N] [--task T] [--next T] [--needs T] [--notes T]
                            update your status and push it
  heartbeat                 refresh auto fields (branch, commit, time) and push; used by the Stop hook
  init                      create the status branch on origin if it does not exist
  feed [--since 3h] [--json]
                            read-only timeline: status changes, claims, commits on every branch,
                            PRs and issue comments, oldest first (for the Observer, see OBSERVER.md)

Identity can also come from the RC_AGENT env var (e.g. `RC_AGENT=sam-2 claude`),
which wins over .claude/agent.json. Use that when running two Claudes in one checkout.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple

REMOTE = "origin"
BRANCH = "status"
REMOTE_REF = f"refs/remotes/{REMOTE}/{BRANCH}"
FIELDS = ["role", "state", "issue", "task", "next", "needs", "notes",
          "branch", "head", "unpushed", "dirty", "updated"]
STATES = ["working", "blocked", "reviewing", "idle", "done", "watching"]
STALE_MIN = 30
HEARTBEAT_MIN_GAP_S = 180
ISSUE_CACHE_S = 120


# ---------------------------------------------------------------- git helpers
def git(*args: str, input: Optional[str] = None, env: Optional[dict] = None,
        check: bool = True, timeout: int = 20) -> str:
    full_env = dict(os.environ)
    if env:
        full_env.update(env)
    r = subprocess.run(["git", *args], input=input, capture_output=True, text=True,
                       env=full_env, cwd=ROOT, timeout=timeout)
    if check and r.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {r.stderr.strip()}")
    return r.stdout.strip()


def repo_root() -> Path:
    here = Path(os.environ.get("CLAUDE_PROJECT_DIR") or Path(__file__).resolve().parent.parent)
    r = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True,
                       text=True, cwd=here)
    return Path(r.stdout.strip()) if r.returncode == 0 else here


ROOT = repo_root()


def git_path(name: str) -> Path:
    p = Path(git("rev-parse", "--git-path", name))
    return p if p.is_absolute() else ROOT / p


def fetch_status() -> bool:
    try:
        git("fetch", "--quiet", REMOTE, f"+refs/heads/{BRANCH}:{REMOTE_REF}", timeout=10)
        return True
    except Exception:
        return False


def fetch_all() -> bool:
    try:
        git("fetch", "--quiet", "--prune", REMOTE, timeout=12)
        return True
    except Exception:
        return False


def ref_exists(ref: str) -> bool:
    return bool(git("rev-parse", "--verify", "--quiet", ref, check=False))


# ------------------------------------------------------------------ identity
def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9-]+", "-", s.lower()).strip("-")[:40]


def identity() -> Tuple[Optional[str], Optional[str]]:
    env_name = os.environ.get("RC_AGENT")
    cfg = ROOT / ".claude" / "agent.json"
    data: Dict[str, str] = {}
    if cfg.exists():
        try:
            data = json.loads(cfg.read_text())
        except Exception:
            data = {}
    name = slug(env_name) if env_name else data.get("name")
    role = os.environ.get("RC_ROLE") or data.get("role")
    return name, role


# ------------------------------------------------------------- status files
def parse(text: str) -> Dict[str, str]:
    out: Dict[str, str] = {}
    for line in text.splitlines():
        m = re.match(r"^- \*\*(\w+)\*\*: ?(.*)$", line)
        if m:
            out[m.group(1)] = m.group(2).strip()
    return out


def render(name: str, d: Dict[str, str]) -> str:
    lines = [f"# {name}", ""]
    for k in FIELDS:
        lines.append(f"- **{k}**: {d.get(k, '')}")
    return "\n".join(lines) + "\n"


def read_all(ref: str = REMOTE_REF) -> Dict[str, Dict[str, str]]:
    if not ref_exists(ref):
        return {}
    names = git("ls-tree", "--name-only", f"{ref}:status", check=False).splitlines()
    out = {}
    for fn in names:
        if fn.endswith(".md"):
            out[fn[:-3]] = parse(git("show", f"{ref}:status/{fn}", check=False))
    return out


def auto_fields() -> Dict[str, str]:
    branch = git("rev-parse", "--abbrev-ref", "HEAD", check=False) or "?"
    head = git("log", "-1", "--format=%h %s", check=False)[:70]
    dirty = len([l for l in git("status", "--porcelain", check=False).splitlines() if l.strip()])
    upstream = git("rev-parse", "--abbrev-ref", "@{u}", check=False)
    if upstream:
        unpushed = git("rev-list", "--count", f"{upstream}..HEAD", check=False) or "0"
    else:
        unpushed = "no upstream"
    return {"branch": branch, "head": head, "dirty": str(dirty), "unpushed": unpushed,
            "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}


README = """# Team status board

One file per Claude session / teammate in `status/`. Written by `scripts/status.py`.
Never edit someone else's file. This branch is never merged into main.
"""


def push_file(name: str, content: str, msg: str) -> None:
    """Commit status/<name>.md onto origin/status and push, retrying on races."""
    index = git_path("status-board-index")
    for attempt in range(4):
        fetch_status()
        base = REMOTE_REF if ref_exists(REMOTE_REF) else None
        env = {"GIT_INDEX_FILE": str(index)}
        if index.exists():
            index.unlink()
        if base:
            git("read-tree", base, env=env)
        else:
            git("read-tree", "--empty", env=env)
            rb = git("hash-object", "-w", "--stdin", input=README)
            git("update-index", "--add", "--cacheinfo", f"100644,{rb},README.md", env=env)
        blob = git("hash-object", "-w", "--stdin", input=content)
        git("update-index", "--add", "--cacheinfo", f"100644,{blob},status/{name}.md", env=env)
        tree = git("write-tree", env=env)
        if base and git("rev-parse", f"{base}^{{tree}}") == tree:
            index.unlink(missing_ok=True)
            return  # nothing changed
        parents = ["-p", base] if base else []
        commit = git("commit-tree", tree, *parents, "-m", msg)
        r = subprocess.run(["git", "push", "--quiet", REMOTE, f"{commit}:refs/heads/{BRANCH}"],
                           capture_output=True, text=True, cwd=ROOT, timeout=20)
        index.unlink(missing_ok=True)
        if r.returncode == 0:
            git("update-ref", REMOTE_REF, commit)
            return
        time.sleep(0.5 + attempt)
    raise RuntimeError("could not push status after 4 attempts: " + r.stderr.strip())


# ------------------------------------------------------------------- issues
def claimed_issues() -> Optional[List[dict]]:
    cache = git_path("status-board-issues.json")
    try:
        if cache.exists() and time.time() - cache.stat().st_mtime < ISSUE_CACHE_S:
            return json.loads(cache.read_text())
    except Exception:
        pass
    try:
        r = subprocess.run(["gh", "issue", "list", "--state", "open", "--label", "in-progress",
                            "--json", "number,title,assignees", "--limit", "50"],
                           capture_output=True, text=True, cwd=ROOT, timeout=8)
        if r.returncode != 0:
            return None
        cache.write_text(r.stdout)
        return json.loads(r.stdout)
    except Exception:
        return None


# ----------------------------------------------------------------- commands
def age_min(ts: str) -> Optional[float]:
    try:
        t = datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - t).total_seconds() / 60
    except Exception:
        return None


def cmd_board() -> None:
    ok = fetch_all()
    name, role = identity()
    board = read_all()
    now = datetime.now(timezone.utc).strftime("%H:%M UTC")
    p = print
    p(f"=== River Clock team board (status branch, {'fetched' if ok else 'OFFLINE, cached'} {now}) ===")
    if not name:
        p("!! NEW SESSION, NO IDENTITY: before doing anything else, follow ONBOARDING.md "
          "(ask the human their first name and role, then run: python3 scripts/status.py whoami <name> <role>)")
    else:
        p(f"You are '{name}' ({role or 'role unset'}). Keep your entry current: "
          "python3 scripts/status.py set --state ... --issue ... --task \"...\" --next \"...\"")
    if not board:
        p("(board is empty)")
    for who in sorted(board):
        d = board[who]
        a = age_min(d.get("updated", ""))
        age = "?" if a is None else (f"{int(a)}m ago" if a < 120 else f"{a/60:.1f}h ago")
        stale = "  [STALE]" if a is not None and a > STALE_MIN else ""
        me = " <- you" if who == name else ""
        issue = d.get("issue") or "-"
        p(f"- {who} [{d.get('role','?')}] {d.get('state','?')} | issue {issue} | "
          f"branch {d.get('branch','?')} | {age}{stale}{me}")
        if d.get("task"):
            p(f"    task: {d['task']}")
        if d.get("next"):
            p(f"    next: {d['next']}")
        if d.get("needs"):
            p(f"    NEEDS: {d['needs']}")
        if d.get("notes"):
            p(f"    notes: {d['notes']}")
        if d.get("dirty") not in (None, "", "0") or d.get("unpushed") not in (None, "", "0"):
            up = d.get("unpushed")
            up_txt = "branch never pushed" if up == "no upstream" else f"{up} unpushed commit(s)"
            p(f"    git: {up_txt}, {d.get('dirty')} uncommitted file(s)")
    # how far behind main are we?
    if ref_exists(f"refs/remotes/{REMOTE}/main"):
        behind = git("rev-list", "--count", f"HEAD..{REMOTE}/main", check=False)
        if behind and behind != "0":
            p(f"!! Your branch is {behind} commit(s) behind {REMOTE}/main. Rebase before continuing.")
    issues = claimed_issues()
    if issues is None:
        p("(GitHub issues unavailable: install and log in to `gh` to see claimed issues)")
    elif issues:
        p("Claimed issues (label in-progress):")
        for i in issues:
            who = ",".join(a.get("login", "") for a in i.get("assignees", [])) or "unassigned"
            p(f"  #{i['number']} {i['title']}  ({who})")
    p("=== end board ===")


def cmd_whoami(args: List[str]) -> None:
    if len(args) < 2:
        sys.exit("usage: status.py whoami <name> <role>")
    force = "--force" in args
    args = [a for a in args if a != "--force"]
    if len(args) < 2:
        sys.exit("usage: status.py whoami <name> <role> [--force]")
    name, role = slug(args[0]), " ".join(args[1:])
    if not name:
        sys.exit("name must contain letters or digits")
    current, _ = identity()
    fetch_status()
    taken = read_all().get(name)
    if taken and current != name and not force:
        sys.exit(f"name '{name}' is already on the board ({taken.get('role','?')}, branch "
                 f"{taken.get('branch','?')}, updated {taken.get('updated','?')}).\n"
                 f"If that entry is this same person on another machine, rerun with --force. "
                 f"Otherwise pick a different name, e.g. '{name}-2'.")
    cfg = ROOT / ".claude" / "agent.json"
    cfg.parent.mkdir(exist_ok=True)
    cfg.write_text(json.dumps({"name": name, "role": role}, indent=2) + "\n")
    print(f"identity set: {name} ({role})")
    cmd_set(["--state", "idle"])


def cmd_set(args: List[str]) -> None:
    name, role = identity()
    if not name:
        sys.exit("no identity; run: python3 scripts/status.py whoami <name> <role>")
    allowed = {"state", "issue", "task", "next", "needs", "notes"}
    updates: Dict[str, str] = {}
    i = 0
    while i < len(args):
        key = args[i].lstrip("-")
        if key not in allowed or i + 1 >= len(args):
            sys.exit(f"bad argument {args[i]!r}; allowed: {', '.join('--'+k for k in sorted(allowed))}")
        updates[key] = args[i + 1].replace("\n", " ").strip()
        i += 2
    if "state" in updates and updates["state"] not in STATES:
        sys.exit(f"state must be one of {STATES}")
    fetch_status()
    cur = read_all().get(name, {})
    cur.update(updates)
    cur["role"] = role or cur.get("role", "")
    cur.update(auto_fields())
    push_file(name, render(name, cur), f"status: {name} {cur.get('state','')} {cur.get('issue','')}".strip())
    stamp = git_path("status-board-heartbeat")
    stamp.write_text(cur["branch"] + " " + cur["head"])
    print(f"status pushed for {name}: {cur.get('state')} | {cur.get('task','')}")


def cmd_heartbeat() -> None:
    try:
        sys.stdin.read()  # hook payload, unused
    except Exception:
        pass
    name, _ = identity()
    if not name:
        return
    stamp = git_path("status-board-heartbeat")
    auto = auto_fields()
    sig = auto["branch"] + " " + auto["head"] + " " + auto["dirty"] + " " + auto["unpushed"]
    if stamp.exists() and time.time() - stamp.stat().st_mtime < HEARTBEAT_MIN_GAP_S \
            and stamp.read_text() == sig:
        return
    fetch_status()
    cur = read_all().get(name, {})
    cur.update(auto)
    push_file(name, render(name, cur), f"status: {name} heartbeat")
    stamp.write_text(sig)


def cmd_init() -> None:
    fetch_status()
    if ref_exists(REMOTE_REF):
        print("status branch already exists on origin")
        return
    index = git_path("status-board-index")
    env = {"GIT_INDEX_FILE": str(index)}
    git("read-tree", "--empty", env=env)
    rb = git("hash-object", "-w", "--stdin", input=README)
    git("update-index", "--add", "--cacheinfo", f"100644,{rb},README.md", env=env)
    tree = git("write-tree", env=env)
    commit = git("commit-tree", tree, "-m", "Create team status board")
    index.unlink(missing_ok=True)
    git("push", "--quiet", REMOTE, f"{commit}:refs/heads/{BRANCH}")
    git("update-ref", REMOTE_REF, commit)
    print("created status branch on origin")


# --------------------------------------------------------------------- feed
# One chronological timeline of what the team did: status changes, claims, commits on
# every branch, PRs and issue comments. Read-only; made for the Observer (OBSERVER.md).
Event = Tuple[datetime, str, str]  # (time UTC, kind, text)


def parse_since(s: str) -> datetime:
    m = re.fullmatch(r"(\d+)([mhd])", s)
    if m:
        secs = int(m.group(1)) * {"m": 60, "h": 3600, "d": 86400}[m.group(2)]
        return datetime.now(timezone.utc) - timedelta(seconds=secs)
    t = datetime.fromisoformat(s.replace("Z", "+00:00"))
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def parse_ts(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)


def cat_files(specs: List[str]) -> List[str]:
    """Contents of many <rev>:<path> objects in one git call ('' if missing)."""
    if not specs:
        return []
    r = subprocess.run(["git", "cat-file", "--batch"], input=("\n".join(specs) + "\n").encode(),
                       capture_output=True, cwd=ROOT, timeout=30)
    out, data, pos = [], r.stdout, 0
    for _ in specs:
        nl = data.index(b"\n", pos)
        header = data[pos:nl].split()
        pos = nl + 1
        if len(header) < 3 or header[1] == b"missing":
            out.append("")
            continue
        size = int(header[2])
        out.append(data[pos:pos + size].decode("utf-8", "replace"))
        pos += size + 1
    return out


def status_events(since: datetime) -> List[Event]:
    """Changes to anyone's state, issue, task or needs (heartbeats skipped)."""
    if not ref_exists(REMOTE_REF):
        return []
    log = git("log", REMOTE_REF, "--reverse", "--format=@%H %cI %s", "--name-only", check=False)
    commits: List[Tuple[str, datetime, str]] = []  # (sha, time, name)
    sha, ts, skip = "", None, True
    for line in log.splitlines():
        if line.startswith("@"):
            sha, iso, subject = line[1:].split(" ", 2)
            ts, skip = parse_ts(iso), subject.endswith(" heartbeat")
        elif line.startswith("status/") and line.endswith(".md") and not skip and ts:
            commits.append((sha, ts, line[len("status/"):-3]))
    texts = cat_files([f"{c}:status/{n}.md" for c, _, n in commits])
    last: Dict[str, Dict[str, str]] = {}
    events: List[Event] = []
    for (_, t, name), text in zip(commits, texts):
        d = parse(text)
        prev = last.get(name, {})
        last[name] = d
        if t < since or all(d.get(k) == prev.get(k) for k in ("state", "issue", "task", "needs")):
            continue
        issue = f" {d['issue']}" if d.get("issue") else ""
        text_ = f"{name} -> {d.get('state', '?')}{issue}"
        if d.get("task"):
            text_ += f": {d['task']}"
        if d.get("needs"):
            text_ += f"  NEEDS: {d['needs']}"
        events.append((t, "status", text_))
    return events


def commit_events(since: datetime) -> List[Event]:
    """Commits on main, then each other branch's own commits (those not yet on main)."""
    prefix = f"refs/remotes/{REMOTE}/"
    refs = [r[len(prefix):] for r in git("for-each-ref", "--format=%(refname)", prefix,
                                         check=False).splitlines()]
    branches = sorted(b for b in refs if b not in ("HEAD", BRANCH, "main"))
    main = f"{REMOTE}/main"
    has_main = ref_exists(f"{prefix}main")
    seen: set = set()
    events: List[Event] = []
    for b in (["main"] if has_main else []) + branches:
        rng = [main] if b == "main" else ([f"{main}..{REMOTE}/{b}"] if has_main else [f"{REMOTE}/{b}"])
        log = git("log", *rng, "--no-merges", f"--since={since.isoformat()}",
                  "--format=%H%x09%cI%x09%s", check=False)
        for line in log.splitlines():
            parts = line.split("\t", 2)
            if len(parts) == 3 and parts[0] not in seen:
                seen.add(parts[0])
                events.append((parse_ts(parts[1]), "commit", f"[{b}] {parts[2]}"))
    return events


def gh_json(*args: str) -> Optional[list]:
    try:
        r = subprocess.run(["gh", *args], capture_output=True, text=True, cwd=ROOT, timeout=15)
        return json.loads(r.stdout) if r.returncode == 0 else None
    except Exception:
        return None


def github_events(since: datetime) -> Optional[List[Event]]:
    """PRs opened/merged/closed, claims and closes, issue/PR comments. None if gh is unavailable."""
    prs = gh_json("pr", "list", "--state", "all", "--limit", "100", "--json",
                  "number,title,headRefName,author,createdAt,mergedAt,closedAt,state")
    if prs is None:
        return None
    events: List[Event] = []
    for p in prs:
        what = f"#{p['number']} {p['title']} [{p['headRefName']}] by {p['author']['login']}"
        events.append((parse_ts(p["createdAt"]), "pr", f"opened {what}"))
        if p.get("mergedAt"):
            events.append((parse_ts(p["mergedAt"]), "pr", f"MERGED {what}"))
        elif p.get("closedAt"):
            events.append((parse_ts(p["closedAt"]), "pr", f"closed unmerged {what}"))
    for e in gh_json("api", "repos/{owner}/{repo}/issues/events?per_page=100") or []:
        kind = e.get("event")
        num = (e.get("issue") or {}).get("number")
        actor = (e.get("actor") or {}).get("login", "?")
        if kind in ("assigned", "unassigned"):
            text = f"#{num} {kind} {(e.get('assignee') or {}).get('login', '?')} (by {actor})"
        elif kind in ("labeled", "unlabeled") and (e.get("label") or {}).get("name") == "in-progress":
            text = f"#{num} {'claimed' if kind == 'labeled' else 'released'} (in-progress, by {actor})"
        elif kind in ("closed", "reopened"):
            text = f"#{num} {kind} by {actor}"
        else:
            continue
        events.append((parse_ts(e["created_at"]), "issue", text))
    for c in gh_json("api", "repos/{owner}/{repo}/issues/comments?per_page=100&since="
                     + since.strftime("%Y-%m-%dT%H:%M:%SZ")) or []:
        num = c.get("issue_url", "").rsplit("/", 1)[-1]
        first = " ".join(c.get("body", "").split())[:160]
        events.append((parse_ts(c["created_at"]), "comment",
                       f"#{num} {(c.get('user') or {}).get('login', '?')}: {first}"))
    return events


def cmd_feed(args: List[str]) -> None:
    since_arg = "3h"
    as_json = "--json" in args
    if "--since" in args:
        i = args.index("--since")
        if i + 1 >= len(args):
            sys.exit("usage: status.py feed [--since 90m|3h|1d|2026-10-24T15:00Z] [--json]")
        since_arg = args[i + 1]
    since = parse_since(since_arg)
    ok = fetch_all()
    events = status_events(since) + commit_events(since)
    gh_events = github_events(since)
    events += gh_events or []
    events = sorted((e for e in events if e[0] >= since), key=lambda e: e[0])
    if as_json:
        print(json.dumps([{"t": t.strftime("%Y-%m-%dT%H:%M:%SZ"), "kind": k, "text": x}
                          for t, k, x in events], indent=1))
        return
    print(f"=== River Clock feed since {since.strftime('%a %H:%M')} UTC "
          f"({'fetched' if ok else 'OFFLINE, cached'}; {len(events)} events) ===")
    if gh_events is None:
        print("(GitHub unavailable: PRs, claims and comments missing; log in to `gh`)")
    for t, kind, text in events:
        print(f"{t.strftime('%a %H:%M')}  {kind:<7} {text}")
    print("=== end feed ===")


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        return
    cmd, rest = sys.argv[1], sys.argv[2:]
    try:
        if cmd == "board":
            cmd_board()
        elif cmd == "whoami":
            cmd_whoami(rest)
        elif cmd == "set":
            cmd_set(rest)
        elif cmd == "heartbeat":
            cmd_heartbeat()
        elif cmd == "init":
            cmd_init()
        elif cmd == "feed":
            cmd_feed(rest)
        else:
            print(__doc__)
            sys.exit(2)
    except Exception as e:  # hooks must never crash the session
        if cmd in ("board", "heartbeat"):
            print(f"(status board error: {e})")
            return
        raise


if __name__ == "__main__":
    main()
