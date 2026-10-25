# FloodClock: one page for judges

> **Decision-support prototype, not an official warning. Check [gov.uk/check-flooding](https://www.gov.uk/check-flooding).**

<!-- Every number is read from committed JSON on main (src comments). Re-check them if `make train backtest` runs again. -->

## FloodClock in 30 seconds

Oxford floods from the river, slowly: the water that floods Botley Road is upstream a day or more before it arrives. We measured how long it takes. On the Cherwell, a rise at **Enslow reaches Kings Mill in about 18.6 h (15–23 h, over 6 floods)**. <!-- src: web/public/data/travel_times.json enslow->kingsmill tHalf median 18.6, p10 15.0, p90 22.8, n 6 --> One LightGBM model uses those travel times to make a **prediction for five Oxford trouble spots: the chance of flooding and the arrival time, hour by hour, for the next 72 h**. A cost–loss rule turns that into a **decision**: is it worth acting yet? Every score is against a "nothing changes" baseline.

## What you'll see: one screen

| Part | What you see |
|---|---|
| **The map** (hero) | Oxford's rivers flowing and rising as the water comes, with a **clock face for each trouble spot** that fills as its chance of flooding rises, and a countdown to when the water is likely to arrive. |
| **The timeline** (under the map) | Our forecast range against the real river level, with three markers: **FloodClock warned · EA warned · Flooded**. Press play and it runs hour by hour, revealing each reading only after it happened. |
| **The scoreboard** (2 lines) | For the chosen flood: when FloodClock warned, when the EA warned, when it flooded. |
| **The switch** (top) | **Now \| 2014 \| Henk \| Bert \| 2026** (Henk = Jan 2024, Bert = Nov 2024, 2026 = the near miss). Today's live forecast, or a past flood replayed with a model trained without it. |
| **The proof footer** (1 line) | Across all 30 floods we replayed: how many FloodClock caught, and how many the official warning caught. |

Sandbag screening, the accuracy charts and the cost–loss calculator are behind **Show the working**. Presenter keys: **Space** plays, **1–5** switch flood, **P** presenter mode.

## The headline: January 2014, Botley Road (times GMT)

FloodClock first said **more likely than not (60%) at 10:00 on Sat 4 Jan**: **9 h before the EA's Flood Warning** (19:03) and **39 h before** New Botley crossed 2.76 m (01:00, Mon 6 Jan). The peak, **3.03 m** on 9 Jan, was **inside the 2.63–3.16 m range** it gave 72 h before. That's one flood: averaged over all floods at Botley, at its alarm level, we and the EA's warning are level (the EA 0.9 h earlier). <!-- src: web/public/data/replays/e2014.json (botley first pFlood >= 0.5 and >= 0.6 (warnAt) at 2014-01-04T10:00Z, 0.6043; official warning 2014-01-04T19:03:30Z; crossing 2014-01-06T01:00Z; newbotley peak 3.027 m at 2014-01-09T09:00Z; forecast 2014-01-06T08:00Z h72 q05 2.627, q95 3.157); proof.json perEvent e2014 botley leadVsOfficialH 9.06; tradeoff botley pStar 0.6 (warnAt) meanLeadVsOfficialH -0.92 -->

## How good is it? (the final numbers)

- **More accurate than the simple guess** ("the river stays where it is"): **+39% at 6 h, +29% at 24 h, +12% at 72 h**, pooled over our four gauges, on forecasts from Oct 2021 on that no model saw. <!-- src: web/public/data/proof.json skillByLead (0.3943, 0.2890, 0.1150); testPeriodNote -->
- **Floods caught at each spot's alarm level** (the app's trigger, chosen on pre-2021 floods only: Osney 30%, Botley 60%, Abingdon Rd 20%, Cherwell 30%): **29 of 30**, across four spots, with **6 false alarms**. The EA's own warnings, scored the same way: **24 of 30, with 1 false alarm**. At a flat 50% trigger: 28 of 30, 5 false alarms. <!-- src: proof.json warnAt[spot].pStar; tradeoff at warnAt (hits 7+7+8+7, misses 0+1+0+0, falseAlarms 3+2+1+0); tradeoff pStar 0.5 (hits 6+7+8+7, falseAlarms 2+3+0+0); officialOutcome (hits 5+8+8+3, falseAlarms 0+0+0+1) -->
- **The one miss:** the July 2007 summer storm at Botley (at 50%, Osney misses it too). It was a sudden summer downpour, which an upstream river signal can't see coming. <!-- src: proof.json warnAt.botley.perEvent e2007 misses 1; tradeoff pStar 0.5 osney/botley misses 1 (e2007, PR #162) -->
- **Timing against the EA is mixed:** we were earlier at **12 of the 19 floods where both warned**. On average at the alarm levels we're ahead at **Osney (+22.1 h)** and the **Cherwell (+25.2 h)**, and level at **Botley (−0.9 h)**. Abingdon Road shows +37.8 h, but that is flattered by one 2014 call nine days early; without it, level (+0.3 h). <!-- src: proof.json tradeoff at warnAt meanLeadVsOfficialH 22.13, 25.16, -0.92, 37.75; warnAt.abingdonrd.perEvent e2014 225.06, other five average 0.29; 12 of 19 as web/src/clock/story.ts proofSummary -->
- **Typical warning before the river crossed:** about 36 h at the alarm levels (22 h at the Cherwell to 43 h at Osney). <!-- src: proof.json tradeoff at warnAt meanLeadH weighted by hits: (7*43.43 + 7*40.43 + 8*37.62 + 7*21.86) / 29 = 35.9 -->
- **The 2026 near miss:** the river stayed high for weeks and came within 11 cm of Botley's line; our highest chance was **just under 30%**, below every spot's alarm level, so it raised **no false alarm**. <!-- src: replays/e2026.json botley max pFlood 0.2994 (warnAt 0.6), newbotley peak 2.647 m vs threshold 2.76; warnAt[spot].perEvent e2026 falseAlarms 0 -->
- **Ranges:** too wide over all hours (the 90% range holds 94–98%), close to right in floods (87–89%). <!-- src: proof.json coverage nominal 0.9 actual 0.9372–0.9755; testPeriodNote -->

## How it works

```
 EA Hydrology API (15-min history)      EA flood-monitoring API (live, every 15 min)
            |                                         |
            v                                         v
 hourly.parquet: 3.29M rows, 21 series, 2006-2026  live readings ----> Tiger Data mirror (SQL, 35 MB)
            v
 Travel times: half-rise and peak matching per gauge pair (n >= 3 floods, else cross-correlation)
            v
 Features: each gauge vs its OWN median, at those lags; past rain; season (no future data)
            v
 LightGBM quantile models: per gauge x lead (6-72 h) x quantile (5-95%), conformal calibration
            v
 Chance of passing each spot's EA threshold + arrival window  ->  cost-loss decision
            v
 Leave-one-flood-out replays + proof metrics  ->  replays/*.json, proof.json
            v
 App (offline, committed JSON): one screen: map + timeline + scoreboard + proof
```
<!-- src: SPEC.md §5-§8; row counts from docs/tiger-data.md -->

## Why you can trust it

- **Data before the model.** In the first hour we found the Osney, Godstow and Iffley lock gauges have no public history on their flood side (0.7% coverage). We switched to four gauges whose history matches their thresholds and said so on screen. <!-- src: web/public/data/quality.json -->
- **No look-ahead.** Tests change future data and check that no input and no replay forecast changes. A forecast at t uses rows only up to t − 1 h.
- **A strong baseline** scores every forecast, and **the EA's own warnings are scored with our rules**, on the same floods.
- **We report what didn't work:** the rain-forecast test, the per-spot timing losses, the wide ranges.

## What it can't do

- **Few floods:** seven events since 2007, one a near miss; 30 spot-level floods from about 7 storms.
- **Leave-one-flood-out can see later floods:** the 2014 replay's model has seen 2024. The accuracy scores use a strict time split instead.
- **No future rain:** it sees water already in the river and rain already fallen.
- **Substitute gauges:** Osney Island uses Minns Estate, about 1.2 km west; Abingdon Road uses Cold Harbour. **Wolvercote has no forecast** (no gauge history). **Kings Mill has sent no live data since 13 Oct**, so the Cherwell shows "no forecast" live.
- **River flooding only.** Not a warning, and it does not replace the EA.

## What's next: rain forecasts (tested, not switched on)

With real archived ECMWF rain forecasts (2024 on), 72 h accuracy against the simple guess rose from **+11% to +28%**, but it added **3 false alarms**, Botley's flood odds scored worse, and the test window holds only one flood. It fails our own adoption rule, so it stays off. <!-- src: issue #100 results comment (branch model/rain-features) -->

## Sponsor tech: Tiger Data

A one-way SQL mirror of all our river data on a Tiger Data (Timescale) service: a `readings_hourly` hypertable (**3,287,615 history rows**, 2006–2026, plus live readings), a `gauges` table and a `readings_daily` continuous aggregate. Compression took it from **434 MB to 35 MB (12.4×)**; re-runs are idempotent. One query shows the clock: in Jan 2014, **Cassington peaked 84 h and Farmoor 28 h before New Botley**. The app doesn't need it, so the demo runs offline. <!-- src: docs/tiger-data.md -->

Team: **s-s01s, alfredo, adi**. More: `README.md` · `docs/tiger-data.md` · `SPEC.md` · github.com/outrolife/FloodOxhack26
