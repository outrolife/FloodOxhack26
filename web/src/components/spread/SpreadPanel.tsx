// S3 (SPEC §11): the toggle, lead picker, caveats, legend and validation score
// for the experimental flood-spread overlay. Presentational only (no Leaflet),
// so it renders in tests and in both the River map and the Time Machine card.
import type { CSSProperties } from "react";
import type { SpreadManifest } from "../../contracts";
import { formatDateTime, hoursBetween } from "../../time";
import {
  type FramePick,
  NO_SPREAD_NOTE,
  SPREAD_LEADS,
  SPREAD_TICKS,
  SPREAD_LIMITATIONS,
  iouSentence,
  legendGradient,
  legendPos,
  legendTitle,
} from "./frames";

export const TOGGLE_LABEL = "Flood spread (Experimental)";

export function SpreadPanel({
  manifest,
  on,
  onToggle,
  tau,
  onTau,
  pick,
  at,
  imageMissing,
  hideWhenMissing,
  wide,
}: {
  /** null: no manifest for this context. */
  manifest: SpreadManifest | null;
  on: boolean;
  onToggle: (on: boolean) => void;
  tau: number;
  onTau: (tau: number) => void;
  pick: FramePick;
  /** Time Machine slider time; absent in live mode. */
  at?: string;
  /** The chosen frame's PNG could not be found or loaded. */
  imageMissing?: boolean;
  /** River: no manifest means no toggle at all. Time Machine: a disabled toggle and a note. */
  hideWhenMissing?: boolean;
  /** In a card rather than a map corner: no width cap. */
  wide?: boolean;
}) {
  const box = wide ? { ...S.box, maxWidth: "none", maxHeight: "none", overflowY: "visible" as const, padding: 0 } : S.box;
  if (!manifest) {
    if (hideWhenMissing) return null;
    return (
      <div style={box}>
        <label style={{ ...S.toggle, color: "#8b8a86" }}>
          <input type="checkbox" disabled checked={false} onChange={() => {}} />
          {TOGGLE_LABEL}
        </label>
        <p style={S.note}>{NO_SPREAD_NOTE}</p>
      </div>
    );
  }

  const leads = availableLeads(manifest);
  const iou = iouSentence(manifest.validation);
  // Caveats from the manifest that aren't already in the SPEC limitations text.
  const extraCaveats = manifest.caveats.filter((c) => !SPREAD_LIMITATIONS.includes(c.trim()));

  return (
    <div style={box}>
      <label style={S.toggle}>
        <input type="checkbox" checked={on} onChange={(e) => onToggle(e.target.checked)} />
        {TOGGLE_LABEL}
      </label>
      {on && (
        <div style={S.body}>
          <span style={S.badge}>Experimental</span>
          <div style={S.leads} role="group" aria-label="Flood spread lead time">
            {leads.map((h) => (
              <button
                key={h}
                type="button"
                style={{ ...S.lead, ...(h === tau ? S.leadOn : null) }}
                aria-pressed={h === tau}
                onClick={() => onTau(h)}
              >
                +{h} h
              </button>
            ))}
          </div>
          <FrameLine pick={pick} at={at} />
          {noSpread(manifest) && (
            <p style={S.iou}>
              <strong>No spread expected at {at ? "these" : "today's"} levels</strong>: no ground outside the
              river is wet in half the runs at any lead.
            </p>
          )}
          {imageMissing && pick.kind === "frame" && <p style={S.warn}>Overlay image not available.</p>}
          <GradientLegend runs={manifest.runs} />
          {iou && (
            <p style={S.iou}>
              <strong>{iou}</strong>
            </p>
          )}
          <p style={S.note}>{SPREAD_LIMITATIONS}</p>
          {extraCaveats.length > 0 && (
            <details style={S.note}>
              <summary style={{ cursor: "pointer" }}>About this run</summary>
              {extraCaveats.map((c) => (
                <p key={c} style={S.note}>
                  {c}
                </p>
              ))}
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function FrameLine({ pick, at }: { pick: FramePick; at?: string }) {
  if (pick.kind === "none") return <p style={S.warn}>This run has no frames.</p>;
  if (pick.kind === "notYet") {
    return (
      <p style={S.note}>
        The spread run starts with the forecast issued {formatDateTime(pick.firstIssuedAt)}. Move the slider there
        to see it.
      </p>
    );
  }
  const { frame } = pick;
  const valid = new Date(Date.parse(frame.issuedAt) + frame.tau * 3_600_000).toISOString();
  const behind = at ? hoursBetween(frame.issuedAt, at) : 0;
  return (
    <p style={S.note}>
      Water at <strong>{formatDateTime(valid)}</strong> (+{frame.tau} h), from the forecast issued{" "}
      {formatDateTime(frame.issuedAt)}
      {behind >= 1 && <> ({Math.round(behind)} h before the slider)</>}.
    </p>
  );
}

/**
 * True when the run's own summary caveat says the largest extent wet in at least
 * half the runs is 0 ha ("Largest extent ... : 0 ha of the 250 ha box").
 */
export function noSpread(manifest: SpreadManifest): boolean {
  for (const c of manifest.caveats) {
    const m = /^Largest extent[^:]*:\s*([\d.]+)\s*ha/i.exec(c.trim());
    if (m) return Number(m[1]) === 0;
  }
  return false;
}

/** Horizontal green-to-red bar matching the PNG ramp, ticked at 5, 25, 50, 75 and 100%. */
export function GradientLegend({ runs }: { runs: number }) {
  return (
    <div style={{ marginTop: 6 }} aria-label="Flood spread legend">
      <div style={{ fontWeight: 600 }}>{legendTitle(runs)}</div>
      <div style={{ margin: "0 16px 0 10px" }}>
        <div style={{ ...S.bar, background: legendGradient() }} />
      </div>
      <div style={S.ticks}>
        {SPREAD_TICKS.map((t) => (
          <span key={t} style={{ ...S.tick, left: `${legendPos(t)}%` }}>
            {Math.round(t * 100)}%
          </span>
        ))}
      </div>
    </div>
  );
}

/** Leads present in the manifest, in order (normally all of SPREAD_LEADS). */
export function availableLeads(manifest: SpreadManifest): number[] {
  const have = new Set(manifest.frames.map((f) => f.tau));
  const known = SPREAD_LEADS.filter((h) => have.has(h));
  const extra = [...have].filter((h) => !(SPREAD_LEADS as readonly number[]).includes(h));
  return [...known, ...extra].sort((a, b) => a - b);
}

const S = {
  // In a map corner: capped height so it never covers the zoom buttons (the River map is 480 px).
  box: {
    background: "#fff",
    padding: "6px 8px",
    maxWidth: 250,
    maxHeight: 330,
    overflowY: "auto",
    fontSize: "0.78rem",
    color: "#0b0b0b",
  },
  toggle: { display: "flex", gap: 6, alignItems: "center", cursor: "pointer", fontWeight: 600 },
  body: { marginTop: 4 },
  badge: {
    display: "inline-block",
    padding: "1px 6px",
    marginRight: 4,
    borderRadius: 4,
    background: "#e9e2f8",
    color: "#4a2f8f",
    fontWeight: 700,
    fontSize: "0.7rem",
    textTransform: "uppercase",
    letterSpacing: "0.03em",
  },
  leads: { display: "flex", flexWrap: "wrap", gap: 3, marginTop: 6 },
  lead: {
    padding: "1px 5px",
    border: "1px solid rgba(11,11,11,0.25)",
    borderRadius: 4,
    background: "#fff",
    font: "inherit",
    cursor: "pointer",
  },
  leadOn: { background: "#184f95", borderColor: "#184f95", color: "#fff" },
  bar: { height: 10, marginTop: 4, borderRadius: 2, border: "1px solid rgba(11,11,11,0.25)" },
  ticks: { position: "relative", height: 14, margin: "2px 16px 0 10px", color: "#52514e" },
  tick: { position: "absolute", top: 0, transform: "translateX(-50%)", whiteSpace: "nowrap" },
  iou: { margin: "6px 0 0" },
  note: { margin: "6px 0 0", color: "#52514e" },
  warn: { margin: "6px 0 0", color: "#8a4b00" },
} satisfies Record<string, CSSProperties>;
