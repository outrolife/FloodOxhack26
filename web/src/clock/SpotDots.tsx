// The flow map's spot markers (#118, browser feedback): small, identical round
// markers so the map stays visible. A ring fills with the chance of flooding
// in the next 3 days, the percentage sits inside from 1%, the spot name is
// small text beside it. The selected spot gets a thicker outline. A spot
// without a forecast is a small grey hollow marker whose hover text says why
// in plain words. Placed with the shared rule (ui/placement.ts) at this
// small size, so neighbours (Osney, Botley Road) move only a few pixels.
// Each marker is a React portal into an empty Leaflet marker, like MapClocks.
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import L from "leaflet";
import { Marker, useMap, useMapEvents } from "react-leaflet";
import { CLOCK_STYLE } from "../ui/SpotClock";
import { needsLeader, spreadApart } from "../ui/placement";
import { DOT_BOX, DOT_PX, chanceLabel, labelSide, ringText, type SpotDot } from "./markers";

const ICON = L.divIcon({ className: "rc-dot-marker", html: "", iconSize: [0, 0], iconAnchor: [0, 0] });

function PortalMarker({ position, z, children }: { position: [number, number]; z: number; children: ReactNode }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const attach = useCallback((m: L.Marker | null) => {
    const e = m?.getElement() ?? null;
    if (e) L.DomEvent.disableClickPropagation(e);
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

/** One marker: the ring (or a grey hollow circle), the percentage inside from 1%. */
export function Dot({ dot, selected }: { dot: Pick<SpotDot, "prob" | "state">; selected: boolean }) {
  const c = DOT_PX / 2;
  const R = c - 4.5;
  const circ = 2 * Math.PI * R;
  const quiet = dot.state === "noforecast" || dot.state === "stale";
  const text = quiet ? null : ringText(dot.prob);
  const frac = quiet || dot.prob == null ? 0 : Math.min(Math.max(dot.prob, 0), 1);
  // A sliver always shows for a non-zero chance.
  const dash = frac > 0 ? Math.max(frac * circ, 1.5) : 0;
  const outline = selected ? 3 : 1.25;
  return (
    <svg width={DOT_PX} height={DOT_PX} viewBox={`0 0 ${DOT_PX} ${DOT_PX}`} aria-hidden="true" focusable="false">
      {quiet ? (
        <circle cx={c} cy={c} r={c - 4} fill="rgba(255,255,255,0.85)" stroke="#898781" strokeWidth={selected ? 3 : 2} strokeDasharray="3 2.5" />
      ) : (
        <>
          <circle cx={c} cy={c} r={c - outline / 2} fill="#fff" stroke="#0b0b0b" strokeWidth={outline} />
          <circle cx={c} cy={c} r={R} fill="none" stroke="#e6e4df" strokeWidth={4} />
          {dash > 0 && (
            <circle
              cx={c}
              cy={c}
              r={R}
              fill="none"
              stroke={CLOCK_STYLE[dot.state].colour}
              strokeWidth={4}
              strokeDasharray={`${dash} ${circ}`}
              transform={`rotate(-90 ${c} ${c})`}
            />
          )}
          {text && (
            <text x={c} y={c + 3.2} textAnchor="middle" fontSize={text.length > 3 ? 8 : 9.5} fontWeight={750} fill="#0b0b0b">
              {text}
            </text>
          )}
        </>
      )}
    </svg>
  );
}

export function SpotDots({ dots, selected, onSelect }: { dots: SpotDot[]; selected: string; onSelect?: (key: string) => void }) {
  const map = useMap();
  const [view, setView] = useState(0);
  const bump = () => setView((v) => v + 1);
  useMapEvents({ moveend: bump, zoomend: bump, resize: bump });

  const layoutKey = dots.map((d) => `${d.key}:${d.lat},${d.lon}`).join("|");
  const offsets = useMemo(() => {
    const size = map.getSize();
    const pts = dots.map((d) => map.latLngToContainerPoint([d.lat, d.lon]));
    return spreadApart(
      pts.map((p) => ({ x: p.x, y: p.y })),
      DOT_BOX,
      size.x > 0 && size.y > 0 ? { w: size.x, h: size.y } : undefined,
    );
    // `layoutKey` stands for the markers' geometry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, layoutKey, view]);

  return (
    <>
      {dots.map((d, i) => {
        const { x: dx, y: dy } = offsets[i] ?? { x: 0, y: 0 };
        const isSel = d.key === selected;
        const quiet = d.note != null;
        const words = (quiet ? `${d.label}: ${d.note}` : chanceLabel(d.label, d.prob)) + (d.badge ? `. River Clock: ${d.badge.text}` : "");
        const clickable = onSelect != null && !quiet;
        return (
          <PortalMarker key={d.key} position={[d.lat, d.lon]} z={isSel ? 1000 : 0}>
            <div className="rc-dot-anchor">
              {needsLeader({ x: dx, y: dy }) && (
                <svg className="rc-dot-leader" aria-hidden="true" focusable="false">
                  <line x1={0} y1={0} x2={dx} y2={dy} />
                  <circle cx={0} cy={0} r={2.5} />
                </svg>
              )}
              <div
                className={`rc-dot rc-dot-${labelSide(dx)}${isSel ? " selected" : ""}${quiet ? " quiet" : ""}`}
                style={{ transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))` }}
                data-state={d.state}
              >
                {clickable ? (
                  <button type="button" className="rc-dot-btn" aria-label={words} aria-pressed={isSel} title={words} onClick={() => onSelect?.(d.key)}>
                    <Dot dot={d} selected={isSel} />
                  </button>
                ) : (
                  <span className="rc-dot-btn" role="img" aria-label={words} title={words}>
                    <Dot dot={d} selected={isSel} />
                  </span>
                )}
                {/* A ring that ripples out when River Clock's warning fires (replays). */}
                {d.pulse && <span className="rc-dot-pulse" aria-hidden="true" />}
                <span className="rc-dot-name" aria-hidden="true">
                  {d.label}
                </span>
                {/* River Clock vs the EA, once both have happened: words and a shape, not colour alone. */}
                {d.badge && (
                  <span className={`rc-dot-badge tone-${d.badge.tone}`} aria-hidden="true">
                    {d.badge.tone === "good" ? "✓ " : d.badge.tone === "bad" ? "✕ " : ""}
                    {d.badge.text}
                  </span>
                )}
              </div>
            </div>
          </PortalMarker>
        );
      })}
    </>
  );
}
