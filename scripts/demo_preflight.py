#!/usr/bin/env python3
"""Pre-judging checklist for the River Clock demo (issue #70; docs/demo-backup.md).

    make preflight            # while `make demo` is running in another terminal
    python3 scripts/demo_preflight.py --port 8080 [--no-server]
    python3 scripts/demo_preflight.py --stamp   # called by the Makefile after each web build

Prints one line per check (✅ ok, ⚠️ warning, ❌ fail, ℹ️ info) and exits 1 on any ❌.
Standard library only and Python 3.9-compatible, so it runs on a fresh laptop before `make setup`.
Never needs the network: the only outbound call is a 1.5 s "are we online?" probe, reported as info.
Finishes in a few seconds.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, NamedTuple, Optional, Sequence, Tuple

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "web" / "public" / "data"
FIXTURES = ROOT / "tests" / "fixtures"
DIST = ROOT / "web" / "dist"
STAMP_NAME = "build-info.json"

# Everything the web build reads (keep in step with WEB_SOURCES in the Makefile).
WEB_SOURCE_PATHS = (
    "web/src",
    "web/public",
    "web/index.html",
    "web/package.json",
    "web/package-lock.json",
    "web/vite.config.ts",
    "web/tsconfig.json",
    "tests/fixtures",
)

# (file under web/public/data, needed for the demo script, top-level JSON type). Mirrors LIST_FILES
# in web/src/data.ts: a file of the wrong top-level type makes the app fall back to its fixture.
DATA_FILES: Tuple[Tuple[str, bool, type], ...] = (
    ("stations.json", True, list),
    ("spots.json", True, list),
    ("events.json", True, list),
    ("travel_times.json", True, list),
    ("quality.json", True, dict),
    ("importance.json", True, dict),
    ("proof.json", True, dict),
    ("replays/e2014.json", True, dict),
    ("live.json", False, dict),
)
WEB_DATA_LIMIT_BYTES = 50 * 1024 * 1024  # CLAUDE.md rule 6

# Hosts that appear in the built bundle as links or credits, never fetched by the app.
LINK_HOSTS = {
    "www.gov.uk",
    "gov.uk",
    "check-for-flooding.service.gov.uk",
    "environment.data.gov.uk",  # station/source links; only the API (DEMO_LIVE=1) calls it
    "www.data.gov.uk",
    "www.openstreetmap.org",
    "leafletjs.com",
    "react.dev",
    "reactjs.org",
    "redux.js.org",
    "redux-toolkit.js.org",
    "bit.ly",  # Immer's minified-error link
    "www.w3.org",  # SVG/XML namespaces
    "archive-api.open-meteo.com",  # data credit in quality.json
}
TILE_HOST_RE = re.compile(r"tile\.openstreetmap\.org$")

# Clocks go back at 01:00 UTC on Sun 25 Oct 2026 (02:00 BST -> 01:00 GMT).
CLOCKS_BACK_UTC = datetime(2026, 10, 25, 1, 0, tzinfo=timezone.utc)

OK, WARN, FAIL, INFO = "ok", "warn", "fail", "info"
ICON = {OK: "✅", WARN: "⚠️ ", FAIL: "❌", INFO: "ℹ️ "}


class Check(NamedTuple):
    status: str
    title: str
    detail: str = ""


# ---- data files -------------------------------------------------------------------------------


def fixture_candidates(file: str, fixtures_dir: Path) -> List[str]:
    """Fixture paths web/src/data.ts would try for ``file``, most specific first (existing only)."""
    names = [file]
    m = re.match(r"^replays/(.+)\.json$", file)
    if m:
        rid = m.group(1)
        names += [f"replay_{rid}.json", f"replay-{rid}.json", f"{rid}.json", "replays/replay.json", "replay.json"]
        replays = fixtures_dir / "replays"
        if replays.is_dir():  # data.ts falls back to ANY replay fixture
            names += sorted(f"replays/{p.name}" for p in replays.glob("*.json"))
    if file == "live.json":
        names.append("forecast.json")
    names.append(f"stretch/{file}")
    seen: List[str] = []
    for n in names:
        if n not in seen and (fixtures_dir / n).is_file():
            seen.append(n)
    return seen


def load_json(path: Path) -> Tuple[Optional[Any], str]:
    """(value, "") or (None, reason)."""
    try:
        return json.loads(path.read_text(encoding="utf-8")), ""
    except FileNotFoundError:
        return None, "missing"
    except (OSError, UnicodeDecodeError, ValueError) as exc:
        return None, f"invalid JSON ({exc.__class__.__name__}: {str(exc)[:80]})"


def check_data_file(public_dir: Path, fixtures_dir: Path, file: str, required: bool, kind: type) -> Check:
    """Real file present and well-formed, or what the app will show instead."""
    path = public_dir / file
    value, err = load_json(path)
    if value is not None and not isinstance(value, kind):
        err = f"top level is {type(value).__name__}, expected {kind.__name__}"
    if not err:
        size = path.stat().st_size
        return Check(OK, f"{file}: real data", f"{size / 1024:.0f} KB")
    fallback = fixture_candidates(file, fixtures_dir)
    shows = (
        f"the app shows fixture tests/fixtures/{fallback[0]} ('sample data' notice)"
        if fallback
        else "no fixture either: that panel shows an error"
    )
    if err == "missing" and not required:
        return Check(WARN, f"{file}: not committed", f"{shows} when the API has no live data (offline)")
    return Check(FAIL, f"{file}: {err}", shows)


def check_event_replays(public_dir: Path, events: Any) -> Check:
    """Every event in events.json should have a real replay (Decide and Proof load them all)."""
    if not isinstance(events, list):
        return Check(INFO, "replays for all events", "events.json unreadable; skipped")
    ids = [e.get("id") for e in events if isinstance(e, dict) and e.get("id")]
    missing = [i for i in ids if not (public_dir / "replays" / f"{i}.json").is_file()]
    if not missing:
        return Check(OK, f"replays for all {len(ids)} events", "")
    return Check(
        WARN,
        f"replays missing for {len(missing)} of {len(ids)} events",
        f"{', '.join(missing)}: the Time Machine shows the e2014 fixture for these; pick e2014 at the table",
    )


def check_data_size(public_dir: Path, limit: int = WEB_DATA_LIMIT_BYTES) -> Check:
    total = sum(p.stat().st_size for p in public_dir.rglob("*") if p.is_file()) if public_dir.is_dir() else 0
    status = OK if total <= limit else FAIL
    return Check(status, "web/public/data size", f"{total / 1024 / 1024:.1f} MB (limit {limit / 1024 / 1024:.0f} MB)")


# ---- the build --------------------------------------------------------------------------------


def git(args: Sequence[str], root: Path = ROOT) -> Optional[str]:
    try:
        out = subprocess.run(
            ["git", *args], cwd=str(root), capture_output=True, text=True, timeout=5, check=True
        )
        return out.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None


def sources_commit(root: Path = ROOT) -> Optional[str]:
    """Last commit that touched anything the web build reads."""
    return git(["log", "-1", "--format=%H", "--", *WEB_SOURCE_PATHS], root) or None


def dirty_sources(root: Path = ROOT) -> List[str]:
    out = git(["status", "--porcelain", "--", *WEB_SOURCE_PATHS], root)
    return [line[3:] for line in (out or "").splitlines() if line.strip()]


def newest_mtime(root: Path, paths: Sequence[str]) -> float:
    newest = 0.0
    for rel in paths:
        p = root / rel
        if p.is_file():
            newest = max(newest, p.stat().st_mtime)
        elif p.is_dir():
            for f in p.rglob("*"):
                if f.is_file():
                    newest = max(newest, f.stat().st_mtime)
    return newest


def write_stamp(dist: Path, root: Path = ROOT, now: Optional[datetime] = None) -> Path:
    now = now or datetime.now(timezone.utc)
    info = {
        "head": git(["rev-parse", "HEAD"], root),
        "sources": sources_commit(root),
        "dirty": dirty_sources(root),
        "builtAt": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    path = dist / STAMP_NAME
    path.write_text(json.dumps(info, indent=2) + "\n", encoding="utf-8")
    return path


def compare_build(
    stamp: Optional[Dict[str, Any]],
    current_sources: Optional[str],
    dirty: List[str],
    dist_mtime: float,
    src_mtime: float,
) -> Check:
    """Is web/dist built from the web sources at HEAD?"""
    title = "web/dist matches HEAD"
    if src_mtime > dist_mtime:
        return Check(FAIL, title, "web sources changed after the last build: restart `make demo` to rebuild")
    if stamp is None:
        return Check(WARN, title, "no build stamp (built outside `make demo`); timestamps look current")
    built = stamp.get("sources")
    if current_sources and built != current_sources:
        return Check(
            FAIL,
            title,
            f"built from {str(built)[:8]}, web sources now at {current_sources[:8]}: restart `make demo`",
        )
    if dirty or stamp.get("dirty"):
        files = ", ".join((dirty or stamp.get("dirty") or [])[:3])
        return Check(WARN, title, f"uncommitted web changes ({files}); commit and tag before judging")
    return Check(OK, title, f"built from {str(built)[:8]} at {stamp.get('builtAt', '?')}")


def check_dist(dist: Path, root: Path = ROOT) -> Check:
    index = dist / "index.html"
    if not index.is_file():
        return Check(FAIL, "web/dist built", "missing: run `make demo` (it builds first)")
    stamp, _ = load_json(dist / STAMP_NAME)
    return compare_build(
        stamp if isinstance(stamp, dict) else None,
        sources_commit(root),
        dirty_sources(root),
        index.stat().st_mtime,
        newest_mtime(root, WEB_SOURCE_PATHS),
    )


def check_dist_data(dist: Path, public_dir: Path) -> Check:
    """The data the server will actually send is the committed data (byte for byte)."""
    title = "web/dist/data = web/public/data"
    if not public_dir.is_dir():
        return Check(FAIL, title, "web/public/data missing")
    stale = []
    for src in sorted(p for p in public_dir.rglob("*.json")):
        rel = src.relative_to(public_dir)
        built = dist / "data" / rel
        if not built.is_file() or built.read_bytes() != src.read_bytes():
            stale.append(rel.as_posix())
    if stale:
        return Check(FAIL, title, f"out of date: {', '.join(stale[:4])}: restart `make demo` to rebuild")
    return Check(OK, title, "")


# ---- network ----------------------------------------------------------------------------------

URL_RE = re.compile(r"https?://([A-Za-z0-9{}._-]+)")
HTML_EXTERNAL_RE = re.compile(r"<(?:script|link|img|iframe)\b[^>]*\b(?:src|href)=[\"']?(?:https?:)?//", re.I)
CSS_EXTERNAL_RE = re.compile(r"(?:url\(\s*[\"']?|@import\s+[\"']?)(?:https?:)?//", re.I)


def scan_external(dist: Path) -> List[Check]:
    """Does the built page load anything from the internet? (Links are fine; tiles are expected.)"""
    index = dist / "index.html"
    if not index.is_file():
        return [Check(FAIL, "no outbound network needed", "web/dist missing")]
    out: List[Check] = []
    bad: List[str] = []
    if HTML_EXTERNAL_RE.search(index.read_text(encoding="utf-8", errors="replace")):
        bad.append("index.html loads an external script/stylesheet")
    hosts = set()
    for f in sorted((dist / "assets").glob("*")) if (dist / "assets").is_dir() else []:
        text = f.read_text(encoding="utf-8", errors="replace")
        if f.suffix == ".css" and CSS_EXTERNAL_RE.search(text):
            bad.append(f"{f.name} loads an external font/image")
        hosts.update(URL_RE.findall(text))
    tiles = sorted(h for h in hosts if TILE_HOST_RE.search(h))
    unknown = sorted(h for h in hosts if h not in LINK_HOSTS and not TILE_HOST_RE.search(h))
    if bad:
        out.append(Check(FAIL, "no outbound network needed", "; ".join(bad)))
    elif unknown:
        out.append(Check(WARN, "no outbound network needed", f"unknown hosts in bundle (links?): {', '.join(unknown)}"))
    else:
        out.append(Check(OK, "no outbound network needed", "scripts, styles, fonts and data are all local"))
    if tiles:
        out.append(Check(INFO, "map tiles", "OSM tiles need internet; offline the map is grey with a note, spots still show"))
    return out


def probe_online(host: str = "tile.openstreetmap.org", timeout: float = 1.5) -> Optional[bool]:
    """True/False if we could tell within ``timeout`` (DNS included), None if it hung."""
    result: List[bool] = []

    def run() -> None:
        try:
            with socket.create_connection((host, 443), timeout=timeout):
                result.append(True)
        except OSError:
            result.append(False)

    t = threading.Thread(target=run, daemon=True)
    t.start()
    t.join(timeout + 0.2)
    return result[0] if result else None


# ---- the running server -----------------------------------------------------------------------


def http_get(url: str, timeout: float = 2.0) -> Tuple[Optional[int], str, bytes]:
    """(status, content type, body); status None if unreachable."""
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return r.status, r.headers.get("content-type", ""), r.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.headers.get("content-type", "") if exc.headers else "", b""
    except Exception:
        return None, "", b""


def check_server(base: str) -> List[Check]:
    out: List[Check] = []
    status, ctype, body = http_get(base)
    if status is None:
        return [Check(FAIL, f"server at {base}", "not answering: start `make demo` first")]
    ok = status == 200 and "html" in ctype and b'id="root"' in body
    out.append(Check(OK if ok else FAIL, "GET /", f"{status} {ctype.split(';')[0]}"))
    status, ctype, body = http_get(base + "data/stations.json")
    try:
        ok = status == 200 and "json" in ctype and isinstance(json.loads(body), list)
    except ValueError:
        ok = False
    out.append(Check(OK if ok else FAIL, "GET /data/stations.json", f"{status} {ctype.split(';')[0]}"))
    status, _, body = http_get(base + "api/health")
    out.append(Check(OK if status == 200 else FAIL, "GET /api/health", f"{status} {body[:40].decode(errors='replace')}"))
    t0 = time.monotonic()
    status, _, _ = http_get(base + "api/live", timeout=5.0)
    took = time.monotonic() - t0
    if status == 503:
        detail = "503: offline mode, River tab shows the saved live.json ('Live data unavailable')"
    elif status == 200:
        detail = f"200 in {took:.1f} s: live forecast from the API (DEMO_LIVE=1)"
    else:
        detail = f"{status}: unexpected; the app falls back to the saved live.json"
    out.append(Check(INFO, "GET /api/live", detail))
    return out


# ---- the room: clock, disk, power --------------------------------------------------------------


def check_clock(now_utc: datetime) -> List[Check]:
    try:
        from zoneinfo import ZoneInfo

        london = ZoneInfo("Europe/London")
    except Exception as exc:  # no tz database on this machine
        return [Check(WARN, "Europe/London time", f"zoneinfo unavailable ({exc}); the browser still converts")]
    local = now_utc.astimezone(london)
    zone = local.tzname() or "?"
    expected = "BST" if now_utc < CLOCKS_BACK_UTC else "GMT"
    out = [
        Check(
            OK if zone == expected else FAIL,
            "Europe/London time",
            f"{local:%a %d %b %H:%M} {zone} ({now_utc:%H:%M} UTC); clocks go back 02:00 BST Sun 25 Oct,"
            f" judging is on GMT (= UTC)",
        )
    ]
    if not (2026 <= now_utc.year <= 2027):
        out.append(Check(WARN, "laptop clock", f"year is {now_utc.year}: set the date, or 'now' and live staleness are wrong"))
    machine_offset = -time.altzone if time.localtime().tm_isdst > 0 else -time.timezone
    london_offset = int(local.utcoffset().total_seconds()) if local.utcoffset() else 0
    if machine_offset != london_offset:
        out.append(
            Check(
                WARN,
                "laptop time zone",
                f"UTC{machine_offset / 3600:+.0f}, not UK time: the app still shows UK time, the menu-bar clock won't",
            )
        )
    return out


def check_disk(path: Path, min_free_gb: float = 2.0) -> Check:
    free = shutil.disk_usage(str(path)).free / 1024**3
    return Check(OK if free >= min_free_gb else WARN, "disk space", f"{free:.1f} GB free (want {min_free_gb:.0f}+ GB for screen recording)")


def parse_pmset(text: str) -> Tuple[Optional[int], Optional[bool]]:
    """(percent, on_mains) from `pmset -g batt` output."""
    pct = re.search(r"(\d+)%", text)
    mains: Optional[bool] = None
    if "AC Power" in text:
        mains = True
    elif "Battery Power" in text:
        mains = False
    return (int(pct.group(1)) if pct else None), mains


def battery() -> Tuple[Optional[int], Optional[bool]]:
    system = platform.system()
    try:
        if system == "Darwin":
            out = subprocess.run(["pmset", "-g", "batt"], capture_output=True, text=True, timeout=3).stdout
            return parse_pmset(out)
        if system == "Linux":
            for supply in Path("/sys/class/power_supply").glob("BAT*"):
                pct = int((supply / "capacity").read_text().strip())
                status = (supply / "status").read_text().strip()
                return pct, status in ("Charging", "Full", "Not charging")
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    return None, None


def check_power() -> Check:
    pct, mains = battery()
    reminder = "charger plugged in at the table; spare charger in the bag (docs/demo-backup.md)"
    if pct is None and mains is None:
        return Check(INFO, "battery", f"can't read it here. Reminder: {reminder}")
    level = f"{pct}%" if pct is not None else "?"
    if mains:
        return Check(OK, "battery", f"{level}, on mains")
    return Check(WARN, "battery", f"{level}, ON BATTERY: {reminder}")


def check_tag(root: Path = ROOT) -> Check:
    tags = [t for t in (git(["tag", "--points-at", "HEAD"], root) or "").splitlines() if t.startswith("demo-ready")]
    if tags:
        return Check(OK, "known-good tag at HEAD", ", ".join(tags))
    return Check(INFO, "known-good tag at HEAD", "none: once this all passes, `git tag demo-ready-$(date +%H%M)`")


# ---- main -------------------------------------------------------------------------------------


def run_all(port: int, server: bool) -> List[Check]:
    checks: List[Check] = []
    for file, required, kind in DATA_FILES:
        checks.append(check_data_file(PUBLIC, FIXTURES, file, required, kind))
    events, _ = load_json(PUBLIC / "events.json")
    checks.append(check_event_replays(PUBLIC, events))
    checks.append(check_data_size(PUBLIC))
    checks.append(check_dist(DIST))
    if (DIST / "index.html").is_file():
        checks.append(check_dist_data(DIST, PUBLIC))
    if server:
        checks += check_server(f"http://127.0.0.1:{port}/")
    else:
        checks.append(Check(WARN, "server", "skipped (--no-server)"))
    checks += scan_external(DIST)
    online = probe_online()
    checks.append(
        Check(
            INFO,
            "internet right now",
            {True: "online: map tiles will load", False: "offline: grey map, everything else works",
             None: "unclear (DNS hung): treat as offline"}[online],
        )
    )
    checks += check_clock(datetime.now(timezone.utc))
    checks.append(check_disk(ROOT))
    checks.append(check_power())
    checks.append(check_tag())
    return checks


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="River Clock demo preflight (docs/demo-backup.md).")
    parser.add_argument("--port", type=int, default=int(os.environ.get("DEMO_PORT", "8080")))
    parser.add_argument("--no-server", action="store_true", help="skip the running-server checks")
    parser.add_argument("--stamp", action="store_true", help="write web/dist/build-info.json and exit")
    args = parser.parse_args(argv)
    if args.stamp:
        print(f"wrote {write_stamp(DIST).relative_to(ROOT)}")
        return 0

    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8")  # Windows consoles default to cp1252
        except (AttributeError, ValueError):
            pass
    t0 = time.monotonic()
    checks = run_all(args.port, server=not args.no_server)
    print("River Clock demo preflight")
    for c in checks:
        print(f"  {ICON[c.status]} {c.title}" + (f": {c.detail}" if c.detail else ""))
    fails = sum(c.status == FAIL for c in checks)
    warns = sum(c.status == WARN for c in checks)
    print(f"\n{fails} failed, {warns} warnings ({time.monotonic() - t0:.1f} s).", end=" ")
    print("Fix the ❌ lines before judging." if fails else "Good to demo. Tag it: git tag demo-ready-$(date +%H%M)")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
