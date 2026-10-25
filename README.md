# River Clock

*"Water upstream is Oxford's future. We read it as a clock."*

River Clock makes a **prediction** of when, and how likely, five flood trouble spots in Oxford will flood in the next 72 hours. It reads the Environment Agency (EA) river gauges upstream of the city, and it turns that prediction into a timed **decision**: when is it worth moving the car, rerouting, closing a road or putting out sandbags?

Built at OxHack 2026, Oxford, 24–25 October 2026.

> **Decision-support prototype, not an official warning. Check [gov.uk/check-flooding](https://www.gov.uk/check-flooding).**
> For official warnings and advice, call Floodline on 0345 988 1188.

---

## The problem

Oxford floods from the river, slowly. The Thames, the Cherwell and their side streams rise over a day or more, and the water that will reach Botley Road or Osney Island on Thursday is often already in the river at Farmoor or Enslow on Tuesday. Residents, commuters and the council have the EA gauge readings and the official warnings. What they don't have is a plain answer to two questions: *how likely is my street to flood, and by when?* And: *is it worth acting yet?*

## What River Clock does, in five steps

1. **A finding.** From past Oxford floods we measure how long a flood wave takes to travel from each upstream gauge to Oxford. That travel time is the "clock".
2. **One model.** A forecaster uses those travel times to pick its upstream inputs. It gives a range for each gauge's level 6 to 72 hours ahead, and from that, the chance that each spot passes its flood threshold, hour by hour.
3. **One baseline.** We compare the model against a simple rule: "the level stays roughly where it is". If the model can't beat that, it isn't worth using, and the app says so.
4. **Proof.** We replay real past floods hour by hour, using only what was known at each moment. We score the model against the baseline and against the times the EA issued its official warnings.
5. **Decisions.** A cost–loss rule says when acting is worth it. If acting costs C and not acting when it floods costs L, act when the chance of flooding is above C / L.

### The app: one screen

The app is a single screen, **River Clock**. It answers three questions at a glance: where is the water, when does it get here, and did that work in real floods? Every number is read from the committed JSON at runtime.

| Part | What you see |
|---|---|
| **The map** (hero) | Oxford's rivers flowing and rising as the water comes, every river gauge as a small icon (hover for its level), and a **ring for each trouble spot** that fills as its chance of flooding in the next 3 days rises. Pick a spot and its **river walk** lights up: the upstream gauges its water comes from, with the measured travel time on each link. |
| **The timeline** (under the map) | Our forecast range against the real river level, with three markers: **River Clock warned · EA warned · Flooded**. Press play and it runs hour by hour, revealing each reading only after it happened. |
| **The scoreboard** (2 lines) | For the chosen flood: when River Clock warned, when the EA warned, when it flooded. |
| **The switch** (top) | **Now \| 2014 \| Henk (Jan 2024) \| Bert (Nov 2024) \| 2026 near miss**, with 2007, 2012 and 2021 under More. Today's live forecast, or a past flood replayed with a model trained without it. |
| **The proof footer** (1 line) | Across all 30 floods we replayed: how many River Clock caught, and how many the official warning caught. |

A spot appears on the map only when we have data for it: Wolvercote has no forecast and is hidden, and the Cherwell is hidden in Now while the Kings Mill gauge is offline (it is shown in the replays).

Everything else is behind **Show the working**: sandbag screening (Protect), the accuracy and reliability charts, the cost–loss calculator, the per-event table, the data-quality report and the travel-time scatter. Presenter mode: **Space** plays the timeline, keys **1–5** switch flood, **P** enlarges the type. The app runs fully offline, with a bundled OpenStreetMap basemap.

Judges and presenters: the one-page version is [`docs/judges.md`](docs/judges.md); the demo script is [`docs/demo.md`](docs/demo.md).

---

## How it works

### Data first: the re-target story

The original plan was to forecast the EA gauges at Osney, Godstow and Iffley locks. The flood thresholds for those locks are on their **downstream** gauge (Osney's record is 3.97 m on 9 Jan 2014).

In the first hour of the hackathon we checked the EA data before writing any model code. We found that:

- The EA Hydrology API, the only public long history, holds only the **upstream** gauge at those locks. Upstream of the weir the level is held almost flat in a flood. At the 2014 peak, Osney upstream read 0.19 m. On 25 Feb 2026 it read −0.001 m while the downstream gauge read 3.34 m.
- The downstream series exist only in the live feed (about 4 weeks) and in the daily archive, which starts on 29 Oct 2025.

So a model trained on the lock history would have learned from a gauge that doesn't move in floods. We switched targets to four gauges whose history is on the same trace as their flood thresholds:

| Target gauge | Stream | 15-min history from |
|---|---|---|
| **New Botley** (primary) | Bulstake Stream | May 2002 |
| Minns Estate | Seacourt Stream | Jul 2003 |
| Cold Harbour | Hinksey Stream | May 2002 |
| Kings Mill (upstream) | Cherwell | Jan 1998 |

Two spots now use a nearby gauge as a **stand-in**:

- **Osney Island uses the Minns Estate gauge**, on the Seacourt Stream, **about 1.2 km west** of the island. We checked it against dated flood reports: Minns went above its 2.90 m threshold in 2007, 2014 and Jan 2024, when Osney homes or streets flooded. It stayed below in quiet winters such as Jan 2023 and Feb 2026. In 2021 it just touched 2.903 m and no homes flooded. It is a proxy for risk on the island, not a measure of it.
- **Abingdon Road uses the Cold Harbour gauge**, beside the stretch of road that was closed and pumped in Jan 2024. Cold Harbour first passed 2.44 m about 23 hours before the road closed at about 21:30 GMT on 5 Jan 2024.

Wolvercote stays on the Godstow downstream gauge. With no history to learn from, it shows the live level against its threshold, with the note "no forecast: no gauge history".

Checking the data first cost us an hour. It saved us from building a convincing demo on a gauge that never shows a flood.

Details: SPEC.md §4.1.1, issues #2 and #10, and the `evidence:` lists in `config/spots.yaml`.

### The travel-time finding

For each past flood and each pair of gauges (for example Farmoor → New Botley), we find the time the upstream gauge was halfway up its rise and the time the downstream gauge was halfway up its rise. The difference is the **half-rise travel time**. We do the same for the peaks. A pair needs at least 3 clean floods to count. Otherwise we fall back to a lagged cross-correlation and say so. The 10th, 50th and 90th percentiles of each pair's travel time decide which past hours of that upstream gauge the model sees.

**What we found** (half-rise travel time: median, with the 10th–90th percentile range; n = clean floods matched for that pair, out of all the rises we detected): <!-- src: web/public/data/travel_times.json (tHalf, tPeak, n, xcorr), main @ 0a61018 -->

| Pair | Half-rise median (p10–p90) | Peak-to-peak median | n |
|---|---|---|---|
| **Cassington → New Botley** | **9.5 h** (1.3–42.5 h) | 32.0 h | **24** |
| Cassington → Minns Estate | 18.4 h (6.4–43.9 h) | 48.5 h | 22 |
| Cassington → Cold Harbour | 52.3 h (20.8–80.3 h) | 50.0 h | 8 |
| Eynsham → Minns Estate | 7.1 h (0.1–10.3 h) | 15.0 h | 7 |
| Islip → Kings Mill | 31.0 h (16.6–73.1 h) | 18.0 h | 7 |
| **Enslow → Kings Mill** | **18.6 h** (15.0–22.8 h) | 24.5 h | **6** |
| Farmoor → Cold Harbour | 22.6 h (6.7–40.6 h) | 15.0 h | 4 |
| Eynsham → Cold Harbour | 41.6 h (12.8–100.6 h) | 14.5 h | 4 |
| Eynsham → New Botley | 0.6 h (0.1–4.4 h) | 8.0 h | 3 |
| Farmoor → New Botley | **cross-correlation only**: peak at 5 h lag (r = 0.38) | n/a | 0 |
| Farmoor → Minns Estate | **cross-correlation only**: peak at 6 h lag (r = 0.34) | n/a | 1 |

How to read it:
- The link we quote first is **Enslow → Kings Mill, about 18.6 h (6 floods, and a tight 15–23 h range)**. Its half-rise and peak times tell the same story.
- **Cassington → New Botley** has the most floods (24), but read it with care. New Botley often jumps quickly from local runoff before the routed wave arrives, which pulls the half-rise median down to 9.5 h and spreads it over 1–42 h. Its peak-to-peak time is 32 h. On the Thames side, the 2014 peak sequence (below) is the clearer picture.
- Nine of the eleven pairs have at least 3 clean floods. The two Farmoor pairs don't, so the model uses the cross-correlation peak lag ±6 h for them, and the app labels them "cross-correlation only".
- Eynsham → New Botley has only 3 floods and a median under 1 h. That is not a travel time we trust, and we don't quote it. Its peak-to-peak time (8 h) looks more physical.
- The ranges are wide. That is why the model takes each upstream gauge at its 10th, 50th and 90th percentile lags, not at one fixed lag.
- Whether bigger rises travel faster isn't settled by our data: the fitted slopes change sign from pair to pair. The steepest, Cassington → New Botley (−43 h per metre of rise), rests on a few slow floods, so we don't lean on it. <!-- src: travel_times.json slopeHoursPerMetre (cassington->newbotley -43.48; enslow->kingsmill 0.59; eynsham->coldharbour 35.84) -->

One flood seen in SQL, from the Tiger Data mirror: in Jan 2014, Cassington peaked 84 h, Farmoor 28 h and Eynsham 9 h before New Botley's 3.032 m peak at 09:00 GMT on 9 Jan. <!-- src: docs/tiger-data.md, query b -->

### The model

- **LightGBM quantile regression.** One small gradient-boosted tree model per (target gauge, lead time, quantile). Lead times are 6, 12, 24, 36, 48 and 72 h. Quantiles run from 5% to 95%. Each model predicts the *change* in level from now.
- **Inputs, all known at forecast time:** the target gauge's level and recent changes; each upstream gauge's level relative to its own long-term median, at the lags the travel times chose; catchment rainfall over the last 6 hours to 21 days (mean of five EA rain gauges); and the season.
- **Each gauge is compared only with itself.** Every gauge has its own datum, so we never compare raw levels across gauges.
- **River level, not flow.** The EA reports unreliable high-flow ratings at several of these gauges.
- **Conformal calibration.** We widen or narrow each prediction interval using held-out flood periods, so a "90% range" contains the outcome about 90% of the time.
- **From range to probability.** We turn the quantiles into a distribution and read off the chance of passing the spot's threshold at each lead time. The "arrival window" is when that chance first reaches 10%, 50% and 90%.

### The baseline: probabilistic persistence

"The level stays where it is, give or take the usual change over that many hours." Its spread comes from the training data. Every skill score in the app is relative to this baseline.

### The proof: leave-one-flood-out replays

For each past flood we retrain every model **without that flood** (plus 7 days either side), then issue a forecast every hour through the event (every 2 hours in the committed e2014 replay, to keep the file small). No data after a forecast's issue time can affect it: a forecast issued at t uses hourly rows only up to t − 1 h, and the replay timeline shows a reading only an hour after it happened (#93). Automated tests check this for the inputs (`tests/test_features.py`: change the future, check no input changes) and for the replays (`tests/test_backtest.py::test_replay_forecast_uses_no_data_after_issue_time`). <!-- src: PR #39, merged --> Separately, we report scores on a strict time split (test period from Oct 2021).

We score:
- pinball loss and skill against persistence, by lead time;
- interval coverage against nominal;
- Brier score and reliability for threshold crossings;
- hits, misses, false alarms and lead time for each trigger level;
- lead gained or lost against the EA's first official warning for the spot's area.

**Scoring rules** (exact definitions in `model/metrics.py`; tests in `tests/test_metrics.py`):
- **Skill, coverage and reliability** use the strict time-split test period (forecasts issued from 1 Oct 2021), which no model saw in training or calibration. They pool the four trained gauges.
- **Hits, misses, false alarms and lead times** use the leave-one-flood-out replays of the seven events.
- **A flood** is an up-crossing of the spot's threshold. Crossings less than 72 h after the previous one count as the same flood, because a level hovering at the line crosses it many times.
- **A trigger** at p* is a forecast whose flood chance (the highest over its leads) is at least p* **while the gauge is still below the line**. Once the river is over the line the flood is here, so a forecast issued then is neither a warning nor a false alarm.
- **Hit:** a trigger in the 72 h before a flood starts. **Lead** = flood start minus the first such trigger, so it is at most 72 h. **Miss:** a flood with no trigger in that window. **False alarm:** a run of triggers (less than 24 h apart) with no crossing from its first trigger to 72 h after its last.
- **Versus the EA:** lead vs official = EA Flood Warning issue time minus our first trigger. Positive means River Clock was earlier.
- **Warn-at level:** each spot's own trigger, chosen on the pre-2021 replays only (the lowest p* with at most 1 false alarm in every validation flood), then frozen and scored on the later floods: Osney 30%, Botley 60%, Abingdon Road 20%, the Cherwell 30%. The app's markers and proof footer, and our headline numbers, use it. <!-- src: proof.json warnAt[spot].pStar 0.3 / 0.6 / 0.2 / 0.3, warnAt.rule -->
- **Uncertainty:** bootstrap over events (1,000 resamples, seed 42), 90% intervals.
<!-- src: model/metrics.py docstring; model/proof.py PER_EVENT_P_STAR = 0.5; proof.json testPeriodNote -->

### Decisions: cost–loss

Three presets: **Resident** (move the car: C = £20, L = £2,000), **Commuter** (reroute: C = £5, L = £100) and **Council** (close a road or put up barriers: C = £5,000, L = £100,000). The best trigger is p* = C / L. The "River Clock warned" marker uses each spot's warn-at level (above). The calculator itself, with the expected cost over the replayed floods for River Clock, the official warnings, "never act" and "always act", is under Show the working.

### Protect: sandbag screening (experimental, in Show the working)

For Osney and Botley, the forecast level is pushed through a 5 m terrain model 200 times (level drawn from River Clock's range, terrain jittered for LiDAR error). The share of runs in which each cell is wet makes the heat map. Buildings whose walls get wet within 48 h are ranked by their chance of getting wet. Buildings are left out when the water comes before bags could be placed (3 h), when it's too deep for sandbags, or when a recorded flood defence is already there. The bag count assumes 10 bags per metre of exposed wall. At the 2014 peak the 50% wet area overlaps the EA's recorded flood outline with an intersection-over-union of **0.68**. It's a simple terrain fill: it ignores channels, walls, drains, pumps and defences, and the run frequency is not a verified flood probability. <!-- src: web/public/data/spread/e2014/manifest.json (runs 200, validation.iou 0.681, caveats); sandbags.json (budget 500, reasons) -->

---

## Results

### Already real (committed data and merged PRs)

- **Travel times:** the table above. Quoted first: Enslow → Kings Mill 18.6 h (15–23 h, n = 6). Most floods: Cassington → New Botley, 9.5 h to the half-rise but 32 h peak to peak (n = 24). <!-- src: web/public/data/travel_times.json enslow->kingsmill, cassington->newbotley -->
- **History:** 3,287,615 hourly rows over 21 series (river levels and rain), 1 Jan 2006 to 24 Oct 2026. Built from 8,757,380 fifteen-minute level readings and 3,648,795 rain readings from the EA Hydrology API. <!-- src: docs/tiger-data.md ("Measured on the team's service"); web/public/data/quality.json sources[].rows -->
- **Data coverage** (share of hours with a usable reading, 2006–2026; readings the EA marks suspect or rejected are dropped): <!-- src: web/public/data/quality.json gauges[].coveragePct -->

  | Gauge | Coverage | | Gauge | Coverage |
  |---|---|---|---|---|
  | New Botley | 99.8% | | Enslow | 99.8% |
  | Farmoor | 99.5% | | Kings Mill | 99.1% |
  | Cold Harbour | 98.5% | | Cassington | 93.2% |
  | Minns Estate | 97.4% | | Islip | 91.2% |
  | Eynsham | 96.7% | | Osney, Godstow, Iffley (downstream) | 0.7% each: 55 days of the daily archive only (15 Jan – 10 Mar 2026) |

  Every gauge's normal-range value from the EA API matches our config (no mismatches).
- **Live polling:** a full poll of the EA (17 requests: 12 level gauges, 5 rain gauges) went from 199.8 s to 28.5 s with 4 polite parallel workers; a repeat within 15 minutes comes from the cache in 0.07 s. <!-- src: PR #62 -->
- **Tiger Data mirror:** all 3.29M hourly rows plus live readings in a Timescale hypertable; compression took them from 434 MB to 35 MB (12.4×). Details below. <!-- src: docs/tiger-data.md -->

### The 2014 replay (real, `replays/e2014.json`)

A leave-one-flood-out replay of Jan–Feb 2014 for the four forecast spots, with a forecast issued every 2 hours (745 forecasts). All times GMT (= UTC in January). <!-- src: web/public/data/replays/e2014.json (PR #39) -->

For **Botley Road** (New Botley gauge, threshold 2.76 m):

| What | When (GMT) |
|---|---|
| EA Flood **Alert** for the area (the lower level) | 19:27, Mon 23 Dec 2013 |
| River Clock first ≥ 10% (at the 48 and 72 h leads) | 06:00, Fri 27 Dec 2013 |
| **River Clock first ≥ 50%** (60% at the 72 h lead, so also Botley's 60% warn-at level) | **10:00, Sat 4 Jan 2014** |
| EA Flood **Warning** for the area | 19:03, Sat 4 Jan 2014: **about 9 h after River Clock reached 50%** |
| New Botley passes 2.76 m | 01:00, Mon 6 Jan 2014: 39 h after River Clock reached 50% |
| New Botley peak (hourly mean 3.027 m) | 09:00, Thu 9 Jan 2014 |

<!-- src: replays/e2014.json botley: first max-lead pFlood >= 0.1 at 2013-12-27T06:00Z (h48 0.160, h72 0.196); first >= 0.5 and >= 0.6 at 2014-01-04T10:00Z (h72 0.6043); official warning 2014-01-04T19:03:30Z; crossing 2014-01-06T01:00Z -->

- The forecast issued at 10:00 on 4 Jan put the 50% arrival time at **01:01 on 6 Jan**, a minute after the gauge crossed. <!-- src: replays/e2014.json botley 2014-01-04T10:00Z arrival.p50 2014-01-06T01:01Z -->
- The peak, **3.03 m**, was **inside the 2.63–3.16 m range** (5–95%) that River Clock gave 72 h before it. <!-- src: replays/e2014.json forecast 2014-01-06T08:00Z botley h72 q05 2.627, q95 3.157; observed newbotley 3.027 m at 2014-01-09T09:00Z -->
- The EA's lower-level Flood Alert came out more than three days before River Clock's first 10%. We are ahead of the Flood Warning, not the Alert.
- One flood is one data point. `proof.json` agrees: Botley's e2014 lead vs the EA warning is +9.1 h (`perEvent`, and the same at the 60% warn-at level). Averaged over all floods at Botley, at its warn-at level, River Clock and the EA's warning are level (−0.9 h, below).

### Scores over all events (real, `proof.json`)

<!-- src: web/public/data/proof.json on main (regenerated with the leakage and scoring fixes, #94) unless noted. Not rounded up. -->

**Skill against persistence** (pinball loss, test period from Oct 2021, four trained gauges pooled). It is positive at every lead and falls as the lead grows:

| Lead | 6 h | 12 h | 24 h | 36 h | 48 h | 72 h |
|---|---|---|---|---|---|---|
| Skill (above 0 = better than persistence) | +0.39 | +0.36 | +0.29 | +0.24 | +0.19 | +0.12 |

In words: **39% more accurate than "the river stays where it is" at 6 h, 29% at 24 h and 12% at 72 h.** That's pooled. In the final retrain's per-gauge check (#162) the edge at Kings Mill is about zero from 36 h, and Cold Harbour's is about zero at 36 h and below zero after (−0.11 at 48 h, −0.32 at 72 h); New Botley and Minns Estate stay above +0.27 at every lead. <!-- src: proof.json skillByLead 0.3943, 0.3562, 0.2890, 0.2381, 0.1903, 0.1150; per-gauge figures from PR #162 (not in proof.json) -->

**Interval coverage: our ranges are too wide.** The actual coverage is above nominal at every lead. That is the safe direction, but it means the ranges are wider than they need to be:

| Interval | 6 h | 24 h | 72 h |
|---|---|---|---|
| 50% | 65% | 73% | 80% |
| 80% | 88% | 91% | 94% |
| 90% | 94% | 97% | 98% |

Most test hours are calm. Inside flood windows the 90% range holds 87–89% and the 80% range 76–79% across leads, close to nominal and slightly narrow. <!-- src: proof.json coverage (h6/h24/h72: 0.6544/0.7289/0.7963, 0.8787/0.9085/0.9442, 0.9372/0.9652/0.9755); testPeriodNote -->

**Reliability** (Brier score, test period, "did the level reach the line at some time in the next h hours"): the model's Brier score is as good as or better than persistence at every spot and lead. It ties at 6 h at Botley and Abingdon Road, and at 24 h at Abingdon Road. In the middle of the range it under-calls: pooled at 24 h, forecasts of about 24% flooded 55% of the time, but that dot holds only 22 forecast hours from a few floods. <!-- src: proof.json reliability brier vs brierPersistence; h24 bins with pPred in [0.2, 0.3) pooled over the four spots, weighted by n: pPred 0.241, pObs 0.545, n 22 -->

**Floods caught at each spot's warn-at level** (seven replayed events; "floods" are threshold crossings at least 72 h apart). **River Clock caught 29 of 30 with 6 false alarms. The EA's Flood Warnings, scored with the same rules on the same floods, caught 24 of 30 with 1 false alarm.** A warning counts as in force from its issue time until 24 h after its last update. This is the line in the app's proof footer.

| Spot (warn-at level) | Hits | Misses | False alarms | Mean lead before the crossing (90% CI) | EA Flood Warning, same rules: hits / misses / false alarms, mean lead |
|---|---|---|---|---|---|
| Osney Island (Minns), 30% | 7 | 0 | 3 | 43.4 h (27.5–54.7) | 5 / 2 / 0, 24.3 h |
| Botley Road (New Botley), 60% | 7 | 1 | 2 | 40.4 h (29.5–50.7) | 8 / 0 / 0, 37.8 h |
| Abingdon Road (Cold Harbour), 20% | 8 | 0 | 1 | 37.6 h (22.2–49.9) | 8 / 0 / 0, 42.0 h |
| Cherwell (Kings Mill), 30% | 7 | 0 | 0 | 21.9 h (11.7–30.2) | 3 / 4 / 1, 3.0 h |

Pooled over the 29 hits, River Clock's first trigger came **about 36 h** before the river crossed. <!-- src: proof.json tradeoff[spot] at warnAt[spot].pStar (hits, misses, falseAlarms, meanLeadH, ci90); pooled (7*43.43 + 7*40.43 + 8*37.62 + 7*21.86) / 29 = 35.9; officialOutcome (hits, misses, falseAlarms, meanLeadH); testPeriodNote (EA warning in force until 24 h after its last Update) -->

**At a single 1-in-2 trigger (p* = 0.5) for every spot** it is 28 of 30 with 5 false alarms (Osney 6/7, 2; Botley 7/8, 3; Abingdon Road 8/8, 0; Cherwell 7/7, 0), about 30 h before the crossing on average. <!-- src: proof.json tradeoff pStar 0.5; pooled meanLeadH weighted by hits 29.5 -->

**The one miss, honestly: the July 2007 summer storm at Botley.** At 50% we also miss it at Osney, and at Osney's 30% level we call it only 1 h ahead. It was a sudden summer downpour, which an upstream river signal can't see coming. <!-- src: proof.json warnAt.botley.perEvent e2007 misses 1; warnAt.osney.perEvent e2007 meanLeadH 1.0; tradeoff pStar 0.5 osney/botley misses 1 (both e2007, PR #162) -->

Part of the EA's misses is a definitional mismatch: we score their warnings against our gauge's threshold, not against theirs.

**Versus the EA's first Flood Warning.** At the warn-at levels River Clock was earlier at **12 of the 19 floods where both warned** (the app footer's count). The mean lead vs official is **+22.1 h at Osney, −0.9 h at Botley (level), +37.8 h at Abingdon Road and +25.2 h at the Cherwell**. Abingdon Road's mean is flattered by one 2014 trigger nine days early, an earlier false alarm matched to the EA warning (+225 h); without it, it is level (+0.3 h). At a single p* = 0.5 the means are +8.4 / +8.4 / −14.6 / +8.2 h. We do not claim to beat the EA. <!-- src: proof.json tradeoff meanLeadVsOfficialH at warnAt (osney 0.3: 22.13, botley 0.6: -0.92, abingdonrd 0.2: 37.75, cherwell 0.3: 25.16) and at pStar 0.5 (8.38, 8.41, -14.58, 8.16); warnAt[spot].perEvent leadVsOfficialH, crossed floods with |h| < 72 h: 12 of 19 positive (as web/src/clock/story.ts proofSummary); abingdonrd e2014 225.06, the other five average 0.29 -->

In the **e2014** replay (at 50%), River Clock was ahead of the EA warning at Osney (+40.9 h) and Botley (+9.1 h), and behind at Abingdon Road (−34.9 h). The EA issued no Cherwell warning in that event. <!-- src: proof.json perEvent e2014 leadVsOfficialH 40.94, 9.06, -34.94 -->

**e2026 near miss:** no gauge crossed its threshold; New Botley peaked at 2.65 m, 11 cm under its 2.76 m line. River Clock's highest flood chance in the whole event was 29.9% (Botley, 15 Feb 2026), below every spot's warn-at level, so it raised **no false alarm** (nor at any trigger of 30% or more). At lower triggers it would have fired, which a resident at p* = 0.01 accepts by design. <!-- src: replays/e2026.json max pFlood botley 0.2994 (2026-02-15T12:00Z, warnAt 0.6), osney 0.2295 (0.3), abingdonrd 0.1202 (0.2), cherwell 0.0645 (0.3); observed newbotley peak 2.647 m; warnAt[spot].perEvent e2026 falseAlarms 0; perEvent e2026 crossed false at every spot -->

Pooled over our four gauges the model beats persistence at every lead on the test period, and its edge shrinks with lead time. Show the working says where it loses.

### What's next

**Rain forecasts (tested, not switched on).** River Clock only reads river and rain gauges, so it can't see rain that hasn't fallen. We tested adding real archived ECMWF rain forecasts (from Jan 2024 on, each from a run issued at least 6 h before the forecast). On that window, 72 h accuracy against the simple guess rose from **+11% to +28%**, and for the Nov 2024 flood Botley's first alarm came 29 h earlier, level with the EA. But it added **3 false alarms** (2 at Botley, 1 at Osney), Botley's flood odds scored worse at 48–72 h, and the window holds only one flood. That fails our own adoption rule, so the shipped model doesn't use it. Code: branch `model/rain-features`, issue #100. <!-- src: issue #100 results comment (honest window 72 h +0.114 -> +0.278; Botley FA 1 -> 3, Osney 0 -> 1; e2024b Botley lead vs EA -29.1 h -> -0.1 h) --> The next step is to train the model to distrust the forecast (to match its real errors) and add how wet the ground already is, so forecast rain on dry ground doesn't raise an alarm (research: [`docs/research/earlier-warnings.md`](docs/research/earlier-warnings.md), #134).

**A live gauge for the Cherwell again.** The Kings Mill gauge stopped sending readings on 13 Oct 2026. The EA gauge at Oxford Botanic Gardens (1490TH), 0.9 km downstream, is live and has history from 1996. It is already on the map. Using it as the Cherwell spot's gauge means a new model: it also rises when the Thames backs up from the confluence, so it needs Thames gauges as inputs, new travel times, a retrain and new replays. Too big a change for the night before the freeze (#146).

**Floods before 2006.** We train and replay from 2006, which is also when the EA's warning records start. Most of our gauges' records go back to the late 1980s or 1990s (Kings Mill from 1998), so earlier floods could add more events to learn from and test on. They could be scored against the simple baseline, but not against EA warnings.

**Ensemble and longer-range rain.** One forecast gives one answer; an ensemble (51 versions of the ECMWF forecast) shows how sure the weather is. The app already shows ensemble rain as context in Show the working, but the model doesn't read it: there is no free archive of past ensembles to train and test on honestly. Rain forecasts further ahead would be the only way to warn more than a day or two ahead.

---

## Spots and gauges

### The five trouble spots (`config/spots.yaml`)

| Spot | Gauge used | Threshold (m) | Normal top (m) | Mode | EA warning area | Evidence |
|---|---|---|---|---|---|---|
| Osney Island / Binsey | Minns Estate (stand-in, ~1.2 km west) | 2.90 | 2.13 | probability | 061FWF23BnsyOsny | good, proxy gauge |
| Botley Road / New Botley / Hinksey | New Botley | 2.76 | 2.01 | probability | 061FWF23NwBotley | strong |
| Abingdon Road / Grandpont | Cold Harbour (stand-in) | 2.44 | 2.30 | probability | 061FWF23NwBotley | strong |
| Wolvercote / Port Meadow | Godstow Lock downstream (live only) | 3.07 | 2.57 | timing only | 061FWF23Wlvrcote | weak: EA warnings only |
| Cherwell (Kings Mill) | Kings Mill upstream | 2.60 | 2.40 | probability | 061FWF14CherOxfd | moderate: paths and parks, no confirmed property flooding |

Thresholds are the EA's "property flooding is possible above this level" values from the GOV.UK station pages. "Normal top" is the top of the gauge's normal range, which we use as the amber line. Each value is in that gauge's own datum: don't compare them across rows. Every spot's map marker was checked to lie inside its EA warning area polygon.

### Gauges (`config/stations.yaml`)

| Gauge | River | Role | Used for |
|---|---|---|---|
| Farmoor | Thames | upstream | input for the three west and south Oxford targets |
| Eynsham Lock (upstream trace) | Thames | upstream | input, as a change from its own median |
| Cassington Weir B | Evenlode | upstream | input |
| Enslow Weir A | Cherwell | upstream | input for Kings Mill |
| Islip | Ray | upstream | input for Kings Mill |
| New Botley | Bulstake Stream | target (primary) | Botley spot |
| Minns Estate | Seacourt Stream | target | Osney spot (stand-in) |
| Cold Harbour | Hinksey Stream | target | Abingdon Road spot (stand-in) |
| Kings Mill (upstream) | Cherwell | target | Cherwell spot |
| Godstow Lock downstream | Thames | live only | Wolvercote spot: live level, no forecast |
| Osney Lock downstream | Thames | live only | River strip, context |
| Iffley Lock downstream | Thames | live only | River strip, context |

Rain gauges (EA tipping buckets): Osney Lock, Eynsham, Abingdon, Benson and Wheatley.

---

## Flood events (`config/events.yaml`)

All times UTC. Windows are analysis windows, not flood durations. Peaks are provisional EA Hydrology daily maxima, in each gauge's own datum.

| Event | Window | What happened | Peaks: New Botley / Minns / Cold Harbour / Kings Mill (m) |
|---|---|---|---|
| **e2007** July 2007 | 18 Jul – 2 Aug 2007 | Summer flood after very heavy rain on 20 Jul. Records at New Botley and Minns; homes flooded in Botley and Osney. | 3.141 / 3.117 / 2.690 / 2.575 |
| **e2012** Nov–Dec 2012 | 20 Nov 2012 – 5 Jan 2013 | Two peaks, about 27 Nov and about 27 Dec. Abingdon Road flooded in Nov. | 2.901 / 2.927 / 2.558 / 2.722 |
| **e2014** Jan–Feb 2014 (**headline replay**) | 20 Dec 2013 – 20 Feb 2014 | Main peak 6–9 Jan; Osney downstream record 3.97 m on 9 Jan. Abingdon Road closed on 8 Jan; Botley and Abingdon Roads closed again on 9 Feb. | 3.032 / 3.090 / 2.699 / 2.678 |
| **e2021** Jan–Feb 2021 | 20 Jan – 20 Feb 2021 | Three targets crossed their thresholds; Minns just touched 2.903 m. Barrier at Bulstake Close; no homes reported flooded. | 2.819 / 2.903 / 2.503 / 2.663 |
| **e2024a** Jan 2024 (Storm Henk) | 28 Dec 2023 – 15 Jan 2024 | Osney Island streets flooded on the evening of 4 Jan. Abingdon Road closed at about 21:30 GMT on 5 Jan. | 2.920 / 2.968 / 2.659 / 2.643 |
| **e2024b** Nov 2024 (Storm Bert) | 20 Nov – 5 Dec 2024 | Mainly a Cherwell flood: Kings Mill record 2.785 m on 27 Nov. Council reported no flooded properties. | 2.788 / 2.819 / 2.455 / 2.785 |
| **e2026** Jan–Mar 2026 | 15 Jan – 10 Mar 2026 | **Near miss.** High water for weeks (Osney downstream about 3.54 m on 16 Feb), but no trained gauge reached its threshold and no Oxford warning was issued. Our false-alarm test. | 2.657 / 2.742 / 2.120 / 2.291 |

The travel-time analysis also uses smaller rises it detects automatically (any period above the amber line with a clear peak). The backtest and replays use the seven named events above.

---

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

`make demo` also tries to download the optional offline basemap for the new map (`?map=gl`, `make tiles`); this needs `gh auth login`, and without it the demo still runs (default map) after a warning. `make fetch-data` downloads the cleaned river history from the GitHub release instead of the long `make data` download (needed only to rerun `make travel`, `make train` or `make backtest`), also with `gh`. The full checklist and fallbacks are in [`docs/demo-backup.md`](docs/demo-backup.md).

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
- **Not an official warning.** River Clock does not replace EA flood warnings and must not be used instead of them.

---

## Disclaimer

**Decision-support prototype, not an official warning. Check [gov.uk/check-flooding](https://www.gov.uk/check-flooding).** The same line is on every screen of the app.

---

## Team and how we worked

Four roles, each owning one part of the repo: **Data** (`pipeline/`, `config/stations.yaml`), **Model** (`analysis/`, `model/`), **App** (`web/`, `api/`) and **Story** (`config/spots.yaml`, `config/events.yaml`, this README). `SPEC.md` is the single source of truth, and the JSON shapes in SPEC §9 are the contract between teams.

Several people and several Claude Code sessions worked in the repo at once. To keep that sane:

- **A status board.** Each person or session has one file, `status/<name>.md`, on a separate `status` branch. Hooks show the whole board before every prompt and push a heartbeat after every reply, so everyone sees who is on what. `python3 scripts/status.py board` prints it.
- **GitHub issues as the task list.** An issue is claimed with an assignee and the `in-progress` label. Decisions between teams happen in issue comments (for example the re-target in #2 and #10).
- **ONBOARDING.md** gets a new session from clone to a claimed issue. **OBSERVER.md** describes a read-only observer role that follows the team's progress without changing anything.
- **Short branches and small PRs** (`data/…`, `model/…`, `app/…`, `story/…`), merged by another teammate. `main` always runs.

Team: one team of three, **s-s01s** (project manager and integration), **alfredo** and **adi**, each working with several Claude Code sessions coordinated through the status board.

Also built: the Tiger Data (Timescale) mirror of the hourly and live readings (#17, PR #63; see "Tiger Data mirror" above). There is no public deploy: the app runs locally and offline.

<!-- TODO at code freeze (Sun 25 Oct, 11:00 GMT): remove anything not built. -->
