// The hero map (#118 one screen): Oxford with its rivers drawn as water that
// rises and flows, the upstream chain as schematic links whose dashes move at
// the real travel time, and the five spot clocks (kit MapClocks, shared
// placement rule). Everything is read from the data at time t.
import { useMemo } from "react";
import type { FeatureCollection } from "geojson";
import type { Path, PathOptions } from "leaflet";
import { CircleMarker, GeoJSON, Polyline, Tooltip } from "react-leaflet";
import type { Forecast, Spot, Station, TravelPair } from "../contracts";
import type { Point } from "../components/shared/series";
import { BaseMap, useBaseMap } from "../ui/BaseMap";
import { MapClocks } from "../ui/MapClocks";
import { clocksFor } from "../ui/clockData";
import { gaugeName } from "../lib/plain";
import { FLOW_LOOK, bucketFor, chainLinks, flowBounds, levelFraction, linesByGauge, type Bucket } from "./flow";

/** Upstream gauges further north than this (degrees) above the spots stay off the map; their link runs in from the edge. */
const NORTH_LIMIT = 0.06;
const NO_READING = "#b7c3cc";

const baseWeight = (kind: unknown) => (kind === "river" ? 4 : 2.2);

function Water({ fc, bucket, known }: { fc: FeatureCollection; bucket: Bucket; known: boolean }) {
  const look = FLOW_LOOK[bucket];
  const solid = useMemo(
    () => (f?: { properties?: { kind?: unknown } | null }): PathOptions => ({
      color: known ? look.colour : NO_READING,
      weight: baseWeight(f?.properties?.kind) * (known ? look.widthX : 1),
      opacity: 1,
      lineCap: "round",
    }),
    [known, look],
  );
  const dashes = useMemo(
    () => (f?: { properties?: { kind?: unknown } | null }): PathOptions => ({
      color: "#ffffff",
      weight: Math.max(1, baseWeight(f?.properties?.kind) * look.widthX * 0.35),
      opacity: 0.75,
      dashArray: "5 13",
      lineCap: "round",
      className: `rc-flow rc-flow-b${bucket}`,
    }),
    [look, bucket],
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
}: {
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
}) {
  const base = useBaseMap();
  const byKey = useMemo(() => new Map(stations.map((s) => [s.key, s])), [stations]);
  const links = useMemo(() => chainLinks(stations, pairs), [stations, pairs]);

  const maxSpotLat = Math.max(...spots.map((s) => s.lat));
  const shownUpstream = stations.filter((s) => s.role === "upstream" && s.lat <= maxSpotLat + NORTH_LIMIT);
  const bounds = useMemo(
    () => flowBounds([...spots, ...shownUpstream]),
    // Keyed on the gauge lists, not the arrays, so a re-render does not re-fit the map.
    [spots.map((s) => s.key).join(), shownUpstream.map((s) => s.key).join()],
  );

  // Oxford gauges that exist in this data set (or are known to be offline): each river line takes its nearest.
  const oxford = stations.filter((s) => s.role !== "upstream" && ((observed?.[s.key]?.length ?? 0) > 0 || stale.includes(s.key)));
  const oxfordKey = oxford.map((s) => s.key).join();
  const groups = useMemo(() => {
    if (base.status !== "ready") return {};
    const lines: FeatureCollection = {
      type: "FeatureCollection",
      features: [...(base.byKind.river?.features ?? []), ...(base.byKind.stream?.features ?? [])],
    };
    return linesByGauge(lines, oxford);
    // Keyed on the gauge list: regroup only when the set of gauges changes.
  }, [base, oxfordKey]);

  const bucketOf = (key: string): { bucket: Bucket; known: boolean } => {
    const s = byKey.get(key);
    const v = levels[key];
    if (!s || v == null || stale.includes(key)) return { bucket: 0, known: false };
    return { bucket: bucketFor(levelFraction(v, s.amber, s.threshold)), known: true };
  };

  const clocks = clocksFor(forecast, spots).map((c) => ({
    ...c,
    size: (c.key === selected ? "md" : "sm") as "md" | "sm",
    selected: c.key === selected,
    onClick: spots.find((s) => s.key === c.key)?.mode === "probability" ? () => onSelect(c.key) : undefined,
  }));

  return (
    <BaseMap bounds={bounds} className="rc-flowmap">
      {Object.entries(groups).map(([g, fc]) => {
        const { bucket, known } = bucketOf(g);
        return <Water key={`${g}|${oxfordKey}`} fc={fc} bucket={bucket} known={known} />;
      })}

      {links.map((l) => {
        const up = byKey.get(l.up);
        const down = byKey.get(l.down);
        if (!up || !down) return null;
        const { bucket, known } = bucketOf(l.up);
        const look = FLOW_LOOK[bucket];
        const pts: [number, number][] = [
          [up.lat, up.lon],
          [down.lat, down.lon],
        ];
        const hours = `≈ ${Math.round(l.tHalfH)} h to ${gaugeName(down.name).replace(/ \(.*\)$/, "")}`;
        return (
          <Polyline key={`${l.up}-solid`} positions={pts} interactive={false} pathOptions={{ color: known ? look.colour : NO_READING, weight: 3 * look.widthX, opacity: l.lowConfidence ? 0.5 : 0.9, dashArray: l.lowConfidence ? "2 6" : undefined }}>
            <Tooltip permanent direction="center" className="rc-link-label" opacity={1}>
              <span className={l.lowConfidence ? "low" : undefined}>
                {hours}
                {l.lowConfidence ? ` (only ${l.n} past rises)` : ""}
              </span>
            </Tooltip>
          </Polyline>
        );
      })}
      {links.map((l) => {
        const up = byKey.get(l.up);
        const down = byKey.get(l.down);
        if (!up || !down || !bucketOf(l.up).known) return null;
        return (
          <Polyline
            key={`${l.up}-dash`}
            positions={[
              [up.lat, up.lon],
              [down.lat, down.lon],
            ]}
            interactive={false}
            pathOptions={{ color: "#ffffff", weight: 2, opacity: 0.8, dashArray: "5 13", className: "rc-flow rc-flow-link" }}
            eventHandlers={{
              // The dash speed is the real travel time: set once on the SVG path.
              add: (e) => {
                const el = (e.target as Path & { getElement?: () => Element | undefined }).getElement?.() as SVGElement | undefined;
                if (el) el.style.animationDuration = `${l.seconds}s`;
              },
            }}
          />
        );
      })}
      {shownUpstream.map((s) => {
        const { bucket, known } = bucketOf(s.key);
        return (
          <CircleMarker
            key={s.key}
            center={[s.lat, s.lon]}
            radius={6}
            interactive={false}
            pathOptions={{ color: "#0b0b0b", weight: 1.5, fillColor: known ? FLOW_LOOK[bucket].colour : "#ffffff", fillOpacity: 1 }}
          >
            <Tooltip permanent direction="top" offset={[0, -6]} className="rc-gauge-label" opacity={1}>
              {gaugeName(s.name).replace(/ \(.*\)$/, "")}
            </Tooltip>
          </CircleMarker>
        );
      })}

      <MapClocks clocks={clocks} />
    </BaseMap>
  );
}

/** The map's key, in words (no colour-only legend). */
export function FlowKey() {
  const order: Bucket[] = [0, 2, 4];
  return (
    <div className="rc-flowkey" aria-label="How to read the rivers">
      {order.map((b) => (
        <span key={b}>
          <i className="rc-flowkey-sw" style={{ borderTopColor: FLOW_LOOK[b].colour, borderTopWidth: 2 + FLOW_LOOK[b].widthX * 1.5 }} />{" "}
          {FLOW_LOOK[b].words}
        </span>
      ))}
      <span>
        <i className="rc-flowkey-sw" style={{ borderTopColor: NO_READING }} /> no reading
      </span>
      <span>Dashes flow downstream; upstream links move at the real travel time.</span>
    </div>
  );
}
