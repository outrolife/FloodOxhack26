# River Clock: Devpost draft

<!-- Draft for the Devpost submission (deadline Sun 25 Oct 2026, 12:00 GMT). Paste section by section.
     Every number is read from committed JSON on main (src comments). If `make train backtest` runs again (#125), re-check each src before submitting. Don't round up. -->

**Tagline (max ~200 characters):** Water upstream is Oxford's future. We read it as a clock. River Clock predicts when, and how likely, five Oxford flood spots will flood in the next 72 hours, so people can decide in time.

---

## Inspiration

Oxford floods from the river, slowly. The water that reaches Botley Road or Osney Island on Thursday is often already in the Thames at Farmoor, or in the Cherwell at Enslow, on Tuesday. The Environment Agency publishes every gauge reading and issues official warnings. But a resident looking at a gauge chart still can't easily answer: *how likely is my street to flood, and by when? Is it worth moving the car tonight?*

We wanted to turn the river upstream into a clock that Oxford can read: a prediction you can make a decision with.

## What it does

River Clock gives five Oxford trouble spots (Osney Island, Botley Road, Abingdon Road, Wolvercote and the Cherwell at Kings Mill) a chance of flooding and an arrival time, hour by hour, for the next 72 hours. It's one screen:

- **A map of the rivers flowing and rising**, with a clock face for each spot that fills as the flood chance rises and counts down to when the water is likely to arrive. The water travels: on the Cherwell, a rise at Enslow reaches Kings Mill about 19 hours later. <!-- src: web/public/data/travel_times.json enslow->kingsmill tHalf median 18.6, n 6 -->
- **A timeline** of our forecast against the real river level, with three markers: **River Clock warned · EA warned · Flooded**. Press play and it runs hour by hour, with the model seeing only what was known at each moment.
- **A two-line scoreboard** and a switch: **Now | 2014 | Jan 2024 | Nov 2024 | 2026 near miss**.
- **A one-line proof footer:** across 30 floods, River Clock caught 30 and the official warning 24. <!-- src: web/public/data/proof.json tradeoff pStar 0.5 hits; officialOutcome hits -->
- **Show the working** holds everything else: sandbag screening for Osney and Botley (where 500 bags would do the most good, and by when), the accuracy charts, a cost–loss calculator for residents, commuters and the council, and the data-quality report.

The screen always says: *Decision-support prototype, not an official warning. Check gov.uk/check-flooding.* It runs fully offline.

## How we built it

1. **The finding.** For each past flood we matched the half-rise and peak times at upstream and Oxford gauges to measure travel times (at least 3 clean floods per pair, or a cross-correlation fallback). The steadiest link: the Cherwell at Enslow reaches Kings Mill in about **18.6 h** (15–23 h, 6 floods). On the Thames side, in Jan 2014 Cassington peaked 84 h and Farmoor 28 h before New Botley. <!-- src: web/public/data/travel_times.json; docs/tiger-data.md query b -->
2. **One model.** LightGBM quantile regression, one model per gauge, lead time (6–72 h) and quantile (5–95%). Inputs are each upstream gauge's level relative to its own median, at the lags the travel times chose, plus rain already fallen and the season. River level, not flow; never compared across gauges. Conformal calibration sets the range widths.
3. **One baseline.** Probabilistic persistence: "the level stays where it is, give or take the usual change". Every accuracy score is relative to it.
4. **Proof.** Leave-one-flood-out replays of seven events from 2007 to 2026, tests that no data after the issue time leaks into the inputs or the replays, and a strict time split (from Oct 2021) for the accuracy scores. The EA's own historic warnings are scored with exactly the same rules.
5. **Decisions.** A cost–loss rule: act when the chance of flooding is above cost ÷ loss. It drives the advice lines and the alarm level.
6. **Protect.** The forecast level, pushed 200 times through the EA's 1 m LiDAR terrain, gives a wet-frequency map; buildings are ranked for sandbags, and the map is checked against the EA's recorded 2014 outline.

**Stack:** Python 3.11 (pandas, NumPy, SciPy, LightGBM, DuckDB, Parquet), FastAPI for the live endpoint, and React + TypeScript + Vite with Leaflet for the app, with a bundled OpenStreetMap basemap so it needs no network.

**Data at a glance:** 3,287,615 hourly rows over 21 river-level and rain series, Jan 2006 to Oct 2026, built from 8.76M fifteen-minute EA level readings. Coverage is 91.2–99.8% of hours for each of the nine gauges with history. <!-- src: docs/tiger-data.md; web/public/data/quality.json -->

**Tiger Data.** We mirror all of it into a Tiger Data (Timescale) hypertable with a daily continuous aggregate. Compression took it from 434 MB to 35 MB (12.4×), and one SQL query shows the clock: in Jan 2014, Cassington peaked 84 h, Farmoor 28 h and Eynsham 9 h before New Botley's 3.032 m peak (09:00 GMT, 9 Jan). <!-- src: docs/tiger-data.md (PR #63) -->

**Live mode.** Polling the EA (17 requests) in 4 polite parallel workers cut a full refresh from 199.8 s to 28.5 s, still at most once every 15 minutes. <!-- src: PR #62 -->

**Data:** EA Hydrology API (history), EA flood-monitoring API (live), EA Historic Flood Warnings, EA LiDAR and Recorded Flood Outlines, GOV.UK check-for-flooding thresholds, OpenStreetMap. All open data (OGL v3 and ODbL).

## Challenges we ran into

**The gauge we planned to forecast had no usable history.** Our plan was built around the Osney Lock gauge, whose flood threshold is on its downstream side. In the first hour we checked the EA data before writing any model code. The public history holds only the *upstream* side of the lock, which the weir keeps almost flat: 0.19 m at the 2014 peak. A model trained on that would have learned nothing about floods. We re-targeted to four gauges whose history matches their thresholds: New Botley, Minns Estate, Cold Harbour and Kings Mill. For Osney Island we use Minns Estate, about 1.2 km west, as a stand-in, checked against residents' flood reports. We say so on screen.

**Scoring ourselves honestly against the EA.** It's easy to make a forecast look good by scoring it loosely. We fixed three things before the final run: a forecast at time t may only use readings up to t − 1 h, an EA warning counts as in force until 24 h after its last update, and both River Clock and the EA are scored on the same floods with the same rules. Some of our best-looking numbers got worse, and we kept the new ones.

**The clocks go back during the hackathon.** UK time changed from BST to GMT at 02:00 on Sunday morning, in the middle of our overnight run. The EA's historic warnings are in naive UK local time, with one repeated hour every autumn. We store and compute everything in UTC, convert only in the UI, and have a test for timestamps across the change.

**Many agents, one repo.** Three people each ran several Claude Code sessions in parallel. To stop them colliding we built a shared status board (one file per session on a separate branch, shown to every session before each prompt), used GitHub issues with claim labels as the task list, and wrote JSON contracts with fixtures so the app could be built before the model existed. Late on Saturday we rebuilt the whole UI, first into four screens and then into one, after a user told us there was too much going on. The contracts let that happen without touching the model.

**Few floods.** Oxford has only a handful of big river floods since 2007. Every event-level number has wide uncertainty, so we report bootstrap intervals, and we kept a near miss (winter 2026) as a false-alarm test.

## Accomplishments that we're proud of

- **The 2014 replay.** River Clock first said Botley Road was more likely than not to flood at 12:00 GMT on Sat 4 Jan 2014: **7 hours before the EA's Flood Warning** and **37 hours before the river crossed** the flood line. The peak, 3.03 m, was inside the 2.62–3.15 m range it gave 72 hours before. That's one flood: averaged over all floods at Botley, the EA's warning came earlier than ours. <!-- src: web/public/data/replays/e2014.json (botley pFlood >= 0.5 at 2014-01-04T12:00Z; EA warning 2014-01-04T19:03:30Z; crossing 2014-01-06T01:00Z; peak 3.027 m; forecast 2014-01-06T08:00Z h72 q05 2.622 q95 3.152); proof.json perEvent e2014 botley leadVsOfficialH 7.06; tradeoff botley pStar 0.5 meanLeadVsOfficialH -5.92 -->
- **Honest scores.** On forecasts from Oct 2021 on that no model saw, River Clock is **39% more accurate than "nothing changes" at 6 h, 27% at 24 h and 11% at 72 h** (pooled over four gauges). <!-- src: web/public/data/proof.json skillByLead 0.3915, 0.2664, 0.1079 -->
- **Early, without crying wolf.** Across seven events, at a 1-in-2 trigger River Clock caught **30 of 30 floods with 5 false alarms**, about 19 hours before the river crossed on average. The EA's warnings, scored the same way: **24 of 30 with 1 false alarm**. On timing it's mixed: ahead of the EA at Osney (+2.1 h) and the Cherwell (+8.2 h), behind at Botley (−5.9 h) and Abingdon Road (−14.6 h). We don't claim to beat the EA. <!-- src: proof.json tradeoff pStar 0.5 (hits 7+8+8+7, falseAlarms 2+3+0+0, meanLeadH weighted 19.1, meanLeadVsOfficialH 2.13 / 8.16 / -5.92 / -14.58); officialOutcome (hits 5+8+8+3, falseAlarms 1) -->
- **The near miss.** In winter 2026 the river came within 11 cm of Botley's flood line. Our highest chance was 28%, so a 1-in-2 trigger raised no false alarm. <!-- src: web/public/data/replays/e2026.json botley max pFlood 0.2767, newbotley peak 2.647 m vs 2.76 m -->
- **Sandbag screening** (in Show the working). A map whose 2014 flood spread overlaps the EA's recorded outline at 68% (intersection-over-union), with every caveat on screen. <!-- src: web/public/data/spread/e2014/manifest.json validation.iou 0.681 -->
- Every spot threshold is backed by dated evidence: news reports, residents' newsletters and EA warnings, with links in the config.
- Twenty years of Oxford river data in Tiger Data at 35 MB, queryable in SQL. The whole demo runs offline. <!-- src: docs/tiger-data.md -->

## What we learned

- Look at the data first. A one-hour check saved the project.
- A strong simple baseline keeps you honest. Our edge over "the level stays where it is" shrinks from 39% at 6 hours to 11% at 72. <!-- src: web/public/data/proof.json skillByLead -->
- Score the official system with your own rules before you compare yourself with it.
- With few events, uncertainty is the result, not a footnote.
- Clear contracts and a shared status board let many AI agents and people work in parallel without stepping on each other.

## What's next for River Clock

- **Rain forecasts.** We already tested real archived ECMWF rain forecasts (2024 on): 72 h accuracy against the simple guess rose from +11% to +28%, but they added 3 false alarms and the test window holds only one flood, so they're not switched on. Next: train the model to trust the forecast less, and score it on more floods. <!-- src: issue #100 results comment (72 h +0.114 -> +0.278; Botley FA 1 -> 3, Osney 0 -> 1) -->
- Get the downstream lock histories from the EA, so Osney, Godstow and Iffley can be forecast directly instead of through stand-ins.
- Work with Osney Island residents and Oxford City Council to check thresholds and sandbag sites street by street.
- Use the Tiger Data mirror as the live store, so the API serves history and live readings from one SQL source.

## Honest limits

Substitute gauges (Osney uses a gauge 1.2 km west; Abingdon Road uses Cold Harbour). Kings Mill has sent no live data since 13 Oct, so the Cherwell shows "no forecast" live. Wolvercote has no forecast at all (no gauge history). No future rain. Only seven events. Each replay's model was trained without that flood but may have seen later ones (the 2014 model has seen 2024), which is why the accuracy scores use a strict time split. River flooding only, and not an official warning.

---

## Built with

`python` `lightgbm` `pandas` `numpy` `scipy` `duckdb` `parquet` `fastapi` `uvicorn` `react` `typescript` `vite` `leaflet` `openstreetmap` `environment-agency-api` `open-data` `tiger-data` `timescaledb` `postgresql` `claude-code` `github`

## Prizes we're entering

- **[HRT] Best Use of Data for Predictions and Decision Making.** River Clock is a prediction that ends in a decision. It forecasts a probability and an arrival time per street-level spot from 20 years of open EA data, proves it against a baseline and against the official warnings scored the same way, then turns it into a decision: a cost–loss trigger per user (move the car at 1%, close a road at 5%) and, in Show the working, where sandbags should go and by when.
- **[MLH] Best Use of Tiger Data.** Built and measured (#17, PR #63). `make mirror` copies all 3,287,615 hourly river and rain rows (2006–2026) and the live readings into a `readings_hourly` hypertable (180-day chunks), with a `gauges` table and a `readings_daily` continuous aggregate. Re-runs are idempotent. Columnstore compression: 434 MB → 35 MB (12.4×). Example query: upstream peak times before New Botley's Jan 2014 peak (Cassington 84 h, Farmoor 28 h, Eynsham 9 h). Setup and five real queries: `docs/tiger-data.md`. <!-- src: docs/tiger-data.md -->

## Links

- Code: https://github.com/outrolife/FloodOxhack26
- Demo: runs locally and fully offline (`make demo`); no public deploy.
- Video: <!-- TODO if required -->

## Team

One team of three: **s-s01s** (project manager and integration), **alfredo** and **adi**, each working with several Claude Code sessions.
