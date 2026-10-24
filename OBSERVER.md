# Observer: following River Clock without touching it

The Observer (a person and their Claude) keeps a running picture of the whole team's progress and flags problems early. The Observer **reads everything and changes nothing**: no project code, no claims, no merges.

## Setup (once)
1. Do the human steps in ONBOARDING.md (clone, `gh auth login`, accept the project hooks).
2. Register: `python3 scripts/status.py whoami <first-name> Observer`, then
   `python3 scripts/status.py set --state watching --task "Observing the team" --next "First check-in"`.
3. Keep any local scripts or notes in `.observer/` (gitignored), not in `scripts/`. That folder is shared tooling.

## How work is tracked here
| Where | What it tells you |
|---|---|
| Team board (`status` branch, one file per person/agent) | Who is on what *now*: state, issue, task, next, needs, branch, last commit |
| GitHub issues | The task list. `in-progress` label + assignee = claimed. Decisions between teams happen in issue comments |
| Branches `data/… model/… app/… story/… integration/…` | One per task; pushed at least every 30 min |
| PRs (`Closes #n`) | Finished work waiting for review; merged into `main` by the PM |
| SPEC.md §13 | Milestones and target times; the core gate |

Board names: a person is `<first-name>`. Their Claude subagents are `<first-name>-<area>`, e.g. `s-s01s-pipeline`, `alfredo-model`. The GitHub assignee is the person's account, so two subagents of one person share an assignee.

## Each check-in (every 20–30 min)
1. **Now:** `python3 scripts/status.py board` (the hooks also show it before every prompt).
2. **What happened:** `python3 scripts/status.py feed --since 30m`. This gives one timeline, oldest first: status changes, claims and releases, commits on every branch, PRs opened and merged, issue comments. Use `--since 2h` or `--since 2026-10-24T18:00Z` to look further back, and `--json` for machine-readable output.
3. **Open PRs:** `gh pr list`, then `gh pr view <n> --comments` and `gh pr diff <n> --name-only`.
4. **Look at a branch without checking it out:**
   `git fetch` · `git log origin/main..origin/<branch> --oneline` · `git diff origin/main...origin/<branch> --stat` · `git show origin/<branch>:<path>`
5. **Milestones:** compare merged work with the SPEC §13 targets.

All board and feed times are **UTC**. UK time is UTC+1 until Sun 02:00 BST, when clocks go back to GMT (UTC+0). The §13 targets are UK local time.

## What to flag
- **Duplicate work:** two assignees or two board entries on one issue.
- **Stalls:** `[STALE]` on the board; "branch never pushed" for > 30 min; an `in-progress` issue with no commits for > 1 h; a `NEEDS:` that nobody has answered.
- **Slipping milestones:** a P0 not merged near its §13 target (the first is clean hourly data, Sat 21:00).
- **Contract drift:** a PR that changes `web/src/contracts.ts`, `tests/fixtures/` or SPEC §9 without changing all three.
- **Broken agreements:** a PR that doesn't match an interface agreed in an issue comment, e.g. the `hourly.parquet` columns (#3), `lags.json` (#7) or the features API (#6).
- **Rule breaks** (CLAUDE.md): a push straight to `main`; anything under `data/` or model files committed; `web/public/data/` over 50 MB; edits outside the author's area; out-of-scope work (SPEC §1.1); stretch work before the core gate; a screen without the disclaimer.

## How to report
- **Observer log:** one GitHub issue titled "Observer log" (create it once: `gh issue create --title "Observer log" --label integration --body "Running log of check-ins."`). Add one comment per check-in:
  - **Headline:** one line.
  - **Done since last check-in:** merged PRs, closed issues.
  - **In flight:** issue → who → state.
  - **Risks / needs the PM:** each with its evidence (board line, feed line, PR).
- **Your board entry:** keep `--notes` set to the current headline so everyone sees it before every prompt.
- **A specific problem:** comment on that issue or PR and name the owner's board name. Don't fix it yourself.

## Running it as a Claude loop
In the Observer's Claude, run:
```
/loop 20m Do an Observer check-in following OBSERVER.md and post it to the Observer log issue
```
