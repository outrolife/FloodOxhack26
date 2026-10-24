// The five spot clocks on the BaseMap, each pinned to its real coordinates
// (spots.json). Rendered inside the react-leaflet map: each clock is a React
// portal into an empty Leaflet marker, so it pans and zooms with the map.
// Clocks that would overlap are nudged apart (layout.ts) with a thin leader
// line back to a dot on the true spot.
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import L from "leaflet";
import { Marker, useMap, useMapEvents } from "react-leaflet";
import type { Spot } from "../../contracts";
import { SpotClock } from "../../ui/SpotClock";
import { kitState, type SpotClockInfo } from "./logic";
import { spreadApart, type Pt } from "./layout";

// Footprint of a "md" clock with its two text lines, plus a small gap.
const BOX_W = 150;
const BOX_H = 178;

const ICON = L.divIcon({ className: "now-clock-marker", html: "", iconSize: [0, 0], iconAnchor: [0, 0] });

function PortalMarker({ position, z, children }: { position: [number, number]; z: number; children: ReactNode }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const attach = useCallback((m: L.Marker | null) => {
    const e = m?.getElement() ?? null;
    if (e) L.DomEvent.disableClickPropagation(e); // clicks on a clock don't pan or zoom the map
    setEl(e);
  }, []);
  return (
    <Marker
      position={position}
      icon={ICON}
      interactive={false}
      keyboard={false}
      zIndexOffset={z}
      ref={attach}
      eventHandlers={{ add: (e) => attach(e.target as L.Marker) }}
    >
      {el && createPortal(children, el)}
    </Marker>
  );
}

export function ClockLayer({
  spots,
  clocks,
  selected,
  onSelect,
}: {
  spots: Spot[];
  clocks: SpotClockInfo[];
  selected: string | null;
  onSelect: (key: string) => void;
}) {
  const map = useMap();
  const [zoom, setZoom] = useState(() => map.getZoom());
  const [size, setSize] = useState(() => map.getSize().x);
  useMapEvents({ zoomend: () => setZoom(map.getZoom()), resize: () => setSize(map.getSize().x) });
  useEffect(() => setZoom(map.getZoom()), [map]);

  // Pixel offsets so no two clocks overlap at this zoom (relative positions don't change with panning).
  const offsets = useMemo<Pt[]>(() => {
    const pts = spots.map((s) => map.project([s.lat, s.lon], zoom));
    return spreadApart(pts.map((p) => ({ x: p.x, y: p.y })), BOX_W, BOX_H);
    // `size` is a dependency so a resized map re-lays out once Leaflet has settled.
  }, [map, spots, zoom, size]);

  return (
    <>
      {spots.map((s, i) => {
        const c = clocks.find((x) => x.spot === s.key);
        if (!c) return null;
        const { x: dx, y: dy } = offsets[i] ?? { x: 0, y: 0 };
        const nudged = Math.hypot(dx, dy) > 4;
        const isSel = selected === s.key;
        return (
          <PortalMarker key={s.key} position={[s.lat, s.lon]} z={isSel ? 1000 : 0}>
            <div className="now-clock-anchor">
              {nudged && (
                <svg className="now-clock-leader" aria-hidden="true" focusable="false">
                  <line x1={0} y1={0} x2={dx} y2={dy} />
                </svg>
              )}
              <span className="now-clock-pin" aria-hidden="true" />
              <div className="now-clock-box" style={{ transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))` }}>
                <SpotClock
                  label={c.name}
                  prob={c.p}
                  countdownH={c.countdownH}
                  state={kitState(c)}
                  size="md"
                  selected={isSel}
                  onClick={() => onSelect(s.key)}
                />
                {/* The kit shows the countdown when there is one; otherwise say "—" or why there is no forecast. */}
                {(c.kind !== "forecast" || c.countdownH == null) && (
                  <div className="now-clock-status">{c.kind === "forecast" ? `likely flood time: ${c.countdown}` : c.status}</div>
                )}
              </div>
            </div>
          </PortalMarker>
        );
      })}
    </>
  );
}
