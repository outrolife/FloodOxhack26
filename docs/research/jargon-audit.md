# Jargon audit: what a judge sees on each tab

Part 2 of #103 (Judge-first UX). Read-only audit of `web/src/views/*.tsx`, `web/src/components/**` and the data in `web/public/data/*.json` as committed on `main` (live forecast issued Sat 24 Oct 18:07 UTC). No browser was used: every on-screen string below was traced from the code, and every number was computed from the committed JSON.

**How to use this.** Section 1 lists every term or number a non-expert would trip over, tab by tab, with a replacement and (where needed) the text for a "what's this?" tooltip. Section 2 is the 30-second test and a data-generated headline per tab. Section 3 ranks the top 10 confusion points with the smallest fix for each. Section 4 is a glossary of 15 terms or fewer for an optional "?" panel. Section 5 gives implementation notes: where the strings live and which tests pin them.

**Ground rules for the replacements.**
- Write chances as **"1 in 10"** or **"30% chance"**, tied to a **clock time** ("by Sunday 6 pm"), not "pFlood +24 h = 0.32".
- Write hours as **"hours"** or "about 2 days", not "h".
- Don't write **"0%"**. A rounded 0% reads as "impossible". Write "under 1%" or "very unlikely".
- Each idea gets one name, used on every tab (see 1.0).
- Keep it accurate. Where the plain version drops something, the tooltip puts it back.

---

## 1. Per-tab tables

### 1.0 One vocabulary for the whole app

The same idea has up to five names today. Choosing one name each fixes about a third of the rows below.

| Idea | Names used today | Use this |
|---|---|---|
| EA "property flooding possible" level on the spot's gauge | flood threshold, threshold, Threshold crossed, the river crossed the threshold | **flood level** ("the river reached flood level") |
| Top of the gauge's typical range (EA `typicalRangeHigh`) | amber, normal top, normal range, Threshold (API / config) | **usual high** ("0.6 m below its usual high"; "higher than usual" when above) |
| Probability the level is above the flood level by hour h | pFlood, P, chance of flooding, probability | **chance of flooding** |
| Hours ahead of the forecast time | lead, lead time, +24 h, Lead +24 h | **hours ahead**, or a clock time |
| Probability at which you act | p*, trigger, trigger probability, P ≥ X% | **act-at chance** |
| Forecast range | interval, quantile, 5–95%, 25–75%, band | **likely range** (25–75%) / **wide range** (5–95%) |
| The "level stays put" baseline | persistence, baseline, "the level stays roughly where it is" | **the simple guess** |
| Past floods used for scoring | backtest, backtest floods, events, replays | **past floods** |
| Environment Agency | EA | Spell it out once per tab: "Environment Agency (EA)" |

### 1.1 Header and disclaimer (every tab)

| # | Current text (file:line) | Why it confuses | Plain-English replacement | Tooltip? |
|---|---|---|---|---|
| G1 | Tagline "Water upstream is Oxford's future. We read it as a clock." (`App.tsx:42`) | Memorable, but doesn't say what the app does | Keep it, and add a second line: "Flood forecasts for five Oxford streets, up to 3 days ahead, from river gauges upstream." | – |
| G2 | Tab labels "River · Time Machine · Decide · Proof · About" (`App.tsx:12-16`) | "Proof" and "Decide" don't say what the tab holds | Keep the names, and add a hover hint or small subtitle to each: "River: right now" · "Time Machine: replay a real flood" · "Decide: should I act?" · "Proof: does it work?" · "About: how it works" | – |
| G3 | Disclaimer (`Disclaimer.tsx:5-10`) | Fine as it is. Required on every screen (SPEC §16 rule 7) | Keep | – |

### 1.2 River tab

What a judge sees, top to bottom: maybe a warning banner; a map with five coloured dots and white gauge dots, plus a legend; a panel for Botley Road; the "water is already on its way" strip of gauges; the "Rain in the next 72 h" chart. With today's data, Osney, Botley and Abingdon Road are green with 0% at every horizon. Wolvercote and Cherwell are grey. Every gauge is below its usual high.

| # | Current text (file:line) | Why it confuses | Plain-English replacement | Tooltip? |
|---|---|---|---|---|
| R1 | **"Live data unavailable.** Showing the last saved forecast, issued Sat 24 Oct, 19:07 BST." in a red-tinted warning box (`River.tsx:41-44`) | Shown whenever `/api/live` isn't running, so it is the likely first thing a judge reads. It looks like an error | Neutral box: "Forecast made Sat 24 Oct, 7:07 pm, from the latest gauge readings." Keep the warning style only when the forecast is more than 6 h old | – |
| R2 | Legend "Spot colour = chance of flooding within 24 h:" (`SpotMap.tsx:81`) | Fine. "24 h" → "24 hours" | "Colour = chance of flooding in the next 24 hours" | – |
| R3 | "Low (< 10%)", "Elevated (10–50%)", "High (≥ 50%)" (`forecast.ts:9-11`) | `<` and `≥` are maths notation. "Elevated" is vague | "Unlikely (under 1 in 10)" · "Possible (1 in 10 to 1 in 2)" · "Likely (1 in 2 or more)" | – |
| R4 | "No probability (timing only or stale)" (`forecast.ts:12`), the grey dot at Wolvercote and Cherwell | "timing only" and "stale" are internal modes. It doesn't say *why* there's no forecast | "No forecast right now" | **Yes:** "Wolvercote's gauge has no long history to learn from, so we show its live level only. The Cherwell gauge at Kings Mill has sent no readings since 13 Oct." |
| R5 | Gauge tooltip "Gauge: Godstow Lock d/s", "Eynsham Lock u/s", "Cassington Weir B", "Enslow Weir A", "Kings Mill u/s" (`SpotMap.tsx:47`; names from `stations.json`) | "u/s" and "d/s" are EA shorthand for upstream and downstream; "Weir B" is an internal label | Display names: "Godstow Lock (downstream side)", "Eynsham Lock (upstream side)", "Cassington Weir", "Enslow Weir", "Kings Mill" | "River gauge: measures water height every 15 minutes." |
| R6 | Spot tooltip "0% chance of flooding within 24 h" (`SpotMap.tsx:71`, `pct()` in `forecast.ts:80`) | A rounded "0%" reads as "impossible" | "Under 1% chance of flooding in the next 24 hours" (when p < 0.005) | – |
| R7 | "Gauge: New Botley · flood threshold 2.76 m · normal top 2.01 m" (`SpotPanel.tsx:32-33`) | Three new terms in one line. A judge can't picture "2.76 m", and the heights only mean something on this gauge's own scale | "Measured at the New Botley gauge · floods at 2.76 m · usual high 2.01 m" | **Yes**, on "floods at": "The height at which the Environment Agency says property flooding becomes possible here. Each gauge measures from its own zero, so heights can't be compared between gauges." |
| R8 | Status chip "Low (< 10%)" (`SpotPanel.tsx:38`) | As R3 | As R3 | – |
| R9 | Chip "Gauge data stale" (`SpotPanel.tsx:40`) | "Stale" is jargon | "Gauge offline since 13 Oct" (from `dataAsOf`) | – |
| R10 | "Now **0.83 m**: 1.93 m below the flood threshold." / "Last reading …" (`SpotPanel.tsx:45-49`) | Fine apart from "threshold" | "River now 0.83 m: about 1.9 m below flood level." | – |
| R11 | "Level, last 7 days" plus a sparkline with an unexplained dashed orange line (`SpotPanel.tsx:53-55`, `Sparkline.tsx:49-51`) | Nothing says what the dashed line is | "River level, last 7 days (dashed line: usual high)" | – |
| R12 | "Chance of flooding, by lead time", with rows "+6 h … +72 h" (`ProbBars.tsx:11,19`) | "Lead time" and "+6 h" are forecaster talk | Title "Chance of flooding by …", with rows as clock times: "Sun 1 am · Sun 6 am (GMT, after the clocks go back) · Sun 6 pm · Mon 6 am · Mon 6 pm · Tue 6 pm" (`formatShort`), or "in 6 hours", "in 3 days" | – |
| R13 | Timing-only title "Chance above normal range (amber), by lead time" (`ProbBars.tsx:11`) | "amber" | "Chance the river goes above its usual high" | – |
| R14 | "No lead-time probabilities." (`ProbBars.tsx:6`) | Developer wording | "No forecast for this spot right now." | – |
| R15 | Arrival sentence "Under 10% chance of flooding in the next 72 h." (`forecast.ts:70`) | Accurate, but it hides that today's chance is far below 10% | When max p < 1%: "Very unlikely to flood in the next 3 days (under 1%)." Otherwise "Under 1 in 10 chance of flooding in the next 3 days." | – |
| R16 | "90% / 50% / 10% chance of flooding by Tue 18:00 GMT." (`forecast.ts:67-69`) | Decent already, but "50%" alone is abstract | "Flooding very likely by Tue 6 pm (9 in 10)." · "As likely as not by Tue 6 pm (1 in 2)." · "1 in 10 chance of flooding by Tue 6 pm." | – |
| R17 | "Median forecast reaches the top of the normal range by … (travel-time window … to …)." (`forecast.ts:65`) | "Median", "travel-time window" | "Our middle estimate: the river goes above its usual high by Mon 6 pm (water from upstream due between Mon noon and Tue 3 am)." | – |
| R18 | "No forecast for this timing-only spot." / "No forecast: gauge data is stale." (`forecast.ts:51-53`) | Internal modes | "No flood forecast here: this gauge has no long history, so we show its level only." / "No forecast: this gauge hasn't sent a reading since 13 Oct." | – |
| R19 | "Already above the flood threshold (2.90 m vs 2.76 m)." (`forecast.ts:58`) | "threshold" | "Already above flood level (2.90 m; floods at 2.76 m)." | – |
| R20 | "Last observation: … · forecast issued …" (`SpotPanel.tsx:69-70`) | Fine | "Last reading … · forecast made …" | – |
| R21 | "Official EA flood warnings for this area (061FWF23NwBotley)" (`SpotPanel.tsx:74`) | The area code means nothing to a judge | "Official Environment Agency warnings for this area" (put the code in `title=`) | – |
| R22 | Strip subtitle "Each link shows the median time for a flood rise to travel downstream (T½, from past floods). Levels are on each gauge's own datum." (`River.tsx:85-86`) | "median", "T½", "datum" | "Each arrow shows how long a flood rise usually takes to reach the next gauge downstream, measured from past floods. Each gauge measures from its own zero, so compare a gauge only with its own past." | **Yes**, on the arrow: "Typical travel time (half-rise): from when the upstream gauge is halfway up its rise to when the downstream gauge is halfway up its own. Middle value over past floods." |
| R23 | Link label "≈ 23 h to Cold Harbour" drawn *between Farmoor and Eynsham* (`RiverStrip.tsx:36,108`) | It reads as "23 h from Farmoor to Eynsham". The label names a different gauge from the next one in the chain | "Farmoor → Cold Harbour: about 23 hours" (name both ends) | – |
| R24 | "(cross-correlation only)" (`RiverStrip.tsx:35`) | Statistics jargon | "(rough estimate: fewer than 3 past floods)" | – |
| R25 | Low-confidence link "≈ 1 h" Eynsham → New Botley (n = 3; peak-to-peak 8 h) (`travel_times.json`) | 1 h over that distance looks wrong to anyone. See #99 item 5 | Grey it out with "(few floods)", or hide it if n < 5 (#99) | – |
| R26 | Node line "Thames · 0.69 m · 0.61 m below normal top" (`RiverStrip.tsx:95-101`) | "normal top" | "Thames · 0.69 m · 0.61 m below its usual high" | – |
| R27 | "stale: last reading Tue 13 Oct, 15:45 BST" (`RiverStrip.tsx:98`) | "stale" | "offline since Tue 13 Oct" | – |
| R28 | Branch title "Thames main channel (live only)" (`RiverStrip.tsx:15`) | "live only" | "Thames main channel (live levels, no forecast)" | – |
| R29 | "7-day history unavailable: the live forecast carries no observed levels yet." (`River.tsx:97`) | Developer wording (hidden today, because `live.json` has observed levels) | "Last 7 days not available." | – |
| R30 | Map panel: "Official river risk" / "Official surface-water risk" legend "High (3.3% or more a year)" … "Very low (under 0.1% a year)" (`geo/risk_layers.json`, drawn by `RiskLayers.tsx:102-106`) | **"High" clashes with our forecast "High (≥ 50%)"** on the same map: a 3.3%-a-year risk and a 50%-in-24-hours forecast share one word | "Floods 1 in 30 years or more often" · "1 in 100 to 1 in 30 years" · "1 in 1,000 to 1 in 100 years" · "rarer than 1 in 1,000 years" | Keep the existing note "Annual chance from EA long-term risk maps. Not a forecast." (`RiskLayers.tsx:21`) |
| R31 | "Rain in the next 72 h [Experimental]" sub: "Cumulative rain from the ECMWF ensemble (51 runs), averaged over Eynsham, Enslow and Oxford. Shaded: 10–90% of runs; line: median." (`EnsembleRain.tsx:63-65`) | "Cumulative", "ECMWF ensemble", "10–90%", "median" | "Total rain expected over the next 3 days, from 51 runs of the European weather model. Line: the middle run. Shading: where 8 in 10 runs land. **Not used by our forecast yet.**" | "ECMWF: the European Centre for Medium-Range Weather Forecasts. It runs its model 51 times with slightly different starting conditions, to show the spread of outcomes." |
| R32 | Readout "By Tue 27 Oct, 18:07 GMT: median **10.2 mm** (10–90%: 7.7–13.0 mm)." (`EnsembleRain.tsx:96-97`) | "median", "10–90%" | "By Tue evening: about 10 mm of rain (most runs: 8 to 13 mm)." | – |

### 1.3 Time Machine tab

What a judge sees: an event picker (default **Jan–Feb 2014**); spot picker (default Botley Road); Play, speed and range buttons; "Forecast issued Fri 20 Dec 2013, 00:00 GMT"; the slider; a fan chart; one or two result sentences; a side panel with chance bars and the upstream strip. The replay **opens at its first forecast, 17 days before the flood**. At 1× it takes about **68 s** of playing to reach the 6 Jan crossing and about **4 min** to play the whole event (745 forecasts, 2 h apart, at 12 simulated hours per 2 s).

| # | Current text (file:line) | Why it confuses | Plain-English replacement | Tooltip? |
|---|---|---|---|---|
| T1 | Event option "Jan–Feb 2014 (headline)" (`TimeMachine.tsx:77-78`) | "headline" is internal | "Jan–Feb 2014 (start here)". Add "(near miss)" to "Jan–Mar 2026" | – |
| T2 | "Forecast issued **Fri 20 Dec 2013, 00:00 GMT**" (`TimeMachine.tsx:264`) | Doesn't say "pretend it's this moment", which is the whole idea of the tab | "Replay time: **Fri 20 Dec 2013, 00:00**. The forecast only knows what was measured up to now." | – |
| T3 | Y axis "m (gauge datum)" (`FanChart.tsx:161`) | "datum" | "River level (m, this gauge's own scale)" | – |
| T4 | **No legend.** Series names "Forecast 5–95%", "Forecast 25–75%", "Forecast median", "Observed (later)", "Observed" appear only in the hover tooltip (`FanChart.tsx:171-175`) | A judge sees two blue bands, a dashed line, a black line and a grey line with no key. This is the most important chart in the app | A one-line legend under the chart: "■ dark blue: likely range (1 in 2 chance the river is inside) · ■ light blue: wide range (9 in 10) · - - middle estimate · ━ black: the river so far · ━ grey: what happened next" | – |
| T5 | Reference lines "Flood threshold 2.76 m" and "Normal top 2.01 m" (`FanChart.tsx:177,179`) | "threshold", "normal top" | "Flood level 2.76 m" · "Usual high 2.01 m" | – |
| T6 | Markers "River Clock ≥ 10%", "River Clock ≥ 50%", "EA Flood Alert", "EA Flood Warning", "Threshold crossed" (`TimeMachine.tsx:214-221`) | `≥`, "threshold", EA tiers not explained | "River Clock: 1 in 10" · "River Clock: 1 in 2" · "Official Flood Alert" · "Official Flood Warning" · "River reached flood level" | **Yes**, on the official markers: "Environment Agency messages. Flood Alert: flooding is possible, be prepared. Flood Warning: flooding is expected, act now." |
| T7 | Caption "Times in UK time (GMT at the slider). Dark vertical line: forecast issue time." (`FanChart.tsx:194`) | "forecast issue time" | "Dark vertical line: 'now' in the replay. Times are UK time (GMT)." | – |
| T8 | Note "Grey line: what actually happened, shown only for times the slider has already passed. The model never sees data after its forecast time." (`TimeMachine.tsx:310-311`) | It explains the grey line but not the black one, and it's below the fold | Fold it into the T4 legend. Keep "The forecast never sees anything after 'now'." as a single line | – |
| T9 | Result: "**River Clock reached 50% 7 h earlier than the EA Flood Warning.** Issued Sat 4 Jan 2014, 19:03 GMT." (`timeline.ts:164`, `TimeMachine.tsx:299`) | "reached 50%" is abstract. It leaves out the most striking number: 37 h before the flood | "River Clock said **'as likely as not'** 7 hours before the official Flood Warning (Sat 4 Jan, 7:03 pm) and **37 hours before Botley Road flooded**." | – |
| T10 | Result: "River Clock reached 10% 61 h before the river crossed the threshold; no EA Flood Alert in the 72 h before it." (`timeline.ts:168-172`) | **It implies the EA gave no alert.** In fact an EA Flood Alert went out on 23 Dec for an earlier rise and may still have been in force; it falls outside the 72 h matching window | "River Clock first gave a 1 in 10 chance about 2½ days (61 h) before the flood. (The EA's Flood Alert for this area went out earlier, on 23 Dec.)" | – |
| T11 | "(EA issue known to the day only, so compared in whole days)" (`timeline.ts:134`) | OK but heavy | "(the official time is known only to the day, so this is approximate)" | – |
| T12 | Side panel "At Fri 20 Dec 2013, 00:00 GMT" + chance bars "+6 h …" + arrival sentence (`TimeMachine.tsx:318-322`) | Same terms as R12 and R15–R19 | Same fixes as R12 and R15–R19 | – |
| T13 | "Upstream at this time" (`TimeMachine.tsx:325`) | Fine. Strip issues as R23–R27 | "Upstream gauges at this moment" | – |
| T14 | Nothing on this tab says the replay model was **trained without this flood** (it is only in About, `About.tsx:43-46`) | A judge's first question: "Did the model already know this flood?" | A small line under the event picker: "Forecasts made by a model that never saw this flood." | **Yes:** "Each replay uses a model retrained without that flood (±7 days). It did learn from the other floods, including some after 2014. The strict test on 2021–2026 forecasts the model never trained on is on the Proof tab." |
| T15 | "Keys: Space play/pause · ← → step one forecast (Shift: 6) · Home/End jump to start/end" (`TimeMachine.tsx:281`) | Fine for presenters; judges won't need it | Keep it small, or move it into the Play button's `title` | – |

### 1.4 Decide tab

What a judge sees, with the default preset (Resident, £20 / £2,000) and the default spot (Osney Island / Binsey): a formula paragraph; three preset buttons; two log-scale sliders; "Your trigger: **p* = 1%**"; the line "At your costs, act when P ≥ 1%. Now (24 h ahead): 0% → don't act yet."; a table (7 hits, 13 false alarms, 0 misses, mean lead 51.6 h vs official 12.4 h); a cost chart (River Clock **£400 · lowest**, Official warnings £6,120, Never act £14,000, Always act £440); and a "How the costs are counted" expander.

| # | Current text (file:line) | Why it confuses | Plain-English replacement | Tooltip? |
|---|---|---|---|---|
| D1 | "Acting costs *C*. Not acting when the flood comes loses *L*. With a calibrated probability *P*, acting pays off when *P* × *L* ≥ *C*, so the best trigger is **p* = C / L**." (`Decide.tsx:170-172`) | Four symbols and an inequality before any example. "calibrated" is unexplained | "Acting costs you something (moving your car: £20). Not acting when it floods costs more (a flooded car: £2,000). So act once the chance of flooding is above **£20 ÷ £2,000 = 1%**." | **Yes**, on "Why?": "If the chance is P, waiting costs P × £2,000 on average and acting costs £20. Acting wins once P × £2,000 is more than £20, which happens at P = 1%. This only works if our chances are honest: 'when we say 30%, it floods about 30% of the time'. The Proof tab checks that." |
| D2 | Presets "Resident (move car: £20 / £2,000)", "Commuter (reroute: £5 / £100)", "Council (close road / barriers: £5,000 / £100,000)" (`Decide.tsx:177`, `costLoss.ts:57-59`) | The "/" between two amounts is ambiguous, and so is the "/" in "close road / barriers" | "Resident: move the car (costs £20, protects £2,000)" etc. | – |
| D3 | Slider labels "Cost of acting, C" / "Loss if flooded, L" (`Decide.tsx:182-183`) | The letters add nothing for a judge | "What acting costs you" / "What you'd lose if it floods and you didn't act" | – |
| D4 | "Your trigger: **p* = 1%**" (`Decide.tsx:186`) | "p*" is notation | "**Act once the flood chance reaches 1%**" | **Yes:** "How sure you need to be before acting. The cheaper acting is compared with what you'd lose, the lower this is." |
| D5 | "(acting never pays off when C ≥ L)" (`Decide.tsx:187`) | Symbols | "(acting costs as much as the loss, so it never pays)" | – |
| D6 | "At your costs, act when P ≥ 1%. Now (24 h ahead): 0% → don't act yet." (`costLoss.ts:358,364`, `Decide.tsx:205-213`) | "P ≥", "0%", "24 h ahead", and an arrow | "Right now at Osney Island: **under 1% chance** of flooding in the next 24 hours, below your 1%. **No need to act yet.**" | – |
| D7 | "No flood probability for this spot (timing only)" / "Live data stale for this spot" (`costLoss.ts:346-349`) | Internal modes | "No forecast for this spot (its gauge has no long history)" / "No forecast: this spot's gauge is offline" | – |
| D8 | "Forecast issued … · latest saved forecast (live.json)" / "sample data (offline fixture), not today's river" (`Decide.tsx:225-226`) | File names, "fixture" | "Forecast made Sat 24 Oct, 7:07 pm" / "Sample data, not today's river" | – |
| D9 | "Over the backtest at Osney Island / Binsey, p* = 1%" (`Decide.tsx:232`) | "backtest", "p*" | "**If you'd used this rule in past floods** (Osney Island, act at 1%)" | – |
| D10 | Clamp notice "Your p* is below the backtested triggers, so River Clock's outcomes are those at p* = 1%. The cost bars still use your C and L." (`Decide.tsx:239-240`) | Three jargon terms | "We tested act-at chances from 1% to 90%, so these results use the nearest one we tested (1%). Costs still use your amounts." | – |
| D11 | Table headings "River Clock outcome / Count / Cost each" and rows "Hits (acted before the flood)", "False alarms (acted, no flood)", "Misses (flood, no trigger)", "Mean lead time of hits" (`Decide.tsx:248-270`) | "Hits", "trigger", "Mean lead time" | "Floods caught in time" · "Acted, but no flood came" · "Floods missed" · "Average warning before the flood: **52 hours (about 2 days)**" | "False alarm: River Clock reached your act-at chance but the river didn't reach flood level within 3 days." |
| D12 | "official warnings 12.4 h" (`Decide.tsx:274`) | Fine, but the comparison is buried in a muted cell | "Official warnings gave 12 hours" (and bold the contrast) | – |
| D13 | Counts such as "7.5" (`format.ts:15-18`): interpolated between tested act-at chances | Half a flood confuses | Round to whole numbers for display, and say "about" when interpolated | – |
| D14 | "Total cost over the **7** backtest floods" (`Decide.tsx:285`) | "backtest". Also, "7" counts repeat crossings (5 flooded events at Osney; #99 item 3) | "What each approach would have cost over **7 past flood episodes**" (or count events, per #99) | – |
| D15 | Cost chart tooltip "7 hits + 13 false alarms × £20 / 0 misses × £2,000" (`CostChart.tsx:47-49`) | "hits" | "7 floods caught + 13 false alarms, £20 each; 0 missed, £2,000 each" | – |
| D16 | Bar labels "River Clock / Official warnings / Never act / Always act" (`costLoss.ts:239-244`) | Mostly clear. "Always act" is a lower bound (see the expander) | Keep. Rename to "Act on River Clock" / "Act on official warnings" so they read as strategies | – |
| D17 | "How the costs are counted": "outcomes interpolated from the backtest", "false-alarm episode the most sensitive trigger flagged; a lower bound" (`Decide.tsx:288-301`) | Dense, though it sits in an expander | Lead with "Each time you act costs £C. Each flood you miss costs £L." and keep the rest as is | – |

### 1.5 Proof tab

What a judge sees: four chart cards ("Skill vs persistence, by lead time", "Interval coverage", "Reliability", "Lead time vs false alarms"); "Event by event"; "The finding: flood travel times"; "What the model looks at"; "Data quality and sources". This tab carries most of the jargon in the app: pinball ×2, persistence ×5, nominal, Brier ×3, calibrated, bootstrap, p* ×3, T½ ×4, cross-correlation ×3, LightGBM gain.

| # | Current text (file:line) | Why it confuses | Plain-English replacement | Tooltip? |
|---|---|---|---|---|
| P1 | Title "Skill vs persistence, by lead time" (`SkillCharts.tsx:33`) | Three jargon words | "**Better than a simple guess?**" | – |
| P2 | "Skill = 1 − model pinball loss / persistence pinball loss. Above 0 means River Clock beats 'the level stays roughly where it is'." (`SkillCharts.tsx:35-36`) | A formula with an unexplained loss function | "How much smaller River Clock's forecast error is than the simple guess 'the river stays where it is'. **0.27 means 27% less error.** Above 0: River Clock is better." | **Yes**, on "error": "Measured with the pinball loss, a standard score for range forecasts. It penalises a range that misses the real level, and a range that is needlessly wide. Scored on 2021–2026 forecasts no model trained on." |
| P3 | Y-axis ticks "0.00 … 0.40" and tooltip "Skill 0.266", "Lead +24 h" (`SkillCharts.tsx:48-51`) | Decimals to 3 places; "Lead" | Ticks as "0%, 10%, … 40%"; tooltip "27% less error, 24 hours ahead"; x ticks "6 h … 72 h" → "6 hours … 3 days" | – |
| P4 | "The model does **not** beat persistence at +X h." (`SkillCharts.tsx:40`) (hidden today: skill is positive at every lead) | "persistence" | "River Clock is **no better than** the simple guess at X hours ahead." | – |
| P5 | Title "Interval coverage"; "How often the real level fell inside each forecast interval. Dashed lines are the nominal targets." (`SkillCharts.tsx:80-83`) | "Interval", "coverage", "nominal" | "**Do our ranges hold the real level?**" "How often the real river level ended up inside our 50%, 80% and 90% ranges. Dashed lines: where they should be." | – |
| P6 | Red box "Coverage off by more than 10 points: 50% interval at +6 h (65%); 50% interval at +12 h (68%); … 80% interval at +72 h (93%)." **Nine items** (`SkillCharts.tsx:85-91`) | It looks like a failure, and it never says which way the ranges are off. Here they are **too wide** (too cautious), which is the safer error. See #99 item 2 | One sentence in an amber, not red, box: "**Our ranges are too cautious:** the 50% range held the real level 65–78% of the time, and the 80% range up to 93%. Wider than needed, not too narrow." | – |
| P7 | Legend "50% interval / 80% interval / 90% interval" (`SkillCharts.tsx:109`) | "interval" | "50% range" etc. | – |
| P8 | Title "Reliability"; "When River Clock says 30%, does it flood about 30% of the time? Points on the diagonal are well calibrated." (`SkillCharts.tsx:136-137`) | The question is great; the title and "calibrated" are not | Title: "**When we say 30%, does it flood 30% of the time?**" Sub: "Dots on the dashed diagonal mean our chances are honest." | – |
| P9 | Axes: x "Forecast probability", y unlabelled; tooltip "Forecasts in bin"; select "Lead" (`SkillCharts.tsx:150,169-174`) | No y label. "bin". "Lead" | y: "How often it actually flooded"; tooltip "Number of forecasts"; select "Hours ahead" | – |
| P10 | "Brier score 0.00080 (persistence 0.00090); Brier skill **0.11**. Dot size = number of forecasts." (`SkillCharts.tsx:181-183`) | Two raw scores no judge can read. At Abingdon Road (24 h) it shows "**-0.17**" with no comment | "Flood-chance error: **11% lower** than the simple guess." When negative: "**17% worse** than the simple guess here." Then "Bigger dot = more forecasts." | **Yes**, on "error": "Brier score: the average squared gap between our chance (0–1) and what happened (0 or 1). 0 is perfect; lower is better." |
| P11 | Biggest dot: 41,116 forecasts at 0% (`proof.json` reliability bins) | It dwarfs the informative dots | Note: "Most of the time the chance is near 0% and nothing floods (the big dot at bottom left)." | – |
| P12 | Title "Lead time vs false alarms"; "Each point is a trigger probability p*. Lower p* gives earlier warning but more false alarms. The dashed zero line is the official EA warning time. … Whiskers: 90% bootstrap interval over events." (`SkillCharts.tsx:218-223`) | "trigger probability p*", "bootstrap". **Two lines with different zeros share one axis:** "Mean lead before flooding" counts from the flood, while "Mean lead vs official warning" counts from the EA warning, yet the text says "the dashed zero line is the official EA warning time" | Title: "**Earlier warning means more false alarms.**" Sub: "Each dot is a different 'act when the chance reaches X%' rule. Acting at a lower chance warns you earlier but cries wolf more often. Purple dot: the official EA warnings, scored the same way. Whiskers: how much this could change with different floods." Plot only "hours of warning before the flood". Move "vs official" to the table | **Yes**, on whiskers: "90% bootstrap interval: we re-ran the scoring on random re-samples of the past floods. 9 in 10 results fell inside the whisker." |
| P13 | Outlier "Mean lead vs official" **−223.6 h** at Cherwell, p* 70% (`proof.json` tradeoff) | It squashes the chart for that spot and looks like a bug | Follows from P12: drop that series from the chart | – |
| P14 | Table headings "p* · Hits · Misses · False alarms · Mean lead · vs official · Mean lead, 90% interval" (`SkillCharts.tsx:282-288`) | Jargon in every column | "Act at · Caught · Missed · False alarms · Average warning · Ahead of official (− = later) · Likely range of average warning" | – |
| P15 | "Some official issue times for this spot are known to the day only, so 'vs official' for those events is compared in whole days (multiples of 24 h)." (`SkillCharts.tsx:227-228`) | OK | "Some official warning times are known only to the day, so those comparisons are approximate (whole days)." | – |
| P16 | "Event by event" headings "Flooded? · Observed peak · Arrival error (50% time − crossing) · Lead vs official" (`TravelAndData.tsx:270-275`) | "Arrival error (50% time − crossing)" is a formula; the column is blank ("–") in 24 of 28 rows with no explanation (#99 item 6). "Observed peak" heights can't be compared across spots | "Did it flood? · Highest level (m, this gauge) · Timing error, hours (+ = forecast too late) · Hours ahead of official warning (− = later)" + footnote "– = the forecast 24 h before the flood never reached 1 in 2" | – |
| P17 | Footnote `testPeriodNote` (`TravelAndData.tsx:298`, text from `proof.json`): about 120 words with "strict time-split test period", "pool the trained gauges", "retrained without that event (+- 7 days)", "Repeat crossings within 72 h count as one flood" | It's a methods paragraph | Show one line, "Scores above come from forecasts the model never trained on (2021–2026). Flood counts come from replays of 7 past floods.", and put the full note in a "Details" expander | – |
| P18 | "The finding: flood travel times" headings "From · To · Events · T½ median · T½ 10–90% · Peak-to-peak median" (`TravelAndData.tsx:61-72`) | "T½", "10–90%", "Events" | "From · To · Past floods used · **Typical travel time** · Usual range · Peak to peak" | **Yes**, on "Typical travel time": as R22 |
| P19 | "* Fewer than 3 events: cross-correlation estimate only." and rows "Farmoor → New Botley: 0 *" (`TravelAndData.tsx:80,89`) | "cross-correlation", "0 events" | "* Fewer than 3 usable past floods: a rough estimate from lining up the two gauges' level records." | – |
| P20 | Scatter title "Cassington Weir B → New Botley: T½ vs rise"; x "Upstream rise (m, own datum)"; result "Bigger rises travel faster: 43.5 h per metre of rise." (`TravelAndData.tsx:92,98,117`) | "T½", "datum". "43.5 h per metre" is hard to picture: typical rises are well under a metre | Title: "**Bigger floods travel faster?**" x: "Size of the upstream rise (m)". Result: "Bigger rises arrive sooner: **about 4 hours sooner for every extra 10 cm of rise**." (43.48 h/m = 4.3 h per 10 cm) | – |
| P21 | "Cross-correlation by lag", y axis −1 to 1, tooltip "r", x "Lag" (`TravelAndData.tsx:138-146`) | Pure statistics | "**How well the two gauges line up at each delay** (the peak is the typical delay)". Or move it into a "Details" expander | – |
| P22 | "What the model looks at" / "Top 10 features by LightGBM gain." (`TravelAndData.tsx:203-204`) | "features", "LightGBM gain" | "The 10 clues the model relies on most." | "Ranked by LightGBM 'gain': how much each clue improved the model's predictions during training." |
| P23 | Feature labels "Rainfall, last 168 h", "Season (day-of-year sine/cosine)", "Eynsham Lock u/s: anomaly 24 h ago", "This gauge: 21-day mean level" (`TravelAndData.tsx:162-185`) | "168 h", "sine", "anomaly", "u/s" | "Rain, last 7 days" · "Time of year" · "Eynsham Lock: level vs its usual, 24 hours ago" · "This gauge: average level, last 3 weeks"; tooltip "Gain 0.116" → "12% of the model's total gain" | – |
| P24 | "Data quality and sources" heading **"Coverage"** (`TravelAndData.tsx:313`) | **The same word means something else 300 px higher** ("Interval coverage"). Here it means "share of hours with data" | "Data complete" | – |
| P25 | "Gaps filled · Gaps flagged · Spikes removed" (`TravelAndData.tsx:314-316`) | Somewhat technical | "Short gaps filled in · Gaps marked · Bad readings removed" | – |
| P26 | **"Threshold (API / config)"** showing **2.01 / 2.01** for New Botley (`TravelAndData.tsx:317,332`, `quality.json` `thresholdApi`) | **The values are the usual-high (amber) levels, not the flood levels** used everywhere else (New Botley floods at 2.76 m). A judge who compares the tabs sees two different "thresholds" | Rename to "Usual high (EA / ours)" (and check with the Data lead that `thresholdApi` is `typicalRangeHigh`) | – |
| P27 | Notes "Qualifier single (one-trace station), Hydrology API", "u/s (upstream stage of a lock or mill)", "typicalRangeHigh 0.12 m"; Osney/Godstow/Iffley at "0.7%" coverage (`TravelAndData.tsx:335`, `quality.json`) | Pipeline notes. A bare 0.7% will alarm a judge | Put the notes in a "Details" expander and add one line: "Osney, Godstow and Iffley lock gauges: live levels only (public history covers just 55 days), so we don't forecast them." | – |

### 1.6 About tab

| # | Current text (file:line) | Why it confuses | Plain-English replacement | Tooltip? |
|---|---|---|---|---|
| A1 | "…the half-rise travel time *T½*." (`About.tsx:11`) | Notation | "…how long it takes the middle of a flood rise to get from one gauge to the next (we call it the travel time)." | – |
| A2 | "Each river gauge is compared only with its own history (anomalies), never with another gauge's datum." (`About.tsx:14-15`) | "anomalies", "datum" | "We compare each gauge only with its own usual level, because every gauge measures from a different zero." | – |
| A3 | "One LightGBM model per gauge, lead time (6 to 72 h) and quantile gives the 5th to 95th percentile of future level, calibrated with conformal prediction." (`About.tsx:18-20`) | The densest sentence in the app | "A machine-learning model (LightGBM, a standard decision-tree method) predicts a **range** for the river level 6 hours to 3 days ahead, from a low guess to a high guess. We then adjust those ranges on past floods so that a '90% range' really holds the real level about 9 times in 10." | "Conformal prediction: a standard method that widens or narrows forecast ranges, using results on held-out data, so they hold the truth as often as they claim." |
| A4 | "The chance each trouble spot passes its flood threshold, and when that chance reaches 10%, 50% and 90%." (`About.tsx:23-24`) | "threshold", percentages | "The chance each spot reaches its flood level, and when that chance reaches 1 in 10, 1 in 2 and 9 in 10." | – |
| A5 | "skill against a 'level stays roughly where it is' baseline … a cost–loss rule" (`About.tsx:27-29`) | "skill", "baseline", "cost–loss" | "…scoring against the simple guess 'the river stays where it is' … and a rule for when acting is worth the cost." | – |
| A6 | "We show 90% bootstrap intervals." (`About.tsx:40`) | "bootstrap" | "We show how much each number could change with a different set of floods." | As P12 |
| A7 | "**Leave-one-flood-out can see the future.** … Strict time-split test results are reported separately on the Proof tab." (`About.tsx:43-46`) | The heading sounds like cheating, and "time-split" is jargon | "**Replays may have learned from later floods.** Each replay's model was trained without that flood, but it may have seen floods that came after it (the 2014 replay's model saw 2024). Our main scores use a separate test on 2021–2026 forecasts the model never trained on." | – |
| A8 | "**Thresholds are proxies.** They are the EA's 'property flooding is possible' gauge levels…" (`About.tsx:49-50`) | "proxies" | "**Flood levels are approximate.** They are the Environment Agency's 'property flooding is possible' gauge levels…" | – |
| A9 | "…in live mode it shows as stale…" (`About.tsx:64`) | "stale" | "…it shows as offline…" | – |
| A10 | Credits: "15-minute river level", "Nominatim and Overpass", "ECMWF IFS, 51 runs", "ODbL" (`About.tsx:83-141`) | Licence attribution has to stay precise | Keep as is (low priority for judges) | – |

---

## 2. The 30-second test

For each tab: the one thing a judge should take away in 30 seconds, whether today's screen delivers it, and a one-sentence headline for the top of the tab, generated from the data.

### River

- **Takeaway:** "Is anywhere in Oxford about to flood, and when?"
- **Does the screen deliver it?** Only partly. The answer is there, but only per spot: you click a dot, read "Low (< 10%)" and look at six 0% bars. The first thing on screen is probably the red "Live data unavailable" box (R1). Two of the five dots are grey with "timing only or stale" (R4). Nothing summarises all five spots.
- **Headline (today's data):** "**Right now: no flooding expected at Botley Road, Osney Island or Abingdon Road in the next 3 days (each under 1%). Every river gauge is below its usual high.** Cherwell: gauge offline since 13 Oct. Wolvercote: live level only."
- **How to generate it:** take `pFloodMax` over the non-stale `probability` spots in `live.json`.
  - If any spot is at 50% or more: "Flooding likely at {spot}: 1 in 2 chance by {arrival.p50}."
  - Else if any is at 10% or more: "Flooding possible at {spot}: 1 in 10 chance by {arrival.p10}."
  - Otherwise: "No flooding expected … in the next 3 days."
  - Add the count of gauges above their usual high (latest observed level > `amber`), and one clause for each stale or timing-only spot.

### Time Machine

- **Takeaway:** "In a real past flood, River Clock saw it coming, earlier than the official warning, without peeking at the future."
- **Does the screen deliver it?** No, not in 30 seconds. It opens on 20 Dec 2013, 17 days before the flood, on flat lines. At 1× it takes about 68 s of playing to reach the flood. The key sentence (T9) appears only once the slider has passed the crossing (by design: no spoilers). The fan chart has no legend (T4).
- **Headline, before the flood is revealed:** "**Replay the January 2014 flood at Botley Road as if it were happening now. Press Play: the forecast only knows what was measured up to each moment.**"
- **Headline, once the crossing is revealed:** "**River Clock gave Botley Road a 1 in 2 chance of flooding 37 hours before the river reached flood level, and 7 hours before the official Flood Warning.**"
- **How to generate it:** from `warnMatch` (`rc` → crossing = 37 h; `rc` → `official.issuedAt` = 7 h), using `tierSentence`'s reveal rule.
- **Smallest fix with the biggest effect:** open the replay about 3 days before the first crossing. The code already supports `?step=N`, so make that the default (Botley 2014: issue time 2014-01-03T00:00Z).

### Decide

- **Takeaway:** "Whether to act depends on what acting costs you. For a resident moving a car, even a small chance is worth acting on, and over past floods that rule would have cost far less than waiting for official warnings."
- **Does the screen deliver it?** Partly. A formula greets the judge first (D1). The money answer (£400 vs £6,120) is in the last card, probably below the fold. "p* = 1%" carries no meaning on its own (D4).
- **Headline (default preset and spot):** "**For a resident (moving the car costs £20, a flooded car £2,000), act once the flood chance passes 1%. Over 7 past flood episodes at Osney Island, acting on River Clock would have cost £400; acting on official warnings, £6,120.**"
- **How to generate it:** from the preset `{label, action, C, L}`, `optimalTrigger`, and `expectedCosts().strategies` (riverClock and official) for the selected spot.
- **Second line (live):** "Right now: under 1% at Osney Island. No need to act." (from `advice()`)

### Proof

- **Takeaway:** "It beats a simple guess at every forecast range, it caught the past floods, and it shows its weak spots openly."
- **Does the screen deliver it?** No. There are four technical charts, each introduced by a formula or term (pinball loss, nominal, Brier, p*). The strongest number (39% less error at 6 h) is a bare decimal on a y axis. The most visible element is a red nine-item "Coverage off" box that looks like failure (P6).
- **Headline (today's data):** "**Tested on 2021–2026 forecasts it never trained on, River Clock's error is 39% smaller than the simple guess 6 hours ahead and 11% smaller 3 days ahead. In replays of past floods, acting at a 1 in 2 chance caught every flood at all four forecast spots, with 0–3 false alarms per spot.**"
- **How to generate it:** first and last of `skillByLead[].skill`; for the second sentence, `tradeoff[spot]` at `pStar == 0.5`, taking min/max of `misses` and `falseAlarms` across spots. Today: misses 0 at every spot; false alarms Osney 2, Botley 3, Abingdon Road 0, Cherwell 0.
- **Caveat line to keep beside it:** "Weak spots: our ranges are wider than they need to be, and at Abingdon Road the flood chance is slightly worse than the simple guess from 24 hours ahead (Brier score)."

### About

- **Takeaway:** "How it works in one breath, and what it can't do."
- **Does the screen deliver it?** Partly. The five steps are the right idea, but step 3 is the densest jargon in the app (A3). The limitations are honest but long (nine bullets).
- **Headline (static):** "**River Clock measures how long a flood takes to travel down the Thames and Cherwell to Oxford, then reads today's upstream gauges to give five flood-prone streets a chance of flooding, hour by hour, for the next 3 days.**"

---

## 3. Top 10 confusion points, ranked

Ranked by (chance a judge hits it in a 4–5 minute visit) × (how badly it misleads). Each comes with the smallest fix.

1. **The Time Machine opens 17 days before the flood, on a chart with no legend.** It's the star demo, but at 1× it takes about 68 s to reach the flood, and the two blue bands, dashed line, black line and grey line are explained only in the hover tooltip (T4, T8). *Fix:* default the replay to about 3 days before the first crossing (`?step` logic already exists), and add a one-line legend under `FanChart`.
2. **The Proof tab opens with formulas** ("Skill = 1 − model pinball loss / persistence pinball loss", "nominal targets", "Brier skill", "calibrated"), and skill shows as a decimal (P1–P3, P5, P8, P10). *Fix:* turn the four card titles into questions ("Better than a simple guess?", "Do our ranges hold the real level?", "When we say 30%, does it flood 30% of the time?", "Earlier warning means more false alarms"), show skill as "% less error", and put the formulas in tooltips.
3. **The red "Coverage off by more than 10 points" box (nine items) reads as failure.** It actually means our ranges are too cautious, the safer error (P6, #99 item 2). *Fix:* replace it with one amber sentence: "Our ranges are too cautious: the 50% range held the real level 65–78% of the time."
4. **Decide opens with algebra** ("Acting costs C … P × L ≥ C … p* = C / L"), and the money answer is at the bottom (D1, D4). *Fix:* lead with the preset in words ("Moving the car costs £20, a flooded car £2,000, so act once the chance passes 1%") plus the £400 vs £6,120 headline, and move the formula behind a "Why?" tooltip.
5. **Two levels go by six names, and one table mislabels them.** "Flood threshold", "threshold", "Threshold crossed", "normal top", "amber" and "normal range" are all in use, and Proof's "Threshold (API / config)" column shows usual-high values (New Botley 2.01 m) while every other tab says New Botley floods at 2.76 m (P26). *Fix:* use two terms everywhere, "flood level" and "usual high", and rename that column "Usual high (EA / ours)".
6. **The River tab has no summary, and its first element may be a red "Live data unavailable" banner.** That happens whenever the API isn't running (R1). *Fix:* add the data-generated headline (Section 2) and a neutral "Forecast made Sat 24 Oct, 7:07 pm" notice. Keep the warning style only when the forecast is more than 6 h old.
7. **Chances are shown as "0%", "< 10%", "≥ 50%", and hours ahead as "+6 h … +72 h"** (R3, R6, R12, D6). A rounded 0% reads as "impossible", and offsets make the judge do sums. *Fix:* in `pct()` and `formatPct()`, show "under 1%" below 0.5%; in `ProbBars`, label rows with clock times (`formatShort`); in the legend, write "1 in 10" / "1 in 2".
8. **Grey dots and gauge names don't explain themselves.** "No probability (timing only or stale)", "Gauge data stale", "u/s", "d/s", "Weir B" (R4, R5, R9, R18). *Fix:* say why: "No forecast: gauge offline since 13 Oct" / "No long history: live level only". Add a display-name map that expands "u/s"/"d/s" and drops "A"/"B".
9. **The river strip's travel-time labels point at the wrong neighbour.** "≈ 23 h to Cold Harbour" sits between Farmoor and Eynsham, the subtitle relies on "T½" and "datum", and low-confidence pairs like Eynsham → New Botley "≈ 1 h" look wrong (R22–R25, #99 item 5). *Fix:* name both ends ("Farmoor → Cold Harbour: about 23 hours"), add the T½ tooltip, and grey out pairs with few floods.
10. **The "Lead time vs false alarms" chart puts two lines with different zeros on one axis.** Its caption says "the dashed zero line is the official EA warning time", which is true for only one of the lines, and Cherwell's −224 h outlier flattens the chart (P12, P13). *Fix:* plot only "hours of warning before the flood" with the purple EA dot, and move "vs official" to the table, labelled "Ahead of official (− = later)".

Close runners-up: the Time Machine's "no EA Flood Alert in the 72 h before it" sentence implies the EA gave no alert, though one went out on 23 Dec (T10). "Coverage" means two different things on the Proof tab (P24). The Time Machine never says the replay model hadn't seen this flood (T14).

---

## 4. Glossary (for an optional "?" panel)

Fifteen terms, each in plain English. Brackets show the label used in the app today, so the panel can link to it.

| Term | Plain English |
|---|---|
| **River gauge** | A sensor in the river that records the water height every 15 minutes. Each one measures from its own zero, so we only ever compare a gauge with its own past. |
| **Flood level** ("flood threshold") | The height on a spot's gauge at which the Environment Agency says property flooding becomes possible nearby. It's a good guide, not a guarantee that water reaches your door. |
| **Usual high** ("normal top", "amber") | The top of the river's normal range at that gauge. Above it, the river is higher than usual, but not necessarily flooding. |
| **Chance of flooding** ("pFlood", "P") | How likely the river is to reach flood level within a given time, e.g. "1 in 3 by Tuesday evening". |
| **Hours ahead** ("lead time", "+24 h") | How far into the future a forecast looks. River Clock looks 6 hours to 3 days ahead. |
| **Forecast range** ("interval", "quantiles", "5–95%") | Instead of one number, River Clock gives a range: a likely range (the river should be inside about half the time) and a wide range (about 9 times in 10). |
| **Travel time** ("T½", "half-rise travel time") | How long a flood rise takes to get from an upstream gauge to Oxford: from when the upstream gauge is halfway up its rise to when the downstream one is halfway up its own. We take the middle value over past floods. |
| **The simple guess** ("persistence") | A basic forecast: the river stays where it is now, give or take its usual ups and downs. A forecast that can't beat this isn't worth much. |
| **Skill** | How much smaller River Clock's error is than the simple guess's. A skill of 0.27 means 27% less error; 0 means no better; below 0 means worse. |
| **Range check** ("coverage", "calibration") | How often the real level actually landed inside our ranges. A 90% range should catch it about 90% of the time. Ours catch it more often, so our ranges are cautious. |
| **Honest chances** ("reliability") | Whether our percentages mean what they say: of all the times we said 30%, did it flood about 30% of the time? |
| **Brier score** | An error score for flood chances: the average squared gap between the chance we gave (0–1) and what happened (flooded = 1, didn't = 0). 0 is perfect; lower is better. |
| **Act-at chance** ("p*", "trigger") | How sure you need to be before acting. It equals what acting costs divided by what you'd lose: £20 to move a car ÷ £2,000 of damage = act at 1%. |
| **Caught / missed / false alarm** ("hit / miss / false alarm") | Caught: we reached your act-at chance before the flood (within 3 days). Missed: it flooded and we didn't. False alarm: we reached it and no flood came within 3 days. |
| **Replay** ("Time Machine", "leave-one-flood-out", "backtest") | Re-running a past flood hour by hour with a model that was trained without that flood and never sees anything after "now". Our headline scores use a stricter test: 2021–2026 forecasts the model never trained on. |

(The Environment Agency's own message levels, Flood Alert ("flooding is possible, be prepared") and Flood Warning ("flooding is expected, immediate action required"), belong in the T6 tooltip, so they aren't counted among the 15.)

---

## 5. Notes for the implementer

- **Where the strings live.** Most of them are in five places:
  - `components/shared/forecast.ts`: `LEVEL_STYLE`, `arrivalSentence`, `pct`
  - `components/timemachine/timeline.ts`: `tierSentence`
  - `lib/costLoss.ts`: `PRESETS`, `STRATEGY_LABELS`, `LIVE_REASON`, `advice`, `formatPct`
  - `components/proof/SkillCharts.tsx`
  - `components/proof/TravelAndData.tsx`
- **Strings owned by other teams.** Station names (`stations.json`, Data) and `testPeriodNote` (`proof.json`, Model) come from data files. A display-name map in `web/` avoids a contract change. The risk-map legend (`geo/risk_layers.json`) belongs to whoever owns S1.
- **Tests that pin today's wording** and will need updating together with the strings:
  - `lib/costLoss.test.ts:212-215` (the `advice` text)
  - `components/timemachine/timeline.test.ts:91,128,143,234` (`tierSentence`, `arrivalSentence` regexes)
  - `views/About.test.tsx` (credit and disclaimer strings: keep those)
  - `components/proof/labels.test.ts` (`featureLabel`, `travelEventLabel`)
  - `components/shared/DataNotice.test.tsx`
- **Overlap with #99.** Items 2, 3, 5 and 6 there are the number-side twins of P6, D14, R25 and P16 here. Fix each pair in one place.
- **Accuracy notes.**
  - pFlood is P(level ≥ flood level at hour h), made non-decreasing in h (SPEC §7.5), so "chance of flooding within 24 hours" is a fair plain reading.
  - Skill is 1 − pinball(model)/pinball(persistence), so "X% less error" is accurate and "X% more accurate" is not.
  - Travel-time figures are medians over past floods.
  - Hit and false-alarm counts are flood episodes (crossings at least 72 h apart), not named events.
