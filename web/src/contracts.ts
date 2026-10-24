// JSON contracts between the pipeline/model and the web app.
//
// Mirrors SPEC.md §9 (core) and §11 (stretch) exactly. Do not edit one side
// alone: a contract change is a single PR that updates SPEC.md, this file and
// tests/fixtures/ together (SPEC §16).
//
// Conventions for every file (SPEC §9):
// - All files live under web/public/data/.
// - Times are ISO 8601 UTC strings ending in "Z", e.g. "2026-10-25T01:15:00Z".
//   Convert to Europe/London only for display.
// - Levels are metres on each gauge's own local datum. Never compare a level
//   from one gauge with a level from another.
// - Probabilities are numbers in [0, 1].
// - Durations ending in H are hours.

// ---------------------------------------------------------------------------
// Core (SPEC §9)
// ---------------------------------------------------------------------------

/** stations.json: one entry per river gauge (SPEC §4.1). */
export type Station = {
  key: string; // e.g. "osney"
  name: string; // e.g. "Osney Lock d/s"
  river: string; // e.g. "Thames"
  role: "upstream" | "target" | "live_only"; // live_only: shown live, never forecast (SPEC §4.1.1)
  ref: string; // EA stationReference, e.g. "1303TH"
  lat: number;
  lon: number;
  amber: number; // m, gauge datum: normal-range top (typicalRangeHigh)
  threshold: number | null; // m, gauge datum: property flooding possible
  record: number | null; // m, gauge datum: highest on record
};

/** spots.json: one entry per trouble spot (SPEC §4.2). */
export type Spot = {
  key: string; // e.g. "osney"
  name: string;
  gauge: string; // Station.key
  threshold: number; // m, on that gauge's datum
  amber: number; // m, on that gauge's datum
  lat: number;
  lon: number;
  warningArea: string; // EA warning area code, e.g. "061FWF23BnsyOsny"
  mode: "probability" | "timing_only";
};

/** events.json: one entry per backtest flood event (SPEC §4.3). */
export type EventMeta = {
  id: string; // e.g. "e2014"
  name: string;
  start: string; // ISO 8601 UTC
  end: string; // ISO 8601 UTC
  peak: Record<string /*gauge*/, number>; // m, each on its own gauge datum
  headline: boolean;
};

/** travel_times.json: one entry per upstream -> downstream gauge pair (SPEC §6). */
export type TravelPair = {
  up: string; // Station.key
  down: string; // Station.key
  n: number; // number of events used
  tHalf: { p10: number; median: number; p90: number }; // hours
  tPeak: { p10: number; median: number; p90: number }; // hours
  events: {
    eventId: string; // EventMeta.id
    tHalf: number | null; // hours
    tPeak: number | null; // hours
    rise: number; // m, upstream peak minus baseline (upstream gauge datum)
    excluded?: string; // reason the event was not used
  }[];
  xcorr: { lagH: number; r: number }[]; // lags 0-120 h; r in [-1, 1]
  slopeHoursPerMetre: number | null; // fit of tHalf against rise
};

/** Quantile keys: "05" is the 5% quantile ... "95" the 95% quantile. */
export type QuantKey = "05" | "10" | "25" | "50" | "75" | "90" | "95";

/** One spot's forecast, inside a Forecast. */
export type SpotForecast = {
  spot: string; // Spot.key
  levelNow: number; // m, gauge datum
  leads: {
    h: number; // lead time, hours: 6 | 12 | 24 | 36 | 48 | 72
    q: Record<QuantKey, number>; // m, gauge datum; non-decreasing 05 -> 95
    pFlood: number | null; // P(level >= threshold); null for timing_only
    pAmber: number; // P(level >= amber)
  }[]; // [] when the spot's gauge is stale
  arrival: { p10: string | null; p50: string | null; p90: string | null } | null; // ISO 8601 UTC
  mode: "probability" | "timing_only";
};

/** live.json, and each element of Replay.forecasts. */
export type Forecast = {
  issuedAt: string; // ISO 8601 UTC
  dataAsOf: Record<string /*gauge*/, string>; // latest reading time per gauge, ISO 8601 UTC
  stale: string[]; // Station.key of gauges whose latest reading is > 3 h old
  spots: SpotForecast[];
};

/** replays/{eventId}.json: the Time Machine data for one event (SPEC §8.1). */
export type Replay = {
  eventId: string; // EventMeta.id
  name: string;
  start: string; // ISO 8601 UTC
  end: string; // ISO 8601 UTC
  observed: Record<string /*gauge*/, { t: string; level: number }[]>; // hourly; m, gauge datum
  forecasts: Forecast[]; // one per hour
  official: {
    spot: string; // Spot.key
    type: "alert" | "warning" | "severe";
    issuedAt: string; // ISO 8601 UTC
    precision: "time" | "date";
  }[];
  crossings: { spot: string; t: string }[]; // observed threshold crossings, ISO 8601 UTC
};

/** proof.json: evaluation metrics (SPEC §8.2). */
export type Proof = {
  skillByLead: {
    h: number;
    pinballModel: number;
    pinballPersistence: number;
    skill: number; // 1 - pinballModel / pinballPersistence
  }[];
  coverage: { h: number; nominal: number; actual: number }[]; // fractions 0-1
  reliability: Record<
    string /*spot*/,
    {
      h: number;
      bins: { pPred: number; pObs: number; n: number }[];
      brier: number;
      brierPersistence: number;
    }[]
  >;
  tradeoff: Record<
    string /*spot*/,
    {
      pStar: number; // trigger probability 0.1 ... 0.9
      hits: number;
      misses: number;
      falseAlarms: number;
      meanLeadH: number | null; // hours
      meanLeadVsOfficialH: number | null; // hours; positive = earlier than official
      ci90?: [number, number];
    }[]
  >;
  perEvent: {
    eventId: string; // EventMeta.id
    spot: string; // Spot.key
    crossed: boolean;
    peakObs: number; // m, gauge datum
    arrivalErrH: number | null; // hours: predicted 50% time - actual crossing
    leadVsOfficialH: number | null; // hours
  }[];
  testPeriodNote: string;
};

/** quality.json: data-quality report (SPEC §5.3). */
export type Quality = {
  gauges: {
    key: string; // Station.key
    coveragePct: number; // 0-100
    gapsFilled: number;
    gapsFlagged: number;
    spikesRemoved: number;
    thresholdApi: number | null; // m, gauge datum
    thresholdConfig: number | null; // m, gauge datum
    notes: string[];
  }[];
  sources: {
    name: string;
    url: string;
    licence: string;
    downloadedAt: string; // ISO 8601 UTC
    rows: number;
  }[];
};

/** importance.json: LightGBM gain per feature, per target gauge and lead. */
export type Importance = Record<
  string /*gauge*/,
  { h: number; features: { name: string; gain: number }[] }[]
>;

// ---------------------------------------------------------------------------
// File shapes
// SPEC §9 names the element type of these files but not their top level.
// These aliases record the assumption that list files are top-level arrays.
// ---------------------------------------------------------------------------

export type StationsFile = Station[]; // stations.json
export type SpotsFile = Spot[]; // spots.json
export type EventsFile = EventMeta[]; // events.json
export type TravelTimesFile = TravelPair[]; // travel_times.json
export type LiveFile = Forecast; // live.json

/** The lead times every forecast uses (SPEC §7.1). */
export const LEAD_HOURS = [6, 12, 24, 36, 48, 72] as const;

/** QuantKey values in increasing order. */
export const QUANT_KEYS: readonly QuantKey[] = ["05", "10", "25", "50", "75", "90", "95"];

// ---------------------------------------------------------------------------
// Stretch (SPEC §11). Only used by stretch/ features; may never be produced.
// ---------------------------------------------------------------------------

/** S1, geo/risk_layers.json: official flood-risk map layers. */
export type RiskLayers = {
  layers: {
    id: string;
    name: string;
    type: "wms" | "geojson";
    url: string;
    attribution: string;
    legend: { label: string; colour: string }[];
  }[];
};

/** S2, ensemble_rain.json: ensemble rainfall context (not a model input). */
export type EnsembleRain = {
  issuedAt: string; // ISO 8601 UTC
  points: string[]; // catchment points, e.g. "eynsham"
  hours: number[]; // hours after issuedAt
  cumMm: { p10: number[]; p50: number[]; p90: number[] }; // cumulative mm, catchment mean; same length as hours
};

/** S3, spread/{eventId|live}/manifest.json: experimental flood-spread overlays. */
export type SpreadManifest = {
  bounds: [[number, number], [number, number]]; // [[latS, lonW], [latN, lonE]]
  runs: number;
  frames: { tau: number; issuedAt: string; png: string }[]; // tau in hours
  validation: { eventId: string; iou: number } | null;
  caveats: string[];
};

/** S4, sandbags.json: sandbag inspection screening. */
export type Sandbags = {
  issuedAt: string; // ISO 8601 UTC
  budget: number; // bags
  candidates: {
    id: string;
    lat: number;
    lon: number;
    score: number;
    pWet48: number; // probability 0-1
    medianDepthM: number; // metres of water depth
    firstWet: string | null; // ISO 8601 UTC
    bags: number;
    reasons: string[];
    checks: string[];
  }[];
  excluded: { id: string; reason: string }[];
};
