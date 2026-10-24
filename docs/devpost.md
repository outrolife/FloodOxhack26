# River Clock: Devpost draft

<!-- Draft for the Devpost submission (deadline Sun 25 Oct 2026, 12:00 GMT). Paste section by section.
     Fill every RESULTS / TODO marker from web/public/data/proof.json (PR #66) and replays/e2014.json (PR #39) before submitting. Don't round up. -->

**Tagline (max ~200 characters):** Water upstream is Oxford's future. We read it as a clock. River Clock forecasts when, and how likely, five Oxford flood spots will flood in the next 72 hours.

---

## Inspiration

Oxford floods from the river, slowly. The water that reaches Botley Road or Osney Island on Thursday is often already in the Thames at Farmoor, or in the Cherwell at Enslow, on Tuesday. The Environment Agency publishes every gauge reading and issues official warnings. But a resident looking at a gauge chart still can't easily answer: *how likely is my street to flood, and by when? Is it worth moving the car tonight?*

We wanted to turn the river upstream into a clock that Oxford can read.

## What it does

River Clock gives five Oxford trouble spots (Osney Island, Botley Road, Abingdon Road, Wolvercote and the Cherwell at Kings Mill) a flood forecast for the next 72 hours:

- **River:** a map of the spots coloured by their chance of flooding in the next 24 hours, and a "river strip" of upstream gauges labelled with how long water takes to reach Oxford (for example "Cassington → New Botley ≈ 10 h", measured over 24 past floods). <!-- src: web/public/data/travel_times.json, cassington→newbotley tHalf.median 9.5 h, n 24 -->
- **Time Machine:** replay a real past flood, hour by hour, using only what was known at that moment. Watch the forecast range narrow, see when River Clock reached 50%, and compare that with when the EA issued its warning.
- **Decide:** choose who you are (resident, commuter, council) or set your own costs. River Clock tells you the chance at which acting is worth it, and how much each strategy would have cost over past floods.
- **Proof:** skill against a simple baseline, calibration, hits and false alarms, and the travel-time finding, with uncertainty intervals.
- **About:** how it works, the limitations, and every data source with its licence.

Every screen says: *Decision-support prototype, not an official warning. Check gov.uk/check-flooding.*

## How we built it

1. **The finding.** For each past flood we matched the half-rise and peak times at upstream and Oxford gauges to measure travel times (at least 3 clean floods per pair, or a cross-correlation fallback). The best-supported links: the Evenlode at Cassington reaches New Botley in about **9.5 h** (median over 24 floods), and the Cherwell at Enslow reaches Kings Mill in about **18.6 h** (6 floods, range 15–23 h). Nine of eleven pairs have at least 3 floods; the other two are labelled "cross-correlation only". <!-- src: web/public/data/travel_times.json -->
2. **One model.** LightGBM quantile regression, one model per gauge, lead time (6–72 h) and quantile (5–95%). Inputs are each upstream gauge's level relative to its own median, at the lags the travel times chose, plus recent rainfall and the season. We used river level, not flow, and never compared levels across gauges. Conformal calibration adjusts the intervals so a 90% range holds about 90% of the time.
3. **One baseline.** Probabilistic persistence: "the level stays where it is, give or take the usual change". Every skill score is relative to it.
4. **Proof.** Leave-one-flood-out replays of seven events from 2007 to 2026, with tests that no data after the issue time leaks into the inputs or the replays. Official warning issue times come from the EA Historic Flood Warnings dataset.
5. **Decisions.** A cost–loss rule: act when the chance of flooding is above cost ÷ loss.

**Stack:** Python 3.11 (pandas, NumPy, SciPy, LightGBM, DuckDB, Parquet), FastAPI for the live endpoint, and React + TypeScript + Vite with Leaflet and Recharts for the app. The app runs fully offline from committed JSON.

**Data at a glance:** 3,287,615 hourly rows over 21 river-level and rain series, Jan 2006 to Oct 2026, built from 8.76M fifteen-minute EA level readings. Coverage is 91.2–99.8% of hours for each of the nine gauges with history. <!-- src: docs/tiger-data.md; web/public/data/quality.json -->

**Tiger Data.** We mirror all of it into a Tiger Data (Timescale) hypertable with a daily continuous aggregate. Compression took it from 434 MB to 35 MB (12.4×), and one SQL query shows the travel-time idea: in Jan 2014, Cassington peaked 84 h, Farmoor 28 h and Eynsham 9 h before New Botley's 3.032 m peak (09:00 GMT, 9 Jan). <!-- src: docs/tiger-data.md (PR #63) -->

**Live mode.** Polling the EA (17 requests) in 4 polite parallel workers cut a full refresh from 199.8 s to 28.5 s, still at most once every 15 minutes. <!-- src: PR #62 -->

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
- In a leave-one-flood-out replay of January 2014, River Clock reached a 50% chance of flooding for Botley Road at 12:00 GMT on 4 Jan, about **7 hours before the EA's Flood Warning** and 37 hours before the gauge crossed its threshold. That forecast put the 50% arrival at 01:01 on 6 Jan; the gauge crossed at 01:00. The real peak sat inside our 5–95% band at every lead from 6 to 72 hours. (The EA's lower-level Flood Alert came earlier than our first 10%, and we say so.) <!-- src: web/public/data/replays/e2014.json (PR #39). PENDING #66: add the all-events numbers from proof.json -->
- A travel-time finding with honest counts: we quote the links backed by 24 and 6 floods, and label the two that rest on cross-correlation alone. <!-- src: web/public/data/travel_times.json -->
- Twenty years of Oxford river data in Tiger Data at 35 MB, queryable in SQL. <!-- src: docs/tiger-data.md -->
- The whole demo runs offline from committed JSON.

## What we learned

- Look at the data first. A one-hour check saved the project.
- A strong simple baseline keeps you honest. "The level stays where it is" is hard to beat at short lead times. <!-- RESULTS (PENDING #66): confirm from proof.json skillByLead; cut this sentence if the data says otherwise -->
- With few events, uncertainty is the result, not a footnote.
- Clear contracts and a shared status board let many AI agents and people work in parallel without stepping on each other.
- Times are hard. Use UTC everywhere and convert at the edge.

## What's next for River Clock

- Add forecast rainfall (for example ensemble forecasts) as an input, so the clock can see rain that hasn't fallen yet.
- Get the downstream lock histories from the EA, so Osney, Godstow and Iffley can be forecast directly instead of through stand-ins.
- Work with Osney Island residents and Oxford City Council to check thresholds street by street.
- Use the Tiger Data mirror as the live store, so the API can serve history and live readings from one SQL source.

---

## Built with

`python` `lightgbm` `pandas` `numpy` `scipy` `duckdb` `parquet` `fastapi` `uvicorn` `react` `typescript` `vite` `leaflet` `recharts` `openstreetmap` `environment-agency-api` `open-data` `tiger-data` `timescaledb` `postgresql` `claude-code` `github`

## Sponsor tracks we're targeting

<!-- TODO: check the exact track names on the OxHack26 Devpost page before submitting. -->

- **Tiger Data (Timescale).** Built and measured (#17, PR #63). `make mirror` copies all 3,287,615 hourly river and rain rows (2006–2026) and the live readings into a `readings_hourly` hypertable (180-day chunks), with a `gauges` table and a `readings_daily` continuous aggregate. Re-runs are idempotent (0 inserted, 0 updated). Columnstore compression: 434 MB → 35 MB (12.4×), well inside a free service. Example query: upstream peak times before New Botley's Jan 2014 peak (Cassington 84 h, Farmoor 28 h, Eynsham 9 h). Setup and five real queries: `docs/tiger-data.md`. <!-- src: docs/tiger-data.md -->
- <!-- TODO: any other tracks (e.g. best use of open data, sustainability) -->

## Links

- Code: https://github.com/outrolife/FloodOxhack26
- Demo: runs locally and fully offline (`make web`); no public deploy.
- Video: <!-- TODO if required -->
