// Map v3 (#152): the MapLibre style for the flow map. A muted, light-grey
// Protomaps basemap from the offline PMTiles archive (so our blue water layer
// stands out), or, when the archive isn't there, a plain background; the
// fallback layers (Oxford streets from oxford-base.geojson) are added by
// FlowMapGL as GeoJSON sources. Nothing here fetches from the internet.
import { GRAYSCALE, layers, type Flavor } from "@protomaps/basemaps";
import type { ExpressionSpecification, LayerSpecification, LineLayerSpecification, StyleSpecification } from "maplibre-gl";

export const PAGE = "#f2f1ed";

/** Protomaps' grayscale flavour, lighter and warmer: land near white, water a pale grey-blue, roads white. */
export const RIVER_CLOCK_FLAVOR: Flavor = {
  ...GRAYSCALE,
  background: PAGE,
  earth: "#f1f0ec",
  water: "#d9e2e9",
  park_a: "#e6ebe0",
  park_b: "#e6ebe0",
  wood_a: "#e7ebe1",
  wood_b: "#e7ebe1",
  scrub_a: "#eceee6",
  scrub_b: "#eceee6",
  buildings: "#e4e1da",
  pedestrian: "#efeee9",
  industrial: "#ecebe6",
  hospital: "#efeee9",
  school: "#efeee9",
  aerodrome: "#ecebe6",
  runway: "#e4e2dc",
  minor_a: "#ffffff",
  minor_b: "#ffffff",
  minor_service: "#ffffff",
  other: "#ffffff",
  link: "#ffffff",
  major: "#ffffff",
  highway: "#fbfaf7",
  minor_casing: "#e2dfd8",
  minor_service_casing: "#e2dfd8",
  link_casing: "#dcd9d2",
  major_casing_early: "#d8d5ce",
  major_casing_late: "#d8d5ce",
  highway_casing_early: "#d2cfc8",
  highway_casing_late: "#d2cfc8",
  railway: "#c9c6bf",
  boundaries: "#c9c6bf",
  roads_label_minor: "#8a8884",
  roads_label_major: "#77756f",
  subplace_label: "#77756f",
  city_label: "#55534e",
  state_label: "#8a8884",
  country_label: "#8a8884",
};

/** Clutter we don't need on a flood map (and that would need an icon sprite). */
const DROP = new Set(["roads_oneway", "roads_shields", "address_label"]);

/** The Protomaps layers for source `source`, muted; without glyphs, no text layers at all. */
export function basemapLayers(source: string, glyphs: boolean): LayerSpecification[] {
  return (layers(source, RIVER_CLOCK_FLAVOR, { lang: "en" }) as LayerSpecification[]).filter(
    (l) => !DROP.has(l.id) && (glyphs || l.type !== "symbol"),
  );
}

export const BASEMAP_SOURCE = "protomaps";

/**
 * The map style. `tilesUrl`: a pmtiles:// URL for the offline archive, or null
 * for the plain fallback. `glyphsUrl`: the local fonts template, or null (no
 * labels). `spriteUrl`: the local icon sprite, or null (missing icons get a
 * blank image). The background is always drawn, so the map is never blank.
 */
export function baseStyle({
  tilesUrl,
  glyphsUrl,
  spriteUrl = null,
}: {
  tilesUrl: string | null;
  glyphsUrl: string | null;
  spriteUrl?: string | null;
}): StyleSpecification {
  const style: StyleSpecification = {
    version: 8,
    sources: {},
    layers: [{ id: "background", type: "background", paint: { "background-color": PAGE } }],
  };
  if (tilesUrl) {
    style.sources[BASEMAP_SOURCE] = {
      type: "vector",
      url: tilesUrl,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · <a href="https://protomaps.com">Protomaps</a>',
    };
    style.layers = basemapLayers(BASEMAP_SOURCE, glyphsUrl != null);
    if (glyphsUrl) style.glyphs = glyphsUrl;
    if (glyphsUrl && spriteUrl) style.sprite = spriteUrl;
  }
  return style;
}

// ---------------------------------------------------------------- our layers (checked against the style spec in tests)

const expr = (e: unknown) => e as ExpressionSpecification;

/** ["match", gauge, k1, v1, ..., fallback], or just the fallback when there are no gauges. */
export function byGauge<T extends string | number>(values: Record<string, T>, fallback: T): ExpressionSpecification | T {
  const pairs = Object.entries(values);
  if (pairs.length === 0) return fallback;
  return expr(["match", ["to-string", ["get", "gauge"]], ...pairs.flat(), fallback]);
}

/**
 * Paint for the river lines (properties `gauge` and `w` from assignGauges):
 * colour and width multiplier per gauge from its level, the lines of the
 * selected spot's river walk at full strength and the rest faded, and a white casing.
 */
export function riverPaint({
  colours,
  widths,
  plain,
  walk,
}: {
  colours: Record<string, string>;
  widths: Record<string, number>;
  /** Colour of lines no gauge speaks for. */
  plain: string;
  /** Gauges on the selected spot's river walk (empty: no walk). */
  walk: string[];
}): { river: LineLayerSpecification["paint"]; casing: LineLayerSpecification["paint"] } {
  const widthX = byGauge(widths, 0.85);
  // Zoom may only drive a top-level interpolate, so the casing (2 px wider) gets its own.
  const byZoom = (extra: number) => {
    const w = (k: number) => (extra ? ["+", ["*", ["get", "w"], k, widthX], extra] : ["*", ["get", "w"], k, widthX]);
    return expr(["interpolate", ["linear"], ["zoom"], 8, w(0.45), 11, w(0.8), 14, w(1.5), 17, w(2.6)]);
  };
  return {
    river: {
      "line-color": byGauge(colours, plain),
      "line-width": byZoom(0),
      "line-opacity": walk.length ? expr(["match", ["to-string", ["get", "gauge"]], walk, 1, 0.4]) : 1,
    },
    casing: { "line-color": "#ffffff", "line-opacity": 0.85, "line-width": byZoom(2) },
  };
}

export const RIVER_LAYOUT: LineLayerSpecification["layout"] = { "line-cap": "round", "line-join": "round" };

/** The plain fallback (no PMTiles): Oxford's parks, water, buildings, roads and rail from oxford-base.geojson. */
export function fallbackLayers(source: string): LayerSpecification[] {
  const kind = (k: string) => expr(["==", ["get", "kind"], k]);
  return [
    { id: "rc-base-park", type: "fill", source, filter: kind("park"), paint: { "fill-color": "#e6ebe0" } },
    { id: "rc-base-water", type: "fill", source, filter: kind("water"), paint: { "fill-color": "#d9e2e9" } },
    {
      id: "rc-base-building",
      type: "fill",
      source,
      minzoom: 13,
      filter: kind("building"),
      paint: { "fill-color": "#e4e1da", "fill-outline-color": "#d6d2ca" },
    },
    {
      id: "rc-base-minor",
      type: "line",
      source,
      minzoom: 12,
      filter: kind("minor_road"),
      paint: { "line-color": "#ffffff", "line-width": expr(["interpolate", ["linear"], ["zoom"], 12, 0.6, 16, 3]) },
    },
    {
      id: "rc-base-road",
      type: "line",
      source,
      filter: kind("road"),
      paint: { "line-color": "#ffffff", "line-width": expr(["interpolate", ["linear"], ["zoom"], 9, 0.6, 13, 2.2, 16, 6]) },
    },
    { id: "rc-base-rail", type: "line", source, filter: kind("rail"), paint: { "line-color": "#bdb9b1", "line-width": 1.2, "line-dasharray": [3, 2] } },
  ];
}
