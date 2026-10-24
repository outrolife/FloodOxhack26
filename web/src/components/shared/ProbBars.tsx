import type { SpotForecast } from "../../contracts";
import { HOUR, formatShort } from "../../time";
import { hoursWords } from "../../lib/plain";
import { LEVEL_STYLE, levelForP, pct } from "./forecast";

/**
 * Probability bars for 6–72 h. timing_only spots show P(above usual high) instead.
 * With `issuedAt`, rows are clock times ("Sun 06:00 GMT") instead of "+6 h" (#103).
 */
export function ProbBars({ sf, issuedAt }: { sf: SpotForecast | undefined; issuedAt?: string }) {
  if (!sf || sf.leads.length === 0) return <p className="muted small">No forecast for this spot right now.</p>;
  const timing = sf.mode === "timing_only";
  const when = (h: number) => (issuedAt ? formatShort(Date.parse(issuedAt) + h * HOUR) : `in ${hoursWords(h)}`);
  return (
    <div>
      <div className="small muted" style={{ marginBottom: 4 }}>
        {timing ? "Chance the river goes above its usual high, by" : "Chance of flooding by"}
      </div>
      <div className="pbars" role="table">
        {sf.leads.map((l) => {
          const p = timing ? l.pAmber : (l.pFlood ?? 0);
          const colour = timing ? "#9ec5f4" : LEVEL_STYLE[levelForP(p)].colour;
          return (
            <div key={l.h} role="row" style={{ display: "contents" }}>
              <span role="cell" title={`${hoursWords(l.h)} ahead`}>{when(l.h)}</span>
              <div className="pbar-track" role="cell" title={`${pct(p)} in ${hoursWords(l.h)}`}>
                <div className="pbar-fill" style={{ width: `${Math.max(p * 100, 0.5)}%`, background: colour }} />
              </div>
              <span className="val" role="cell">
                {pct(p)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
