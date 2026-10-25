// Map v3 (#152): the hero flow map on MapLibre GL, a drop-in for FlowMap
// (same props), loaded as its own chunk.
//
// - Basemap: the offline Protomaps PMTiles archive (/tiles/oxon.pmtiles, local
//   fonts), muted so the water stands out. Without it (a fresh clone): a plain
//   background with Oxford's streets from oxford-base.geojson. Never the internet.
// - Rivers: catchment-rivers.geojson as blue lines, each coloured and widened
//   by its own river's nearest gauge, from that gauge's usual high to its flood
//   level (levels are never compared across gauges).
// - Flow: deck.gl TripsLayer pulses streaming downstream along the real river
//   course of each upstream link, at the real travel time; hover for words.
//   A link without a routed course is hidden: no straight lines anywhere.
// - Gauges: the small level-gauge icons and cards; spots: the small rings, only
//   for spots with data in this view (the others are listed in Show the working).
// - The selected spot's river walk is bright, the rest dimmed.
// Rules: flowgl.ts (pure, tested). Without WebGL, or if the map fails, the
// Leaflet FlowMap is drawn instead.
import "maplibre-gl/dist/maplibre-gl.css";
import "./glmap.css";
import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { addProtocol } from "maplibre-gl";
import type { Map as MapLibreMap, StyleSpecification } from "maplibre-gl";
import { Protocol } from "pmtiles";
import MapGL, { AttributionControl, Layer, Marker, NavigationControl, Popup, Source, useControl, type MapRef } from "react-map-gl/maplibre";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { PathLayer } from "@deck.gl/layers";
import { TripsLayer } from "@deck.gl/geo-layers";
import type { PickingInfo } from "@deck.gl/core";
import type { Feature, FeatureCollection, Position } from "geojson";
import type { Station } from "../contracts";
import { loadData } from "../data";
import { gaugeName } from "../lib/plain";
import { useBaseMap } from "../ui/BaseMap";
import { clocksFor } from "../ui/clockData";
import { spreadApart } from "../ui/placement";
import { FlowMap } from "./FlowMap";
import { GaugeCard } from "./GaugeLayer";
import { DotBody } from "./SpotDots";
import { FLOW_LOOK, bucketFor, chainLinks, flowBounds, levelFraction, linkWords, riverWalk, type Bucket, type ChainLink } from "./flow";
import {
  GLYPHS_PATH,
  PATHS_FILE,
  PULSE_PERIOD_S,
  RIVERS_FILE,
  SPRITE_PATH,
  TILES_PATH,
  TRAIL_S,
  assignGauges,
  buildNetwork,
  contextCourses,
  contextWords,
  copiesFor,
  copyTimestamps,
  coursesFrom,
  flowPathFor,
  linkKey,
  padBounds,
  probeBasemap,
  routedCourses,
  toLngLat,
  tripClock,
  type BasemapProbe,
  type FlowPath,
  type MapView,
} from "./flowgl";
import { BASEMAP_SOURCE, RIVER_LAYOUT, basemapLayers, baseStyle, fallbackLayers, riverPaint } from "./glstyle";
import { GAUGE_LOOK, gaugeCard, gaugeIconSvg, lookFor, type GaugeLook } from "./gauges";
import { setHiddenSpots } from "./hiddenSpots";
import { DOT_BOX, spotDots, withData } from "./markers";

export type FlowMapProps = Parameters<typeof FlowMap>[0];
export type FlowMapGLProps = FlowMapProps;

const BASE = import.meta.env.BASE_URL;
const NO_READING = "#b7c3cc";
/** River lines no gauge speaks for: plain water. */
const PLAIN_WATER = "#9fc0dc";
/** Paths with no measured travel time: faint grey-blue, never animated. */
const CONTEXT = "#7d93a6";
/** Gauge names appear from this zoom (MapLibre zooms run one below Leaflet's). */
const NAMES_FROM_ZOOM = 13;

/** "Islip (Cherwell)" → "Islip". */
const shortGauge = (name: string) => gaugeName(name).replace(/ \(.*\)$/, "");
/** "No live river reading…" → "no live river reading…", to sit in brackets after a name. */
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

// ---------------------------------------------------------------- one-time setup

let protocolAdded = false;
function ensurePmtiles() {
  if (protocolAdded) return;
  addProtocol("pmtiles", new Protocol().tile);
  protocolAdded = true;
}

let probeOnce: Promise<BasemapProbe> | null = null;
const probe = () => (probeOnce ??= probeBasemap(BASE));

/** Can this browser draw WebGL at all? (No: the Leaflet map is drawn instead.) */
function webglOk(): boolean {
  try {
    const c = document.createElement("canvas");
    const gl = (c.getContext("webgl2") ?? c.getContext("webgl")) as WebGLRenderingContext | null;
    return gl != null;
  } catch {
    return false;
  }
}

/** A GeoJSON file from web/public/data: undefined while loading, null when missing. */
function useGeo(file: string): FeatureCollection | null | undefined {
  const [fc, setFc] = useState<FeatureCollection | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    loadData<FeatureCollection>(file).then(
      ({ value }) => alive && setFc(Array.isArray(value?.features) ? value : null),
      () => alive && setFc(null),
    );
    return () => {
      alive = false;
    };
  }, [file]);
  return fc;
}

// ---------------------------------------------------------------- colours and expressions

type RGBA = [number, number, number, number];
function rgba(hex: string, alpha = 1): RGBA {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), Math.round(alpha * 255)];
}

/** Room (px) kept clear of the panels over the map when fitting (matches shell.css). */
function fitPadding(mapView: MapView) {
  const wide = typeof window === "undefined" || window.innerWidth > 700;
  if (wide) return { top: 56, left: 24, right: mapView === "catchment" ? 24 : 390, bottom: 24 };
  return { top: 56, left: 16, right: 16, bottom: 150 };
}

// ---------------------------------------------------------------- the map

/** A failure inside the GL map draws the Leaflet map instead of a blank hero. */
class GLBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export default function FlowMapGL(props: FlowMapGLProps) {
  const [gl] = useState(webglOk);
  if (!gl) return <FlowMap {...props} />;
  return (
    <GLBoundary fallback={<FlowMap {...props} />}>
      <FlowMapGLInner {...props} />
    </GLBoundary>
  );
}

type LinkMode = "normal" | "walk" | "dim";
/** A course drawn on the map (hover for its words): a timed link, or a context path. */
type CourseDatum = { path: Position[]; words: string; course: RGBA; courseW: number };
type FlowDatum = FlowPath & CourseDatum & { mode: LinkMode; pulse: RGBA | null; pulseW: number };
type TripDatum = { path: Position[]; timestamps: number[]; colour: RGBA; width: number };

function FlowMapGLInner({
  spots,
  stations,
  pairs,
  levels,
  forecast,
  observed,
  stale,
  selected,
  onSelect,
  marks,
  t = null,
  lagH = 0,
  mapView = "oxford",
}: FlowMapGLProps) {
  const mapRef = useRef<MapRef | null>(null);
  const [basemap, setBasemap] = useState<BasemapProbe | null>(null);
  useEffect(() => {
    let alive = true;
    probe().then((p) => alive && setBasemap(p));
    return () => {
      alive = false;
    };
  }, []);
  const riversFc = useGeo(RIVERS_FILE);
  const coursesFc = useGeo(PATHS_FILE);
  const base = useBaseMap();

  const byKey = useMemo(() => new Map(stations.map((s) => [s.key, s])), [stations]);
  const links = useMemo(() => chainLinks(stations, pairs), [stations, pairs]);

  // ------------------------------------------------ rivers
  // The catchment rivers, else (until that file exists) Oxford's rivers and streams from oxford-base.
  const riverLines: Feature[] = useMemo(() => {
    if (riversFc) return riversFc.features;
    if (riversFc === null && base.status === "ready") return [...(base.byKind.river?.features ?? []), ...(base.byKind.stream?.features ?? [])];
    return [];
  }, [riversFc, base]);

  // Gauges that exist in this data set or are known to be offline: each river line takes its own river's nearest.
  const dataGauges = stations.filter((s) => (observed?.[s.key]?.length ?? 0) > 0 || stale.includes(s.key));
  const dataKey = dataGauges.map((s) => s.key).join();
  const rivers = useMemo(
    () => assignGauges(riverLines, dataGauges),
    // Keyed on the gauge list: regroup only when the set of gauges changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [riverLines, dataKey],
  );

  const bucketOf = (key: string): { bucket: Bucket; known: boolean } => {
    const s = byKey.get(key);
    const v = levels[key];
    if (!s || v == null || stale.includes(key)) return { bucket: 0, known: false };
    return { bucket: bucketFor(levelFraction(v, s.amber, s.threshold)), known: true };
  };

  // ------------------------------------------------ the river walk
  const spotGauge = spots.find((s) => s.key === selected)?.gauge ?? null;
  const walk = useMemo(() => (spotGauge ? riverWalk(spotGauge, pairs) : { gauges: new Set<string>(), links: [] as ChainLink[] }), [spotGauge, pairs]);
  const walking = walk.links.length > 0;

  // ------------------------------------------------ courses (where the water flows)
  const courses = useMemo(() => {
    if (coursesFc) return coursesFrom(coursesFc);
    // No routed paths file yet: route each measured link along the river lines we have, or leave it out.
    if (coursesFc === null && riverLines.length > 0) return routedCourses(buildNetwork(riverLines), pairs, stations);
    return new Map<string, { path: Position[] }>();
  }, [coursesFc, riverLines, pairs, stations]);

  const shownLinks: { link: ChainLink; mode: LinkMode }[] = walking
    ? [
        ...links.filter((l) => !walk.gauges.has(l.up)).map((link) => ({ link, mode: "dim" as const })),
        ...walk.links.map((link) => ({ link, mode: "walk" as const })),
      ]
    : links.map((link) => ({ link, mode: "normal" as const }));

  // Paths with no measured travel time: faint, still context (one per upstream gauge; on the walk, those into
  // the selected spot's gauge). Never animated and never given an hour count.
  const measured = useMemo(() => new Set(pairs.map((p) => linkKey(p))), [pairs]);
  const context = useMemo(() => {
    if (!walking || !spotGauge) return contextCourses(courses, measured).map((c) => ({ ...c, onWalk: false }));
    const into = new Map([...courses].filter(([k]) => k.endsWith(`>${spotGauge}`)));
    const onWalk = contextCourses(into, measured);
    const ups = new Set(onWalk.map((c) => c.up));
    return [
      ...contextCourses(courses, measured)
        .filter((c) => !ups.has(c.up))
        .map((c) => ({ ...c, onWalk: false })),
      ...onWalk.map((c) => ({ ...c, onWalk: true })),
    ];
  }, [courses, measured, walking, spotGauge]);

  // One signature for everything the flow layers draw, so deck.gl recomputes only when it changes.
  const flowSig =
    shownLinks
      .map(({ link, mode }) => {
        const b = bucketOf(link.up);
        return `${linkKey(link)}:${mode}:${b.known ? b.bucket : "-"}`;
      })
      .join("|") +
    "#" +
    context.map((c) => `${c.up}>${c.down}:${c.onWalk ? 1 : 0}`).join("|");
  const courseSig = [...courses.keys()].join();

  const { flows, trips, copies } = useMemo(() => {
    const flows: CourseDatum[] = [];
    for (const c of context) {
      const up = byKey.get(c.up);
      const down = byKey.get(c.down);
      if (!up || !down) continue;
      const spot = spots.find((p) => p.gauge === c.down);
      flows.push({
        path: c.path,
        words: contextWords(shortGauge(up.name), spot ? spot.name.split(" / ")[0].trim() : shortGauge(down.name)),
        course: rgba(CONTEXT, walking && !c.onWalk ? 0.18 : 0.4),
        courseW: c.onWalk ? 2.5 : 1.8,
      });
    }
    for (const { link, mode } of shownLinks) {
      const fp = flowPathFor(link, courses.get(linkKey(link)));
      const up = byKey.get(link.up);
      const down = byKey.get(link.down);
      if (!fp || !up || !down) continue;
      const { bucket, known } = bucketOf(link.up);
      const look = FLOW_LOOK[bucket];
      const dim = mode === "dim";
      const c = fp.confidence;
      // The course: the water's colour, faint; brighter on the walk. The pulses: a deeper blue as the level rises.
      const course = known ? rgba(look.colour, dim ? 0.25 : 0.35 + 0.35 * c) : rgba(NO_READING, dim ? 0.3 : 0.6);
      const pulseHex = FLOW_LOOK[Math.min(4, bucket + 2) as Bucket].colour;
      const timed: FlowDatum = {
        ...fp,
        mode,
        words: linkWords(fp, shortGauge(up.name), shortGauge(down.name)),
        course,
        courseW: (mode === "walk" ? 3.5 : 2.5) * (dim ? 0.8 : 1),
        pulse: known && !dim ? rgba(pulseHex, 0.45 + 0.55 * c) : null,
        pulseW: (mode === "walk" ? 6 : 4.5) * look.widthX ** 0.5 * (0.7 + 0.3 * c),
      };
      flows.push(timed);
    }
    const timed = flows.filter((f): f is FlowDatum => "tripS" in f);
    const maxS = Math.max(0, ...timed.map((f) => f.tripS));
    const copies = copiesFor(maxS);
    const trips: TripDatum[] = [];
    for (const f of timed) {
      if (!f.pulse) continue;
      for (let k = 0; k < copies; k++) trips.push({ path: f.path, timestamps: copyTimestamps(f.timestamps, k), colour: f.pulse, width: f.pulseW });
    }
    return { flows, trips, copies };
    // flowSig + courseSig stand for shownLinks, the context paths, the levels and the courses.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowSig, courseSig, byKey, spots]);

  // ------------------------------------------------ river paint (from the levels at the playhead)
  const colours: Record<string, string> = {};
  const widths: Record<string, number> = {};
  for (const s of dataGauges) {
    const { bucket, known } = bucketOf(s.key);
    colours[s.key] = known ? FLOW_LOOK[bucket].colour : NO_READING;
    widths[s.key] = known ? FLOW_LOOK[bucket].widthX : 1;
  }
  const paint = riverPaint({ colours, widths, plain: PLAIN_WATER, walk: walking ? [...walk.gauges] : [] });

  // ------------------------------------------------ gauges and spots
  const looks: Record<string, GaugeLook> = {};
  for (const s of stations) {
    const b = bucketOf(s.key);
    looks[s.key] = b.known ? lookFor(b.bucket) : "none";
  }
  const reaches = useMemo(() => {
    const out: Record<string, { name: string; hours: number }> = {};
    for (const l of links) {
      const spot = spots.find((p) => p.gauge === l.down);
      const down = byKey.get(l.down);
      const name = spot ? spot.name.split(" / ")[0].trim() : down ? shortGauge(down.name) : null;
      if (name) out[l.up] = { name, hours: l.tHalfH };
    }
    return out;
  }, [links, spots, byKey]);

  // Only spots with something to show (the shared rule, markers.withData); the rest are named in Show the working.
  const allDots = spotDots(clocksFor(forecast, spots), forecast, spots);
  const dots = withData(allDots, forecast).map((d) => ({ ...d, ...marks?.[d.key] }));
  const shownKeys = new Set(dots.map((d) => d.key));
  const hidden = allDots.filter((d) => !shownKeys.has(d.key)).map((d) => ({ key: d.key, name: d.label, why: lowerFirst(d.note ?? "no forecast here") }));
  const hiddenSig = hidden.map((h) => `${h.key}:${h.why}`).join("|");
  useEffect(
    () => setHiddenSpots(hidden),
    // hiddenSig stands for the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hiddenSig],
  );
  useEffect(() => () => setHiddenSpots([]), []);

  // ------------------------------------------------ view
  const [tick, setTick] = useState(0);
  const [moving, setMoving] = useState(false);
  const [zoom, setZoom] = useState(10);
  const cityBounds = useMemo(() => toLngLat(flowBounds(spots, 0.025)), [spots.map((s) => s.key).join()]);
  const catchmentBounds = useMemo(
    () => toLngLat(flowBounds([...spots, ...stations], 0.02)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [spots.map((s) => s.key).join(), stations.map((s) => s.key).join()],
  );
  const bounds = mapView === "oxford" ? cityBounds : catchmentBounds;
  const boundsKey = bounds.flat().join();
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !loaded) return;
    try {
      const padding = fitPadding(mapView);
      const camera = map.cameraForBounds(bounds, { padding });
      if (camera?.zoom != null) map.setMinZoom(Math.max(0, camera.zoom - 0.25));
      map.setMaxBounds(padBounds(bounds, 0.08));
      map.fitBounds(bounds, { padding, duration: 600, maxZoom: 16 });
    } catch {
      // Not laid out yet: the initial view stands.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boundsKey, loaded]);

  const layoutKey = dots.map((d) => `${d.key}:${d.lat},${d.lon}`).join("|");
  const offsets = useMemo(() => {
    const map = mapRef.current?.getMap();
    if (!map) return dots.map(() => ({ x: 0, y: 0 }));
    const el = map.getContainer();
    const pts = dots.map((d) => map.project([d.lon, d.lat]));
    return spreadApart(
      pts.map((p) => ({ x: p.x, y: p.y })),
      DOT_BOX,
      el.clientWidth > 0 && el.clientHeight > 0 ? { w: el.clientWidth, h: el.clientHeight } : undefined,
    );
    // `layoutKey` stands for the markers' geometry, `tick` for the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey, tick]);

  const onLoad = useCallback((e: { target: MapLibreMap }) => {
    const map = e.target;
    map.touchZoomRotate?.disableRotation?.();
    // Basemap icons we don't ship (no sprite): a blank image instead of a warning per icon.
    map.on("styleimagemissing", (ev: { id: string }) => {
      if (!map.hasImage(ev.id)) map.addImage(ev.id, { width: 1, height: 1, data: new Uint8Array(4) });
    });
    setZoom(map.getZoom());
    setLoaded(true);
    setTick((x) => x + 1);
  }, []);

  // ------------------------------------------------ style
  const style: StyleSpecification | null = useMemo(() => {
    if (!basemap) return null;
    if (basemap.tiles) ensurePmtiles();
    const origin = typeof location === "undefined" ? "" : location.origin;
    return baseStyle({
      tilesUrl: basemap.tiles ? `pmtiles://${origin}${BASE}${TILES_PATH}` : null,
      glyphsUrl: basemap.tiles && basemap.glyphs ? `${origin}${BASE}${GLYPHS_PATH}` : null,
      spriteUrl: basemap.tiles && basemap.sprite ? `${origin}${BASE}${SPRITE_PATH}` : null,
    });
  }, [basemap]);
  // Our water goes under the basemap's labels when there are any.
  const beforeId = useMemo(
    () => (basemap?.tiles && basemap.glyphs ? basemapLayers(BASEMAP_SOURCE, true).find((l) => l.type === "symbol")?.id : undefined),
    [basemap],
  );
  // The plain fallback: Oxford's streets, parks, water and rail from oxford-base (no rivers: ours are drawn on top).
  const fallbackFc: FeatureCollection | null = useMemo(() => {
    if (!basemap || basemap.tiles || base.status !== "ready") return null;
    const kinds = ["park", "water", "building", "minor_road", "road", "rail"] as const;
    return { type: "FeatureCollection", features: kinds.flatMap((k) => base.byKind[k]?.features ?? []) };
  }, [basemap, base]);

  const [hover, setHover] = useState<{ x: number; y: number; text: string } | null>(null);
  const onHover = useCallback((info: PickingInfo<CourseDatum>) => {
    setHover(info.object ? { x: info.x, y: info.y, text: info.object.words } : null);
  }, []);

  const [card, setCard] = useState<{ key: string; pinned: boolean } | null>(null);
  const cardStation = card ? byKey.get(card.key) : undefined;

  if (!style) return <div className={`ui-basemap rc-flowmap rc-gl${walking ? " rc-walking" : ""}`} aria-busy="true" />;

  const initialBounds = bounds;
  return (
    <div className={`ui-basemap rc-flowmap rc-gl${walking ? " rc-walking" : ""}${mapView === "catchment" ? " rc-catchment" : ""}${zoom >= NAMES_FROM_ZOOM ? " rc-near" : ""}`}>
      <MapGL
        ref={mapRef}
        mapStyle={style}
        initialViewState={{ bounds: initialBounds, fitBoundsOptions: { padding: fitPadding(mapView) } }}
        style={{ position: "absolute", inset: 0 }}
        maxZoom={16}
        cooperativeGestures
        dragRotate={false}
        pitchWithRotate={false}
        touchPitch={false}
        maxPitch={0}
        attributionControl={false}
        onLoad={onLoad}
        onMoveStart={() => setMoving(true)}
        onMoveEnd={() => {
          setMoving(false);
          setTick((x) => x + 1);
        }}
        onZoomEnd={(e) => setZoom(e.target.getZoom())}
        onError={(e) => console.warn("FloodClock map:", e.error?.message ?? e)}
      >
        <NavigationControl position="top-left" showCompass={false} />
        <AttributionControl
          position="bottom-right"
          compact
          customAttribution={basemap?.tiles ? undefined : 'Map data © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors (ODbL)'}
        />

        {fallbackFc && (
          <Source id="rc-base" type="geojson" data={fallbackFc}>
            {fallbackLayers("rc-base").map((l) => (
              <Layer key={l.id} {...l} />
            ))}
          </Source>
        )}

        <Source id="rc-rivers" type="geojson" data={rivers}>
          <Layer id="rc-river-casing" type="line" beforeId={beforeId} layout={RIVER_LAYOUT} paint={paint.casing} />
          <Layer id="rc-river" type="line" beforeId={beforeId} layout={RIVER_LAYOUT} paint={paint.river} />
        </Source>

        <DeckFlow flows={flows} trips={trips} copies={copies} sig={`${flowSig}#${courseSig}`} onHover={onHover} paused={moving} />

        {stations
          .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon))
          .map((s) => (
            <GaugeMarkerGL
              key={s.key}
              station={s}
              look={looks[s.key] ?? "none"}
              emphasis={!walking ? "normal" : walk.gauges.has(s.key) ? "emph" : "dim"}
              onHover={(on) => setCard((c) => (on ? (c?.pinned ? c : { key: s.key, pinned: false }) : c?.pinned ? c : null))}
              onPin={() => setCard({ key: s.key, pinned: true })}
            />
          ))}
        {cardStation && card && (
          <Popup
            longitude={cardStation.lon}
            latitude={cardStation.lat}
            anchor="bottom"
            offset={14}
            closeButton={card.pinned}
            closeOnClick={false}
            onClose={() => setCard(null)}
            className="rc-gauge-popup"
            maxWidth="240px"
          >
            <GaugeCard
              card={gaugeCard(cardStation, observed?.[cardStation.key], t, lagH, reaches[cardStation.key] ?? null)}
              usualHigh={cardStation.amber}
            />
          </Popup>
        )}

        {dots.map((d, i) => (
          <Marker key={d.key} longitude={d.lon} latitude={d.lat} anchor="center" style={{ zIndex: d.key === selected ? 3 : 2 }}>
            <DotBody dot={d} offset={offsets[i] ?? { x: 0, y: 0 }} selected={d.key === selected} onSelect={onSelect} />
          </Marker>
        ))}
      </MapGL>
      {hover && (
        <div className="rc-gl-tip" role="tooltip" style={{ left: hover.x, top: hover.y }}>
          {hover.text}
        </div>
      )}
      {/* A hint for developers only: judges just see the simple map. */}
      {import.meta.env.DEV && basemap && !basemap.tiles && <div className="rc-gl-note">Simple map: the offline basemap isn't installed (make fetch-data).</div>}
    </div>
  );
}

// ---------------------------------------------------------------- deck.gl flow

/**
 * The flow layers, redrawn every animation frame without re-rendering React:
 * each link's course (faint; hover for its words) and the pulses of water
 * streaming down it (TripsLayer, one shared clock; copies a period apart keep
 * the pulses coming). With reduced motion the pulses stand still.
 */
function DeckFlow({
  flows,
  trips,
  copies,
  sig,
  onHover,
  paused,
}: {
  flows: CourseDatum[];
  trips: TripDatum[];
  copies: number;
  sig: string;
  onHover: (info: PickingInfo<CourseDatum>) => void;
  paused: boolean;
}) {
  const overlay = useControl<MapboxOverlay>(() => new MapboxOverlay({ interleaved: false, pickingRadius: 6 }));
  const latest = useRef({ flows, trips, copies, sig, onHover });
  latest.current = { flows, trips, copies, sig, onHover };
  useEffect(() => {
    if (paused) return;
    const still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    const frame = (ms: number) => {
      const { flows, trips, copies, sig, onHover } = latest.current;
      const nowS = still ? PULSE_PERIOD_S * 0.6 : ms / 1000;
      overlay.setProps({
        layers: [
          new PathLayer<CourseDatum>({
            id: "rc-course",
            data: flows,
            getPath: (d) => d.path as [number, number][],
            getColor: (d) => d.course,
            getWidth: (d) => d.courseW,
            widthUnits: "pixels",
            capRounded: true,
            jointRounded: true,
            pickable: true,
            onHover,
            updateTriggers: { getColor: sig, getWidth: sig },
          }),
          new TripsLayer<TripDatum>({
            id: "rc-trips",
            data: trips,
            getPath: (d) => d.path as [number, number][],
            getTimestamps: (d) => d.timestamps,
            getColor: (d) => d.colour,
            getWidth: (d) => d.width,
            widthUnits: "pixels",
            capRounded: true,
            jointRounded: true,
            fadeTrail: true,
            trailLength: TRAIL_S,
            currentTime: tripClock(nowS, copies),
            updateTriggers: { getColor: sig, getWidth: sig, getTimestamps: sig },
          }),
        ],
      });
      raf = next(frame);
    };
    // Browsers have requestAnimationFrame; elsewhere (tests) a timer stands in.
    const hasRaf = typeof requestAnimationFrame === "function";
    const next = (f: (ms: number) => void) => (hasRaf ? requestAnimationFrame(f) : window.setTimeout(() => f(Date.now()), 100));
    raf = next(frame);
    return () => (hasRaf ? cancelAnimationFrame(raf) : window.clearTimeout(raf));
  }, [overlay, paused]);
  return null;
}

// ---------------------------------------------------------------- gauges

function GaugeMarkerGL({
  station,
  look,
  emphasis,
  onHover,
  onPin,
}: {
  station: Station;
  look: GaugeLook;
  emphasis: "normal" | "emph" | "dim";
  onHover: (on: boolean) => void;
  onPin: () => void;
}) {
  const name = shortGauge(station.name);
  const words = `${name} gauge: ${GAUGE_LOOK[look].words}`;
  const svg = useMemo(() => gaugeIconSvg(look, emphasis === "emph"), [look, emphasis]);
  return (
    <Marker longitude={station.lon} latitude={station.lat} anchor="center" style={{ zIndex: 1 }}>
      <button
        type="button"
        className={`rc-gauge-icon rc-gauge-${look}${emphasis === "normal" ? "" : ` ${emphasis}`}${station.role === "upstream" ? " rc-gauge-upstream" : ""}`}
        aria-label={words}
        title={words}
        onMouseEnter={() => onHover(true)}
        onMouseLeave={() => onHover(false)}
        onFocus={() => onHover(true)}
        onBlur={() => onHover(false)}
        onClick={(e) => {
          e.stopPropagation();
          onPin();
        }}
      >
        <span aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />
        <span className="rc-gauge-name">{name}</span>
      </button>
    </Marker>
  );
}
