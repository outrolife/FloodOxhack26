// The hero map (#118 one screen): Oxford with its rivers drawn as water that
// rises and flows, the upstream chain as schematic links whose dashes move at
// the real travel time (pulses; words on hover), and small identical spot
// markers (SpotDots, shared placement rule). Everything is read from the data at time t.
import { Fragment, useEffect, useMemo } from "react";
import type { FeatureCollection } from "geojson";
import type { Path, PathOptions } from "leaflet";
import { GeoJSON, Polyline, Tooltip, useMap, useMapEvents } from "react-leaflet";
import type { Forecast, Spot, Station, TravelPair } from "../contracts";
import type { Point } from "../components/shared/series";
import { BaseMap, useBaseMap, type FitPadding } from "../ui/BaseMap";
import { clocksFor } from "../ui/clockData";
import { gaugeName } from "../lib/plain";
import { FLOW_LOOK, PULSE_DASH, PULSE_PATH_LENGTH, bucketFor, chainLinks, flowBounds, levelFraction, linesByGauge, linkWords, riverWalk, type Bucket, type ChainLink } from "./flow";
import { type MapView } from "./flowgl";
import { spotDots, withData, type DotBadge } from "./markers";
import { SpotDots } from "./SpotDots";
import { GaugeLayer } from "./GaugeLayer";
import { gaugeIconSvg, lookFor, type GaugeLook } from "./gauges";
import { useData } from "../data";

/**
 * Keep the spots and gauges clear of the panels drawn over the map: the badge
 * (top left), the Scoreboard (top right on wide screens, along the bottom on
 * narrow ones) and the key (bottom left). Matches shell.css.
 */
function fitPadding(mapView: MapView): FitPadding {
  // [x, y] px. Left: clear of the zoom buttons. Right (wide screens, Oxford): clear of the Scoreboard card.
  // Phones put the Scoreboard and the key under the map, so nothing else covers it.
  const wide = typeof window === "undefined" || window.innerWidth > 700;
  if (wide) return { topLeft: [56, 20], bottomRight: [mapView === "catchment" ? 24 : 360, 20] };
  return { topLeft: [48, 16], bottomRight: [16, 16] };
}

/** "Islip (Cherwell)" → "Islip". */
const shortGauge = (name: string) => gaugeName(name).replace(/ \(.*\)$/, "");

/** A gauge this close (degrees of latitude; 1.6× in longitude) to a spot is an Oxford gauge whose river lines are drawn. */
const NEAR_DEG = 0.04;
const NO_READING = "#b7c3cc";

const baseWeight = (kind: unknown) => (kind === "river" ? 4 : 2.2);

function FlowMotion() {
  const map = useMap();
  useMapEvents({
    movestart: () => map.getContainer().classList.add("rc-map-moving"),
    moveend: () => map.getContainer().classList.remove("rc-map-moving"),
  });
  useEffect(() => () => map.getContainer().classList.remove("rc-map-moving"), [map]);
  return null;
}

/** How a link is drawn: as usual, bright on the selected spot's river walk, or dimmed off it. */
type LinkMode = "normal" | "walk" | "dim";

function Water({ fc, bucket, known, dim = false }: { fc: FeatureCollection; bucket: Bucket; known: boolean; dim?: boolean }) {
  const look = FLOW_LOOK[bucket];
  const solid = useMemo(
    () => (f?: { properties?: { kind?: unknown } | null }): PathOptions => ({
      color: known ? look.colour : NO_READING,
      weight: baseWeight(f?.properties?.kind) * (known ? look.widthX : 1),
      opacity: dim ? 0.35 : 1,
      lineCap: "round",
    }),
    [known, look, dim],
  );
  const dashes = useMemo(
    () => (f?: { properties?: { kind?: unknown } | null }): PathOptions => ({
      color: "#ffffff",
      weight: Math.max(1, baseWeight(f?.properties?.kind) * look.widthX * 0.35),
      opacity: dim ? 0.3 : 0.75,
      dashArray: "5 13",
      lineCap: "round",
      className: `rc-flow rc-flow-b${bucket}`,
    }),
    [look, bucket, dim],
  );
  return (
    <>
      <GeoJSON data={fc} style={solid} interactive={false} />
      {/* Re-mounted when the bucket changes: Leaflet sets a path's class (the dash speed) only once. */}
      {known && <GeoJSON key={`dash-${bucket}`} data={fc} style={dashes} interactive={false} />}
    </>
  );
}

export function FlowMap({
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
}: {
  /** The moment shown (epoch ms), for the gauge cards. */
  t?: number | null;
  mapView?: MapView;
  onMapViewChange?: (view: MapView) => void;
  /** Readings are known this many hours after they happen (replays: 1 h). */
  lagH?: number;
  spots: Spot[];
  stations: Station[];
  pairs: TravelPair[];
  /** Level per gauge at the current time (null: no reading). */
  levels: Record<string, number | null>;
  /** The forecast in force at the current time (clocks). */
  forecast: Forecast | null;
  /** The data set's readings, to know which gauges exist in it. */
  observed: Record<string, Point[]> | undefined;
  stale: string[];
  selected: string;
  onSelect: (spot: string) => void;
  /** Replays: per spot, the FloodClock vs EA badge and the warning pulse at the playhead. */
  marks?: Record<string, { badge: DotBadge | null; pulse: boolean }>;
}) {
  const base = useBaseMap();
  const catchmentData = useData<FeatureCollection>(mapView === "catchment" ? "geo/catchment-rivers.geojson" : null);
  const byKey = useMemo(() => new Map(stations.map((s) => [s.key, s])), [stations]);
  const links = useMemo(() => chainLinks(stations, pairs), [stations, pairs]);

  // The whole catchment: the spots and every gauge in stations.json (upstream, live_only, targets),
  // so water from further out is on the map. Oxford until they load (flowBounds' fallback).
  const bounds = useMemo(
    () => (mapView === "oxford" ? flowBounds(spots, 0.025) : flowBounds([...spots, ...stations], 0.02)),
    // Keyed on the lists, not the arrays, so a re-render does not re-fit the map.
    [mapView, spots.map((s) => s.key).join(), stations.map((s) => s.key).join()],
  );

  // Oxford gauges (near a spot, where the basemap draws rivers) that exist in this data set or are
  // known to be offline: each river line takes its nearest. Far catchment gauges have no lines here.
  const nearOxford = (s: Station) => spots.some((p) => Math.abs(p.lat - s.lat) < NEAR_DEG && Math.abs(p.lon - s.lon) < NEAR_DEG * 1.6);
  const oxford = stations.filter(
    (s) => s.role !== "upstream" && nearOxford(s) && ((observed?.[s.key]?.length ?? 0) > 0 || stale.includes(s.key)),
  );
  const dataGauges = stations.filter((s) => (observed?.[s.key]?.length ?? 0) > 0 || stale.includes(s.key));
  const visibleGauges = mapView === "catchment" ? dataGauges : oxford;
  const visibleGaugeKey = visibleGauges.map((s) => s.key).join();
  const groups = useMemo(() => {
    if (base.status !== "ready") return {};
    const lines: FeatureCollection = {
      type: "FeatureCollection",
      features:
        mapView === "catchment" && catchmentData.status === "ready"
          ? catchmentData.data.features
          : [...(base.byKind.river?.features ?? []), ...(base.byKind.stream?.features ?? [])],
    };
    return linesByGauge(lines, visibleGauges);
    // Keyed on the gauge list and view: regroup only when the source changes.
  }, [base, catchmentData, mapView, visibleGaugeKey]);

  const bucketOf = (key: string): { bucket: Bucket; known: boolean } => {
    const s = byKey.get(key);
    const v = levels[key];
    if (!s || v == null || stale.includes(key)) return { bucket: 0, known: false };
    return { bucket: bucketFor(levelFraction(v, s.amber, s.threshold)), known: true };
  };

  const dots = withData(spotDots(clocksFor(forecast, spots), forecast, spots), forecast).map((d) => ({ ...d, ...marks?.[d.key] }));

  // Gauge icons: each gauge's own level vs its usual high, and where its water goes next.
  const looks: Record<string, GaugeLook> = {};
  for (const s of stations) looks[s.key] = bucketOf(s.key).known ? lookFor(bucketOf(s.key).bucket) : "none";
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

  // The river walk (#118): the selected spot's upstream path is drawn bright, the rest dimmed.
  const spotGauge = spots.find((s) => s.key === selected)?.gauge ?? null;
  const walk = useMemo(() => (spotGauge ? riverWalk(spotGauge, pairs) : { gauges: new Set<string>(), links: [] }), [spotGauge, pairs]);
  const walking = walk.links.length > 0;
  const shownLinks: { link: ChainLink; mode: LinkMode }[] = walking
    ? [
        ...links.filter((l) => !walk.gauges.has(l.up)).map((link) => ({ link, mode: "dim" as const })),
        ...walk.links.map((link) => ({ link, mode: "walk" as const })),
      ]
    : links.map((link) => ({ link, mode: "normal" as const }));

  /** One link: the line (words on hover) and, while its upstream gauge has a reading, the pulses. */
  const linkLayers = (l: ChainLink, mode: LinkMode) => {
    const up = byKey.get(l.up);
    const down = byKey.get(l.down);
    if (!up || !down) return null;
    const { bucket, known } = bucketOf(l.up);
    const look = FLOW_LOOK[bucket];
    const pts: [number, number][] = [
      [up.lat, up.lon],
      [down.lat, down.lon],
    ];
    // Low confidence (few past rises): dashed and grey. Otherwise the water's own colour.
    const colour = l.lowConfidence || !known ? NO_READING : look.colour;
    const k = `${l.up}>${l.down}|${mode}`;
    return (
      <Fragment key={k}>
        <Polyline
          positions={pts}
          pathOptions={{
            color: colour,
            weight: (mode === "walk" ? 3.5 : 2.5) * look.widthX,
            // Translucent so the map shows through (#152 feedback).
            opacity: mode === "dim" ? 0.2 : mode === "walk" ? 0.7 : 0.45,
            dashArray: l.lowConfidence ? "3 6" : undefined,
          }}
        >
          {/* No permanent label: the words appear on hover. */}
          <Tooltip sticky direction="top" className="rc-link-label" opacity={1}>
            {linkWords(l, shortGauge(up.name), shortGauge(down.name))}
          </Tooltip>
        </Polyline>
        {known && mode !== "dim" && (
          <Polyline
            positions={pts}
            interactive={false}
            pathOptions={{
              color: "#ffffff",
              weight: mode === "walk" ? 7 : 6,
              opacity: l.lowConfidence ? 0.4 : 0.7,
              lineCap: "round",
              dashArray: PULSE_DASH,
              className: "rc-pulse",
            }}
            eventHandlers={{
              // Pulses travel the whole link (upstream to Oxford) in l.seconds, scaled from the real
              // travel time. pathLength makes the dash units a share of the link at any zoom.
              add: (e) => {
                const el = (e.target as Path & { getElement?: () => Element | undefined }).getElement?.() as SVGElement | undefined;
                if (!el) return;
                el.setAttribute("pathLength", String(PULSE_PATH_LENGTH));
                el.style.animationDuration = `${l.seconds}s`;
              },
            }}
          />
        )}
      </Fragment>
    );
  };

  return (
    <BaseMap
      bounds={bounds}
      className={`rc-flowmap${walking ? " rc-walking" : ""}${mapView === "catchment" ? " rc-catchment" : ""}`}
      fitPadding={fitPadding(mapView)}
    >
      <FlowMotion />
      {Object.entries(groups).map(([g, fc]) => {
        const { bucket, known } = bucketOf(g);
        return <Water key={`${g}|${visibleGaugeKey}`} fc={fc} bucket={bucket} known={known} dim={walking && !walk.gauges.has(g)} />;
      })}

      {shownLinks.map(({ link, mode }) => linkLayers(link, mode))}
      <GaugeLayer
        stations={stations}
        looks={looks}
        observed={observed}
        t={t}
        lagH={lagH}
        reaches={reaches}
        emphasised={walking ? walk.gauges : undefined}
        avoid={dots.map((d) => [d.lat, d.lon] as [number, number])}
      />

      <SpotDots dots={dots} selected={selected} onSelect={onSelect} />
    </BaseMap>
  );
}

/** The map's key, in words (no colour-only legend). */
export function FlowKey() {
  const order: Bucket[] = [0, 2, 4];
  return (
    <div className="rc-flowkey" role="note" aria-label="How to read the rivers">
      <span className="rc-field-label">Key</span>
      {order.map((b) => (
        <span key={b}>
          <i className="rc-flowkey-sw" style={{ borderTopColor: FLOW_LOOK[b].colour, borderTopWidth: 2 + FLOW_LOOK[b].widthX * 1.5 }} />{" "}
          {FLOW_LOOK[b].words}
        </span>
      ))}
      <span>
        <i className="rc-flowkey-sw" style={{ borderTopColor: NO_READING }} /> no reading
      </span>
      <span>Pulses move at the real travel time from upstream</span>
      <span>
        <i className="rc-flowkey-gauge" aria-hidden="true" dangerouslySetInnerHTML={{ __html: gaugeIconSvg("above") }} /> gauge: hover or tap
      </span>
      <span>
        <i className="rc-flowkey-ring" aria-hidden="true" /> Ring = chance of flooding in the next 3 days
      </span>
    </div>
  );
}
