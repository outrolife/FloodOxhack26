// Replay map (#120): the offline Oxford basemap with each trouble spot's clock
// filling as the wave arrives. The spots sit a few hundred metres apart, so
// each clock is drawn a little away from its spot with a leader line to a dot
// on the true location. Clicking a clock selects that spot.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import L from "leaflet";
import { Marker } from "react-leaflet";
import type { Forecast, Spot } from "../../contracts";
import { BaseMap } from "../../ui/BaseMap";
import { SpotClock } from "../../ui";
import { clockAt } from "./clocks";
import { shortSpotName } from "./story";

/** Where each clock sits relative to its spot, in px (dx, dy). */
const OFFSET: Record<string, [number, number]> = {
  wolvercote: [-20, -70],
  botley: [-105, 10],
  osney: [10, 85],
  abingdonrd: [90, 60],
  cherwell: [95, -45],
};

const ANCHOR = L.divIcon({ className: "rp-anchor", html: "", iconSize: [0, 0], iconAnchor: [0, 0] });

/** A Leaflet marker whose content is React, rendered through a portal. */
function PortalMarker({ position, children }: { position: [number, number]; children: ReactNode }) {
  const ref = useRef<L.Marker>(null);
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const node = ref.current?.getElement() ?? null;
    if (node) {
      L.DomEvent.disableClickPropagation(node);
      setEl(node);
    }
  }, []);
  return (
    <>
      <Marker
        ref={ref}
        position={position}
        icon={ANCHOR}
        keyboard={false}
        eventHandlers={{ add: (e) => setEl((e.target as L.Marker).getElement() ?? null) }}
      />
      {el && createPortal(children, el)}
    </>
  );
}

export function ReplayMap({
  spots,
  forecast,
  selected,
  onSelect,
}: {
  spots: Spot[];
  forecast: Forecast | undefined;
  selected: string;
  onSelect: (key: string) => void;
}) {
  // Fit the spots, not all of Oxford, so the clocks have room.
  const bounds = useMemo<[[number, number], [number, number]]>(() => {
    const lats = spots.map((s) => s.lat);
    const lons = spots.map((s) => s.lon);
    return [
      [Math.min(...lats) - 0.008, Math.min(...lons) - 0.02],
      [Math.max(...lats) + 0.008, Math.max(...lons) + 0.02],
    ];
  }, [spots]);

  return (
    <BaseMap bounds={bounds} className="rp-map">
      {spots.map((s) => {
        const c = clockAt(forecast, s);
        const [dx, dy] = OFFSET[s.key] ?? [0, -70];
        const isSel = s.key === selected;
        const pickable = s.mode === "probability";
        return (
          <PortalMarker key={s.key} position={[s.lat, s.lon]}>
            <div className={`rp-pin${isSel ? " selected" : ""}`}>
              <svg className="rp-leader" aria-hidden="true" width="1" height="1" overflow="visible">
                <line x1={0} y1={0} x2={dx} y2={dy} />
                <circle cx={0} cy={0} r={5} />
              </svg>
              <div className="rp-pin-clock" style={{ transform: `translate(calc(${dx}px - 50%), calc(${dy}px - 50%))` }}>
                <SpotClock
                  label={shortSpotName(s.name)}
                  prob={c.prob}
                  countdownH={c.countdownH}
                  state={c.state}
                  size={isSel ? "md" : "sm"}
                  selected={isSel}
                  onClick={pickable ? () => onSelect(s.key) : undefined}
                />
              </div>
            </div>
          </PortalMarker>
        );
      })}
    </BaseMap>
  );
}
