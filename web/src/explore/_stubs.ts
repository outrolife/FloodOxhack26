// TEMPORARY stand-ins for fc-explore-logic's geocode.ts / risk.ts / sandbags.ts.
// Deleted once origin/app/explore-logic is merged; logic.ts then re-exports the real modules.
import type { FeatureCollection } from "geojson";
import type { Forecast, Spot } from "../contracts";
import type { FloorLevel, Geocoder, NearbySpot, Place, PointRisk, PropertyInputs, RiskBand, SandbagEstimate } from "./types";
import { GeocodeError } from "./types";

const SAMPLE: Place[] = [
  { label: "Botley Road, Oxford OX2 0HA", lat: 51.7522, lon: -1.2795, kind: "postcode", postcode: "OX2 0HA" },
  { label: "Osney Island, Oxford OX2 0AZ", lat: 51.7503, lon: -1.2728, kind: "address", postcode: "OX2 0AZ" },
  { label: "Abingdon Road, Oxford OX1 4PU", lat: 51.7385, lon: -1.2541, kind: "address", postcode: "OX1 4PU" },
];
const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      rej(new DOMException("aborted", "AbortError"));
    });
  });

export const geocoder: Geocoder = {
  async suggest(query, signal) {
    await wait(150, signal);
    const q = query.toLowerCase();
    if (q.includes("zzz")) throw new GeocodeError("We couldn't find that address. Try a postcode like OX2 0HA.", "not_found");
    return SAMPLE.filter((p) => p.label.toLowerCase().includes(q) || q.length >= 2);
  },
  async reverse(lat, lon, signal) {
    await wait(400, signal);
    return { label: `Near ${lat.toFixed(4)}, ${lon.toFixed(4)}, Oxford`, lat, lon, kind: "point" };
  },
};

export const BAND_INFO: Record<RiskBand, { label: string; zoneLabel: string; words: string }> = {
  high: { label: "High risk", zoneLabel: "High risk zone", words: "more than 1 in 30 chance each year" },
  medium: { label: "Medium risk", zoneLabel: "Medium risk zone", words: "1 in 100 to 1 in 30 each year" },
  low: { label: "Low risk", zoneLabel: "Low risk zone", words: "1 in 1000 to 1 in 100 each year" },
  very_low: { label: "Very low risk", zoneLabel: "Very low risk zone", words: "less than 1 in 1000 each year" },
  none: { label: "Not in a flood zone", zoneLabel: "No mapped zone", words: "outside every mapped river flood zone" },
};
export const BAND_HEX: Record<RiskBand, string> = { high: "#b3261e", medium: "#e07b16", low: "#f2c94c", very_low: "#d7e6cf", none: "#e4e3de" };

function inRing(ring: number[][], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const ORDER: RiskBand[] = ["high", "medium", "low", "very_low"];
export function bandAt(zones: FeatureCollection, lat: number, lon: number): RiskBand {
  let best: RiskBand = "none";
  for (const f of zones.features) {
    const g = f.geometry;
    const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
    if (polys.some((p) => inRing(p[0] as number[][], lon, lat))) {
      const b = f.properties?.band as RiskBand;
      if (best === "none" || ORDER.indexOf(b) < ORDER.indexOf(best)) best = b;
    }
  }
  return best;
}
export function nearbySpot(lat: number, lon: number, spots: Spot[], forecast: Forecast | null): NearbySpot | undefined {
  let out: NearbySpot | undefined;
  for (const s of spots) {
    const d = Math.hypot((s.lat - lat) * 111_320, (s.lon - lon) * 69_000);
    if (d < 1500 && (!out || d < out.distanceM)) {
      const f = (forecast?.spots as Record<string, { prob?: Record<string, number> }> | undefined)?.[s.key];
      out = { key: s.key, name: s.name.split(" / ")[0].trim(), distanceM: d, prob3d: f?.prob?.["72"] ?? null };
    }
  }
  return out;
}
export function describePoint(band: RiskBand, nearby?: NearbySpot): PointRisk {
  const i = BAND_INFO[band];
  return {
    band,
    label: i.label,
    colour: BAND_HEX[band],
    textColour: band === "high" ? "#fff" : band === "none" ? "#3d3c38" : "#1a1a1a",
    sentence:
      band === "none" ? "This spot is outside the mapped river flood zones." : `This spot is in a ${i.label.toLowerCase()} river flood zone: ${i.words}.`,
    nearby,
  };
}

export const DEFAULT_INPUTS: PropertyInputs = { doors: 2, doorWidthM: 0.9, basement: false, floorLevel: "street" };
export const FORMULA_PLAIN =
  "We take a likely flood depth for the risk band, subtract your floor height, work out how many layers of sandbags that needs (each bag is about 10 cm high once flattened), multiply by bags per layer across each door, then add 20% for gaps and spares.";
const DEPTH: Record<RiskBand, number> = { high: 0.6, medium: 0.4, low: 0.25, very_low: 0.1, none: 0 };
const FLOOR: Record<FloorLevel, number> = { street: 0, one_step: 0.15, raised: 0.45, upper: 3 };
export function estimateSandbags(band: RiskBand, inp: PropertyInputs): SandbagEstimate {
  const depthM = DEPTH[band];
  const effectiveDepthM = Math.max(0, depthM - FLOOR[inp.floorLevel]);
  const raw = Math.ceil(effectiveDepthM / 0.1);
  const layers = Math.min(raw, 6);
  const bagsPerLayer = Math.ceil(inp.doorWidthM / 0.45) + 1;
  const openings = inp.doors + (inp.basement ? 1 : 0);
  const subtotal = layers * bagsPerLayer * openings;
  const margin = Math.ceil(subtotal * 0.2);
  return {
    depthM,
    effectiveDepthM,
    layers,
    bagsPerLayer,
    openings,
    subtotal,
    margin,
    total: subtotal + margin,
    capped: raw > 6,
    steps: [
      `Likely depth for this band: ${depthM.toFixed(2)} m, minus your floor height leaves ${effectiveDepthM.toFixed(2)} m.`,
      `${layers} layers of bags at about 10 cm each.`,
      `${bagsPerLayer} bags per layer across a ${inp.doorWidthM.toFixed(1)} m door, for ${openings} openings: ${subtotal} bags.`,
      `Plus 20% for gaps and spares (${margin}): ${subtotal + margin} bags.`,
    ],
  };
}
