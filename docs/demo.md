# River Clock: demo script (4 minutes)

Judging is science-fair style: about 4 minutes per judge, at our table. The app has **four screens: Now · Replay · Protect · How good is it?** It must work with **no network**.

All times are UK local time. Judging is on **Sun 25 Oct 2026, after the clocks went back at 02:00**, so the app and this script are on **GMT (= UTC)**. January events are GMT too.

<!-- Every number below is read from committed JSON on main; the src comment beside each says where. If `make train backtest` runs again (#125, cut-off 03:00 GMT), re-check each src before rehearsal. The screens read their numbers at runtime, so they follow the data; this script doesn't. Never say a number we haven't computed. -->

---

## Presenter keys

| Key | Does |
|---|---|
| **1 · 2 · 3 · 4** | Now · Replay · Protect · How good is it? |
| **Space** | Play / pause the replay |
| **← / →** | Step the replay one forecast (**Shift**: 6 steps) |
| **P** | Presenter mode: bigger type, no chrome |

Each screen's details live behind **Show the working** (the old charts, tables, cost–loss calculator and data quality). Use it only when a judge asks.

## Before each judging slot (1 minute)

1. Laptop on mains. Wi-Fi **off**. `make demo` running (see `docs/demo-backup.md`); `make preflight` shows only ✅/ℹ️.
2. Open **http://127.0.0.1:8080/#/replay** in a **fresh tab** (the replay auto-plays on the first visit in a tab). Event **January 2014**, spot **Botley Road**. Press **P**.
3. If it has already played: press **Space** to pause, then **Shift+←** until the date reads about **1 Jan 2014, 12:00**. From there at 1× the 50% row fills at about 12 s, the EA warning at 13 s, the crossing at 20 s and the peak at about 32 s, then it stops.

---

## The 4-minute walkthrough

Spoken words are in quotes: about 520 in total, so it fits 4:00 at a calm pace with room for one click each.

### 0:00–1:00 · Replay (press 2): the hero

**Do:** let it play. Point at the scoreboard rows as they fill in. Don't explain the chart yet.

> "This is Botley Road in January 2014, replayed hour by hour. The model sees only what was known at each moment, and was trained without this flood.
>
> Noon on Saturday 4 January: River Clock says Botley Road is more likely than not to flood. The Environment Agency's flood warning came seven hours later. The river crossed the flood line at 1 am on Monday, 37 hours after our call. And the peak, 3.03 metres, landed inside the range we gave three days before.
>
> How? Oxford floods slowly, from upstream: on the Cherwell, a rise at Enslow reaches Kings Mill about 19 hours later. River Clock reads the upstream gauges like a clock and makes a prediction: the chance of flooding, and when, for five Oxford spots, three days ahead. Then the decision: is it worth acting yet?
>
> That's one flood. Over all our replays the EA is sometimes earlier than us, and the app shows where. It's a student prototype, not an official warning."

<!-- src: web/public/data/replays/e2014.json: botley first pFlood >= 0.5 at issuedAt 2014-01-04T12:00:00Z (0.59 at 72 h); official botley warning 2014-01-04T19:03:30Z; crossings botley 2014-01-06T01:00:00Z (37 h after 12:00 on 4 Jan); observed newbotley peak 3.027 m at 2014-01-09T09:00:00Z; forecast issued 72 h before the peak (2014-01-06T08:00Z, the nearest 2-hourly issue) h=72 q05 2.622, q95 3.152 -->
<!-- src: web/public/data/proof.json perEvent e2014 botley leadVsOfficialH 7.06 (the scoreboard's "7 h earlier" is read from here) -->

### 1:00–1:40 · Now (press 1): the clock

**Do:** point at the river strip on the left edge, at the **Enslow → Kings Mill** link, then at the clocks on the map.

> "Here's the clock today. Each link is a travel time we measured from past floods. Enslow to Kings Mill: 19 hours, 15 to 23 across six floods. Those lags choose what the model reads upstream.
>
> Each clock is a spot. It fills as the chance of flooding rises, with a countdown underneath. Kings Mill has sent no data since 13 October, so the Cherwell says 'no forecast' instead of guessing. Wolvercote never has one: its gauge has no history."

<!-- src: web/public/data/travel_times.json enslow->kingsmill tHalf median 18.6 h, p10 15.0, p90 22.8, n 6; web/public/data/live.json stale ["kingsmill"]; web/public/data/spots.json wolvercote mode timing_only -->

**Read the headline aloud if it says something** (it's live data, so don't learn a number for it). Don't lead with Cassington → New Botley: its 9.5 h half-rise includes a fast local jump, and its peak-to-peak time is 32 h. <!-- src: travel_times.json cassington->newbotley tHalf median 9.5 (p10 1.3, p90 42.5), tPeak median 32.0, n 24 -->

### 1:40–2:20 · Protect (press 3): the decision on the ground

**Do:** January 2014 is selected. Drag the hour slider once, then click pin 1.

> "Protect asks: if the council had 500 sandbags, where would they do the most good, and by when? We run the forecast through the terrain 200 times. Red means wet in most runs. The pins are the buildings most exposed, with the time the bags must be in place. Each card lists the checks a person must make first. It's screening, not instructions. Against the real 2014 flood outline the map overlaps 68 percent."

<!-- src: web/public/data/spread/e2014/manifest.json runs 200, validation.iou 0.681; web/public/data/spread/e2014/sandbags.json budget 500, 5 candidates, 248 bags, first firstWet 2014-01-05T12:00Z (deploy-by = 3 h earlier, 09:00 GMT) -->

### 2:20–3:30 · How good is it? (press 4): the honest test

**Do:** point at the three tiles, left to right.

> "Should you trust it? First, we beat the simple guess that the river stays where it is: 27 percent more accurate a day ahead, 39 at six hours, falling to 11 at three days. That's on forecasts from October 2021 on, which no model saw, pooled across our four gauges.
>
> Second, honest odds: when we say a chance, does it happen that often? Dots near the line mean yes. The counts are small, so we show them.
>
> Third, early without crying wolf. Alarm when the chance passes one in two: we caught all 30 floods across four spots, with 5 false alarms. The EA's own warnings, scored the same way, caught 24, with 1 false alarm. On timing it's mixed: we're ahead at Osney and the Cherwell, behind at Botley and Abingdon Road."

<!-- src: web/public/data/proof.json skillByLead h24 skill 0.2664, h6 0.3915, h72 0.1079; testPeriodNote (issue times from 2021-10-01; pool newbotley, minns, coldharbour, kingsmill) -->
<!-- src: web/public/data/proof.json tradeoff pStar 0.5: osney 7/0/2, botley 8/0/3, abingdonrd 8/0/0, cherwell 7/0/0 (hits/misses/falseAlarms) = 30 caught of 30, 5 false alarms; officialOutcome: osney 5/2/0, botley 8/0/0, abingdonrd 8/0/0, cherwell 3/4/1 = 24 of 30, 1 false alarm; meanLeadVsOfficialH osney +2.13, cherwell +8.16, botley -5.92, abingdonrd -14.58 -->

### 3:30–4:00 · The near miss and the close

**Do:** press **2**, click the **2026** thumbnail ("Stayed calm: highest chance 28%").

> "Last winter the river came within 11 centimetres of Botley's flood line and stayed high for weeks. River Clock never went above 28 percent, so a one-in-two alarm never fired. Next, we tested real rain forecasts: three days ahead they lift accuracy from 11 to 28 percent, but they added three false alarms, so they're not switched on yet. One finding, one model, one baseline, honest proof. Thanks."

<!-- src: web/public/data/replays/e2026.json botley max pFlood 0.2767 (2026-02-15), observed newbotley peak 2.647 m vs threshold 2.76 m in spots.json (11 cm); proof.json perEvent e2026 crossed false at every spot; rain forecasts: issue #100 results comment (honest window, 72 h pooled skill +0.114 -> +0.278; false alarms Botley 1 -> 3, Osney 0 -> 1), shown on the How good is it? "What's next" card -->

---

## Short versions

### 30 seconds (judge in a hurry, or the laptop is down)

> "Oxford floods slowly, from upstream: on the Cherwell, a rise at Enslow reaches Kings Mill about 19 hours later. River Clock reads those upstream gauges like a clock and makes a prediction for five Oxford spots: the chance of flooding and when, three days ahead, so people can make a decision before the water arrives. Replaying January 2014, it called Botley Road 37 hours before the river crossed and seven hours before the EA's warning. Over every flood we replayed, it caught 30 of 30 with five false alarms, but on timing the EA is sometimes earlier. It's a prototype, not an official warning."

<!-- src: travel_times.json enslow->kingsmill tHalf median 18.6 n 6; replays/e2014.json + proof.json perEvent e2014 botley leadVsOfficialH 7.06; proof.json tradeoff pStar 0.5 -->

### 2 minutes (one screen each, no Q&A)

1. **Replay (2), 40 s.** Let it play from 1 Jan. "Noon on 4 January: more likely than not. The EA's warning came seven hours later; the river crossed 37 hours after our call. The peak, 3.03 m, was inside our 2.62–3.15 m range from three days before. One flood: over all floods the EA is sometimes earlier." <!-- src: replays/e2014.json; proof.json perEvent e2014 botley -->
2. **Now (1), 25 s.** "The clock: Enslow to Kings Mill takes about 19 hours, 15 to 23 across six floods. Each spot's clock fills as the chance rises. The Cherwell says 'no forecast' because Kings Mill is offline." <!-- src: travel_times.json enslow->kingsmill; live.json stale -->
3. **Protect (3), 20 s.** "Where would 500 sandbags do the most good, and by when? 200 runs through the terrain; the pins are the most exposed buildings. Screening, not instructions." <!-- src: spread/e2014/manifest.json runs 200; sandbags.json budget 500 -->
4. **How good is it? (4), 30 s.** "27% more accurate than 'the river stays the same' a day ahead. At a one-in-two alarm: 30 of 30 floods, 5 false alarms. The EA's warnings scored the same way: 24 of 30, 1 false alarm. Ahead of the EA at Osney and the Cherwell, behind at Botley and Abingdon Road." <!-- src: proof.json skillByLead h24 0.2664; tradeoff pStar 0.5; officialOutcome; meanLeadVsOfficialH -->
5. **Close, 5 s.** "Not an official warning; a clock you can read."

---

## If something breaks

| Problem | What to do |
|---|---|
| App won't start | `docs/demo-backup.md` plan B: the last `demo-ready-*` tag and `make demo`, or `cd web && npm run preview` (port 4173). |
| A screen shows "sample data" | Say so. Don't present fixture numbers as results. |
| Map looks plain | Expected offline: it's the bundled OpenStreetMap basemap (rivers, roads, buildings), no tiles. |
| Replay already finished | Space, then Shift+← back to about 1 Jan 12:00, then Space. Or open `#/replay` in a new tab. |
| "Live data unavailable" on Now | Expected offline: it shows the last saved forecast with its time. "Online it polls the EA every 15 minutes." |
| Out of time | Cut Protect, then the near miss. Never cut the disclaimer or the "EA is sometimes earlier" line. |

---

## What to say if a number looks bad

Say the number, then why. Never hide it, never round it up.

| What the judge sees | What to say |
|---|---|
| Only 11% better at 3 days | "Still better, but the edge shrinks. Beyond the longest travel time the water hasn't reached any upstream gauge yet, and we use no rain forecast. Real rain forecasts took it to 28% in our test, but added false alarms, so they're off." <!-- src: proof.json skillByLead h72 0.1079; #100 --> |
| 5 false alarms vs the EA's 1 | "We alarm earlier and more often; the EA warns less often and missed 6 floods by the same rules. A higher trigger cuts our false alarms; a lower one gives more warning. The trade-off is under Show the working." <!-- src: proof.json tradeoff pStar 0.5 falseAlarms 2+3+0+0; officialOutcome falseAlarms 1, misses 2+0+0+4 --> |
| Behind the EA at Botley (−5.9 h) and Abingdon Rd (−14.6 h) | "The EA was earlier there, on average, and that's fine: they have forecasters and more data. Their one warning covers both spots, so it looks early for the spot that floods last. At a 1-in-5 trigger we're earlier at every spot, with more false alarms." <!-- src: proof.json tradeoff meanLeadVsOfficialH pStar 0.5 botley -5.92, abingdonrd -14.58; pStar 0.2: +16.63, +48.25, +37.75, +18.26 --> |
| The EA gives more warning time at Botley and Abingdon Rd | "Yes: on average the EA's warning came about 38 and 42 hours before those floods, ours about 27 and 22." <!-- src: proof.json officialOutcome meanLeadH botley 37.84, abingdonrd 41.99; tradeoff pStar 0.5 meanLeadH botley 27.12, abingdonrd 22.38 --> |
| Ranges too wide (90% range holds 94–97% over all hours) | "Over all hours, mostly calm ones, yes: too cautious. In floods, which is when it matters, the 90% range holds 86–91%." <!-- src: proof.json coverage nominal 0.9 actual 0.9384–0.9694; testPeriodNote (in floods 0.86–0.91) --> |
| Honest odds: dots off the line in the middle | "When we said about 25%, it flooded more often than that. There are only a few dozen forecast hours in each middle dot, and they come from a handful of floods." <!-- src: proof.json reliability h24 pooled bin 0.2: pPred 0.245, pObs 0.59, n 32 --> |
| Cherwell warning time only about 8 h | "The Cherwell gives the least warning of our four spots. We're still ahead of the EA there, by about 8 hours on average." <!-- src: proof.json tradeoff cherwell pStar 0.5 meanLeadH 8.29, meanLeadVsOfficialH 8.16 --> |

---

## Judge Q&A cheat sheet

Short, honest answers. If we don't know, say so and say what we'd check.

**Is it better than the EA?**
No, and we don't claim it. It's complementary. EA warnings are yes/no, per warning area, from duty forecasters. We give each spot a chance and a time, so each user picks their own trigger. Scored with the same rules over seven events, at a one-in-two trigger we caught 30 of 30 floods with 5 false alarms; the EA's warnings caught 24 with 1 false alarm. Part of their "misses" is a mismatch: we score them against our gauge's flood line, not theirs. On timing it's mixed: ahead at Osney (+2.1 h) and the Cherwell (+8.2 h), behind at Botley (−5.9 h) and Abingdon Road (−14.6 h). <!-- src: proof.json tradeoff pStar 0.5; officialOutcome; meanLeadVsOfficialH -->

**How do you know there's no look-ahead?**
Every input is a trailing window. Tests change the data after the forecast time and check that nothing at that time changes, for the inputs and for the replay forecasts (`tests/test_features.py`, `tests/test_backtest.py`). A forecast issued at t only uses hourly rows up to t − 1 h, and the Replay screen shows a reading only an hour after it happened. The accuracy scores use forecasts from Oct 2021 on, after all training and calibration. <!-- src: proof.json testPeriodNote; web/src/screens/replay/facts.ts OBS_LAG_H (#93) -->

**But the 2014 replay model has seen later floods?**
Yes. Each replay uses a model retrained without that flood (±7 days), so the 2014 model has seen 2024. With seven events that's the best we can do, and it's why the accuracy scores use a strict time split instead. <!-- src: proof.json testPeriodNote -->

**Why LightGBM, and not an LSTM?**
About 20 years of hourly data but only a handful of floods. Boosted trees on per-gauge anomalies are strong on small tabular data, train in minutes, and show which inputs matter. One model per gauge, lead time and quantile gives a full range, so the flood chance falls straight out. Conformal calibration fixes the range widths.

**Does it beat the simple guess at every gauge?**
The published score is pooled over four gauges: +39% at 6 h to +11% at 72 h. An earlier per-gauge check (#8, before the final retrain) found Kings Mill about level with the simple guess from 36 h and Cold Harbour slightly worse from 48 h. Beyond the travel time, the wave that will arrive hasn't reached an upstream gauge yet; forecast rain is the likely fix, not a bigger model. <!-- src: proof.json skillByLead; per-gauge figures from issue #8, not in proof.json -->

**What about rain forecasts?**
We tested real archived ECMWF forecasts (from 2024 on). Three days ahead, accuracy against the simple guess rose from +11% to +28%, and in the Nov 2024 flood Botley would have been warned 29 h earlier. But it added 3 false alarms (2 at Botley, 1 at Osney), Botley's flood odds scored worse, and the test window holds only one flood. That fails our own rule, so it's not switched on. <!-- src: issue #100 results comment (honest window: 72 h +0.114 -> +0.278; Botley FA 1 -> 3, Osney 0 -> 1; e2024b Botley lead vs EA -29.1 h -> -0.1 h) -->

**Seven events is tiny.**
It is: seven events since 2007, one a near miss, giving 30 spot-level floods. One storm floods all four spots, so it's closer to 7 independent storms. That's why we bootstrap over events and score accuracy on every test hour, not just the floods. "30 of 30" is encouraging, not proof. <!-- src: proof.json tradeoff pStar 0.5 hits+misses 7+8+8+7 -->

**Why river level and not flow? How do you compare gauges?**
The EA flags the high-flow ratings at Farmoor, Enslow, Cassington and Islip as unreliable, and flood lines are set in level anyway. We never compare levels across gauges: each one enters as a change from its own median.

**Why stand-in gauges?**
In the first hour we found that the Osney, Godstow and Iffley lock gauges have no public history on their flood side (0.7% coverage). So Osney Island uses Minns Estate, about 1.2 km west, checked against residents' flood reports; Abingdon Road uses Cold Harbour; Wolvercote has no forecast. <!-- src: web/public/data/quality.json osney/godstow/iffley coveragePct 0.7 -->

**What does Protect's 68% mean?**
At the 2014 peak, the area wet in at least half of 200 terrain runs overlaps the EA's recorded flood outline with an intersection-over-union of 0.68. It's a sanity check on one event: a simple terrain fill ignores channels, walls, drains and defences, and much of the overlap is open floodplain. <!-- src: spread/e2014/manifest.json validation.iou 0.681, caveats -->

**Where is the decision part?**
A cost–loss rule: if acting costs C and being caught out costs L, act when the chance passes C ÷ L. Moving a car (£20 against £2,000) means act at 1%; closing a road (£5,000 against £100,000) at 5%. It drives the advice lines on Now and the alarm level on How good is it?; the calculator is under Show the working.

**The clocks went back last night. Did that break anything?**
Everything is stored and computed in UTC and converted to UK time only on screen, with the zone shown. The EA's historic warnings come in UK local time with a repeated hour each autumn; there's a test for that.

**What does Tiger Data do for you?**
It holds a SQL copy of everything: 3,287,615 hourly rows over 21 series, 2006 to today, plus live readings, in a Timescale hypertable with a daily rollup. Compression took it from 434 MB to 35 MB. One query shows the clock in 2014: Cassington peaked 84 h and Farmoor 28 h before New Botley. The app doesn't depend on it, so the demo runs offline. <!-- src: docs/tiger-data.md -->

**What would you do with another week?**
Rain forecasts trained to trust the forecast less, scored on more floods; per-gauge scores on screen; ask the EA for the lock flood-side histories so Osney can be forecast directly; check flood lines street by street with residents and the council.
