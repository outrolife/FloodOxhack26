# Earlier warnings: which predictors could beat the EA's lead time

Part of #134. Research only, no code changes. Written Sat 24 Oct 2026, about 20:30 UTC. All times are UTC. Sources are numbered [n] at the end. Numbers marked **(probe)** come from API calls made tonight. The scripts are in the research session's scratchpad, and each one is a single request to the endpoint given.

**Not duplicated:** #125 (alfredo) covers further-upstream gauges, derived level features (rate of rise and similar) and regime-conditional CQR. #100 (s-s01s-rain) covers the first rain-forecast experiment. Its results are used here.

## TL;DR

1. **Only rainfall forecasts can add more than about a day of lead time.** Every observed-data predictor (gauges, soil, groundwater) works only after the rain has fallen. The EA is earliest in the floods where it used a forecast, such as Storm Bert at Botley (−30 h). #100 already showed that archived ECMWF forecasts get Botley's lead back to about 0 h vs the EA, but they also raised false alarms. Tonight's best test is **rain forecasts with forecast-error-aware training, plus an antecedent-wetness state (soil moisture or groundwater) that tells the model when rain will run off.**
2. **The Abingdon Road gap is partly how we score it.** Abingdon Road and Botley share one EA warning area (`061FWF23NwBotley`, `web/public/data/spots.json`). The "EA lead" at Abingdon Road is therefore the Botley warning. Abingdon Road's gauge crosses later, so at the same trigger we look late by construction.
3. **The cheapest lever needs no new data: a trigger level per spot.** The trade-off curve already in `proof.json` shows Abingdon Road at p* = 0.2 is +38 h vs the EA with 1 false alarm, and the Cherwell at p* = 0.3 is +25 h with 0. This is tuned on the same replays, so it must be re-chosen on validation events only (see "Lever 0").
4. **Soil moisture and groundwater are leakage-safe if lagged.** ERA5-Land lags real time by about 6 days (probe), so use it at t − 7 days. The 7-day autocorrelation is 0.97 (probe), so the lag costs little. Great Oolite groundwater loggers have hourly data for 2006–2026 and about 10–15 h latency (probe), so use them at t − 24 h.
5. **"Water density" carries no timing signal** (see the last section). Wet ground, high groundwater and forecast rain do.

## Why the EA is sometimes earlier (diagnosis)

| Spot | Our lead vs the EA's first warning, per flood (h, + = we're earlier) | Likely reason when we're behind |
|---|---|---|
| Osney | 2007 −16.7, 2012 +2.8, 2014 +20.9, 2024a +1.5 | 2007 was summer convective rain on dry-ish soil (rain-driven, fast). The EA had the rainfall forecast. |
| Botley | 2007 −12.7, 2012 −2.3, 2014 +7.1, 2021 −0.9, 2024a +3.5, **2024b −30.1** | 2024b (Storm Bert): a named storm with heavy forecast rain. The EA warned before the river response was visible upstream. |
| Abingdon Rd | 2007 −31.7, 2012 +7.7, 2014 −34.9, 2021 +5.1, 2024a −10.5, 2024b −23.1 | It shares warning area `061FWF23NwBotley` with Botley, so the EA time is the Botley warning (identical issue times in `proof.json`). Our trigger is Abingdon Road's own, later crossing. |
| Cherwell | 2012 +22.1, 2021 +4.4, 2024a +3.7, 2024b +2.4 | Ahead, but only by 2–4 h. The Cherwell is the quickest-responding river (BFIHOST 0.59; the Ray, at 0.49, is clay [17]). |

The physics behind this: the Thames above Oxford is groundwater-fed and slow (BFIHOST 0.69 at Eynsham, 0.79 for the Windrush, 0.70 for the Evenlode [17]). Travel time from our upstream gauges gives us 1–2 days at best. The EA's operational chain adds rainfall **forecasts** (deterministic, ensemble and nowcast) on top of gauges [5][6][7], plus a duty forecaster [8]. No observed predictor can reproduce that for rain still in the sky.

## Ranked top 5 features to test tonight

Ranked by expected lead-time gain per hour of work, with the leakage rule satisfied. Each one should be tested with the #134 adoption rule: earlier first-trigger lead vs the EA and vs the crossing, no extra false alarms, Brier not worse, leakage tests green.

| # | Feature | Expected effect | Leakage-safe source (exact endpoint below) | Cost |
|---|---|---|---|---|
| 1 | **Rain forecast for the next 0–24, 24–48 and 48–72 h, trained to be distrusted.** Perfect-prognosis training on observed future rain *degraded to match the ECMWF archive's error* (shrink plus noise per lead), evaluated honestly on the real archive (2024-01-22 on). | **Largest.** #100: 72 h skill rose from +0.11 to +0.28 and Botley in Storm Bert went from −29 h to about 0 h vs the EA. Error-aware training should keep most of that while cutting the 3 forecast-driven false alarms. | Open-Meteo Previous Runs API (ECMWF IFS 0.25°, filled from 0.4°), run issued ≥ 6 h before t. Live: Open-Meteo forecast API, ECMWF IFS. | 2–3 h (code on branch `model/rain-features`) |
| 2 | **ERA5-Land root-zone soil moisture**: 0.28 × (7–28 cm) + 0.72 × (28–100 cm), catchment mean of 3 points, **at t − 168 h**, plus its 14-day change. The existing `rain_168h` feature already bridges the 7-day lag. | **Fewer false alarms, sharper 36–72 h probabilities.** Not a lead gain on its own: `level_now` already carries most of the state [2]. As a partner to #1 it lets the model ignore forecast rain on dry ground. The Botley false alarm on 26 Sep 2024 came at the **11th percentile** of root-zone wetness at t − 7 d (probe). Every flood start was at the 61st–99th. | Open-Meteo archive, `models=era5_land`, 2006 on, 0.1°. | 1.5 h |
| 3 | **Great Oolite groundwater level anomaly** (each borehole minus its own median at the training cutoff), **at t − 24 h**, plus its 7-day change. Kings Wood SP41_88 (Evenlode/Glyme), Macaroni Wood SP10_53 (Coln), Fringford SP62_1 (Cherwell/Ray). | Same role as #2 but slower and deeper. It encodes the baseflow the flood rides on and the long wet-winter build-up (as in 2013/14 [11]). Probably most useful for the high-baseflow Thames chain at 48–72 h. Like #2, it **won't** fix the 12 Feb 2026 false alarm: groundwater was at the 99th–100th percentile then (probe). | EA Hydrology API, hourly loggers, data back to 2006, latency about 10–15 h (probe). **Not** on the flood-monitoring API. | 2 h (new pipeline fetch: Data lead's area) |
| 4 | **Antecedent precipitation index with longer memory**: API_k(t) = Σ_d k^d · P(day t − d) for k = 0.90 and 0.97 over 60 days, from our own catchment rain. | Small; largely redundant with #2 (soil moisture is a physically based API). Use it as the fallback if #2's extra API is unwelcome. | EA Hydrology API rain measures, already in `config/stations.yaml`. Latency ≤ 30 min (probe), so live can reach back 60 days. **Breaks the 21-day `MAX_WINDOW_H` cap (SPEC §7.2): needs a PM decision.** | 1 h |
| 5 | **Thames × Cherwell coincidence for Abingdon Road**: add `enslow`/`islip` anomalies at their travel lags as upstream features for `coldharbour`, plus `min(thames_up_anom, cherwell_anom)` at matched lags. | Small, a few hours at Abingdon Road. LightGBM can already learn interactions among the lags it gets, but `coldharbour` currently gets no Cherwell input (`UPSTREAMS` in `model/features.py`). The Cherwell enters the Thames between Botley and Iffley, so it may affect levels in the reach Hinksey Stream drains to. **Check with alfredo (#125) first:** this overlaps "further-upstream gauges / derived features". | Existing Hydrology level series (no new data). | 1 h |

**Suggested order tonight:** 2 → 1 (with 2 included) → 3. Feature 2 is cheap and makes 1 safer. Feature 4 only if 2 stalls; feature 5 only if #125 isn't doing it. Total for 1+2+3: about 6 h for one person, or about 3 h in parallel.

### Implementation notes (leakage first)

**#1 Error-aware rain forecast.**
- **Training.** Build `rain_fc_{0_24,24_48,48_72}` from observed catchment rain over (t, t + 24], (t + 24, t + 48] and (t + 48, t + 72]. Then degrade it per lead k: `r_syn = b_k · r_obs · exp(σ_k · z − σ_k²/2)`, with z ~ N(0, 1) and a fixed seed.
  - b_k comes from the archive's heavy-rain ratio: 0.78 / 0.72 / 0.56 (#100).
  - σ_k is set so that corr(r_syn, r_obs) matches the archive: 0.80 / 0.66 / 0.60 (#100).
  - Why: the model learns that "forecast" rain is only partly reliable, which is the documented failure of pure perfect-prognosis training. Pre-training on reanalysis and then fine-tuning on real forecasts is the same idea at scale [15]. Most forecast skill loss with lead comes from lower correlation (timing), not bias [15].
- **Honest test.** Use the real Previous Runs archive (`precipitation_previous_day{1,2,3}`, run issued ≥ 6 h before t, the exact rule from #100) on 2024-01-22 onward only.
- **Live.** Use the current ECMWF run from the forecast API. The Time Machine must use the Previous Runs archive, never observed rain.
- **Caveat.** The honest window contains one flood (e2024b). The adoption rule can be checked, but not with much statistical confidence.

**#2 ERA5-Land soil moisture.**
- **Latency (probe, 20:22 UTC 24 Oct).** The archive's last non-null ERA5-Land value was 2026-10-18 23:00. Open-Meteo documents "Daily with 5 days delay" [16]. A value at t is therefore **not** knowable at t.
- **Rule.** Use the value at t − 168 h in training, backtests, replays and live alike, so there is no train/serve skew. The root-zone series at the Eynsham, Enslow and upper Evenlode points has a correlation of **0.97** between t and t − 7 d over 2006–2026 (probe, n = 182,112 hours), so the lag loses very little.
- **Don't use a "fresher" substitute.** The forecast API's soil moisture, or `models=ecmwf_ifs` in the archive, comes from a different model with a different climatology. At the same point, 28–100 cm read 0.154 (IFS) vs 0.203 m³/m³ (ERA5-Land) (probe). The archive's `ecmwf_ifs` also returned values up to 23:00 UTC tonight when it was 20:22 UTC, so it contains forecast hours. Mixing the two silently shifts the feature at the training/live boundary.
- **Per-source rule.** As with gauges (rule 2), take an anomaly against ERA5-Land's own median at the training cutoff.
- **Event check (probe; root-zone percentile vs 2006-01 to 2018-09, at t − 7 d):**

| Date | Context | Percentile |
|---|---|---|
| 2007-07-19 | flood | 61 |
| 2012-11-23 | flood | 89 |
| 2014-01-01 | flood | 91 |
| 2021-01-27 | flood | 96 |
| 2024-01-01 | flood | 92 |
| 2024-11-22 | Storm Bert | 65 |
| **2024-09-25** | **Botley false alarm** | **11** |
| 2026-02-11 | Botley false alarm | 99 |

**#3 Groundwater.**
- **Coverage (probe).** Hourly values in each of 2007, 2012, 2014, 2020 and 2024 (8,760–8,784 per year). About 7,350–7,460 of the roughly 7,600 days since 2006 have data.
- **Latency (probe).** The latest readings at 20:30 UTC were 10:00 (Macaroni Wood), 07:32 (Kings Wood) and 05:07 (Fringford). Use t − 24 h.
- **Live mode.** These boreholes are **not** in the flood-monitoring API (only Berkshire Downs chalk sites near us are), so live mode must call the Hydrology API.
- **Percentiles at t − 1 d (probe):** Kings Wood / Fringford / Macaroni Wood. The rows that matter: Sep 2024 false alarm 85 / 29 / 36; Storm Bert 65 / 76 / 67; Feb 2026 false alarm 99 / 100 / 99; floods 2014 79 / 94 / 93, 2021 96 / 97 / 97.
- **Fallback.** Fairford SP10_85 (Coln) is equally complete. Alvescot Field Farm SP20_103 has logger data only from about 2020: don't use it.

**#4 API.** Cheap, but changing the 21-day cap touches SPEC §7.2 and live data fetching (pipeline). Only do it with a PM decision.

**#5 Coincidence.** Add `coldharbour: ("farmoor", "eynsham", "cassington", "enslow", "islip")` and travel lags for those pairs (#7's `lags.json` needs the Cherwell → coldharbour pair). That is a Model change plus an analysis rerun.

## Lever 0 (no new features): a trigger level per spot, scored per warning area

This comes from `proof.json → tradeoff` (event replays, leave-one-event-out; false alarms as counted there).

| Spot | p* = 0.5 (now): hits / false alarms, lead vs EA | Better p* | Hits / false alarms, lead vs EA |
|---|---|---|---|
| Osney | 7/7, 2 FA, +2.1 h | 0.3 | 7/7, 4 FA, **+13.4 h** |
| Botley | 8/8, 3 FA, −5.9 h | 0.4 | 8/8, 7 FA, +0.9 h |
| Abingdon Rd | 8/8, 0 FA, −14.6 h | 0.2 | 8/8, 1 FA, **+37.8 h** (0.3: 0 FA, −2.3 h) |
| Cherwell | 7/7, 0 FA, +8.2 h | 0.3 | 7/7, 0 FA, **+25.2 h** |

**Caveat: this is in-sample.** These p* values were picked by looking at the same replays. To claim it honestly, either (a) choose p* per spot on the validation-period events only and report the test-period result, or (b) present it as an explicit "early / balanced" setting, with the trade-off shown, rather than as a skill gain. Botley is the hard case: earlier triggers there cost real false alarms, which is why #1 + #2 matter. It costs about 0.5–1 h (the backtest already computes every p*) plus a PM/Story decision. For Abingdon Road, also report the lead vs the **area** (the Botley warning area) explicitly, so judges see why the comparison is unfair to the later-flooding spot.

## Literature, ranked by expected lead-time gain for slow lowland catchments

1. **Rainfall forecasts (deterministic → ensemble → post-processed): the only route to lead times beyond the catchment response time.**
   - Medium-range flood forecasting (about 2–15 days) needs NWP rainfall. Ensembles add value mainly by flagging uncertain, high-impact events early [1].
   - England's NFFS was trialled with MOGREPS ensembles **in the Thames Region configuration**. Even the coarse 24 km ensemble gave forecasters better information than deterministic forecasts, with few false alarms for flow exceedance [6].
   - Operational ML (Google) using forecast forcings reaches up to 5-day lead time for extreme events [13].
   - Pre-training on ERA5-Land and then fine-tuning on IFS forecasts is the published recipe for making an ML model "trust the forecast the right amount" [15].
   - Locally (#100), archived ECMWF forecasts added about a day at Botley in Storm Bert.
   - **Expected gain: +12 to +30 h at the Thames spots**, if false alarms are controlled.
2. **Antecedent wetness (soil moisture, API, groundwater): conditions how much rain becomes river.** It sharpens probabilities and cuts false alarms more than it moves the first trigger.
   - Across Europe, most annual maximum floods come from heavy rain on wet soils or from snowmelt, not from the year's biggest rainfall alone [3].
   - Antecedent moisture matters for forecasting, but **updating with the last observed flow closes much of the gap** [2]. We already do that (`level_now`, changes, the 21-day mean level), so expect modest gains on their own.
   - Assimilating satellite soil moisture helps mainly when initial wetness is otherwise unknown [4]. ERA5-Land provides a consistent 0.1° land reanalysis from 1950 on [12].
   - Groundwater as a predictor is supported by the high baseflow indices here [17] and the 2013/14 winter, when saturated ground and high groundwater sustained the Thames floods [11].
   - **SMAP** (satellite soil moisture) starts only in 2015 [18], so it can't cover our 2006–2026 training. Use ERA5-Land instead.
   - **Expected gain: 0 to +6 h on its own; it enables #1 without false alarms.**
3. **Data assimilation / autoregression.** For ML rainfall–runoff models, feeding recent observed flow as an input (autoregression) is more accurate and cheaper than variational DA [14]. Our model already does this. EA models use real-time updating to the same end [5][9]. **Expected gain: about 0; the gap is already closed.**
4. **Tributary peak coincidence, rate of rise, hysteresis.** These sharpen magnitude and timing once water is moving. They add hours, not days. Gradient-boosted trees can learn interactions from lagged upstream inputs, so the gain is mostly where an input is missing (the Cherwell for Abingdon Road). I found no study isolating a lead-time gain from hysteresis features. **Expected gain: 0 to a few hours** (and see #125).
5. **Snowmelt.** Only relevant in snow-dominated regimes [3]. On the Thames above Oxford it is rare (a historic exception was March 1947). **Not worth testing tonight.**

## What the EA and the Flood Forecasting Centre actually use

- **Platform.** NFFS, now the Incident Management Forecasting System, runs on Deltares' Delft-FEWS. It chains rainfall inputs to hydrological and hydraulic models [9][10].
- **Local models (the EA area, e.g. Thames).** Conceptual rainfall–runoff models (**PDM**, plus TCM and others), hydrological routing, and hydrodynamic models (**ISIS/Flood Modeller**, MIKE 11), with real-time updating against telemetered gauges [5][19].
- **National model (FFC).** **Grid-to-Grid (G2G)**: a 1 km distributed model with a 15-minute step, calibrated across England and Wales. It drives the FFC's 5-day fluvial guidance (Flood Guidance Statement) [7][20].
- **Rainfall inputs.** Telemetered rain gauges; weather radar; the **STEPS** nowcast ensemble (2 km); deterministic **UKV**; and the **MOGREPS-UK** ensemble. MOGREPS-UK is 2.2 km, out to 120 h, run hourly, with the latest runs combined into an 18-member lagged ensemble. Downscaled **MOGREPS-G** is used beyond that [6][7][21][22].
- **People.** Flood warnings are issued when rivers reach trigger levels **or when high levels are forecast**. EA duty officers and Met Office forecasters liaise before warnings go out [8]. The FFC is a joint Met Office–EA centre with a 24/7 hydrometeorologist service [20].

**Which gap we can close:** the "forecast rain" gap, partly, through #1 + #2. ECMWF IFS archived runs are a reasonable free stand-in for UKV/MOGREPS at a 1–3 day range. We can't close the "nowcast / radar" gap, and don't need to: our catchments respond in 1–3 days, so radar's hours-ahead skill matters little. We can't close the "duty officer knows a named storm is coming" gap at all.

## What can't be closed tonight (honest list)

1. **Met Office ensemble archives (MOGREPS-UK/G, STEPS) are not freely available back to 2006.** In Open-Meteo, UKMO previous runs start only about Oct 2024 (#100). We can't train or test on what the EA's forecasters actually saw.
2. **An honest rain-forecast test with more than one flood.** The free archive of forecast runs starts 2024-01-22, so only Storm Bert (e2024b) is in it. Any adoption decision on #1 rests on one flood.
3. **Ensemble rain (ECMWF ENS) for 2006–2026.** It isn't in a free archive at our lead times, so the ensemble-spread idea (#100 next step 2, S2) can't be trained honestly tonight.
4. **Area-level vs spot-level warnings.** The EA warns a whole area, while we forecast a gauge. At Abingdon Road part of the "EA lead" is structural; only re-scoring, not a better model, can fix that.
5. **Duty-forecaster judgement and forecast-led warnings ahead of any river signal.** For a Storm-Bert-type event, the EA can warn before rain reaches the ground. With observed data alone, no model can.
6. **Radar rainfall.** The Met Office 1 km NIMROD composite archive needs CEDA registration and a heavy download. It is too much for tonight, and it matters little for 1–3 day responses.

## Exact endpoints (all checked tonight)

```text
# ERA5-Land soil moisture / temperature, 2006 on, 0.1°, about 5-6 day latency -> use at t-168 h
https://archive-api.open-meteo.com/v1/archive?latitude=51.77,51.86,51.93&longitude=-1.36,-1.30,-1.60
  &start_date=2006-01-01&end_date=<today>&models=era5_land&timezone=GMT
  &hourly=soil_moisture_7_to_28cm,soil_moisture_28_to_100cm,soil_moisture_100_to_255cm,soil_temperature_0_to_7cm
#   layers available: 0_to_7cm, 7_to_28cm, 28_to_100cm, 100_to_255cm (moisture m3/m3; temperature degC)
#   cache in data/raw/openmeteo/; CC BY 4.0, attribute Open-Meteo + Copernicus

# Archived rain forecasts (the honest test, 2024-01-22 on): the run issued >= 24*d h before the valid time
https://previous-runs-api.open-meteo.com/v1/forecast?latitude=..&longitude=..&models=ecmwf_ifs025
  &hourly=precipitation,precipitation_previous_day1,precipitation_previous_day2,precipitation_previous_day3
  &start_date=..&end_date=..        (fill gaps with models=ecmwf_ifs04, as #100 did)

# Live rain forecast
https://api.open-meteo.com/v1/forecast?latitude=..&longitude=..&models=ecmwf_ifs025&hourly=precipitation&forecast_days=4

# Groundwater (EA Hydrology API), hourly loggers, mAOD, about 10-15 h latency -> use at t-24 h
https://environment.data.gov.uk/hydrology/id/measures/{station}-gw-logged-i-subdaily-mAOD-qualified/readings?mineq-date=2006-01-01&_limit=400000
#   Kings Wood    SP41_88  station 0dc90b10-f926-4b33-9d0f-d65993156e82  (51.871,-1.412) Great Oolite, Evenlode/Glyme
#   Macaroni Wood SP10_53  station 87e638ba-2718-489e-9832-007dae52049b  (51.739,-1.740) Great Oolite, Coln
#   Fringford     SP62_1   station 6a30a04f-f976-4544-8da9-deced6c83580  (51.952,-1.122) Great Oolite, Cherwell/Ray
#   Fairford      SP10_85  station 99a22595-d77b-49b5-9262-984a312f9ef7  (51.704,-1.794) Great Oolite, Coln (fallback)
# Station search:
https://environment.data.gov.uk/hydrology/id/stations?observedProperty=groundwaterLevel&lat=51.80&long=-1.40&dist=35

# Rain for a longer-memory API (live latency <= 30 min): existing measures in config/stations.yaml, e.g.
https://environment.data.gov.uk/hydrology/id/measures/5086b349-e04b-4f8e-b8f1-fa92b21078d0_256230TP-rainfall-t-900-mm-qualified/readings?mineq-date=..

# Catchment descriptors (BFIHOST etc.)
https://nrfaapps.ceh.ac.uk/nrfa/ws/station-info?station=39008&format=json-object&fields=id,name,bfihost,propwet,saar-1961-1990
```

## On water "density"

It's a good instinct to look for a signal in the water itself, but density doesn't carry one we can use:
- River water density changes by only about 0.1% between winter and summer temperatures, and by a similar or smaller amount from flood-time suspended sediment. That is far too little to measure as a forecast signal. The EA's level gauges measure the water surface, not density.
- **Turbidity and suspended sediment** do change during floods. At many sites sediment peaks *before* the flow peak (clockwise hysteresis) [23][24]. But it is measured at the same place, it leads by hours at most, and the EA doesn't publish real-time turbidity for these gauges. It tells you a flood is happening, not that one is coming.
- **What is useful instead:** how wet the ground is (soil moisture, #2), how full the aquifer is (groundwater, #3), and how much rain is forecast (#1). Together these are the "state" that density was meant to capture.

## References

1. Cloke, H. L. and Pappenberger, F. (2009). [Ensemble flood forecasting: a review](https://centaur.reading.ac.uk/35053). *J. Hydrol.* 375, 613–626. doi:10.1016/j.jhydrol.2009.06.005. Also the [ECMWF Tech Memo 574 preprint](https://www.ecmwf.int/en/elibrary/8742-operational-flood-forecasting-review-ensemble-techniques).
2. Berthet, L., Andréassian, V., Perrin, C. and Javelle, P. (2009). [How crucial is it to account for the antecedent moisture conditions in flood forecasting?](https://hess.copernicus.org/articles/13/819/2009/) *HESS* 13, 819–831.
3. Berghuijs, W. R., Harrigan, S., Molnar, P., Slater, L. J. and Kirchner, J. W. (2019). [The relative importance of different flood-generating mechanisms across Europe](https://ora.ox.ac.uk/objects/uuid:a27a5c31-2f0b-4ffc-b54f-86dd9221e556). *WRR* 55, 4582–4593. doi:10.1029/2019WR024841.
4. Brocca, L. et al. (2010). [Improving runoff prediction through the assimilation of the ASCAT soil moisture product](https://hess.copernicus.org/articles/14/1881/2010/). *HESS* 14, 1881–1893.
5. Environment Agency / CEH. Comparison of rainfall–runoff models for flood forecasting ([NORA 7471](https://nora.nerc.ac.uk/id/eprint/7471/)), and the NFFS local-model groups (PDM, hydrological routing, ISIS/MIKE 11 hydrodynamic) compared with G2G in [Hydrological modelling using convective scale rainfall modelling: phase 1 report (EA/CEH, 2010)](https://nora.nerc.ac.uk/id/eprint/13824/1/Phase_1_Report_SCHO0210BRYR-e-e.pdf).
6. Schellekens, J., Weerts, A. H., Moore, R. J., Pierce, C. E. and Hildon, S. (2011). [The use of MOGREPS ensemble rainfall forecasts in operational flood forecasting systems across England and Wales](https://adgeo.copernicus.org/articles/29/77/2011/). *Adv. Geosci.* 29, 77–84.
7. Flood Forecasting Centre (2014). [Hydrological ensembles at the Flood Forecasting Centre: current and future developments](https://www.ecmwf.int/sites/default/files/elibrary/2014/13606-hydrological-ensembles-flood-forecasting-centre-current-and-future-developments.pdf) (ECMWF workshop slides; G2G inputs: nowcast, UKV, MOGREPS-UK, STEPS).
8. Environment Agency evidence to the EFRA Select Committee (2008), [Minutes of Evidence](https://publications.parliament.uk/pa/cm200708/cmselect/cmenvfru/49/7101003.htm): NFFS, trigger levels, "or when high levels are forecast", duty officer–Met Office liaison.
9. Werner, M. et al. [The Delft-FEWS flow forecasting system](https://research.vu.nl/en/publications/the-delft-fews-flow-forecasting-system/) (*Environ. Model. Softw.*, 2013).
10. Find a Tender (2025). [Incident Management Forecasting System (IMFS) support notice](https://www.find-tender.service.gov.uk/Notice/070518-2025/PDF): IMFS is the EA's primary forecasting system, on Delft-FEWS.
11. Muchan, K., Lewis, M., Hannaford, J. and Parry, S. (2015). The winter storms of 2013/2014 in the UK: hydrological responses and impacts. *Weather* 70(2), 55–61. Local context: [EA briefing note (Surrey CC)](https://mycouncil.surreycc.gov.uk/documents/s15000/ITEM%205a%20ii%20Annexe%205b%20-%20Environment%20Agency%20Briefing%20Note.pdf).
12. Muñoz-Sabater, J. et al. (2021). [ERA5-Land: a state-of-the-art global reanalysis dataset for land applications](https://essd.copernicus.org/articles/13/4349/2021/). *ESSD* 13, 4349–4383.
13. Nearing, G. et al. (2024). [Global prediction of extreme floods in ungauged watersheds](https://research.google/pubs/ai-increases-global-access-to-reliable-flood-forecasts/). *Nature* 627, 559–563. doi:10.1038/s41586-024-07145-1.
14. Nearing, G. S. et al. (2022). [Technical note: Data assimilation and autoregression for using near-real-time streamflow observations in long short-term memory networks](https://hess.copernicus.org/articles/26/5493/2022/). *HESS* 26, 5493–5513.
15. [AIFL: a global daily streamflow forecasting model using a deterministic LSTM pre-trained on ERA5-Land and fine-tuned on IFS](https://arxiv.org/pdf/2602.16579) (arXiv 2602.16579, 2026; preprint).
16. Open-Meteo. [Historical Weather API documentation](https://open-meteo.com/en/docs/historical-weather-api): ERA5/ERA5-Land "Daily with 5 days delay", ERA5-Land 0.1°, soil layers 0–7/7–28/28–100/100–255 cm.
17. UKCEH National River Flow Archive, [station-info web service](https://nrfaapps.ceh.ac.uk/nrfa/ws/station-info?station=39008&format=json-object&fields=id,name,bfihost): BFIHOST 39008 Thames at Eynsham 0.686, 39006 Windrush at Newbridge 0.79, 39034 Evenlode at Cassington 0.699, 39021 Cherwell at Enslow 0.59, 39140 Ray at Islip 0.49.
18. NASA JPL. [SMAP mission](https://smap.jpl.nasa.gov/) (launched January 2015).
19. [Flood Modeller (formerly ISIS)](https://en.wikipedia.org/wiki/Flood_Modeller): the EA's 1D/2D hydraulic modelling package.
20. Price, D. et al. (2012). [Operational use of a grid-based model for flood forecasting](https://nora.nerc.ac.uk/id/eprint/16535/). *Proc. ICE Water Management* 165(2), 65–77. Also [Pilling et al., FFC (IAHS)](https://iahs.info/uploads/dms/16625.75-419-424-363-63-Paper-105-Cpilling.pdf).
21. Met Office. [The Met Office ensemble system (MOGREPS)](https://www.metoffice.gov.uk/research/weather/ensemble-forecasting/mogreps).
22. CEH / EA. [Hydrological modelling using convective-scale rainfall modelling (STEPS, MOGREPS in NFFS)](https://nora.nerc.ac.uk/id/eprint/13828/).
23. Lloyd, C. E. M., Freer, J. E., Johnes, P. J. and Collins, A. L. (2016). [Technical Note: Testing an improved index for analysing storm discharge–concentration hysteresis](https://hess.copernicus.org/articles/20/625/2016/). *HESS* 20, 625–632.
24. Review of concentration–discharge hysteresis (clockwise loops = sediment peak before flow peak): [ESS Open Archive preprint](https://essopenarchive.org/doi/full/10.1002/essoar.10503421.1).

*Note: the Consensus paper-search quota was exhausted this month, so the sources were found through web search and checked against the publisher or repository pages linked above.*
