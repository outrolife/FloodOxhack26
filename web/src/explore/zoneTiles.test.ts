// Map perf: the risk zones as cached tiles with level of detail (zoneTiles.ts).
import { describe, expect, it } from "vitest";
import type { FeatureCollection } from "geojson";
import { mercatorUnit } from "./mercator";
import { buildZoneIndex, clipRing, drawZoneTile, zoneAt, zonesInBox } from "./zoneTiles";

/** A square zone around (lat, lon), `d` degrees across, with `n` vertices per side, and an optional hole. */
function square(lat: number, lon: number, d: number, n = 1, hole = false) {
  const ring: [number, number][] = [];
  const corners: [number, number][] = [[lon, lat], [lon + d, lat], [lon + d, lat + d], [lon, lat + d]]; // prettier-ignore
  for (let c = 0; c < 4; c++) {
    const [ax, ay] = corners[c];
    const [bx, by] = corners[(c + 1) % 4];
    for (let i = 0; i < n; i++) ring.push([ax + ((bx - ax) * i) / n, ay + ((by - ay) * i) / n]);
  }
  ring.push(ring[0]);
  const h = d / 4;
  const holeRing: [number, number][] = [[lon + h, lat + h], [lon + 3 * h, lat + h], [lon + 3 * h, lat + 3 * h], [lon + h, lat + 3 * h], [lon + h, lat + h]]; // prettier-ignore
  return hole ? [ring, holeRing] : [ring];
}

const fc: FeatureCollection = {
  type: "FeatureCollection",
  features: [
    { type: "Feature", properties: { band: "high" }, geometry: { type: "Polygon", coordinates: square(51.75, -1.28, 0.01, 200, true) } },
    { type: "Feature", properties: { band: "low" }, geometry: { type: "MultiPolygon", coordinates: [square(51.7, -1.3, 0.002), square(51.8, -1.2, 0.00001)] } },
  ],
};

/** A 2D context stand-in that counts vertices. */
function counter() {
  const c = { moves: 0, lines: 0, fills: 0, fillStyle: "", strokeStyle: "", lineWidth: 0, lineJoin: "" };
  return Object.assign(c, {
    beginPath() {},
    closePath() {},
    moveTo() {
      c.moves++;
    },
    lineTo() {
      c.lines++;
    },
    fill() {
      c.fills++;
    },
    stroke() {},
  });
}
const paint = () => ({ fill: "rgba(0,0,0,0.3)", stroke: "#000" });
/** The tile (x, y) at zoom z that holds (lat, lon). */
function tileAt(lat: number, lon: number, z: number) {
  const [x, y] = mercatorUnit(lat, lon);
  return [Math.floor(x * 2 ** z), Math.floor(y * 2 ** z)] as const;
}

describe("zone index", () => {
  const ix = buildZoneIndex(fc);
  it("has one zone per polygon part", () => {
    expect(ix.zones.map((z) => z.band)).toEqual(["high", "low", "low"]);
  });
  it("finds the zone under a point, and not inside its hole", () => {
    expect(zoneAt(ix, ...mercatorUnit(51.751, -1.279))?.band).toBe("high");
    expect(zoneAt(ix, ...mercatorUnit(51.755, -1.275))).toBeNull(); // the hole
    expect(zoneAt(ix, ...mercatorUnit(51.701, -1.299))?.band).toBe("low");
    expect(zoneAt(ix, ...mercatorUnit(51.6, -1.0))).toBeNull();
  });
  it("lists only the zones in a box", () => {
    const [x0, y0] = mercatorUnit(51.76, -1.29);
    const [x1, y1] = mercatorUnit(51.74, -1.26);
    expect(zonesInBox(ix, x0, y0, x1, y1).map((z) => z.band)).toEqual(["high"]);
  });
});

describe("drawZoneTile (level of detail)", () => {
  const ix = buildZoneIndex(fc);
  it("draws far fewer vertices zoomed out than zoomed in, and leaves out zones under a pixel", () => {
    const far = counter();
    const [fx, fy] = tileAt(51.75, -1.28, 9);
    const nFar = drawZoneTile(far, ix, fx, fy, 9, 256, paint);
    const near = counter();
    const [nx, ny] = tileAt(51.7505, -1.2795, 16);
    const nNear = drawZoneTile(near, ix, nx, ny, 16, 256, paint);
    expect(nFar).toBeGreaterThan(0);
    expect(nFar).toBeLessThan(60); // ~800 vertices squeezed into a few pixels
    expect(nNear).toBeGreaterThan(nFar);
  });
  it("draws nothing on an empty tile", () => {
    const c = counter();
    const [x, y] = tileAt(52.5, -0.5, 14);
    expect(drawZoneTile(c, ix, x, y, 14, 256, paint)).toBe(0);
    expect(c.fills).toBe(0);
  });
});

describe("clipRing", () => {
  it("keeps a ring inside the box as it is", () => {
    const r = [10, 10, 20, 10, 20, 20, 10, 20];
    expect(clipRing(r, 0, 256)).toEqual(r);
  });
  it("cuts a big ring down to the box", () => {
    const out = clipRing([-1000, -1000, 1000, -1000, 1000, 1000, -1000, 1000], -4, 260);
    expect(out.length / 2).toBe(4);
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(-4);
      expect(v).toBeLessThanOrEqual(260);
    }
  });
  it("drops a ring wholly outside", () => {
    expect(clipRing([300, 300, 400, 300, 400, 400], -4, 260)).toEqual([]);
  });
});
