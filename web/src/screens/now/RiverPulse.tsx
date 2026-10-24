// Left edge of the Now screen: the upstream gauges and how long a rise takes
// to reach Oxford. A blue pulse runs down each link; its duration is the real
// median travel time T½ × 0.25 s per hour (kept between 1.2 s and 16 s), so a
// faster river visibly pulses faster. Links measured on fewer than 5 past
// rises are greyed and say "low confidence" (#99). The pulse stops for
// prefers-reduced-motion (CSS in now.css).
import type { RiverLink } from "./logic";
import { SECONDS_PER_HOUR, hoursText } from "./logic";

const H = 56; // link height in px (SVG user units = px)
const W = 22;

function LinkPulse({ link }: { link: RiverLink }) {
  return (
    <svg className="now-link-svg" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true" focusable="false">
      <line x1={W / 2} y1={6} x2={W / 2} y2={H - 6} className="now-link-line" />
      <circle cx={W / 2} cy={6} r={4.5} className="now-node up" />
      <circle cx={W / 2} cy={H - 6} r={5.5} className="now-node down" />
      <circle cx={W / 2} cy={6} r={4} className="now-pulse" style={{ animationDuration: `${link.seconds}s` }} />
    </svg>
  );
}

export function RiverPulse({ chains }: { chains: { river: string; links: RiverLink[] }[] }) {
  return (
    <section className="now-strip" aria-label="How long a rise upstream takes to reach Oxford">
      <h2 className="now-strip-title">The water on its way</h2>
      <p className="now-strip-sub">
        How long a rise at each upstream gauge usually takes to reach Oxford, from past floods. Pulse speed follows the
        real time (1 s ≈ {Math.round(1 / SECONDS_PER_HOUR)} h).
      </p>
      {chains.length === 0 && <p className="now-strip-sub">Travel times not available yet.</p>}
      {chains.map((c) => (
        <div className="now-chain" key={c.river}>
          <h3 className="now-chain-river">{c.river}</h3>
          <ul className="now-links">
            {c.links.map((l) => (
              <li
                key={`${l.up}-${l.down}`}
                className={`now-link${l.lowConfidence ? " low" : ""}`}
                title={`Median half-rise travel time ${l.tHalfH.toFixed(1)} h, ${l.basis}.`}
              >
                <LinkPulse link={l} />
                <div className="now-link-text">
                  <div className="now-link-label">
                    {l.upName} → {l.downName} <strong className="now-link-hours">{hoursText(l.tHalfH)}</strong>
                  </div>
                  <div className="now-link-basis">
                    based on {l.n} past {l.n === 1 ? "rise" : "rises"}
                    {l.lowConfidence && <span className="tag-low">low confidence</span>}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
