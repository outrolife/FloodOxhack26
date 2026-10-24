# River Clock: demo script (4–5 minutes)

Judging is science-fair style: 4–5 minutes per judge, at our table. This script follows SPEC §17. It must work with **no network**.

All times here are UK local time. Judging is on **Sun 25 Oct 2026, after the clocks went back at 02:00**, so the app and this script are on **GMT (= UTC)**. Past events are labelled with their own zone (Jan 2014 is GMT).

<!-- Every number below comes from committed JSON (src comments next to each). If the data is regenerated, re-check them before rehearsal. Never say a number we haven't computed. -->

Everything in this script is now real data on main: travel times, data coverage, all seven replays (PR #39, PR #66), `proof.json` (PR #66), live mode and Tiger Data. If a tab still shows "sample data", the build is out of date: say so, use the fallback line, and move on.

---

## Before each judging slot (2 minutes)

1. Laptop on mains power. Wi-Fi **off** (we demo offline; turn it on only for step 5 if the live API is running).
2. `make web` already running; browser at http://localhost:5173, zoomed to fit, on the **River** tab.
3. **Check for the "sample data" notice.** If any tab shows "Showing sample data (test fixtures)", that tab is not real results. Either skip that tab or say clearly: "this tab is showing our test fixture, not results."
4. Time Machine: e2014 selected, slider at the start, spot **Botley Road**.
5. Decide: preset **Resident**.
6. Have the one-line spot facts ready (cheat sheet below).

---

## Short versions

### 30 seconds (judge in a hurry, or the laptop is down)

No clicks needed.

"Oxford floods from the river, slowly, so the flood is already upstream a day before it arrives. We measured how long: from Cassington on the Evenlode to New Botley takes about nine and a half hours, over 24 past floods, and Enslow to Kings Mill on the Cherwell about 19. River Clock uses those travel times to give five Oxford trouble spots a chance of flooding and an arrival time over the next 72 hours, and it's scored against a 'nothing changes' baseline so we can't fool ourselves. Replaying the 2014 flood, it reached 50% for Botley Road seven hours before the EA's flood warning. It's a decision-support prototype, not an official warning."

<!-- src: web/public/data/travel_times.json (9.5 h n 24; 18.6 h n 6); web/public/data/replays/e2014.json (50% at 2014-01-04T12:00Z, EA warning 19:03Z) -->

### 2 minutes (one tab each, no Q&A)

1. **River (30 s).** The hook line, then point at the Cassington → New Botley link: "about 9½ hours, over 24 floods". Point at the disclaimer banner.
2. **Data first (20 s).** "In the first hour we checked the data and found the Osney Lock flood gauge has no public history on its flood side. So we switched to gauges whose history matches their thresholds, and say so on screen."
3. **Time Machine (40 s).** Play e2014 for a few seconds and pause at our 50% marker: "noon on 4 January, about 7 hours before the EA's flood warning, and 37 hours before the gauge crossed its threshold." <!-- src: web/public/data/replays/e2014.json -->
4. **Proof (20 s).** "Above zero means we beat 'the level stays where it is'. We do at every lead: +0.39 at 6 hours, falling to +0.11 at 72. Against the EA it's mixed: we're earlier at Osney and the Cherwell, they're earlier at Botley and Abingdon Road." <!-- src: web/public/data/proof.json skillByLead; tradeoff meanLeadVsOfficialH at pStar 0.5 -->
5. **Close (10 s).** "One finding, one model, one baseline, honest proof. Not an official warning; a clock you can read."

---

## The walkthrough

### 0:00–0:20 · Hook (no clicks)

**Say:** "Oxford floods from the river, slowly. The water that floods Botley Road on Thursday is usually already in the Thames at Farmoor on Tuesday. River Clock reads the gauges upstream like a clock and tells you how likely each of five Oxford spots is to flood in the next 72 hours, and when."

**Point at:** the banner. "It's a decision-support prototype, not an official warning. The banner is on every screen."

### 0:20–1:00 · Step 1: River strip, "the water is already on its way"

**Click:** River tab (already open). Point at the river strip on the right, then the map.

**Say:**
- "This is the river as a chain of gauges: Farmoor, Eynsham and Cassington on the Thames side, Enslow and Islip on the Cherwell. Each link shows how long a flood wave takes to travel it, measured from past Oxford floods."
- **Point at the Cassington → New Botley link:** "From Cassington on the Evenlode to New Botley, the rise takes about nine and a half hours. That's the median over 24 past floods." <!-- src: web/public/data/travel_times.json, cassington→newbotley tHalf.median 9.5 h, n 24 -->
- **Point at the Enslow → Kings Mill link:** "On the Cherwell, Enslow to Kings Mill is about 19 hours, and it's steady: 15 to 23 hours across 6 floods." <!-- src: travel_times.json, enslow→kingsmill tHalf median 18.6 h, p10 15.0, p90 22.8, n 6 -->
- **Don't quote** Farmoor → New Botley (no clean floods: "cross-correlation only") or Eynsham → New Botley (only 3 floods, under 1 h). If a judge points at them: "Those two links don't have enough clean floods, so the app labels them, and we don't lean on them."
- "Those travel times choose which past hours of each upstream gauge the model looks at."
- "One thing we found in the first hour: the Osney Lock gauge we planned to forecast has no usable public history on its flood side. So we switched to gauges whose history matches their flood thresholds. Osney Island uses the Minns Estate gauge, about 1.2 km west, as a stand-in, and we checked it against residents' flood reports."

**Fallback:** if the map tiles are blank (offline): "The map tiles need the internet; the spots and gauges are all still here." If the strip shows no travel times: "The travel-time numbers are on the Proof tab; let me show you there," and do step 4's travel-time chart instead.

### 1:00–2:30 · Step 2: Time Machine on January 2014 (real replay, PR #39)

**Click:** Time Machine tab. Event **Jan–Feb 2014**, spot **Botley Road** (gauge New Botley). Press **Play**.

**Say, while it plays:**
- "This replays the 2014 flood, a forecast every two hours. At each moment the model only sees what was known then. Tests check that nothing from the future leaks in."
- "The shaded fan is the forecast range, 5 to 95 percent. Watch it narrow as the upstream water arrives."
- **At the River Clock ≥ 50% marker** (pause here): "Here River Clock says there's a 50% chance Botley floods. That's noon on Saturday 4 January. And it says the 50% point arrives at about 1 in the morning on Monday the 6th. The gauge crossed its threshold at 1 am on the 6th." <!-- src: web/public/data/replays/e2014.json: first botley pFlood >= 0.5 at 2014-01-04T12:00Z (0.63 at 48/72 h); that forecast's arrival.p50 2014-01-06T01:01Z; crossings botley 2014-01-06T01:00Z -->
- **At the official-warning marker:** "And here, just after 7 that evening, the Environment Agency issued its flood warning for this area: about 7 hours after us." <!-- src: replays/e2014.json official botley warning 2014-01-04T19:03:30Z. proof.json perEvent.leadVsOfficialH (PR #66) gives the official figure per p*; if it disagrees, use it. -->
- **If a judge asks about the earlier marker:** "That's the EA's Flood Alert, the lower level, on 23 December. It came before our first 10%. We're ahead of the warning, not the alert." <!-- src: replays/e2014.json official botley alert 2013-12-23T19:27:31Z; first pFlood >= 0.1 at 2013-12-25T22:00Z -->
- **Play on to the peak:** "The real peak, 3.03 metres at New Botley at 9 in the morning on 9 January, lands inside the forecast band, from every forecast 6 to 72 hours ahead." <!-- src: replays/e2014.json: hourly-mean peak 3.027 m at 2014-01-09T09:00Z (3.032 m 15-min max, docs/tiger-data.md); observed at 08:00/10:00 inside q05–q95 for every lead 6–72 h -->
- "You can see the clock in the raw data too: in this flood Cassington peaked three and a half days before New Botley, and Farmoor a bit over a day before." <!-- src: docs/tiger-data.md query b: 84 h, 28 h -->
- "The model used for this replay was trained without this flood. With so few floods it may have seen later ones, like 2024. Strict time-split results are on the Proof tab."

**Fallback:** if the replay won't play or shows sample data: "The real replay isn't loading, so this is our test fixture. In the real one, we hit 50% at noon on 4 January, 7 hours before the EA's warning." Then move on quickly. If Play stutters, drag the slider by hand.

### 2:30–3:15 · Step 3: Decide

**Click:** Decide tab. Start on **Resident**, then switch to **Commuter**, then **Council**.

**Say:**
- "Forecasts only help if they change what you do. If acting costs C and getting caught out costs L, it's worth acting once the chance of flooding is above C over L."
- "A resident moving their car: £20 against £2,000 of damage, so act at 1%. A commuter rerouting: £5 against £100, act at 5%. The council closing a road: £5,000 against £100,000, also 5%." (The bars update instantly when you switch.)
- "The bars are the expected cost over the past floods for River Clock at that trigger, the official warnings, never acting and always acting." Point at the lowest bar and read it off the chart; don't guess it in advance.
- If asked what's behind the bars: "At a 50% trigger, River Clock caught every flood in the replays at all four forecast spots, with 2 false alarms at Osney, 3 at Botley and none at Abingdon Road or the Cherwell. The EA's Flood Warning, scored the same way, missed 3 at Osney, 2 at Botley, 1 at Abingdon Road and 4 at the Cherwell." <!-- src: web/public/data/proof.json tradeoff pStar 0.5; officialOutcome -->
- "And for today: 'at your costs, act when P is at least X%. Now it's Y%.'"

**Fallback:** if the live advice line says "Live data unavailable", say: "There's no live feed here, so the advice uses no current reading. The cost comparison is from the replays and works offline."

### 3:15–4:15 · Step 4: Proof

**Click:** Proof tab.

**Say:**
- **Skill chart:** "This is the honest test. Our baseline is 'the level stays roughly where it is'. Above zero means we beat it. It's scored on forecasts from October 2021 on, which the models never saw. We beat it at every lead: +0.39 at 6 hours, +0.27 at 24, +0.11 at 72. The edge shrinks with lead time, as you'd expect: beyond the travel times, the water hasn't reached the upstream gauges yet." <!-- src: web/public/data/proof.json skillByLead; testPeriodNote -->
- **Reliability diagram:** "When we say 30%, does it flood about 30% of the time? Points on the diagonal mean yes. Look at the counts: most middle bins have only a handful of forecasts. At long leads our near-certain forecasts are too confident. At Botley, 72-hour forecasts of about 99% came true 44% of the time, so we're too sure that high water stays high." <!-- src: web/public/data/proof.json reliability botley h72 top bin pPred 0.995, pObs 0.44, n 125 -->
- **Coverage:** "Our ranges are too wide, not too narrow. The 90% range holds the outcome 94 to 97% of the time, and the 50% range 65 to 78%. That's the safe direction, but it means we could be sharper." <!-- src: web/public/data/proof.json coverage: nominal 0.9 actual 0.938-0.969; nominal 0.5 actual 0.647-0.781 -->
- **e2026 near miss:** "Last winter the river was high for weeks, but no gauge reached its threshold and the EA issued no Oxford warning. That's our false-alarm test. River Clock's highest chance all winter was 28%, at Botley on 15 February, so at any trigger of 30% or more it raised no false alarm." <!-- src: web/public/data/replays/e2026.json max pFlood 0.2767 at 2026-02-15T14:00Z; proof.json perEvent e2026 crossed false for every spot -->
- **Travel-time chart** (if time, real data): "Each dot is one past flood. The spread is wide, so the model looks at each upstream gauge over a range of lags, not one fixed lag. Bigger rises don't clearly travel faster here." <!-- src: travel_times.json, tHalf p10–p90 and slopeHoursPerMetre (small, sign changes across pairs) -->
- **Data-quality table** (if asked): "Nine gauges with history from 2006, 91 to 99.8% of hours covered. The lock gauges have 0.7%: that's the gap we found in the first hour." <!-- src: web/public/data/quality.json coveragePct -->

**Fallback:** if Proof shows sample data (an old build): "This build is showing our test fixture. The real numbers: skill +0.39 at 6 hours down to +0.11 at 72, and our 90% ranges hold 94 to 97%." Then show the travel-time chart. For the scores, say: "We'd rather show you nothing than a made-up number," and go to step 5.

### 4:15–4:45 · Step 5: Live, today's Oxford

**Click:** River tab.

**Say (live API running and online):** "This is today: the latest EA readings, at most 15 minutes old. Kings Mill on the Cherwell has sent nothing since 13 October, so it's shown as stale and the Cherwell spot has no live forecast. We'd rather say 'no forecast' than guess."

**Say (offline, the expected case at the table):** "We're offline, so the River tab says 'Live data unavailable' and shows the last saved forecast with its issue time. Online, it polls the EA every 15 minutes. A full refresh is 17 requests and takes about 30 seconds; we cut it from over 3 minutes by running 4 requests at a time." <!-- src: PR #62, 199.8 s → 28.5 s -->

**If the forecast is labelled "persistence":** "Live mode falls back to the persistence baseline when the trained models aren't loaded, and it says so on screen."

**Point at:** Wolvercote marker (grey): "Wolvercote's gauge has no history, so we show its live level against the threshold and say 'no forecast'."

### 4:45–5:00 · Close

**Say:** "One finding, one model, one baseline, honest proof, and a decision rule. It's not an official warning; it's a clock you can read. Thanks. Any questions?"

---

## If something breaks

| Problem | What to do |
|---|---|
| App won't start | `cd web && npm run dev`. If that fails, `npm run build && npm run preview` (serves the built app on port 4173). |
| A tab shows "sample data" | Say so. Don't present fixture numbers as results. |
| Map tiles blank | Expected offline. Spots and gauges still show. |
| "Live data unavailable" | Expected offline. Use the step 5 offline line. |
| Times look one hour off | Check the zone label. After 02:00 Sun the app shows GMT; Jan events are GMT anyway. |
| Out of time | Cut step 5, then the travel-time chart. Never cut the disclaimer or the e2026 near miss. |

---

## What to say if a number looks bad

Say the number, then say why. Never hide it, never round it up.

| What the judge sees | What to say |
|---|---|
| Skill only +0.11 at 72 h | "It's still above zero, but the edge shrinks with lead time. Beyond the longest travel time the water hasn't reached the upstream gauges yet, and we don't use rain forecasts, so there's little to go on. Rain forecasts are our first next step." |
| Coverage above nominal (the 90% range holds 94–97%) | "Our ranges are too wide: conservative. With only seven floods the calibration is rough, and we'd rather be too wide than too narrow. The app flags any gap over 10 points." |
| Reliability: near-certain forecasts at 72 h came true 44% of the time (Botley) | "At long leads we're too sure that high water stays high; the river often starts to fall within three days. And look at the counts: most middle bins have only a handful of forecasts." |
| Abingdon Road Brier score worse than persistence from 24 h | "Yes. At Abingdon Road (the Cold Harbour stand-in gauge) the probability forecast is slightly worse than persistence from 24 hours on (0.0014 vs 0.0012 at 24 h). The Proof tab shows it." |
| EA warning earlier than River Clock (Botley −5.1 h, Abingdon Road −13.8 h at p* = 0.5) | "Then the EA was ahead of us, and that's fine. They have forecasters and more data. A lower trigger, 20%, is earlier than the EA at every spot, but with more false alarms. We add a probability and a time per spot; we don't replace them." |
| False alarms at p* = 0.5 (Osney 2, Botley 3) | "That's over seven replayed events. Abingdon Road and the Cherwell had none. The EA's own warnings, scored the same way, had 1 to 3 per spot." |
| Cherwell mean lead only 9.3 h | "The Cherwell gives the least warning of our four spots. We're still earlier than the EA there, by about 9 h on average." |
| e2026 would fire at a low trigger | "Yes: the highest chance was 28%, so a resident with a 1% trigger would have moved their car. That costs £20, and it's what a low trigger is for." |
| Eynsham → New Botley under 1 h | "Only 3 clean floods for that pair, one at 0 h. We don't trust it and don't quote it; its peak-to-peak time is 8 h." |
| Farmoor → New Botley "cross-correlation only" | "No clean floods matched for that pair, so it falls back to the lag where the two gauges' rises line up best, about 5 h, and the app labels it." |
| Wide travel-time ranges (e.g. 1–42 h) | "Floods differ: rain falls in different places and the side streams split the flow. That's why the model looks at several lags per gauge, not one." |
| Cassington, Islip coverage 91–93% | "The EA marks some readings suspect or rejected, and we drop them rather than guess. Missing stays missing." |

<!-- src: web/public/data/proof.json (skillByLead, coverage, reliability, tradeoff, officialOutcome), web/public/data/replays/e2026.json, web/public/data/travel_times.json, web/public/data/quality.json -->

---

## Judge Q&A cheat sheet

Short, honest answers. If we don't know, say "we don't know" and say what we'd check.

**Why not an LSTM or a foundation model?**
Oxford has about seven big flood events since 2007. A deep sequence model would need far more floods to learn from, and would be hard to explain. Gradient-boosted quantile models are a strong, well-tested choice for river forecasting with small data (top entries in the DrivenData Water Supply Forecast Rodeo used them), they train in minutes, and we can show which inputs matter. One model, done carefully, beats two done badly.

**Why compare against persistence?**
"The level stays where it is" is the simplest honest forecast, and rivers change slowly, so it's a strong rival. If we can't beat it, the model isn't worth using. We do beat it at every lead (+0.39 at 6 h, +0.11 at 72 h), but the edge shrinks as the lead grows. <!-- src: web/public/data/proof.json skillByLead --> The Proof tab says plainly where we do and don't beat it.

**How do you avoid leakage?**
Every input is computed only from data up to the forecast time, and a test changes the future data and checks that no input changes (`tests/test_features.py`). Each replay uses a model trained without that flood (plus 7 days either side). And a second test checks that replay forecasts don't change when data after their issue time changes (`tests/test_backtest.py`). <!-- src: PR #39, merged --> The one caveat: a replay of 2014 can use a model that saw 2024. Strict time-split results (test period from Oct 2021) are reported separately.

**What's conformal calibration?**
After training, we look at how far off the model's ranges were on held-out flood periods, and widen or narrow them so a 90% range really contains the outcome about 90% of the time. It's a simple correction with a guarantee under mild assumptions.

**What if a gauge is stale or broken?**
A gauge with no reading for more than 3 hours is marked stale, and any spot that depends on it gets no forecast, not a guess. Kings Mill has been offline since 13 Oct 2026, so the Cherwell spot has no live forecast right now. Missing values stay missing in the model; we don't invent them.

**Why use Minns Estate for Osney Island?**
The Osney Lock flood gauge (downstream) has no public history before Oct 2025, and the upstream side is held flat by the weir. Minns Estate is the nearest gauge with long history on the same trace as its threshold, about 1.2 km west on the Seacourt Stream. We checked it against residents' reports: above 2.90 m in 2007, 2014 and Jan 2024, when Osney flooded; below in the quiet winters of 2023 and 2026. 2021 touched 2.903 m with no homes flooded, so it's a borderline case. It's a stand-in, and the app says so.

**Why does Wolvercote have no forecast?**
Its gauge, Godstow Lock downstream, has the same problem as Osney: no history. We show its live level against the 3.07 m threshold and say "no forecast: no gauge history".

**The clocks went back last night. Did that break anything?**
Everything is stored and computed in UTC. The app converts to UK time only for display and shows the zone (BST or GMT). The EA's historic warnings come in UK local time with a repeated hour each autumn; we convert them to UTC, and there's a test for timestamps across the 25 Oct change.

**Why river level and not flow?**
The EA says the high-flow ratings at several of our upstream gauges (Farmoor, Enslow, Cassington, Islip) are unreliable. Level is what's measured. We never compare levels between gauges, because each has its own datum; we use each gauge's change from its own median.

**Doesn't rain matter?**
Yes. The model uses rain that has already fallen (EA rain gauges over the last 6 h to 21 days). It does not use rain forecasts, so heavy rain still to come isn't in the forecast. That's the first thing we'd add next.

**How good are the thresholds?**
They're the EA's "property flooding is possible" levels from the GOV.UK station pages. We checked each against dated reports: news, council updates, residents' newsletters and EA warnings. Botley and Abingdon Road are strong. Cherwell at Kings Mill is moderate: we found paths, parks and a pub flooded, but no confirmed homes.

**How many floods is the proof based on?**
Seven events from 2007 to 2026, including one near miss (2026). Counting repeat peaks at least 72 h apart as separate floods, that's 7 or 8 floods per spot (2014 had two, in January and February). That's few, so we show 90% bootstrap intervals for event-level numbers. Skill and coverage use every forecast issued from October 2021 on, which no model saw. <!-- src: web/public/data/proof.json tradeoff hits+misses at pStar 0.5 = 7/8/8/7; testPeriodNote --> For travel times we also use smaller rises the analysis detects itself: up to 24 clean floods per pair. <!-- src: travel_times.json n -->

**Are you better than the EA warnings?**
We compare lead times against the EA's first warning for each spot's area, using their official issue times. In the 2014 replay for Botley Road we reached 50% about 7 hours before the EA's Flood Warning, but their lower-level Flood Alert came days before our first 10%. <!-- src: replays/e2014.json --> Across all seven events at a 50% trigger it's mixed: on average we're earlier than the EA's warning at Osney (+2.9 h) and the Cherwell (+9.2 h), and later at Botley (−5.1 h) and Abingdon Road (−13.8 h). In 2014 we were ahead at Osney (+20.9 h) and Botley (+7.1 h) but behind at Abingdon Road (−34.9 h). <!-- src: web/public/data/proof.json tradeoff meanLeadVsOfficialH pStar 0.5; perEvent e2014 --> Either way, River Clock is not a replacement. The EA has forecasters, more data and a legal duty. We add a probability and a time per street.

**Why not use the Botley Road closures as evidence?**
Botley Road was closed for the railway bridge works from April 2023 to September 2026, so a closure in that period tells you nothing about flooding. We used none.

**How does the Decide tab work?**
If acting costs C and not acting when it floods costs L, act when the chance of flooding is above C / L. We count each hit or false alarm as costing C and each miss as costing L over the past floods, and compare River Clock, the official warnings, never acting and always acting.

**How did you work as a team with AI agents?**
Each person ran Claude Code sessions in parallel. A shared status board on its own git branch shows every session who's doing what before each prompt. GitHub issues are the task list, with claim labels. JSON contracts with sample files let the app be built before the model existed. An observer session watched progress without changing code.

**What does Tiger Data do for you?**
It holds a SQL copy of everything: 3.29 million hourly rows over 21 river and rain series, 2006 to today, plus the live readings, in a Timescale hypertable with a daily rollup. Compression took it from 434 MB to 35 MB. One query shows the clock idea: in Jan 2014 the upstream gauges peaked 84, 28 and 9 hours before New Botley. The app doesn't depend on it, so the demo still runs offline. <!-- src: docs/tiger-data.md -->

**Why is the Eynsham → New Botley link under an hour?**
Only 3 clean floods matched for that pair, and one of them came out at 0 h. We don't trust it, and we don't quote it. Its peak-to-peak time is 8 h. <!-- src: travel_times.json eynsham→newbotley n 3, tHalf median 0.6, tPeak median 8.0 -->

**What would you do with another week?**
Add forecast rainfall; ask the EA for the downstream lock histories so Osney can be forecast directly; check thresholds street by street with residents and the council.
