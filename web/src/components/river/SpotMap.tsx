// Leaflet map of the five trouble spots, coloured by pFlood at 24 h.
// OSM tiles are the app's only network dependency: if they fail, the map keeps
// working on a plain background and says so.
import { type ReactNode, useState } from "react";
import { CircleMarker, MapContainer, TileLayer, Tooltip } from "react-leaflet";
import type { Forecast, Spot, Station } from "../../contracts";
import { LEVEL_STYLE, pFloodAt, pct, spotLevel } from "../shared/forecast";

const OXFORD: [number, number] = [51.7585, -1.2655];

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
        <MapContainer center={OXFORD} zoom={13} scrollWheelZoom={false}>
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
                <Tooltip>Gauge: {s.name}</Tooltip>
              </CircleMarker>
            ))}
          {spots.map((spot) => {
            const lvl = spotLevel(forecast, spot);
            const sf = forecast?.spots.find((s) => s.spot === spot.key);
            const p = pFloodAt(sf, 24);
            const isSel = spot.key === selected;
            return (
              <CircleMarker
                key={spot.key}
                center={[spot.lat, spot.lon]}
                radius={isSel ? 14 : 11}
                pathOptions={{
                  color: isSel ? "#0b0b0b" : "#ffffff",
                  weight: isSel ? 3 : 2,
                  fillColor: LEVEL_STYLE[lvl].colour,
                  fillOpacity: 0.9,
                }}
                eventHandlers={{ click: () => onSelect(spot.key) }}
              >
                <Tooltip direction="top" offset={[0, -10]}>
                  <strong>{spot.name}</strong>
                  <br />
                  {lvl === "unknown" ? LEVEL_STYLE.unknown.label : `${pct(p)} chance of flooding within 24 h`}
                </Tooltip>
              </CircleMarker>
            );
          })}
          {children}
        </MapContainer>
        {tilesFailed && <div className="map-offline">Map tiles unavailable offline; spots and gauges still shown.</div>}
      </div>
      <div className="legend" aria-label="Legend">
        <span className="muted">Spot colour = chance of flooding within 24 h:</span>
        {(["low", "elevated", "high", "unknown"] as const).map((l) => (
          <span key={l}>
            <span className="swatch" style={{ background: LEVEL_STYLE[l].colour }} />
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
