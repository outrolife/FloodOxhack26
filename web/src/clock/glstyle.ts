// Map v3 (#152): the MapLibre style for the flow map. A muted, light-grey
// Protomaps basemap from the offline PMTiles archive (so our blue water layer
// stands out), or, when the archive isn't there, a plain background; the
// fallback layers (Oxford streets from oxford-base.geojson) are added by
// FlowMapGL as GeoJSON sources. Nothing here fetches from the internet.
import { GRAYSCALE, layers, type Flavor } from "@protomaps/basemaps";
import type { LayerSpecification, StyleSpecification } from "maplibre-gl";

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
 * labels). The background is always drawn, so the map is never blank.
 */
export function baseStyle({ tilesUrl, glyphsUrl }: { tilesUrl: string | null; glyphsUrl: string | null }): StyleSpecification {
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
  }
  return style;
}
