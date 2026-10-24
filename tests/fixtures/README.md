# Contract fixtures

One small, valid sample per JSON file the web app reads from `web/public/data/` (SPEC §9, stretch §11). Types live in `web/src/contracts.ts`; `tests/test_fixtures.py` checks every file against them.

The fixtures follow the post-#30 gauge setup (SPEC §4.1.1).
- **From config:** `stations.json`, `spots.json` and `events.json` are the §9 fields of `config/stations.yaml`, `config/spots.yaml` and `config/events.yaml`.
- **Real record:** the replay's `official` array is the EA Historic Flood Warnings record for e2014.
- **Illustrative:** everything else (observed hydrographs, forecasts, metrics, travel times, quality counts) is made up, but kept internally consistent.

| File | Contract type | What it is |
|---|---|---|
| `stations.json` | `Station[]` | All 12 gauges from `config/stations.yaml`, with resolved refs. The trained targets are newbotley, kingsmill, minns and coldharbour; godstow, osney and iffley are `live_only`. |
| `spots.json` | `Spot[]` | The 5 trouble spots from `config/spots.yaml`: osney on minns (2.90 m), botley on newbotley, abingdonrd on coldharbour (2.44 m), cherwell on kingsmill, and wolvercote as `timing_only` on the live-only godstow. |
| `events.json` | `EventMeta[]` | The 7 events from `config/events.yaml` (including e2021 and the Jan–Mar e2026 window), with peaks on the four trained gauges. `e2014` is the headline; e2026 is the near miss (minns 2.742 m). |
| `travel_times.json` | `TravelPair[]` | 7 pairs on the trained flow paths: farmoor, eynsham and cassington to newbotley; farmoor to minns; cassington to coldharbour; enslow and islip to kingsmill. Includes excluded events, and one pair with `n` < 3 (islip to kingsmill: cross-correlation fallback, lag_main ± 6 h). |
| `live.json` | `Forecast` | Live forecast issued 2026-10-25 01:15 UTC, inside the clocks-go-back window. `kingsmill` is stale (a real telemetry outage since 2026-10-13), so `cherwell` has `leads: []`. `wolvercote` is on a live-only gauge, so it has `leads: []` and `arrival: null`. `method` is `"persistence"`, with its note. |
| `replays/e2014.json` | `Replay` | 23 Dec 2013 to 10 Jan 2014. Hourly observed levels for farmoor, eynsham (u/s), cassington, newbotley and minns; the newbotley and minns peaks (3.032 m and 3.090 m on 9 Jan) match `events.yaml`. Forecasts for osney and botley **every 6 h** (the real file has one per hour). The real EA messages: Oxford alert 2013-12-23 19:27Z, Cherwell alert 2013-12-24 09:12Z, Botley/Grandpont warning 2014-01-04 19:03Z, Osney warning 2014-01-06 12:56Z, Wolvercote warning 2014-01-07 18:44Z. Also the osney and botley crossings. |
| `proof.json` | `Proof` | Skill and coverage for all 6 leads; reliability (10 bins) for osney and abingdonrd; trade-off for p* 0.1–0.9, where hits + misses equals the number of crossed events. Per-event rows for all 7 events, taken from the `events.yaml` peaks, with `leadVsOfficialH: null` where no official warning was issued. |
| `quality.json` | `Quality` | Quality report for all 12 gauges and 5 data sources. `thresholdApi` is the flood-monitoring `typicalRangeHigh` from `stations.yaml`. Live-only gauges have only live coverage. Notes cover the eynsham u/s series, the substitute gauges and the Kings Mill outage. |
| `importance.json` | `Importance` | Top features by gain (feature names from `model/features.py`) for newbotley (h 6, 24, 72) and kingsmill (h 24). |
| `stretch/geo/risk_layers.json` | `RiskLayers` | S1: two WMS layers and one GeoJSON layer with legends. |
| `stretch/ensemble_rain.json` | `EnsembleRain` | S2: cumulative 10/50/90% rain over 72 h for three catchment points. |
| `stretch/spread/e2014/manifest.json` | `SpreadManifest` | S3: Osney/Botley bounds, 200 runs, one frame per lead, e2014 IoU. |
| `stretch/sandbags.json` | `Sandbags` | S4: two inspection candidates and two exclusions within a 500-bag budget. |

Conventions, all tested:
- Times are ISO 8601 UTC ending in `Z`.
- Leads are 6, 12, 24, 36, 48 and 72 h.
- Quantiles `"05"`…`"95"` are absolute levels on the gauge's own datum, and non-decreasing.
- `pFlood` and `pAmber` are non-decreasing in h.
- Arrival `p10`/`p50`/`p90` are set only when some lead reaches 0.1/0.5/0.9.
- A spot on a `live_only` gauge is `timing_only` with `leads: []` and `arrival: null`.
- For other `timing_only` spots, `arrival.p50` is when the median forecast reaches amber, and `p10`/`p90` are the upstream travel-time window.

Run the checks: `uv run --python 3.11 --with pytest pytest tests/test_fixtures.py`.
