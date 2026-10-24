// #118: the bundled offline basemap is present, small, attributed and covers the spots.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import spots from "../../public/data/spots.json";

const url = new URL("../../public/data/geo/oxford-base.geojson", import.meta.url);
const KINDS = ["water", "river", "stream", "road", "minor_road", "rail", "building", "park"];

describe.skipIf(!existsSync(url))("oxford-base.geojson", () => {
  const fc = JSON.parse(readFileSync(url, "utf8")) as {
    attribution: string;
    bbox: [number, number, number, number];
    features: { properties: { kind: string }; geometry: { type: string } }[];
  };
  it("is under 3 MB and credits OpenStreetMap (ODbL)", () => {
    expect(statSync(url).size).toBeLessThan(3_000_000);
    expect(fc.attribution).toMatch(/OpenStreetMap contributors, ODbL/);
  });
  it("only uses kinds BaseMap knows, and has water, rivers, roads and buildings", () => {
    const kinds = new Set(fc.features.map((f) => f.properties.kind));
    for (const k of kinds) expect(KINDS).toContain(k);
    for (const k of ["water", "river", "road", "building"]) expect(kinds.has(k)).toBe(true);
  });
  it("covers every trouble spot", () => {
    const [w, s, e, n] = fc.bbox;
    for (const sp of spots as { lat: number; lon: number }[]) {
      expect(sp.lon).toBeGreaterThan(w);
      expect(sp.lon).toBeLessThan(e);
      expect(sp.lat).toBeGreaterThan(s);
      expect(sp.lat).toBeLessThan(n);
    }
  });
});
