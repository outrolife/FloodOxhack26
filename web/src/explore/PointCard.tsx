// The point card (#118 Explore): what we know about a searched or clicked
// point. A side panel on desktop, a bottom sheet on phones (<= 700 px; swipe
// down or the close button). Address (skeleton while it is looked up), the
// risk badge (colour plus words), one plain sentence, the FloodClock forecast
// at a nearby flood spot, and the sandbag estimate.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { SandbagCard } from "./SandbagCard";
import type { RiskState, Selection } from "./useExplore";
import type { NearbySpot, RiskBand } from "./types";

/** The CSS token suffix for a band (tokens.css spells very_low as verylow). */
export const bandToken = (b: RiskBand) => (b === "very_low" ? "verylow" : b);

/** "2%", "under 1%", or null with no forecast. */
export function chanceWords(p: number | null): string | null {
  if (p == null || !Number.isFinite(p)) return null;
  if (p > 0 && p < 0.01) return "under 1%";
  return `${Math.round(Math.min(Math.max(p, 0), 1) * 100)}%`;
}

/** "FloodClock now: 2% chance at Botley Road in the next 3 days". */
export function nearbyLine(n: NearbySpot): string {
  const c = chanceWords(n.prob3d);
  return c ? `FloodClock now: ${c} chance at ${n.name} in the next 3 days` : `FloodClock has no forecast for ${n.name} right now`;
}

const distanceWords = (m: number) => (m < 1000 ? `${Math.round(m / 10) * 10} m away` : `${(m / 1000).toFixed(1)} km away`);

/** Drag the sheet down this far (px) to close it. */
const SWIPE_CLOSE_PX = 80;
const EXIT_MS = 220;

export function PointCard({
  selection,
  risk,
  onClose,
  onRetry,
}: {
  selection: Selection;
  risk: RiskState;
  onClose: () => void;
  onRetry: () => void;
}) {
  const [closing, setClosing] = useState(false);
  const [drag, setDrag] = useState(0);
  const start = useRef<number | null>(null);
  const headRef = useRef<HTMLHeadingElement>(null);

  // A new point re-opens the card (cancels a close in progress).
  useEffect(() => setClosing(false), [selection.id]);

  // Esc closes the card.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement)) close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const close = () => {
    if (closing) return;
    setClosing(true);
    window.setTimeout(onClose, EXIT_MS);
  };

  // Swipe down on the sheet's handle or header (phones).
  const onDown = (e: ReactPointerEvent) => {
    if (e.pointerType === "mouse") return;
    start.current = e.clientY;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: ReactPointerEvent) => {
    if (start.current == null) return;
    setDrag(Math.max(0, e.clientY - start.current));
  };
  const onUp = () => {
    if (start.current == null) return;
    start.current = null;
    if (drag > SWIPE_CLOSE_PX) close();
    setDrag(0);
  };

  const place = selection.place;
  const title = place?.label ?? (selection.status === "error" ? "Dropped pin" : null);
  const coords = `${selection.lat.toFixed(5)}, ${selection.lon.toFixed(5)}`;

  return (
    <aside
      className={`fc-x-card${closing ? " is-closing" : ""}${drag ? " is-dragging" : ""}`}
      style={drag ? { transform: `translateY(${drag}px)` } : undefined}
      aria-labelledby="fc-x-card-title"
      aria-busy={selection.status === "loading" || risk.status === "loading"}
    >
      <div className="fc-x-card-grab" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <span className="fc-x-handle" aria-hidden="true" />
        <div className="fc-x-card-head">
          <div className="fc-x-card-where">
            <span className="fc-x-eyebrow">{selection.source === "search" ? "Search result" : "Dropped pin"}</span>
            <h2 id="fc-x-card-title" ref={headRef} className="fc-x-card-title" tabIndex={-1}>
              {title ?? (
                <>
                  <span className="fc-x-sr">Looking up the address…</span>
                  <span className="fc-x-skel fc-x-skel-title" aria-hidden="true" />
                </>
              )}
            </h2>
            {selection.status === "loading" ? (
              <span className="fc-x-skel fc-x-skel-line" aria-hidden="true" />
            ) : (
              <span className="fc-x-coords">{place?.postcode && !place.label.includes(place.postcode) ? `${place.postcode} · ` : ""}{coords}</span>
            )}
          </div>
          <button type="button" className="fc-x-close" aria-label="Close" onClick={close}>
            <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
              <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>

      <div className="fc-x-card-body">
        {selection.status === "error" && selection.error && (
          <div className="fc-x-error" role="alert">
            <span>{selection.error.text}</span>
            {selection.error.retry && (
              <button type="button" className="fc-x-btn" onClick={onRetry}>
                Retry
              </button>
            )}
          </div>
        )}

        {risk.status === "loading" && (
          <div className="fc-x-risk" aria-hidden="true">
            <span className="fc-x-skel fc-x-skel-badge" />
            <span className="fc-x-skel fc-x-skel-line" />
            <span className="fc-x-skel fc-x-skel-line short" />
          </div>
        )}
        {risk.status === "unavailable" && (
          <div className="fc-x-risk">
            <p className="fc-x-sentence">The flood zone map isn't available right now, so we can't show the river flood risk here.</p>
          </div>
        )}
        {risk.status === "ready" && (
          <div className="fc-x-risk">
            <span
              className={`fc-x-badge fc-x-badge-${bandToken(risk.risk.band)}`}
              style={{
                background: `var(--fc-risk-${bandToken(risk.risk.band)}, ${risk.risk.colour})`,
                color: `var(--fc-risk-${bandToken(risk.risk.band)}-ink, ${risk.risk.textColour})`,
              }}
            >
              <span className="fc-x-badge-dot" aria-hidden="true" />
              {risk.risk.label}
            </span>
            <p className="fc-x-sentence">{risk.risk.sentence}</p>
            {risk.risk.nearby && risk.risk.nearby.prob3d != null && (
              <p className="fc-x-nearby">
                <span className="fc-x-nearby-mark" aria-hidden="true" />
                <span>
                  <strong>{nearbyLine(risk.risk.nearby)}</strong>
                  <small> · {distanceWords(risk.risk.nearby.distanceM)}</small>
                </span>
              </p>
            )}
          </div>
        )}

        {risk.status === "ready" && <SandbagCard band={risk.risk.band} />}

        <p className="fc-x-fine">
          Source: Environment Agency Risk of Flooding from Rivers and Sea. Decision-support prototype, not an official warning:{" "}
          <a href="https://www.gov.uk/check-flooding" target="_blank" rel="noreferrer">
            check flooding on gov.uk
          </a>
          .
        </p>
      </div>
    </aside>
  );
}
