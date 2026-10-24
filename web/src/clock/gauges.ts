// Gauges on the flow map (#118 browser feedback): every gauge in stations.json
// (upstream, live_only, Oxford targets) is a small level-gauge icon, and a
// compact card on hover or tap. Each gauge is only ever compared with its own
// usual high and flood level (never across gauges). Pure, so tested;
// GaugeLayer.tsx draws them.
import type { Station } from "../contracts";
import type { Point } from "../components/shared/series";
import { gaugeName } from "../lib/plain";
import { formatDateTime } from "../time";
import { type Bucket, bucketFor, levelAt, levelFraction } from "./flow";

const HOUR = 3_600_000;

/** Three looks for a gauge icon: colour and how full the little gauge is (shape, not colour alone). */
export type GaugeLook = "calm" | "above" | "high" | "none";

export const GAUGE_LOOK: Record<GaugeLook, { fill: number; colour: string; words: string }> = {
  calm: { fill: 0.3, colour: "#8bb8de", words: "within its usual range" },
  above: { fill: 0.62, colour: "#2a78d6", words: "above its usual high" },
  high: { fill: 1, colour: "#0d366b", words: "close to or above flood level" },
  none: { fill: 0, colour: "#b7c3cc", words: "no reading" },
};

/** Flow-map bucket → gauge look. */
export function lookFor(bucket: Bucket | null): GaugeLook {
  if (bucket == null) return "none";
  return bucket === 0 ? "calm" : bucket <= 2 ? "above" : "high";
}

/** The little gauge (14 × 18 px SVG markup for a Leaflet divIcon): a post filled to its level, with ticks. */
export function gaugeIconSvg(look: GaugeLook, emphasis = false): string {
  const g = GAUGE_LOOK[look];
  const inner = 14.6; // inner height of the post
  const h = Math.round(g.fill * inner * 10) / 10;
  const stroke = look === "none" ? "#898781" : "#0b0b0b";
  const dash = look === "none" ? ' stroke-dasharray="2 1.5"' : "";
  const sw = emphasis ? 2 : 1.2;
  return (
    `<svg width="14" height="18" viewBox="0 0 14 18" aria-hidden="true" focusable="false">` +
    `<rect x="1" y="1" width="12" height="16" rx="2.5" fill="#fff" stroke="${stroke}" stroke-width="${sw}"${dash}/>` +
    (h > 0 ? `<rect x="2.2" y="${(16.2 - h).toFixed(1)}" width="9.6" height="${h}" rx="1.4" fill="${g.colour}"/>` : "") +
    `<path d="M1 5.5h3M1 9h4.5M1 12.5h3" stroke="${stroke}" stroke-width="0.9"/>` +
    `</svg>`
  );
}

/** "0.4 m" / "6 cm": a distance on one gauge. */
export function metres(d: number): string {
  const a = Math.abs(d);
  return a < 0.095 ? `${Math.round(a * 100)} cm` : `${a.toFixed(1)} m`;
}

export type GaugeCardData = {
  title: string;
  river: string;
  /** "0.4 m below its usual high" */
  vsUsual: string | null;
  /** "1.1 m below flood level" */
  vsFlood: string | null;
  /** "Rising 6 cm in the last 3 h" */
  trend: string | null;
  /** "Last reading Sat 24 Oct, 18:00 BST" */
  last: string | null;
  /** "Water here reaches Botley Road in about 9 h" */
  flow: string | null;
  /** The last 3 days of readings up to the moment shown (for the sparkline). */
  spark: Point[];
};

/**
 * The card for one gauge at time t (epoch ms). Readings become known `lagH`
 * hours after they happen (replays: 1 h, #93). `reaches` is the downstream
 * place and hours when the gauge starts a flow link.
 */
export function gaugeCard(
  station: Pick<Station, "name" | "river" | "amber" | "threshold">,
  series: readonly Point[] | undefined,
  t: number | null,
  lagH = 0,
  reaches?: { name: string; hours: number } | null,
): GaugeCardData {
  const known = t == null ? Infinity : t - lagH * HOUR;
  const pts = (series ?? []).filter((p) => Date.parse(p.t) <= known);
  const lastPt = pts.length ? pts[pts.length - 1] : null;
  const level = lastPt?.level ?? null;
  const lastT = lastPt ? Date.parse(lastPt.t) : null;
  let vsUsual: string | null = null;
  let vsFlood: string | null = null;
  if (level != null) {
    const d = level - station.amber;
    vsUsual = Math.abs(d) < 0.005 ? "At its usual high" : `${metres(d)} ${d < 0 ? "below" : "above"} its usual high`;
    if (station.threshold != null) {
      const f = level - station.threshold;
      vsFlood = f >= 0 ? `${metres(f)} above flood level` : `${metres(f)} below flood level`;
    }
  }
  let trend: string | null = null;
  if (level != null && lastT != null) {
    const before = levelAt(pts, lastT - 3 * HOUR);
    if (before != null) {
      const d = level - before;
      trend = Math.abs(d) < 0.02 ? "Steady over the last 3 h" : `${d > 0 ? "Rising" : "Falling"} ${metres(d)} in the last 3 h`;
    }
  }
  const spark = lastT == null ? [] : pts.filter((p) => Date.parse(p.t) >= lastT - 72 * HOUR);
  return {
    title: gaugeName(station.name),
    river: station.river,
    vsUsual,
    vsFlood,
    trend,
    last: lastT != null ? `Last reading ${formatDateTime(lastT)}` : "No reading",
    flow: reaches ? `Water here reaches ${reaches.name} in about ${Math.round(reaches.hours)} h` : null,
    spark,
  };
}

/** The look of a gauge from its level at t (null: no reading). */
export function gaugeLook(station: Pick<Station, "amber" | "threshold">, level: number | null | undefined): GaugeLook {
  if (level == null || !Number.isFinite(level)) return "none";
  return lookFor(bucketFor(levelFraction(level, station.amber, station.threshold)));
}

/** Sparkline path (SVG "d") for points in a w × h box, with the usual high's y if it is in range. */
export function sparkPath(points: readonly Point[], w: number, h: number, usualHigh?: number): { d: string; usualY: number | null } {
  if (points.length < 2) return { d: "", usualY: null };
  const ts = points.map((p) => Date.parse(p.t));
  const vs = points.map((p) => p.level);
  const t0 = ts[0];
  const t1 = ts[ts.length - 1];
  let lo = Math.min(...vs);
  let hi = Math.max(...vs);
  if (usualHigh != null && usualHigh >= lo - (hi - lo) && usualHigh <= hi + (hi - lo)) {
    lo = Math.min(lo, usualHigh);
    hi = Math.max(hi, usualHigh);
  }
  if (hi - lo < 0.05) {
    const m = (hi + lo) / 2;
    lo = m - 0.025;
    hi = m + 0.025;
  }
  const x = (t: number) => (t1 === t0 ? 0 : ((t - t0) / (t1 - t0)) * w);
  const y = (v: number) => h - 1 - ((v - lo) / (hi - lo)) * (h - 2);
  const d = points.map((p, i) => `${i ? "L" : "M"}${x(ts[i]).toFixed(1)} ${y(p.level).toFixed(1)}`).join(" ");
  const usualY = usualHigh != null && usualHigh >= lo && usualHigh <= hi ? y(usualHigh) : null;
  return { d, usualY };
}
