// Explore (#118): a rough, transparent sandbag estimate for a home.
// Deliberately simple so anyone can check it by hand:
//   depth       = expected flood depth for the risk band
//   effective   = max(0, depth - how far the floor sits above the street)
//   layers      = ceil(effective / bag height), at most MAX_LAYERS
//   per layer   = ceil((door width + overlap) / bag length)
//   openings    = doors (+ 1 for a basement)
//   total       = openings x layers x per layer, plus 10 % spare
// EA guidance: sandbags are not effective against water deeper than about 0.6 m.
import { BAND_INFO } from "./risk";
import type { FloorLevel, PropertyInputs, RiskBand, SandbagEstimate } from "./types";

/** Expected flood depth to plan for, by risk band (m). */
export const DEPTH_BY_BAND_M: Record<RiskBand, number> = { high: 0.6, medium: 0.4, low: 0.25, very_low: 0.1, none: 0.1 };

/** How far the floor sits above the street (m). "upper" = upper-floor flat: no bags needed at the flat itself. */
export const FLOOR_RAISE_M: Record<FloorLevel, number> = { street: 0, one_step: 0.15, raised: 0.3, upper: Infinity };

export const FLOOR_LABEL: Record<FloorLevel, string> = {
  street: "Floor at street level",
  one_step: "Floor one step up",
  raised: "Raised floor",
  upper: "Upper-floor flat",
};

/** Height of one filled bag laid flat (m). */
export const BAG_HEIGHT_M = 0.1;
/** Most layers we stack: 6 x 0.1 m = 0.6 m, the EA limit for sandbags. */
export const MAX_LAYERS = 6;
/** Length of one filled bag (m). */
export const BAG_LENGTH_M = 0.45;
/** Extra width past the door frame, both sides together (m). */
export const OVERLAP_M = 0.3;
/** Spare bags on top, as a fraction. */
export const MARGIN = 0.1;

export const DOORS_MIN = 1;
export const DOORS_MAX = 10;
export const WIDTH_MIN_M = 0.6;
export const WIDTH_MAX_M = 3.0;

export const DEFAULT_INPUTS: PropertyInputs = { doors: 2, doorWidthM: 0.9, basement: false, floorLevel: "street" };

/** The general formula in words, for the "How we calculated this" expander. */
export const FORMULA_PLAIN: string[] = [
  `Start from the flood depth to plan for in this risk zone: High ${DEPTH_BY_BAND_M.high} m, Medium ${DEPTH_BY_BAND_M.medium} m, Low ${DEPTH_BY_BAND_M.low} m, Very low or outside the zones ${DEPTH_BY_BAND_M.very_low} m.`,
  `Take off how high your floor sits above the street (one step ${FLOOR_RAISE_M.one_step} m, raised floor ${FLOOR_RAISE_M.raised} m). An upper-floor flat needs no bags at the flat itself.`,
  `Each filled bag laid flat is about ${BAG_HEIGHT_M} m tall, so layers = remaining depth ÷ ${BAG_HEIGHT_M} m, rounded up, at most ${MAX_LAYERS} layers.`,
  `Each bag is about ${BAG_LENGTH_M} m long. Bags per layer = (door width + ${OVERLAP_M} m overlap) ÷ ${BAG_LENGTH_M} m, rounded up.`,
  `Openings = doors, plus one if you have a basement (light well or door).`,
  `Total = openings × layers × bags per layer, plus ${MARGIN * 100}% spare (rounded up).`,
  `Environment Agency guidance: sandbags are not effective against water deeper than about 0.6 m. Above that, move valuables up and follow official warnings.`,
];

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Round away floating-point noise (0.6 / 0.1 = 5.999…) before ceil. */
const ceilClean = (x: number) => Math.ceil(Math.round(x * 1e6) / 1e6);
const m = (x: number) => `${+x.toFixed(2)} m`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Clamp and tidy user inputs: doors 1–10 (whole), width 0.6–3.0 m, known floor level. */
export function sanitizeInputs(inputs: Partial<PropertyInputs> | null | undefined): PropertyInputs {
  const i = { ...DEFAULT_INPUTS, ...(inputs ?? {}) };
  const doors = Number.isFinite(i.doors) ? Math.round(clamp(i.doors, DOORS_MIN, DOORS_MAX)) : DEFAULT_INPUTS.doors;
  const doorWidthM = Number.isFinite(i.doorWidthM)
    ? +clamp(i.doorWidthM, WIDTH_MIN_M, WIDTH_MAX_M).toFixed(2)
    : DEFAULT_INPUTS.doorWidthM;
  const floorLevel = i.floorLevel in FLOOR_RAISE_M ? i.floorLevel : DEFAULT_INPUTS.floorLevel;
  return { doors, doorWidthM, basement: !!i.basement, floorLevel };
}

/**
 * Same formula from an explicit depth (m). `zoneText` opens the worked example,
 * e.g. "High risk zone". estimateSandbags is the normal entry point.
 */
export function estimateForDepth(depthM: number, rawInputs: Partial<PropertyInputs>, zoneText: string): SandbagEstimate {
  const inputs = sanitizeInputs(rawInputs);
  const raise = FLOOR_RAISE_M[inputs.floorLevel];
  const effectiveDepthM = Math.max(0, +(depthM - raise).toFixed(3)) || 0; // Infinity raise → 0
  const uncapped = ceilClean(effectiveDepthM / BAG_HEIGHT_M);
  const capped = uncapped > MAX_LAYERS;
  const layers = Math.min(MAX_LAYERS, uncapped);
  const bagsPerLayer = ceilClean((inputs.doorWidthM + OVERLAP_M) / BAG_LENGTH_M);
  const openings = inputs.doors + (inputs.basement ? 1 : 0);
  const subtotal = openings * layers * bagsPerLayer;
  const margin = ceilClean(subtotal * MARGIN);
  const total = subtotal + margin;

  const steps: string[] = [`1. ${zoneText} → plan for about ${m(depthM)} of water.`];
  if (inputs.floorLevel === "upper") {
    steps.push("2. Upper-floor flat → no sandbags needed at the flat itself (the building's ground-floor doors may still need them).");
    steps.push("3. Total: **0 sandbags**.");
    return { depthM, effectiveDepthM: 0, layers: 0, bagsPerLayer, openings, subtotal: 0, margin: 0, total: 0, capped: false, steps };
  }
  steps.push(
    raise > 0
      ? `2. ${FLOOR_LABEL[inputs.floorLevel]} (${m(raise)}) → ${m(depthM)} − ${m(raise)} = ${m(effectiveDepthM)} at the door.`
      : `2. ${FLOOR_LABEL[inputs.floorLevel]} → about ${m(effectiveDepthM)} at the door.`,
  );
  if (layers === 0) {
    steps.push("3. Your floor sits above the expected water → no sandbags needed.");
    steps.push("4. Total: **0 sandbags**.");
    return { depthM, effectiveDepthM, layers, bagsPerLayer, openings, subtotal, margin, total, capped, steps };
  }
  steps.push(
    capped
      ? `3. ${m(effectiveDepthM)} ÷ ${BAG_HEIGHT_M} m per bag = ${uncapped} layers, capped at ${MAX_LAYERS}: sandbags are not effective above about 0.6 m (EA guidance).`
      : `3. ${m(effectiveDepthM)} ÷ ${BAG_HEIGHT_M} m per bag = ${plural(layers, "layer")} (rounded up).`,
  );
  steps.push(
    `4. ${m(inputs.doorWidthM)} door + ${m(OVERLAP_M)} overlap = ${m(inputs.doorWidthM + OVERLAP_M)} ÷ ${BAG_LENGTH_M} m per bag = ${plural(bagsPerLayer, "bag")} per layer (rounded up).`,
  );
  const who = inputs.basement
    ? `${plural(inputs.doors, "door")} + 1 basement = ${openings} openings`
    : plural(inputs.doors, "door");
  steps.push(
    `5. ${who} × ${plural(layers, "layer")} × ${plural(bagsPerLayer, "bag")} = ${subtotal} bags, plus ${MARGIN * 100}% spare (${margin}) = **${total} sandbags**.`,
  );
  return { depthM, effectiveDepthM, layers, bagsPerLayer, openings, subtotal, margin, total, capped, steps };
}

/** Sandbags for a home in this risk band, with the worked example in plain English. */
export function estimateSandbags(band: RiskBand, inputs: Partial<PropertyInputs> = DEFAULT_INPUTS): SandbagEstimate {
  const depth = DEPTH_BY_BAND_M[band] ?? DEPTH_BY_BAND_M.none;
  const zone = band === "none" ? "Outside the mapped zones" : `${BAND_INFO[band].label} zone`;
  return estimateForDepth(depth, inputs, zone);
}
