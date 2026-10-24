// Map v3 (#152): the rules behind FlowMapGL, kept pure (no MapLibre or deck.gl
// import), so they are tested in node.
//
// - Which map to draw (?map=gl | ?map=leaflet).
// - Water streaming downstream along the real river course: per-vertex
//   timestamps for deck.gl's TripsLayer, from each link's travel time.
// - Which river paths may be drawn: only ones that follow the river (no
//   straight lines, ever). Until the routed paths file exists, paths are
//   routed along the river lines we already have, or hidden.
// - Whether the offline PMTiles basemap is there (else a plain fallback).
// - Each river line's gauge: its own river's nearest gauge (levels are only
//   ever compared with that gauge's own usual high and flood level).
import type { Feature, FeatureCollection, LineString, Position } from "geojson";
import type { Station } from "../contracts";
import { LOW_CONFIDENCE_N } from "../components/shared/RiverStrip";
import { SECONDS_PER_HOUR, type ChainLink } from "./flow";

// ---------------------------------------------------------------- which map

export type MapFlavour = "gl" | "leaflet";

/** The map drawn when the URL doesn't say. Flip to "gl" once map v3 is signed off (#152). */
export const DEFAULT_MAP: MapFlavour = "leaflet";

/** `?map=gl` or `?map=leaflet` (anything else: the default). */
export function mapFlavour(search: string): MapFlavour {
  const v = new URLSearchParams(search).get("map");
  return v === "gl" || v === "leaflet" ? v : DEFAULT_MAP;
}

// ---------------------------------------------------------------- files

export const RIVERS_FILE = "geo/catchment-rivers.geojson";
export const PATHS_FILE = "geo/river-paths.geojson";
/** Under web/public/ (not data/): fetched by `make fetch-data`, gitignored. */
export const TILES_PATH = "tiles/oxon.pmtiles";
export const GLYPHS_PATH = "tiles/fonts/{fontstack}/{range}.pbf";
/** One glyph file that must exist for labels to be drawn. */
export const GLYPH_PROBE = "tiles/fonts/Noto%20Sans%20Regular/0-255.pbf";
/** The Protomaps icon sprite matching our grey flavour (town dots), without its .json / .png. */
export const SPRITE_PATH = "tiles/sprites/v4/grayscale";

// ---------------------------------------------------------------- geometry

/** Ground distance in metres between two [lon, lat] points (equirectangular; fine at this scale). */
export function metresBetween(a: Position, b: Position): number {
  const k = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  const dx = (b[0] - a[0]) * k;
  const dy = b[1] - a[1];
  return ((Math.hypot(dx, dy) * Math.PI) / 180) * 6_371_000;
}

export function pathLengthM(path: Position[]): number {
  let d = 0;
  for (let i = 1; i < path.length; i++) d += metresBetween(path[i - 1], path[i]);
  return d;
}

/** A line's vertices: a LineString's, or a MultiLineString's parts end to end. */
function coordsOf(f: Feature): Position[] {
  const g = f.geometry;
  if (g?.type === "LineString") return g.coordinates;
  if (g?.type === "MultiLineString") return g.coordinates.flat();
  return [];
}

export type LngLatBounds = [[number, number], [number, number]];

/** [[west, south], [east, north]] of every line or polygon vertex, or null. */
export function geoBounds(fc: FeatureCollection | null | undefined): LngLatBounds | null {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  const visit = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number" && typeof c[1] === "number") {
      w = Math.min(w, c[0]);
      e = Math.max(e, c[0]);
      s = Math.min(s, c[1]);
      n = Math.max(n, c[1]);
      return;
    }
    for (const x of c) visit(x);
  };
  for (const f of fc?.features ?? []) visit((f.geometry as { coordinates?: unknown } | null)?.coordinates);
  return [w, s, e, n].every(Number.isFinite) && e > w && n > s ? [[w, s], [e, n]] : null;
}

/** Bounds grown by `frac` of their size on every side. */
export function padBounds(b: LngLatBounds, frac: number): LngLatBounds {
  const dx = (b[1][0] - b[0][0]) * frac;
  const dy = (b[1][1] - b[0][1]) * frac;
  return [
    [b[0][0] - dx, b[0][1] - dy],
    [b[1][0] + dx, b[1][1] + dy],
  ];
}

/** Leaflet-style [[lat, lon], [lat, lon]] → MapLibre [[lon, lat], [lon, lat]]. */
export const toLngLat = (b: [[number, number], [number, number]]): LngLatBounds => [
  [b[0][1], b[0][0]],
  [b[1][1], b[1][0]],
];

// ---------------------------------------------------------------- trips (water streaming downstream)

/** A new pulse of water leaves each upstream gauge every this many seconds. */
export const PULSE_PERIOD_S = 3;
/** Length of each pulse's fading tail, in seconds of animation. */
export const TRAIL_S = 1.4;

/**
 * How long (animation seconds) a pulse takes from the upstream gauge to the
 * downstream one: the real travel time at 0.25 s per hour, kept between 1.5 s
 * and 16 s so short links are still visible and long ones still move.
 */
export const tripSeconds = (travelH: number) => Math.min(16, Math.max(1.5, travelH * SECONDS_PER_HOUR));

/** Per-vertex timestamps (s): 0 at the upstream end, `seconds` downstream, spaced by distance along the river. */
export function pathTimestamps(path: Position[], seconds: number): number[] {
  const cum = [0];
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + metresBetween(path[i - 1], path[i]));
  const total = cum[cum.length - 1];
  return cum.map((d, i) => (total > 0 ? (d / total) * seconds : path.length > 1 ? (i / (path.length - 1)) * seconds : 0));
}

/** How many copies of each pulse, PULSE_PERIOD_S apart, keep a path of up to `maxSeconds` full of water. */
export const copiesFor = (maxSeconds: number, period = PULSE_PERIOD_S, trail = TRAIL_S) =>
  Math.ceil((Math.max(0, maxSeconds) + trail) / period) + 1;

/** Timestamps of copy k of a pulse: the same pulse, k periods later. */
export const copyTimestamps = (timestamps: number[], k: number, period = PULSE_PERIOD_S) => timestamps.map((x) => x + k * period);

/**
 * TripsLayer's currentTime at wall-clock `nowS`. With `copies` copies a period
 * apart, copy k's head sits (nowS mod period) + (copies − 1 − k) periods along
 * its path, so heads are every period along the path at all times and the
 * loop is seamless when nowS wraps.
 */
export const tripClock = (nowS: number, copies: number, period = PULSE_PERIOD_S) =>
  (((nowS % period) + period) % period) + (copies - 1) * period;

// ---------------------------------------------------------------- river paths

/** 0–1: how sure we are of a link's travel time (opacity and width). */
export function confidenceOf(c: unknown, n: number): number {
  if (typeof c === "number" && Number.isFinite(c)) return Math.min(1, Math.max(0, c));
  if (typeof c === "string") {
    const m = ({ high: 1, medium: 0.7, low: 0.45 } as Record<string, number>)[c.toLowerCase()];
    if (m != null) return m;
  }
  return n >= LOW_CONFIDENCE_N ? 1 : 0.45;
}

export const linkKey = (l: { up: string; down: string }) => `${l.up}>${l.down}`;

/** A link drawn along its river: the chain link plus its course and timestamps. */
export type FlowPath = ChainLink & { path: Position[]; timestamps: number[]; confidence: number; tripS: number };

/** A course may be drawn only if it bends with the river: three or more vertices. Two points is a straight line. */
export const followsRiver = (path: Position[]) => path.length >= 3;

/**
 * Courses by link key from river-paths.geojson (properties up, down, travelH,
 * n, confidence; coordinates ordered downstream). Features with
 * `routed: false` or fewer than three vertices are dropped: no straight lines.
 */
export function coursesFrom(fc: FeatureCollection | null | undefined): Map<string, { path: Position[]; travelH?: number; n?: number; confidence?: unknown }> {
  const out = new Map<string, { path: Position[]; travelH?: number; n?: number; confidence?: unknown }>();
  for (const f of fc?.features ?? []) {
    const p = (f.properties ?? {}) as Record<string, unknown>;
    if (typeof p.up !== "string" || typeof p.down !== "string" || p.routed === false) continue;
    const path = coordsOf(f);
    if (!followsRiver(path)) continue;
    out.set(linkKey({ up: p.up, down: p.down }), {
      path,
      travelH: typeof p.travelH === "number" && Number.isFinite(p.travelH) ? p.travelH : undefined,
      n: typeof p.n === "number" ? p.n : undefined,
      confidence: p.confidence,
    });
  }
  return out;
}

/** The link drawn along its course (travel time and count from the course file when it has them). */
export function flowPathFor(link: ChainLink, course: { path: Position[]; travelH?: number; n?: number; confidence?: unknown } | undefined): FlowPath | null {
  if (!course || !followsRiver(course.path)) return null;
  const tHalfH = course.travelH ?? link.tHalfH;
  const n = course.n ?? link.n;
  const tripS = tripSeconds(tHalfH);
  return {
    ...link,
    tHalfH,
    n,
    lowConfidence: n < LOW_CONFIDENCE_N,
    path: course.path,
    timestamps: pathTimestamps(course.path, tripS),
    confidence: confidenceOf(course.confidence, n),
    tripS,
  };
}

// ---------------------------------------------------------------- temporary routing along river lines

/** A river network: vertices, and for each its neighbours and the distances to them. */
export type Network = { nodes: Position[]; adj: number[][]; w: number[][] };

const nodeKey = (p: Position) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`;

/** Line ends this close (m) to another line's vertex are joined to it (simplified lines rarely share exact vertices). */
export const JOIN_M = 35;

/**
 * Join every line's vertices into a graph: lines meeting at a shared vertex
 * connect, and a line's end within JOIN_M of another line's vertex is joined to it.
 */
export function buildNetwork(lines: Feature[]): Network {
  const index = new Map<string, number>();
  const net: Network = { nodes: [], adj: [], w: [] };
  const lineOf: number[] = [];
  const ends: number[] = [];
  const link = (a: number, b: number, d: number) => {
    net.adj[a].push(b);
    net.w[a].push(d);
    net.adj[b].push(a);
    net.w[b].push(d);
  };
  const id = (p: Position) => {
    const k = nodeKey(p);
    let i = index.get(k);
    if (i == null) {
      i = net.nodes.length;
      index.set(k, i);
      net.nodes.push([p[0], p[1]]);
      net.adj.push([]);
      net.w.push([]);
      lineOf.push(lineNo);
    }
    return i;
  };
  let lineNo = 0;
  for (const f of lines) {
    const g = f.geometry;
    const parts = g?.type === "LineString" ? [g.coordinates] : g?.type === "MultiLineString" ? g.coordinates : [];
    for (const part of parts) {
      lineNo++;
      if (part.length === 0) continue;
      for (let j = 1; j < part.length; j++) {
        const a = id(part[j - 1]);
        const b = id(part[j]);
        if (a !== b) link(a, b, metresBetween(net.nodes[a], net.nodes[b]));
      }
      ends.push(id(part[0]), id(part[part.length - 1]));
    }
  }
  // Join loose ends: a grid of ~JOIN_M cells, so each end only checks its neighbourhood.
  const cell = JOIN_M / 111_195; // degrees of latitude (longitude cells are a little narrower: fine)
  const grid = new Map<string, number[]>();
  const cellOf = (p: Position) => [Math.floor(p[0] / cell), Math.floor(p[1] / cell)];
  net.nodes.forEach((p, i) => {
    const [cx, cy] = cellOf(p);
    const k = `${cx},${cy}`;
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
  });
  for (const e of new Set(ends)) {
    const [cx, cy] = cellOf(net.nodes[e]);
    let best = -1;
    let bd = JOIN_M;
    for (let dx = -2; dx <= 2; dx++)
      for (let dy = -2; dy <= 2; dy++)
        for (const j of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (j === e || lineOf[j] === lineOf[e] || net.adj[e].includes(j)) continue;
          const d = metresBetween(net.nodes[e], net.nodes[j]);
          if (d < bd) {
            bd = d;
            best = j;
          }
        }
    if (best >= 0) link(e, best, bd);
  }
  return net;
}

function nearestNode(net: Network, p: Position): { i: number; d: number } {
  let best = -1;
  let bd = Infinity;
  for (let i = 0; i < net.nodes.length; i++) {
    const d = metresBetween(net.nodes[i], p);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return { i: best, d: bd };
}

/**
 * The course along the river network from one gauge to another ([lon, lat]),
 * or null when either gauge is more than `maxSnapM` from a river line, the
 * lines don't connect, or the route is implausibly long (over 4× the straight
 * distance). Shortest path (Dijkstra with a small binary heap).
 */
export function routeAlong(net: Network, from: Position, to: Position, maxSnapM = 600): Position[] | null {
  if (net.nodes.length === 0) return null;
  const s = nearestNode(net, from);
  const e = nearestNode(net, to);
  if (s.d > maxSnapM || e.d > maxSnapM || s.i === e.i) return null;
  const dist = new Float64Array(net.nodes.length).fill(Infinity);
  const prev = new Int32Array(net.nodes.length).fill(-1);
  const heap: [number, number][] = [];
  const push = (d: number, i: number) => {
    heap.push([d, i]);
    let c = heap.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (heap[p][0] <= heap[c][0]) break;
      [heap[p], heap[c]] = [heap[c], heap[p]];
      c = p;
    }
  };
  const pop = (): [number, number] => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let c = 0;
      for (;;) {
        const l = 2 * c + 1;
        const r = l + 1;
        let m = c;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === c) break;
        [heap[m], heap[c]] = [heap[c], heap[m]];
        c = m;
      }
    }
    return top;
  };
  dist[s.i] = 0;
  push(0, s.i);
  while (heap.length) {
    const [d, i] = pop();
    if (d > dist[i]) continue;
    if (i === e.i) break;
    const adj = net.adj[i];
    for (let k = 0; k < adj.length; k++) {
      const j = adj[k];
      const nd = d + net.w[i][k];
      if (nd < dist[j]) {
        dist[j] = nd;
        prev[j] = i;
        push(nd, j);
      }
    }
  }
  if (!Number.isFinite(dist[e.i])) return null;
  const path: Position[] = [];
  for (let i = e.i; i !== -1; i = prev[i]) path.push(net.nodes[i]);
  path.reverse();
  if (!followsRiver(path)) return null;
  if (dist[e.i] > 4 * metresBetween(from, to)) return null;
  return path;
}

/** Temporary courses (until river-paths.geojson exists): each link routed along the river lines, where it can be. */
export function routedCourses(
  net: Network,
  links: Pick<ChainLink, "up" | "down">[],
  stations: Pick<Station, "key" | "lat" | "lon">[],
): Map<string, { path: Position[] }> {
  const byKey = new Map(stations.map((s) => [s.key, s]));
  const out = new Map<string, { path: Position[] }>();
  for (const l of links) {
    const k = linkKey(l);
    if (out.has(k)) continue;
    const up = byKey.get(l.up);
    const down = byKey.get(l.down);
    if (!up || !down) continue;
    const path = routeAlong(net, [up.lon, up.lat], [down.lon, down.lat]);
    if (path) out.set(k, { path });
  }
  return out;
}

// ---------------------------------------------------------------- spots left off the map (markers.withData), named in Show the working

export type HiddenSpot = { key: string; name: string; why: string };

// ---------------------------------------------------------------- river lines and their gauges

/** A river line's gauge must be on the same river and within this distance... */
export const SAME_RIVER_M = 15_000;
/** ...or, for Oxford's side streams, the nearest gauge this close. */
export const NEAR_GAUGE_M = 2_500;

const norm = (s: unknown) => (typeof s === "string" ? s.trim().toLowerCase() : "");

/** Line width (px at zoom 12) by kind or name: the Thames widest, side streams thinnest. */
export function riverWidth(p: Record<string, unknown> | null | undefined): number {
  const kind = norm(p?.kind);
  const name = norm(p?.name);
  if (name.includes("thames") || name.includes("isis")) return 3.2;
  if (kind === "canal") return 1.4;
  if (kind === "stream" || kind === "ditch" || kind === "drain" || name.includes("stream") || name.includes("brook")) return 1.6;
  return kind === "river" ? 2.6 : 2.2;
}

/** "River Thames" and "Thames" are the same river (stations.json says "Thames"). */
export const riverName = (s: unknown) => norm(s).replace(/^river\s+/, "");

/** Long rivers are coloured piece by piece: no piece longer than this (m). */
export const PIECE_M = 1_500;

/** A line split into pieces of at most `maxM` metres (pieces share their end vertices, so the line stays whole). */
export function splitLine(path: Position[], maxM = PIECE_M): Position[][] {
  if (path.length < 2) return [];
  const out: Position[][] = [];
  let cur: Position[] = [path[0]];
  let len = 0;
  for (let i = 1; i < path.length; i++) {
    cur.push(path[i]);
    len += metresBetween(path[i - 1], path[i]);
    if (len >= maxM && i < path.length - 1) {
      out.push(cur);
      cur = [path[i]];
      len = 0;
    }
  }
  if (cur.length >= 2) out.push(cur);
  return out;
}

/**
 * The river lines in pieces (each part of a MultiLineString, split every
 * PIECE_M), each with `gauge`: the key of its own river's nearest gauge with
 * data in this view (within SAME_RIVER_M), else of the nearest gauge within
 * NEAR_GAUGE_M, else null; and `w`, its width. So the Thames at Shifford takes
 * Shifford's level and the Thames at Osney takes Osney's.
 */
export function assignGauges(
  lines: Feature[],
  gauges: Pick<Station, "key" | "lat" | "lon" | "river">[],
): FeatureCollection<LineString> {
  const features: Feature<LineString>[] = [];
  for (const f of lines) {
    const g = f.geometry;
    const parts = g?.type === "LineString" ? [g.coordinates] : g?.type === "MultiLineString" ? g.coordinates : [];
    const props = (f.properties ?? {}) as Record<string, unknown>;
    const name = riverName(props.name);
    const w = riverWidth(props);
    for (const piece of parts.flatMap((p) => splitLine(p))) {
      const m = piece[Math.floor(piece.length / 2)];
      let gauge: string | null = null;
      let best = Infinity;
      for (const s of gauges) {
        const d = metresBetween(m, [s.lon, s.lat]);
        if (name !== "" && riverName(s.river) === name && d < SAME_RIVER_M && d < best) {
          best = d;
          gauge = s.key;
        }
      }
      if (gauge == null) {
        for (const s of gauges) {
          const d = metresBetween(m, [s.lon, s.lat]);
          if (d < NEAR_GAUGE_M && d < best) {
            best = d;
            gauge = s.key;
          }
        }
      }
      features.push({ type: "Feature", geometry: { type: "LineString", coordinates: piece }, properties: { ...props, gauge, w } });
    }
  }
  return { type: "FeatureCollection", features };
}

// ---------------------------------------------------------------- context paths (no measured travel time)

/**
 * River paths with no measured travel time (travelH null: found on the river
 * network, not timed): drawn as faint, still context, one per upstream gauge
 * (its shortest), never with an hour count.
 */
export function contextCourses(
  courses: Map<string, { path: Position[]; travelH?: number }>,
  measured: Set<string>,
): { up: string; down: string; path: Position[] }[] {
  const best = new Map<string, { up: string; down: string; path: Position[]; len: number }>();
  for (const [k, c] of courses) {
    if (c.travelH != null || measured.has(k)) continue;
    const [up, down] = k.split(">");
    const len = pathLengthM(c.path);
    const cur = best.get(up);
    if (!cur || len < cur.len) best.set(up, { up, down, path: c.path, len });
  }
  return [...best.values()].map(({ up, down, path }) => ({ up, down, path }));
}

/** Hover words for a context path: where the water goes, and honestly no hours. */
export const contextWords = (upName: string, downName: string) =>
  `Water passing ${upName} flows on towards ${downName} (travel time not measured yet)`;

// ---------------------------------------------------------------- the offline basemap

/** The first bytes of every PMTiles v3 archive. */
const MAGIC = [0x50, 0x4d, 0x54, 0x69, 0x6c, 0x65, 0x73]; // "PMTiles"

export function isPmtiles(bytes: Uint8Array): boolean {
  return bytes.length >= MAGIC.length && MAGIC.every((b, i) => bytes[i] === b);
}

export type BasemapProbe = { tiles: boolean; glyphs: boolean; sprite: boolean };

type FetchLike = (url: string, init?: RequestInit) => Promise<Pick<Response, "ok" | "status" | "headers" | "arrayBuffer">>;

const isHtml = (r: Pick<Response, "headers">) => (r.headers.get("content-type") ?? "").includes("html");

/**
 * Is the offline basemap there? `tiles`: /tiles/oxon.pmtiles answers a byte
 * range (206) that starts with the PMTiles magic; a dev server answering
 * index.html, a 404 or a server without byte ranges all mean no. `glyphs`: one
 * label font file exists. Never throws; nothing here touches the internet.
 */
export async function probeBasemap(base: string, fetchFn: FetchLike = fetch, timeoutMs = 4000): Promise<BasemapProbe> {
  const get = async (url: string, init?: RequestInit) => {
    const ctrl = typeof AbortController === "undefined" ? null : new AbortController();
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      return await fetchFn(url, { ...init, signal: ctrl?.signal, cache: "no-cache" });
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  let tiles = false;
  try {
    const r = await get(`${base}${TILES_PATH}`, { headers: { Range: "bytes=0-15" } });
    if (r.status === 206 && !isHtml(r)) tiles = isPmtiles(new Uint8Array(await r.arrayBuffer()));
  } catch {
    tiles = false;
  }
  const exists = async (path: string) => {
    try {
      const r = await get(`${base}${path}`);
      return r.ok && !isHtml(r);
    } catch {
      return false;
    }
  };
  if (!tiles) return { tiles, glyphs: false, sprite: false };
  const [glyphs, sprite] = await Promise.all([exists(GLYPH_PROBE), exists(`${SPRITE_PATH}.json`)]);
  return { tiles, glyphs, sprite };
}
