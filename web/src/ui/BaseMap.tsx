// BaseMap (#118): a readable Oxford map that works fully offline. Online, it
// shows the OSM street tiles. Offline, or once tiles fail to load, it falls
// back by itself (no toggle) to a bundled vector GeoJSON
// (data/geo/oxford-base.geojson: OSM water, rivers, main roads, railways and
// buildings; © OpenStreetMap contributors, ODbL), drawn as Leaflet vector
// layers. Children are overlays (spot clocks, spread heatmap, pins).
// Under it, a catchment-wide layer (data/geo/catchment-base.geojson: OSM main
// roads, railways, lakes, built-up areas and town names across the upper
// Thames and Cherwell) fills the map out to the furthest upstream gauges.
import { Component, type ReactNode, useEffect, useState } from "react";
import { GeoJSON, MapContainer, Marker, TileLayer, useMap } from "react-leaflet";
import L from "leaflet";
import type { FeatureCollection } from "geojson";
import type { PathOptions } from "leaflet";
import { loadData } from "../data";

import { OXFORD_BOUNDS, safeBounds, type Bounds } from "./bounds";

export { OXFORD_BOUNDS, safeBounds };

export const BASEMAP_FILE = "geo/oxford-base.geojson";
export const CATCHMENT_BASE_FILE = "geo/catchment-base.geojson";

/** Feature kinds in oxford-base.geojson (properties.kind). */
export type BaseKind = "water" | "river" | "stream" | "road" | "minor_road" | "rail" | "building" | "park";

/** Quiet, map-like styles: water blue-grey, roads white on a warm grey page. */
export const BASE_STYLE: Record<BaseKind, PathOptions> = {
  park: { stroke: false, fillColor: "#dfe9d8", fillOpacity: 1 },
  water: { stroke: false, fillColor: "#a9cbe8", fillOpacity: 1 },
  river: { color: "#8bb8de", weight: 4, opacity: 1 },
  stream: { color: "#9fc4e4", weight: 2, opacity: 1 },
  building: { color: "#cfcac0", weight: 0.5, fillColor: "#e3dfd6", fillOpacity: 1 },
  minor_road: { color: "#ffffff", weight: 1.5, opacity: 1 },
  road: { color: "#ffffff", weight: 3.5, opacity: 1 },
  rail: { color: "#9b978e", weight: 1.5, opacity: 1, dashArray: "4 3" },
};

/** Draw order, bottom to top. */
const ORDER: BaseKind[] = ["park", "water", "building", "minor_road", "road", "rail", "stream", "river"];

/** The catchment layer's kinds (properties.kind), drawn under Oxford's, in this order. */
type CatchKind = "urban" | "water" | "rail" | "road" | "major_road";
const CATCH_ORDER: CatchKind[] = ["urban", "water", "rail", "road", "major_road"];
export const CATCH_STYLE: Record<CatchKind, PathOptions> = {
  urban: { stroke: false, fillColor: "#e4dfd4", fillOpacity: 1 },
  water: { stroke: false, fillColor: "#a9cbe8", fillOpacity: 1 },
  rail: { color: "#a9a59c", weight: 1.2, opacity: 1, dashArray: "4 3" },
  road: { color: "#ffffff", weight: 1.8, opacity: 1 },
  major_road: { color: "#ffffff", weight: 3, opacity: 1 },
};
type Town = { name: string; lat: number; lon: number };
type CatchBase = { status: "loading" | "none" } | { status: "ready"; byKind: Partial<Record<CatchKind, FeatureCollection>>; towns: Town[] };

let catchCache: Promise<CatchBase> | null = null;
function loadCatchBase(): Promise<CatchBase> {
  catchCache ??= loadData<FeatureCollection>(CATCHMENT_BASE_FILE)
    .then(({ value }) => {
      const byKind: Partial<Record<CatchKind, FeatureCollection>> = {};
      const towns: Town[] = [];
      for (const f of value.features ?? []) {
        const k = f.properties?.kind;
        if (k === "town" && f.geometry?.type === "Point") {
          const [lon, lat] = f.geometry.coordinates;
          towns.push({ name: String(f.properties?.name ?? ""), lat, lon });
        } else if (k in CATCH_STYLE) {
          (byKind[k as CatchKind] ??= { type: "FeatureCollection", features: [] }).features.push(f);
        }
      }
      return { status: "ready", byKind, towns } as CatchBase;
    })
    .catch(() => ({ status: "none" }) as CatchBase);
  return catchCache;
}

function useCatchBase(): CatchBase {
  const [base, setBase] = useState<CatchBase>({ status: "loading" });
  useEffect(() => {
    let alive = true;
    loadCatchBase().then((b) => alive && setBase(b));
    return () => {
      alive = false;
    };
  }, []);
  return base;
}

const townIcons = new Map<string, L.DivIcon>();
function townIcon(name: string): L.DivIcon {
  let icon = townIcons.get(name);
  if (!icon) {
    icon = L.divIcon({ className: "ui-town", html: `<span>${name.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)}</span>`, iconSize: [0, 0] });
    townIcons.set(name, icon);
  }
  return icon;
}

/**
 * Pinch to zoom the map, not the page. A trackpad pinch reaches the browser as
 * a wheel event with ctrlKey set (Chrome, Edge, Firefox) or as gesture events
 * (Safari); left alone, both zoom the whole page. Here they zoom the map around
 * the pointer. A plain two-finger scroll still scrolls the page, and touch
 * screens pinch through Leaflet's own touch zoom.
 */
function PinchZoom() {
  const map = useMap();
  useEffect(() => {
    const el = map.getContainer();
    let target: number | null = null;
    let idle = 0;
    let frame = 0;
    let at: L.Point | null = null;
    const clamp = (z: number) => Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), z));
    // At most one redraw per frame, at the map's 0.25 zoom steps. An unsnapped zoom that rounds back to
    // the current one would only shift the centre, so a slow pinch would slide the map instead of zooming.
    const apply = () => {
      frame = 0;
      if (target == null || at == null) return;
      const z = Math.round(target * 4) / 4;
      if (z !== map.getZoom()) map.setZoomAround(at, z, { animate: false });
    };
    const zoomTo = (z: number, point: L.Point) => {
      target = clamp(z);
      at = point;
      if (!frame) frame = window.requestAnimationFrame(apply);
    };
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      // Pixel deltas from a trackpad are small and many; line deltas (ctrl + mouse wheel) are coarse.
      const step = e.deltaMode === 1 ? e.deltaY * 0.25 : e.deltaY * 0.012;
      zoomTo((target ?? map.getZoom()) - step, map.mouseEventToContainerPoint(e));
      window.clearTimeout(idle);
      idle = window.setTimeout(() => (target = null), 250);
    };
    let start = 0;
    type Gesture = Event & { scale: number; clientX: number; clientY: number };
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      start = map.getZoom();
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const g = e as Gesture;
      zoomTo(start + Math.log2(g.scale), map.mouseEventToContainerPoint(g as unknown as MouseEvent));
    };
    const block = (e: Event) => e.preventDefault();
    el.addEventListener("wheel", onWheel, { passive: false });
    // Safari's gesture events are for trackpads here. On iPhone and iPad they also fire for touchscreen
    // pinches, which Leaflet's touch zoom already handles, so two handlers would fight over one pinch.
    const trackpadGestures = typeof navigator !== "undefined" && navigator.maxTouchPoints === 0;
    if (trackpadGestures) {
      el.addEventListener("gesturestart", onGestureStart);
      el.addEventListener("gesturechange", onGestureChange);
      el.addEventListener("gestureend", block);
    }
    return () => {
      window.clearTimeout(idle);
      if (frame) window.cancelAnimationFrame(frame);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
      el.removeEventListener("gestureend", block);
    };
  }, [map]);
  return null;
}

type Base = { status: "loading" } | { status: "ready"; byKind: Partial<Record<BaseKind, FeatureCollection>> } | { status: "none" };

let cache: Promise<Base> | null = null;
function loadBase(): Promise<Base> {
  cache ??= loadData<FeatureCollection>(BASEMAP_FILE)
    .then(({ value }) => {
      const byKind: Partial<Record<BaseKind, FeatureCollection>> = {};
      for (const f of value.features ?? []) {
        const k = (f.properties?.kind ?? "") as BaseKind;
        if (!(k in BASE_STYLE)) continue;
        (byKind[k] ??= { type: "FeatureCollection", features: [] }).features.push(f);
      }
      return { status: "ready", byKind } as Base;
    })
    .catch(() => ({ status: "none" }) as Base);
  return cache;
}

export function useBaseMap(): Base {
  const [base, setBase] = useState<Base>({ status: "loading" });
  useEffect(() => {
    let alive = true;
    loadBase().then((b) => alive && setBase(b));
    return () => {
      alive = false;
    };
  }, []);
  return base;
}

/**
 * Keeps Leaflet's idea of the map size right (#118). Leaflet measures its
 * container once; if that was 0 × 0 (a collapsed panel, a drawer, a grid that
 * hadn't laid out yet) it draws nothing. A ResizeObserver calls
 * invalidateSize() whenever the container changes size, and re-fits the
 * bounds the first time it gets a real size.
 */
/** Room (px) kept clear when fitting the bounds, e.g. under a panel drawn over the map. */
export type FitPadding = { topLeft: [number, number]; bottomRight: [number, number] };
const DEFAULT_PAD: FitPadding = { topLeft: [24, 24], bottomRight: [24, 24] };

function MapSizer({ bounds, pad = DEFAULT_PAD }: { bounds: Bounds; pad?: FitPadding }) {
  const map = useMap();
  const key = bounds.flat().join(",");
  useEffect(() => {
    const el = map.getContainer();
    let fitted = false;
    const fix = () => {
      map.invalidateSize();
      if (fitted || el.clientWidth === 0 || el.clientHeight === 0) return;
      try {
        // Padding wider than the map would leave no room: fall back to the default.
        const p = pad.topLeft[0] + pad.bottomRight[0] < el.clientWidth - 80 && pad.topLeft[1] + pad.bottomRight[1] < el.clientHeight - 80 ? pad : DEFAULT_PAD;
        map.setMinZoom(0);
        map.setMaxBounds(undefined);
        // Lock to the fitted zoom, not the previous zoom during an animated transition.
        map.fitBounds(bounds, { paddingTopLeft: p.topLeft, paddingBottomRight: p.bottomRight, animate: false });
        map.setMinZoom(map.getZoom());
        map.setMaxBounds(L.latLngBounds(bounds).pad(0.08));
        fitted = true;
      } catch {
        // Not laid out yet; the next resize tries again.
      }
    };
    const t = window.setTimeout(fix, 0); // once after the first layout
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", fix);
      return () => {
        window.clearTimeout(t);
        window.removeEventListener("resize", fix);
      };
    }
    const ro = new ResizeObserver(fix);
    ro.observe(el);
    return () => {
      window.clearTimeout(t);
      ro.disconnect();
    };
    // Re-fit when the bounds change (e.g. from the Oxford fallback to the loaded data), not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, key]);
  return null;
}

/** Failed tiles before the map falls back to the bundled vector basemap. */
export const TILE_ERRORS_TO_FALL_BACK = 3;

/** navigator.onLine, kept up to date by the browser's online / offline events. */
function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? false : navigator.onLine));
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}

/** A map failure shows a note instead of unmounting the whole page. */
class MapErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? <div className="ui-basemap-note">The map could not be drawn. Reload the page.</div> : this.props.children;
  }
}

export function BaseMap({
  bounds = OXFORD_BOUNDS,
  children,
  className,
  tiles: wantTiles = true,
  interactive = true,
  fitPadding,
}: {
  bounds?: [[number, number], [number, number]];
  children?: ReactNode;
  className?: string;
  /** Use the OSM street tiles when online (default true); false = always the bundled vector basemap. */
  tiles?: boolean;
  /** Allow pan and zoom (default true). Scroll-wheel zoom is off; a trackpad pinch zooms the map (PinchZoom). */
  interactive?: boolean;
  /** Room to keep clear when fitting the bounds (default 24 px all round). */
  fitPadding?: FitPadding;
}) {
  const base = useBaseMap();
  const catchBase = useCatchBase();
  const online = useOnline();
  // Tiles that fail to load (no network behind a "connected" Wi-Fi, a blocked server) switch to the
  // bundled basemap. A few failures, not one, so a single dropped tile doesn't swap the whole map.
  const [tileErrors, setTileErrors] = useState(0);
  useEffect(() => {
    if (online) setTileErrors(0); // back online: try the tiles again
  }, [online]);
  const tiles = wantTiles && online && tileErrors < TILE_ERRORS_TO_FALL_BACK;
  const fit = safeBounds(bounds);
  // Start from a centre and zoom, never from bounds: fitting bounds in a container that has no size yet
  // gives a NaN zoom. MapSizer fits the bounds once the container is laid out.
  const center: [number, number] = [(fit[0][0] + fit[1][0]) / 2, (fit[0][1] + fit[1][1]) / 2];
  return (
    <div className={`ui-basemap${className ? ` ${className}` : ""}`}>
      <MapErrorBoundary>
      <MapContainer
        center={center}
        zoom={13}
        zoomSnap={0.25}
        scrollWheelZoom={false}
        dragging={interactive}
        doubleClickZoom={interactive}
        zoomControl={interactive}
        maxZoom={16}
        maxBoundsViscosity={1}
        attributionControl
      >
        {tiles && (
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            eventHandlers={{ tileerror: () => setTileErrors((n) => n + 1) }}
          />
        )}
        {!tiles &&
          catchBase.status === "ready" &&
          CATCH_ORDER.map((k) =>
            catchBase.byKind[k] ? (
              <GeoJSON key={`catch-${k}`} data={catchBase.byKind[k]!} style={() => CATCH_STYLE[k]} interactive={false} />
            ) : null,
          )}
        {!tiles &&
          catchBase.status === "ready" &&
          catchBase.towns.map((t) => (
            <Marker key={`town-${t.name}`} position={[t.lat, t.lon]} icon={townIcon(t.name)} interactive={false} keyboard={false} zIndexOffset={-1000} />
          ))}
        {!tiles &&
          base.status === "ready" &&
          ORDER.map((k) =>
            base.byKind[k] ? (
              <GeoJSON
                key={k}
                data={base.byKind[k]!}
                style={() => BASE_STYLE[k]}
                interactive={false}
                attribution='Basemap &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors (ODbL)'
              />
            ) : null,
          )}
        <MapSizer bounds={fit} pad={fitPadding} />
        {interactive && <PinchZoom />}
        {children}
      </MapContainer>
      </MapErrorBoundary>
      {base.status === "none" && !tiles && <div className="ui-basemap-note">The Oxford basemap could not be loaded (data/geo/oxford-base.geojson).</div>}
    </div>
  );
}
