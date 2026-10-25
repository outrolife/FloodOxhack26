# FloodClock: Specification v3

**Context:** OxHack 2026, Oxford. Hacking ends Sun 25 Oct 12:00; code freeze 11:00. UK clocks go back 02:00→01:00 BST→GMT on Sun 25 Oct. Judging is science-fair style, 4–5 minutes per judge.
**This document is the source of truth.** If something here proves impossible (e.g. data unavailable), apply the stated fallback; if none is stated, stop and ask a human.

---

## 1. Overview

FloodClock forecasts **when, and how likely,** five Oxford flood trouble spots will flood in the next 72 hours, and turns that into timed decisions.

It is built from:
1. **A finding:** from past Oxford floods, measure how long the flood wave takes to travel from upstream river gauges to Oxford.
2. **One model:** a LightGBM quantile forecaster that uses those travel times to choose its upstream inputs and outputs the probability of each spot flooding over time.
3. **One baseline:** probabilistic persistence ("the level stays roughly where it is").
4. **Proof:** replays of real past floods, skill vs the baseline, calibration, and comparison with official Environment Agency (EA) warnings.
5. **Decisions:** a cost–loss rule that says when it's worth acting.

Tagline: *"Water upstream is Oxford's future. We read it as a clock."*

### 1.1 Scope
- **Core (P0–P2):** everything in §3–§10.
- **Stretch (S1–S4):** §11. Built only after the core gate in §13 is passed, in order, one at a time.
- **Out of scope (never build):** a second forecasting model or foundation-model comparison; LSTMs; surface-water or groundwater forecasting; any claim to replace official warnings.

---

## 2. Repository layout

```
river-clock/
  SPEC.md  README.md  Makefile  pyproject.toml
  config/
    stations.yaml   spots.yaml   events.yaml
  data/                       # gitignored: raw/ interim/ processed/ models/ geo/
  pipeline/
    ea_client.py  ingest_history.py  ingest_live.py  ingest_warnings.py
    clean.py  quality_report.py
  analysis/
    travel_times.py
  model/
    features.py  train.py  calibrate.py  probability.py  backtest.py  forecast_live.py
  stretch/                    # S1–S4 only (§11)
  api/
    main.py
  web/                        # React + Vite + TypeScript, Leaflet, Recharts
    public/data/              # committed JSON the app reads (< 50 MB total)
    src/contracts.ts  src/views/{River,TimeMachine,Decide,Proof,About}.tsx
  tests/
    fixtures/                 # valid sample of every JSON contract (§9)
```

**Make targets:** `make data` (ingest history + warnings, clean, quality report) · `make travel` · `make train` (train + calibrate) · `make backtest` (writes `web/public/data/*.json`) · `make live` · `make api` · `make web` · `make test`.

**Stack:** Python 3.11 (pandas, numpy, scipy, lightgbm, pyarrow, duckdb, requests, pyyaml, fastapi, uvicorn; stretch: geopandas, rasterio, shapely). React + Vite + TypeScript, Leaflet, Recharts. Working store: Parquet + DuckDB. Optional mirror: Tiger Data (Timescale/Postgres) for hourly and live readings (P2).

---

## 3. Data sources

All Open Government Licence (OGL) unless noted. Store all timestamps in UTC.

| Source | Access | Use |
|---|---|---|
| EA Hydrology API | `https://environment.data.gov.uk/hydrology/` (docs `/hydrology/doc/reference`). 15-min level measures end in `level-i-900-m-qualified`; rainfall measures available. Station records cross-reference flood-monitoring `stationReference` / `RLOIid` | Full history: training, travel times, backtests |
| EA flood-monitoring API | `https://environment.data.gov.uk/flood-monitoring/` (docs `/doc/reference`, `/doc/rainfall`). `/id/stations/{ref}`, `/id/stations/{ref}/readings?since=…&_sorted&_limit=10000`, `/data/readings?latest`. ~4 weeks history; no key; poll ≤ every 15 min | Live mode; station metadata incl. `stageScale` (`typicalRangeHigh`, `highestRecent`, `maxOnRecord`) |
| Flood-monitoring daily archive | `/flood-monitoring/archive/readings-{YYYY-MM-DD}.csv` (~56 MB/day, all England) | Fallback for gaps in specific event windows only |
| EA Historic Flood Warnings | data.gov.uk dataset `historic-flood-warnings2` (ZIP; alerts, warnings, severe warnings, 26 Jan 2006 → June 2026) | Comparison with official warnings |
| Open-Meteo archive | `https://archive-api.open-meteo.com/v1/archive`, hourly `precipitation` (CC BY 4.0; attribute) | Fallback rainfall |
| OpenStreetMap tiles | Leaflet tile layer (ODbL; attribute) | Base map |

Stretch-only sources are listed in §11.

---

## 4. Configuration

### 4.1 Gauges (`config/stations.yaml`)
Values from EA public pages. **At ingest, re-read thresholds from API metadata and log mismatches** (quality report). Bracketed refs are GOV.UK page IDs: resolve the API `stationReference` on first run and write it back.

| key | Station | River | Role | Ref | Normal top / amber (m) | Property flooding possible (m) | Record (m) |
|---|---|---|---|---|---|---|---|
| farmoor | Farmoor | Thames | upstream | 1100TH | 1.30 | 1.75 | 2.01 (Jul 2007) |
| eynsham | Eynsham Lock (u/s series, §4.1.1) | Thames | upstream | 1201TH | 0.37 (u/s) | – | 1.187 (u/s) |
| cassington | Cassington Weir B | Evenlode | upstream | 1290_w2TH | 0.77 | – | 1.29 (Jul 2007) |
| enslow | Enslow Weir A | Cherwell | upstream | 1460_w1TH | 1.29 | – (unreliable) | 2.10 (Apr 1998) |
| islip | Islip | Ray | upstream | 1489TH | 7.80 | 8.85 | 9.33 (Apr 1998) |
| shifford | Shifford Lock (u/s series, #125) | Thames | upstream | 0904TH | 0.42 (u/s) | – | 0.728 (u/s, Jan 2014) |
| hannington | Hannington Bridge (#125) | Thames | upstream | 0569TH | 3.81 | 4.47 | 4.49 (Jul 2007) |
| worsham | Worsham (#125) | Windrush | upstream | 1080TH | 1.62 | 2.16 | 1.70 (Nov 2024) |
| shipton | Shipton (#125) | Evenlode | upstream | 1238TH | 2.02 | 2.62 | 3.44 (Nov 2024) |
| banbury | Banbury (#125) | Cherwell | live_only | 1420TH | 1.14 | 1.83 | 2.39 (Jul 2007) |
| lowerarncott | Lower Arncott (#125) | Ray | live_only | 1483TH | 2.00 | 3.26 | 2.98 (Jan 2003) |
| godstow | Godstow Lock d/s | Thames | live_only (§4.1.1) | 1302TH | 2.57 | 3.07 | 3.11 (Jul 2007) |
| osney | Osney Lock d/s | Thames | live_only (§4.1.1) | 1303TH | 3.18 | 3.79 | 3.97 (9 Jan 2014) |
| iffley | Iffley Lock d/s | Thames | live_only (§4.1.1) | 1501TH | 2.72 | 3.25 | 3.67 (9 Jan 2014) |
| kingsmill | Kings Mill u/s | Cherwell | target | 1491TH | 2.40 | 2.60 | 2.79 (27 Nov 2024) |
| newbotley | New Botley | Bulstake Stream | target (primary) | 1645TH | 2.01 | 2.76 | 3.14 (Jul 2007) |
| minns | Minns Estate | Seacourt Stream | target | 1635TH | 2.13 | 2.90 (GOV.UK; Story to confirm, #10) | 3.117 |
| coldharbour | Cold Harbour | Hinksey Stream | target | 1675TH | 2.30 | 2.44 (GOV.UK; Story to confirm, #10) | 2.738 |

#### 4.1.1 Downstream-stage history (verified 24 Oct, #2; re-target decided by PM)
The Hydrology API holds only the **upstream** lock stage for osney, godstow, iffley and eynsham. The d/s series in the table exist only in flood-monitoring (live, about 4 weeks) and the daily archive (from 2025-10-29, so e2026 only). Osney and Godstow u/s stay flat in floods (Osney u/s 0.19 m at the 2014 peak; −0.001 m on 25 Feb 2026 while d/s read 3.34 m), so they can't be proxies. Therefore:
- **Trained targets:** `newbotley` (primary, 15-min history from 2002), `kingsmill` (1998+), `minns` (2003+), `coldharbour` (2002+).
- **Live only:** `osney`, `godstow`, `iffley`, shown in the River strip from flood-monitoring live data; not trained or backtested.
- `eynsham` uses its u/s series as an upstream feature. Anomalies are per-gauge, so the datum doesn't matter.
- Upstream gauges with matching Hydrology history: farmoor (1992+), cassington (1986+), enslow (1987+), islip (1995+; use the `-mASD` measure), eynsham u/s (2000+).
- Further-upstream gauges (#125 experiment A, adopted for newbotley and minns only, PM 24 Oct): shifford u/s (2002+), hannington (1995+), worsham (1988+), shipton (1998+). Their live `Stage` measure equals the Hydrology series exactly (20–24 Oct 2026). banbury (1986+) and lowerarncott (1998+) have the same matching history but are `live_only`: A was not adopted for kingsmill. All six are in `hourly.parquet` from release `data-hourly-v2` on.
- Refs and measures are resolved in `config/stations.yaml` (#2). Hydrology 15-min level measures end in `level-i-900-m-qualified`. At the locks, flood-monitoring puts the d/s thresholds under `downstageScale`; `stageScale` is the u/s trace.
- Kings Mill telemetry has been out since 2026-10-13 14:45Z: its history is fine, but live mode shows it as stale.
- **Catchment ring (#146):** a separate `catchment_gauges:` section of `config/stations.yaml` lists 16 EA level gauges within about 35 km of Oxford (Thames, Windrush, Glyme, Evenlode, Cherwell, Ray; incl. Kings Lock d/s and Oxford Botanic Gardens 1490TH). They are display only: role `live_only`, never forecast, not trained, no travel-time pairs. Only `pipeline/ingest_live.py` and `pipeline/export_static.py` (stations.json) read them; keys already in `gauges:` (the #125 six) are deduped at load time.

Rain gauges (EA): Osney `256230TP`, Eynsham `254336TP`, Abingdon `261021TP`, Benson `264254TP`, Wheatley `263541TP`. Catchment rain = mean of available gauges per hour (log which are used).

Flow paths = the **river walk** (for travel times and features; `flow_paths:` in `config/stations.yaml` is the single source, read by `model/features.py` and `analysis/travel_times.py`). For each target, walk upstream through the river network and list every gauge the water passes; each enters the model shifted by its own measured travel time (§6, §7.2).
- newbotley (Bulstake Stream) and minns (Seacourt Stream): farmoor, eynsham, cassington, then further up shifford and hannington (Thames), worsham (Windrush) and shipton (Evenlode). The further four were added on #125 (experiment A, adopted for these two targets only).
- coldharbour (Hinksey Stream): farmoor, eynsham, cassington. The further gauges lowered its 72 h skill in experiment A, so it keeps the near gauges.
- kingsmill (Cherwell): enslow, islip. banbury and lowerarncott are `live_only` for the same reason.
- The main-channel locks godstow → osney → iffley are live only (§4.1.1) and have no pairs.
- Each list is flat (one list per target, model column order), not a per-branch tree: that reproduces experiment A's models exactly. Per-branch aggregation is a post-freeze idea.

### 4.2 Trouble spots (`config/spots.yaml`)
Coordinates verified with point-in-polygon against each EA warning area (#10; see `config/spots.yaml` for the evidence). Thresholds: minns and coldharbour confirmed against dated flood reports; cherwell stays on `probability` (EA operational level, history from 1998), although no property flooding is confirmed there.

| key | Name | EA warning area | Gauge | Threshold (m) | lat, lon |
|---|---|---|---|---|---|
| osney | Osney Island / Binsey | 061FWF23BnsyOsny | minns | 2.90 | 51.7503, -1.2735 |
| botley | Botley Road / New Botley / Hinksey | 061FWF23NwBotley | newbotley | 2.76 | 51.7525, -1.2790 |
| abingdonrd | Abingdon Road / Grandpont | 061FWF23NwBotley | coldharbour | 2.44 | 51.7330, -1.2493 |
| wolvercote | Wolvercote / Port Meadow | 061FWF23Wlvrcote | godstow | 3.07 | 51.7790, -1.2950 |
| cherwell | Cherwell (Kings Mill) | 061FWF14CherOxfd | kingsmill | 2.60 | 51.7575, -1.2395 |

Gauge changes (§4.1.1): osney and abingdonrd use the nearest single-trace gauges with history, minns and coldharbour, as substitutes. Their thresholds (2.90 and 2.44 m) come from the GOV.UK station pages (#2); Story confirmed both against dated flood reports (#10): Minns crosses 2.90 in e2007, e2014 and e2024a (Osney homes and streets flooded); Cold Harbour crossed 2.44 about 23 h before Abingdon Road closed on 5 Jan 2024. Both spots are `probability`. In the demo, say that osney uses a substitute gauge (Minns Estate, about 1.2 km west). wolvercote stays on godstow, which is live only: its mode is `timing_only` with `leads: []` and `arrival: null`, and the UI shows the live level against 3.07 m with the note "no forecast: no gauge history".

Each spot has:
- `amber` = gauge normal-range top (`typicalRangeHigh`).
- `mode: probability | timing_only`. Use `timing_only` if the gauge has < 5 years of usable history, or if no past event supports the threshold (Story lead decides; default `probability`).

### 4.3 Flood events (`config/events.yaml`)
Windows are approximate (UTC); refine from data.

| id | Name | Window | Notes |
|---|---|---|---|
| e2007 | July 2007 | 2007-07-18 → 2007-08-02 | Summer event |
| e2012 | Nov–Dec 2012 | 2012-11-20 → 2013-01-05 | Kings Mill 2.722 m on 27 Nov (not a record) |
| e2014 | Jan–Feb 2014 | 2013-12-20 → 2014-02-20 | **Headline replay** on newbotley; Osney d/s 3.97 m on 9 Jan (context only, §4.1.1); Minns 3.09 m, 9 Jan |
| e2021 | Jan–Feb 2021 | 2021-01-20 → 2021-02-20 | Three trained gauges crossed; minns touched 2.903 m (no homes flooded) |
| e2024a | Jan 2024 (Storm Henk) | 2023-12-28 → 2024-01-15 | Abingdon Road closed ~21:30 5 Jan |
| e2024b | Nov 2024 (Storm Bert) | 2024-11-20 → 2024-12-05 | Kings Mill record 2.785 m, 27 Nov |
| e2026 | Jan–Mar 2026 | 2026-01-15 → 2026-03-10 | Osney d/s peaked about 3.54 m on 16 Feb (below 3.79); no trained gauge crossed its threshold: false-alarm test |

Additional events are auto-detected (§6.1) and added to the backtest set.

---

## 5. Data pipeline

### 5.1 Ingest (`pipeline/`)
- `ea_client.py`: thin, cached wrappers (responses saved under `data/raw/`; never re-download if cached). Retries with backoff; respect the 15-minute polling guidance for live endpoints.
- `ingest_history.py`: for each gauge and rain gauge, download all available 15-min data from the Hydrology API (2006 → now). **Fallback:** if a gauge is missing from the Hydrology API, use daily archive CSVs for the event windows only. Note that the archive is a rolling window starting 2025-10-29, so it reaches e2026 only (#2).
- `ingest_warnings.py`: download Historic Flood Warnings; keep Oxford-related codes (061FWF23BnsyOsny, 061FWF23NwBotley, 061FWF23Wlvrcote, 061WAF23Oxford, Cherwell 061FWF14CherOxfd / alert 061WAF14LChrwell; these named codes start in Nov 2012, so e2007 needs the legacy codes 061FWF233, 061FWF142 and 061WAFW06). Issue times are recorded to the second, in UK local time: convert to UTC; output `(area_code, type, issued_at, precision: time|date)`.
- `ingest_live.py`: last 28 days of readings for all gauges + rain gauges from flood-monitoring; record `observed_at` and `received_at`.

### 5.2 Cleaning (`pipeline/clean.py`)
1. Normalise to `(gauge, ts_utc, value, quality, source)`. Drop values EA flags as suspect/rejected. Deduplicate on (gauge, ts).
2. Resample to hourly: `level_mean`, `level_max`; rain → hourly sum.
3. Forward-fill gaps ≤ 2 h; longer gaps stay NaN and are flagged.
4. Spikes: hour-to-hour jump > 0.5 m that reverses within 3 h → NaN and count. Persistent level shifts (possible datum change) → logged for human review, not auto-corrected.
5. Write `data/processed/hourly.parquet` (long format) and `data/processed/provenance.parquet` (`source_url, licence, downloaded_at, n_rows, first_ts, last_ts`).

### 5.3 Quality report (`pipeline/quality_report.py`)
Writes `web/public/data/quality.json` (§9): per-gauge coverage %, gaps filled/flagged, spikes removed, threshold from API vs config, notes; list of sources with licence and download time.

### 5.4 Rules
- Lock gauges have upstream/downstream qualifiers: use the measure listed in §4.1.
- **Never compare stage values across gauges**; each has its own local datum.
- Use **level**, not flow (EA reports unreliable high-flow ratings at Farmoor, Enslow, Cassington, Islip).

---

## 6. Travel-time analysis (`analysis/travel_times.py`)

### 6.1 Event detection
For each target gauge: an event is a contiguous period where `level_max` > amber, merged if separated by < 7 days; keep if peak > amber + 0.1 m. Analysis window: 7 days before start to 3 days after end. Union with `events.yaml`.

### 6.2 Matching per gauge pair
Pairs: every upstream gauge → each target on its flow path (§4.1). The main-channel locks have no history (§4.1.1), so they have no pairs.
For each event and pair:
1. Smooth hourly `level_mean` with a centred 3 h rolling mean (analysis only, never used as a model input).
2. **Peak time:** argmax in the window. Require one dominant peak: any second peak (via `scipy.signal.find_peaks`) must have prominence < 50% of the main one; otherwise mark the event `ambiguous` with a reason.
3. **Half-rise time:** first time level ≥ baseline + 0.5 × (peak − baseline); baseline = median level over the 72 h before the rise begins.
4. `T_peak = t_peak_down − t_peak_up`; `T_half = t_half_down − t_half_up`. Keep if 0 < T < 168 h.
5. Record upstream rise magnitude (peak − baseline, metres at the upstream gauge) and rise rate.

### 6.3 Outputs
- `web/public/data/travel_times.json` (§9): per pair p10 / median / p90 of `T_half` and `T_peak`, event count, per-event values, exclusions with reasons.
- Lagged cross-correlation of hourly level *changes* (lags 0–120 h) per pair over all Oct–Mar periods.
- Per pair: linear fit of `T_half` against upstream rise magnitude (slope in hours per metre; report n even if weak).
- `data/processed/lags.json`: per pair, `lag_lo = round(p10 T_half)`, `lag_main = round(median)`, `lag_hi = round(p90)` hours. Pairs with < 3 valid events fall back to the cross-correlation peak lag (`lag_main`) and ±6 h.

---

## 7. Model

### 7.1 Frame
One hourly frame per target gauge with ≥ 5 years usable history. Lead times h ∈ {6, 12, 24, 36, 48, 72}. Target: `y = level_mean(t + h) − level_mean(t)`.

### 7.2 Features (`model/features.py`): all known at time t
- Target gauge: `level_now`; changes over 1, 3, 6, 24 h; 21-day mean level.
- Each upstream gauge on the target's river walk (§4.1: 7 gauges for newbotley and minns, 3 for coldharbour, 2 for kingsmill): anomaly (level minus that gauge's own long-term median) at lags {0, 6, 12, 24, lag_lo, lag_main, lag_hi} h (deduplicated); changes over 3 h and 24 h. The travel-time lags come from §6 for every pair, including the further gauges (for example hannington → newbotley 3/18/64 h, shipton → minns 14/21/78 h). A saved model keeps its own upstream list (read from its feature columns), so live mode and replays build exactly the columns it was trained on, even after `flow_paths` changes.
- Catchment rain: sums over the last 6, 24, 72, 168 h and 21 days.
- Season: sin and cos of day of year.
- Missing values remain NaN.
- Windows are capped at 21 days so live mode works with ~4 weeks of live data.
- **No future information.** Test: perturbing data after time t must not change any feature at time t.

### 7.3 Training (`model/train.py`)
- One LightGBM model per (target gauge, h, α), α ∈ {0.05, 0.10, 0.25, 0.50, 0.75, 0.90, 0.95}, `objective="quantile"`, `alpha=α`.
- Params: `num_leaves=31, learning_rate=0.05, n_estimators=2000, early_stopping_rounds=100, min_data_in_leaf=50, feature_fraction=0.8, bagging_fraction=0.8, bagging_freq=1, seed=42`.
- Sample weights: 5 where `level_now` > amber − 0.3 m, else 1.
- Splits: train ≤ 2018-09-30; validation 2018-10-01 → 2021-09-30; test ≥ 2021-10-01. If history starts later than 2007, shift splits to keep ~60/20/20 by winter seasons.
- Sort predicted quantiles per row (no crossing).
- Save models to `data/models/`; feature importance (gain) to `web/public/data/importance.json`.

### 7.4 Calibration (`model/calibrate.py`)
Conformalised quantile regression per (gauge, h), using validation rows inside detected events:
- For each interval pair (0.05, 0.95), (0.10, 0.90), (0.25, 0.75) with nominal miscoverage a: scores `E = max(q_lo − y, y − q_hi)`; `Q` = the ⌈(1 − a)(n + 1)⌉-th smallest E. Lower bound −= Q, upper bound += Q (Q may be negative). Median unchanged. Re-sort.

### 7.5 Probability and timing (`model/probability.py`)
For a forecast issued at t for gauge g:
1. Level quantiles per h: `level_now + q_α(h)`.
2. CDF by linear interpolation between quantiles; beyond α = 0.05 / 0.95 extrapolate linearly using the 0.05–0.25 and 0.75–0.95 slopes; clip to [0, 1].
3. `pFlood_h = 1 − F_h(threshold)`, `pAmber_h = 1 − F_h(amber)`.
4. Enforce non-decreasing in h: `p_h = max(p_h, p_{h−1})`.
5. **Arrival window:** first times at which p reaches 0.1, 0.5, 0.9, linearly interpolated between leads; `null` if not reached by 72 h. Interpolate from p = 0 at the issue time. If `level_now` is already at or above the threshold, p = 1 at the issue time, so all three arrival times are the issue time (the flood has arrived), even if later leads are lower.
6. `timing_only` spots: no flood probability; report time for the median forecast to reach amber, and, if an upstream rise is currently observed, the travel-time window (`t_upstream_half + T_half p10/median/p90`).

### 7.6 Baseline: probabilistic persistence
`level(t + h) = level(t) + ε`, with ε quantiles = empirical α-quantiles of `level(t + h) − level(t)` over training rows with the same weighting rule. Used for all skill scores.

---

## 8. Evaluation (`model/backtest.py`)

### 8.1 Replays (Time Machine)
For every backtest event:
- **Leave-one-flood-out:** retrain all models excluding the event window ± 7 days; recalibrate on remaining validation events.
- Issue a forecast every hour across the event window; compute probabilities and arrival windows for all spots.
- Write `web/public/data/replays/{eventId}.json` (§9). Observed data after each forecast's issue time must not influence that forecast (test). The hourly row labelled L holds the readings from L to L + 45 min, so a forecast issued at t uses rows labelled ≤ t − 1 h: its `levelNow` is the observed level at t − 1 h, and lead h is the hour ending at t + h (#93).
- The About screen states that leave-one-flood-out training can include floods after the replayed one, and that strict time-split test results are reported separately.

### 8.2 Metrics → `web/public/data/proof.json`
Computed on the test period and across replay events.
- **Pinball loss** (mean over α) per h, model and persistence; **skill** = 1 − model / persistence.
- **Interval coverage** for 50/80/90% intervals per h.
- **Threshold exceedance:** Brier score and 10-bin reliability per spot and h; Brier skill vs persistence.
- **Event outcomes** per spot for trigger p* ∈ {0.01, 0.02, 0.05, 0.1, …, 0.9} (the low values cover the Decide presets, #38):
  - hit: trigger fired before the actual crossing (within 72 h before); lead = crossing time − first trigger time;
  - miss: crossing with no prior trigger;
  - false alarm: trigger episode (episodes ≥ 24 h apart) with no crossing within 72 h.
- **Arrival timing error:** predicted 50% time − actual crossing time, for forecasts issued 24 h and 48 h before the crossing.
- **Versus official warnings:** for each event and spot, first EA Flood Warning (and Flood Alert) issue time in the spot's area (`perEvent.officialIssuedAt`; null when the EA issued none); lead gained = official issue time − our first trigger time, per p*. Fallback if dates only: compare in days, set `precision: "date"`, and say so in the UI.
- **Official warnings as a trigger** (`officialOutcome`): score the first EA Flood Warning per event and spot with the same hit / miss / false-alarm rules as our trigger, so the Decide tab can price "act on official warnings". e2026 has no Oxford warning messages at all.
- **Warn-at level per spot** (`warnAt`, #134): each probability spot's trigger p* is chosen on **validation information only** (replay issue times and crossings before the test period, 2021-10-01: the leave-one-flood-out replays of e2007, e2012, e2014, e2021) by one fixed rule: the lowest p* in 0.1–0.9 with at most 1 false alarm in every validation flood replay (0.5 if none qualifies). It is then frozen and scored on the test events (e2024a, e2024b, e2026), next to p* = 0.5 on the same events. Test events never enter the choice. Everything else in proof.json stays at p* = 0.5.
- **Uncertainty:** bootstrap over events (1,000 resamples), 90% intervals for event-level numbers. `tradeoff[].ci90` is the 90% bootstrap interval of `meanLeadH` (hours).
- **Known cost of the river walk (#125 A), to report honestly:** the further-upstream gauges gave Botley a first trigger at p* = 0.5 50 h before the e2024a crossing (16 h before; 41.5 h ahead of the EA warning). In #125's experiment they also added one Botley false alarm at p* = 0.5 in the strict test period: 22–23 Feb 2024, when New Botley peaked at 2.687 m against the 2.76 m line (a near miss, not a dry-weather alarm; outside the replay windows, so not in proof.json). In the final retrain (#162) the river walk also covers Minns Estate (Osney); it costs Botley the July 2007 flood at its 60% warn-at level and adds one Osney false alarm (e2024b) at its 30% level, for 29 of 30 floods caught with 6 false alarms at the warn-at levels (28 of 30, 5 false alarms at p* = 0.5). <!-- src: replays/e2024a.json botley first max-lead pFlood >= 0.5 below the line at 2024-01-02T16:00Z, crossing 2024-01-04T18:00Z, EA warning 2024-01-04T09:30:45Z; proof.json perEvent e2024a botley leadVsOfficialH 41.51; warnAt.botley.perEvent e2007 misses 1; warnAt.osney.perEvent e2024b falseAlarms 1; tradeoff -->

---

## 9. JSON contracts

All files under `web/public/data/`. Times are ISO 8601 UTC. Levels in metres (each gauge's own datum). Probabilities 0–1. `web/src/contracts.ts` mirrors these exactly; `tests/fixtures/` holds a valid sample of each.

```ts
// stations.json
type Station = { key: string; name: string; river: string; role: "upstream" | "target" | "live_only";
  ref: string; lat: number; lon: number; amber: number; threshold: number | null; record: number | null; };

// spots.json
type Spot = { key: string; name: string; gauge: string; threshold: number; amber: number;
  lat: number; lon: number; warningArea: string; mode: "probability" | "timing_only"; };

// events.json
type EventMeta = { id: string; name: string; start: string; end: string;
  peak: Record<string /*gauge*/, number>; headline: boolean; };

// travel_times.json
type TravelPair = { up: string; down: string; n: number;
  tHalf: { p10: number; median: number; p90: number };
  tPeak: { p10: number; median: number; p90: number };
  events: { eventId: string; tHalf: number | null; tPeak: number | null; rise: number; excluded?: string }[];
  xcorr: { lagH: number; r: number }[];
  slopeHoursPerMetre: number | null; };

// Forecast (live.json and inside replays)
type QuantKey = "05" | "10" | "25" | "50" | "75" | "90" | "95";
type SpotForecast = { spot: string; levelNow: number;
  leads: { h: number; q: Record<QuantKey, number>; pFlood: number | null; pAmber: number }[];
  arrival: { p10: string | null; p50: string | null; p90: string | null } | null;
  mode: "probability" | "timing_only"; };
type Forecast = { issuedAt: string; dataAsOf: Record<string /*gauge*/, string>;
  stale: string[]; spots: SpotForecast[];
  method?: "model" | "persistence";   // optional; "persistence" = labelled fallback until models exist
  note?: string;                      // shown in the UI when non-empty
  observed?: Record<string /*gauge*/, { t: string; level: number }[]>; };
  // optional, live.json only: hourly levels over the last 7 days for every gauge with live data,
  // live_only gauges included (River sparklines); same shape as Replay.observed

// replays/{eventId}.json
type Replay = { eventId: string; name: string; start: string; end: string;
  observed: Record<string /*gauge*/, { t: string; level: number }[]>;   // hourly
  forecasts: Forecast[];                                                // one per hour
  official: { spot: string; type: "alert" | "warning" | "severe"; issuedAt: string; precision: "time" | "date" }[];
  crossings: { spot: string; t: string }[]; };

// proof.json
type Proof = {
  skillByLead: { h: number; pinballModel: number; pinballPersistence: number; skill: number }[];
  coverage: { h: number; nominal: number; actual: number }[];
  reliability: Record<string /*spot*/, { h: number; bins: { pPred: number; pObs: number; n: number }[];
      brier: number; brierPersistence: number }[]>;
  tradeoff: Record<string /*spot*/, { pStar: number; hits: number; misses: number; falseAlarms: number;
      meanLeadH: number | null; meanLeadVsOfficialH: number | null;
      ci90?: [number, number] }[]>;          // ci90: 90% bootstrap interval of meanLeadH (hours)
                                             // pStar rows: 0.01, 0.02, 0.05, 0.1 … 0.9 (§8.2)
  perEvent: { eventId: string; spot: string; crossed: boolean; peakObs: number;
      arrivalErrH: number | null; leadVsOfficialH: number | null;
      officialIssuedAt?: string | null }[];  // first EA Flood Warning in the spot's area; null = none issued
  officialOutcome?: Record<string /*spot*/, { hits: number; misses: number; falseAlarms: number;
      meanLeadH: number | null }>;           // official warnings scored as a trigger (§8.2)
  warnAt?: Record<string /*spot*/, {         // per-spot warn-at level (#134, §8.2)
      pStar: number; rule: string;           // chosen on validation floods only, then frozen
      validation: WarnAtScore; test: WarnAtScore;
      atDefault: { pStar: number; validation: WarnAtScore; test: WarnAtScore };  // same events at p* 0.5
      perEvent: { eventId: string; period: "validation" | "test"; hits: number; misses: number;
          falseAlarms: number; meanLeadH: number | null; leadVsOfficialH: number | null }[] }>;
  testPeriodNote: string; };
type WarnAtScore = { events: string[]; hits: number; misses: number; falseAlarms: number;
  meanLeadH: number | null; meanLeadVsOfficialH: number | null };

// quality.json
type Quality = {
  gauges: { key: string; coveragePct: number; gapsFilled: number; gapsFlagged: number; spikesRemoved: number;
    thresholdApi: number | null; thresholdConfig: number | null; notes: string[] }[];
  sources: { name: string; url: string; licence: string; downloadedAt: string; rows: number }[]; };

// importance.json
type Importance = Record<string /*gauge*/, { h: number; features: { name: string; gain: number }[] }[]>;
```

Stretch contracts are in §11.

---

## 10. Application

### 10.1 API (`api/main.py`, FastAPI)
- `GET /api/live` → `Forecast` for now (from `forecast_live.py`, cached ≤ 15 min). A gauge whose latest reading is > 3 h old is listed in `stale`. A spot whose own gauge is stale gets `leads: []`. A spot whose own gauge is fresh but one of its model's upstream gauges is stale gets labelled persistence for that spot only (the `note` names the spot and the gauge; #125): a stale Shifford sends Botley and Osney to persistence and leaves Abingdon Road and Cherwell on the model.
- All other data is static JSON. **The app must run fully offline** from `web/public/data/`; live mode degrades to "Live data unavailable".

### 10.2 Web app (React + Vite + TS): one screen
**As built (PM decision 24 Oct, #118, #135).** One screen, `web/src/clock/ClockScreen.tsx`, replaces the earlier tabs and the four-screen plan. Top to bottom: the event switch, the flow map (hero) with the Scoreboard on it, the Timeline at full width, and a one-line proof footer. Everything else is in the **"Show the working"** drawer. Every screen and the drawer show the banner "Decision-support prototype, not an official warning. Check gov.uk/check-flooding." Times display in Europe/London with the zone shown. Every number on screen is read from `web/public/data/*.json` at runtime.

**Shell (`web/src/App.tsx`, `web/src/ui/presenter.ts`).** Header: brand, tagline, "Show the working" link and the presenter toggle. The hash keeps the state: `#/now`, `#/<eventId>` (e.g. `#/e2014`), `#/working/<tab>`. Old hashes (`#/replay`, `#/protect`, `#/trust`, `#/proof`, …) still resolve. Keys: **1–5** pick the switch choices, **Space** plays or pauses (`rc:playpause`), **←/→** step (`rc:step`, Shift = 6 steps), **P** toggles presenter mode (bigger type).

**Event switch (`clock/choices.ts`).** Now · 2014 · Henk (Jan 2024) · Bert (Nov 2024) · 2026, with 2007, 2012 and 2021 under "More…". "Now" reads the live forecast (`/api/live`, else `live.json`, cached 15 min). A past flood loads only its own `replays/<id>.json`, on demand.

**Flow map (`clock/FlowMap.tsx`, `GaugeLayer.tsx`, `SpotDots.tsx`, `flow.ts`).** Leaflet over the bundled offline basemap `geo/oxford-base.geojson` (OSM, ODbL, attributed), fitted to the whole catchment.
- **Rivers as water:** each river line takes its nearest Oxford gauge and gets thicker and deeper blue as that gauge rises from its usual high towards its flood level, with dashes moving downstream. Levels are only compared with the same gauge's own lines, never across gauges.
- **Upstream chain:** links from `travel_times.json` (best pair per upstream gauge), with pulses moving at the measured travel time and the travel time in words on hover.
- **Gauges:** every gauge in `stations.json` (upstream, targets, live_only, and the #146 catchment ring) as a small level-gauge icon, with a compact card on hover or tap. Names show from zoom 14.
- **River walk:** the selected spot's upstream path (`riverWalk` over `travel_times.json`) is drawn bright and the rest dimmed.
- **Spots:** small identical round markers. The ring fills with the chance of flooding in the next 3 days, with the percentage inside from 1%. In replays, a badge under the marker shows FloodClock vs the EA once both have happened, and a ripple marks FloodClock's warning.
- **Spot visibility rule (#146, #152):** a spot shows only when it has data. Wolvercote (timing only, live-only gauge, no forecast) is hidden. Cherwell is hidden in Now while Kings Mill telemetry is offline (§4.1.1), and shown in replays.

**Map v3 (in progress, #152, behind `?map=gl`):** MapLibre uses the offline PMTiles basemap (release `basemap-v1`, unpacked to `web/public/tiles/` by `make tiles`), with deck.gl flow that follows the routed river paths (`geo/river-paths.geojson`, `geo/catchment-rivers.geojson`). Without the tiles it falls back to a plain background and the GeoJSON layers; without WebGL it falls back to Leaflet. The Leaflet map remains the default until the MapLibre worker is verified in production. Both maps provide Oxford and Catchment presets that bound panning and zoom to the selected area.

**Timeline (`clock/Timeline.tsx`, under the map).** For the selected spot: FloodClock's forecast fan from the playhead (middle line and likely range), the real level (solid up to the playhead − 1 h, #93), the flood level and usual high as labelled lines, and the markers **FloodClock warned · EA warned · Flooded** once the playhead has passed them. In a replay the playhead plays hour by hour, and a flood at the selected spot auto-plays when it loads. No reading is shown before the playhead reaches it (§8). Now shows the recent readings (up to 7 days) and the live forecast.

**Scoreboard (`clock/Scoreboard.tsx`, on the map).** At most two lines for the selected spot. Replay: when FloodClock warned before the flood, and how that compares with the EA warning, with its honest sign (✓ / ✕ and words, not colour alone), each line filled only once the playhead has passed it. Calm events: "Stayed calm: highest chance X%". Now: "No flood expected in the next 3 days" or "X% chance of flooding by <time>". Caption: the spot's warn-at level (`proof.warnAt[spot].pStar`, chosen on validation floods only; else 50%) and, for a spot measured against another spot's EA warning area, which one. Never "we always beat the EA".

**Proof footer (`clock/ProofFooter.tsx`).** One line summed at runtime from `proof.tradeoff` (FloodClock at each spot's warn-at level) and `proof.officialOutcome` (EA Flood Warnings), scored on the same rules, plus a "Show the working" button.

**Show the working (`clock/Drawer.tsx`, `#/working/<tab>`).** A drawer over the screen, each tab loaded only when opened: How good is it? (trust tiles and charts), Protect (sandbag screening, S4, labelled "Screening, not instructions" and "Experimental"), Live gauges, Time Machine, Decide (cost–loss), Proof, About and credits. Esc or × closes it.

**Cost–loss.** Presets (Resident move car C = £20, L = £2,000; Commuter reroute £5 / £100; Council close road £5,000 / £100,000; p* = C / L; expected cost over the backtest) stay in `web/src/lib/costLoss.ts` and the Decide tab.

**Contracts:** `web/src/contracts.ts` and the §9 / §11 JSON shapes are unchanged by the one-screen rebuild.

---

## 11. Stretch backlog (gated)

**Gate:** start only when the core gate in §13 is met. Build in order S1 → S4, one at a time, each on its own branch. Anything not working end-to-end by **Sun 09:00** is hidden from the UI. Every stretch view carries an "Experimental" label where stated.

### S1. Official flood-risk map layer
- **Data:** EA Risk of Flooding from Rivers and Sea (RoFRS) and Risk of Flooding from Surface Water (RoFSW), plus Recorded Flood Outlines (OGL). Use EA-provided map services (WMS) if available; otherwise download, clip to the Oxford bbox (approx. 51.70–51.80 N, −1.33 to −1.20 E), simplify, and save as GeoJSON in `web/public/data/geo/`.
- **UI (River tab):** toggles "Official river risk", "Official surface-water risk", "Recorded flood outlines". Legend text: "Annual chance from EA long-term risk maps. Not a forecast."
- **Contract:** `geo/risk_layers.json`: `{ layers: { id: string; name: string; type: "wms" | "geojson"; url: string; attribution: string; legend: { label: string; colour: string }[] }[] }`.

### S2. Ensemble rainfall context
- **Data:** Open-Meteo ensemble API (`https://ensemble-api.open-meteo.com/v1/ensemble`, ECMWF IFS 51 members; CC BY 4.0) for 3 catchment points (Eynsham, Enslow, Oxford). Not a model input.
- **UI (River tab):** "Rain in the next 72 h" fan (10/50/90% of member cumulative totals, catchment mean) with the note "Context only: our forecast does not yet use future rain."
- **Contract:** `ensemble_rain.json`: `{ issuedAt: string; points: string[]; hours: number[]; cumMm: { p10: number[]; p50: number[]; p90: number[] } }`.

### S3. Experimental flood-spread ensemble (Osney/Botley subarea only)
- **Purpose:** show *where* water could spread as the forecast level rises, with uncertainty.
- **Prerequisite (blocking):** the newbotley (or minns) gauge's stage datum in metres above Ordnance Datum (mAOD), taken from EA station metadata. If it can't be verified, **do not build S3**.
- **Data:** EA 1 m LiDAR DTM tiles covering the subarea (bbox approx. 51.745–51.758 N, −1.290 to −1.265 E); resample to 5 m; British National Grid (EPSG:27700). River cells from OS Open Rivers or EA Main River Map.
- **Method (offline, per forecast time τ ∈ {6, 12, 24, 36, 48, 72} h):**
  1. N = 200 runs. Sample a gauge level from that forecast's distribution at τ (inverse-CDF from §7.5); convert to water-surface elevation (WSE, mAOD) with the gauge datum.
  2. Perturb the DTM per run with spatially smoothed noise (σ = 0.15 m, Gaussian filter radius 25 m) to represent LiDAR error.
  3. Wet cells = cells with DTM < WSE that are connected (4-connectivity, `scipy.ndimage.label`) to river cells. Depth = WSE − DTM.
  4. Per cell: **ensemble frequency** = fraction of runs wet; median depth among wet runs; earliest τ at which frequency ≥ 0.5.
- **Validation:** for e2014 at its peak, compare the frequency ≥ 0.5 extent against the Recorded Flood Outline (intersection over union); show the number on screen.
- **Limitations shown in UI:** "Experimental. A simple terrain fill: ignores channel flow, walls, drains, pumps and defences. Ensemble frequency, not a verified flood probability."
- **Outputs:** PNG overlays per τ (transparent, colour by frequency) for the e2014 replay and for live mode, plus `spread/{eventId|live}/manifest.json`: `{ bounds: [[latS, lonW], [latN, lonE]]; runs: number; frames: { tau: number; issuedAt: string; png: string }[]; validation: { eventId: string; iou: number } | null; caveats: string[] }`.
- **UI:** toggle on the River and Time Machine maps, synced to the selected lead time.

### S4. Sandbag screening (depends on S3)
**Promoted into the core on 24 Oct (#118) as the Protect screen (§10.2).** The method and contract below are unchanged.
- **Purpose:** suggest where limited sandbags are worth *inspecting* first. Never instructions.
- **Data:** OpenStreetMap building footprints for the subarea (ODbL; attribute); S3 outputs.
- **Method:**
  1. Candidates: buildings whose footprint edge touches cells with frequency ≥ 0.2 at any τ ≤ 48 h.
  2. Hard exclusions: median depth at the building > 0.5 m (sandbags are practical only to about 0.3 m, at most ~0.5 m in ideal conditions, per UK flood defence guidance); first-wet time earlier than now + deployment time (default 3 h); flagged as an existing defence location.
  3. Exposed length = footprint perimeter touching wet cells (m). Bags needed = exposed length × `bags_per_metre` (config, default 10; marked as an assumption).
  4. Screening score = P(wet by 48 h) × (1 if median depth ≤ 0.3 m else 0.5).
  5. Select greedily by score ÷ bags until the bag budget (UI slider, default 500) is used; output the top 5.
- **Output contract:** `sandbags.json`: `{ issuedAt: string; budget: number; candidates: { id: string; lat: number; lon: number; score: number; pWet48: number; medianDepthM: number; firstWet: string | null; bags: number; reasons: string[]; checks: string[] }[]; excluded: { id: string; reason: string }[] }`.
- **UI:** "Inspection candidates" list with reasons and the checks a human must make (door/sill height, access, permission, risk of diverting water to neighbours). Label: "Screening score, not modelled damage reduction."

---

## 12. Team ownership and first steps

| Role | Owns | First 2 hours |
|---|---|---|
| Data | `pipeline/`, `config/stations.yaml` | §14 checklist; resolve station refs; ingest newbotley, minns, coldharbour, kingsmill + upstream history |
| Model | `analysis/`, `model/` | `travel_times.py` and `features.py` against fixtures; leakage test |
| App | `web/`, `api/` | Scaffold app; `contracts.ts`; all five tabs on fixture data |
| Story | `config/events.yaml`, `config/spots.yaml`, `README.md` | Verify spot coordinates, event dates, threshold evidence, warning area codes |

Stretch items are owned by whoever is free first, agreed at a team check-in.

---

## 13. Milestones

| Pri | Deliverable | Done when | Target (BST/GMT local) |
|---|---|---|---|
| P0 | Clean hourly data: newbotley + upstream gauges + rain | `hourly.parquet` exists; quality.json renders | Sat 21:00 |
| P0 | Travel-time finding, Thames chain → newbotley | `travel_times.json` renders on Proof | Sat 23:00 |
| P0 | New Botley model, all leads, calibrated; e2014 replay | Time Machine plays e2014 | Sun 02:00 |
| P0 | River (static) + Time Machine on real data, offline | Demo runs from committed JSON | Sun 03:00 |
| P1 | All 5 spots, all events, full `proof.json`, Proof tab | Metrics render with intervals | Sun 06:00 |
| P1 | Official-warning comparison and trade-off curve | Markers in Time Machine | Sun 07:00 |
| ~~P2~~ | ~~Decide tab~~ retired as a screen 24 Oct (#118); cost–loss stays internal (advice lines, trust tile), old view under Show the working | | |
| P0 | Visual-first shell + kit (§10.2: screens, SpotClock, offline basemap, presenter mode) | Four screens route; build passes offline | Sat 21:00 |
| P1 | Now, Replay, Protect, How good is it? screens (§10.2) | Each screen: headline + hero + ≤ 3 stats from data | Sun 00:30 GMT |
| P1 | Integration: old tabs under Show the working; presenter rehearsal | 4-min demo runs on the four screens offline | Sun 03:00 GMT |
| P2 | Live mode (`/api/live`); Tiger Data mirror | Live data shows | Sun 09:30 |
| — | ~~Vultr deploy~~ dropped 24 Oct (no MLH credit); the `deploy/` kit works on any Docker host | | |
| **Core gate** | All P0–P2 merged; demo runs end-to-end offline | | |
| S1–S3 | Stretch backlog (§11), in order (S4 is now core: the Protect screen, §10.2) | Each works end-to-end | Stop new stretch work 09:00 |
| — | **Code freeze 11:00**; submission by 12:00 | | |

---

## 14. First-hour verification checklist
1. `GET /flood-monitoring/id/stations/1303TH`: Osney metadata, downstream stage measure, `stageScale` thresholds, lat/lon (and datum fields, for S3).
2. Hydrology API: find all §4.1 gauges; confirm `level-i-900` exists and the earliest date per gauge (target: 2007 or earlier).
3. Pull osney for Jan 2014: confirm ≈ 3.97 m on 9 Jan 2014.
4. Historic Flood Warnings: confirm issue times (not just dates) and the Oxford area codes.
5. Rain gauges 256230TP and 254336TP: confirm history.
Record results in the team chat and update `config/stations.yaml`.
*Result (24 Oct): item 1's downstream stage has no history, so items 1 and 3 led to the re-target in §4.1.1.*

---

## 15. Acceptance criteria
1. From a clean clone (with network): `make data travel train backtest` runs end-to-end; the web app runs offline from committed JSON.
2. Station refs, qualifiers and thresholds verified from API metadata; mismatches listed in quality.json.
3. Each reported travel-time pair uses ≥ 3 events, or is marked as cross-correlation-only.
4. Proof shows model vs persistence pinball skill per lead; if the model doesn't beat persistence, the UI says so.
5. Interval coverage shown against nominal; gaps > 10 percentage points are flagged in the UI.
6. Tests prove: no future data in features; replay forecasts don't use data after their issue time.
7. Disclaimer on every tab; About lists every data source actually used, with licence and credit (EA/OGL; OSM/ODbL; Open-Meteo/CC BY if used).
8. No raw data or model files in git; `web/public/data/` < 50 MB.
9. Stretch features (if shown) carry their required labels and pass their own validation step.

---

## 16. Engineering rules
- UTC for storage and computation; Europe/London only in the UI. Include a test with timestamps across 2026-10-25 00:30–02:30 UTC.
- Never compare stage across gauges; use per-gauge anomalies. Use level, not flow.
- No future information in features or replays.
- Cache all downloads in `data/raw/`; scripts idempotent; seeds fixed.
- Python: type hints, `ruff`. TypeScript: strict mode, function components, no heavy UI framework.
- Contracts (§9, §11) change only via a PR that updates this spec, `contracts.ts` and fixtures together.

---

## 17. Demo requirements
The app must support this 4–5 minute walkthrough without network access:
1. River strip with travel times ("the water is already on its way").
2. Time Machine on e2014: play, forecast fan narrows, FloodClock ≥ 50% marker, then the official-warning marker, then the real peak inside the band.
3. Decide: switch presets; expected-cost bars update instantly.
4. Proof: skill vs persistence, reliability diagram, e2026 near-miss outcome.
5. Live: today's Oxford (or a clear "live data unavailable" state).

---

## 18. References
- EA flood-monitoring API: https://environment.data.gov.uk/flood-monitoring/doc/reference · rainfall: https://environment.data.gov.uk/flood-monitoring/doc/rainfall
- EA Hydrology API: https://environment.data.gov.uk/hydrology/doc/reference · https://api.gov.uk/ea/hydrology/
- Oxford gauges and warning areas: https://check-for-flooding.service.gov.uk/river-and-sea-levels/target-area/061WAF23Oxford
- Kings Mill station metadata (mirror): https://dsp.agrimetrics.co.uk/flood-monitoring/id/stations/1491TH.html
- EA Oxford Flood Alleviation Scheme hydrology report (48–72 h response; rating issues): https://consult.environment-agency.gov.uk/thames/ofas-updates/user_uploads/fra-appendix-d-hydrology_report.pdf (dead link as of 24 Oct 2026; don't cite)
- Historic Flood Warnings: https://www.data.gov.uk/dataset/d4fb2591-f4dd-4e7f-9aaf-49af94437b36/historic-flood-warnings2
- Recorded Flood Outlines: https://environment.data.gov.uk/dataset/8c75e700-d465-11e4-8b5b-f0def148f590
- RoFRS: https://environment.data.gov.uk/dataset/96ab4342-82c1-4095-87f1-0082e8d84ef1 · RoFSW: https://environment.data.gov.uk/dataset/b5aaa28d-6eb9-460e-8d6f-43caa71fbe0e
- LiDAR DTM 1 m: https://www.data.gov.uk/dataset/01b3ee39-da3f-47b6-83da-dc98e73a461f/lidar-composite-dtm-2022-1m
- Open-Meteo historical weather: https://open-meteo.com/en/docs/historical-weather-api · ensembles: https://open-meteo.com/en/docs/ensemble-api
- OpenStreetMap Oxfordshire extract: https://download.geofabrik.de/europe/united-kingdom/england/oxfordshire.html
- Reach routing / travel time from matched hydrograph features (USACE): https://www.hec.usace.army.mil/confluence/hmsdocs/hmsguides/applying-reach-routing-methods-within-hec-hms/applying-the-muskingum-routing-method
- Flood defence guidance (sandbag limits): https://assets.publishing.service.gov.uk/media/60549b2e8fa8f545dca2c57a/FDG_chapter_9_-_Floodwalls_and_flood_embankments.pdf
- Boosted quantile models in streamflow forecasting (Water Supply Forecast Rodeo winners): https://blog.drivendata.org/blog/water-supply-forecast-and-final-winners
- Event evidence: Jan 2024 https://www.highwaysmagazine.co.uk/news/local-road-network/freeze-adds-counties-flooding-woes · Nov 2024 http://web.archive.org/web/20251015053110/https://www.oxford.gov.uk/news/article/1591/flood-warnings-issued-for-oxford-as-river-levels-continue-to-rise (original is 404) · Feb–Mar 2026 https://www.floodradar.co.uk/flood-event/flood-alert-river-thames-and-tributaries-in-the-oxford-area-2026-02-25
- Botley Road reopening: https://letstalk.oxfordshire.gov.uk/provider-engagement/news_feed/botley-road-to-reopen-on-20-september
