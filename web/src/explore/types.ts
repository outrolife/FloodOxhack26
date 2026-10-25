// Explore the map (#118 user request): click or search any point, see its
// official river flood risk and a sandbag estimate. Shared types for the
// pure logic (geocode.ts, risk.ts, sandbags.ts) and the UI components.
// Frontend only: no backend or model logic is involved.

/** EA Risk of Flooding from Rivers and Sea (NaFRA2, 4 bands), or "none" outside every mapped zone. */
export type RiskBand = "high" | "medium" | "low" | "very_low" | "none";

/** Something the map can fly to or a pin can describe. */
export interface Place {
  /** One line for people, e.g. "12 Botley Road, Oxford OX2 0HA". */
  label: string;
  lat: number;
  lon: number;
  kind: "postcode" | "address" | "place" | "point";
  postcode?: string;
}

/** A failed lookup, with a friendly message the UI can show as is. */
export class GeocodeError extends Error {
  constructor(
    message: string,
    readonly reason: "offline" | "not_found" | "rate_limited" | "network",
  ) {
    super(message);
    this.name = "GeocodeError";
  }
}

export interface Geocoder {
  /** Autocomplete: UK postcodes and addresses, Oxford first. Debounce in the caller; pass a signal to cancel. */
  suggest(query: string, signal?: AbortSignal): Promise<Place[]>;
  /** The address (or nearest named place) at a point. Rejects with GeocodeError. */
  reverse(lat: number, lon: number, signal?: AbortSignal): Promise<Place>;
}

/** The current FloodClock forecast at the nearest flood spot, when the point is close to one. */
export interface NearbySpot {
  key: string;
  name: string;
  distanceM: number;
  /** Chance of flooding in the next 3 days (0..1), or null with no forecast. */
  prob3d: number | null;
}

export interface PointRisk {
  band: RiskBand;
  /** Badge text, e.g. "High risk". */
  label: string;
  /** Badge colour (background), with a text colour that keeps contrast >= 4.5:1. */
  colour: string;
  textColour: string;
  /** One plain-English sentence, e.g. "This spot is in a high-risk river flood zone: ...". */
  sentence: string;
  nearby?: NearbySpot;
}

export type FloorLevel = "street" | "one_step" | "raised" | "upper";

/** What the user can adjust in the Sandbag estimate card. */
export interface PropertyInputs {
  doors: number;
  doorWidthM: number;
  basement: boolean;
  floorLevel: FloorLevel;
}

export interface SandbagEstimate {
  /** Expected flood depth from the risk band (m). */
  depthM: number;
  /** After the floor level (m), never below 0. */
  effectiveDepthM: number;
  layers: number;
  bagsPerLayer: number;
  /** Doors plus one for a basement. */
  openings: number;
  subtotal: number;
  margin: number;
  total: number;
  /** True when the depth is beyond what sandbags can hold back (capped layers). */
  capped: boolean;
  /** The worked example in plain English, one line per step, using these numbers. */
  steps: string[];
}
