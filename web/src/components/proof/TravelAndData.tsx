// Proof: the travel-time finding, feature importance, per-event table, data quality.
import { useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { EventMeta, Importance, Proof, Quality, Spot, Station, TravelPair } from "../../contracts";
import { formatDate } from "../../time";
import { formatPct } from "../../lib/costLoss";
import { LOW_CONFIDENCE_N } from "../shared/RiverStrip";
import type { PeakProbabilities } from "./peakProbability";

/** Why an arrival error is blank on a flooded row (model/proof.py, ARRIVAL_OFFSET_H = 24). */
export const ARRIVAL_BLANK = "River Clock had not reached 50% 24 h before the river crossed the flood line";

const AXIS = { stroke: "#c3c2b7", tick: { fill: "#52514e", fontSize: 12 } };

/**
 * Human label for a travel-time event id: the named flood from events.json,
 * or "auto-detected rise, 26 Nov 2006" for the pipeline's auto-YYYYMMDD ids.
 */
export function travelEventLabel(id: string, events: Pick<EventMeta, "id" | "name">[] = []): string {
  const named = events.find((e) => e.id === id);
  if (named) return named.name;
  const m = /^auto-(\d{4})(\d{2})(\d{2})/.exec(id);
  if (m) return `auto-detected rise, ${formatDate(`${m[1]}-${m[2]}-${m[3]}T12:00:00Z`)}`;
  return id.startsWith("auto-") ? "auto-detected rise" : id;
}

/** Default row: the best-measured pair (most events), so the scatter isn't empty. */
function bestPairIndex(pairs: TravelPair[]): number {
  let best = 0;
  pairs.forEach((p, k) => {
    if (p.n > pairs[best].n) best = k;
  });
  return best;
}

export function TravelFinding({
  pairs,
  stations,
  events = [],
}: {
  pairs: TravelPair[];
  stations: Station[];
  events?: Pick<EventMeta, "id" | "name">[];
}) {
  const name = (k: string) => stations.find((s) => s.key === k)?.name ?? k;
  const [i, setI] = useState(() => bestPairIndex(pairs));
  const pair = pairs[Math.min(i, pairs.length - 1)];
  if (!pair) return null;
  const used = pair.events
    .filter((e) => !e.excluded && e.tHalf != null)
    .map((e) => ({ ...e, label: travelEventLabel(e.eventId, events) }));
  const excluded = pair.events.filter((e) => e.excluded);
  return (
    <div className="card">
      <h2>The finding: flood travel times</h2>
      <p className="sub">How long a flood rise takes to travel from an upstream gauge to Oxford, measured from past floods.</p>
      <div className="table-scroll">
        <table className="data">
          <thead>
            <tr>
              <th>From</th>
              <th>To</th>
              <th>Events</th>
              <th>T½ median</th>
              <th>T½ 10–90%</th>
              <th>Peak-to-peak median</th>
            </tr>
          </thead>
          <tbody>
            {pairs.map((p, k) => (
              <tr key={`${p.up}-${p.down}`} onClick={() => setI(k)} style={{ cursor: "pointer", background: k === i ? "#eef3fa" : undefined }}>
                <td>{name(p.up)}</td>
                <td>{name(p.down)}</td>
                <td className="num">
                  {p.n}
                  {p.n < 3 && " *"}
                  {p.n < LOW_CONFIDENCE_N && <span className="tag-low">low confidence</span>}
                </td>
                <td className="num">{p.tHalf.median.toFixed(1)} h</td>
                <td className="num">{p.tHalf.p10.toFixed(0)}–{p.tHalf.p90.toFixed(0)} h</td>
                <td className="num">{p.tPeak.median.toFixed(1)} h</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted">
        * Fewer than 3 events: cross-correlation estimate only. Fewer than {LOW_CONFIDENCE_N} events: low
        confidence. Click a row to see its detail.
      </p>
      <div className="grid-cols" style={{ marginTop: "0.6rem" }}>
        <div>
          <h3>{name(pair.up)} → {name(pair.down)}: T½ vs rise</h3>
          <div style={{ height: 200 }}>
            <ResponsiveContainer>
              <ScatterChart margin={{ top: 8, right: 16, left: 0, bottom: 16 }}>
                <CartesianGrid stroke="#e1e0d9" />
                <XAxis type="number" dataKey="rise" name="Rise" {...AXIS} tickFormatter={(v: number) => `${v.toFixed(1)} m`}
                  label={{ value: "Upstream rise (m, own datum)", position: "insideBottom", offset: -8, fill: "#52514e", fontSize: 12 }} />
                <YAxis type="number" dataKey="tHalf" name="T½" {...AXIS} width={44} tickFormatter={(v: number) => `${v} h`} />
                <Tooltip
                  content={({ active, payload }) => {
                    const e = active ? (payload?.[0]?.payload as (typeof used)[number] | undefined) : undefined;
                    if (!e) return null;
                    return (
                      <div className="chart-tip">
                        <strong>{e.label}</strong>
                        <div>Rise {e.rise.toFixed(2)} m · T½ {e.tHalf?.toFixed(1)} h</div>
                      </div>
                    );
                  }}
                />
                <Scatter data={used} fill="#2a78d6" stroke="#fcfcfb" strokeWidth={2} isAnimationActive={false} />
              </ScatterChart>
            </ResponsiveContainer>
          </div>
          {pair.slopeHoursPerMetre != null && (
            <p className="small">Bigger rises travel {pair.slopeHoursPerMetre < 0 ? "faster" : "slower"}: {Math.abs(pair.slopeHoursPerMetre).toFixed(1)} h per metre of rise.</p>
          )}
          {used.length === 0 && (
            <p className="small muted">No rise passed the matching checks for this pair, so its travel time comes from cross-correlation.</p>
          )}
          {excluded.length > 0 && (
            <details className="small muted">
              <summary>
                {excluded.length} {excluded.length === 1 ? "rise" : "rises"} excluded from this pair (show why)
              </summary>
              <ul className="excluded-list">
                {excluded.map((e) => (
                  <li key={e.eventId}>
                    {travelEventLabel(e.eventId, events)}: {e.excluded}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
        <div>
          <h3>Cross-correlation by lag</h3>
          <div style={{ height: 200 }}>
            <ResponsiveContainer>
              <LineChart data={pair.xcorr} margin={{ top: 8, right: 16, left: 0, bottom: 16 }}>
                <CartesianGrid stroke="#e1e0d9" vertical={false} />
                <XAxis dataKey="lagH" type="number" {...AXIS} tickFormatter={(v: number) => `${v} h`}
                  label={{ value: "Lag", position: "insideBottom", offset: -8, fill: "#52514e", fontSize: 12 }} />
                <YAxis domain={[-1, 1]} {...AXIS} width={36} />
                <Tooltip formatter={(v) => [Number(v).toFixed(2), "r"]} labelFormatter={(l) => `Lag ${l} h`} />
                <Line dataKey="r" stroke="#2a78d6" strokeWidth={2} dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Readable label for a model feature name (model/features.py naming), e.g.
 * "eynsham_change_3h" → "Eynsham Lock u/s: change over 3 h",
 * "rain_sum_24h" → "Rainfall, last 24 h". Unknown names pass through.
 */
export function featureLabel(raw: string, stations: Pick<Station, "key" | "name">[] = []): string {
  const describe = (rest: string): string | null => {
    let m: RegExpExecArray | null;
    if (rest === "now") return "level now";
    if ((m = /^change_(\d+)h$/.exec(rest))) return `change over ${m[1]} h`;
    if ((m = /^mean_(\d+)d$/.exec(rest))) return `${m[1]}-day mean level`;
    if ((m = /^anom_lag(\d+)h$/.exec(rest))) return m[1] === "0" ? "anomaly now" : `anomaly ${m[1]} h ago`;
    return null;
  };
  let m: RegExpExecArray | null;
  if ((m = /^rain_sum_(\d+)([hd])$/.exec(raw))) return `Rainfall, last ${m[1]} ${m[2] === "d" ? "days" : "h"}`;
  if (raw === "doy_sin") return "Season (day-of-year sine)";
  if (raw === "doy_cos") return "Season (day-of-year cosine)";
  if (raw.startsWith("level_")) {
    const d = describe(raw.slice(6));
    if (d) return `This gauge: ${d}`;
  }
  const st = stations.find((s) => raw.startsWith(`${s.key}_`));
  if (st) {
    const d = describe(raw.slice(st.key.length + 1));
    if (d) return `${st.name}: ${d}`;
  }
  return raw;
}

export function FeatureImportance({ importance, stations }: { importance: Importance; stations: Station[] }) {
  const gauges = Object.keys(importance);
  // Importance is keyed by gauge: default to newbotley, the primary target (SPEC §4.1.1).
  const [g, setG] = useState(gauges.includes("newbotley") ? "newbotley" : (gauges[0] ?? ""));
  const entries = importance[g] ?? [];
  const [h, setH] = useState(entries.find((e) => e.h === 24)?.h ?? entries[0]?.h ?? 24);
  const entry = entries.find((e) => e.h === h) ?? entries[0];
  const name = (k: string) => stations.find((s) => s.key === k)?.name ?? k;
  const top = entry
    ? [...entry.features]
        .sort((a, b) => b.gain - a.gain)
        .slice(0, 10)
        .map((f) => ({ ...f, label: featureLabel(f.name, stations) }))
    : [];
  return (
    <div className="card">
      <h2>What the model looks at</h2>
      <p className="sub">Top 10 features by LightGBM gain.</p>
      <div className="controls">
        <label>
          Gauge
          <select value={g} onChange={(e) => setG(e.target.value)}>
            {gauges.map((k) => (
              <option key={k} value={k}>{name(k)}</option>
            ))}
          </select>
        </label>
        <label>
          Lead
          <select value={entry?.h ?? h} onChange={(e) => setH(Number(e.target.value))}>
            {entries.map((e) => (
              <option key={e.h} value={e.h}>+{e.h} h</option>
            ))}
          </select>
        </label>
      </div>
      <div style={{ height: Math.max(120, top.length * 26 + 30) }}>
        <ResponsiveContainer>
          <BarChart data={top} layout="vertical" margin={{ top: 0, right: 16, left: 8, bottom: 0 }}>
            <XAxis type="number" {...AXIS} hide />
            <YAxis type="category" dataKey="label" width={290} {...AXIS} />
            <Tooltip
              formatter={(v) => [Number(v).toFixed(3), "Gain"]}
              labelFormatter={(l, p) => `${String(l)} (${String((p?.[0]?.payload as { name?: string } | undefined)?.name ?? "")})`}
            />
            <Bar dataKey="gain" fill="#2a78d6" radius={[0, 4, 4, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function PerEventTable({
  proof,
  events,
  spots,
  dateOnly,
  peaks = {},
}: {
  proof: Proof;
  events: EventMeta[];
  spots: Spot[];
  /** "eventId:spot" keys whose official time is known to the day only. */
  dateOnly: Set<string>;
  /** Peak pFlood per event and spot, derived from the replays (non-flooded rows only). */
  peaks?: PeakProbabilities;
}) {
  const ev = (id: string) => events.find((e) => e.id === id)?.name ?? id;
  const sp = (k: string) => spots.find((s) => s.key === k)?.name ?? k;
  const h = (v: number | null) => (v == null ? "–" : `${v > 0 ? "+" : ""}${v.toFixed(1)} h`);
  const isDateOnly = (eventId: string, spot: string) => dateOnly.has(`${eventId}:${spot}`);
  const anyDateOnly = proof.perEvent.some((r) => isDateOnly(r.eventId, r.spot));
  const peakOf = (r: Proof["perEvent"][number]) => (r.crossed ? undefined : peaks[r.eventId]?.[r.spot]);
  const anyPeak = proof.perEvent.some((r) => peakOf(r) !== undefined);
  const anyBlankArrival = proof.perEvent.some((r) => r.arrivalErrH == null);
  return (
    <div className="card">
      <h2>Event by event</h2>
      {anyDateOnly && (
        <div className="notice warn">
          Rows marked † have an official issue time known to the day only: their lead vs official is
          compared in whole days (multiples of 24 h), so it is approximate.
        </div>
      )}
      <div className="table-scroll">
        <table className="data">
          <thead>
            <tr>
              <th>Event</th>
              <th>Spot</th>
              <th>Flooded?</th>
              <th>Observed peak</th>
              <th>Arrival error (50% time − crossing){anyBlankArrival && " *"}</th>
              <th>Lead vs official</th>
            </tr>
          </thead>
          <tbody>
            {proof.perEvent.map((r) => {
              const peak = peakOf(r);
              return (
              <tr key={`${r.eventId}-${r.spot}`}>
                <td>{ev(r.eventId)}</td>
                <td>{sp(r.spot)}</td>
                <td>
                  {r.crossed ? "Yes" : "No"}
                  {peak !== undefined && (
                    <span className="muted" title={`Max pFlood over every forecast and lead in replays/${r.eventId}.json`}>
                      {" "}· highest flood chance {formatPct(peak)} ‡
                    </span>
                  )}
                </td>
                <td className="num">{r.peakObs.toFixed(2)} m</td>
                <td className="num">
                  {r.arrivalErrH == null ? (
                    <span title={r.crossed ? ARRIVAL_BLANK : "No flood here, so nothing to time"}>–</span>
                  ) : (
                    h(r.arrivalErrH)
                  )}
                </td>
                <td className="num">
                  {isDateOnly(r.eventId, r.spot) && r.leadVsOfficialH != null ? (
                    <span title="Official time known to the day only">≈ {h(r.leadVsOfficialH)} †</span>
                  ) : (
                    h(r.leadVsOfficialH)
                  )}
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {anyBlankArrival && (
        <p className="small muted">
          * Arrival error: blank (–) = {ARRIVAL_BLANK}. On rows that did not flood there is nothing to time.
        </p>
      )}
      {anyPeak && (
        <p className="small muted">
          ‡ Highest flood chance: for events that did not flood a spot, the highest chance of flooding River Clock
          gave there at any point in the event (looking up to 72 h ahead). The results summary doesn't store this,
          so the app reads it from that event's replay (replays/&lt;event&gt;.json).
        </p>
      )}
      <p className="small muted">{proof.testPeriodNote}</p>
    </div>
  );
}

export function QualityTables({ quality, stations }: { quality: Quality; stations: Station[] }) {
  const name = (k: string) => stations.find((s) => s.key === k)?.name ?? k;
  return (
    <div className="card">
      <h2>Data quality and sources</h2>
      <div className="table-scroll">
        <table className="data">
          <thead>
            <tr>
              <th>Gauge</th>
              <th>Coverage</th>
              <th>Gaps filled</th>
              <th>Gaps flagged</th>
              <th>Spikes removed</th>
              <th>Threshold (API / config)</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {quality.gauges.map((g) => {
              const mismatch = g.thresholdApi != null && g.thresholdConfig != null && Math.abs(g.thresholdApi - g.thresholdConfig) > 0.005;
              return (
                <tr key={g.key}>
                  <td>{name(g.key)}</td>
                  <td className="num">{g.coveragePct.toFixed(1)}%</td>
                  <td className="num">{g.gapsFilled}</td>
                  <td className="num">{g.gapsFlagged}</td>
                  <td className="num">{g.spikesRemoved}</td>
                  <td className="num">
                    {g.thresholdApi?.toFixed(2) ?? "–"} / {g.thresholdConfig?.toFixed(2) ?? "–"}
                    {mismatch && <strong style={{ color: "#d03b3b" }}> mismatch</strong>}
                  </td>
                  <td className="small">{g.notes.join("; ")}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <h3 style={{ marginTop: "0.8rem" }}>Sources</h3>
      <div className="table-scroll">
        <table className="data">
          <thead>
            <tr>
              <th>Source</th>
              <th>Licence</th>
              <th>Downloaded</th>
              <th>Rows</th>
            </tr>
          </thead>
          <tbody>
            {quality.sources.map((s) => (
              <tr key={s.name}>
                <td>
                  <a href={s.url} target="_blank" rel="noreferrer">{s.name}</a>
                </td>
                <td>{s.licence}</td>
                <td>{formatDate(s.downloadedAt)}</td>
                <td className="num">{s.rows.toLocaleString("en-GB")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
