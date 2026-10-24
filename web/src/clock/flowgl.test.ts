// Map v3 (#152): the pure rules behind FlowMapGL.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Feature, FeatureCollection, Position } from "geojson";
import { describe, expect, it } from "vitest";
import type { Forecast, Spot } from "../contracts";
import { linkOf } from "./flow";
import {
  DEFAULT_MAP,
  PULSE_PERIOD_S,
  TRAIL_S,
  assignGauges,
  buildNetwork,
  contextCourses,
  contextWords,
  splitLine,
  confidenceOf,
  copiesFor,
  copyTimestamps,
  coursesFrom,
  flowPathFor,
  geoBounds,
  isPmtiles,
  mapFlavour,
  metresBetween,
  pathTimestamps,
  probeBasemap,
  routeAlong,
  routedCourses,
  spotVisibility,
  tripClock,
  tripSeconds,
} from "./flowgl";
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import type { StyleSpecification } from "maplibre-gl";
import type { Station, TravelPair } from "../contracts";
import { chainLinks } from "./flow";
import { RIVER_LAYOUT, baseStyle, fallbackLayers, riverPaint } from "./glstyle";

const DATA = resolve(__dirname, "../../public/data") + "/";
const line = (coords: Position[], properties: Record<string, unknown> = {}): Feature => ({
  type: "Feature",
  properties,
  geometry: { type: "LineString", coordinates: coords },
});
const fc = (features: Feature[]): FeatureCollection => ({ type: "FeatureCollection", features });

describe("which map", () => {
  it("reads ?map=gl / ?map=leaflet and otherwise uses the default (Leaflet until v3 is signed off)", () => {
    expect(mapFlavour("?map=gl")).toBe("gl");
    expect(mapFlavour("?x=1&map=leaflet")).toBe("leaflet");
    expect(mapFlavour("")).toBe(DEFAULT_MAP);
    expect(mapFlavour("?map=other")).toBe(DEFAULT_MAP);
    expect(DEFAULT_MAP).toBe("leaflet");
  });
});

describe("trips: water streaming downstream at the travel time", () => {
  const bend: Position[] = [
    [-1.3, 51.8],
    [-1.29, 51.8],
    [-1.29, 51.79],
    [-1.27, 51.79],
  ];

  it("animation seconds follow the travel time (0.25 s per hour, 1.5–16 s)", () => {
    expect(tripSeconds(31)).toBeCloseTo(7.75);
    expect(tripSeconds(0.6)).toBe(1.5);
    expect(tripSeconds(200)).toBe(16);
  });

  it("timestamps start at 0 upstream, end at the trip time downstream, and are spaced by distance", () => {
    const ts = pathTimestamps(bend, 8);
    expect(ts[0]).toBe(0);
    expect(ts[ts.length - 1]).toBeCloseTo(8);
    for (let i = 1; i < ts.length; i++) expect(ts[i]).toBeGreaterThan(ts[i - 1]);
    // The last leg is about twice as long as the first, so it takes about twice as long.
    const legs = [ts[1] - ts[0], ts[3] - ts[2]];
    expect(legs[1] / legs[0]).toBeCloseTo(metresBetween(bend[2], bend[3]) / metresBetween(bend[0], bend[1]), 5);
  });

  it("a slower link (longer travel time) moves its water more slowly along the same course", () => {
    const fast = pathTimestamps(bend, tripSeconds(9.5));
    const slow = pathTimestamps(bend, tripSeconds(31));
    expect(slow[slow.length - 1]).toBeGreaterThan(fast[fast.length - 1]);
  });

  it("copies a period apart keep pulses all along the path at every moment, and the loop is seamless", () => {
    const D = 16;
    const copies = copiesFor(D);
    expect((copies - 1) * PULSE_PERIOD_S).toBeGreaterThanOrEqual(D + TRAIL_S);
    const heads = (nowS: number) =>
      Array.from({ length: copies }, (_, k) => tripClock(nowS, copies) - k * PULSE_PERIOD_S).filter((h) => h >= 0 && h <= D).sort((a, b) => a - b);
    for (const now of [0, 0.7, 2.9, 3, 100.25]) {
      const h = heads(now);
      expect(h[0]).toBeLessThan(PULSE_PERIOD_S); // a pulse near the upstream end
      expect(h[h.length - 1]).toBeGreaterThan(D - PULSE_PERIOD_S); // and one near the downstream end
      for (let i = 1; i < h.length; i++) expect(h[i] - h[i - 1]).toBeCloseTo(PULSE_PERIOD_S);
    }
    // Just before and after a wrap the heads are (almost) the same set.
    const a = heads(PULSE_PERIOD_S - 1e-6);
    const b = heads(PULSE_PERIOD_S);
    expect(b.slice(1).map((x) => x.toFixed(3))).toEqual(a.map((x) => x.toFixed(3)));
    expect(copyTimestamps([0, 1], 2)).toEqual([2 * PULSE_PERIOD_S, 1 + 2 * PULSE_PERIOD_S]);
  });

  it("confidence: numbers clamp to 0–1, words map, else from the count of past rises", () => {
    expect(confidenceOf(0.8, 0)).toBe(0.8);
    expect(confidenceOf(3, 0)).toBe(1);
    expect(confidenceOf("low", 10)).toBeLessThan(confidenceOf("high", 0));
    expect(confidenceOf(undefined, 7)).toBe(1);
    expect(confidenceOf(undefined, 2)).toBeLessThan(1);
  });
});

describe("no straight lines", () => {
  const pair = { up: "islip", down: "kingsmill", n: 7, tHalf: { p10: 20, median: 31, p90: 40 } };
  const bendy: Position[] = [
    [-1.24, 51.82],
    [-1.25, 51.8],
    [-1.24, 51.78],
    [-1.239, 51.756],
  ];

  it("drops courses with routed: false or only two points, keeps ones that bend with the river", () => {
    const c = coursesFrom(
      fc([
        line(bendy, { up: "islip", down: "kingsmill", travelH: 30, n: 7, confidence: "high" }),
        line(
          [
            [-1.36, 51.77],
            [-1.28, 51.75],
          ],
          { up: "eynsham", down: "newbotley" },
        ),
        line(bendy, { up: "enslow", down: "kingsmill", routed: false }),
      ]),
    );
    expect([...c.keys()]).toEqual(["islip>kingsmill"]);
    const fp = flowPathFor(linkOf(pair), c.get("islip>kingsmill"));
    expect(fp?.tHalfH).toBe(30); // the course file's travel time wins
    expect(fp?.path.length).toBeGreaterThanOrEqual(3);
    expect(flowPathFor(linkOf(pair), undefined)).toBeNull();
    expect(flowPathFor(linkOf(pair), { path: [bendy[0], bendy[3]] })).toBeNull();
  });

  it("routes a temporary course along connected river lines, and gives up (null) rather than draw a straight one", () => {
    const net = buildNetwork([line(bendy.slice(0, 3)), line(bendy.slice(2))]);
    const path = routeAlong(net, [-1.2402, 51.8201], [-1.239, 51.7561]);
    expect(path).toEqual(bendy);
    // A gauge far from any river line: no course.
    expect(routeAlong(net, [-1.5, 51.9], [-1.239, 51.756])).toBeNull();
    // Lines that don't connect: no course.
    const broken = buildNetwork([line(bendy.slice(0, 2)), line(bendy.slice(2))]);
    expect(routeAlong(broken, bendy[0], bendy[3])).toBeNull();
    const stations = [
      { key: "islip", lat: 51.82, lon: -1.24 },
      { key: "kingsmill", lat: 51.756, lon: -1.239 },
    ];
    expect([...routedCourses(net, [pair], stations).keys()]).toEqual(["islip>kingsmill"]);
  });
});

describe("which spots are on the map", () => {
  const spots: Pick<Spot, "key" | "name" | "gauge" | "mode">[] = [
    { key: "osney", name: "Osney", gauge: "minns", mode: "probability" },
    { key: "cherwell", name: "Cherwell / St Clement's", gauge: "kingsmill", mode: "probability" },
    { key: "wolvercote", name: "Wolvercote", gauge: "godstow", mode: "timing_only" },
  ];
  const lead = { h: 6, q: { "05": 1, "10": 1, "25": 1, "50": 1, "75": 1, "90": 1, "95": 1 }, pFlood: 0.1, pAmber: 0.2 };
  const sf = (spot: string, leads = [lead]) => ({ spot, levelNow: 1, leads, arrival: null, mode: "probability" as const });

  it("Now: hides Wolvercote (no forecast) and Cherwell while its gauge is offline, and says why", () => {
    const now: Pick<Forecast, "spots" | "stale"> = { stale: ["kingsmill"], spots: [sf("osney"), sf("cherwell", []), sf("wolvercote", [])] };
    const v = spotVisibility(spots, [now], { kingsmill: "Kings Mill", godstow: "Godstow" });
    expect([...v.shown]).toEqual(["osney"]);
    expect(v.hidden.map((h) => h.key)).toEqual(["cherwell", "wolvercote"]);
    expect(v.hidden[0].name).toBe("Cherwell");
    expect(v.hidden[0].why).toMatch(/Kings Mill gauge has no recent reading/);
    expect(v.hidden[1].why).toMatch(/timing only/);
  });

  it("a past flood: Cherwell shows when any replay step has a forecast for it", () => {
    const steps = [
      { stale: ["kingsmill"], spots: [sf("osney"), sf("cherwell", [])] },
      { stale: [], spots: [sf("osney"), sf("cherwell")] },
    ];
    const v = spotVisibility(spots, steps);
    expect(v.shown.has("cherwell")).toBe(true);
    expect(v.shown.has("wolvercote")).toBe(false);
  });

  it("while loading (no forecasts) nothing is shown or listed", () => {
    expect(spotVisibility(spots, [])).toEqual({ shown: new Set(), hidden: [] });
    expect(spotVisibility(spots, [null])).toEqual({ shown: new Set(), hidden: [] });
  });

  it.skipIf(!existsSync(DATA + "live.json") || !existsSync(DATA + "spots.json"))("with the real files: Wolvercote is never on the map in Now", () => {
    const live = JSON.parse(readFileSync(DATA + "live.json", "utf8")) as Forecast;
    const real = JSON.parse(readFileSync(DATA + "spots.json", "utf8")) as Spot[];
    const v = spotVisibility(real, [live]);
    if (real.some((s) => s.key === "wolvercote")) expect(v.shown.has("wolvercote")).toBe(false);
    expect(v.shown.size + v.hidden.length).toBe(real.length);
  });
});

describe("river lines take their own river's gauge", () => {
  it("same river within 15 km first, else the nearest gauge within 2.5 km, else none", () => {
    const gauges = [
      { key: "eynsham", lat: 51.7747, lon: -1.3569, river: "Thames" },
      { key: "cassington", lat: 51.786, lon: -1.3512, river: "Evenlode" },
    ];
    const out = assignGauges(
      [
        // Next to Cassington, but on the Thames: Eynsham's.
        line([[-1.352, 51.784], [-1.3515, 51.785], [-1.351, 51.786]], { name: "Thames" }),
        line([[-1.352, 51.787], [-1.351, 51.788], [-1.35, 51.789]], { name: "Evenlode" }),
        line([[-1.35, 51.78], [-1.349, 51.781], [-1.348, 51.782]], { name: "Some Brook", kind: "stream" }),
        line([[-1.0, 51.5], [-1.01, 51.51], [-1.02, 51.52]], { name: "Far Away" }),
      ],
      gauges,
    );
    expect(out.features.map((f) => f.properties?.gauge)).toEqual(["eynsham", "cassington", "cassington", null]);
    expect(out.features[0].properties?.w).toBeGreaterThan(out.features[2].properties?.w);
  });

  it("bounds of a collection, or null when empty", () => {
    expect(geoBounds(fc([line([[-1.4, 51.7], [-1.2, 51.9], [-1.3, 51.8]])]))).toEqual([
      [-1.4, 51.7],
      [-1.2, 51.9],
    ]);
    expect(geoBounds(fc([]))).toBeNull();
    expect(geoBounds(null)).toBeNull();
  });
});

describe("the offline basemap: never the internet, never a crash", () => {
  const magic = new TextEncoder().encode("PMTiles\u0003rest");
  const res = (status: number, type: string, body: Uint8Array = new Uint8Array()) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? type : null) } as Headers,
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
  });

  it("recognises a PMTiles archive by its first bytes", () => {
    expect(isPmtiles(magic)).toBe(true);
    expect(isPmtiles(new TextEncoder().encode("<!doctype html>"))).toBe(false);
    expect(isPmtiles(new Uint8Array())).toBe(false);
  });

  it("missing tiles (a 404, or the dev server's index.html) fall back to the plain map", async () => {
    expect(await probeBasemap("/", async () => res(404, "text/plain"))).toEqual({ tiles: false, glyphs: false, sprite: false });
    expect(await probeBasemap("/", async () => res(200, "text/html", new TextEncoder().encode("<!doctype html>")))).toEqual({ tiles: false, glyphs: false, sprite: false });
    expect(
      await probeBasemap("/", async () => {
        throw new TypeError("offline");
      }),
    ).toEqual({ tiles: false, glyphs: false, sprite: false });
    // A server without byte ranges (200 for the whole file) can't serve PMTiles either.
    expect((await probeBasemap("/", async () => res(200, "application/octet-stream", magic))).tiles).toBe(false);
  });

  it("tiles present: labels only if the local fonts are there too; every request is local", async () => {
    const urls: string[] = [];
    const withFonts = await probeBasemap("/", async (url) => {
      urls.push(url);
      return url.endsWith(".pmtiles") ? res(206, "application/octet-stream", magic) : res(200, "application/x-protobuf");
    });
    expect(withFonts).toEqual({ tiles: true, glyphs: true, sprite: true });
    expect(urls.every((u) => u.startsWith("/tiles/"))).toBe(true);
    const noFonts = await probeBasemap("/", async (url) => (url.endsWith(".pmtiles") ? res(206, "application/octet-stream", magic) : res(404, "text/plain")));
    expect(noFonts).toEqual({ tiles: true, glyphs: false, sprite: false });
  });

  it("the style: just a background without tiles; the muted Protomaps layers with them, text only with fonts", () => {
    const plain = baseStyle({ tilesUrl: null, glyphsUrl: null });
    expect(plain.layers.map((l) => l.type)).toEqual(["background"]);
    expect(plain.sources).toEqual({});
    expect(plain.glyphs).toBeUndefined();

    const full = baseStyle({ tilesUrl: "pmtiles://http://localhost/tiles/oxon.pmtiles", glyphsUrl: "http://localhost/tiles/fonts/{fontstack}/{range}.pbf" });
    expect(full.layers.length).toBeGreaterThan(20);
    expect(full.layers.some((l) => l.type === "symbol")).toBe(true);
    expect(full.layers.some((l) => l.id === "roads_shields" || l.id === "roads_oneway")).toBe(false);
    expect(JSON.stringify(full)).not.toMatch(/https?:\/\/(?!localhost)[^"]*\.(pbf|pmtiles|json)/);

    const noText = baseStyle({ tilesUrl: "pmtiles://http://localhost/tiles/oxon.pmtiles", glyphsUrl: null });
    expect(noText.layers.some((l) => l.type === "symbol")).toBe(false);
    expect(noText.glyphs).toBeUndefined();
  });
});

describe("our layers are valid MapLibre style (no browser needed to catch a bad expression)", () => {
  const withOurLayers = (base: StyleSpecification, paint: ReturnType<typeof riverPaint>): StyleSpecification => ({
    ...base,
    sources: {
      ...base.sources,
      "rc-base": { type: "geojson", data: { type: "FeatureCollection", features: [] } },
      "rc-rivers": { type: "geojson", data: { type: "FeatureCollection", features: [] } },
    },
    layers: [
      ...base.layers,
      ...fallbackLayers("rc-base"),
      { id: "rc-river-casing", type: "line", source: "rc-rivers", layout: RIVER_LAYOUT, paint: paint.casing },
      { id: "rc-river", type: "line", source: "rc-rivers", layout: RIVER_LAYOUT, paint: paint.river },
    ],
  });
  const cases = {
    "levels known, on a river walk": riverPaint({ colours: { osney: "#2a78d6", minns: "#b7c3cc" }, widths: { osney: 2, minns: 1 }, plain: "#9fc0dc", walk: ["osney", "minns"] }),
    "no gauges yet, no walk": riverPaint({ colours: {}, widths: {}, plain: "#9fc0dc", walk: [] }),
  };
  for (const [name, paint] of Object.entries(cases)) {
    it(`plain fallback style: ${name}`, () => {
      expect(validateStyleMin(withOurLayers(baseStyle({ tilesUrl: null, glyphsUrl: null }), paint))).toEqual([]);
    });
  }
  it("full PMTiles style with labels and our layers", () => {
    const full = baseStyle({ tilesUrl: "pmtiles://http://localhost/tiles/oxon.pmtiles", glyphsUrl: "http://localhost/tiles/fonts/{fontstack}/{range}.pbf" });
    expect(validateStyleMin(withOurLayers(full, cases["levels known, on a river walk"]))).toEqual([]);
  });
});

describe("river pieces and context paths", () => {
  it("long rivers are split into pieces of about 1.5 km that join end to end", () => {
    const path: Position[] = Array.from({ length: 41 }, (_, i) => [-1.4 + i * 0.002, 51.75]); // about 5.5 km
    const pieces = splitLine(path);
    expect(pieces.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < pieces.length; i++) expect(pieces[i][0]).toEqual(pieces[i - 1][pieces[i - 1].length - 1]);
    expect(pieces.flat().length - (pieces.length - 1)).toBe(path.length);
  });

  it('"River Thames" matches a Thames gauge, piece by piece', () => {
    const path: Position[] = Array.from({ length: 81 }, (_, i) => [-1.45 + i * 0.002, 51.75]); // about 11 km
    const out = assignGauges([line(path, { name: "River Thames", kind: "river" })], [
      { key: "west", lat: 51.75, lon: -1.45, river: "Thames" },
      { key: "east", lat: 51.75, lon: -1.29, river: "Thames" },
    ]);
    const gauges = out.features.map((f) => f.properties?.gauge);
    expect(gauges[0]).toBe("west");
    expect(gauges[gauges.length - 1]).toBe("east");
  });

  it("context paths: untimed only, one per upstream gauge (its shortest), and words with no hour count", () => {
    const short: Position[] = [[0, 0], [0.01, 0.01], [0.02, 0]];
    const long: Position[] = [[0, 0], [0.05, 0.05], [0.1, 0]];
    const courses = new Map([
      ["shipton>minns", { path: long }],
      ["shipton>newbotley", { path: short }],
      ["islip>kingsmill", { path: short, travelH: 31 }],
    ]);
    expect(contextCourses(courses, new Set())).toEqual([{ up: "shipton", down: "newbotley", path: short }]);
    expect(contextWords("Shipton", "Botley Road")).not.toMatch(/\d/);
  });

  const files = ["geo/river-paths.geojson", "geo/catchment-rivers.geojson", "stations.json", "travel_times.json"];
  it.skipIf(!files.every((f) => existsSync(DATA + f)))("with the real files: every measured chain link has a river course, none straight", () => {
    const paths = JSON.parse(readFileSync(DATA + files[0], "utf8")) as FeatureCollection;
    const rivers = JSON.parse(readFileSync(DATA + files[1], "utf8")) as FeatureCollection;
    const stations = JSON.parse(readFileSync(DATA + files[2], "utf8")) as Station[];
    const pairs = JSON.parse(readFileSync(DATA + files[3], "utf8")) as TravelPair[];
    const courses = coursesFrom(paths);
    for (const c of courses.values()) expect(c.path.length).toBeGreaterThanOrEqual(3);
    for (const l of chainLinks(stations, pairs)) expect(courses.has(`${l.up}>${l.down}`), `${l.up}>${l.down}`).toBe(true);
    // Every river piece is either a gauge's or plain water; most of the Thames has a gauge.
    const pieces = assignGauges(rivers.features, stations).features;
    const thames = pieces.filter((f) => f.properties?.name === "River Thames");
    expect(thames.filter((f) => f.properties?.gauge != null).length / thames.length).toBeGreaterThan(0.8);
    expect(geoBounds(rivers)).not.toBeNull();
  });
});
