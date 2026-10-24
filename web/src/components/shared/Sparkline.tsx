// Tiny SVG sparkline of one gauge's level (its own datum, never compared
// with other gauges). Optional dashed amber line. Points must be sorted by time.
import { countAtOrBefore, timesOf, type Point } from "./series";

export function Sparkline({
  points,
  amber,
  width = 120,
  height = 32,
  until,
}: {
  points: Point[] | undefined;
  amber?: number | null;
  width?: number;
  height?: number;
  /** Only draw points at or before this ISO time (Time Machine: no peeking). */
  until?: string;
}) {
  const all = points ?? [];
  const ts = timesOf(all);
  const k = countAtOrBefore(all, until ? Date.parse(until) : Infinity);
  const pts = all.slice(0, k);
  if (pts.length < 2) {
    return (
      <svg width={width} height={height} role="img" aria-label="No level history">
        <text x={2} y={height / 2 + 4} fontSize={10} fill="#898781">
          no history
        </text>
      </svg>
    );
  }
  // x spans the whole series (time only, no spoiler); y uses only the points
  // drawn, so the scale can't hint at a peak the slider hasn't reached.
  const t0 = ts[0];
  const t1 = ts[ts.length - 1];
  let lo = amber ?? Infinity;
  let hi = amber ?? -Infinity;
  for (const p of pts) {
    if (p.level < lo) lo = p.level;
    if (p.level > hi) hi = p.level;
  }
  const pad = 2;
  const x = (i: number) => pad + ((ts[i] - t0) / Math.max(t1 - t0, 1)) * (width - 2 * pad);
  const y = (v: number) => height - pad - ((v - lo) / Math.max(hi - lo, 1e-6)) * (height - 2 * pad);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.level).toFixed(1)}`).join("");
  const last = pts[pts.length - 1];
  return (
    <svg width={width} height={height} role="img" aria-label={`Level now ${last.level.toFixed(2)} m`}>
      {amber != null && (
        <line x1={pad} x2={width - pad} y1={y(amber)} y2={y(amber)} stroke="#eda100" strokeDasharray="3 2" strokeWidth={1} />
      )}
      <path d={d} fill="none" stroke="#2a78d6" strokeWidth={1.5} />
      <circle cx={x(pts.length - 1)} cy={y(last.level)} r={2.5} fill="#2a78d6" />
    </svg>
  );
}
