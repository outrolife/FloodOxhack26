# Presentation research: making River Clock judge-first

Part of #103. Research on how winning UK student hackathon projects presented, how walk-up judging works, how to communicate forecasts to the public, and which UI patterns make a dashboard readable in 30 seconds. Every River Clock number below comes from `docs/judges.md` / `docs/demo.md` (committed JSON). Sources are numbered [n] at the end.

## The one thing to know first

OxHack 2026's Devpost page lists the judging criteria as **Creativity, Technicality, Completeness, Presentation / Hackathon Spirit**. Alongside First Place and Runner Up, it offers **[HRT] Best Use of Data for Predictions and Decision Making** and **[MLH] Best Use of Tiger Data** [1]. The same HRT prize at IC Hack 26 went to **WildFire**, a wildfire-spread predictor built "to inform emergency service decisions" [2][3]. River Clock is a forecast that ends in a decision (the Decide tab). The pitch should say the words "prediction" and "decision" in its first minute and show both.

## Top 10 recommendations (ranked by impact per hour of work)

| # | Where | Change | Why (source) | Effort |
|---|---|---|---|---|
| 1 | **Pitch / Time Machine** | **Open on the 2014 replay, already paused at the 50% marker** (Botley Road, 10:00 on Sat 4 Jan). Say the result before explaining anything: "River Clock called it 9 hours before the EA's flood warning, and 39 hours before the river crossed the flood line." Explain how it works after that. | Judges say to show something working within about 90 s and to give "the anchor first, then the story" [4][5]. One "oh, this is possible now" moment beats a tour [4]. | 15 min (demo.md + table setup) |
| 2 | **Pitch** | **Name the prize criteria out loud.** Say "prediction" and "decision" for HRT, show the Tiger Data query in one line, and finish with "complete: it runs offline, end to end". | Judges score against the published criteria. Read the rules and know what the judges look for [1][4][6]. | 15 min |
| 3 | **River tab, top of SpotPanel** | **Add one plain-English headline per spot**, above the chips and bars. For example: "**Botley Road: about a 1 in 3 chance (32%) of flooding by Tuesday 6 pm.** If it floods, most likely from Monday night." Define "flooding" once, as the reference event: "the river at New Botley above 2.76 m, the level above which GOV.UK says property flooding is possible." (The numbers in this example are made up; use the live values.) | People read "30% chance" in conflicting ways unless the event and time window are stated [7]. Words plus numbers work better than either alone [8]. Natural frequencies are easier to reason with [9]. | 1–2 h |
| 4 | **Time Machine fan chart** | **Put three callouts on the chart itself**, at the moment each happens: "River Clock: 50%, Sat 10:00", "EA Flood Warning, 9 h later", "River crosses the flood line, Mon 01:00". Also label the band "likely range (5–95%)" directly on the chart, not in a legend. | Readers preferred heavily annotated charts and were not put off by them [10]. Text near the data shapes what readers take away [10][11]. | 1–2 h |
| 5 | **Every tab** | **Give each tab and chart a title that states its takeaway**, not its type. For example, Proof: "We beat 'nothing changes' at every lead time, most at 6 h". Time Machine: "In 2014 we called Botley 9 h before the official warning". River already does this well ("The water is already on its way"). | What people recall of a chart follows its title more often than the chart itself [11][12]. | 1 h |
| 6 | **All tabs (from the jargon audit)** | **Swap jargon for everyday words, each with a "what's this?" tooltip.** persistence → "'nothing changes' baseline"; pFlood → "chance of flooding"; p* → "act when the chance is above…"; amber → "above normal"; quantile / 5–95% → "likely range"; coverage → "how often the range held the real level"; Brier / pinball → only behind "For experts". | Progressive disclosure: show the most important information first and the specialist detail on request [13]. | 2 h |
| 7 | **Proof tab** | **Lead with one headline number and one honest limit.** "Over 7 past events, River Clock (at each spot's alarm level) caught 29 of 30 floods, with 0–3 false alarms per spot; the miss is the July 2007 summer storm at Botley. Against the EA it's mixed: earlier at 12 of the 19 floods where both warned." Fold the reliability diagram, coverage and pinball charts into a "For experts" section. | Being direct about what doesn't work "reads as confidence" [4]. Judges aren't experts, so show one number and keep the rest for those who ask [5][13]. | 1 h |
| 8 | **Decide tab** | **Put the verdict first, then the chart.** "If you're a Botley resident moving your car (£20 to act vs £2,000 of damage), act when the chance passes 1%. Right now it's X%: **not yet** / **act now**." Show the cost bars underneath as the evidence. | Turning the forecast into a decision is what the HRT prize asks for [1]. Uncertainty displays help lay users when they are tied to a concrete decision [14][15]. | 1 h |
| 9 | **River map, chips, banner (with #101)** | **Use words and shapes as well as colour, and keep away from official vocabulary.** Never say "Flood Alert", "Flood Warning" or "Severe" for our own outputs, and don't copy the yellow/amber/red warning matrix. Use labels such as "Normal / Above normal / Flood likely" with an icon. | The EA's terms carry official meanings ("flooding is expected, act now") [16]. The Met Office and the Flood Forecasting Centre colour codes are likelihood × impact matrices [17][18]. About 1 in 12 men has a colour-vision deficiency, so colour needs a text label too [19]. | 1 h |
| 10 | **App shell** | **Add a three-step "Start here" strip**, dismissible, shown on first visit: ① The water travels (River) → ② Replay 2014 (Time Machine) → ③ Would it have helped you? (Decide). Each step is a button that sets up the right view. | Gives a walk-up judge who drives the laptop one complete path [5]. ShotFinder (IC Hack 26) has a "chip that tells the user exactly what they are seeing" [20]. | 2 h |

**Cheap extras if there is time:** show the arrival time as a window ("most likely Mon 01:00; likely between Sun 18:00 and Mon 10:00") rather than one time, since frequency-style displays of arrival times improve lay decisions [14][15]. Let the judge drag the Time Machine slider themselves; interactive projects are the memorable ones (DurHack X's 1st place, Clap Collider, was something you play with [21]).

## Suggested 60-second opening

*(Laptop on the Time Machine: Jan 2014, Botley Road, paused at the River Clock 50% marker.)*

> "This is Botley Road in January 2014. At 10 am on Saturday the 4th, River Clock said Botley Road was more likely than not to flood, with the water arriving around 1 am on Monday. The Environment Agency's flood warning came nine hours later. The river crossed the flood line at 1 am on Monday, 39 hours after our call.
>
> How? Oxford floods slowly, from upstream. The water that floods Botley is already in the river at Cassington about nine and a half hours earlier; we measured that from 24 past floods. River Clock reads the upstream gauges like a clock and gives five Oxford spots a chance of flooding and an arrival time, hour by hour, for the next three days. Then it tells you whether it's worth acting yet.
>
> And we check ourselves. Every past flood is replayed with a model trained without it, and scored against 'nothing changes'. We beat that at every lead time, and where the EA beats us, the app says so. It's a student prototype, not an official warning. Let me show you what it says about Oxford today."

## 4-minute flow

| Time | Tab | What to show | Line to land |
|---|---|---|---|
| 0:00–1:00 | **Time Machine** | The opening above. Press Play: the band narrows and the 3.03 m peak lands inside it. | "Called it 9 h before the warning." |
| 1:00–1:45 | **River** | The river strip: Cassington → New Botley 9.5 h (24 floods), Enslow → Kings Mill about 19 h. Then today's headline sentence for one spot. One line on data first: "In the first hour we found the lock gauges had no usable flood history, so we switched gauges." | "The water is already on its way." |
| 1:45–2:30 | **Decide** | Resident preset, verdict first; then switch to Council. | "Prediction → decision: act when the chance passes cost ÷ loss." |
| 2:30–3:30 | **Proof** | The headline result, then the honest limits: mixed against the EA, ranges too wide (90% holds 94–98%), and the 2026 near miss (highest chance just under 30%: no false alarm at any spot's alarm level). | "We'd rather show you a weakness than a made-up number." |
| 3:30–4:00 | **About / close** | Tiger Data in one line (3.29 M rows, 434 MB → 35 MB). The disclaimer. | "One finding, one model, one baseline, honest proof." |

Keep the leave-one-flood-out caveat (the 2014 model has seen 2024) and the reliability diagram for questions. One judge's advice: "Pick the sentence you want a judge to repeat to another judge an hour later" [5]. Ours: **"It called the 2014 Botley flood 9 hours before the official warning, and it shows you where it's wrong."**

## Wording: do / don't

**Do**
- State the event and the window: "chance the river at New Botley passes 2.76 m **by Tue 18:00**" [7].
- Give words and a number together: "about 1 in 3 (32%)", "more likely than not (63%)" [8][9].
- Give arrival times as a likely window, in local time (GMT on judging day).
- Say "River Clock suggests…" or "our forecast". Link "Official warnings: gov.uk/check-flooding" next to every forecast.
- Compare with things people know: the EA's warning time, "nothing changes", a working day (9.5 h).
- Name each weakness in plain words: "too cautious", "later than the EA at Botley".

**Don't**
- Don't use the EA's terms for our outputs ("Flood Alert", "Flood Warning", "Severe Flood Warning") or the yellow/amber/red warning matrix [16][17][18].
- Don't use bare verbal probabilities ("likely") without a number; people read them as less extreme than intended [8].
- Don't use return periods ("1-in-100-year"); people hear "once a century" [22]. Our "1 in 3" is a chance for this event, so always say "chance".
- Don't show a single centre line without its range; people fixate on the line [23], or read the range as a fixed value [24].
- Don't rely on colour alone [19]. Don't say "accuracy" for a probability score.
- Don't let the 2014 example suggest we always beat the EA. Averaged over all seven events, at Botley the EA was earlier.

## What the research says (short)

**Winning UK student hackathon projects (Devpost, verified).** These UK events give mostly track and sponsor prizes. Only DurHack X lists 1st and 2nd places on Devpost, and the IC Hack 24 gallery shows no winner badges. The lessons below come from the projects' Devpost write-ups, not from seeing their live demos.

1. **WildFire**, IC Hack 26, *HRT Best Use of Data for Predictions & Decision-Making* [3]. Map first, then a model comparison, then a Monte Carlo spread, then "what if" mitigation. *Lesson:* end the prediction in a decision; this is the same prize we can enter.
2. **SafeStep**, IC Hack 26, HRT honourable mention [25]. Tagline: "Transform raw safety data into actionable routes." *Lesson:* the one-line tagline names what the user gets.
3. **Optimised Maritime Routing**, IC Hack 26, *DoCSoc Best Ecosystem Support* [26]. Probabilistic risk from Monte Carlo, checked against "real past oil spills". *Lesson:* replaying real past events earns trust, as our Time Machine does.
4. **ShotFinder**, IC Hack 26, Sports honourable mention [20]. A "zen mode chip that tells the user exactly what they are seeing". *Lesson:* a plain-language status line for the current view.
5. **Causalitree**, IC Hack 25, Marshall Wace honourable mention [27]. Sells a "clean, friendly, easy-to-use interface" and a tree metaphor. *Lesson:* one strong metaphor; ours is the clock.
6. **Niche Machine**, DurHack X, G-Research "crystal ball" prize [28]. A LightGBM model (like ours) inside a 3D-printed crystal ball you rub. *Lesson:* a physical metaphor makes a gradient-boosting model memorable.
7. **Clap Collider**, DurHack X, *1st place* [21]. You clap to make music. *Lesson:* let the judge drive.
8. **Flood Rescue Line**, Hack Cambridge Atlas, Twilio prize [29]. Opens with a dated event: "On the 17th of December 2021, one month's worth of rain fell in a single day…" *Lesson:* open with a specific, dated flood.
9. **Toku** and **HearSight**, Hack Cambridge Atlas, main challenge winners [30][31]. Each names a concrete human problem in its first line (cost of living; helping blind people navigate). *Lesson:* lead with the person, not the tech.

I found no OxHack winners online to compare with: Oxford Hack 2020 and 2022 winners were all track prizes, none data or forecasting projects [32].

**Walk-up judging.** MLH recommends science-fair judging. It budgets about 2 minutes for presentation and demo plus 1 minute for questions, and asks for "a demo of their hack, not a presentation" [6]. Judges' advice agrees: open with "a tool that does X for Y", rehearse the first 30 seconds ("that is where the score is set"), show one complete path, keep a 60-second backup recording, and use at most one screenshot of slides [5]. Show it working within about 90 s, mock or pre-fill anything that could stall, and be direct about what doesn't work [4].

**Forecast and risk communication.** The Met Office and the FFC's Flood Guidance Statement grade risk by likelihood × impact on a 4×4 matrix. Their colours have official meanings, so we must not mimic them [17][18]. The EA's own wording is short and action-led: an alert means flooding is possible, prepare now; a warning means flooding is expected, act now [16]. Single-event probabilities confuse people unless the reference class is stated. In one survey, people read "30% chance of rain" as 30% of the time or 30% of the area [7]. The Met Office says it means the chance at any one place, "such as your garden" [33]. Pair words with numbers [8]. Frequency formats such as natural frequencies and quantile dotplots improve lay estimates and decisions [9][14][15]. Uncertainty graphics are often misread: the hurricane cone [23], and the "deterministic construal error" of reading a range as a single value [24]. The display that works best depends on the audience and its purpose [34].

**"Absorbable in 30 seconds" patterns.** These patterns help: a headline sentence first, takeaway titles [11][12], annotations on the chart [10], progressive disclosure with an "experts" fold [13], a status chip saying what you're looking at [20], text plus shape for status [19], and one guided path [5].

## Sources

1. OxHack 2026, Devpost overview, prizes and judging criteria: https://oxhack-2026.devpost.com/
2. IC Hack 26, Devpost prizes and judging criteria (Creativity, Utility, Technical Achievement): https://ic-hack-26.devpost.com/
3. WildFire (IC Hack 26, HRT winner): https://devpost.com/software/wildfire-rcz2xb
4. K. Druckman, "How to Win a Hackathon: Notes From the Judging Table", JetBrains blog, Jun 2026: https://blog.jetbrains.com/ai/2026/06/how-to-win-a-hackathon-notes-from-the-judging-table/
5. "What judges actually score: notes from a year of hackathon judging", DEV Community: https://dev.to/kurbaitaev/what-judges-actually-score-notes-from-a-year-of-hackathon-judging-3p4l
6. MLH Hackathon Organizer Guide, "Judging plan": https://guide.mlh.com/general-information/judging-and-submissions/judging-plan
7. Gigerenzer et al. (2005), "A 30% chance of rain tomorrow: how does the public understand probabilistic weather forecasts?", *Risk Analysis*: https://researchonline.lse.ac.uk/id/eprint/16975
8. Budescu, Broomell & Por (2009), IPCC verbal probabilities, *Psychological Science* (coverage): https://www.shapingtomorrowsworld.org/uncertainty_in_climate_change_2.html
9. Natural frequencies (Hoffrage & Gigerenzer 1998), summary: https://www.r-bloggers.com/2010/12/some-ideas-on-communicating-risks-to-the-general-public/amp/
10. Stokes, Setlur, Cogley, Satyanarayan & Hearst, "Striking a Balance: Reader Takeaways and Preferences when Integrating Text and Charts": https://www.tableau.com/research/publications/striking-balance-reader-takeaways-and-preferences-when-integrating-text-and
11. Kong, Liu & Karahalios (CHI 2018), "Frames and Slants in Titles of Visualizations on Controversial Topics": https://mail.zcliu.cs.umd.edu/vistitles/CHI18-VisTitles.pdf
12. Kong et al. (CHI 2019), "Trust and recall of information across varying degrees of title-visualization misalignment": https://experts.illinois.edu/en/publications/trust-and-recall-of-information-across-varying-degrees-of-title-v/
13. Progressive disclosure (J. Nielsen): https://uxtigers.com/post/progressive-disclosure and https://en.wikipedia.org/wiki/Progressive_disclosure
14. Kay, Kola, Hullman & Munson (CHI 2016), "When(ish) is My Bus?": https://idl.uw.edu/papers/when-ish-is-my-bus
15. Fernandes et al. (CHI 2018), "Uncertainty Displays Using Quantile Dotplots or CDFs Improve Transit Decision-Making": https://idl.uw.edu/papers/uncertainty-bus
16. GOV.UK, "Flood alerts and warnings: what they are and what to do": https://www.gov.uk/guidance/flood-alerts-and-warnings-what-they-are-and-what-to-do
17. Met Office, "How are weather warnings categorised?": https://www.metoffice.gov.uk/blog/2025/how-are-weather-warnings-categorised
18. Flood Forecasting Centre, "Flood Guidance Statement user guide": https://www.gov.uk/government/publications/flood-guidance-statement-fgs-user-guide/flood-guidance-statement-user-guide
19. NHS Scotland Turas design system, "Status palette" (colour vision deficiency, text and shape cues): https://www.turasdesignsystem.nhs.scot/design/data-visualisation/status-palette/
20. ShotFinder (IC Hack 26): https://devpost.com/software/score-finder
21. Clap Collider (DurHack X, 1st place): https://devpost.com/software/clap-collider
22. "100-year flood" terminology: https://en.wikipedia.org/wiki/100-year_flood and https://www.asce.org/publications-and-news/civil-engineering-source/article/2026/08/26/that-will-never-happen-again-how-our-flood-risk-language-needs-to-evolve
23. Broad et al. (2007), "Misinterpretations of the 'Cone of Uncertainty' in Florida during the 2004 Hurricane Season", *BAMS*: https://climatecommunication.yale.edu/publications/misinterpretations-of-the-cone-of-uncertainty-in-florida
24. Joslyn & Savelli (2021), "Visualizing Uncertainty for Non-Expert End Users: The Challenge of the Deterministic Construal Error", *Frontiers in Computer Science*: https://www.frontiersin.org/articles/10.3389/fcomp.2020.590232/full
25. SafeStep (IC Hack 26): https://devpost.com/software/safestep-6ci719
26. Optimised Maritime Routing to Protect Coastal Ecosystems (IC Hack 26): https://devpost.com/software/optimised-maritime-routing-to-protect-coastal-ecosystems
27. Causalitree (IC Hack 25): https://devpost.com/software/causalitree
28. Niche Machine (DurHack X): https://devpost.com/software/niche-machine
29. Flood Rescue Line (Hack Cambridge Atlas): https://devpost.com/software/flood-rescue-line
30. Toku (Hack Cambridge Atlas): https://devpost.com/software/otoku
31. HearSight (Hack Cambridge Atlas): https://devpost.com/software/hearsight
32. Oxford Hack 2022 and 2020 project galleries: https://oxford-hackathon-2022.devpost.com/project-gallery · https://oxford-hack-2020.devpost.com/project-gallery
33. Probability of precipitation, with the Met Office definition: https://en.wikipedia.org/wiki/Probability_of_precipitation
34. Spiegelhalter, Pearson & Short (2011), "Visualizing Uncertainty About the Future", *Science* 333: https://www.stat.berkeley.edu/users/aldous/157/Papers/spiegelhalter_visualizing.pdf
