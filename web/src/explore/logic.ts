// The pure Explore logic the UI components use (fc-explore-logic: geocode.ts, risk.ts, sandbags.ts).
// Components import from here, not from index.ts, so there is no import cycle through the barrel.
export { geocoder, MIN_QUERY } from "./geocode";
export { BAND_INFO, BAND_HEX, bandAt, nearbySpot, describePoint } from "./risk";
export { DEFAULT_INPUTS, FORMULA_PLAIN, FLOOR_LABEL, DOORS_MIN, DOORS_MAX, WIDTH_MIN_M, WIDTH_MAX_M, estimateSandbags } from "./sandbags";
