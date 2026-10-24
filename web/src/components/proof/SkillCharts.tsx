// Proof: skill vs persistence, interval coverage, reliability, trade-off.
import { useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
  ErrorBar,
} from "recharts";
import type { Proof, Spot } from "../../contracts";

const AXIS = { stroke: "#c3c2b7", tick: { fill: "#52514e", fontSize: 11 } };
const GRID = <CartesianGrid stroke="#e1e0d9" vertical={false} />;
const SERIES = ["#2a78d6", "#eb6834", "#1baf7a"]; // categorical slots 1-3, fixed order

export function SkillByLead({ proof }: { proof: Proof }) {
  const rows = [...proof.skillByLead].sort((a, b) => a.h - b.h);
  const losing = rows.filter((r) => r.skill <= 0);
  return (
    <div className="card">
      <h2>Skill vs persistence, by lead time</h2>
      <p className="sub">
        Skill = 1 − model pinball loss / persistence pinball loss. Above 0 means River Clock beats
        "the level stays roughly where it is".
      </p>
      {losing.length > 0 && (
        <div className="notice warn">
          The model does <strong>not</strong> beat persistence at {losing.map((r) => `+${r.h} h`).join(", ")}.
        </div>
      )}
      <div style={{ height: 220 }}>
        <ResponsiveContainer>
          <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            {GRID}
            <XAxis dataKey="h" tickFormatter={(h: number) => `+${h} h`} {...AXIS} />
            <YAxis tickFormatter={(v: number) => v.toFixed(2)} {...AXIS} width={40} />
            <Tooltip
              formatter={(v) => [Number(v).toFixed(3), "Skill"]}
              labelFormatter={(h) => `Lead +${h} h`}
            />
            <ReferenceLine y={0} stroke="#52514e" />
            <Bar dataKey="skill" name="Skill" radius={[4, 4, 0, 0]} isAnimationActive={false}>
              {rows.map((r) => (
                <Cell key={r.h} fill={r.skill > 0 ? "#2a78d6" : "#898781"} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function Coverage({ proof }: { proof: Proof }) {
  const nominals = [...new Set(proof.coverage.map((c) => c.nominal))].sort((a, b) => a - b);
  const leads = [...new Set(proof.coverage.map((c) => c.h))].sort((a, b) => a - b);
  const rows = leads.map((h) => {
    const r: Record<string, number> = { h };
    for (const n of nominals) {
      const c = proof.coverage.find((x) => x.h === h && x.nominal === n);
      if (c) r[`n${Math.round(n * 100)}`] = c.actual * 100;
    }
    return r;
  });
  const flagged = proof.coverage.filter((c) => Math.abs(c.actual - c.nominal) > 0.1);
  return (
    <div className="card">
      <h2>Interval coverage</h2>
      <p className="sub">
        How often the real level fell inside each forecast interval. Dashed lines are the nominal
        targets.
      </p>
      {flagged.length > 0 && (
        <div className="notice warn">
          Coverage off by more than 10 points:{" "}
          {flagged
            .map((c) => `${Math.round(c.nominal * 100)}% interval at +${c.h} h (${Math.round(c.actual * 100)}%)`)
            .join("; ")}
          .
        </div>
      )}
      <div style={{ height: 220 }}>
        <ResponsiveContainer>
          <LineChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            {GRID}
            <XAxis dataKey="h" tickFormatter={(h: number) => `+${h} h`} {...AXIS} />
            <YAxis domain={[0, 100]} tickFormatter={(v: number) => `${v}%`} {...AXIS} width={40} />
            <Tooltip formatter={(v, n) => [`${Number(v).toFixed(0)}%`, String(n)]} labelFormatter={(h) => `Lead +${h} h`} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {nominals.map((n, i) => (
              <ReferenceLine key={`r${n}`} y={n * 100} stroke={SERIES[i % 3]} strokeDasharray="4 3" strokeOpacity={0.6} />
            ))}
            {nominals.map((n, i) => (
              <Line
                key={n}
                dataKey={`n${Math.round(n * 100)}`}
                name={`${Math.round(n * 100)}% interval`}
                stroke={SERIES[i % 3]}
                strokeWidth={2}
                dot={{ r: 4 }}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/** Brier scores on rare floods are tiny (0.001): show two significant figures, not three decimals. */
const brierFmt = (v: number): string => (v > 0 && v < 0.01 ? v.toPrecision(2) : v.toFixed(3));

export function Reliability({ proof, spots }: { proof: Proof; spots: Spot[] }) {
  const spotKeys = Object.keys(proof.reliability);
  const [spot, setSpot] = useState(spotKeys.includes("osney") ? "osney" : (spotKeys[0] ?? ""));
  const entries = proof.reliability[spot] ?? [];
  const [h, setH] = useState<number>(entries.find((e) => e.h === 24)?.h ?? entries[0]?.h ?? 24);
  const entry = entries.find((e) => e.h === h) ?? entries[0];
  const name = (k: string) => spots.find((s) => s.key === k)?.name ?? k;

  return (
    <div className="card">
      <h2>Reliability</h2>
      <p className="sub">When River Clock says 30%, does it flood about 30% of the time? Points on the diagonal are well calibrated.</p>
      <div className="controls">
        <label>
          Spot
          <select value={spot} onChange={(e) => setSpot(e.target.value)}>
            {spotKeys.map((k) => (
              <option key={k} value={k}>
                {name(k)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Lead
          <select value={entry?.h ?? h} onChange={(e) => setH(Number(e.target.value))}>
            {entries.map((e) => (
              <option key={e.h} value={e.h}>
                +{e.h} h
              </option>
            ))}
          </select>
        </label>
      </div>
      {!entry ? (
        <p className="muted">No reliability data for this spot.</p>
      ) : (
        <>
          <div style={{ height: 260 }}>
            <ResponsiveContainer>
              <ScatterChart margin={{ top: 8, right: 16, left: 0, bottom: 16 }}>
                <CartesianGrid stroke="#e1e0d9" />
                <XAxis type="number" dataKey="pPred" domain={[0, 1]} tickFormatter={(v: number) => `${v * 100}%`} {...AXIS}
                  label={{ value: "Forecast probability", position: "insideBottom", offset: -8, fill: "#898781", fontSize: 11 }} />
                <YAxis type="number" dataKey="pObs" domain={[0, 1]} tickFormatter={(v: number) => `${v * 100}%`} {...AXIS} width={44} />
                <ZAxis type="number" dataKey="n" range={[40, 260]} />
                <ReferenceLine segment={[{ x: 0, y: 0 }, { x: 1, y: 1 }]} stroke="#898781" strokeDasharray="4 3" />
                <Tooltip
                  formatter={(v, n) => [n === "n" ? String(v) : `${(Number(v) * 100).toFixed(0)}%`, n === "pPred" ? "Forecast" : n === "pObs" ? "Observed" : "Forecasts in bin"]}
                />
                <Scatter data={entry.bins} fill="#2a78d6" stroke="#fcfcfb" strokeWidth={2} isAnimationActive={false} />
              </ScatterChart>
            </ResponsiveContainer>
          </div>
          <p className="small">
            Brier score {brierFmt(entry.brier)} (persistence {brierFmt(entry.brierPersistence)}); Brier skill{" "}
            <strong>{entry.brierPersistence > 0 ? (1 - entry.brier / entry.brierPersistence).toFixed(2) : "–"}</strong>. Dot
            size = number of forecasts.
          </p>
        </>
      )}
    </div>
  );
}

export function Tradeoff({
  proof,
  spots,
  dateOnlySpots,
}: {
  proof: Proof;
  spots: Spot[];
  /** Spots with at least one date-only official issue time (SPEC §8.2). */
  dateOnlySpots: Set<string>;
}) {
  const spotKeys = Object.keys(proof.tradeoff);
  const [spot, setSpot] = useState(spotKeys.includes("osney") ? "osney" : (spotKeys[0] ?? ""));
  // ci90 is read as the 90% bootstrap interval of meanLeadH (proposed wording in #38).
  const rows = [...(proof.tradeoff[spot] ?? [])]
    .sort((a, b) => a.pStar - b.pStar)
    .map((r) => ({
      ...r,
      leadErr:
        r.ci90 && r.meanLeadH != null
          ? [Math.max(r.meanLeadH - r.ci90[0], 0), Math.max(r.ci90[1] - r.meanLeadH, 0)]
          : undefined,
    }));
  const anyCi = rows.some((r) => r.ci90);
  const official = proof.officialOutcome?.[spot];
  const name = (k: string) => spots.find((s) => s.key === k)?.name ?? k;
  return (
    <div className="card">
      <h2>Lead time vs false alarms</h2>
      <p className="sub">
        Each point is a trigger probability p*. Lower p* gives earlier warning but more false alarms.
        The dashed zero line is the official EA warning time.
        {official?.meanLeadH != null && " The purple dot is the official EA Flood Warnings themselves, scored the same way."}
        {anyCi && " Whiskers: 90% bootstrap interval over events."}
      </p>
      {dateOnlySpots.has(spot) && (
        <div className="notice warn">
          Some official issue times for this spot are known to the day only, so "vs official" for
          those events is compared in whole days (multiples of 24 h).
        </div>
      )}
      <div className="controls">
        <label>
          Spot
          <select value={spot} onChange={(e) => setSpot(e.target.value)}>
            {spotKeys.map((k) => (
              <option key={k} value={k}>
                {name(k)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div style={{ height: 240 }}>
        <ResponsiveContainer>
          <LineChart data={rows} margin={{ top: 8, right: 16, left: 0, bottom: 16 }}>
            {GRID}
            <XAxis dataKey="falseAlarms" type="number" allowDecimals={false} {...AXIS}
              label={{ value: "False alarms over the backtest", position: "insideBottom", offset: -8, fill: "#898781", fontSize: 11 }} />
            <YAxis {...AXIS} width={44} tickFormatter={(v: number) => `${v} h`} />
            <Tooltip
              labelFormatter={(fa) => `${fa} false alarms`}
              formatter={(v, n, item) => {
                const p = (item?.payload as { pStar?: number } | undefined)?.pStar;
                return [v == null ? "–" : `${Number(v).toFixed(1)} h`, `${String(n)} (p* ${p != null ? Math.round(p * 100) : "?"}%)`];
              }}
            />
            <Legend verticalAlign="top" wrapperStyle={{ fontSize: 12, paddingBottom: 6 }} />
            <ReferenceLine y={0} stroke="#6250d6" strokeDasharray="5 3" label={{ value: "Official warning", position: "insideBottomRight", fill: "#6250d6", fontSize: 11 }} />
            <Line dataKey="meanLeadH" name="Mean lead before flooding" stroke={SERIES[0]} strokeWidth={2} dot={{ r: 4 }} isAnimationActive={false} connectNulls>
              {anyCi && <ErrorBar dataKey="leadErr" direction="y" width={6} stroke={SERIES[0]} strokeWidth={1.5} isAnimationActive={false} />}
            </Line>
            <Line dataKey="meanLeadVsOfficialH" name="Mean lead vs official warning" stroke={SERIES[1]} strokeWidth={2} dot={{ r: 4 }} isAnimationActive={false} connectNulls />
            {official?.meanLeadH != null && (
              <ReferenceDot
                x={official.falseAlarms}
                y={official.meanLeadH}
                r={6}
                fill="#6250d6"
                stroke="#fcfcfb"
                strokeWidth={2}
                ifOverflow="extendDomain"
                label={{ value: "EA warnings", position: "right", fill: "#6250d6", fontSize: 11, fontWeight: 600 }}
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="table-scroll">
        <table className="data">
          <thead>
            <tr>
              <th>p*</th>
              <th>Hits</th>
              <th>Misses</th>
              <th>False alarms</th>
              <th>Mean lead</th>
              <th>vs official</th>
              <th>Mean lead, 90% interval</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.pStar}>
                <td className="num">{Math.round(r.pStar * 100)}%</td>
                <td className="num">{r.hits}</td>
                <td className="num">{r.misses}</td>
                <td className="num">{r.falseAlarms}</td>
                <td className="num">{r.meanLeadH == null ? "–" : `${r.meanLeadH.toFixed(1)} h`}</td>
                <td className="num">{r.meanLeadVsOfficialH == null ? "–" : `${r.meanLeadVsOfficialH.toFixed(1)} h`}</td>
                <td className="num">{r.ci90 ? `${r.ci90[0].toFixed(1)} to ${r.ci90[1].toFixed(1)} h` : "–"}</td>
              </tr>
            ))}
            {official && (
              <tr style={{ color: "#6250d6", fontWeight: 600 }}>
                <td>EA warnings</td>
                <td className="num">{official.hits}</td>
                <td className="num">{official.misses}</td>
                <td className="num">{official.falseAlarms}</td>
                <td className="num">{official.meanLeadH == null ? "–" : `${official.meanLeadH.toFixed(1)} h`}</td>
                <td className="num">–</td>
                <td className="num">–</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
