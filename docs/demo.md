# River Clock: demo script (4 minutes)

Judging is science-fair style: about 4 minutes per judge, at our table. The app is **one screen, "River Clock"**: a map of Oxford's rivers with a clock for each spot, a timeline under it, a 2-line scoreboard, a switch along the top (**Now | 2014 | Jan 2024 | Nov 2024 | 2026 near miss**) and a one-line proof footer. Everything else (sandbag screening, the accuracy charts, the cost–loss calculator, data quality) is behind **Show the working**. It must work with **no network**.

All times are UK local time. Judging is on **Sun 25 Oct 2026, after the clocks went back at 02:00**, so the app and this script are on **GMT (= UTC)**. January events are GMT too.

<!-- Every number below is read from committed JSON on main; the src comment beside each says where. If `make train backtest` runs again (#125, cut-off 03:00 GMT), re-check each src before rehearsal. The app reads its numbers at runtime, so it follows the data; this script doesn't. Never say a number we haven't computed. -->

---

## What's on the screen

- **The map (hero):** the rivers flow and rise as the water comes; each trouble spot has a clock face that fills as its chance of flooding rises, with a countdown underneath.
- **The timeline (under the map):** our forecast range against the real river level, with three markers: **River Clock warned · EA warned · Flooded**. Space plays it.
- **The scoreboard (2 lines):** when River Clock warned, when the EA warned, and when it flooded, for the chosen flood.
- **The switch (top):** today, or one of four past floods.
- **The proof footer (1 line):** across all the floods we replayed, how many River Clock caught and how many the official warning caught.

## Presenter keys

| Key | Does |
|---|---|
| **1 · 2 · 3 · 4 · 5** | Now · 2014 · Jan 2024 · Nov 2024 · 2026 near miss |
| **Space** | Play / pause the timeline |
| **P** | Presenter mode: bigger type, no chrome |

## Before each judging slot (1 minute)

1. Laptop on mains. Wi-Fi **off**. `make demo` running (see `docs/demo-backup.md`); `make preflight` shows only ✅/ℹ️.
2. Browser at **http://127.0.0.1:8080/**, press **P**, then **2** (2014), spot **Botley Road**, timeline at its start (about 1 Jan 2014). Don't press Space yet.
3. Check the proof footer reads 30 caught for River Clock and 24 for the official warning. If it doesn't, the data has changed: say what the footer says, not this script.

---

## The 4-minute walkthrough

Spoken words are in quotes: about 460 in total, so it fits 4:00 at a calm pace with time for the plays.

### 0:00–1:00 · The 2014 replay (key 2), the hero

**Do:** press **Space**. Point at each marker on the timeline as it appears: River Clock warned, EA warned, Flooded. Don't explain the chart yet.

> "This is Botley Road in January 2014, replayed hour by hour. The model sees only what was known at each moment, and was trained without this flood.
>
> Noon on Saturday 4 January: River Clock says Botley Road is more likely than not to flood. The Environment Agency's flood warning came seven hours later. The river crossed the flood line at 1 am on Monday, 37 hours after our call. And the peak, 3.03 metres, landed inside the range we gave three days before.
>
> How? Oxford floods slowly, from upstream: on the Cherwell, a rise at Enslow reaches Kings Mill about 19 hours later. River Clock reads the upstream gauges like a clock and makes a prediction: the chance of flooding, and when, for five Oxford spots, three days ahead. Then the decision: is it worth acting yet?
>
> That's one flood. Over all our replays the EA is sometimes earlier than us, and the app shows where. It's a student prototype, not an official warning."

<!-- src: web/public/data/replays/e2014.json: botley first pFlood >= 0.5 at issuedAt 2014-01-04T12:00:00Z (0.59 at 72 h); official botley warning 2014-01-04T19:03:30Z; crossings botley 2014-01-06T01:00:00Z (37 h after 12:00 on 4 Jan); observed newbotley peak 3.027 m at 2014-01-09T09:00:00Z; forecast issued 72 h before the peak (2014-01-06T08:00Z, the nearest 2-hourly issue) h=72 q05 2.622, q95 3.152 -->
<!-- src: web/public/data/proof.json perEvent e2014 botley leadVsOfficialH 7.06; web/public/data/travel_times.json enslow->kingsmill tHalf median 18.6 h, p10 15.0, p90 22.8, n 6 -->

### 1:00–1:45 · The map: how the water flows

**Do:** while 2014 keeps playing, point at the rivers on the map, then at the clocks.

> "Watch the map. The rivers rise upstream first and the water moves down towards Oxford. We measured those travel times from past floods: Enslow to Kings Mill takes 15 to 23 hours across six floods. Those lags choose what the model reads upstream.
>
> Each clock is a trouble spot. It fills as the chance of flooding rises, with a countdown to when the water is likely to arrive. That's what a resident needs: how likely, and by when."

<!-- src: web/public/data/travel_times.json enslow->kingsmill p10 15.0, p90 22.8, n 6 -->

Don't lead with Cassington → New Botley: its 9.5 h half-rise includes a fast local jump, and its peak-to-peak time is 32 h. <!-- src: travel_times.json cassington->newbotley tHalf median 9.5 (p10 1.3, p90 42.5), tPeak median 32.0, n 24 -->

### 1:45–2:30 · Nov 2024 (key 4): where the EA was earlier

**Do:** press **4**, Space. Let the three markers appear.

> "Here's the honest one. In November 2024, at Botley, the EA warned about 30 hours before we did. We still flagged it before the river crossed, but they were earlier, and the app shows it, not just the floods we're proud of. On average across all floods, we're ahead of the EA at Osney and the Cherwell, and behind at Botley and Abingdon Road."

<!-- src: web/public/data/proof.json perEvent e2024b botley leadVsOfficialH -30.14, crossed true; tradeoff botley pStar 0.5 misses 0; meanLeadVsOfficialH osney +2.13, cherwell +8.16, botley -5.92, abingdonrd -14.58 -->

### 2:30–3:20 · The proof footer: should you trust it?

**Do:** point at the footer line.

> "This line is the whole test. Alarm when the chance passes one in two: across 30 floods at four spots, River Clock caught all 30, with 5 false alarms. The EA's own warnings, scored the same way, caught 24, with 1 false alarm. And against the simple guess that the river stays where it is, we're 27 percent more accurate a day ahead, on forecasts from 2021 on that no model saw. The edge shrinks to 11 percent at three days."

<!-- src: web/public/data/proof.json tradeoff pStar 0.5: osney 7/0/2, botley 8/0/3, abingdonrd 8/0/0, cherwell 7/0/0 (hits/misses/falseAlarms) = 30 of 30, 5 false alarms; officialOutcome: osney 5/2/0, botley 8/0/0, abingdonrd 8/0/0, cherwell 3/4/1 = 24 of 30, 1 false alarm; skillByLead h24 0.2664, h72 0.1079; testPeriodNote (issue times from 2021-10-01, four gauges pooled) -->

### 3:20–4:00 · The 2026 near miss (key 5), and the close

**Do:** press **5**, Space.

> "Last winter the river came within 11 centimetres of Botley's flood line and stayed high for weeks. River Clock never went above 28 percent, so a one-in-two alarm never fired. Next, rain forecasts: in a test they lifted three-day accuracy from 11 to 28 percent but added three false alarms, so they're off for now. Sandbag screening and all the charts are in Show the working. One finding, one model, one baseline, honest proof. Thanks."

<!-- src: web/public/data/replays/e2026.json botley max pFlood 0.2767 (2026-02-15), observed newbotley peak 2.647 m vs threshold 2.76 m in spots.json (11 cm); proof.json perEvent e2026 crossed false at every spot; rain forecasts: issue #100 results comment (honest window, 72 h pooled skill +0.114 -> +0.278; false alarms Botley 1 -> 3, Osney 0 -> 1) -->

If a judge asks about today, press **1**: read the headline as it is (live data, so don't learn a number for it). Kings Mill has sent no data since 13 October, so the Cherwell says "no forecast"; Wolvercote never has one (no gauge history). <!-- src: web/public/data/live.json stale ["kingsmill"]; spots.json wolvercote mode timing_only -->

---

## Short versions

### 30 seconds (judge in a hurry, or the laptop is down)

> "Oxford floods slowly, from upstream: on the Cherwell, a rise at Enslow reaches Kings Mill about 19 hours later. River Clock reads those upstream gauges like a clock and makes a prediction for five Oxford spots: the chance of flooding and when, three days ahead, so people can make a decision before the water arrives. Replaying January 2014, it called Botley Road 37 hours before the river crossed and seven hours before the EA's warning. Over every flood we replayed, it caught 30 of 30 with five false alarms, but on timing the EA is sometimes earlier. It's a prototype, not an official warning."

<!-- src: travel_times.json enslow->kingsmill tHalf median 18.6 n 6; replays/e2014.json + proof.json perEvent e2014 botley leadVsOfficialH 7.06; proof.json tradeoff pStar 0.5 -->

### 2 minutes (no Q&A)

1. **2014 (key 2, Space), 50 s.** "Noon on 4 January: more likely than not. The EA's warning came seven hours later; the river crossed 37 hours after our call. The peak, 3.03 m, was inside our 2.62–3.15 m range from three days before." Point at the rivers rising: "Enslow to Kings Mill takes about 19 hours; we measured it over six floods." <!-- src: replays/e2014.json; proof.json perEvent e2014 botley; travel_times.json enslow->kingsmill -->
2. **Nov 2024 (key 4), 20 s.** "Here the EA warned about 30 hours before us. It's mixed: ahead at Osney and the Cherwell, behind at Botley and Abingdon Road." <!-- src: proof.json perEvent e2024b botley -30.14; tradeoff meanLeadVsOfficialH -->
3. **Proof footer, 30 s.** "At a one-in-two alarm: 30 of 30 floods, 5 false alarms. The EA's warnings scored the same way: 24 of 30, 1 false alarm. 27% more accurate than 'the river stays the same' a day ahead." <!-- src: proof.json tradeoff pStar 0.5; officialOutcome; skillByLead h24 0.2664 -->
4. **2026 (key 5), 15 s.** "Within 11 cm of the line; we never went above 28%, so no false alarm." <!-- src: replays/e2026.json -->
5. **Close, 5 s.** "Not an official warning; a clock you can read."

---

## If something breaks

| Problem | What to do |
|---|---|
| App won't start | `docs/demo-backup.md` plan B: the last `demo-ready-*` tag and `make demo`, or `cd web && npm run preview` (port 4173). |
| The app shows "sample data" | Say so. Don't present fixture numbers as results. |
| Map looks plain | Expected offline: it's the bundled OpenStreetMap basemap (rivers, roads, buildings), no tiles. |
| The 2014 timeline has already played | Press another flood's key and then **2** again, or reload the page. |
| "Live data unavailable" on Now (key 1) | Expected offline: it shows the last saved forecast with its time. "Online it polls the EA every 15 minutes." |
| Out of time | Cut the map section, then the near miss. Never cut the disclaimer or Nov 2024 (the EA was earlier). |

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
Every input is a trailing window. Tests change the data after the forecast time and check that nothing at that time changes, for the inputs and for the replay forecasts (`tests/test_features.py`, `tests/test_backtest.py`). A forecast issued at t only uses hourly rows up to t − 1 h, and the replay timeline shows a reading only an hour after it happened. The accuracy scores use forecasts from Oct 2021 on, after all training and calibration. <!-- src: proof.json testPeriodNote; web/src/screens/replay/facts.ts OBS_LAG_H (#93) -->

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

**What's the sandbag screening in Show the working?**
For Osney and Botley we push the forecast level through the terrain 200 times and rank buildings for 500 sandbags, each with a deploy-by time and the checks a person must make. It's experimental: screening, not instructions. At the 2014 peak, the area wet in at least half of the runs overlaps the EA's recorded flood outline with an intersection-over-union of 0.68. It's a sanity check on one event: a simple terrain fill ignores channels, walls, drains and defences, and much of the overlap is open floodplain. <!-- src: spread/e2014/manifest.json validation.iou 0.681, caveats -->

**Where is the decision part?**
A cost–loss rule: if acting costs C and being caught out costs L, act when the chance passes C ÷ L. Moving a car (£20 against £2,000) means act at 1%; closing a road (£5,000 against £100,000) at 5%. The calculator, with presets for a resident, a commuter and the council, is under Show the working.

**The clocks went back last night. Did that break anything?**
Everything is stored and computed in UTC and converted to UK time only on screen, with the zone shown. The EA's historic warnings come in UK local time with a repeated hour each autumn; there's a test for that.

**What does Tiger Data do for you?**
It holds a SQL copy of everything: 3,287,615 hourly rows over 21 series, 2006 to today, plus live readings, in a Timescale hypertable with a daily rollup. Compression took it from 434 MB to 35 MB. One query shows the clock in 2014: Cassington peaked 84 h and Farmoor 28 h before New Botley. The app doesn't depend on it, so the demo runs offline. <!-- src: docs/tiger-data.md -->

**What would you do with another week?**
Rain forecasts trained to trust the forecast less, scored on more floods; per-gauge scores on screen; ask the EA for the lock flood-side histories so Osney can be forecast directly; check flood lines street by street with residents and the council.
