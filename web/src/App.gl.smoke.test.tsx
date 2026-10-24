// @vitest-environment jsdom
//
// Map v3 (#152) smoke test: the whole <App/> with ?map=gl in jsdom. jsdom has
// no WebGL, so MapLibre (react-map-gl), deck.gl and pmtiles are replaced by
// small stand-ins that render the map's children (markers, popups) as plain
// DOM. The checks: the GL map loads (as its own lazy chunk), the gauges and
// only the spots with data are on it, the hidden ones are named in "Show the
// working", no flow path is a straight line, the missing offline tiles fall
// back quietly, and nothing logs a console error.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Forecast, Replay, Spot } from "./contracts";
import { spotVisibility } from "./clock/flowgl";
import { getHiddenSpots } from "./clock/hiddenSpots";
import App from "./App";

const DATA = resolve(__dirname, "../public/data") + "/";
const WAIT_MS = 15_000;
const TEST_MS = 40_000;

const deck = vi.hoisted(() => ({ props: [] as { layers?: { props: Record<string, unknown> }[] }[] }));

vi.mock("maplibre-gl", () => ({ addProtocol: vi.fn() }));
vi.mock("pmtiles", () => ({ Protocol: class { tile = vi.fn(); } }));
vi.mock("@deck.gl/mapbox", () => ({
  MapboxOverlay: class {
    setProps(p: { layers?: { props: Record<string, unknown> }[] }) {
      deck.props.push(p);
    }
    onAdd() {
      return document.createElement("div");
    }
    onRemove() {}
  },
}));
vi.mock("@deck.gl/layers", () => ({ PathLayer: class { constructor(public props: Record<string, unknown>) {} } }));
vi.mock("@deck.gl/geo-layers", () => ({ TripsLayer: class { constructor(public props: Record<string, unknown>) {} } }));
vi.mock("react-map-gl/maplibre", async () => {
  const React = await import("react");
  const h = React.createElement;
  const map = {
    project: ([lon, lat]: [number, number]) => ({ x: (lon + 1.45) * 3000, y: (51.9 - lat) * 4000 }),
    getContainer: () => ({ clientWidth: 900, clientHeight: 500 }),
    getZoom: () => 10,
    on: () => {},
    hasImage: () => true,
    addImage: () => {},
    setMaxBounds: () => {},
    fitBounds: () => {},
    touchZoomRotate: { disableRotation: () => {} },
  };
  type P = { children?: React.ReactNode; onLoad?: (e: { target: typeof map }) => void };
  const MapGL = React.forwardRef<unknown, P>(function MapGL({ children, onLoad }, ref) {
    React.useImperativeHandle(ref, () => ({ getMap: () => map }));
    React.useEffect(() => onLoad?.({ target: map }), []); // eslint-disable-line react-hooks/exhaustive-deps
    return h("div", { className: "maplibregl-map" }, children);
  });
  const Box = (className: string) =>
    function Box({ children }: { children?: React.ReactNode }) {
      return h("div", { className }, children);
    };
  return {
    default: MapGL,
    Marker: Box("maplibregl-marker"),
    Popup: Box("maplibregl-popup"),
    Source: ({ children }: { children?: React.ReactNode }) => h(React.Fragment, null, children),
    Layer: () => null,
    NavigationControl: () => null,
    AttributionControl: () => null,
    useControl: (create: (ctx: unknown) => unknown) => React.useState(() => create({}))[0],
  };
});

/** A fetch Response for /data/<file> from web/public/data (404 for anything else: /api/live, /tiles/oxon.pmtiles). */
function respond(url: string) {
  const path = new URL(url, "http://localhost/").pathname;
  const file = path.startsWith("/data/") ? DATA + decodeURIComponent(path.slice("/data/".length)) : null;
  const ok = file != null && existsSync(file);
  const text = ok ? readFileSync(file, "utf8") : "";
  return {
    ok,
    status: ok ? 200 : 404,
    headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? (ok ? "application/json" : "text/plain") : null) },
    json: async () => JSON.parse(text) as unknown,
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

const read = <T,>(f: string) => JSON.parse(readFileSync(DATA + f, "utf8")) as T;
const urlOf = (input: RequestInfo | URL) => (typeof input === "string" ? input : input instanceof URL ? input.href : input.url);

beforeEach(() => {
  deck.props = [];
  // jsdom has no WebGL: say it does, so the GL map (stand-ins) is drawn rather than the Leaflet fallback.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const ready = existsSync(DATA + "spots.json") && existsSync(DATA + "stations.json") && existsSync(DATA + "live.json");

describe("App smoke test, map v3 (?map=gl)", () => {
  it.skipIf(!ready)("draws the GL map with the gauges and only the spots with data, without console errors", async () => {
    const errors: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => respond(urlOf(input))));
    window.history.replaceState(null, "", "/?map=gl#/now");
    render(<App />);

    const spots = read<Spot[]>("spots.json");
    const stations = read<unknown[]>("stations.json");
    const expected = spotVisibility(spots, [read<Forecast>("live.json")]);

    await waitFor(() => expect(document.querySelector(".rc-hero .rc-gl .maplibregl-map")).not.toBeNull(), { timeout: WAIT_MS });
    expect(document.querySelector(".rc-hero .leaflet-container")).toBeNull();
    await waitFor(() => expect(document.querySelectorAll(".rc-hero .rc-gauge-icon")).toHaveLength(stations.length), { timeout: WAIT_MS });
    await waitFor(() => expect(document.querySelectorAll(".rc-hero .rc-dot")).toHaveLength(expected.shown.size), { timeout: WAIT_MS });
    // Wolvercote (timing only, no forecast) is never on the map; the hidden spots are named in Show the working.
    expect(screen.queryByRole("img", { name: /^Wolvercote/ })).toBeNull();
    expect(getHiddenSpots().map((h) => h.key)).toEqual(expected.hidden.map((h) => h.key));
    if (expected.hidden.length) {
      await act(async () => {
        window.location.hash = "/working";
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      });
      await waitFor(() => expect(document.querySelector(".rc-drawer-hidden")?.textContent).toContain(expected.hidden[0].name), { timeout: WAIT_MS });
    }
    // The flow layers are drawn, and no path anywhere is a straight two-point line.
    await waitFor(() => expect(deck.props.length).toBeGreaterThan(0), { timeout: WAIT_MS });
    for (const p of deck.props.slice(-3)) {
      for (const layer of p.layers ?? []) {
        for (const d of (layer.props.data as { path: unknown[] }[]) ?? []) expect(d.path.length).toBeGreaterThanOrEqual(3);
      }
    }
    // No offline tiles in this checkout's test server: the plain map says so quietly.
    await waitFor(() => expect(document.querySelector(".rc-gl-note")).not.toBeNull(), { timeout: WAIT_MS });
    expect(errors).toEqual([]);
  }, TEST_MS);

  it.skipIf(!ready || !existsSync(DATA + "replays/e2014.json"))("plays a past flood with the GL map; spots with replay forecasts are on it", async () => {
    const errors: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => respond(urlOf(input))));
    window.history.replaceState(null, "", "/?map=gl#/e2014");
    render(<App />);
    const expected = spotVisibility(read<Spot[]>("spots.json"), read<Replay>("replays/e2014.json").forecasts);
    await waitFor(() => expect(document.querySelector(".ck-play")).not.toBeNull(), { timeout: WAIT_MS });
    await waitFor(() => expect(document.querySelectorAll(".rc-hero .rc-gl .rc-dot")).toHaveLength(expected.shown.size), { timeout: WAIT_MS });
    expect(expected.shown.has("cherwell")).toBe(true);
    expect(errors).toEqual([]);
  }, TEST_MS);
});
