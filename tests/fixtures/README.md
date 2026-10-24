# Contract fixtures

One small, valid sample per JSON file the web app reads from `web/public/data/` (SPEC §9, stretch §11). Types live in `web/src/contracts.ts`; `tests/test_fixtures.py` checks every file against them.

Values are **illustrative**, not real data. Gauge keys, names, rivers, amber / threshold / record levels, spot coordinates, event ids and windows come from SPEC §4.1–§4.3; gauge coordinates are approximate; everything else (forecasts, metrics, travel times, quality counts) is made up but kept internally consistent. Unresolved station refs use the bracketed GOV.UK page ID as a string (e.g. `"7054"`).

| File | Contract type | What it is |
|---|---|---|
| `stations.json` | `Station[]` | All 10 river gauges from SPEC §4.1. |
| `spots.json` | `Spot[]` | The 5 trouble spots from SPEC §4.2; `cherwell` is `timing_only`. |
| `events.json` | `EventMeta[]` | The 6 events from SPEC §4.3 with per-gauge peaks; `e2014` is the headline; `e2026` osney peak 3.41 m. |
| `travel_times.json` | `TravelPair[]` | 6 gauge pairs (Thames chain to osney, osney to iffley, enslow to kingsmill); includes excluded events and one pair with `n` < 3 (cross-correlation fallback, lag_main ± 6 h). |
| `live.json` | `Forecast` | Live forecast issued 2026-10-25 01:15 UTC, inside the clocks-go-back window; `newbotley` is stale so `botley` has `leads: []`; `cherwell` shows amber timing with `pFlood: null`. |
| `replays/e2014.json` | `Replay` | 5 days around the 9 Jan 2014 osney peak (3.97 m): hourly observed levels for osney, godstow, eynsham, cassington; forecasts for osney and wolvercote **every 6 h** (the real file has one per hour); an EA alert and warning; the osney crossing. |
| `proof.json` | `Proof` | Skill and coverage for all 6 leads; reliability (10 bins) for osney and abingdonrd; trade-off for p* 0.1–0.9; per-event rows including the e2026 near-miss (`crossed: false`). |
| `quality.json` | `Quality` | Quality report for all 10 gauges (one threshold mismatch, one gauge with no API threshold) and 5 data sources. |
| `importance.json` | `Importance` | Top features by gain for osney (h 6, 24, 72) and kingsmill (h 24). |
| `stretch/geo/risk_layers.json` | `RiskLayers` | S1: two WMS layers and one GeoJSON layer with legends. |
| `stretch/ensemble_rain.json` | `EnsembleRain` | S2: cumulative 10/50/90% rain over 72 h for three catchment points. |
| `stretch/spread/e2014/manifest.json` | `SpreadManifest` | S3: Osney/Botley bounds, 200 runs, one frame per lead, e2014 IoU. |
| `stretch/sandbags.json` | `Sandbags` | S4: two inspection candidates and two exclusions within a 500-bag budget. |

Conventions followed (and tested): times are ISO 8601 UTC ending in `Z`; leads are 6, 12, 24, 36, 48, 72 h; quantiles `"05"`…`"95"` are absolute levels on the gauge's own datum and non-decreasing; `pFlood` and `pAmber` are non-decreasing in h; arrival `p10`/`p50`/`p90` are set only when some lead reaches 0.1/0.5/0.9. For `timing_only` spots, `arrival.p50` is when the median forecast reaches amber and `p10`/`p90` are the upstream travel-time window.

Run the checks: `uv run --python 3.11 --with pytest pytest tests/test_fixtures.py`.
