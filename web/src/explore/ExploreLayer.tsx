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
import { mercatorUnit } from "./mercator";
import { buildZoneIndex, drawZoneTile, zoneAt, type BandPaint, type Zone, type ZoneIndex } from "./zoneTiles";

export { mercatorUnit };

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
  // The zones are drawn on a canvas in their own pane (map perf): a click on it is a click on a zone.
  if (target.closest(`.leaflet-${ZONES_PANE}-pane`)) return true;
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
  fastProjection(layer);
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

/**
 * Faster re-projection for the zones (map perf). After every zoom Leaflet re-projects each of the
 * ~190k zone vertices from lat/lon (a log and a sine each, plus several objects per point). The
 * Web Mercator part never changes, so it is computed once per ring; a zoom then only scales it.
 * Same arithmetic as L.CRS.EPSG3857.latLngToPoint and the same rounding, so the pixels match.
 */
const unitRings = new WeakMap<L.LatLng[], Float64Array>();
function unitRing(ring: L.LatLng[]): Float64Array {
  let u = unitRings.get(ring);
  if (!u) {
    u = new Float64Array(ring.length * 2);
    for (let i = 0; i < ring.length; i++) {
      const [x, y] = mercatorUnit(ring[i].lat, ring[i].lng);
      u[2 * i] = x;
      u[2 * i + 1] = y;
    }
    unitRings.set(ring, u);
  }
  return u;
}
type Projecting = { _map: L.Map; _projectLatlngs: (latlngs: unknown[], result: L.Point[][], bounds: L.Bounds) => void };
function projectLatlngsFast(this: Projecting, latlngs: unknown[], result: L.Point[][], bounds: L.Bounds) {
  if (latlngs.length > 0 && latlngs[0] instanceof L.LatLng) {
    const map = this._map;
    const scale = map.options.crs!.scale(map.getZoom());
    const o = map.getPixelOrigin();
    const u = unitRing(latlngs as L.LatLng[]);
    const ring: L.Point[] = new Array(latlngs.length);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; // prettier-ignore
    for (let i = 0; i < latlngs.length; i++) {
      const x = Math.round(scale * u[2 * i]) - o.x;
      const y = Math.round(scale * u[2 * i + 1]) - o.y;
      ring[i] = new L.Point(x, y);
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    result.push(ring);
    if (latlngs.length > 0) bounds.extend(new L.Point(x0, y0)).extend(new L.Point(x1, y1));
  } else for (const l of latlngs) projectLatlngsFast.call(this, l as unknown[], result, bounds);
}
function fastProjection(layer: L.Layer) {
  const p = layer as unknown as Projecting;
  const leaflets = p._projectLatlngs;
  if (typeof leaflets !== "function") return;
  // Only for the default Web Mercator map, which is what the formula above is.
  p._projectLatlngs = function (this: Projecting, latlngs, result, bounds) {
    if (this._map.options.crs === L.CRS.EPSG3857) projectLatlngsFast.call(this, latlngs, result, bounds);
    else leaflets.call(this, latlngs, result, bounds);
  };
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

const canDrawCanvas = () => L.Browser.canvas && !(typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent));

/** One zones pane, below the rivers and spot rings. */
function useZonesPane(): boolean {
  const map = useMap();
  const [ready, setReady] = useState(() => !!map.getPane(ZONES_PANE));
  useEffect(() => {
    if (!map.getPane(ZONES_PANE)) {
      const pane = map.createPane(ZONES_PANE);
      pane.style.zIndex = String(ZONES_Z);
    }
    setReady(true);
  }, [map]);
  return ready;
}

/** rgba() from "#rrggbb" and an opacity. */
function rgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
const PAINT = new Map<string, BandPaint>(
  ZONE_BANDS.map((b) => {
    const st = zoneStyle(b);
    return [b, { fill: rgba(st.fillColor!, st.fillOpacity!), stroke: rgba(st.color!, st.opacity!) }];
  }),
);
const paintFor = (band: string) => PAINT.get(band) ?? null;

/** Tiles waiting to be drawn, drawn a few per frame (about 8 ms) so a zoom or pan never freezes. */
type Job = { canvas: HTMLCanvasElement; x: number; y: number; z: number; done: () => void };
const FRAME_BUDGET_MS = 8;

/** Built once per data set, even when the layer is hidden and shown again. */
const indexes = new WeakMap<FeatureCollection, ZoneIndex>();
function indexOnce(fc: FeatureCollection): ZoneIndex {
  let ix = indexes.get(fc);
  if (!ix) {
    ix = buildZoneIndex(fc);
    indexes.set(fc, ix);
  }
  return ix;
}

/**
 * The zones as cached canvas tiles with level of detail (zoneTiles.ts), the way a web map
 * draws streets: drawn once per tile and zoom level, then only moved and scaled while you
 * zoom and pan. Hover highlights the zone under the pointer and shows its tooltip.
 */
function ZoneTiles({ zones }: { zones: FeatureCollection }) {
  const map = useMap();
  useEffect(() => {
    const index = indexOnce(zones);
    const queue: Job[] = [];
    let frame = 0;
    const work = () => {
      frame = 0;
      const t0 = performance.now();
      while (queue.length && performance.now() - t0 < FRAME_BUDGET_MS) {
        const job = queue.shift()!;
        if (!job.canvas.isConnected) continue; // pruned before it was drawn
        const ctx = job.canvas.getContext("2d");
        if (ctx) {
          const k = job.canvas.width / 256;
          ctx.setTransform(k, 0, 0, k, 0, 0);
          drawZoneTile(ctx, index, job.x, job.y, job.z, 256, paintFor);
        }
        job.done();
      }
      if (queue.length) frame = requestAnimationFrame(work);
    };
    const Tiles = L.GridLayer.extend({
      createTile(coords: L.Coords, done: L.DoneCallback) {
        const canvas = document.createElement("canvas");
        const k = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = canvas.height = 256 * k;
        queue.push({ canvas, x: coords.x, y: coords.y, z: coords.z, done: () => done(undefined, canvas) });
        if (!frame) frame = requestAnimationFrame(work);
        return canvas;
      },
    });
    // updateWhenZooming false: during a zoom the drawn tiles are scaled; new ones come after it.
    const layer: L.GridLayer = new (Tiles as unknown as new (o: L.GridLayerOptions) => L.GridLayer)({ pane: ZONES_PANE, updateWhenZooming: false, keepBuffer: 4, className: "fc-x-zone-tiles" });
    layer.addTo(map);

    // Hover: the zone under the pointer (one lookup per frame), outlined, with its tooltip.
    let outline: L.Polygon | null = null;
    let current: Zone | null = null;
    const tip = L.tooltip({ sticky: true, direction: "top", offset: [0, -10], className: "fc-x-zone-tip", opacity: 1 });
    let pending: L.LeafletMouseEvent | null = null;
    let hoverFrame = 0;
    const clear = () => {
      current = null;
      outline?.remove();
      outline = null;
      map.closeTooltip(tip);
    };
    const hover = () => {
      hoverFrame = 0;
      const e = pending;
      pending = null;
      if (!e || moving) return;
      const t = e.originalEvent?.target ?? null;
      if (!dropsPin(t)) return clear(); // over a gauge, a spot ring, a card or a control
      const [ux, uy] = mercatorUnit(e.latlng.lat, e.latlng.lng);
      const z = zoneAt(index, ux, uy);
      if (!z) return clear();
      if (z !== current) {
        current = z;
        outline?.remove();
        outline = L.polygon(z.latlngs, { ...zoneStyle(z.band, true), interactive: false }).addTo(map);
        tip.setContent(zoneLabel(z.band));
      }
      tip.setLatLng(e.latlng);
      if (!map.hasLayer(tip)) map.openTooltip(tip);
    };
    // No hover while the map moves: a drag that crosses zone edges would build a new outline
    // (thousands of points for the floodplain zones) mid-pan and stall it.
    let moving = false;
    const onMoveStart = () => {
      moving = true;
      clear();
    };
    const onMoveEnd = () => {
      moving = false;
    };
    const onMove = (e: L.LeafletMouseEvent) => {
      if (moving || (map as L.Map & { dragging: { moving(): boolean } }).dragging?.moving?.()) return;
      pending = e;
      if (!hoverFrame) hoverFrame = requestAnimationFrame(hover);
    };
    const onOut = () => clear();
    map.on("mousemove", onMove);
    map.on("mouseout", onOut);
    map.on("zoomstart movestart dragstart", onMoveStart);
    map.on("moveend dragend", onMoveEnd);
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(hoverFrame);
      queue.length = 0;
      map.off("mousemove", onMove);
      map.off("mouseout", onOut);
      map.off("zoomstart movestart dragstart", onMoveStart);
      map.off("moveend dragend", onMoveEnd);
      clear();
      layer.remove();
    };
  }, [map, zones]);
  return null;
}

const ZonesLayer = memo(function ZonesLayer({ zones }: { zones: FeatureCollection }) {
  const paneReady = useZonesPane();
  const parts = useMemo(() => explodedOnce(zones), [zones]);
  // A new key per data set: react-leaflet's GeoJSON reads its data only once.
  const key = useMemo(() => `zones-${parts.features.length}-${Math.random().toString(36).slice(2, 7)}`, [parts]);
  if (!paneReady) return null;
  // Browsers: cached tiles with level of detail. The test DOM (jsdom) has no 2D canvas: SVG there.
  if (canDrawCanvas()) return <ZoneTiles zones={zones} />;
  return <GeoJSON key={key} data={parts} pane={ZONES_PANE} style={zoneFeatureStyle} onEachFeature={onEachZone} />;
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
