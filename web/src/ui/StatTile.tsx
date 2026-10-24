// One big number with a label (#118). At most three per screen.
// tone: "model" (blue, River Clock), "baseline" (orange, comparison),
// "neutral" (ink), or a flood-state tone that always comes with its label.
import type { ReactNode } from "react";

export type StatTone = "model" | "baseline" | "neutral" | "calm" | "watch" | "likely" | "muted";

export function StatTile({
  value,
  label,
  sub,
  tone = "neutral",
  title,
}: {
  value: ReactNode;
  label: ReactNode;
  sub?: ReactNode;
  tone?: StatTone;
  /** The precise meaning, for a "what's this?" tooltip. */
  title?: string;
}) {
  return (
    <div className={`ui-stat ui-stat-${tone}`} title={title}>
      <div className="ui-stat-value">{value}</div>
      <div className="ui-stat-label">{label}</div>
      {sub && <div className="ui-stat-sub">{sub}</div>}
    </div>
  );
}

/** A row of up to three StatTiles. */
export function StatRow({ children }: { children: ReactNode }) {
  return <div className="ui-stat-row">{children}</div>;
}
