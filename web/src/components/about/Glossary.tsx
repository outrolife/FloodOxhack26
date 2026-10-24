// "Words we use": a small glossary (#103; docs/research/jargon-audit.md §4).
// The bracketed names are what forecasters (and older versions of this app) call them.

export const GLOSSARY: { term: string; aka?: string; plain: string }[] = [
  { term: "River gauge", plain: "A sensor in the river that records the water height every 15 minutes. Each one measures from its own zero, so we only ever compare a gauge with its own past." },
  { term: "Flood level", aka: "flood threshold", plain: "The height on a spot's gauge at which the Environment Agency says property flooding becomes possible nearby. A good guide, not a guarantee that water reaches your door." },
  { term: "Usual high", aka: "normal top, amber", plain: "The top of the river's normal range at that gauge. Above it the river is higher than usual, but not necessarily flooding." },
  { term: "Chance of flooding", aka: "pFlood", plain: "How likely the river is to reach flood level by a given time, e.g. \"about 1 in 3 by Tuesday evening\"." },
  { term: "Hours ahead", aka: "lead time", plain: "How far into the future a forecast looks. River Clock looks 6 hours to 3 days ahead." },
  { term: "Likely range / wide range", aka: "forecast interval, quantiles", plain: "Instead of one number, River Clock gives a range: a likely range (the river should be inside about half the time) and a wide range (about 9 times in 10)." },
  { term: "Travel time", aka: "T½, half-rise travel time", plain: "How long a flood rise takes to get from an upstream gauge to Oxford: from when the upstream gauge is halfway up its rise to when the downstream one is halfway up its own. We take the middle value over past floods." },
  { term: "The simple guess", aka: "persistence", plain: "A basic forecast: the river stays where it is now, give or take its usual ups and downs. A forecast that can't beat this isn't worth much." },
  { term: "Skill", plain: "How much smaller River Clock's error is than the simple guess's. 0.27 means 27% less error; 0 means no better; below 0 means worse." },
  { term: "Range check", aka: "coverage", plain: "How often the real level landed inside our ranges. A 90% range should catch it about 9 times in 10. Ours catch it more often, so our ranges are cautious." },
  { term: "Honest chances", aka: "reliability, calibration", plain: "Whether our percentages mean what they say: of all the times we said 30%, did it flood about 30% of the time?" },
  { term: "Brier score", plain: "An error score for flood chances: the average squared gap between the chance we gave (0 to 1) and what happened (flooded = 1, didn't = 0). 0 is perfect; lower is better." },
  { term: "Act-at chance", aka: "p*, trigger", plain: "How sure you need to be before acting: what acting costs divided by what you'd lose. £20 to move a car ÷ £2,000 of damage = act at 1%." },
  { term: "Caught / missed / false alarm", aka: "hit / miss", plain: "Caught: we reached your act-at chance before the flood (within 3 days). Missed: it flooded and we didn't. False alarm: we reached it and no flood came within 3 days." },
  { term: "Replay", aka: "Time Machine, leave-one-flood-out", plain: "Re-running a past flood hour by hour with a model trained without that flood, which never sees anything after \"now\". Our headline scores use a stricter test: forecasts from 2021 on that no model trained on." },
];

export default function Glossary() {
  return (
    <section className="card" id="glossary">
      <h2>Words we use</h2>
      <dl className="glossary">
        {GLOSSARY.map((g) => (
          <div key={g.term}>
            <dt>
              {g.term}
              {g.aka && <span className="muted small"> ({g.aka})</span>}
            </dt>
            <dd>{g.plain}</dd>
          </div>
        ))}
      </dl>
      <p className="small muted">
        Official Environment Agency messages, which River Clock never issues: a Flood Alert means flooding is possible,
        be prepared; a Flood Warning means flooding is expected, act now. See gov.uk/check-flooding.
      </p>
    </section>
  );
}
