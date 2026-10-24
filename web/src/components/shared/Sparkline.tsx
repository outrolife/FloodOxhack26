// Tiny SVG sparkline of one gauge's level (its own datum, never compared
// with other gauges). Optional dashed amber line.
type Point = { t: string; level: number };

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
  const cut = until ? Date.parse(until) : Infinity;
  const pts = (points ?? []).filter((p) => Date.parse(p.t) <= cut);
  if (pts.length < 2) {
    return (
      <svg width={width} height={height} role="img" aria-label="No level history">
        <text x={2} y={height / 2 + 4} fontSize={10} fill="#898781">
          no history
        </text>
      </svg>
    );
  }
  const all = points ?? pts;
  const t0 = Date.parse(all[0].t);
  const t1 = Date.parse(all[all.length - 1].t);
  const levels = all.map((p) => p.level);
  if (amber != null) levels.push(amber);
  const lo = Math.min(...levels);
  const hi = Math.max(...levels);
  const pad = 2;
  const x = (t: string) => pad + ((Date.parse(t) - t0) / Math.max(t1 - t0, 1)) * (width - 2 * pad);
  const y = (v: number) => height - pad - ((v - lo) / Math.max(hi - lo, 1e-6)) * (height - 2 * pad);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.level).toFixed(1)}`).join("");
  const last = pts[pts.length - 1];
  return (
    <svg width={width} height={height} role="img" aria-label={`Level now ${last.level.toFixed(2)} m`}>
      {amber != null && (
        <line x1={pad} x2={width - pad} y1={y(amber)} y2={y(amber)} stroke="#eda100" strokeDasharray="3 2" strokeWidth={1} />
      )}
      <path d={d} fill="none" stroke="#2a78d6" strokeWidth={1.5} />
      <circle cx={x(last.t)} cy={y(last.level)} r={2.5} fill="#2a78d6" />
    </svg>
  );
}
