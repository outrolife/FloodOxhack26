# River Clock: rules for Claude Code sessions and teammates

River Clock forecasts when and how likely five Oxford flood trouble spots will flood in the next 72 h, from upstream EA river gauges. **SPEC.md is the source of truth.** Read the section for your module before coding.

## Hard deadline
Code freeze **Sun 25 Oct 11:00**. Hacking ends 12:00. Prefer finishing a P0 item over starting a P2 one (priorities and the core gate: SPEC.md §13).

## Team coordination: read this first, every session
Several Claude sessions work in this repo at once. Two shared sources of truth keep everyone in sync:
- **The status board**: one file per session, `status/<name>.md`, on the `status` branch (never merged into `main`). Hooks fetch it and show it to you **before every prompt** (look for "River Clock team board" in your context). A Stop hook pushes a heartbeat (branch, last commit, time) after every reply.
- **GitHub issues**: the task list. The label `in-progress` plus an assignee means an issue is claimed.

Rules:
1. **Identity.** If the board says this checkout has no identity, ask the human for their name and role, then run `python3 scripts/status.py whoami <name> <role>`. Running two Claudes on one machine? Give each its own checkout or worktree, or launch it with `RC_AGENT=<name>-2 claude`.
2. **Read the board before acting.** Don't start work someone else has claimed. If your task touches another module or a §9 contract, check the board for its owner and tell them through your `needs` field or an issue comment.
3. **Claim before coding.** Pick the highest-priority unclaimed issue in your area (SPEC §13 order). Run `gh issue edit <n> --add-assignee @me --add-label in-progress`, then `python3 scripts/status.py set --state working --issue "#<n>" --task "<one line>" --next "<one line>"`.
4. **Update your status whenever it changes**: a new task, a finished step, a blocker, a new branch. Do it in the same turn as the change. Use `--state blocked --needs "<what, from whom>"` when you're stuck. Keep each field to one line.
5. **Push code often.** Commit and push your task branch at every working step, at least every 30 minutes, so others can see real progress. Never push to `main` directly. Merge through a PR that says `Closes #<n>`.
6. **Finishing.** Open the PR, then `set --state reviewing`. After the merge, `set --state idle --issue "" --task ""` and remove the `in-progress` label.
7. **If the board says you're behind `origin/main`**, rebase before you continue.
8. Never edit another person's status file. The script only ever writes yours.

## Module ownership (edit only your own area unless asked)
| Area | Owner | Paths |
|---|---|---|
| Data | Data lead | `pipeline/`, `config/stations.yaml` |
| Model | Model lead | `analysis/`, `model/` |
| App | App lead | `web/`, `api/` |
| Story | Story lead | `config/events.yaml`, `config/spots.yaml`, `README.md` |

If you need a change in someone else's area, ask them (or open an issue) instead of editing it.

## Contracts
- The JSON shapes in **SPEC.md §9** (and §11 for stretch items) are the interface between teams. `web/src/contracts.ts` mirrors them; `tests/fixtures/` holds a valid sample of each file.
- **Never change a contract silently.** If one must change: update SPEC.md §9, `contracts.ts` and the fixture in the same PR, and tell the team.
- The web app must always run offline from `web/public/data/` (or fixtures).

## Commands
- `make data` · `make travel` · `make train` · `make backtest` · `make live` · `make api` · `make web` · `make test`

## Non-negotiable engineering rules
1. Store and compute in **UTC**; convert to Europe/London only in the UI. (Clocks go back tonight.)
2. **Never compare river stage values across gauges**; each has its own datum. Use per-gauge anomalies.
3. **No future data in features or in what the Time Machine shows the model.** Keep the leakage tests passing.
4. Use river **level**, not flow.
5. Cache API responses in `data/raw/`; poll EA live endpoints at most every 15 minutes.
6. `data/` and model files are gitignored. Only small JSON goes in `web/public/data/` (< 50 MB total).
7. Every screen shows the disclaimer: decision-support prototype, not an official warning; link to gov.uk/check-flooding.
8. Never build anything in SPEC.md §1.1 "out of scope" (no second forecasting model, no foundation models/LSTMs, no surface-water forecasting). Stretch items S1–S4 (SPEC.md §11) only after the core gate in §13 is met, in order, in `stretch/`; hide anything unfinished by Sun 09:00.

## Git workflow
- `main` must always run. Never commit directly to `main`.
- Branch per task: `data/…`, `model/…`, `app/…`, `story/…`. Keep branches short-lived (merge within ~2 hours).
- Small PRs, one module each; run `make test` before opening. Another teammate (or the integration owner) merges.
- Pull/rebase from `main` often, at least every hour and before starting a new task.
- Commit messages: imperative, specific ("Add travel-time matching for Thames chain").
- Track tasks as GitHub issues; reference them in PRs.

## Style
- Python 3.11, type hints, `ruff`; scripts idempotent; fixed random seeds.
- TypeScript strict; React function components; no heavy UI frameworks.
- Prefer clear, explainable code over clever code: every teammate must be able to explain it to judges.
