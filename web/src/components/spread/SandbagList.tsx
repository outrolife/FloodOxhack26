// S4 (SPEC §11): "Inspection candidates" from the sandbag screening (sandbags.json).
// Self-contained and presentational; hidden behind SHOW_S4 in stretch.ts until S4
// is signed off. Suggestions of where to *inspect* first, never instructions.
import type { CSSProperties } from "react";
import type { Sandbags } from "../../contracts";
import { formatDateTime } from "../../time";

export const SANDBAG_TITLE = "Inspection candidates";
export const SCORE_LABEL = "Screening score, not modelled damage reduction.";
export const SANDBAG_NOTE =
  "Where a limited stock of sandbags may be worth inspecting first. A suggestion for a person to check, " +
  "never an instruction. Based on the experimental flood-spread run, so it shares all its limitations.";
export const SANDBAG_SOURCES =
  "Buildings © OpenStreetMap contributors (ODbL). Defences: EA Spatial Flood Defences (OGL v3). " +
  "Bags per metre of wall is an assumption.";

export function SandbagList({ data }: { data: Sandbags | null }) {
  if (!data) return null;
  const used = data.candidates.reduce((n, c) => n + c.bags, 0);
  return (
    <section style={S.box} aria-label={SANDBAG_TITLE}>
      <div style={S.head}>
        <strong>{SANDBAG_TITLE}</strong>
        <span style={S.badge}>Experimental</span>
      </div>
      <p style={S.label}>{SCORE_LABEL}</p>
      <p style={S.note}>{SANDBAG_NOTE}</p>
      <p style={S.note}>
        From the forecast issued {formatDateTime(data.issuedAt)}. Budget {data.budget} bags; these{" "}
        {data.candidates.length} use {used}.
      </p>
      {data.candidates.length === 0 ? (
        <p style={S.note}>No building passes the screening for this forecast.</p>
      ) : (
        <ol style={S.list}>
          {data.candidates.map((c) => (
            <li key={c.id} style={S.item}>
              <div>
                <strong>Score {c.score.toFixed(2)}</strong> · P(wet by 48 h) {Math.round(c.pWet48 * 100)}% · depth{" "}
                {c.medianDepthM.toFixed(2)} m · {c.bags} bags
              </div>
              <div style={S.note}>
                {c.firstWet ? <>Likely wet from {formatDateTime(c.firstWet)}</> : <>Not wet in half the runs</>}
                {" · "}
                <a href={osmUrl(c.id, c.lat, c.lon)} target="_blank" rel="noreferrer">
                  map
                </a>
              </div>
              <ul style={S.sub}>
                {c.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
              <div style={S.checksHead}>A person must check:</div>
              <ul style={S.sub}>
                {c.checks.map((k) => (
                  <li key={k}>{k}</li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
      {data.excluded.length > 0 && (
        <details style={S.note}>
          <summary style={{ cursor: "pointer" }}>{data.excluded.length} buildings screened out</summary>
          <ul style={S.sub}>
            {data.excluded.map((e) => (
              <li key={e.id}>
                {e.id}: {e.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
      <p style={S.note}>{SANDBAG_SOURCES}</p>
    </section>
  );
}

/** OpenStreetMap link for an "osm-way-123" / "osm-relation-456" id, else a map pin. */
export function osmUrl(id: string, lat: number, lon: number): string {
  const m = /^osm-(way|relation|node)-(\d+)$/.exec(id);
  if (m) return `https://www.openstreetmap.org/${m[1]}/${m[2]}`;
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=19/${lat}/${lon}`;
}

const S = {
  box: { background: "#fff", padding: "6px 8px", fontSize: "0.78rem", color: "#0b0b0b" },
  head: { display: "flex", gap: 6, alignItems: "center" },
  badge: {
    display: "inline-block",
    padding: "1px 6px",
    borderRadius: 4,
    background: "#e9e2f8",
    color: "#4a2f8f",
    fontWeight: 700,
    fontSize: "0.7rem",
    textTransform: "uppercase",
    letterSpacing: "0.03em",
  },
  label: { margin: "4px 0", fontWeight: 600 },
  note: { margin: "4px 0", color: "#52514e" },
  list: { margin: "4px 0", paddingLeft: 18 },
  item: { marginBottom: 8 },
  sub: { margin: "2px 0", paddingLeft: 16 },
  checksHead: { marginTop: 2, fontWeight: 600 },
} satisfies Record<string, CSSProperties>;
