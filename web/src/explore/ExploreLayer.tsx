// Explore on the map (#118): react-leaflet children, so this must sit inside
// MapContainer. A click anywhere drops an animated pin (except on the map's own
// click targets: spot rings, gauges, links, popups), the risk zones are shaded
// by band with a hover highlight and tooltip, and a search result is flown to.
import { Component, memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import L from "leaflet";
import type { Feature, FeatureCollection, Polygon } from "geojson";
import { GeoJSON, Marker, useMap, useMapEvents } from "react-leaflet";
import { BAND_HEX, BAND_INFO } from "./logic";
import { prefersReducedMotion } from "./motion";
import type { RiskBand } from "./types";
import type { FlyTarget } from "./useExplore";

export const ZONES_PANE = "fc-zones";
/** Below the overlay pane (400), where the rivers, links and spot rings are drawn. */
const ZONES_Z = 350;

export const ZONE_BANDS: Exclude<RiskBand, "none">[] = ["high", "medium", "low", "very_low"];
const isBand = (b: unknown): b is Exclude<RiskBand, "none"> => ZONE_BANDS.includes(b as Exclude<RiskBand, "none">);

/** Wide screens show the card as a left panel; phones as a bottom sheet (matches explore.css). */
export const PHONE_MAX_PX = 700;
const isPhone = () => typeof window !== "undefined" && window.innerWidth <= PHONE_MAX_PX;
/** The desktop card's width plus its margins (explore.css), kept clear when placing a point. */
const PANEL_PX = 396;

export function zoneStyle(band: unknown, hover = false): L.PathOptions {
  const colour = (isBand(band) ? BAND_HEX[band] : BAND_HEX.none).fill;
  return {
    pane: ZONES_PANE,
    color: colour,
    weight: hover ? 2.5 : 0.6,
    opacity: hover ? 1 : 0.6,
    fillColor: colour,
    fillOpacity: hover ? 0.55 : 0.35,
    className: "fc-x-zone",
  };
}

/** "High risk zone". */
export function zoneLabel(band: unknown): string {
  return isBand(band) ? `${BAND_INFO[band].label} zone` : "Flood zone";
}

/**
 * Should a map click drop a pin? Not when it landed on one of the map's own
 * click targets: a marker, popup, tooltip or control, or an interactive line
 * (the upstream links). The risk zones are interactive too, and do take pins.
 */
export function dropsPin(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true;
  if (target.closest(".leaflet-marker-icon, .leaflet-popup, .leaflet-tooltip, .leaflet-control, .rc-dot-marker")) return false;
  if (target.classList.contains("leaflet-interactive") && !target.classList.contains("fc-x-zone")) return false;
  return true;
}

/**
 * One Polygon feature per part, so hovering a zone highlights that zone only,
 * not every zone of its band (#177 stores one MultiPolygon per band). The data
 * file is unchanged; this runs once per data set.
 */
export function explodeZones(fc: FeatureCollection): FeatureCollection<Polygon> {
  const features: Feature<Polygon>[] = [];
  for (const f of fc.features ?? []) {
    const g = f?.geometry;
    if (!g) continue;
    const parts = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
    for (const coordinates of parts) {
      if (coordinates?.length) features.push({ type: "Feature", properties: { band: f.properties?.band ?? null }, geometry: { type: "Polygon", coordinates } });
    }
  }
  return { type: "FeatureCollection", features };
}

/** Explode each data set once, even when the layer is hidden and shown again. */
const exploded = new WeakMap<FeatureCollection, FeatureCollection<Polygon>>();
function explodedOnce(fc: FeatureCollection): FeatureCollection<Polygon> {
  let out = exploded.get(fc);
  if (!out) {
    out = explodeZones(fc);
    exploded.set(fc, out);
  }
  return out;
}

/**
 * The zones' style and per-feature setup live at module scope: react-leaflet
 * re-applies a new `style` function to every path (thousands) on each render,
 * which would also wipe a hover highlight mid-hover.
 */
const zoneFeatureStyle = (f?: Feature) => zoneStyle(f?.properties?.band);
function onEachZone(f: Feature, layer: L.Layer) {
  const band = f.properties?.band;
  layer.bindTooltip(zoneLabel(band), { sticky: true, direction: "top", offset: [0, -10], className: "fc-x-zone-tip", opacity: 1 });
  layer.on({
    mouseover: (e) => {
      const p = e.target as L.Path;
      p.setStyle(zoneStyle(band, true));
      p.bringToFront();
    },
    mouseout: (e) => {
      (e.target as L.Path).setStyle(zoneStyle(band));
    },
  });
}

/** A malformed zones file must never take the map down: draw no zones instead. */
class ZonesBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(e: unknown) {
    console.warn("Risk zones could not be drawn:", e);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

const ZonesLayer = memo(function ZonesLayer({ zones }: { zones: FeatureCollection }) {
  const map = useMap();
  const [paneReady, setPaneReady] = useState(() => !!map.getPane(ZONES_PANE));
  useEffect(() => {
    if (!map.getPane(ZONES_PANE)) {
      const pane = map.createPane(ZONES_PANE);
      pane.style.zIndex = String(ZONES_Z);
    }
    setPaneReady(true);
  }, [map]);
  const parts = useMemo(() => explodedOnce(zones), [zones]);
  // A new key per data set: react-leaflet's GeoJSON reads its data only once.
  const key = useMemo(() => `zones-${parts.features.length}-${Math.random().toString(36).slice(2, 7)}`, [parts]);
  if (!paneReady) return null;
  return (
    <GeoJSON
      key={key}
      data={parts}
      pane={ZONES_PANE}
      style={zoneFeatureStyle}
      onEachFeature={onEachZone}
    />
  );
});

const PIN_HTML = `
<div class="fc-x-pin">
  <span class="fc-x-pin-pulse"></span>
  <span class="fc-x-pin-shadow"></span>
  <svg class="fc-x-pin-body" viewBox="0 0 32 44" width="32" height="44" aria-hidden="true" focusable="false">
    <path d="M16 1.5C8 1.5 1.5 7.9 1.5 15.8c0 10.6 12.3 24.4 13.4 25.6a1.5 1.5 0 0 0 2.2 0C18.2 40.2 30.5 26.4 30.5 15.8 30.5 7.9 24 1.5 16 1.5z" fill="#16171a" stroke="#fff" stroke-width="2"/>
    <circle cx="16" cy="15.5" r="5.5" fill="#fff"/>
  </svg>
</div>`;
const PIN_ICON = L.divIcon({ className: "fc-x-pin-icon", html: PIN_HTML, iconSize: [32, 44], iconAnchor: [16, 43] });

function DropPin({ pin }: { pin: { id: number; lat: number; lon: number } }) {
  // Keyed on the pin id by the parent, so each new point re-mounts and re-drops.
  return <Marker position={[pin.lat, pin.lon]} icon={PIN_ICON} interactive={false} keyboard={false} zIndexOffset={2000} />;
}

/** The point on screen should not end up under the card: right of the side panel on wide screens. */
function clearOffset(map: L.Map): L.Point {
  const size = map.getSize();
  if (isPhone()) return L.point(0, 0);
  return size.x > PANEL_PX + 240 ? L.point(Math.round(PANEL_PX / 2), 0) : L.point(0, 0);
}

/**
 * Phones: the bottom sheet covers the lower half of the screen, so bring the map
 * to the top of the screen; its centre (where the point is) then stays in view above the sheet.
 */
function mapToTop(map: L.Map) {
  if (!isPhone()) return;
  const el = map.getContainer();
  if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
}

function FlyTo({ fly }: { fly: FlyTarget | null }) {
  const map = useMap();
  const id = fly?.id;
  useEffect(() => {
    if (!fly) return;
    try {
      const target = L.latLng(fly.lat, fly.lon);
      const zoom = Math.min(fly.zoom, map.getMaxZoom());
      // The map is bounded to its view; widen the bounds so a place outside them can still be shown.
      const raw = map.options.maxBounds;
      const mb = raw ? (raw instanceof L.LatLngBounds ? L.latLngBounds(raw.getSouthWest(), raw.getNorthEast()) : L.latLngBounds(raw)) : null;
      if (mb && !mb.contains(target)) map.setMaxBounds(mb.extend(target).pad(0.05));
      // Centre so the point lands in the part of the map the card leaves clear.
      const centre = map.unproject(map.project(target, zoom).subtract(clearOffset(map)), zoom);
      mapToTop(map);
      if (prefersReducedMotion()) map.setView(centre, zoom, { animate: false });
      else map.flyTo(centre, zoom, { duration: 1.0, easeLinearity: 0.25 });
    } catch {
      // A map without a size yet: nothing to fly.
    }
    // Fly once per target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, map]);
  return null;
}

/** A popup closing this close (ms) to a click's preclick was closed by that click. */
const DISMISS_MS = 50;

function ClickToDrop({ onMapClick }: { onMapClick: (lat: number, lon: number) => void }) {
  // A click that only dismissed a gauge card is not a pin. Leaflet closes the popup on the click's
  // preclick (before or after ours), so the close and the preclick land within a few ms of each other.
  // A card closed by hovering away happens on its own, well before any click, and doesn't count.
  const closedAt = useRef(-1e9);
  const preclickAt = useRef(-2e9);
  const map = useMapEvents({
    popupclose: () => {
      closedAt.current = performance.now();
    },
    preclick: () => {
      preclickAt.current = performance.now();
    },
    click: (e) => {
      if (Math.abs(closedAt.current - preclickAt.current) < DISMISS_MS) return;
      if (!dropsPin(e.originalEvent?.target ?? null)) return;
      onMapClick(e.latlng.lat, e.latlng.lng);
      // Keep the pin clear of the card that is about to open.
      const p = e.containerPoint;
      const size = map.getSize();
      const animate = !prefersReducedMotion();
      if (isPhone()) {
        mapToTop(map);
        map.panTo(e.latlng, { animate });
      } else if (size.x > PANEL_PX + 240 && p.x < PANEL_PX + 24) {
        map.panBy([p.x - (PANEL_PX + 60), 0], { animate });
      }
    },
  });
  return null;
}

export type ExploreLayerProps = {
  zones: FeatureCollection | null;
  showZones: boolean;
  pin: { id: number; lat: number; lon: number } | null;
  fly: FlyTarget | null;
  onMapClick: (lat: number, lon: number) => void;
  panelOpen?: boolean;
};

export function ExploreLayer({ zones, showZones, pin, fly, onMapClick }: ExploreLayerProps) {
  return (
    <>
      {zones && showZones && (
        <ZonesBoundary>
          <ZonesLayer zones={zones} />
        </ZonesBoundary>
      )}
      <ClickToDrop onMapClick={onMapClick} />
      <FlyTo fly={fly} />
      {pin && <DropPin key={pin.id} pin={pin} />}
    </>
  );
}
