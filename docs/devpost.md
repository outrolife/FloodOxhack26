# River Clock: Devpost draft

<!-- Draft for the Devpost submission (deadline Sun 25 Oct 2026, 12:00 GMT). Paste section by section.
     Fill every RESULTS / TODO marker from web/public/data/proof.json before submitting. Don't round up. -->

**Tagline (max ~200 characters):** Water upstream is Oxford's future. We read it as a clock. River Clock forecasts when, and how likely, five Oxford flood spots will flood in the next 72 hours.

---

## Inspiration

Oxford floods from the river, slowly. The water that reaches Botley Road or Osney Island on Thursday is often already in the Thames at Farmoor, or in the Cherwell at Enslow, on Tuesday. The Environment Agency publishes every gauge reading and issues official warnings. But a resident looking at a gauge chart still can't easily answer: *how likely is my street to flood, and by when? Is it worth moving the car tonight?*

We wanted to turn the river upstream into a clock that Oxford can read.

## What it does

River Clock gives five Oxford trouble spots (Osney Island, Botley Road, Abingdon Road, Wolvercote and the Cherwell at Kings Mill) a flood forecast for the next 72 hours:

- **River:** a map of the spots coloured by their chance of flooding in the next 24 hours, and a "river strip" of upstream gauges labelled with how long water takes to reach Oxford ("≈ __ h").
- **Time Machine:** replay a real past flood, hour by hour, using only what was known at that moment. Watch the forecast range narrow, see when River Clock reached 50%, and compare that with when the EA issued its warning.
- **Decide:** choose who you are (resident, commuter, council) or set your own costs. River Clock tells you the chance at which acting is worth it, and how much each strategy would have cost over past floods.
- **Proof:** skill against a simple baseline, calibration, hits and false alarms, and the travel-time finding, with uncertainty intervals.
- **About:** how it works, the limitations, and every data source with its licence.

Every screen says: *Decision-support prototype, not an official warning. Check gov.uk/check-flooding.*

## How we built it

1. **The finding.** For each past flood we matched the half-rise and peak times at upstream and Oxford gauges to measure travel times (at least 3 clean floods per pair, or a cross-correlation fallback).
2. **One model.** LightGBM quantile regression, one model per gauge, lead time (6–72 h) and quantile (5–95%). Inputs are each upstream gauge's level relative to its own median, at the lags the travel times chose, plus recent rainfall and the season. We used river level, not flow, and never compared levels across gauges. Conformal calibration adjusts the intervals so a 90% range holds about 90% of the time.
3. **One baseline.** Probabilistic persistence: "the level stays where it is, give or take the usual change". Every skill score is relative to it.
4. **Proof.** Leave-one-flood-out replays of seven events from 2007 to 2026, issuing a forecast every hour, with tests that no data after the issue time leaks in. Official warning issue times come from the EA Historic Flood Warnings dataset.
5. **Decisions.** A cost–loss rule: act when the chance of flooding is above cost ÷ loss.

**Stack:** Python 3.11 (pandas, NumPy, SciPy, LightGBM, DuckDB, Parquet), FastAPI for the live endpoint, and React + TypeScript + Vite with Leaflet and Recharts for the app. The app runs fully offline from committed JSON.

**Data:** EA Hydrology API (history), EA flood-monitoring API (live), EA Historic Flood Warnings, GOV.UK check-for-flooding thresholds, OpenStreetMap. All open data (OGL v3 and ODbL).

## Challenges we ran into

**The gauge we planned to forecast had no usable history.** Our plan was built around the Osney Lock gauge, whose flood threshold is on its downstream side. In the first hour we checked the EA data before writing any model code. The public history holds only the *upstream* side of the lock, which the weir keeps almost flat: 0.19 m at the 2014 peak, and −0.001 m on a day in Feb 2026 when the downstream side read 3.34 m. A model trained on that would have learned nothing about floods. We re-targeted to four gauges whose history matches their thresholds: New Botley, Minns Estate, Cold Harbour and Kings Mill. For Osney Island we use Minns Estate, about 1.2 km west, as a stand-in, and we checked it against residents' flood reports from 2007, 2014, 2021, 2023, 2024 and 2026. We say so on screen.

**The clocks go back during the hackathon.** UK time changed from BST to GMT at 02:00 on Sunday morning, in the middle of our overnight run. The EA's historic warnings are in naive UK local time, with one repeated hour every autumn. We store and compute everything in UTC, convert only in the UI, and have a test for timestamps across the change.

**Many agents, one repo.** Several people each ran one or more Claude Code sessions in parallel. To stop them colliding we built a shared status board (one file per session on a separate branch, shown to every session before each prompt), used GitHub issues with claim labels as the task list, and wrote JSON contracts with fixtures so the app could be built before the model existed. An onboarding guide gets a new session from clone to a claimed issue, and an observer role watches progress without changing anything.

**Few floods.** Oxford has only a handful of big river floods since 2007. Every event-level number has wide uncertainty, so we report bootstrap intervals rather than single numbers, and we kept a near miss (winter 2026) as a false-alarm test.

## Accomplishments that we're proud of

- We checked the data before trusting the plan, and changed course in the first hour rather than at 3 am.
- Every spot threshold is backed by dated evidence: news reports, residents' newsletters and EA warnings, with links in the config.
- An honest proof page: skill against a baseline, calibration, and lead time against official warnings. If the model loses somewhere, the page says so.
- <!-- RESULTS: fill from proof.json, e.g. "In the 2014 replay, River Clock reached 50% for Botley Road __ h before the first EA warning." Only if true. -->
- The whole demo runs offline from committed JSON.

## What we learned

- Look at the data first. A one-hour check saved the project.
- A strong simple baseline keeps you honest. "The level stays where it is" is hard to beat at short lead times. <!-- RESULTS: confirm from skillByLead -->
- With few events, uncertainty is the result, not a footnote.
- Clear contracts and a shared status board let many AI agents and people work in parallel without stepping on each other.
- Times are hard. Use UTC everywhere and convert at the edge.

## What's next for River Clock

- Add forecast rainfall (for example ensemble forecasts) as an input, so the clock can see rain that hasn't fallen yet.
- Get the downstream lock histories from the EA, so Osney, Godstow and Iffley can be forecast directly instead of through stand-ins.
- Work with Osney Island residents and Oxford City Council to check thresholds street by street.
- Planned for this weekend if time allows: a public deploy on Vultr (#18) and a Tiger Data mirror of the hourly and live readings (#17).

---

## Built with

`python` `lightgbm` `pandas` `numpy` `scipy` `duckdb` `parquet` `fastapi` `uvicorn` `react` `typescript` `vite` `leaflet` `recharts` `openstreetmap` `environment-agency-api` `open-data` `claude-code` `github`

<!-- Add `vultr` and `timescale` / `tiger-data` only if #18 and #17 are merged and working. -->

## Sponsor tracks we're targeting

<!-- TODO: check the exact track names on the OxHack26 Devpost page before submitting. -->

- **MLH: Best use of Vultr.** Planned (#18): deploy the API and app on Vultr. Only submit if it's live.
- **Tiger Data (Timescale).** Planned (#17): mirror the hourly and live gauge readings into Tiger Data. Only submit if it works.
- <!-- TODO: any other tracks (e.g. best use of open data, sustainability) -->

## Links

- Code: https://github.com/outrolife/FloodOxhack26
- Demo: <!-- TODO: Vultr URL if deployed, else "runs locally: make web" -->
- Video: <!-- TODO if required -->
