// Every gauge on the flow map as a small level-gauge icon (#118 browser
// feedback): discreet by default, a compact card on hover (desktop) or tap.
// Names show only when zoomed in close. Rules and wording: gauges.ts.
import { useEffect, useMemo, useRef } from "react";
import L from "leaflet";
import { Marker, Popup, useMap, useMapEvents } from "react-leaflet";
import type { Station } from "../contracts";
import type { Point } from "../components/shared/series";
import { gaugeName } from "../lib/plain";
import { GAUGE_LOOK, gaugeCard, gaugeIconSvg, sparkPath, type GaugeCardData, type GaugeLook } from "./gauges";

/** Gauge names appear from this zoom (city streets); below it only the icons. */
export const NAMES_FROM_ZOOM = 14;

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const iconCache = new Map<string, L.DivIcon>();
type Emphasis = "normal" | "emph" | "dim";
function iconFor(look: GaugeLook, name: string, emphasis: Emphasis, role: Station["role"]): L.DivIcon {
  const k = `${look}|${emphasis}|${name}|${role}`;
  let icon = iconCache.get(k);
  if (!icon) {
    icon = L.divIcon({
      className: `rc-gauge-icon rc-gauge-${look}${emphasis === "normal" ? "" : ` ${emphasis}`}${role === "upstream" ? " rc-gauge-upstream" : ""}`,
      html: `${gaugeIconSvg(look, emphasis === "emph")}<span class="rc-gauge-name">${escapeHtml(name)}</span>`,
      iconSize: [14, 18],
      iconAnchor: [7, 9],
      popupAnchor: [0, -10],
    });
    iconCache.set(k, icon);
  }
  return icon;
}

/** Adds .rc-near to the map container when zoomed in enough to show gauge names. */
function ZoomClass() {
  const map = useMap();
  const set = () => {
    map.getContainer().classList.toggle("rc-near", map.getZoom() >= NAMES_FROM_ZOOM);
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
}: {
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
      icon={iconFor(look, name, emphasis, station.role)}
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
}: {
  stations: Station[];
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
  return (
    <>
      <ZoomClass />
      {stations
        .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon))
        .map((s) => (
          <GaugeMarker
            key={s.key}
            station={s}
            look={looks[s.key] ?? "none"}
            series={observed?.[s.key]}
            t={t}
            lagH={lagH}
            reaches={reaches[s.key] ?? null}
            emphasis={!emphasised ? "normal" : emphasised.has(s.key) ? "emph" : "dim"}
          />
        ))}
    </>
  );
}
