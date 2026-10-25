# FloodClock

Forecasts when, and how likely, five Oxford flood trouble spots are to flood in the next 72 hours, from upstream Environment Agency river gauges. **Decision-support prototype, not an official flood warning:** for official warnings check [gov.uk/check-flooding](https://www.gov.uk/check-flooding).

## Inspiration

Living in Oxford, we noticed how heavy rain can leave water building up in streets and low-lying areas. That made us wonder how vulnerable the city is to flooding, and whether people could get a clearer picture of where river levels were heading.

We researched how river flooding develops around Oxford and what public information was available. The Environment Agency publishes readings from river gauges, but those readings can be difficult to interpret if you just want to know: **How likely is flooding near me, and when might it happen?**

We built **FloodClock** to turn upstream river readings into a more understandable picture of flood risk and timing. It is intended as an informative decision-support tool, not an official warning or a replacement for the Environment Agency.

## What it does

FloodClock brings together historical and recent readings from Environment Agency river and rain gauges. A gauge is a monitoring station: river gauges measure water level, while rain gauges measure rainfall. Because each river gauge has its own reference point, its level should be interpreted against that gauge's own history and flood threshold, not compared directly with readings from other gauges.

The project uses historical data to train models to forecast river-level changes at different lead times, from 6 to 72 hours. It combines:

- Recent levels and changes at a target gauge
- Upstream levels aligned using estimated travel times
- Rainfall that has already fallen
- The season

It then turns the forecast range into an estimated chance of passing a local flood threshold.

The interactive map shows the river network, gauges, and forecast risk at trouble spots. The timeline lets you explore live readings or replay past events. Those map animations help explain the relationships between gauges; they are not a simulation tracking water through city streets.

The project is designed around five Oxford-area trouble spots. Probability forecasts are available for four modelled locations. Wolvercote can show a live gauge level but does not currently have a forecast, because there is not suitable historical data for its gauge. Some locations also use a nearby gauge as a stand-in, which the app explains.

## How we built it

- **Collected public data:** We used Environment Agency historical river-level and rainfall data, recent readings from the live flood-monitoring service, and historic flood-warning records.
- **Checked the gauges:** We matched the gauges' historical readings to their flood thresholds. This mattered because some lock gauges had historical data only for the upstream side, which stays relatively flat during floods. We changed our target gauges rather than train on misleading readings.
- **Prepared the data:** We checked and cleaned readings, converted them into hourly data, and recorded gaps and data quality.
- **Measured travel times:** We compared the timing of river rises at upstream and downstream gauges during past events. For example, a rise at Enslow reaches Kings Mill in about 18.6 hours on average across six floods, though the timing varies.
- **Trained and tested the model:** We used LightGBM quantile models to forecast a range of future levels, then estimated the chance of crossing each location's threshold. We compared performance with a simple baseline: the river level stays roughly where it is.
- **Built the app:** A React and TypeScript interface presents the data on a map and timeline. It can run offline from saved project data. We also built an experimental sandbag-screening feature using terrain data.

## Challenges we ran into

- **Finding usable data:** The gauges we first expected to use did not have suitable historical readings on the side of the river relevant to their flood thresholds. We had to check the data and retarget the model.
- **Collaboration:** Several people and AI-assisted coding sessions worked in parallel. Shared task tracking and clear data contracts helped us coordinate changes without breaking the app.
- **Optimisation and integration:** Processing historical data, training models, and keeping the app responsive required careful coordination between the data pipeline, model, API, and interface.
- **Designing the interface:** We had to turn complex readings, uncertainty, and event comparisons into a map and timeline people could understand quickly.
- **Model precision:** Oxford has only a small number of major historical flood events. We had to avoid data leakage, compare against a baseline, and be honest about false alarms, uncertainty, and cases where the EA warning came first.

## Accomplishments that we're proud of

- We built a working prototype around a real Oxford flooding problem using public data.
- We created historical replays that show forecasts alongside observed levels, EA warnings, and threshold crossings.
- In our replay evaluation, FloodClock caught **29 of 30** threshold crossings with **6 false alarms**. EA Flood Warnings, scored under the same project rules, caught **24** with **1 false alarm**. These results show a trade-off, not that FloodClock replaces or generally outperforms the EA.
- We built an experimental sandbag-screening view for Osney and Botley, estimating where screening suggests sandbags could be prioritised. It is not an instruction system or a verified operational flood model.
- We made the demo work offline, so judges can explore it without relying on a live connection.

## What we learned

We learned how to coordinate development across people and AI coding agents, and how important clear task ownership and shared interfaces are when work happens in parallel.

We also learned to inspect the data before building a model: a gauge reading can look useful but still be the wrong measurement for the question being asked. Along the way, we learned more about Oxford's rivers, flood monitoring, travel-time relationships, and the limits of making forecasts from a small number of past events.

Most importantly, we learned that a forecast needs to show uncertainty and be tested against a simple baseline, not just look convincing on a map.

## What's next for FloodClock

- **Expand to other places:** Adapt the approach for other towns with connected river gauges, suitable historical records, and locally checked flood thresholds.
- **Improve rainfall and gauge coverage:** Carefully test forecast rainfall as a model input, and work toward better historical data for locations currently represented by nearby gauges. Any new feature would need to be evaluated for accuracy and false alarms before being relied on.

## Quickstart

You need Python 3.11 (installed by `uv`), Node.js and, on macOS, `libomp` for LightGBM.

```bash
# macOS
brew install uv node libomp gh

git clone https://github.com/outrolife/FloodOxhack26.git
cd FloodOxhack26

make setup     # creates .venv with Python 3.11 and installs dependencies
make test      # Python tests, including the leakage tests
make web       # installs web dependencies and starts the app at http://localhost:5173
```

**Run the demo (what we show judges).** One process serves the built app, its data and the API, offline (the first run needs a network once, for `npm ci`):

```bash
make demo        # builds the app if needed and serves it at http://127.0.0.1:8080 (DEMO_PORT=8090 make demo if 8080 is busy)
make preflight   # in a second terminal: checks data, build, port and time zone (same DEMO_PORT)
```

`make demo` also tries to download the optional offline basemap for MapLibre (`?map=gl`, `make tiles`); this needs `gh auth login`, and without it the default Leaflet map still runs while MapLibre uses its GeoJSON fallback. Both maps offer Oxford and full-catchment presets; MapLibre remains opt-in until its worker is verified in production. `make fetch-data` downloads the cleaned river history from the GitHub release instead of the long `make data` download (needed only to rerun `make travel`, `make train` or `make backtest`), also with `gh`. The full checklist and fallbacks are in [`docs/demo-backup.md`](docs/demo-backup.md).

**The app runs offline.** It reads committed JSON from `web/public/data/`. If a file is missing, it falls back to the matching sample in `tests/fixtures/` and shows a "sample data" notice. The basemap is bundled (`web/public/data/geo/`), so the map works with no network; OpenStreetMap tiles are only an optional layer on top.

### Full pipeline (needs a network)

```bash
make data      # download EA history and historic warnings, clean, write the quality report
make travel    # travel-time finding -> web/public/data/travel_times.json
make train     # train and calibrate the 4 gauge models -> web/public/data/importance.json
make backtest  # leave-one-flood-out replays for all 7 events + proof.json -> web/public/data/
```

Downloads are cached in `data/raw/` and never fetched twice. `data/` and model files are gitignored.

### Live mode

```bash
make live      # last 28 days of EA readings + a forecast for now
make api       # FastAPI on http://localhost:8000; the web dev server proxies /api to it
```

The API polls the EA at most every 15 minutes. A gauge whose latest reading is more than 3 hours old is marked stale, and spots that depend on it get no forecast. If the API is down, the Now view says "Live data unavailable" and shows the last saved forecast with its time.

### Tiger Data mirror (optional)

```bash
make mirror    # copies hourly.parquet and live_hourly.parquet into Tiger Data (needs TIGER_DATABASE_URL in .env)
```

A one-way copy of the hourly river and rain readings into a [Tiger Data](https://www.tigerdata.com/) (Timescale / Postgres) service, so anyone can query 20 years of Oxford river levels in SQL. The app, API and model never read from it, so the offline demo doesn't need it.

- **What it stores:** `readings_hourly`, a hypertable of 3,287,615 history rows plus live rows (gauge, UTC hour, mean and max level, rain, quality flags); `gauges`, one row per gauge with its normal-range top and flood threshold; `readings_daily`, a continuous aggregate of daily max and mean.
- **Measured on the team's service (Sat 24 Oct):** first load 65 s; a re-run inserts and updates nothing (idempotent); compression of 41 of 43 chunks took 434 MB to 35 MB (12.4×).
- **One query:** when did each upstream gauge peak before New Botley in Jan 2014? Cassington 84 h before, Farmoor 28 h, Eynsham 9 h, New Botley 3.032 m at 09:00 GMT on 9 Jan.

<!-- src: docs/tiger-data.md (PR #63) -->
Setup, all five example queries and their real outputs: [`docs/tiger-data.md`](docs/tiger-data.md).

### Other commands

`make lint` runs `ruff`. In `web/`, `npm test` runs the Vitest tests and `npm run build` type-checks and builds.

---

## Data sources and licences

We store and compute everything in UTC. The app shows UK time (Europe/London) with the zone. UK clocks went back from BST to GMT at 02:00 on Sun 25 Oct 2026, during the hackathon.

### Data the pipeline and app use

| Source | What we use it for | Licence and credit |
|---|---|---|
| [EA Hydrology API](https://environment.data.gov.uk/hydrology/doc/reference) | 15-minute river level and rainfall history: training, travel times, replays | Open Government Licence v3.0. Contains Environment Agency information © Environment Agency and database right. |
| [EA real-time flood-monitoring API](https://environment.data.gov.uk/flood-monitoring/doc/reference) | Live levels and rainfall (last 28 days); station metadata and thresholds; flood warning area polygons | Open Government Licence v3.0. © Environment Agency. |
| [EA flood-monitoring daily archive](https://environment.data.gov.uk/flood-monitoring/archive) | Checking downstream lock levels for Jan–Mar 2026 (the archive starts 29 Oct 2025) | Open Government Licence v3.0. © Environment Agency. |
| [EA Historic Flood Warnings](https://www.data.gov.uk/dataset/d4fb2591-f4dd-4e7f-9aaf-49af94437b36/historic-flood-warnings2) (data.gov.uk) | Issue times of official alerts and warnings for Oxford, 2006 – June 2026 | Open Government Licence v3.0. © Environment Agency. |
| [GOV.UK Check for flooding](https://check-for-flooding.service.gov.uk/) station and warning-area pages | "Property flooding is possible" thresholds, normal ranges and records (stations 7056, 7057, 7071, 7072, 7074, 7075, 7076) | Open Government Licence v3.0. Crown copyright. |
| [OpenStreetMap](https://www.openstreetmap.org/copyright): bundled basemap (water, rivers, roads, rail, parks, buildings), optional tiles; Nominatim and Overpass | The offline base map; building outlines for Protect; placing each spot on the street that floods | © OpenStreetMap contributors. Open Database Licence (ODbL). |
| EA LIDAR Composite DTM 2022 (1 m) and the Statutory Main River Map, via the Defra Data Services Platform | Terrain and river cells for the Protect flood spread | Open Government Licence v3.0. © Environment Agency. |
| EA Recorded Flood Outlines | Checking the Protect flood spread against the winter 2013/14 outline | Open Government Licence v3.0. © Environment Agency. |
| EA Risk of Flooding from Rivers and Sea (RoFRS) and from Surface Water (RoFSW) map layers | Optional overlays, fetched live from the EA map service only when switched on | Open Government Licence v3.0. © Environment Agency. |
| [Protomaps](https://protomaps.com/) basemap (release asset `basemap-v1`), Noto Sans fonts; drawn with MapLibre GL and deck.gl | The offline vector basemap of the catchment map | Built from OpenStreetMap data: © OpenStreetMap contributors, ODbL. Fonts: SIL Open Font Licence. |
| [Open-Meteo](https://open-meteo.com/) ensemble API (ECMWF IFS, 51 members) | Experimental "Rain in the next 72 h" panel under Now → Show the working (stretch S2). Context only, **not a model input** | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Weather data by Open-Meteo.com. |

**The shipped model uses no weather forecast or Open-Meteo data** (the rain-forecast test above used the Open-Meteo previous-runs archive and stays on its own branch). The spec lists Open-Meteo as a fallback for rainfall *history*, but all five EA rain gauges have dense 15-minute history from 2000 or earlier (#2), so we didn't need it. Open-Meteo appears only in the S2 rain-context panel above, which the model does not read.

### Evidence sources (for checking thresholds and event dates; not redistributed)

We read these to check that each gauge threshold matches real flooding at its spot. We quote short facts and link to the source. They aren't model inputs.

- Osney Island Residents' Association: [flooding pages and FAQs](https://osneyisland.org.uk/flooding/faqs); newsletters [Feb 2023](https://osneyisland.org.uk/wp-content/uploads/2023/02/osney-newsletter-2023-feb.pdf) and [Feb 2024](https://osneyisland.org.uk/wp-content/uploads/2024/02/osney-newsletter-2024-feb.pdf)
- Cherwell (student newspaper): [live blog, Jan 2014](https://www.cherwell.org/2014/01/07/update-floods-hit-central-oxford/)
- Oxford History: [floods 2007, 2012, 2014 and 2024](https://oxfordhistory.org.uk/floods/2014/index.html)
- Highways Magazine: [Abingdon Road closure, Jan 2024](https://www.highwaysmagazine.co.uk/news/local-road-network/freeze-adds-counties-flooding-woes)
- ITV Meridian: [9 Feb 2014](https://itv.com/news/meridian/2014-02-09/oxfordshire-facing-worse-flooding-since-2007)
- Oxford City Council news: [2021 flooding update](https://www.oxford.gov.uk/news/article/1706/flooding_update_1221), [2021 response](https://www.oxford.gov.uk/news/article/1715/city_council_and_ods_step_up_to_deal_with_the_floods), [Nov 2024 warnings (Wayback copy)](http://web.archive.org/web/20251015053110/https://www.oxford.gov.uk/news/article/1591/flood-warnings-issued-for-oxford-as-river-levels-continue-to-rise)
- riverlevels.uk warning archive (republishes EA warnings): [Cherwell Oxford](https://riverlevels.uk/flood-warning-river-cherwell-for-the-oxford-area), [Wolvercote](https://riverlevels.uk/flood-warning-river-thames-and-tributaries-at-wolvercote-in-oxford), [Binsey and Osney](https://riverlevels.uk/flood-warning-river-thames-and-tributaries-in-the-binsey-osney-and-osney-island-areas-in-oxford)
- FloodRadar: [Oxford flood alert, Feb 2026](https://www.floodradar.co.uk/flood-event/flood-alert-river-thames-and-tributaries-in-the-oxford-area-2026-02-25)
- Culham Parish Council: [flood warnings, 5 Jan 2024](https://culham-pc.gov.uk/?p=70480)
- University of Oxford alumni, ["Watery Oxford II"](https://alumni.ox.ac.uk/node/3699671), 27 Feb 2024 (context only)
- UK Parliament, [EFRA Committee written evidence, 2007](https://publications.parliament.uk/pa/cm200708/cmselect/cmenvfru/49/49we69.htm) (not yet checked by hand)
- Oxfordshire County Council: [Botley Road reopening](https://letstalk.oxfordshire.gov.uk/provider-engagement/news_feed/botley-road-to-reopen-on-20-september)

Method references: [USACE HEC-HMS reach routing](https://www.hec.usace.army.mil/confluence/hmsdocs/hmsguides/applying-reach-routing-methods-within-hec-hms/applying-the-muskingum-routing-method) (travel time from matched hydrograph features); [DrivenData Water Supply Forecast Rodeo](https://blog.drivendata.org/blog/water-supply-forecast-and-final-winners) (boosted quantile models for streamflow).

---

## Limitations

- **Few floods.** Our event set has seven winters and summers since 2007, and one of them (2026) is a near miss. Every event-level number has wide uncertainty, so we show 90% bootstrap intervals.
- **Leave-one-flood-out can see the future.** A replay of the 2014 flood uses a model trained on the other floods, including later ones such as 2024. That is the best we can do with so few floods. Strict time-split test results are reported separately.
- **Thresholds are proxies.** The EA's "property flooding is possible" level is a gauge level, not a flood at your door. At Kings Mill we found no confirmed property flooding, only paths, parks and a pub.
- **Stand-in gauges.** Osney Island uses Minns Estate, about 1.2 km west on a side stream. Abingdon Road uses Cold Harbour. Osney Island also floods from groundwater and sewers, which a river gauge only partly reflects.
- **No forecast for Wolvercote.** Its gauge (Godstow downstream) has no history, so we show the live level only.
- **No future rainfall.** The model reads water already in the river and rain that has already fallen. Heavy rain still to come is not in the forecast. We tested rain forecasts; they helped at long leads but added false alarms (see "What's next").
- **Not better everywhere.** The accuracy gain is pooled; the EA's warning was earlier on average at Botley and Abingdon Road; and the Protect flood spread is a simple terrain fill checked against one event.
- **River flooding only.** No surface-water or groundwater forecasting.
- **Botley Road closure.** Botley Road was closed for the railway bridge works from April 2023 to September 2026, so road closures there in that period are not flood evidence. We used none.
- **Kings Mill is offline.** The Kings Mill gauge has sent no readings since 13 Oct 2026, 15:45 BST. Its history is fine, but in live mode it shows as stale and the Cherwell spot has no live forecast.
- **Not an official warning.** FloodClock does not replace EA flood warnings and must not be used instead of them.

---

## Disclaimer

**Decision-support prototype, not an official warning. Check [gov.uk/check-flooding](https://www.gov.uk/check-flooding).** The same line is on every screen of the app.

---

