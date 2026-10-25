// Explore (#118): the official river flood risk band at a point, and the
// plain-English words and colours the card shows for it. Pure, no React.
//
// Bands follow the EA "Risk of Flooding from Rivers and Sea" definitions:
//   High      >= 3.3 % a year (1 in 30 or more)
//   Medium    1 % to 3.3 % a year (1 in 100 to 1 in 30)
//   Low       0.1 % to 1 % a year (1 in 1000 to 1 in 100)
//   Very low  < 0.1 % a year (less than 1 in 1000)
// "none" means the point is outside every mapped zone.
import type { Feature, FeatureCollection, Geometry, Position } from "geojson";
import type { Forecast, Spot } from "../contracts";
import { clockFor, shortSpotName } from "../ui/clockData";
import type { NearbySpot, PointRisk, RiskBand } from "./types";

/** Higher number = worse band. Used to pick the worst of overlapping zones. */
export const BAND_RANK: Record<RiskBand, number> = { none: 0, very_low: 1, low: 2, medium: 3, high: 4 };

const BANDS = new Set<string>(["high", "medium", "low", "very_low"]);

/** Hex fallbacks for canvas / Leaflet / MapLibre styles. Keep in sync with the --fc-risk-* tokens in ui/tokens.css (PR #173). */
export const BAND_HEX: Record<RiskBand, { fill: string; ink: string }> = {
  high: { fill: "#b3261e", ink: "#ffffff" },
  medium: { fill: "#e07b16", ink: "#1a1a1a" },
  low: { fill: "#f2c94c", ink: "#1a1a1a" },
  very_low: { fill: "#d7e6cf", ink: "#1a1a1a" },
  none: { fill: "#e4e3de", ink: "#3d3c38" },
};

const TOKEN: Record<RiskBand, string> = {
  high: "high",
  medium: "medium",
  low: "low",
  very_low: "verylow",
  none: "none",
};

export interface BandInfo {
  label: string;
  /** CSS colour for the badge background (design token, with hex fallback). */
  colour: string;
  /** CSS colour for the badge text (design token, with hex fallback). */
  textColour: string;
  sentence: string;
}

const LABEL: Record<RiskBand, string> = {
  high: "High risk",
  medium: "Medium risk",
  low: "Low risk",
  very_low: "Very low risk",
  none: "Outside mapped zones",
};

const SENTENCE: Record<RiskBand, string> = {
  high: "This spot is in a high-risk river flood zone: in any year it has a 1 in 30 or greater chance of flooding from rivers.",
  medium:
    "This spot is in a medium-risk river flood zone: in any year it has between a 1 in 100 and a 1 in 30 chance of flooding from rivers.",
  low: "This spot is in a low-risk river flood zone: in any year it has between a 1 in 1000 and a 1 in 100 chance of flooding from rivers.",
  very_low:
    "This spot is in a very-low-risk river flood zone: in any year it has less than a 1 in 1000 chance of flooding from rivers.",
  none: "This spot is outside the mapped river flood zones, so river flooding is very unlikely here (surface water can still flood streets).",
};

export const BAND_INFO: Record<RiskBand, BandInfo> = Object.fromEntries(
  (Object.keys(LABEL) as RiskBand[]).map((b) => [
    b,
    {
      label: LABEL[b],
      colour: `var(--fc-risk-${TOKEN[b]}, ${BAND_HEX[b].fill})`,
      textColour: `var(--fc-risk-${TOKEN[b]}-ink, ${BAND_HEX[b].ink})`,
      sentence: SENTENCE[b],
    },
  ]),
) as Record<RiskBand, BandInfo>;

// ---------------------------------------------------------------------------
// Point in polygon
// ---------------------------------------------------------------------------

type BBox = [number, number, number, number]; // minLon, minLat, maxLon, maxLat

/** Ray casting: is (x, y) inside this closed ring? Points exactly on an edge may go either way. */
function inRing(x: number, y: number, ring: Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Inside the outer ring and not inside any hole. */
function inPolygon(x: number, y: number, rings: Position[][]): boolean {
  if (!rings.length || !inRing(x, y, rings[0])) return false;
  for (let k = 1; k < rings.length; k++) if (inRing(x, y, rings[k])) return false;
  return true;
}

function polygonsOf(g: Geometry | null): Position[][][] {
  if (!g) return [];
  if (g.type === "Polygon") return [g.coordinates];
  if (g.type === "MultiPolygon") return g.coordinates;
  if (g.type === "GeometryCollection") return g.geometries.flatMap(polygonsOf);
  return [];
}

const bboxCache = new WeakMap<Feature, BBox | null>();

function bboxOf(f: Feature): BBox | null {
  if (bboxCache.has(f)) return bboxCache.get(f)!;
  let b: BBox | null = null;
  for (const poly of polygonsOf(f.geometry)) {
    for (const [x, y] of poly[0] ?? []) {
      if (!b) b = [x, y, x, y];
      else {
        if (x < b[0]) b[0] = x;
        if (y < b[1]) b[1] = y;
        if (x > b[2]) b[2] = x;
        if (y > b[3]) b[3] = y;
      }
    }
  }
  bboxCache.set(f, b);
  return b;
}

function bandOf(f: Feature): RiskBand | null {
  const b = f.properties?.band;
  return typeof b === "string" && BANDS.has(b) ? (b as RiskBand) : null;
}

/** The worst EA river flood band among all zones containing the point, or "none". */
export function bandAt(zones: FeatureCollection | null | undefined, lat: number, lon: number): RiskBand {
  let best: RiskBand = "none";
  if (!zones?.features || !Number.isFinite(lat) || !Number.isFinite(lon)) return best;
  for (const f of zones.features) {
    const band = bandOf(f);
    if (!band || BAND_RANK[band] <= BAND_RANK[best]) continue; // can't improve on what we have
    const bb = bboxOf(f);
    if (!bb || lon < bb[0] || lon > bb[2] || lat < bb[1] || lat > bb[3]) continue;
    if (polygonsOf(f.geometry).some((p) => inPolygon(lon, lat, p))) {
      best = band;
      if (best === "high") break;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Nearby FloodClock spot
// ---------------------------------------------------------------------------

/** Great-circle distance in metres. */
export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * The nearest FloodClock trouble spot within maxM metres, with its chance of
 * flooding in the next 3 days. That chance is read exactly as the clocks read it
 * (ui/clockData.ts clockFor: highest pFlood over the 72 h leads).
 */
export function nearbySpot(
  lat: number,
  lon: number,
  spots: Spot[] | null | undefined,
  forecast: Forecast | null,
  maxM = 1500,
): NearbySpot | undefined {
  let best: { spot: Spot; d: number } | undefined;
  for (const s of spots ?? []) {
    const d = haversineM(lat, lon, s.lat, s.lon);
    if (d <= maxM && (!best || d < best.d)) best = { spot: s, d };
  }
  if (!best) return undefined;
  return {
    key: best.spot.key,
    name: shortSpotName(best.spot.name),
    distanceM: Math.round(best.d),
    prob3d: clockFor(forecast, best.spot).prob,
  };
}

/** Everything the risk badge needs for one point. */
export function describePoint(band: RiskBand, nearby?: NearbySpot): PointRisk {
  const info = BAND_INFO[band] ?? BAND_INFO.none;
  const out: PointRisk = { band, ...info };
  if (nearby) out.nearby = nearby;
  return out;
}
