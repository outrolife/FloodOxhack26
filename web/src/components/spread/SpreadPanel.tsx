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
  SPREAD_LEGEND,
  SPREAD_LIMITATIONS,
  iouSentence,
} from "./frames";

export const TOGGLE_LABEL = "Flood spread (Experimental)";

export function SpreadPanel({
  manifest,
  sample,
  on,
  onToggle,
  tau,
  onTau,
  pick,
  at,
  imageMissing,
  hideWhenMissing,
}: {
  /** null: no manifest for this context. */
  manifest: SpreadManifest | null;
  /** The manifest is the tests/fixtures/ placeholder, not a real run. */
  sample?: boolean;
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
}) {
  if (!manifest) {
    if (hideWhenMissing) return null;
    return (
      <div style={S.box}>
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
    <div style={S.box}>
      <label style={S.toggle}>
        <input type="checkbox" checked={on} onChange={(e) => onToggle(e.target.checked)} />
        {TOGGLE_LABEL}
      </label>
      {on && (
        <div style={S.body}>
          <span style={S.badge}>Experimental</span>
          {sample && <span style={{ ...S.badge, background: "#fdf0d5", color: "#8a4b00" }}>Sample data</span>}
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
          {imageMissing && pick.kind === "frame" && <p style={S.warn}>Overlay image not available.</p>}
          <div style={{ marginTop: 6 }}>
            <div style={{ fontWeight: 600 }}>Share of {manifest.runs} runs where the ground is wet</div>
            {SPREAD_LEGEND.map((l) => (
              <div key={l.label}>
                <span style={{ ...S.swatch, background: l.colour }} />
                {l.label}
              </div>
            ))}
          </div>
          {iou && (
            <p style={S.iou}>
              <strong>{iou}</strong>
            </p>
          )}
          <p style={S.note}>{SPREAD_LIMITATIONS}</p>
          {extraCaveats.map((c) => (
            <p key={c} style={S.note}>
              {c}
            </p>
          ))}
          {sample && <p style={S.warn}>Placeholder overlay from tests/fixtures, not a real run.</p>}
          <p style={S.note}>Terrain: EA LiDAR DTM, Open Government Licence v3.0.</p>
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

/** Leads present in the manifest, in order (normally all of SPREAD_LEADS). */
export function availableLeads(manifest: SpreadManifest): number[] {
  const have = new Set(manifest.frames.map((f) => f.tau));
  const known = SPREAD_LEADS.filter((h) => have.has(h));
  const extra = [...have].filter((h) => !(SPREAD_LEADS as readonly number[]).includes(h));
  return [...known, ...extra].sort((a, b) => a - b);
}

const S = {
  box: { background: "#fff", padding: "6px 8px", maxWidth: 250, fontSize: "0.78rem", color: "#0b0b0b" },
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
  swatch: {
    display: "inline-block",
    width: 10,
    height: 10,
    marginRight: 5,
    verticalAlign: -1,
    border: "1px solid rgba(11,11,11,0.2)",
  },
  iou: { margin: "6px 0 0" },
  note: { margin: "6px 0 0", color: "#52514e" },
  warn: { margin: "6px 0 0", color: "#8a4b00" },
} satisfies Record<string, CSSProperties>;
