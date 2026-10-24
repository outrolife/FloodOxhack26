# River Clock: rules for Claude Code sessions and teammates

River Clock forecasts when and how likely five Oxford flood trouble spots will flood in the next 72 h, from upstream EA river gauges. **SPEC.md is the source of truth.** Read the section for your module before coding.

## Hard deadline
Code freeze **Sun 25 Oct 11:00**. Hacking ends 12:00. Prefer finishing a P0 item over starting a P2 one (priorities: SPEC.md §12).

## Module ownership (edit only your own area unless asked)
| Area | Owner | Paths |
|---|---|---|
| Data | Data lead | `pipeline/`, `config/stations.yaml` |
| Model | Model lead | `analysis/`, `model/` |
| App | App lead | `web/`, `api/` |
| Story | Story lead | `config/events.yaml`, `config/spots.yaml`, `README.md` |

If you need a change in someone else's area, ask them (or open an issue) instead of editing it.

## Contracts
- The JSON shapes in **SPEC.md §8** are the interface between teams. `web/src/contracts.ts` mirrors them; `tests/fixtures/` holds a valid sample of each file.
- **Never change a contract silently.** If one must change: update SPEC.md §8, `contracts.ts` and the fixture in the same PR, and tell the team.
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
8. Don't add scope from SPEC.md §1 "out of scope" (no flood-spread sim, no sandbags, no second model).

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
