# River Clock: one page for judges

> **Decision-support prototype, not an official warning. Check [gov.uk/check-flooding](https://www.gov.uk/check-flooding).**

## River Clock in 30 seconds

Oxford floods from the river, slowly: the water that floods Botley Road is already upstream a day or more before. We measured how long it takes to arrive. From **Cassington to New Botley the rise takes about 9.5 h (median over 24 past floods)**. From **Enslow to Kings Mill it takes about 18.6 h (15–23 h, 6 floods)**. <!-- src: web/public/data/travel_times.json --> One LightGBM model uses those travel times to give five Oxford trouble spots a **chance of flooding and an arrival time, hour by hour, for the next 72 h**. A cost–loss rule then says when acting is worth it. Every score is against a "nothing changes" baseline.

## How it works

```
 EA Hydrology API (15-min history)      EA flood-monitoring API (live, every 15 min)
            |                                         |
            v                                         v
 hourly.parquet: 3.29M rows, 21 series, 2006-2026  live_hourly.parquet ----> Tiger Data mirror
            |                                                                (SQL copy, 35 MB)
            v
 Travel times: half-rise and peak matching per gauge pair (n >= 3 floods, else cross-correlation)
            |  p10 / p50 / p90 lags
            v
 Features: each gauge vs its OWN median, at those lags; past rain; season (no future data)
            v
 LightGBM quantile models: per gauge x lead (6-72 h) x quantile (5-95%)
            v
 Conformal calibration on held-out floods (so a "90% range" holds ~90%)
            v
 Probability of passing each spot's EA threshold + arrival window (10/50/90%)
            v
 Leave-one-flood-out replays + proof metrics  ->  replays/*.json, proof.json
            v
 App (offline, committed JSON): River . Time Machine . Decide . Proof . About
```
<!-- src: SPEC.md §5-§8; row counts from docs/tiger-data.md -->

## Why you can trust it

- **We checked the data before the model.** In the first hour we found that the public history for the Osney, Godstow and Iffley lock gauges holds only the *upstream* side. The weir holds that side almost flat in a flood (Osney read 0.19 m at the 2014 peak). Their flood side has 0.7% coverage: 55 days of an archive. So we re-targeted to four gauges whose history matches their thresholds: New Botley, Minns Estate, Cold Harbour and Kings Mill (91.2–99.8% coverage for the gauges with history). <!-- src: SPEC.md §4.1.1; web/public/data/quality.json -->
- **Leave-one-flood-out.** Each past flood is replayed with a model trained without it (±7 days), issuing a forecast every hour.
- **A strong baseline.** Persistence ("the level stays where it is") scores every forecast. If we lose to it, the Proof tab says so.
- **Calibration is measured.** We report interval coverage against nominal and reliability diagrams, and the app flags gaps over 10 points.
- **Leakage tests.** Tests change future data and check that no input and no replay forecast changes (`tests/test_features.py`, `tests/test_backtest.py`).
- **Honest counts.** Nine of eleven travel-time pairs rest on at least 3 floods. The other two are labelled "cross-correlation only". Event-level numbers carry 90% bootstrap intervals.
- **Checked thresholds.** Each spot's threshold is checked against dated news, council and residents' reports (`config/spots.yaml`).

**The 2014 replay (Botley Road, times GMT):** River Clock first reached 50% at 12:00 on 4 Jan, **about 7 h before the EA's Flood Warning** (19:03) and 37 h before New Botley crossed 2.76 m (01:00, 6 Jan). The peak was inside the 5–95% band at every lead from 6 to 72 h. The EA's lower-level Flood Alert (23 Dec) came before our first 10%. <!-- src: web/public/data/replays/e2014.json -->

**Over all seven events:**
- **Skill vs persistence** is positive at every lead, from +0.39 at 6 h to +0.11 at 72 h (forecasts from Oct 2021 on, which no model saw).
- **Ranges are too wide:** the 90% range holds 94–97%.
- **Floods caught at a 50% trigger:** every flood at all four forecast spots, with 0–3 false alarms per spot.
- **Versus the EA's warning, mixed:** earlier at Osney (+2.9 h) and the Cherwell (+9.2 h), later at Botley (−5.1 h) and Abingdon Road (−13.8 h).
- **2026 near miss:** our highest flood chance was 28%, so there were no false alarms at triggers of 30% or more. <!-- src: web/public/data/proof.json; replays/e2026.json -->

## What it can't do

- **Few floods:** seven named events since 2007, one a near miss. Uncertainty is wide.
- **Not always better:** at Abingdon Road the probability forecast is slightly worse than persistence from 24 h on (Brier score), and at long leads near-certain forecasts are too confident.
- **No future rain:** it sees water already in the river and rain already fallen.
- **Stand-ins:** Osney Island uses Minns Estate, about 1.2 km west. Abingdon Road uses Cold Harbour. Wolvercote has no forecast (no gauge history).
- **Leave-one-flood-out can see later floods:** the 2014 replay's model has seen 2024. Strict time-split results are reported separately.
- **River flooding only:** no surface water or groundwater. Kings Mill has sent no live data since 13 Oct.
- **Not a warning:** it does not replace the EA.

## Sponsor tech: Tiger Data

A one-way SQL mirror of all our river data on a Tiger Data (Timescale) service. It holds a `readings_hourly` hypertable (**3,287,615 history rows**, 2006–2026, plus live readings), a `gauges` table (normal range and flood threshold for each gauge) and a `readings_daily` continuous aggregate. Compression took it from **434 MB to 35 MB (12.4×)**, and re-runs are idempotent. <!-- src: docs/tiger-data.md -->

*One query:* when did each upstream gauge peak before New Botley in Jan 2014? **Cassington 84 h, Farmoor 28 h, Eynsham 9 h** before New Botley's 3.032 m peak (09:00 GMT, 9 Jan). That's the clock, straight from SQL.

Also measured: a live refresh of the EA (17 requests) went from 199.8 s to 28.5 s. <!-- src: PR #62 -->

More: `README.md` · `docs/tiger-data.md` · `SPEC.md` · github.com/outrolife/FloodOxhack26
