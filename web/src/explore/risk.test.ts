import { describe, expect, it } from "vitest";
import type { FeatureCollection, Position } from "geojson";
import type { Forecast, Spot } from "../contracts";
import { BAND_HEX, BAND_INFO, bandAt, describePoint, haversineM, nearbySpot } from "./risk";
import type { RiskBand } from "./types";

const sq = (x0: number, y0: number, x1: number, y1: number): Position[] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
  [x0, y0],
];

// Low zone 0..10 with a hole 4..6; a medium zone nested at 2..8 (overlaps the hole);
// a high MultiPolygon with two parts at 20..22 and 30..32; a junk feature.
const zones: FeatureCollection = {
  type: "FeatureCollection",
  features: [
    { type: "Feature", properties: { band: "low" }, geometry: { type: "Polygon", coordinates: [sq(0, 0, 10, 10), sq(4, 4, 6, 6)] } },
    { type: "Feature", properties: { band: "medium" }, geometry: { type: "Polygon", coordinates: [sq(2, 2, 8, 8)] } },
    {
      type: "Feature",
      properties: { band: "high" },
      geometry: { type: "MultiPolygon", coordinates: [[sq(20, 20, 22, 22)], [sq(30, 30, 32, 32)]] },
    },
    { type: "Feature", properties: { band: "very_low" }, geometry: { type: "Polygon", coordinates: [sq(-5, -5, 40, 40)] } },
    { type: "Feature", properties: { band: "bogus" }, geometry: { type: "Polygon", coordinates: [sq(0, 0, 100, 100)] } },
    { type: "Feature", properties: { band: "high" }, geometry: { type: "Point", coordinates: [1, 1] } },
  ],
};

describe("bandAt", () => {
  it("returns the band of a simple polygon", () => {
    expect(bandAt(zones, 1, 1)).toBe("low"); // lat=y, lon=x
  });
  it("picks the highest of nested zones", () => {
    expect(bandAt(zones, 3, 3)).toBe("medium");
  });
  it("respects holes but still sees zones that cover the hole", () => {
    expect(bandAt(zones, 5, 5)).toBe("medium"); // in low's hole, inside medium
  });
  it("handles every part of a MultiPolygon", () => {
    expect(bandAt(zones, 21, 21)).toBe("high");
    expect(bandAt(zones, 31, 31)).toBe("high");
    expect(bandAt(zones, 25, 25)).toBe("very_low");
  });
  it("is none outside every zone, and ignores unknown bands and non-polygons", () => {
    expect(bandAt(zones, 50, 50)).toBe("none");
    expect(bandAt({ type: "FeatureCollection", features: [] }, 1, 1)).toBe("none");
    expect(bandAt(null, 1, 1)).toBe("none");
    expect(bandAt(zones, NaN, 1)).toBe("none");
  });
  it("works with a hole-only gap (no outer zone around it)", () => {
    const fc: FeatureCollection = {
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: { band: "high" }, geometry: { type: "Polygon", coordinates: [sq(0, 0, 10, 10), sq(4, 4, 6, 6)] } }],
    };
    expect(bandAt(fc, 5, 5)).toBe("none");
    expect(bandAt(fc, 9, 9)).toBe("high");
  });
});

describe("BAND_INFO", () => {
  const bands: RiskBand[] = ["high", "medium", "low", "very_low", "none"];
  it("has the agreed labels", () => {
    expect(bands.map((b) => BAND_INFO[b].label)).toEqual(["High risk", "Medium risk", "Low risk", "Very low risk", "Outside mapped zones"]);
  });
  it("uses the design tokens with the hex fallbacks", () => {
    expect(BAND_INFO.high.colour).toBe(`var(--fc-risk-high, ${BAND_HEX.high.fill})`);
    expect(BAND_INFO.very_low.colour).toContain("--fc-risk-verylow");
    expect(BAND_INFO.very_low.textColour).toContain("--fc-risk-verylow-ink");
    expect(BAND_INFO.none.colour).toContain("--fc-risk-none");
  });
  it("says each band in one sentence with the EA odds", () => {
    expect(BAND_INFO.high.sentence).toContain("1 in 30");
    expect(BAND_INFO.medium.sentence).toContain("1 in 100");
    expect(BAND_INFO.low.sentence).toContain("1 in 1000");
    expect(BAND_INFO.none.sentence).toContain("surface water");
    for (const b of bands) expect(BAND_INFO[b].sentence.split(". ").length).toBe(1);
  });
});

const spots: Spot[] = [
  { key: "osney", name: "Osney / West Oxford", gauge: "osney", threshold: 3, amber: 2, lat: 51.751, lon: -1.27, warningArea: "x", mode: "probability" },
  { key: "far", name: "Far away", gauge: "far", threshold: 3, amber: 2, lat: 52.5, lon: -1.27, warningArea: "y", mode: "probability" },
];
const forecast = {
  issuedAt: "2026-10-25T06:00:00Z",
  spots: [{ spot: "osney", mode: "probability", leads: [{ h: 6, pFlood: 0.2 }, { h: 72, pFlood: 0.55 }] }],
} as unknown as Forecast;

describe("nearbySpot", () => {
  it("finds the nearest spot within range, with its 3-day chance", () => {
    const n = nearbySpot(51.752, -1.268, spots, forecast);
    expect(n).toMatchObject({ key: "osney", name: "Osney", prob3d: 0.55 });
    expect(n!.distanceM).toBeGreaterThan(100);
    expect(n!.distanceM).toBeLessThan(250);
  });
  it("is undefined when nothing is within maxM", () => {
    expect(nearbySpot(51.9, -1.0, spots, forecast)).toBeUndefined();
    expect(nearbySpot(51.752, -1.268, spots, forecast, 50)).toBeUndefined();
  });
  it("gives prob3d null without a forecast", () => {
    expect(nearbySpot(51.751, -1.27, spots, null)?.prob3d).toBeNull();
  });
  it("haversine is about right", () => {
    expect(haversineM(51.75, -1.25, 51.76, -1.25)).toBeCloseTo(1112, -1);
  });
});

describe("describePoint", () => {
  it("combines the band info and the nearby spot", () => {
    const nearby = { key: "osney", name: "Osney", distanceM: 120, prob3d: 0.3 };
    expect(describePoint("high", nearby)).toEqual({ band: "high", ...BAND_INFO.high, nearby });
    expect(describePoint("none").nearby).toBeUndefined();
    expect(describePoint("none").label).toBe("Outside mapped zones");
  });
});
