# River Clock: Final Build Spec (v3)

**Event:** OxHack 2026, Oxford. Hacking ends **Sun 25 Oct 12:00** (clocks go back 02:00→01:00 tonight). Judging 13:00, science-fair style, 4–5 min per judge.
**Prizes targeted:** HRT "Best Use of Data for Predictions & Decision Making" (primary), main track (theme TIME), MLH Tiger Data, MLH Vultr.
**This document is the source of truth for the coding agent.** All design decisions are final. If something here is impossible (e.g. data unavailable), follow the fallback written next to it; if there's no fallback, stop and ask a human.

---

## 1. What we are building (one paragraph)

River Clock forecasts **when, and how likely,** five Oxford flood trouble spots will flood in the next 72 hours. It's built on one finding and one model. **The finding:** we measure, from every past Oxford flood, how long the flood wave takes to travel from upstream river gauges to Oxford. **The model:** a LightGBM quantile forecaster that uses those travel times to pick its upstream signals and outputs a probability of flooding over time. We prove it with replays of real past floods ("Time Machine"), skill against a "nothing changes" baseline, calibration charts, and a comparison against official Environment Agency (EA) warnings. A decision screen turns probabilities into "act now / wait" advice using a cost–loss rule.

**Pitch line:** *"Water upstream is Oxford's future. We read it as a clock."*

### Explicitly out of scope (do not build)
- Monte Carlo flood-spread / inundation simulation, terrain (LiDAR) processing, sandbag placement.
- Surface-water and groundwater flood forecasting (official surface-water risk is shown only as a static context layer, if time).
- Foundation models, LSTMs, or any second forecasting model.
- Any claim to replace official warnings.

---

## 2. Final decisions (for reference)

| # | Decision | Final |
|---|---|---|
| D1 | Users | Residents/commuters first; council preset in Decide screen |
| D2 | Spots & thresholds | 5 spots (§4.3); threshold = EA "property flooding possible" level at the controlling gauge, cross-checked against past events; if a spot's threshold can't be backed by evidence or its gauge lacks history, show **arrival timing only** |
| D3 | Target | Change in level at each target gauge, per lead time |
| D4 | Lead times | 6, 12, 24, 36, 48, 72 h |
| D5 | Method | Travel-time analysis (a finding) → one LightGBM quantile model → persistence baseline. Nothing else |
| D6 | Future rain | Not used as a model input. (Optional P3: show ECMWF ensemble rain on the live screen as context only) |
| D7 | Calibration | Conformalised quantile regression (CQR) on held-out whole events |
| D8 | Validation | Time split + leave-one-flood-out (LOFO) replays with 7-day buffers |
| D9 | Headline claim | Hours earlier than official EA warning **together with** false-alarm count, shown as a trade-off curve |
| D10 | Decision layer | Cost–loss trigger + expected-cost comparison (client-side) |
| D11 | Storage | Parquet + DuckDB as the working store. Tiger Data mirror of hourly + live readings as P2 (MLH prize) |
| D12 | Stack | Python 3.11 pipeline/model, FastAPI, React + Vite + TypeScript, Leaflet, Recharts. Replays **precomputed** to static JSON |
| D13 | Extras | Vultr hosting P2. Gemini, ElevenLabs etc.: no |
| D14 | Roles | Data / Model / App / Story (§10) |
| D15 | Entries | HRT + main track + Tiger Data + Vultr. No Best Handmade, no Zed |
| D16 | Name | River Clock |
| D17–19 | Monte Carlo, sandbags, non-river flooding | Out of scope |

---

## 3. Repository layout

```
river-clock/
  CLAUDE.md                 # agent/teammate rules (see separate file)
  SPEC.md                   # this file
  README.md                 # how to run, credits, disclaimer
  pyproject.toml            # python deps
  config/
    stations.yaml           # gauges, roles, IDs, thresholds (§4.2)
    spots.yaml              # trouble spots → gauge, threshold, coords (§4.3)
    events.yaml             # flood events for replays (§4.4)
  data/                     # GITIGNORED: raw/, interim/, processed/
  pipeline/
    ea_client.py            # thin wrappers for EA flood-monitoring + Hydrology APIs
    ingest_history.py       # 15-min history → data/raw → hourly parquet
    ingest_live.py          # last ~4 weeks live readings → parquet (+ Tiger Data, P2)
    ingest_warnings.py      # Historic Flood Warnings → parquet (Oxford areas only)
    clean.py                # resample, gap flags, step-change checks, provenance
    quality_report.py       # writes web/public/data/quality.json
  analysis/
    travel_times.py         # event detection + hydrograph feature matching (§5)
  model/
    features.py             # build feature frame (§6.2)
    train.py                # LightGBM quantile models per gauge × lead
    calibrate.py            # CQR adjustments
    probability.py          # quantiles → exceedance P, arrival windows (§6.5)
    backtest.py             # LOFO replays + metrics → static JSON (§7)
    forecast_live.py        # latest data → live forecast JSON
  api/
    main.py                 # FastAPI: serves live forecast + static JSON
  web/                      # Vite React TS app
    public/data/            # COMMITTED small JSON: replays, proof, travel times, quality, stations, spots
    src/
      contracts.ts          # TS types mirroring §8 JSON contracts
      views/River.tsx  TimeMachine.tsx  Decide.tsx  Proof.tsx  About.tsx
  tests/
    fixtures/               # tiny synthetic series + sample JSON for every contract
```

Commands (put in README and CLAUDE.md):
- `make data` → ingest_history + ingest_warnings + clean + quality_report
- `make travel` → analysis/travel_times.py
- `make train` → model/train.py + calibrate.py
- `make backtest` → model/backtest.py (writes web/public/data/*.json)
- `make live` → ingest_live + forecast_live
- `make api` / `make web` / `make test`

---

## 4. Data

### 4.1 Sources (all Open Government Licence unless noted)
| Source | Endpoint / location | Use |
|---|---|---|
| **EA Hydrology API** | `https://environment.data.gov.uk/hydrology/` (docs `/hydrology/doc/reference`). 15-min level measures end `level-i-900`; rainfall measures also available. Stations have their own IDs plus cross-references to flood-monitoring `stationReference`/`RLOIid` | Full history (training, travel times, backtests) |
| **EA flood-monitoring API** | `https://environment.data.gov.uk/flood-monitoring/` (docs `/doc/reference`, `/doc/rainfall`). `/id/stations/{ref}`, `/id/stations/{ref}/readings?since=…&_sorted&_limit=10000`, `/data/readings?latest`. Only ~4 weeks of history. No key; poll ≤ every 15 min | Live mode; station metadata (`stageScale`: `typicalRangeHigh`, `highestRecent`, `maxOnRecord`) |
| **Flood-monitoring daily archive** | `/flood-monitoring/archive/readings-{YYYY-MM-DD}.csv` (~56 MB/day, all England) | **Fallback only** if Hydrology API lacks a station/period |
| **EA Historic Flood Warnings** | data.gov.uk dataset `historic-flood-warnings2` (ZIP; alerts/warnings/severe since 26 Jan 2006 to June 2026) | Official-warning comparison |
| Open-Meteo archive | `https://archive-api.open-meteo.com/v1/archive` hourly `precipitation` (CC BY 4.0, attribute) | **Fallback** rainfall if EA rain gauges have gaps |
| OpenStreetMap tiles | Leaflet default tiles (ODbL; show attribution) | Base map |

Timestamps: EA APIs are UTC/GMT. Store UTC everywhere; display Europe/London.

### 4.2 Gauges (`config/stations.yaml`)
GOV.UK values below were read from EA pages; **re-read thresholds from API metadata at ingest and log any mismatch.** Bracketed IDs are GOV.UK page numbers; resolve the API `stationReference` on first run (search by name / lat-long) and write it into the YAML.

| key | Station | River | Role | Ref | Normal top (m) | Property flooding possible (m) | Record |
|---|---|---|---|---|---|---|---|
| farmoor | Farmoor | Thames | upstream | 1100TH | 1.30 | 1.75 | 2.01 (Jul 2007) |
| eynsham | Eynsham Lock d/s | Thames | upstream | 1201TH | 2.96 | – | 3.65 (Jul 2007) |
| cassington | Cassington Weir B | Evenlode | upstream | (7054) | 0.77 | – | 1.29 (Jul 2007) |
| enslow | Enslow Weir A | Cherwell | upstream | (7064) | 1.29 | (inconsistent; ignore) | 2.10 (Apr 1998) |
| islip | Islip | Ray | upstream | (9082) | 7.80 | 8.85 | 9.33 (Apr 1998) |
| godstow | Godstow Lock d/s | Thames | target | 1302TH | 2.57 | 3.07 | 3.11 (Jul 2007) |
| osney | Osney Lock d/s | Thames | target (**primary**) | 1303TH | 3.18 | 3.79 | 3.97 (9 Jan 2014) |
| iffley | Iffley Lock d/s | Thames | target | (7072) | 2.72 | 3.25 | 3.67 (9 Jan 2014) |
| kingsmill | Kings Mill u/s | Cherwell | target | 1491TH | 2.40 | 2.60 | 2.79 (27 Nov 2024) |
| newbotley | New Botley | Bulstake Stream | target | (7075) | 2.01 | 2.76 | 3.14 (Jul 2007) |

Rain gauges (EA): Osney `256230TP`, Eynsham `254336TP`, Abingdon `261021TP`, Benson `264254TP`, Wheatley `263541TP`. Use the catchment mean of available gauges (exclude Benson/Wheatley if they bias it; log choice).

**Gotchas:**
- Lock gauges have upstream/downstream **qualifiers**; pick the downstream stage measure listed above.
- **Never compare stage values across gauges** (each has its own local datum). All features are per-gauge.
- Enslow and Castle Mill feeds have known issues; Farmoor/Enslow/Cassington/Islip ratings are unreliable at high flow (EA OFAS hydrology report), so **use level, not flow**, everywhere.

### 4.3 Trouble spots (`config/spots.yaml`)
Coordinates are approximate; the Story lead should verify on a map.

| key | Name | EA warning area | Gauge | Threshold (m) | Approx lat, lon |
|---|---|---|---|---|---|
| osney | Osney Island / Binsey | 061FWF23BnsyOsny | osney | 3.79 | 51.7505, -1.2725 |
| botley | Botley Road / New Botley / Hinksey | 061FWF23NwBotley | newbotley | 2.76 | 51.7525, -1.2790 |
| abingdonrd | Abingdon Road / Grandpont | 061FWF23NwBotley | iffley | 3.25 | 51.7425, -1.2560 |
| wolvercote | Wolvercote / Port Meadow | 061FWF23Wlvrcote | godstow | 3.07 | 51.7770, -1.2800 |
| cherwell | Cherwell side (Kings Mill) | Cherwell Oxford area (code TBC) | kingsmill | 2.60 | 51.7600, -1.2390 |

Each spot also has an **amber** level = gauge `typicalRangeHigh`.
Each spot has `mode: "probability" | "timing_only"`. Set to `timing_only` if (a) the gauge has < 5 years of history, or (b) the threshold has no supporting past event (Story lead decides (b); default `probability`).

### 4.4 Flood events (`config/events.yaml`)
| id | Name | Window (UTC, approx; refine from data) | Notes |
|---|---|---|---|
| e2007 | July 2007 | 2007-07-18 → 2007-08-02 | Summer event |
| e2012 | Nov–Dec 2012 | 2012-11-20 → 2013-01-05 | Cherwell record |
| **e2014** | **Jan–Feb 2014** | 2013-12-20 → 2014-02-20 | **Headline replay**; Osney 3.97 m on 9 Jan |
| e2024a | Jan 2024 (Storm Henk) | 2023-12-28 → 2024-01-15 | Abingdon Rd closed ~21:30 5 Jan |
| e2024b | Nov 2024 (Storm Bert) | 2024-11-20 → 2024-12-05 | Kings Mill record 27 Nov |
| e2026 | Feb–Mar 2026 near-miss | 2026-02-18 → 2026-03-10 | Osney peaked 3.41 m (< 3.79): false-alarm test |

Also auto-detect additional events (§5.1) and add them to the backtest set.

### 4.5 Cleaning (`pipeline/clean.py`)
1. Parse to `(gauge, ts_utc, value, quality_flag, source, received_at?)`. Drop values flagged suspect/rejected by EA quality fields.
2. Deduplicate on (gauge, ts).
3. Resample to **hourly**: `level_mean` and `level_max`.
4. Forward-fill gaps ≤ 2 h; longer gaps stay NaN with `gap=True`.
5. Step-change check: flag any hour-to-hour jump > 0.5 m that reverses within 3 h (spike) → set NaN; log persistent level shifts (possible datum change) for human review.
6. Write `data/processed/hourly.parquet` (long format) and provenance rows to `data/processed/provenance.parquet`: `source_url, licence, downloaded_at, n_rows, first_ts, last_ts`.
7. `quality_report.py` → `web/public/data/quality.json` (contract §8): per gauge coverage %, gaps filled, gaps flagged, spikes removed, thresholds API vs config.

**Fallback:** if a gauge lacks Hydrology history before 2015, keep it (fewer events) and mark spots using it as `timing_only` if < 5 years.

---

## 5. The finding: travel-time analysis (`analysis/travel_times.py`)

### 5.1 Event detection
- For each target gauge: an event = contiguous period where `level_max` > amber level, merged if separated by < 7 days; extend window 7 days before start and 3 days after end. Keep events with peak > amber + 0.1 m. Union with `events.yaml`.

### 5.2 Feature matching per gauge pair
Pairs: each upstream gauge → each target gauge on the same flow path (Thames chain: farmoor, eynsham, cassington → godstow, osney, iffley, newbotley; Cherwell chain: enslow, islip → kingsmill; also godstow → osney → iffley).
For each event and pair:
1. Smooth hourly `level_mean` with a centred 3 h rolling mean (analysis only, never a model feature).
2. **Peak time** = argmax within the event window (require a single dominant peak: second peak prominence < 50% of main peak, via `scipy.signal.find_peaks`; else mark `ambiguous` with reason).
3. **Half-rise time** = first time the level exceeds `baseline + 0.5 × (peak − baseline)`, baseline = median of the 72 h before the window's rising limb.
4. `T_peak = t_peak_down − t_peak_up`, `T_half` likewise. Keep if 0 < T < 168 h.
5. Record upstream rise magnitude (peak − baseline) and rise rate.

### 5.3 Outputs
- Table `data/processed/travel_times.parquet` and `web/public/data/travel_times.json` (contract §8): per pair median, p10, p90 of T_half and T_peak, n events, list of per-event values, excluded events + reasons.
- Supporting: lagged cross-correlation of hourly level *changes* (lags 0–120 h) per pair over all winters (Oct–Mar); store the curve.
- Fit per pair: T_half vs upstream rise magnitude (simple linear fit + residual quantiles) so we can say "bigger floods travel faster/slower". Report slope and n honestly, even if flat.
- **Lag selection for the model:** for each (upstream, target) pair, `lag_main = round(median T_half)`, `lag_lo = round(p10)`, `lag_hi = round(p90)` (hours). Saved to `data/processed/lags.json`, consumed by `model/features.py`.

---

## 6. The model

### 6.1 Frame
Hourly rows for each target gauge with at least 5 years history. For lead h ∈ {6, 12, 24, 36, 48, 72}: target `y = level_mean(t+h) − level_mean(t)`.

### 6.2 Features (all known at t; `model/features.py`)
- Target gauge: `level_now`, changes over 1, 3, 6, 24 h; 21-day mean level (21 d, not 30, so live mode works with ~4 weeks of live data).
- Each relevant upstream gauge: level at lags {0, 6, 12, 24, `lag_lo`, `lag_main`, `lag_hi`} hours (deduplicated; lags from §5.3), plus changes over 3 h and 24 h at lag 0. Upstream levels are expressed as **anomaly from that gauge's own median** (removes the datum issue).
- Rain (catchment mean): sums over last 6, 24, 72, 168 h; 21-day sum.
- Season: sin/cos of day of year.
- Missing values left as NaN (LightGBM handles them).
- **No future information.** Add a unit test that shifting the series forward by 1 h changes features only for rows ≥ the shift point (leakage guard).

### 6.3 Training (`model/train.py`)
- One LightGBM model per (target gauge, h, quantile α), α ∈ {0.05, 0.10, 0.25, 0.50, 0.75, 0.90, 0.95}, `objective="quantile"`.
- Params: `num_leaves=31, learning_rate=0.05, n_estimators=2000` with early stopping (100 rounds) on the validation split, `min_data_in_leaf=50, feature_fraction=0.8, bagging_fraction=0.8, bagging_freq=1`. Seed fixed.
- **Sample weights:** rows where `level_now` > amber − 0.3 m get weight 5 (floods are rare; this is intentional, document it).
- Splits: train ≤ 2018-09-30, validation 2018-10-01 → 2021-09-30, test ≥ 2021-10-01.
- After prediction, **sort quantiles** per row (no crossing).
- Save models to `data/models/` (gitignored) and feature importances to `web/public/data/importance.json`.

### 6.4 Calibration (`model/calibrate.py`)
CQR per (gauge, h), using validation rows inside detected events only:
- For interval pairs (0.05,0.95), (0.10,0.90), (0.25,0.75): conformity score `E = max(q_lo − y, y − q_hi)`; correction `Q = (1−a)(1+1/n)` empirical quantile of E, where a = nominal miscoverage. Widen both bounds by Q (Q may be negative → narrow). Median untouched. Re-sort.
- Note in About screen: "calibrated on whole held-out flood events, because hourly river data are not independent".

### 6.5 From quantiles to "when" (`model/probability.py`)
For a forecast issued at t for gauge g:
1. For each h: predicted level quantiles = `level_now + q_α(h)`.
2. CDF by linear interpolation between quantile points; beyond 0.05/0.95 extrapolate linearly using the 0.05–0.25 and 0.75–0.95 slopes; clip to [0,1].
3. `P_h = 1 − F_h(threshold)`; amber likewise.
4. Enforce non-decreasing over h: `P_h = max(P_h, P_{h−1})`.
5. **Arrival window:** times where P first reaches 0.1 / 0.5 / 0.9, linearly interpolating between lead times; `null` if never reached within 72 h.
6. Spots in `timing_only` mode: report the median-forecast time to reach the amber level, plus the travel-time window from §5 for any upstream rise currently observed; no flood probability.

### 6.6 Baseline: probabilistic persistence
`level(t+h) = level(t) + ε`, with ε quantiles = empirical quantiles of `level(t+h) − level(t)` in the **training** set restricted to high-water rows (same weighting rule). This gives a fair probabilistic baseline for pinball/Brier skill scores.

---

## 7. Proof (`model/backtest.py`)

### 7.1 Replays (Time Machine data)
For every event in the backtest set:
- **Leave-one-flood-out:** retrain (all gauges, all h, all α) excluding the event window ± 7 days, recalibrate on the remaining validation events, then issue a forecast **every hour** from window start to window end.
- Cache per-event models; total compute is small (≈ 5 gauges × 6 h × 7 α ≈ 210 small models per fold).
- Disclose in About: LOFO lets a model train on floods after the replayed one; the time-split test results are reported separately as the strict check.
- Output `web/public/data/replays/{event_id}.json` (contract §8).

### 7.2 Metrics (test period + LOFO events) → `web/public/data/proof.json`
- **Pinball loss** averaged over α, per h; **skill vs persistence** = 1 − model/persistence.
- **Coverage** of 50/80/90% intervals per h.
- **Brier score + reliability diagram** (10 bins) for threshold exceedance per spot at each h; Brier skill vs persistence.
- **Event metrics per spot**, for trigger p* ∈ {0.1, 0.2, …, 0.9}:
  - hit = trigger fired before the real crossing (within 72 h ahead); lead time = crossing time − first trigger time;
  - miss = crossing with no prior trigger; false alarm = trigger with no crossing within 72 h (count separate episodes, ≥ 24 h apart).
- **Arrival timing error** = predicted 50% time − actual crossing time (from forecasts issued 24/48 h before the crossing).
- **Official comparison:** from Historic Flood Warnings, first Flood Warning (and Flood Alert) issue time for each spot's EA area per event. Lead gained = official issue time − our first trigger time, for each p*. Produce the trade-off curve (mean lead gained vs false alarms).
  - **Fallback:** if records have dates only, compare in days and say so in the UI.
- Uncertainty on all event-level numbers: bootstrap over events (1000 resamples), report 90% intervals.

---

## 8. JSON contracts (`web/src/contracts.ts` must mirror these exactly)

All times ISO 8601 UTC strings. Levels in metres (gauge local datum). Probabilities 0–1.

```ts
// stations.json
type Station = { key: string; name: string; river: string; role: "upstream"|"target";
  ref: string; lat: number; lon: number; amber: number; threshold: number|null; record: number|null; };

// spots.json
type Spot = { key: string; name: string; gauge: string; threshold: number; amber: number;
  lat: number; lon: number; warningArea: string; mode: "probability"|"timing_only"; };

// travel_times.json
type TravelPair = { up: string; down: string; n: number;
  tHalf: { p10: number; median: number; p90: number }; tPeak: { p10: number; median: number; p90: number };
  events: { eventId: string; tHalf: number|null; tPeak: number|null; rise: number; excluded?: string }[];
  xcorr: { lagH: number; r: number }[]; slopeHoursPerMetre: number|null; };

// Forecast (used by live.json and inside replays)
type SpotForecast = { spot: string; levelNow: number;
  leads: { h: number; q: Record<"05"|"10"|"25"|"50"|"75"|"90"|"95", number>; pFlood: number|null; pAmber: number }[];
  arrival: { p10: string|null; p50: string|null; p90: string|null } | null;
  mode: "probability"|"timing_only"; };
type Forecast = { issuedAt: string; dataAsOf: Record<string,string>; stale: string[]; spots: SpotForecast[]; };

// replays/{eventId}.json
type Replay = { eventId: string; name: string; start: string; end: string;
  observed: Record<string /*gauge*/, { t: string; level: number }[]>;   // hourly
  forecasts: Forecast[];                                                // one per hour
  official: { spot: string; type: "alert"|"warning"|"severe"; issuedAt: string; precision: "time"|"date" }[];
  crossings: { spot: string; t: string }[]; };

// events.json
type EventMeta = { id: string; name: string; start: string; end: string; peak: Record<string, number>; headline: boolean; };

// proof.json
type Proof = {
  skillByLead: { h: number; pinballModel: number; pinballPersistence: number; skill: number }[];
  coverage: { h: number; nominal: number; actual: number }[];
  reliability: Record<string /*spot*/, { h: number; bins: { pPred: number; pObs: number; n: number }[]; brier: number; brierPersistence: number }[]>;
  tradeoff: Record<string /*spot*/, { pStar: number; hits: number; misses: number; falseAlarms: number;
      meanLeadH: number|null; meanLeadVsOfficialH: number|null; ci90?: [number, number] }[]>;
  perEvent: { eventId: string; spot: string; crossed: boolean; peakObs: number; arrivalErrH: number|null; leadVsOfficialH: number|null }[];
  testPeriodNote: string; };

// quality.json
type Quality = { gauges: { key: string; coveragePct: number; gapsFilled: number; gapsFlagged: number; spikesRemoved: number;
  thresholdApi: number|null; thresholdConfig: number|null; notes: string[] }[];
  sources: { name: string; url: string; licence: string; downloadedAt: string; rows: number }[]; };

// importance.json
type Importance = Record<string /*gauge*/, { h: number; features: { name: string; gain: number }[] }[]>;
```

`tests/fixtures/` must contain a valid sample of every file so the web app can be built before the model exists.

---

## 9. App

### 9.1 API (`api/main.py`, FastAPI)
- `GET /api/live` → current `Forecast` (computed by `forecast_live.py`, cached ≤ 15 min; if any gauge's latest reading is > 3 h old, list it in `stale` and set that spot's `leads` to `[]`).
- Everything else is static JSON under `/data/*` served by the web app (no API needed for the demo; **the demo must work offline** from committed JSON).

### 9.2 Web (`web/`, React + Vite + TS, Leaflet, Recharts)
Top nav tabs: **River · Time Machine · Decide · Proof · About**. Fast and clean; no spinners on the Time Machine (all data preloaded).

**River (live)**
- Left: Leaflet map of Oxford, 5 spot markers coloured green/amber/red by `pFlood` at 24 h (grey if `timing_only` or stale). Click → panel: levels sparkline (last 7 days), probability-over-time bar for 6–72 h, arrival window text ("50% chance by Tue 18:00"), last observation time, link to official EA page for that warning area.
- Right: **river strip**: vertical chain of gauges (Thames and Cherwell branches) with 7-day sparklines and the median travel time printed on each link ("≈ 18 h"), from `travel_times.json`.
- Banner: "Decision support prototype, not an official warning. Check gov.uk/check-flooding."

**Time Machine (the wow moment)**
- Event picker (default e2014). Slider over hourly forecast times; play button (2 s per simulated 12 h).
- Main chart: observed level at the chosen spot's gauge up to the slider (solid), **future observed revealed in faint grey only after the slider passes**, forecast fan (5–95, 25–75, median) from the slider, threshold and amber lines.
- Side: probability-over-time bars; arrival window; the river strip showing upstream gauges at the slider time (so the wave visibly travels).
- Markers on the timeline: "River Clock first ≥50%" and "Official EA warning issued", with the difference in hours.

**Decide**
- Preset buttons: Resident (move car: C=£20, L=£2,000), Commuter (reroute: C=£5, L=£100), Council (close road / barriers: C=£5,000, L=£100,000). Sliders for C and L.
- Show optimal trigger p* = C/L, and from `proof.tradeoff` (interpolated): hits, misses, false alarms, mean lead time, and **expected cost over the backtest** for River Clock at p*, official warnings, never act, always act (bar chart).
- Plain-English advice for the currently selected live spot: "At your costs, act when P ≥ 4%: currently 1% → no action".

**Proof**
- Skill vs persistence by lead time (bar/line). Coverage chart. Reliability diagram (spot selector). Trade-off curve (lead gained vs false alarms). Per-event table. Travel-time finding (scatter of T_half vs rise magnitude per pair, with cross-correlation curve). Feature importance (top 10). Data-quality table.

**About**
- How it works in 5 short steps, limitations (small number of floods, LOFO caveat, thresholds, no future rain, Botley Road bridge works 2023–Sept 2026), data credits and licences, disclaimer.

---

## 10. Work split (parallel from minute 1)

Contracts in §8 + fixtures let everyone start at once.

| Role | Owns | First 2 hours | Then |
|---|---|---|---|
| **Data lead** | `pipeline/`, `config/` | §11 verification checklist; resolve station refs; ingest history for osney + upstream | All gauges, warnings dataset, quality report; P2 Tiger Data mirror + `ingest_live` |
| **Model lead** | `analysis/`, `model/` | Write `travel_times.py` + `features.py` against fixtures; leakage test | Train, calibrate, backtest, proof.json |
| **App lead** | `web/`, `api/` | Scaffold app, contracts.ts, all 5 tabs on fixture JSON | Wire real JSON, polish Time Machine |
| **Story lead** | `config/events.yaml`, `config/spots.yaml`, README, Devpost | Verify spot coordinates, event dates, threshold evidence (news/EA sources), official warning areas | Pitch, demo rehearsal, judge Q&A, Devpost; help wherever behind |

---

## 11. First-hour verification checklist (Data lead)
1. `GET /flood-monitoring/id/stations/1303TH` → confirm Osney metadata, measures (downstream stage), `stageScale` thresholds, lat/lon.
2. Hydrology API: find stations for osney, godstow, iffley, kingsmill, newbotley, farmoor, eynsham, cassington, enslow, islip; confirm `level-i-900` exists and **history reaches 2007** (else note earliest date per gauge).
3. Pull osney Jan 2014; confirm ≈ 3.97 m on 9 Jan 2014 (proves datum/measure choice).
4. Download Historic Flood Warnings ZIP: confirm columns include issue **time**; filter Oxford codes (061FWF23BnsyOsny, 061FWF23NwBotley, 061FWF23Wlvrcote, 061WAF23Oxford, Cherwell area).
5. Rain gauges: confirm 15-min/hourly rainfall history for 256230TP and 254336TP.
Post results in the team chat; update `config/stations.yaml`. If (2) fails for a gauge, use the daily archive CSVs for the event windows only.

---

## 12. Milestones and cut lines (drop from the bottom)

| Pri | Deliverable | Done when | Target |
|---|---|---|---|
| P0 | Hourly clean data for osney + 4 upstream gauges + rain, 2007→now | parquet exists; quality.json renders | Sat 21:00 |
| P0 | Travel-time finding for Thames chain → osney | travel_times.json; chart renders | Sat 23:00 |
| P0 | Model for osney, all leads, calibrated; e2014 LOFO replay | replays/e2014.json; Time Machine plays it | Sun 02:00 |
| P0 | App: River (static) + Time Machine on real data | demo works offline | Sun 03:00 |
| P1 | All 5 spots; all events; proof.json; Proof tab | metrics render with CIs | Sun 06:00 |
| P1 | Official-warning comparison + trade-off curve | markers in Time Machine | Sun 07:00 |
| P2 | Decide tab | expected-cost chart works | Sun 08:30 |
| P2 | Live mode (`/api/live`), Tiger Data mirror, Vultr deploy | live tab shows today's data | Sun 09:30 |
| P3 | Ensemble rain context on live screen; static EA risk layer | — | if time |
| — | **Code freeze 11:00.** Devpost by 12:00 (workshop 09:00) | | |

---

## 13. Acceptance criteria
1. `make data travel train backtest` runs end-to-end from a clean clone (given network), and the web app runs offline from committed JSON.
2. Station IDs, qualifiers and thresholds are verified from API metadata; mismatches logged in quality.json.
3. Travel-time distributions come from ≥ 3 past events per reported pair, with exclusions explained.
4. The model beats persistence on pinball loss at ≥ 24 h lead on the test set **or** the UI reports honestly that it doesn't.
5. Reported interval coverage within ±10 percentage points of nominal on held-out events, or the gap is shown.
6. The Time Machine never reveals observed data after the slider time to the forecast (verified by a test).
7. Every screen shows the disclaimer link; About lists all data sources and licences (EA/OGL, Open-Meteo CC BY if used, OSM ODbL).
8. No raw data or models committed; committed JSON in `web/public/data/` totals < 50 MB.

---

## 14. Engineering rules
- UTC internally; Europe/London only in the UI. (Clocks go back tonight; test a timestamp across 2026-10-25 01:00–02:00.)
- Never compare stage across gauges; use per-gauge anomalies.
- No future data in features (leakage test in `tests/`).
- Small PRs, one module per PR; don't change §8 contracts without telling the team and updating fixtures + `contracts.ts` in the same PR.
- Seeds fixed; scripts idempotent; cache API responses in `data/raw/` and never re-download unnecessarily. Poll live endpoints ≤ every 15 min.
- Python: type hints, `ruff`; TS: strict mode.

---

## 15. Demo script (for the Story lead; app must support it)
1. Hook (20 s): "Two to three days before Botley Road floods, the water's already in the Cotswolds. We measured how long it takes to get here." (River strip with travel times.)
2. Time Machine (90 s): Jan 2014; play; forecast fan narrows; our ≥50% marker fires; official warning marker appears later; real peak lands in our band.
3. Decide (45 s): judge picks Council; expected-cost bars.
4. Proof (45 s): skill vs persistence; reliability; Feb 2026 near-miss (false alarm or not).
5. Close (10 s): "Oxford's flood scheme is only now starting construction. This works today."
Each teammate must be able to explain: the travel-time finding, how the model turns quantiles into "when", and why we compare against persistence.

---

## 16. Sources
- EA flood-monitoring API: https://environment.data.gov.uk/flood-monitoring/doc/reference · rainfall: https://environment.data.gov.uk/flood-monitoring/doc/rainfall
- EA Hydrology API: https://environment.data.gov.uk/hydrology/doc/reference · https://api.gov.uk/ea/hydrology/
- Oxford gauges & warning areas: https://check-for-flooding.service.gov.uk/river-and-sea-levels/target-area/061WAF23Oxford
- Kings Mill metadata (mirror): https://dsp.agrimetrics.co.uk/flood-monitoring/id/stations/1491TH.html
- EA OFAS hydrology report (48–72 h response; rating issues): https://consult.environment-agency.gov.uk/thames/ofas-updates/user_uploads/fra-appendix-d-hydrology_report.pdf
- Historic Flood Warnings: https://www.data.gov.uk/dataset/d4fb2591-f4dd-4e7f-9aaf-49af94437b36/historic-flood-warnings2
- Open-Meteo historical weather: https://open-meteo.com/en/docs/historical-weather-api
- USACE reach-routing guide (travel time from matched hydrograph features): https://www.hec.usace.army.mil/confluence/hmsdocs/hmsguides/applying-reach-routing-methods-within-hec-hms/applying-the-muskingum-routing-method
- Water Supply Forecast Rodeo winners (boosted quantile models): https://blog.drivendata.org/blog/water-supply-forecast-and-final-winners
- IC Hack 26 HRT winner (context): https://devpost.com/software/wildfire-rcz2xb
- Event evidence: Jan 2024 https://www.highwaysmagazine.co.uk/news/local-road-network/freeze-adds-counties-flooding-woes · Nov 2024 https://www.oxford.gov.uk/news/article/1591/flood-warnings-issued-for-oxford-as-river-levels-continue-to-rise · Feb–Mar 2026 https://www.floodradar.co.uk/flood-event/flood-alert-river-thames-and-tributaries-in-the-oxford-area-2026-02-25
- Oxford Flood Alleviation Scheme: https://engageenvironmentagency.uk.engagementhq.com/oxfordfloodalleviationscheme · Botley Road reopening: https://letstalk.oxfordshire.gov.uk/provider-engagement/news_feed/botley-road-to-reopen-on-20-september
