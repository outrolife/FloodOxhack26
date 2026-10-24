// BaseMap (#118): a readable Oxford map that works fully offline. The base is
// a bundled vector GeoJSON (data/geo/oxford-base.geojson: OSM water, rivers,
// main roads, railways and buildings; © OpenStreetMap contributors, ODbL),
// drawn as Leaflet vector layers. OSM raster tiles are an optional extra when
// online. Children are overlays (spot clocks, spread heatmap, pins).
import { type ReactNode, useEffect, useState } from "react";
import { GeoJSON, MapContainer, TileLayer, useMap } from "react-leaflet";
import type { FeatureCollection } from "geojson";
import type { PathOptions } from "leaflet";
import { loadData } from "../data";

/** Default view: the five trouble spots with some room around them. */
export const OXFORD_BOUNDS: [[number, number], [number, number]] = [
  [51.722, -1.305],
  [51.786, -1.232],
];

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
function MapSizer({ bounds }: { bounds: [[number, number], [number, number]] }) {
  const map = useMap();
  useEffect(() => {
    const el = map.getContainer();
    let sized = el.clientWidth > 0 && el.clientHeight > 0;
    const fix = () => {
      map.invalidateSize();
      const now = el.clientWidth > 0 && el.clientHeight > 0;
      if (now && !sized) map.fitBounds(bounds, { padding: [24, 24] });
      sized = now;
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
    // Bounds are read when the map first gets a real size; later changes don't re-fit.
  }, [map]);
  return null;
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
  return (
    <div className={`ui-basemap${className ? ` ${className}` : ""}`}>
      <MapContainer
        bounds={bounds}
        boundsOptions={{ padding: [24, 24] }}
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
        <MapSizer bounds={bounds} />
        {children}
      </MapContainer>
      {online && (
        <button className="ui-basemap-toggle" onClick={() => setTiles((t) => !t)} aria-pressed={tiles}>
          {tiles ? "Simple map" : "Street map"}
        </button>
      )}
      {base.status === "none" && !tiles && <div className="ui-basemap-note">The Oxford basemap could not be loaded (data/geo/oxford-base.geojson).</div>}
    </div>
  );
}
