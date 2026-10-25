# Improving forecast accuracy: follow the rivers

Part of #134. Research only, no code changes. Written Sat 24 Oct 2026, 21:45–23:30 UTC, by s-s01s-research3. All times are UTC. Sources are numbered [n] at the end. Numbers marked **(probe)** come from Hydrology API calls made tonight. They are cached under `data/raw/hydrology_dailymax/` and `data/raw/hydrology_probe/` (gitignored), one request per gauge, or per gauge-year.

**Not repeated here:**
- #100: rain forecasts, not adopted.
- #125: A, further-upstream gauges, adopted for newbotley + minns only; B, derived features, pending; C, regime CQR, not adopted.
- #134: soil moisture and noise-aware rain, running.
- `docs/research/earlier-warnings.md`, which covers predictors for lead time against the EA.

This note is about **accuracy**: which inputs to give the one LightGBM quantile model, and how, without a second model (SPEC §1.1).

## Answer for the user: "won't more gauges help, since the water must come from somewhere?" (≤ 120 words)

> Partly. A gauge helps when its river really flows into the flood spot and its water takes longer to arrive than we're forecasting ahead. That's why six far-upstream Thames, Windrush and Evenlode gauges gave Botley 36 h more warning in Jan 2024. But each gauge has only 5–7 recorded floods behind it, and each one adds about nine numbers to the model. With so few floods, the model starts fitting coincidences. That cost Abingdon Rd and the Cherwell some accuracy at 72 h. The Cherwell also rises within about a day of the rain, so no river gauge can see three days ahead there. The fix: follow the rivers and merge each branch into one timed signal.

## The river walk, for the user and the judges (≤ 120 words)

> We trace each spot's water back upstream, like a family tree. Botley's water comes down the Thames, which is fed by the Windrush, the Evenlode and the Cotswold streams. The Cherwell's comes from Banbury and the Ray. Every EA gauge on those branches is a candidate; we know roughly how many hours its water takes to reach Oxford. Rivers joining below Oxford, like the Ock and the Thame, are left out: their water never reaches our spots. Instead of feeding the model every gauge separately, we merge each branch into one signal, "what is coming down this river, and when", timed by its travel time. The model gets the physics with far fewer numbers to learn.

## TL;DR: ranked for the 02:00 GMT retrain

| # | Change | Expected effect | Evidence | Exact change | Time | Risk for 02:00 |
|---|---|---|---|---|---|---|
| 1 | **Keep A per target** (newbotley + minns, as the PM adopted). Treat it as the first step of the river walk. | As measured on #125: Botley 36/48 h skill +0.04/+0.03, e2024a Botley +36 h. | #125 A results; [1][2][3] | None beyond the A PR. | 0 | Already accepted (+1 near-miss false alarm, reported) |
| 2 | **Per-branch routed signal for coldharbour and kingsmill** ("A-branch"): 1–2 columns per tributary instead of ~9 per gauge. | Keeps most of A's 24–48 h gain at these spots (coldharbour 36 h −0.005 → +0.086, 48 h −0.153 → −0.033; kingsmill 24–48 h +0.04 to +0.06), without the 72 h loss (−0.02 to −0.03). **Not measured yet.** | [1][2][3][4]; the A importance and skill pattern below | See §2.3: about 5 new columns at coldharbour and 2 at kingsmill, built from the A gauges already prepared. | ~1.5 h code + tests, ~30–45 min train and score with the A harness | **Medium.** Doable only if the A owner starts by about 23:45 GMT. Otherwise it's a post-hackathon item, and those spots stay at baseline (no harm) |
| 3 | **Cheap diagnostic sub-arm:** the A variant for coldharbour/kingsmill with `feature_fraction` 0.8 → 0.5 | If the 72 h loss comes from too many correlated columns, this recovers part of it with no feature code. | Random subspace / bagging regularisation [5][6] | One parameter for two targets, in the A harness only | ~15 min plus training | Low, but it departs from the single §7.3 parameter set. Adopt only with a SPEC note |
| 4 | **Extend training back to each target's first record** (2002 Thames, 1998 Kings Mill; *not* 1986: the targets have no data before then) | **+1 flood each** at newbotley, coldharbour and kingsmill (all Jan 2003; coldharbour's 2.738 m is its record), 0 at minns. High-water days +15% newbotley, +59% kingsmill. Small but positive, mostly in the upper quantiles and at Kings Mill. | §3 counts (probe); more data helps tree models most when data is scarce [4] | `pipeline.ingest_history --start 1998`, re-clean, publish `data-hourly-v2`, retrain. Splits unchanged (§3.3). | Ingest a few minutes (< 1 s per gauge-year, probe); clean, publish and retrain with the planned run | **Low–medium.** Adds a third simultaneous change to the combined retrain. Do it only if Data can publish v2 by 01:15 GMT |
| 5 | **Walk the rain too:** catchment rain from gauges inside the upstream area | Better rain features for the 24–72 h leads that upstream gauges can't reach. 3 of the 5 rain gauges (Abingdon, Benson, Wheatley) are outside the area draining to our spots. | `config/stations.yaml` coordinates; SPEC §4.1 | New rain gauges (Cotswolds, Banbury area) in the pipeline | 2–3 h with ingest | Post-hackathon |
| 6 | **#125 B derived features: adopt one version of each, no stacking** (upstream rise rate, rolling max over the travel window, target 72 h max) | Owned by #125 B; pending | #125 | Per B's results | — | Per B's adoption rule |

**Not tonight:** monotone constraints (LightGBM 4.7.0 refuses them with the quantile objective, tested below), raw "all gauges" inputs, re-running `make travel`, flood-period re-weighting, tuning hyperparameters on the test period, history before the target gauges' records. Details in §5.

---

## 1. When do more gauges help? The evidence

**Rule 1: only connected gauges carry signal.** A data-driven model learns a mapping from inputs to the target. An input that isn't causally linked to the target (here, a gauge that doesn't drain to the spot) can only contribute through chance correlation in the training sample. Input selection is a known critical step for data-driven water models: Bowden, Dandy and Maier [1] showed that formal input selection (partial mutual information) gave more parsimonious models with lower forecast error than ad hoc input sets. Maier et al. [2] reviewed 210 river-system papers and found that input selection was still mostly ad hoc. Galelli et al. [3] built a benchmark framework for it because poor input selection is a common failure point in environmental models. The closest operational analogue to FloodClock is the Garonne study [7]. Its gradient-boosting, linear and MLP models took **anomalies of selected upstream stations**, mirroring the operational lag-and-route model, and beat lag-and-route at 6 h. Their data set had 36 floods in 15 years, and the authors note that "the scarcity and the heterogeneity of the data heavily weigh on the learning strategy". That is our situation exactly.

**Rule 2: the gauge's travel time must be comparable to the lead time.** An upstream gauge tells the model about water that is already in the river. That information is worth most at leads up to the travel time and fades after it. Beyond that, the future depends on rain that hasn't fallen yet. That's why rain forecasts (#100) and wetness (#134) are the levers at 72 h, not more gauges.

**Rule 3: with few floods, every extra column costs something.** A tree model chooses splits greedily. With hundreds of correlated columns and a handful of flood episodes, some splits on noise look good in training. The cost shows up as wider or shifted quantiles at the leads where the real signal is weakest. Tree models hold up well on small data sets compared with deep models [4], but they're not immune to spurious splits.

### 1.1 Why A helped Botley but hurt Abingdon Rd and the Cherwell at 72 h

Facts from #125 A, the shipped importance file and tonight's counts:

| | newbotley | minns | coldharbour | kingsmill |
|---|---|---|---|---|
| Floods (≥ threshold) in training, 2006–2018 (probe, daily max, separated by > 7 days) | 6 | 5 | 6 | 4 |
| High-water days in training (daily max > amber − 0.3 m, the §7.3 weight line) | 391 | 273 | **49** | 184 |
| Matched events per new A gauge (§6) | 17–24 | 14–20 | **4–7** | **5–7** |
| Columns: baseline → A | 38 → ~92 | 35 → ~89 | 40 → ~94 | 31 → ~49 |
| A skill Δ at 24 / 48 / 72 h | +.04 / +.03 / +.01 | +.03 / +.02 / +.01 | .00 / +.12 / **−.03** | +.05 / +.06 / **−.02** |
| Brier Δ, 72 h (A) | better | better | better (.0036 → .0033) | same |

Three things explain the pattern:

1. **Coldharbour has very few informative rows.** It has 49 high-water days in 12 training years (Botley has 391), and only 4–7 matched events per new gauge, so the new gauges' lags are poorly pinned down. The A importance shows the new gauges taking 36–39% of the gain at coldharbour, but test skill at 72 h fell. High in-sample use with no out-of-sample gain is the textbook overfitting signature (Rule 3).
2. **Kings Mill's 72 h lead is beyond its rivers' memory (Rule 2).** The new Cherwell inputs arrive at lag_main 37 h (Banbury) and 39 h (Lower Arncott). The Cherwell and Ray drain clay and respond quickly (BFIHOST 0.59 and 0.49 [8]). In the shipped kingsmill model, the top 72 h features are `level_now`, season and rain; no upstream gauge is in the top six. At 72 h the new columns can only add variance.
3. **"Hurt" is small and mostly on quiet days.** The losses are 0.02–0.03 of pinball skill at 72 h only. Coldharbour gained +0.09 and +0.12 at 36 and 48 h, and Brier was the same or better at every spot. C's analysis on #125 shows that 72 h pinball is dominated by calm-weather rows. So A didn't make the flood calls worse at those spots. It made the 72 h ranges slightly worse, and that failed the pooled rule.

**The principled fix** is not "fewer gauges" but **fewer, better columns per gauge branch**. Select inputs by flow path (the river walk, §2), then aggregate each branch into a routed signal (§2.3), so a target with 49 high-water days learns 1–2 numbers per tributary instead of 9 per gauge.

## 2. The river walk

### 2.1 The graph

Gauges are snapped to branches by the Hydrology API `riverName` and position (probe: `/hydrology/id/stations?observedProperty=waterLevel`, 368 stations within 45 km). Order runs from the source down to Oxford. "Since" is the Hydrology station's opening year. Check the 15-min series start (the A table on #125 lists the verified ones). Gauges marked **lock** are lock u/s traces, which the weir holds nearly flat in floods (Osney and Godstow u/s, §4.1.1; Buscot was muted in A). They need a responsiveness check before use.

```yaml
# config/rivers.yaml-style sketch (docs only; the Data lead owns config/)
thames:                      # main stem, source -> Oxford
  - {key: ewen,        ref: 0130TH, since: 1979}
  - {key: cricklade,   ref: 0190TH, since: 1972}          # Churn and the Wiltshire Ray join near here
  - {key: hannington,  ref: 0569TH, since: 1995}          # in A
  - {key: buscot,      ref: 0898TH, since: 1995, lock: true, note: "muted in A, excluded"}   # Coln, Leach, Cole join at Lechlade/Inglesham
  - {key: radcot,      ref: 0902TH, since: 2002, lock: true}
  - {key: shifford,    ref: 0904TH, since: 2002, lock: true, note: "in A, responsive"}
  #  <- Windrush joins at Newbridge
  - {key: northmoor,   ref: 1099TH, since: 1995, lock: true}
  - {key: farmoor,     ref: 1100TH, since: 1992}          # current upstream
  - {key: eynsham,     ref: 1201TH, since: 2000, lock: true, note: "u/s series, current upstream"}
  #  <- Evenlode (+ Glyme) joins near Cassington / Kings Lock
  - {key: godstow,     ref: 1302TH, live_only: true}
  #  Seacourt Stream (minns 1635TH) and Bulstake Stream (newbotley 1645TH) branch off around Botley
  - {key: osney,       ref: 1303TH, live_only: true}
  #  Hinksey Stream (coldharbour 1675TH) runs south of Osney
  #  <- Cherwell joins below Folly Bridge, downstream of all three Thames-side targets
  - {key: iffley,      ref: 1501TH, live_only: true}
  #  Ock (Abingdon) and Thame (Dorchester) join further downstream: NOT upstream of any target
windrush:  [bourton 1020TH (1995), worsham 1080TH (Hydrology 1988, in A), witney 1082TH (2008), ducklington 1084TH (1999)]
evenlode:  [moreton 1208TH (2009), evenlode_bridge 1210TH (2002), shipton 1238TH (1998, in A), cassington 1290_w2TH (1986, current)]
glyme:     [woodstock 1289TH (1997)]            # joins the Evenlode
coln:      [fossebridge 0630TH (1990), bibury 0660TH (1961), fairford 0680TH (1991)]
leach:     [lechlade 0890TH (1972)]
cole:      [inglesham 0790_w1TH (1987)]
churn:     [cirencester 0260TH (1979), cerney_wick 0290TH (1969)]
cherwell:  # source -> Kings Mill
  - [woodford_halse 1408TH (2004), cropredy 1416TH (1998), banbury 1420TH (1986, in A),
     heyford 1453TH (1998, ingested in A, not used), enslow 1460_w1TH (1987, current),
     thrupp 1465TH (2001), islip 1489TH (1995, current; Hydrology labels it Cherwell/Ray: branch to verify),
     kingsmill 1491TH (target)]
sor_brook: [bodicote 1437TH (1995), bloxham_brook 1431TH (2001)]   # joins the Cherwell near Banbury
ray:       [grendon_underwood 1471TH (1962), lower_arncott 1483TH (1998, in A), langford_brook 1484TH (2004),
            wendlebury_brook 1486TH (2006)]                         # joins the Cherwell at Islip
swere:     []   # no EA level gauge found
```

### 2.2 The walk per target, with cumulative travel times

Rule: start at the target and walk upstream through every confluence. Collect each gauge with (a) Hydrology 15-min history over the training period and a matching live measure, (b) a trace that responds in floods (rise ≥ 0.2 m in matched events; this excludes weir-held lock traces), and (c) a travel time to the target. For (c), use the measured pair time (§6) where n ≥ 3. Otherwise use the sum of measured edge times along the path.

**Consistency check:** travel time must not decrease as you walk upstream along a branch. Where it does, the event matching has picked up shared rainfall timing (every gauge rises in the same storm), not water moving down the river, and the summed-edge time should be used instead. Examples tonight: Hannington's lag_main to newbotley (18 h) is almost the same as Shifford's (17 h), although Hannington is about 20 km further up the Thames in a straight line, and further by river. Coldharbour shows the same: eynsham 42 h vs farmoor 23 h, although Eynsham is downstream of Farmoor. At Kings Mill, Islip's half-rise time (31 h, n = 7) is longer than Enslow's (18.6 h, n = 6), which only makes sense if Islip is on the slower Ray branch. Either way, that needs checking.

| Target | Branch → gauges walked (lag_main to target, h; source) |
|---|---|
| newbotley | Thames: eynsham 0.6 (n=3), farmoor 5 (fixed lags, n=0), shifford 17 (A), hannington 18 (A; fails the consistency check) · Evenlode: cassington 9.5 (n=24), shipton 19 (A) · Windrush: worsham 9 (A) |
| minns | Thames: eynsham 7 (n=7), farmoor 6 (n=1), shifford 32 (A), hannington 22 (A) · Evenlode: cassington 18 (n=22), shipton 21 (A) · Windrush: worsham 13 (A) |
| coldharbour | Thames: farmoor 23 (n=4), eynsham 42 (n=4), shifford 29 (A), hannington 40 (A) · Evenlode: cassington 52 (n=8), shipton 76 (A) · Windrush: worsham 45 (A). *No Cherwell* (it joins downstream; #134's `coinc` arm tested Cherwell inputs and lost skill: .266/.175/.108 → .249/.148/.090) |
| kingsmill | Cherwell: enslow 18.6 (n=6), banbury 37 (A) · Cherwell or Ray (verify): islip 31 (n=7) · Ray: lowerarncott 39 (A). Candidates not yet measured: heyford, cropredy, bodicote (Sor Brook), thrupp |

(The current lags are half-rise medians from `web/public/data/travel_times.json`; the A lags are lag_main values from the #125 table.) Rejected by the walk: the Ock (Abingdon), the Thame (Wheatley, Dorchester) and the Thames below Iffley, all downstream of the targets.

### 2.3 Using many walked gauges with few floods: per-branch aggregation

For each target and each branch b with walked gauges g (lag τ_g, spread lag_lo…lag_hi), build these features from the past only:

- **Standardised anomaly** z_g(t) = (level_g(t) − median_g) / s_g. Here median_g and s_g (say, the q90 − q10 range of that gauge) come from the training period only. This stays within the "never compare stages across gauges" rule, because each gauge is scaled by its own spread and has no datum left.
- **Routed branch signal** R_b(t) = mean over g of z_g(t − τ_g). This is a lag-and-route sum: each gauge is shifted by its travel time. Optional Muskingum-style smoothing replaces the single shift by an exponential kernel over [τ_lo, τ_hi], the linear-reservoir form of Muskingum routing [9]. Keep the plain shift first.
- **Branch window max** M_b(t) = max over g of z_g over [t − lag_hi, t − lag_lo]: "has a peak left this branch that is still on its way?"
- Optionally, the **furthest gauge's** z at its own lag, which gives the earliest signal.

That gives 2–3 columns per branch (Thames-upper, Windrush, Evenlode at the Thames-side targets; Cherwell-upper and Ray at Kings Mill) instead of 9 per gauge. Keep the existing per-gauge columns for the current near gauges (farmoor, eynsham, cassington, enslow, islip). Only the *new* gauges enter through branch signals. Windows stay ≤ 21 days, as SPEC §7.2 requires.

**Minimal 02:00 version ("A-branch"), coldharbour and kingsmill only:**
- **coldharbour:** + `R_thamesup` (shifford, hannington), `R_windrush` (worsham), `R_evenlode` (shipton), and `M_` of the same three. That is 6 columns, against 54 in A.
- **kingsmill:** + `R_cherwellup` (banbury) and `R_ray` (lowerarncott). That is 2 columns, against 18.
- Same harness, splits, params, CQR and adoption rule as #125. Leakage test: perturbing data after t must leave the R and M values at t unchanged. That's automatic if they're built from the already-tested shifted anomalies.
- newbotley and minns keep A as adopted. A-branch could be scored for them too, for comparison, but not swapped in tonight.

## 3. More training history: the extra floods

### 3.1 What exists

The Thames-side targets start in 2002 (newbotley, coldharbour) and in Jul 2003 (minns). Kings Mill starts in Jan 1998. The upstream gauges go back further (cassington 1986, enslow 1987, farmoor 1992), but **the model needs the target's level to learn from**, so years before a target's first reading add nothing to that target. Starting in 1986 or 1995 only matters for travel-time estimation between upstream gauges (post-hackathon).

### 3.2 Flood counts by period

Probe: Hydrology daily-max series for all four targets. An event is a daily max ≥ the spot threshold, and exceedances more than 7 days apart count as separate events.

| Target (threshold) | Pre-2006 (record start → 2005) | Train 2006 → Sep 2018 | Val Oct 2018 → Sep 2021 | Test Oct 2021 → | High-water days pre-2006 / train |
|---|---|---|---|---|---|
| newbotley (2.76) | **1** (Jan 2003, 2.92 m) | 6 | 1 | 2 | 59 / 391 (+15%) |
| minns (2.90) | **0** (starts Jul 2003; Jan 2003 missed) | 5 | 1 | 1 | 5 / 273 (+2%) |
| coldharbour (2.44) | **1** (Jan 2003, **2.738 m, the record**) | 6 | 1 | 2 | 6 / 49 (+12%) |
| kingsmill (2.60) | **1** (Jan 2003, 2.69 m) | 4 | 2 | 2 | 109 / 184 (**+59%**) |

So the older history adds **3 floods in total, all from one event (Jan 2003), and none at minns**. Kings Mill gains the most high-water rows (25 extra high-water episodes from 1998–2005). The other well-known pre-2006 floods don't cross our spot thresholds: Kings Mill peaked at 2.28 m in Easter 1998 (data gaps around the peak), 2.40 m in Nov 2000 and 2.43 m in Dec 2000. The Thames-side targets have no data before 2002.

**Data quality (probe, 15-min, share of the year's readings present and not Suspect):**
- newbotley: 2002 62% (starts in May), 2003 96%, 2004–05 100%.
- coldharbour: 2002 67%, 2003–05 100%.
- minns: 2003 45%, 2004–05 100%.
- kingsmill: 1998 82%, 1999–2000 100%, 2001 90% (3,346 Suspect readings, dropped by `clean_series`), 2002–05 100%.
- farmoor and cassington: 100%. enslow: 100%. islip: 92–100%.
- eynsham: **7% in 2003**, so it's missing during the Jan 2003 flood. That's fine: the model treats it as NaN.
- Rain gauges have history from 1982–1991 (`config/stations.yaml`).

### 3.3 Cost and risk for 02:00

- **Ingest:** `python -m pipeline.ingest_history --start 1998` (the flag exists; the default is 2006). One request per gauge-year, measured at **< 1 s each** (probe), so about 100 extra gauge-years (including the A gauges) take minutes. Then re-clean and publish `data-hourly-v2` (Data lead).
- **Splits:** **unchanged.** `choose_splits` returns the default split (validation from 2018-10-01, **test from 2021-10-01**) whenever history starts on or before 2007. The extra years simply join the training split.
- **What does change:**
  - The per-gauge medians, which are computed on the training split, so every anomaly shifts slightly. The new medians are saved with the models, so live mode follows automatically.
  - The persistence baseline's ε quantiles, from more training rows.
  - Neither lags.json nor the events change. Keep `lags.json` fixed: don't re-run `make travel` tonight.
- **Not changed:** the LOFO replays (Jan 2003 isn't in `config/events.yaml`; adding an `e2003` replay is a Story call for after the hackathon), the 30/30 headline, and the leakage tests.
- **Expected effect:** small. One more flood is +17–25% of the training floods per target. The clearest gain should be at Kings Mill (+59% high-water rows) and in coldharbour's upper quantiles (its record enters training).
- **Risk:** it is a third simultaneous change in a one-hour window. If the combined retrain misbehaves, it's hard to tell which change caused it. **Do it only if v2 is published by 01:15 GMT**, and score it as its own arm under the same rule if time allows. Otherwise it's the first post-hackathon item.

## 4. Feature and training ideas, assessed

| Idea | Verdict | Why |
|---|---|---|
| Routed upstream sums (lag-and-route or Muskingum-style) | **Yes: §2.3, rank 2** | Physically motivated and few columns. Mirrors operational lag-and-route [7][9] |
| Upstream rate of rise, acceleration | In #125 B | Don't duplicate; take B's version |
| Upstream peak-arrival indicator ("a peak left branch b, is it here yet?") | Covered by M_b in §2.3 | The window max over [t − lag_hi, t − lag_lo] is the leakage-safe form |
| Catchment-mean standardised anomaly (mean z over all walked gauges) | Post-hackathon, 1 column | A cheap "how full is the river network" state. Overlaps soil moisture (#134) |
| Seasonality interactions | No | Trees learn interactions already. Season is already a top 72 h feature at Kings Mill and Cold Harbour (11–12% of gain), which with ~4–6 flood winters may itself be overfitting |
| Target's own recent maximum | In #125 B (target 72 h max) | — |
| Sample weights for flood periods | **Not tonight** | The weights already up-weight high water ×5. C (#125) showed that the large residuals are the *low-water rows before a flood*, which a level-based weight can't single out. A weight defined by "a flood follows" uses the target, and it changes which quantile is being estimated. It would need re-validating the CQR |
| Monotone constraints on upstream features | **Impossible as built** | Tested tonight: LightGBM 4.7.0 raises `Cannot use monotone_constraints in quantile objective` |
| Quantile crossing | Already handled | Rows are sorted after prediction and after CQR (SPEC §7.3/§7.4), the standard rearrangement fix [10] |
| Hyperparameters | Only `feature_fraction` for the wide A-branch targets (rank 3) | Anything chosen on the test period would leak. Tuning on validation is fine, but there's no time to do it well |
| Imbalanced-regression losses (SERA etc.) | Post-hackathon | Designed for rare extremes [11], but it means a new objective and new calibration |

## 5. What NOT to do tonight

1. **Feed every walked gauge as raw columns.** About 40 gauges × 9 columns against 4–7 floods per gauge pair is the coldharbour 72 h failure, but bigger.
2. **Re-run `make travel`.** It moves the lags for every target at once, so the A results no longer apply.
3. **Start history in 1986 or 1995 for the targets.** There's no target data before 1998/2002, so it buys nothing for training. It's useful only for upstream edge travel times, after the hackathon.
4. **Add gauges below Oxford** (Ock, Thame, Sandford, Abingdon Lock). They aren't on any flow path, so they could only add noise.
5. **Use lock u/s traces without a responsiveness check** (Buscot was muted in A; Osney and Godstow u/s are flat in floods).
6. **Monotone constraints, new objectives, new calibration schemes, LSTMs or a second model** (impossible, unvalidated, or out of scope under SPEC §1.1).
7. **Stack overlapping features** from #125 B and #134 (e.g. two antecedent indices). Pick one version of each.
8. **Choose anything on the test period** (thresholds, params, feature sets). Choices are made on validation; test ≥ 2021-10-01 stays untouched.

## Sources

1. Bowden, G. J., Dandy, G. C. and Maier, H. R. (2005). Input determination for neural network models in water resources applications. Part 1: background and methodology; Part 2 (Bowden, Maier, Dandy): case study, forecasting salinity in a river. *Journal of Hydrology* 301(1–4), 75–92 and 93–107. [Repository record](https://hekyll.services.adelaide.edu.au/dspace/handle/2440/16751).
2. Maier, H. R., Jain, A., Dandy, G. C. and Sudheer, K. P. (2010). Methods used for the development of neural networks for the prediction of water resource variables in river systems: current status and future directions. *Environmental Modelling & Software* 25(8), 891–909. [Repository record](https://drmc.library.adelaide.edu.au/dspace/handle/2440/61137).
3. Galelli, S., Humphrey, G. B., Maier, H. R., Castelletti, A., Dandy, G. C. and Gibbs, M. S. (2014). An evaluation framework for input variable selection algorithms for environmental data-driven models. *Environmental Modelling & Software* 62, 33–51. doi:10.1016/j.envsoft.2014.08.015. [Repository record](https://drmc.library.adelaide.edu.au/dspace/handle/2440/85889).
4. Gauch, M., Mai, J. and Lin, J. (2021). The proper care and feeding of CAMELS: how limited training data affects streamflow prediction. *Environmental Modelling & Software* 135. [arXiv:1911.07249](https://arxiv.org/abs/1911.07249). Tree-based (XGBoost) and LSTM models are similarly accurate on small data sets; more training data helps both.
5. Ho, T. K. (1998). The random subspace method for constructing decision forests. *IEEE TPAMI* 20(8), 832–844.
6. LightGBM documentation, [Parameters](https://lightgbm.readthedocs.io/en/stable/Parameters.html) (`feature_fraction`, `monotone_constraints`).
7. Defontaine, T., Ricci, S., Lapeyre, C., Marchandise, A. and Le Pape, E. (2024). [Real-time flood forecasting with machine learning using scarce rainfall-runoff data](https://egusphere.copernicus.org/preprints/2024/egusphere-2023-2621/). EGUsphere preprint egusphere-2023-2621 (in discussion for *HESS*). 36 floods in 15 years; upstream-station anomalies; beats lag-and-route at 6 h.
8. UKCEH National River Flow Archive, [station-info service](https://nrfaapps.ceh.ac.uk/nrfa/ws/station-info?station=39008&format=json-object&fields=id,name,bfihost): BFIHOST values as cited in `docs/research/earlier-warnings.md` [17].
9. Muskingum routing as a linear storage relation: Cunge, J. A. (1969). On the subject of a flood propagation computation method (Muskingum method). *Journal of Hydraulic Research* 7(2), 205–230. For the hybrid use of Muskingum routing with ML residual correction, see the review [Review of machine learning methods for river flood routing](https://www.mdpi.com/2073-4441/16/2/364) (*Water* 16(2), 364, 2024).
10. Chernozhukov, V., Fernández-Val, I. and Galichon, A. (2010). Quantile and probability curves without crossing. *Econometrica* 78(3), 1093–1125.
11. Ribeiro, R. P. and Moniz, N. (2020). [Imbalanced regression and extreme value prediction](https://mlanthology.org/mlj/2020/ribeiro2020mlj-imbalanced). *Machine Learning* 109, 1803–1835.
12. Romano, Y., Patterson, E. and Candès, E. (2019). [Conformalized quantile regression](https://proceedings.neurips.cc/paper_files/paper/2019/file/5103c3584b063c431bd1268e9b5e76fb-Paper.pdf). *NeurIPS 2019*. This is the calibration already in use (SPEC §7.4); it is not changed here.

Internal evidence:
- #125 (the A, B and C results);
- #134 (the `coinc` arm);
- `web/public/data/importance.json` and `travel_times.json`;
- `model/train.py` (`choose_splits`, `LGB_PARAMS`);
- `pipeline/ingest_history.py` (`--start`).

The monotone-constraint test was a 4,000-row synthetic fit with `objective=quantile` and `monotone_constraints=[1, 0]`, run on LightGBM 4.7.0 in the project venv.

*Note: the Consensus paper-search quota was exhausted this month, so the sources were found through web search and checked against the publisher, repository or arXiv pages linked above. Refs 5, 9 (Cunge) and 10 are standard references cited from the journal record, not re-fetched tonight.*
