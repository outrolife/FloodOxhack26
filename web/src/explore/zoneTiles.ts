// The risk zones drawn the way a web map draws its streets (map perf, user
// feedback: "still laggy"): as 256 px image tiles, each drawn once for its zoom
// level and then kept. While zooming or panning the browser only moves and
// scales finished tiles, so nothing is redrawn on every frame and no zoom ends
// with a redraw of all ~3,900 zones.
//
// Level of detail: a tile draws only the zones that touch it, skips zones
// smaller than about a pixel at that zoom, and drops vertices closer than half
// a pixel to the last one drawn. Zoomed out (the catchment view) that is a few
// thousand points; full detail appears as you zoom in.
//
// Hover and the tooltip use a point-in-zone lookup through a grid index, not
// thousands of interactive shapes.
import type { Feature, FeatureCollection, Position } from "geojson";
import { mercatorUnit } from "./mercator";

export type Zone = {
  id: number;
  band: string;
  /** Rings in Web Mercator units ([0, 1] square), x then y. The first ring is the outline, the rest holes. */
  rings: Float64Array[];
  /** Each ring's box, x0 y0 x1 y1 (Mercator units). */
  boxes: Float64Array[];
  /** The same rings as [lat, lon], for the hover outline. */
  latlngs: [number, number][][];
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};

export type ZoneIndex = { zones: Zone[]; cells: Map<number, number[]> };

/** Grid cells for the lookup are zoom-14 tiles (about 2.4 km across at Oxford's latitude). */
const CELL_SCALE = 2 ** 14;
const cellKey = (cx: number, cy: number) => cx * CELL_SCALE + cy;

function polygonsOf(f: Feature): Position[][][] {
  const g = f.geometry;
  if (!g) return [];
  if (g.type === "Polygon") return [g.coordinates];
  if (g.type === "MultiPolygon") return g.coordinates;
  return [];
}

/** One Zone per polygon part, in Web Mercator units, with a grid index over their boxes. */
export function buildZoneIndex(fc: FeatureCollection): ZoneIndex {
  const zones: Zone[] = [];
  const cells = new Map<number, number[]>();
  for (const f of fc.features ?? []) {
    const band = String(f?.properties?.band ?? "");
    for (const poly of polygonsOf(f)) {
      if (!poly?.length) continue;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; // prettier-ignore
      const rings: Float64Array[] = [];
      const boxes: Float64Array[] = [];
      const latlngs: [number, number][][] = [];
      for (const ring of poly) {
        const u = new Float64Array(ring.length * 2);
        const ll: [number, number][] = new Array(ring.length);
        const b = new Float64Array([Infinity, Infinity, -Infinity, -Infinity]);
        for (let i = 0; i < ring.length; i++) {
          const [lon, lat] = ring[i];
          const [x, y] = mercatorUnit(lat, lon);
          u[2 * i] = x;
          u[2 * i + 1] = y;
          ll[i] = [lat, lon];
          if (x < b[0]) b[0] = x;
          if (y < b[1]) b[1] = y;
          if (x > b[2]) b[2] = x;
          if (y > b[3]) b[3] = y;
        }
        x0 = Math.min(x0, b[0]);
        y0 = Math.min(y0, b[1]);
        x1 = Math.max(x1, b[2]);
        y1 = Math.max(y1, b[3]);
        rings.push(u);
        boxes.push(b);
        latlngs.push(ll);
      }
      const id = zones.length;
      zones.push({ id, band, rings, boxes, latlngs, x0, y0, x1, y1 });
      for (let cx = Math.floor(x0 * CELL_SCALE); cx <= Math.floor(x1 * CELL_SCALE); cx++)
        for (let cy = Math.floor(y0 * CELL_SCALE); cy <= Math.floor(y1 * CELL_SCALE); cy++) {
          const k = cellKey(cx, cy);
          const list = cells.get(k);
          if (list) list.push(id);
          else cells.set(k, [id]);
        }
    }
  }
  return { zones, cells };
}

/** Zones whose box meets the box [x0, x1] × [y0, y1] (Mercator units), each once. */
export function zonesInBox(index: ZoneIndex, x0: number, y0: number, x1: number, y1: number): Zone[] {
  const seen = new Set<number>();
  const out: Zone[] = [];
  for (let cx = Math.floor(x0 * CELL_SCALE); cx <= Math.floor(x1 * CELL_SCALE); cx++)
    for (let cy = Math.floor(y0 * CELL_SCALE); cy <= Math.floor(y1 * CELL_SCALE); cy++)
      for (const id of index.cells.get(cellKey(cx, cy)) ?? []) {
        if (seen.has(id)) continue;
        seen.add(id);
        const z = index.zones[id];
        if (z.x1 >= x0 && z.x0 <= x1 && z.y1 >= y0 && z.y0 <= y1) out.push(z);
      }
  return out;
}

function inRings(rings: Float64Array[], x: number, y: number): boolean {
  let inside = false; // even-odd over the outline and its holes
  for (const r of rings) {
    const n = r.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = r[2 * i], yi = r[2 * i + 1], xj = r[2 * j], yj = r[2 * j + 1]; // prettier-ignore
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** The zone under a point (Mercator units), or null. */
export function zoneAt(index: ZoneIndex, x: number, y: number): Zone | null {
  for (const id of index.cells.get(cellKey(Math.floor(x * CELL_SCALE), Math.floor(y * CELL_SCALE))) ?? []) {
    const z = index.zones[id];
    if (x < z.x0 || x > z.x1 || y < z.y0 || y > z.y1) continue;
    if (inRings(z.rings, x, y)) return z;
  }
  return null;
}

/** Zones smaller than this (px, both sides) at a tile's zoom are left out of it. */
export const MIN_ZONE_PX = 1;
/** A vertex closer than this (px) to the last one drawn is dropped. */
export const MIN_STEP_PX = 0.5;
/** Zoomed out (below this zoom, the catchment view) the detail is coarser still: 2 px zones, 1 px steps. */
export const COARSE_BELOW_ZOOM = 13;
/** Rings are clipped this far (px) outside the tile, past the reach of the outline stroke. */
const CLIP_PAD_PX = 4;

/**
 * Clip a ring (flat x, y pairs, px) to the square [lo, hi]² (Sutherland–Hodgman).
 * A big floodplain zone then costs a tile only the part of it that is on the tile.
 * The cut edges run along the square, outside the tile, so they never show.
 */
export function clipRing(pts: number[], lo: number, hi: number): number[] {
  let out = pts;
  for (let edge = 0; edge < 4; edge++) {
    const src = out;
    out = [];
    const n = src.length / 2;
    if (!n) break;
    const axis = edge & 1; // 0: x, 1: y
    const limit = edge < 2 ? lo : hi;
    const inside = (v: number) => (edge < 2 ? v >= limit : v <= limit);
    let px = src[2 * n - 2], py = src[2 * n - 1]; // prettier-ignore
    let pin = inside(axis ? py : px);
    for (let i = 0; i < n; i++) {
      const x = src[2 * i], y = src[2 * i + 1]; // prettier-ignore
      const cin = inside(axis ? y : x);
      if (cin !== pin) {
        const t = ((axis ? limit - py : limit - px) / (axis ? y - py : x - px));
        out.push(axis ? px + t * (x - px) : limit, axis ? limit : py + t * (y - py));
      }
      if (cin) out.push(x, y);
      px = x;
      py = y;
      pin = cin;
    }
  }
  return out;
}

type Ctx = Pick<CanvasRenderingContext2D, "beginPath" | "moveTo" | "lineTo" | "closePath" | "fill" | "stroke"> & {
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  lineJoin: unknown;
};

export type BandPaint = { fill: string; stroke: string };

/**
 * Draw one tile: every zone that touches it, one path per band, at this zoom's
 * level of detail. `tx`, `ty`, `z` are the tile's coordinates; `size` its size in px.
 * Returns the number of vertices drawn (for tests and benchmarks).
 */
export function drawZoneTile(ctx: Ctx, index: ZoneIndex, tx: number, ty: number, z: number, size: number, paint: (band: string) => BandPaint | null): number {
  const scale = size * 2 ** z; // Mercator units -> px at this zoom
  const ox = tx * size;
  const oy = ty * size;
  const coarse = z < COARSE_BELOW_ZOOM;
  const minZone = coarse ? 2 * MIN_ZONE_PX : MIN_ZONE_PX;
  const minStep = coarse ? 2 * MIN_STEP_PX : MIN_STEP_PX;
  const pad = CLIP_PAD_PX / scale; // strokes reach a little past a zone's edge
  const found = zonesInBox(index, ox / scale - pad, oy / scale - pad, (ox + size) / scale + pad, (oy + size) / scale + pad);
  const byBand = new Map<string, Zone[]>();
  for (const zone of found) {
    if ((zone.x1 - zone.x0) * scale < minZone && (zone.y1 - zone.y0) * scale < minZone) continue;
    const list = byBand.get(zone.band);
    if (list) list.push(zone);
    else byBand.set(zone.band, [zone]);
  }
  let drawn = 0;
  ctx.lineJoin = "round";
  ctx.lineWidth = 0.6;
  for (const [band, list] of byBand) {
    const p = paint(band);
    if (!p) continue;
    ctx.beginPath();
    const lo = -CLIP_PAD_PX;
    const hi = size + CLIP_PAD_PX;
    for (const zone of list)
      for (let k = 0; k < zone.rings.length; k++) {
        const r = zone.rings[k];
        const b = zone.boxes[k];
        const bx0 = b[0] * scale - ox, by0 = b[1] * scale - oy, bx1 = b[2] * scale - ox, by1 = b[3] * scale - oy; // prettier-ignore
        if (bx1 < lo || by1 < lo || bx0 > hi || by0 > hi) continue; // this ring (or hole) is off the tile
        if (bx1 - bx0 < minZone && by1 - by0 < minZone) continue; // a hole or part too small to see
        const n = r.length / 2;
        if (n < 3) continue;
        // Level of detail: drop vertices closer than MIN_STEP_PX to the last one kept.
        const pts: number[] = [];
        let lx = Infinity, ly = Infinity; // prettier-ignore
        for (let i = 0; i < n; i++) {
          const x = r[2 * i] * scale - ox;
          const y = r[2 * i + 1] * scale - oy;
          if (i < n - 1 && Math.abs(x - lx) < minStep && Math.abs(y - ly) < minStep) continue; // the last (closing) vertex always stays
          pts.push(x, y);
          lx = x;
          ly = y;
        }
        const inside = bx0 >= lo && by0 >= lo && bx1 <= hi && by1 <= hi;
        const ring = inside ? pts : clipRing(pts, lo, hi);
        if (ring.length < 6) continue;
        ctx.moveTo(ring[0], ring[1]);
        for (let i = 2; i < ring.length; i += 2) ctx.lineTo(ring[i], ring[i + 1]);
        // No closePath: the ring ends on its first vertex (GeoJSON rings are closed) and fill closes it.
        if (ring[ring.length - 2] !== ring[0] || ring[ring.length - 1] !== ring[1]) ctx.lineTo(ring[0], ring[1]);
        drawn += ring.length / 2;
      }
    ctx.fillStyle = p.fill;
    ctx.fill("evenodd");
    ctx.strokeStyle = p.stroke;
    ctx.stroke();
  }
  return drawn;
}
