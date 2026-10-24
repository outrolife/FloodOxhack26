// Event picker as big thumbnails (#120): each past event with a tiny trace of
// the selected spot's river level against its flood level, and a one-line
// outcome badge from the data. Badges appear once that event's replay has
// loaded in the background.
import { memo } from "react";
import type { EventMeta, Replay, Spot } from "../../contracts";
import type { ReplayFacts } from "./facts";
import { badgeText, eaBadgeText, outcomeOf, outcomeTone } from "./story";

const W = 160;
const HT = 44;

/** A small level trace, downsampled to ~W points, with the flood level as a dashed line. */
const Trace = memo(function Trace({ points, threshold }: { points: { level: number }[]; threshold: number }) {
  if (points.length < 2) return <svg className="rp-thumb-trace" width={W} height={HT} aria-hidden="true" />;
  const step = Math.max(1, Math.floor(points.length / W));
  const vals: number[] = [];
  for (let i = 0; i < points.length; i += step) vals.push(points[i].level);
  const lo = Math.min(...vals, threshold) - 0.05;
  const hi = Math.max(...vals, threshold) + 0.05;
  const y = (v: number) => HT - ((v - lo) / (hi - lo)) * HT;
  const d = vals.map((v, i) => `${i ? "L" : "M"}${((i / (vals.length - 1)) * W).toFixed(1)} ${y(v).toFixed(1)}`).join("");
  return (
    <svg className="rp-thumb-trace" width={W} height={HT} viewBox={`0 0 ${W} ${HT}`} aria-hidden="true">
      <line x1={0} x2={W} y1={y(threshold)} y2={y(threshold)} stroke="#d03b3b" strokeDasharray="4 3" strokeWidth={1.5} />
      <path d={d} fill="none" stroke="#0b0b0b" strokeWidth={1.5} />
    </svg>
  );
});

const yearOf = (e: EventMeta) => {
  const m = /(\d{4})/.exec(e.name);
  return m ? m[1] : e.start.slice(0, 4);
};

export function EventPicker({
  events,
  replays,
  facts,
  spot,
  selected,
  onSelect,
}: {
  events: EventMeta[];
  replays: Record<string, Replay>;
  facts: Record<string, ReplayFacts>;
  spot: Spot;
  selected: string;
  onSelect: (id: string) => void;
}) {
  return (
    <nav className="rp-thumbs" aria-label="Past floods to replay">
      {events.map((e) => {
        const f = facts[e.id];
        const o = f ? outcomeOf(f) : null;
        const isSel = e.id === selected;
        const badge = o ? badgeText(o) : "Loading…";
        const ea = f ? eaBadgeText(f) : null;
        return (
          <button
            key={e.id}
            className={`rp-thumb${isSel ? " selected" : ""}`}
            aria-pressed={isSel}
            onClick={() => onSelect(e.id)}
            aria-label={`${e.name}: ${badge}${ea ? `; ${ea}` : ""}`}
          >
            <span className="rp-thumb-year">{yearOf(e)}</span>
            <span className="rp-thumb-name">{e.name.replace(/\s*\d{4}\s*/, " ").trim()}</span>
            <Trace points={replays[e.id]?.observed[spot.gauge] ?? []} threshold={spot.threshold} />
            <span className={`rp-thumb-badge tone-${o ? outcomeTone(o) : "neutral"}`}>{badge}</span>
            {ea && <span className="rp-thumb-ea">{ea}</span>}
          </button>
        );
      })}
    </nav>
  );
}
