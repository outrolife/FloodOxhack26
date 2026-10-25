// Every gauge on the flow map as a small level-gauge icon (#118 browser
// feedback): discreet by default, a compact card on hover (desktop) or tap.
// Names show only when zoomed in close. Rules and wording: gauges.ts.
import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import { Marker, Popup, useMap, useMapEvents } from "react-leaflet";
import type { Station } from "../contracts";
import type { Point } from "../components/shared/series";
import { gaugeName } from "../lib/plain";
import { GAUGE_LOOK, gaugeCard, gaugeIconSvg, sparkPath, type GaugeCardData, type GaugeLook } from "./gauges";

/** Gauge names appear from this zoom (city streets); below it only the icons. */
export const NAMES_FROM_ZOOM = 14;
/** Below this zoom (the catchment view) spot rings and gauge icons are drawn smaller (.rc-far). */
export const FAR_BELOW_ZOOM = 11.5;

type Pt = { x: number; y: number };
type Box = { x0: number; y0: number; x1: number; y1: number };
const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
const ROLE_RANK: Record<string, number> = { upstream: 0, target: 1, live_only: 2 };

/**
 * Which gauge icons and names to leave out at this zoom so nothing piles up
 * (#152 feedback: the catchment view overlapped badly). Gauges are placed in
 * priority order (the selected river walk, then upstream, target, live-only).
 * An icon is dropped if it would sit on a spot ring or on an icon already
 * placed (upstream gauges, where the flow links end, give way only to rings). A name is
 * dropped if it would cross a spot (ring and label), an icon or another name.
 */
export function declutter(
  gauges: { key: string; role: string; name: string; p: Pt; emph: boolean }[],
  spots: Pt[],
  far: boolean,
): { hidden: Set<string>; nameless: Set<string> } {
  const k = far ? 0.8 : 1; // icon scale under .rc-far
  const iw = 14 * k;
  const ih = 18 * k;
  const spotR = far ? 13 : 18;
  const rings: Box[] = spots.map((s) => ({ x0: s.x - spotR, y0: s.y - spotR, x1: s.x + spotR, y1: s.y + spotR }));
  // A spot's name sits on either side of its ring: keep a band clear on both.
  const spotNames: Box[] = spots.map((s) => ({ x0: s.x - spotR - 95, y0: s.y - 8, x1: s.x + spotR + 95, y1: s.y + 8 }));
  const order = [...gauges].sort(
    (a, b) => Number(b.emph) - Number(a.emph) || (ROLE_RANK[a.role] ?? 3) - (ROLE_RANK[b.role] ?? 3) || a.key.localeCompare(b.key),
  );
  const icons: Box[] = [];
  const names: Box[] = [];
  const hidden = new Set<string>();
  const nameless = new Set<string>();
  for (const g of order) {
    const box = { x0: g.p.x - iw / 2, y0: g.p.y - ih / 2, x1: g.p.x + iw / 2, y1: g.p.y + ih / 2 };
    const core = { x0: box.x0 + 2, y0: box.y0 + 2, x1: box.x1 - 2, y1: box.y1 - 2 };
    // Upstream gauges stay unless a spot ring covers them (the links end at them); the rest also give way to icons placed first.
    const onRing = rings.some((r) => overlaps(core, r));
    if (onRing || (g.role !== "upstream" && icons.some((r) => overlaps(core, r)))) {
      hidden.add(g.key);
      nameless.add(g.key);
      continue;
    }
    icons.push(box);
    const label = { x0: box.x1 + 2, y0: g.p.y - 7, x1: box.x1 + 4 + g.name.length * (far ? 5.6 : 6.3), y1: g.p.y + 7 };
    const blocked = [...rings, ...spotNames, ...icons.slice(0, -1), ...names].some((r) => overlaps(label, r));
    if (blocked) nameless.add(g.key);
    else names.push(label);
  }
  return { hidden, nameless };
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const iconCache = new Map<string, L.DivIcon>();
type Emphasis = "normal" | "emph" | "dim";
function iconFor(look: GaugeLook, name: string, emphasis: Emphasis, role: Station["role"], hidden = false, nameless = false): L.DivIcon {
  const k = `${look}|${emphasis}|${name}|${role}|${hidden}|${nameless}`;
  let icon = iconCache.get(k);
  if (!icon) {
    icon = L.divIcon({
      className: `rc-gauge-icon rc-gauge-${look}${emphasis === "normal" ? "" : ` ${emphasis}`}${role === "upstream" ? " rc-gauge-upstream" : ""}${hidden ? " rc-gauge-hidden" : ""}${nameless ? " rc-gauge-nameless" : ""}`,
      html: `${gaugeIconSvg(look, emphasis === "emph")}<span class="rc-gauge-name">${escapeHtml(name)}</span>`,
      iconSize: [14, 18],
      iconAnchor: [7, 9],
      popupAnchor: [0, -10],
    });
    iconCache.set(k, icon);
  }
  return icon;
}

/** Adds .rc-near (gauge names shown) and .rc-far (smaller markers) to the map container by zoom. */
function ZoomClass() {
  const map = useMap();
  const set = () => {
    map.getContainer().classList.toggle("rc-near", map.getZoom() >= NAMES_FROM_ZOOM);
    map.getContainer().classList.toggle("rc-far", map.getZoom() < FAR_BELOW_ZOOM);
  };
  useMapEvents({ zoomend: set });
  useEffect(set, [map]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

export function GaugeCard({ card, usualHigh }: { card: GaugeCardData; usualHigh: number }) {
  const W = 168;
  const H = 34;
  const { d, usualY } = sparkPath(card.spark, W, H, usualHigh);
  return (
    <div className="rc-gauge-card">
      <div className="rc-gauge-card-title">
        <strong>{card.title}</strong> <span className="rc-gauge-card-river">{card.river}</span>
      </div>
      {card.vsUsual && <div>{card.vsUsual}</div>}
      {card.vsFlood && <div>{card.vsFlood}</div>}
      {card.trend && <div>{card.trend}</div>}
      {d && (
        <svg className="rc-gauge-spark" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Level over the last 3 days">
          {usualY != null && <line x1={0} x2={W} y1={usualY} y2={usualY} stroke="#898781" strokeDasharray="3 3" strokeWidth={1} />}
          <path d={d} fill="none" stroke="#184f95" strokeWidth={1.75} />
        </svg>
      )}
      {d && <div className="rc-gauge-card-small">Last 3 days{usualY != null ? " · dashed: usual high" : ""}</div>}
      {card.flow && <div className="rc-gauge-card-flow">{card.flow}</div>}
      {card.last && <div className="rc-gauge-card-small">{card.last}</div>}
    </div>
  );
}

function GaugeMarker({
  station,
  look,
  series,
  t,
  lagH,
  reaches,
  emphasis,
  hidden,
  nameless,
}: {
  hidden: boolean;
  nameless: boolean;
  station: Station;
  look: GaugeLook;
  series: readonly Point[] | undefined;
  t: number | null;
  lagH: number;
  reaches: { name: string; hours: number } | null;
  emphasis: Emphasis;
}) {
  const name = gaugeName(station.name).replace(/ \(.*\)$/, "");
  const pinned = useRef(false);
  const card = useMemo(() => gaugeCard(station, series, t, lagH, reaches), [station, series, t, lagH, reaches]);
  const words = `${name} gauge: ${GAUGE_LOOK[look].words}`;
  return (
    <Marker
      position={[station.lat, station.lon]}
      icon={iconFor(look, name, emphasis, station.role, hidden, nameless)}
      interactive={!hidden}
      title={words}
      alt={words}
      zIndexOffset={-500}
      eventHandlers={{
        // Hover opens the card, leaving closes it; a click or tap keeps it open until closed.
        mouseover: (e) => (e.target as L.Marker).openPopup(),
        mouseout: (e) => {
          if (!pinned.current) (e.target as L.Marker).closePopup();
        },
        click: (e) => {
          pinned.current = true;
          (e.target as L.Marker).openPopup();
        },
        popupclose: () => {
          pinned.current = false;
        },
      }}
    >
      <Popup autoPan={false} closeButton className="rc-gauge-popup" minWidth={180} maxWidth={240}>
        <GaugeCard card={card} usualHigh={station.amber} />
      </Popup>
    </Marker>
  );
}

export function GaugeLayer({
  stations,
  looks,
  observed,
  t,
  lagH = 0,
  reaches,
  emphasised,
  avoid = [],
}: {
  stations: Station[];
  /** Spot positions: gauge icons and names keep clear of their rings and labels. */
  avoid?: [number, number][];
  /** Look per gauge at the moment shown. */
  looks: Record<string, GaugeLook>;
  observed: Record<string, Point[]> | undefined;
  t: number | null;
  lagH?: number;
  /** Per upstream gauge: where its water goes next and how long it takes. */
  reaches: Record<string, { name: string; hours: number }>;
  /** The selected spot's river walk: these gauges drawn bolder, the others dimmed. */
  emphasised?: ReadonlySet<string>;
}) {
  const map = useMap();
  const [view, setView] = useState(0);
  useMapEvents({ zoomend: () => setView((v) => v + 1), resize: () => setView((v) => v + 1) });
  const shown = stations.filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon));
  const layout = useMemo(() => {
    const size = map.getSize();
    if (size.x === 0 || size.y === 0) return { hidden: new Set<string>(), nameless: new Set<string>() };
    const pt = (lat: number, lon: number) => {
      const q = map.latLngToContainerPoint([lat, lon]);
      return { x: q.x, y: q.y };
    };
    return declutter(
      shown.map((s) => ({
        key: s.key,
        role: s.role,
        name: gaugeName(s.name).replace(/ \(.*\)$/, ""),
        p: pt(s.lat, s.lon),
        emph: emphasised?.has(s.key) ?? false,
      })),
      avoid.map(([lat, lon]) => pt(lat, lon)),
      map.getZoom() < FAR_BELOW_ZOOM,
    );
    // Screen positions change only with zoom and size (a pan moves everything together).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, view, shown.map((s) => s.key).join(), avoid.flat().join(), emphasised ? [...emphasised].join() : ""]);
  return (
    <>
      <ZoomClass />
      {shown.map((s) => (
          <GaugeMarker
            key={s.key}
            station={s}
            look={looks[s.key] ?? "none"}
            series={observed?.[s.key]}
            t={t}
            lagH={lagH}
            reaches={reaches[s.key] ?? null}
            emphasis={!emphasised ? "normal" : emphasised.has(s.key) ? "emph" : "dim"}
            hidden={layout.hidden.has(s.key)}
            nameless={layout.nameless.has(s.key)}
          />
        ))}
    </>
  );
}
