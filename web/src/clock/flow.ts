// The flow map's data rules (#118 one screen). Pure, so tested.
//
// Each river line on the basemap is drawn as water: it gets thicker and deeper
// blue as its nearest gauge rises from the usual high towards the flood level,
// and dashes move downstream along it (OSM draws waterways in the direction of
// flow). Levels are only ever compared with the same gauge's own usual high and
// flood level (never across gauges): fraction = (level − usual high) / (flood
// level − usual high).
import type { Feature, FeatureCollection, LineString, MultiLineString } from "geojson";
import type { Forecast, Station, TravelPair } from "../contracts";
import { countAtOrBefore, type Point } from "../components/shared/series";
import { bestPair, LOW_CONFIDENCE_N } from "../components/shared/RiverStrip";
import { OXFORD_BOUNDS } from "../ui/bounds";

const HOUR = 3_600_000;

// ---------------------------------------------------------------- levels

/** The last reading at or before t (epoch ms), or null. */
export function levelAt(points: readonly Point[] | undefined, t: number): number | null {
  if (!points || points.length === 0) return null;
  const n = countAtOrBefore(points, t);
  return n > 0 ? points[n - 1].level : null;
}

/** The forecast middle (q50) at t for one gauge's spot, interpolated between leads; null outside 0–72 h. */
export function forecastLevelAt(f: Forecast, spotKey: string, t: number): number | null {
  const sf = f.spots?.find((s) => s.spot === spotKey);
  if (!sf || !sf.leads?.length) return null;
  const h = (t - Date.parse(f.issuedAt)) / HOUR;
  const pts = [{ h: 0, v: sf.levelNow }, ...[...sf.leads].sort((a, b) => a.h - b.h).map((l) => ({ h: l.h, v: l.q["50"] }))];
  if (h < 0 || h > pts[pts.length - 1].h) return null;
  for (let i = 1; i < pts.length; i++) {
    if (h <= pts[i].h) {
      const a = pts[i - 1];
      const b = pts[i];
      return a.v + ((b.v - a.v) * (h - a.h)) / (b.h - a.h || 1);
    }
  }
  return null;
}

/** Where a level sits on its own gauge: 0 at the usual high, 1 at the flood level (unclamped). */
export function levelFraction(level: number, usualHigh: number, floodLevel: number | null): number {
  const top = floodLevel != null && floodLevel > usualHigh ? floodLevel : usualHigh + 0.5;
  return (level - usualHigh) / (top - usualHigh);
}

/** Five looks for the water, from normal to above flood level. */
export type Bucket = 0 | 1 | 2 | 3 | 4;

export function bucketFor(fraction: number | null): Bucket {
  if (fraction == null || fraction < 0) return 0; // within the usual range
  if (fraction < 1 / 3) return 1;
  if (fraction < 2 / 3) return 2;
  if (fraction < 1) return 3;
  return 4; // at or above the flood level
}

/** Line width multiplier, colour (light → deep blue) and dash speed per bucket. */
export const FLOW_LOOK: Record<Bucket, { widthX: number; colour: string; seconds: number; words: string }> = {
  0: { widthX: 1, colour: "#8bb8de", seconds: 6, words: "within its usual range" },
  1: { widthX: 1.5, colour: "#5a9ad8", seconds: 4.5, words: "above the usual high" },
  2: { widthX: 2, colour: "#2a78d6", seconds: 3.2, words: "rising towards flood level" },
  3: { widthX: 2.6, colour: "#184f95", seconds: 2.2, words: "close to flood level" },
  4: { widthX: 3.2, colour: "#0d366b", seconds: 1.5, words: "at or above flood level" },
};

/** Gauge levels at t. Past (or event) times use readings; Now's future uses the forecast middle. */
export function gaugeLevelsAt({
  stations,
  observed,
  t,
  lagH = 0,
  forecast,
  spotsByGauge,
}: {
  stations: Pick<Station, "key">[];
  observed: Record<string, Point[]> | undefined;
  t: number;
  /** Readings become known this many hours after they happen (Replay: 1 h). */
  lagH?: number;
  /** Live mode: past the last reading, the forecast middle for spot gauges. */
  forecast?: Forecast | null;
  spotsByGauge?: Record<string, string>;
}): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const s of stations) {
    const series = observed?.[s.key];
    const last = series && series.length ? Date.parse(series[series.length - 1].t) : -Infinity;
    const spot = spotsByGauge?.[s.key];
    if (forecast && spot && t > last) {
      out[s.key] = forecastLevelAt(forecast, spot, t) ?? levelAt(series, t - lagH * HOUR);
    } else {
      out[s.key] = levelAt(series, t - lagH * HOUR);
    }
  }
  return out;
}

// ---------------------------------------------------------------- lines

type Line = Feature<LineString | MultiLineString>;

function midpoint(f: Line): [number, number] | null {
  const coords = f.geometry.type === "LineString" ? f.geometry.coordinates : f.geometry.coordinates.flat();
  if (coords.length === 0) return null;
  const c = coords[Math.floor(coords.length / 2)];
  return [c[1], c[0]];
}

/** Rough ground distance² in degrees, with longitude shrunk for Oxford's latitude. */
const dist2 = (a: [number, number], b: [number, number]) => {
  const k = Math.cos((51.75 * Math.PI) / 180);
  return (a[0] - b[0]) ** 2 + ((a[1] - b[1]) * k) ** 2;
};

/**
 * Group river lines by their nearest gauge that has a reading (gauges without
 * data are skipped, so every line still gets water). Returns one collection per gauge.
 */
export function linesByGauge(
  lines: FeatureCollection | undefined,
  gauges: Pick<Station, "key" | "lat" | "lon">[],
): Record<string, FeatureCollection> {
  const out: Record<string, FeatureCollection> = {};
  if (!lines || gauges.length === 0) return out;
  for (const f of lines.features as Line[]) {
    if (f.geometry?.type !== "LineString" && f.geometry?.type !== "MultiLineString") continue;
    const m = midpoint(f);
    if (!m) continue;
    let best = gauges[0];
    for (const g of gauges) if (dist2(m, [g.lat, g.lon]) < dist2(m, [best.lat, best.lon])) best = g;
    (out[best.key] ??= { type: "FeatureCollection", features: [] }).features.push(f);
  }
  return out;
}

// ---------------------------------------------------------------- upstream chain

export type ChainLink = {
  up: string;
  down: string;
  /** Median hours for a rise to travel down this link (travel_times.json). */
  tHalfH: number;
  n: number;
  lowConfidence: boolean;
  /** Dash speed: the real travel time, 0.25 s per hour, kept between 1.5 s and 16 s. */
  seconds: number;
};

export const SECONDS_PER_HOUR = 0.25;

/**
 * Pulses on a link: the SVG path is given pathLength 100, so the dash pattern
 * is a share of the link at any zoom. "0 50" with round caps = two dots, half
 * a link apart; the rc-pulse animation moves them one whole link (100) per
 * `seconds`, from the upstream gauge towards Oxford.
 */
export const PULSE_PATH_LENGTH = 100;
export const PULSE_DASH = "0 50";

/** Hover words for a link: "Water passing Islip reaches Kings Mill about 31 h later (from 7 past rises)". */
export function linkWords(l: Pick<ChainLink, "tHalfH" | "n" | "lowConfidence">, upName: string, downName: string): string {
  const h = Math.round(l.tHalfH);
  const from = `from ${l.n} past rise${l.n === 1 ? "" : "s"}`;
  return `Water passing ${upName} reaches ${downName} about ${h} h later (${l.lowConfidence ? `only ${from}, so a rough guide` : from})`;
}

/** One schematic link per upstream gauge, to its best-measured Oxford gauge. */
export function chainLinks(stations: Pick<Station, "key" | "role">[], pairs: TravelPair[]): ChainLink[] {
  const targets = new Set(stations.filter((s) => s.role !== "upstream").map((s) => s.key));
  const out: ChainLink[] = [];
  for (const s of stations) {
    if (s.role !== "upstream") continue;
    const p = bestPair(
      s.key,
      pairs.filter((x) => targets.has(x.down)),
    );
    if (!p) continue;
    const tHalfH = p.tHalf.median;
    out.push({
      up: s.key,
      down: p.down,
      tHalfH,
      n: p.n,
      lowConfidence: p.n < LOW_CONFIDENCE_N,
      seconds: Math.min(16, Math.max(1.5, tHalfH * SECONDS_PER_HOUR)),
    });
  }
  return out;
}

/** Map bounds: the spots plus the upstream gauges the chain starts from, padded. Oxford until any are known. */
export function flowBounds(points: { lat: number; lon: number }[], pad = 0.006): [[number, number], [number, number]] {
  const ok = (points ?? []).filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon));
  if (ok.length === 0) return OXFORD_BOUNDS;
  const lats = ok.map((p) => p.lat);
  const lons = ok.map((p) => p.lon);
  return [
    [Math.min(...lats) - pad, Math.min(...lons) - pad * 1.6],
    [Math.max(...lats) + pad, Math.max(...lons) + pad * 1.6],
  ];
}
