// The one screen's flow map rules (#118): rivers that rise and flow, and the upstream chain.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Forecast, Spot, Station, TravelPair } from "../contracts";
import {
  FLOW_LOOK,
  bucketFor,
  chainLinks,
  forecastLevelAt,
  gaugeLevelsAt,
  levelAt,
  levelFraction,
  linesByGauge,
} from "./flow";

const read = <T,>(f: string): T => JSON.parse(readFileSync(new URL(`../../public/data/${f}`, import.meta.url), "utf8")) as T;
const stations = read<Station[]>("stations.json");
const spots = read<Spot[]>("spots.json");
const pairs = read<TravelPair[]>("travel_times.json");
const live = read<Forecast>("live.json");

describe("rivers that rise", () => {
  it("measures a level only against its own gauge's usual high and flood level", () => {
    expect(levelFraction(2.0, 2.0, 3.0)).toBe(0);
    expect(levelFraction(3.0, 2.0, 3.0)).toBe(1);
    expect(levelFraction(2.5, 2.0, 3.0)).toBeCloseTo(0.5);
    // No flood level on record: half a metre above the usual high counts as the top.
    expect(levelFraction(2.5, 2.0, null)).toBeCloseTo(1);
  });
  it("buckets the water from normal to above flood level, thicker and deeper each step", () => {
    expect(bucketFor(null)).toBe(0);
    expect(bucketFor(-0.2)).toBe(0);
    expect(bucketFor(0.1)).toBe(1);
    expect(bucketFor(0.5)).toBe(2);
    expect(bucketFor(0.9)).toBe(3);
    expect(bucketFor(1.2)).toBe(4);
    for (let b = 1; b <= 4; b++) {
      const k = b as 1 | 2 | 3 | 4;
      const prev = (b - 1) as 0 | 1 | 2 | 3;
      expect(FLOW_LOOK[k].widthX).toBeGreaterThan(FLOW_LOOK[prev].widthX);
      expect(FLOW_LOOK[k].seconds).toBeLessThan(FLOW_LOOK[prev].seconds);
    }
  });
  it("reads the last reading at or before t, never a later one", () => {
    const pts = [
      { t: "2026-01-01T00:00:00Z", level: 1 },
      { t: "2026-01-01T01:00:00Z", level: 2 },
    ];
    expect(levelAt(pts, Date.parse("2025-12-31T23:00:00Z"))).toBeNull();
    expect(levelAt(pts, Date.parse("2026-01-01T00:30:00Z"))).toBe(1);
    expect(levelAt(pts, Date.parse("2026-01-01T05:00:00Z"))).toBe(2);
  });
  it("in a replay, holds readings back by the lag (no future data)", () => {
    const observed = { newbotley: [{ t: "2026-01-01T00:00:00Z", level: 1 }, { t: "2026-01-01T01:00:00Z", level: 2 }] };
    const lv = gaugeLevelsAt({ stations: [{ key: "newbotley" }], observed, t: Date.parse("2026-01-01T01:30:00Z"), lagH: 1 });
    expect(lv.newbotley).toBe(1);
  });
  it("Now: past the last reading, a spot gauge follows the forecast middle", () => {
    const sf = live.spots.find((s) => s.leads.length > 0)!;
    const spot = spots.find((s) => s.key === sf.spot)!;
    const t0 = Date.parse(live.issuedAt);
    expect(forecastLevelAt(live, sf.spot, t0)).toBeCloseTo(sf.levelNow);
    const l24 = sf.leads.find((l) => l.h === 24);
    if (l24) expect(forecastLevelAt(live, sf.spot, t0 + 24 * 3_600_000)).toBeCloseTo(l24.q["50"]);
    expect(forecastLevelAt(live, sf.spot, t0 + 100 * 3_600_000)).toBeNull();
    const last = live.observed?.[spot.gauge]?.at(-1);
    if (last && l24) {
      const lv = gaugeLevelsAt({
        stations,
        observed: live.observed,
        t: Math.max(t0, Date.parse(last.t)) + 24 * 3_600_000,
        forecast: live,
        spotsByGauge: { [spot.gauge]: spot.key },
      });
      expect(lv[spot.gauge]).not.toBeNull();
    }
  });
  it("gives every basemap river line a gauge", () => {
    const fc = {
      type: "FeatureCollection" as const,
      features: [
        { type: "Feature" as const, properties: {}, geometry: { type: "LineString" as const, coordinates: [[-1.28, 51.752], [-1.281, 51.753]] } },
        { type: "Feature" as const, properties: {}, geometry: { type: "LineString" as const, coordinates: [[-1.239, 51.757], [-1.238, 51.758]] } },
      ],
    };
    const g = linesByGauge(fc, stations.filter((s) => s.key === "newbotley" || s.key === "kingsmill"));
    expect(g.newbotley.features).toHaveLength(1);
    expect(g.kingsmill.features).toHaveLength(1);
  });
});

describe("the upstream chain", () => {
  it("has one link per upstream gauge with a measured travel time, dash speed from it", () => {
    const links = chainLinks(stations, pairs);
    expect(links.length).toBeGreaterThan(0);
    for (const l of links) {
      expect(stations.find((s) => s.key === l.up)?.role).toBe("upstream");
      expect(l.seconds).toBeGreaterThanOrEqual(1.5);
      expect(l.seconds).toBeLessThanOrEqual(16);
    }
  });
});
