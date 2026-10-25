// #118 "Try an example": the example address must stay in the EA high-risk
// zone of the shipped offline zones file, so one click shows the full result.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { FeatureCollection } from "geojson";
import { bandAt } from "./risk";
import { estimateSandbags, DEFAULT_INPUTS } from "./sandbags";
import { EXAMPLE_PLACE } from "./SearchBox";

const zones = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../public/data/geo/risk-zones.geojson", import.meta.url)), "utf-8"),
) as FeatureCollection;

describe("EXAMPLE_PLACE", () => {
  it("sits in the high-risk zone and gets a sandbag estimate", () => {
    expect(bandAt(zones, EXAMPLE_PLACE.lat, EXAMPLE_PLACE.lon)).toBe("high");
    expect(estimateSandbags("high", DEFAULT_INPUTS).total).toBeGreaterThan(0);
  });
});
