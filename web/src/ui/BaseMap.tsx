// BaseMap (#118): a readable Oxford map that works fully offline. The base is
// a bundled vector GeoJSON (data/geo/oxford-base.geojson: OSM water, rivers,
// main roads, railways and buildings; © OpenStreetMap contributors, ODbL),
// drawn as Leaflet vector layers. OSM raster tiles are an optional extra when
// online. Children are overlays (spot clocks, spread heatmap, pins).
import { Component, type ReactNode, useEffect, useState } from "react";
import { GeoJSON, MapContainer, TileLayer, useMap } from "react-leaflet";
import type { FeatureCollection } from "geojson";
import type { PathOptions } from "leaflet";
import { loadData } from "../data";

import { OXFORD_BOUNDS, safeBounds, type Bounds } from "./bounds";

export { OXFORD_BOUNDS, safeBounds };

export const BASEMAP_FILE = "geo/oxford-base.geojson";

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
function MapSizer({ bounds }: { bounds: Bounds }) {
  const map = useMap();
  const key = bounds.flat().join(",");
  useEffect(() => {
    const el = map.getContainer();
    let fitted = false;
    const fix = () => {
      map.invalidateSize();
      if (fitted || el.clientWidth === 0 || el.clientHeight === 0) return;
      try {
        map.fitBounds(bounds, { padding: [24, 24] });
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
  tiles: tilesDefault = false,
  interactive = true,
}: {
  bounds?: [[number, number], [number, number]];
  children?: ReactNode;
  className?: string;
  /** Start with OSM raster tiles on (only shown when online). */
  tiles?: boolean;
  /** Allow pan and zoom (default true; scroll-wheel zoom is always off). */
  interactive?: boolean;
}) {
  const base = useBaseMap();
  const online = typeof navigator === "undefined" ? false : navigator.onLine;
  const [tiles, setTiles] = useState(tilesDefault && online);
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
        attributionControl
      >
        {tiles && (
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            eventHandlers={{ tileerror: () => setTiles(false) }}
          />
        )}
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
        <MapSizer bounds={fit} />
        {children}
      </MapContainer>
      </MapErrorBoundary>
      {online && (
        <button className="ui-basemap-toggle" onClick={() => setTiles((t) => !t)} aria-pressed={tiles}>
          {tiles ? "Simple map" : "Street map"}
        </button>
      )}
      {base.status === "none" && !tiles && <div className="ui-basemap-note">The Oxford basemap could not be loaded (data/geo/oxford-base.geojson).</div>}
    </div>
  );
}
