import type { SpotForecast } from "../../contracts";
import { LEVEL_STYLE, levelForP, pct } from "./forecast";

/** Probability bars for 6–72 h. timing_only spots show P(amber) instead. */
export function ProbBars({ sf }: { sf: SpotForecast | undefined }) {
  if (!sf || sf.leads.length === 0) return <p className="muted small">No lead-time probabilities.</p>;
  const timing = sf.mode === "timing_only";
  return (
    <div>
      <div className="small muted" style={{ marginBottom: 4 }}>
        {timing ? "Chance above normal range (amber), by lead time" : "Chance of flooding, by lead time"}
      </div>
      <div className="pbars" role="table">
        {sf.leads.map((l) => {
          const p = timing ? l.pAmber : (l.pFlood ?? 0);
          const colour = timing ? "#9ec5f4" : LEVEL_STYLE[levelForP(p)].colour;
          return (
            <div key={l.h} role="row" style={{ display: "contents" }}>
              <span role="cell">+{l.h} h</span>
              <div className="pbar-track" role="cell" title={`${pct(p)} at +${l.h} h`}>
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
