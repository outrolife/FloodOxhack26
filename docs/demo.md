# River Clock: demo script (4–5 minutes)

Judging is science-fair style: 4–5 minutes per judge, at our table. This script follows SPEC §17. It must work with **no network**.

All times here are UK local time. Judging is on **Sun 25 Oct 2026, after the clocks went back at 02:00**, so the app and this script are on **GMT (= UTC)**. Past events are labelled with their own zone (Jan 2014 is GMT).

<!-- RESULTS: every "__" below must be filled from the real JSON (proof.json, replays/e2014.json, travel_times.json) before rehearsal. If a number isn't there, cut the line. Never say a number we haven't computed. -->

---

## Before each judging slot (2 minutes)

1. Laptop on mains power. Wi-Fi **off** (we demo offline; turn it on only for step 5 if the live API is running).
2. `make demo` already running (offline, one process; see `docs/demo-backup.md`); browser at http://127.0.0.1:8080, zoomed to fit, on the **River** tab. `make preflight` shows only ✅/ℹ️.
3. **Check for the "sample data" notice.** If any tab shows "Showing sample data (test fixtures)", that tab is not real results. Either skip that tab or say clearly: "this tab is showing our test fixture, not results."
4. Time Machine: e2014 selected, slider at the start, spot **Botley Road**.
5. Decide: preset **Resident**.
6. Have the one-line spot facts ready (cheat sheet below).

---

## The walkthrough

### 0:00–0:20 · Hook (no clicks)

**Say:** "Oxford floods from the river, slowly. The water that floods Botley Road on Thursday is usually already in the Thames at Farmoor on Tuesday. River Clock reads the gauges upstream like a clock and tells you how likely each of five Oxford spots is to flood in the next 72 hours, and when."

**Point at:** the banner. "It's a decision-support prototype, not an official warning. The banner is on every screen."

### 0:20–1:00 · Step 1: River strip, "the water is already on its way"

**Click:** River tab (already open). Point at the river strip on the right, then the map.

**Say:**
- "This is the river as a chain of gauges: Farmoor, Eynsham and Cassington on the Thames side, Enslow and Islip on the Cherwell. Each link shows how long a flood wave takes to travel it, measured from past Oxford floods. From Farmoor to New Botley it's about __ hours." <!-- RESULTS: travel_times.json, tHalf.median -->
- "Those travel times choose which past hours of each upstream gauge the model looks at."
- "One thing we found in the first hour: the Osney Lock gauge we planned to forecast has no usable public history on its flood side. So we switched to gauges whose history matches their flood thresholds. Osney Island uses the Minns Estate gauge, about 1.2 km west, as a stand-in, and we checked it against residents' flood reports."

**Fallback:** if the map tiles are blank (offline): "The map tiles need the internet; the spots and gauges are all still here." If the strip shows no travel times: "The travel-time numbers are on the Proof tab; let me show you there," and do step 4's travel-time chart instead.

### 1:00–2:30 · Step 2: Time Machine on January 2014

**Click:** Time Machine tab. Event **Jan–Feb 2014**, spot **Botley Road** (gauge New Botley). Press **Play**.

**Say, while it plays:**
- "This replays the 2014 flood hour by hour. At each moment the model only sees what was known then. Tests check that nothing from the future leaks in."
- "The shaded fan is the forecast range, 5 to 95 percent. Watch it narrow as the upstream water arrives."
- **At the River Clock ≥ 50% marker** (pause here): "Here River Clock says there's a 50% chance Botley floods. That's __ on __ January." <!-- RESULTS: replay, first forecast with pFlood >= 0.5 at any lead -->
- **At the official-warning marker:** "And here the Environment Agency issued its flood warning for this area." Say the difference only as the app shows it: "__ hours earlier / later than us." <!-- RESULTS: perEvent.leadVsOfficialH. If River Clock is later, say so plainly: "Here the EA was ahead of us." -->
- **Play on to the peak:** "The real peak, 3.03 metres at New Botley on 9 January, lands inside the forecast band." <!-- RESULTS: confirm the observed peak is inside the 5–95% band from the forecast shown; if not, say where it fell -->
- "The model used for this replay was trained without this flood. With so few floods it may have seen later ones, like 2024. Strict time-split results are on the Proof tab."

**Fallback:** if the replay won't play or shows sample data: "The real replay isn't loading, so this is our test fixture. What it shows is the idea: forecast fan, our 50% marker, the EA warning marker." Then move on quickly. If Play stutters, drag the slider by hand.

### 2:30–3:15 · Step 3: Decide

**Click:** Decide tab. Start on **Resident**, then switch to **Commuter**, then **Council**.

**Say:**
- "Forecasts only help if they change what you do. If acting costs C and getting caught out costs L, it's worth acting once the chance of flooding is above C over L."
- "A resident moving their car: £20 against £2,000 of damage, so act at 1%. A commuter rerouting: £5 against £100, act at 5%. The council closing a road: £5,000 against £100,000, also 5%." (The bars update instantly when you switch.)
- "The bars are the expected cost over the past floods for River Clock at that trigger, the official warnings, never acting and always acting." Point at the lowest bar and say what it is. <!-- RESULTS: say which strategy is cheapest for each preset, only from the chart -->
- "And for today: 'at your costs, act when P is at least X%. Now it's Y%.'"

**Fallback:** if the live advice line says "Live data unavailable", say: "There's no live feed here, so the advice uses no current reading. The cost comparison is from the replays and works offline."

### 3:15–4:15 · Step 4: Proof

**Click:** Proof tab.

**Say:**
- **Skill chart:** "This is the honest test. Our baseline is 'the level stays roughly where it is'. Above zero means we beat it. At 24 hours our skill is __; at 72 hours __." <!-- RESULTS: skillByLead. If skill is ≤ 0 at some lead, say: "At __ hours we don't beat the baseline, and the app says so." -->
- **Reliability diagram:** "When we say 30%, does it flood about 30% of the time? Points on the diagonal mean yes." <!-- RESULTS: one-sentence read of the diagram; mention the small counts -->
- **Coverage:** "Our 90% ranges hold the outcome __% of the time." <!-- RESULTS: coverage; the UI flags gaps over 10 points -->
- **e2026 near miss:** "Last winter the river was high for weeks, but no gauge reached its threshold and the EA issued no Oxford warning. That's our false-alarm test. River Clock __." <!-- RESULTS: perEvent for e2026: did any spot trigger at p* = 0.5? -->
- **Travel-time chart** (if time): "Bigger upstream rises tend to travel __." <!-- RESULTS: slopeHoursPerMetre; skip if weak -->

**Fallback:** if Proof shows sample data: "The full scores are still being computed. This layout is what you'll see; here's the one number we have: __." If we have no real number, say: "We'd rather show you nothing than a made-up number," and go to step 5.

### 4:15–4:45 · Step 5: Live, today's Oxford

**Click:** River tab.

**Say (live API running and online):** "This is today: the latest EA readings, at most 15 minutes old. Kings Mill on the Cherwell has sent nothing since 13 October, so it's shown as stale and the Cherwell spot has no live forecast. We'd rather say 'no forecast' than guess."

**Say (offline, the expected case at the table):** "We're offline, so the River tab says 'Live data unavailable' and shows the last saved forecast with its issue time. Online, it polls the EA every 15 minutes."

**If the forecast is labelled "persistence":** "Live mode falls back to the persistence baseline when the trained models aren't loaded, and it says so on screen."

**Point at:** Wolvercote marker (grey): "Wolvercote's gauge has no history, so we show its live level against the threshold and say 'no forecast'."

### 4:45–5:00 · Close

**Say:** "One finding, one model, one baseline, honest proof, and a decision rule. It's not an official warning; it's a clock you can read. Thanks. Any questions?"

---

## If something breaks

| Problem | What to do |
|---|---|
| App won't start | See `docs/demo-backup.md` plan B: check out the last `demo-ready-*` tag and `make demo`, or `cd web && npm run preview` (port 4173). |
| A tab shows "sample data" | Say so. Don't present fixture numbers as results. |
| Map tiles blank | Expected offline. Spots and gauges still show. |
| "Live data unavailable" | Expected offline. Use the step 5 offline line. |
| Times look one hour off | Check the zone label. After 02:00 Sun the app shows GMT; Jan events are GMT anyway. |
| Out of time | Cut step 5, then the travel-time chart. Never cut the disclaimer or the e2026 near miss. |

---

## Judge Q&A cheat sheet

Short, honest answers. If we don't know, say "we don't know" and say what we'd check.

**Why not an LSTM or a foundation model?**
Oxford has about seven big flood events since 2007. A deep sequence model would need far more floods to learn from, and would be hard to explain. Gradient-boosted quantile models are a strong, well-tested choice for river forecasting with small data (top entries in the DrivenData Water Supply Forecast Rodeo used them), they train in minutes, and we can show which inputs matter. One model, done carefully, beats two done badly.

**Why compare against persistence?**
"The level stays where it is" is the simplest honest forecast, and rivers change slowly, so it's hard to beat at short lead times. If we can't beat it, the model isn't worth using. The Proof tab says plainly where we do and don't beat it.

**How do you avoid leakage?**
Three ways. Every input is computed only from data up to the forecast time, and a test changes the future data and checks that no input changes. Each replay uses a model trained without that flood (plus 7 days either side). And a second test checks that replay forecasts don't change when data after their issue time changes. <!-- TODO: confirm the replay leakage test is merged (SPEC §15.6; model/backtest.py, #8/#11). If not, drop this sentence. --> The one caveat: a replay of 2014 can use a model that saw 2024. Strict time-split results (test period from Oct 2021) are reported separately.

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
Seven events from 2007 to 2026, including one near miss (2026) and any extra floods the backtest detects automatically. That's few, so we show 90% bootstrap intervals for event-level numbers. <!-- RESULTS: say the actual n from proof.json -->

**Are you better than the EA warnings?**
We compare lead times against the EA's first warning for each spot's area, using their official issue times. <!-- RESULTS: say the honest answer from proof.json --> Either way, River Clock is not a replacement. The EA has forecasters, more data and a legal duty. We add a probability and a time per street.

**Why not use the Botley Road closures as evidence?**
Botley Road was closed for the railway bridge works from April 2023 to September 2026, so a closure in that period tells you nothing about flooding. We used none.

**How does the Decide tab work?**
If acting costs C and not acting when it floods costs L, act when the chance of flooding is above C / L. We count each hit or false alarm as costing C and each miss as costing L over the past floods, and compare River Clock, the official warnings, never acting and always acting.

**How did you work as a team with AI agents?**
Each person ran Claude Code sessions in parallel. A shared status board on its own git branch shows every session who's doing what before each prompt. GitHub issues are the task list, with claim labels. JSON contracts with sample files let the app be built before the model existed. An observer session watched progress without changing code.

**What would you do with another week?**
Add forecast rainfall; ask the EA for the downstream lock histories so Osney can be forecast directly; check thresholds street by street with residents and the council.
