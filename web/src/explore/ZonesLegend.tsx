// The risk zones' key (#118 Explore): show or hide the zones, and the four
// bands in words (never colour alone). Collapses to one line.
import { useId, useState } from "react";
import { BAND_HEX, BAND_INFO } from "./logic";
import { ZONE_BANDS } from "./ExploreLayer";
import { bandToken } from "./PointCard";
import type { RiskBand } from "./types";
import type { ZonesState } from "./useExplore";

/** The EA's definitions, as a chance each year. */
export const BAND_YEARLY: Record<Exclude<RiskBand, "none">, string> = {
  high: "over 3.3% a year",
  medium: "1% to 3.3% a year",
  low: "0.1% to 1% a year",
  very_low: "under 0.1% a year",
};

export function ZonesLegend({ zones, show, onToggle }: { zones: ZonesState; show: boolean; onToggle: (show: boolean) => void }) {
  const id = useId();
  const [open, setOpen] = useState(() => typeof window === "undefined" || window.innerWidth > 700);
  return (
    <div className={`fc-x-legend${open ? " is-open" : ""}`}>
      <div className="fc-x-legend-head">
        <button type="button" className="fc-x-legend-title" aria-expanded={open} aria-controls={`${id}-key`} onClick={() => setOpen((o) => !o)}>
          River flood zones
          <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">
            <path d="M3 4.5L6 7.5L9 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
        <label className="fc-x-switch fc-x-switch-sm" title={show ? "Hide the zones" : "Show the zones"}>
          <input type="checkbox" role="switch" aria-label="Show flood zones on the map" checked={show} disabled={zones.status !== "ready"} onChange={(e) => onToggle(e.target.checked)} />
          <span aria-hidden="true" />
        </label>
      </div>
      <div id={`${id}-key`} className="fc-x-legend-key" hidden={!open}>
        {zones.status === "loading" && (
          <div className="fc-x-legend-loading" aria-live="polite">
            <span className="fc-x-sr">Loading the flood zones…</span>
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className="fc-x-skel fc-x-skel-line" aria-hidden="true" />
            ))}
          </div>
        )}
        {zones.status === "error" && <p className="fc-x-legend-note">The flood zone map couldn't be loaded. The rest of the map still works.</p>}
        {zones.status === "ready" && (
          <ul className={show ? undefined : "is-off"}>
            {ZONE_BANDS.map((b) => (
              <li key={b}>
                <span className="fc-x-swatch" style={{ background: `var(--fc-risk-${bandToken(b)}, ${BAND_HEX[b].fill})` }} aria-hidden="true" />
                <span>
                  <strong>{BAND_INFO[b].label}</strong> <small>{BAND_YEARLY[b]}</small>
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="fc-x-legend-tip">Click anywhere on the map to check a spot.</p>
      </div>
    </div>
  );
}
