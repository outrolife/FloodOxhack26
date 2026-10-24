// MapClocks (#118): the spot clocks on a <BaseMap>, for Now and Replay alike.
// Each clock is a React portal into an empty Leaflet marker at its spot, so it
// pans and zooms with the map. Clocks that would cover each other, or fall off
// the edge, are nudged by the one shared rule (placement.ts) and drawn with a
// thin leader line back to a dot on the true spot. Import directly
// ("../ui/MapClocks"): like BaseMap it needs Leaflet, which needs `window`.
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import L from "leaflet";
import { Marker, useMap, useMapEvents } from "react-leaflet";
import { SpotClock, type ClockState } from "./SpotClock";
import { CLOCK_BOX, NOTE_H, needsLeader, spreadApart, type Box } from "./placement";

export type MapClockItem = {
  key: string;
  lat: number;
  lon: number;
  label: string;
  prob: number | null;
  countdownH: number | null;
  state: ClockState;
  size?: "sm" | "md" | "lg";
  selected?: boolean;
  onClick?: () => void;
  /** One short line under the clock (e.g. why there is no forecast). */
  note?: ReactNode;
};

const ICON = L.divIcon({ className: "ui-mapclock-marker", html: "", iconSize: [0, 0], iconAnchor: [0, 0] });

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

const boxFor = (c: MapClockItem): Box => {
  const b = CLOCK_BOX[c.size ?? "md"];
  return c.note ? { w: b.w, h: b.h + NOTE_H } : b;
};

export function MapClocks({ clocks }: { clocks: MapClockItem[] }) {
  const map = useMap();
  // Re-lay out after every pan, zoom or resize (positions are in map-container pixels).
  const [view, setView] = useState(0);
  const bump = () => setView((v) => v + 1);
  useMapEvents({ moveend: bump, zoomend: bump, resize: bump });

  const layoutKey = clocks.map((c) => `${c.key}:${c.lat},${c.lon}:${c.size ?? "md"}:${c.note ? 1 : 0}`).join("|");
  const offsets = useMemo(() => {
    const size = map.getSize();
    const pts = clocks.map((c) => map.latLngToContainerPoint([c.lat, c.lon]));
    return spreadApart(
      pts.map((p) => ({ x: p.x, y: p.y })),
      clocks.map(boxFor),
      size.x > 0 && size.y > 0 ? { w: size.x, h: size.y } : undefined,
    );
    // `layoutKey` stands for the clocks' geometry, so a new array with the same clocks doesn't re-lay out.
  }, [map, layoutKey, view]);

  return (
    <>
      {clocks.map((c, i) => {
        const { x: dx, y: dy } = offsets[i] ?? { x: 0, y: 0 };
        return (
          <PortalMarker key={c.key} position={[c.lat, c.lon]} z={c.selected ? 1000 : 0}>
            <div className="ui-mapclock-anchor">
              {needsLeader({ x: dx, y: dy }) && (
                <svg className="ui-mapclock-leader" aria-hidden="true" focusable="false">
                  <line x1={0} y1={0} x2={dx} y2={dy} />
                </svg>
              )}
              <span className="ui-mapclock-pin" aria-hidden="true" />
              <div
                className={`ui-mapclock-box${c.selected ? " selected" : ""}`}
                style={{ transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))` }}
              >
                <SpotClock
                  label={c.label}
                  prob={c.prob}
                  countdownH={c.countdownH}
                  state={c.state}
                  size={c.size ?? "md"}
                  selected={c.selected}
                  onClick={c.onClick}
                />
                {c.note && <div className="ui-mapclock-note">{c.note}</div>}
              </div>
            </div>
          </PortalMarker>
        );
      })}
    </>
  );
}
