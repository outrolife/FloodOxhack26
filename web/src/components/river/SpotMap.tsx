// Leaflet map of the five trouble spots, coloured by pFlood at 24 h. Each tier
// also has its own shape (● low, ▲ elevated, ■ high, ○ no probability), so the
// map reads without colour. Spot markers are keyboard-focusable (Tab, Enter).
// OSM tiles are the app's only network dependency: if they fail, the map keeps
// working on a plain background and says so.
import { type ReactNode, useEffect, useRef, useState } from "react";
import L from "leaflet";
import { CircleMarker, MapContainer, Marker, TileLayer, Tooltip } from "react-leaflet";
import type { Forecast, Spot, Station } from "../../contracts";
import { LEVEL_STYLE, type Level, pFloodAt, pct, spotLevel } from "../shared/forecast";
import { LevelGlyph, glyphSvg } from "../shared/LevelGlyph";
import { gaugeName } from "../../lib/plain";

const OXFORD: [number, number] = [51.7585, -1.2655];

const ICONS = new Map<string, L.DivIcon>();
/** Cached divIcon per tier and selection state (sized for a projector). */
function spotIcon(level: Level, selected: boolean): L.DivIcon {
  const key = `${level}-${selected}`;
  let icon = ICONS.get(key);
  if (!icon) {
    const size = selected ? 38 : 30;
    icon = L.divIcon({
      className: "spot-marker",
      html: glyphSvg(level, size, { halo: true, selected }),
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
      tooltipAnchor: [0, -size / 2],
    });
    ICONS.set(key, icon);
  }
  return icon;
}

/** A spot marker whose element carries an accessible name for screen readers. */
function SpotMarker({
  position,
  icon,
  label,
  selected,
  onSelect,
  children,
}: {
  position: [number, number];
  icon: L.DivIcon;
  label: string;
  selected: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  const ref = useRef<L.Marker>(null);
  useEffect(() => {
    const el = ref.current?.getElement();
    if (!el) return;
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", label);
    el.setAttribute("aria-pressed", String(selected));
  }, [label, selected, icon]);
  return (
    <Marker
      ref={ref}
      position={position}
      icon={icon}
      keyboard
      zIndexOffset={selected ? 1000 : 0}
      eventHandlers={{ click: onSelect }}
    >
      {children}
    </Marker>
  );
}

export function SpotMap({
  spots,
  stations,
  forecast,
  selected,
  onSelect,
  children,
}: {
  spots: Spot[];
  stations: Station[];
  forecast: Forecast | null;
  selected: string | null;
  onSelect: (key: string) => void;
  /** Extra map layers, e.g. the S1 official flood-risk layers. */
  children?: ReactNode;
}) {
  const [tilesFailed, setTilesFailed] = useState(!navigator.onLine);

  return (
    <div>
      <div className="map-wrap">
        {/* Fit all five spots with padding (quarter-zoom steps) so none is clipped at the edge. */}
        <MapContainer
          {...(spots.length > 1
            ? { bounds: L.latLngBounds(spots.map((s) => [s.lat, s.lon] as [number, number])), boundsOptions: { padding: [36, 36] as [number, number] } }
            : { center: OXFORD, zoom: 13 })}
          zoomSnap={0.25}
          scrollWheelZoom={false}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            eventHandlers={{ tileerror: () => setTilesFailed(true), tileload: () => setTilesFailed(false) }}
          />
          {stations
            .filter((s) => s.lat > 51.7 && s.lat < 51.82 && s.lon > -1.36 && s.lon < -1.18)
            .map((s) => (
              <CircleMarker
                key={`g-${s.key}`}
                center={[s.lat, s.lon]}
                radius={4}
                pathOptions={{ color: "#52514e", weight: 1, fillColor: "#fff", fillOpacity: 1 }}
              >
                <Tooltip>River gauge: {gaugeName(s.name)}</Tooltip>
              </CircleMarker>
            ))}
          {spots.map((spot) => {
            const lvl = spotLevel(forecast, spot);
            const sf = forecast?.spots.find((s) => s.spot === spot.key);
            const p = pFloodAt(sf, 24);
            const isSel = spot.key === selected;
            const status =
              lvl === "unknown" ? LEVEL_STYLE.unknown.label : `${pct(p)} chance of flooding in the next 24 hours`;
            return (
              <SpotMarker
                key={spot.key}
                position={[spot.lat, spot.lon]}
                icon={spotIcon(lvl, isSel)}
                label={`${spot.name}: ${status}. Select to show details.`}
                selected={isSel}
                onSelect={() => onSelect(spot.key)}
              >
                <Tooltip direction="top">
                  <strong>{spot.name}</strong>
                  <br />
                  {status}
                </Tooltip>
              </SpotMarker>
            );
          })}
          {children}
        </MapContainer>
        {tilesFailed && <div className="map-offline">Map tiles unavailable offline; spots and gauges still shown.</div>}
      </div>
      <div className="legend" role="group" aria-label="Legend">
        <span className="muted">Colour and shape = chance of flooding in the next 24 hours:</span>
        {(["low", "elevated", "high", "unknown"] as const).map((l) => (
          <span key={l} className="legend-item">
            <LevelGlyph level={l} size={16} />
            {LEVEL_STYLE[l].label}
          </span>
        ))}
        <span>
          <span className="swatch" style={{ background: "#fff", border: "1px solid #52514e" }} />
          River gauge
        </span>
      </div>
    </div>
  );
}
