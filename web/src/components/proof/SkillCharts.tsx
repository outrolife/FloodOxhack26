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
import { FLOOD_EPISODE_NOTE, FLOOD_EPISODE_RULE, FLOOD_EPISODES } from "../shared/episodes";
import { DIRECTION_TERM, coverageSummary } from "./coverage";
import { TERM_TIPS, hoursWords } from "../../lib/plain";

const AXIS = { stroke: "#c3c2b7", tick: { fill: "#52514e", fontSize: 12 } };
const GRID = <CartesianGrid stroke="#e1e0d9" vertical={false} />;
const SERIES = ["#2a78d6", "#eb6834", "#1baf7a"]; // categorical slots 1-3, fixed order

export function SkillByLead({ proof }: { proof: Proof }) {
  const rows = [...proof.skillByLead].sort((a, b) => a.h - b.h);
  const losing = rows.filter((r) => r.skill <= 0);
  return (
    <div className="card">
      <h2>Better than a simple guess?</h2>
      <p className="sub">
        How much smaller River Clock's forecast{" "}
        <span
          className="term"
          title="Measured with the pinball loss, a standard score for range forecasts: skill = 1 − model pinball loss / persistence pinball loss. Scored on test-period forecasts no model trained on, all gauges pooled."
        >
          error
        </span>{" "}
        is than <span className="term" title={TERM_TIPS.simpleGuess}>the simple guess</span> "the river stays where it
        is". 25% means a quarter less error. Above 0: River Clock is better. All gauges pooled.
      </p>
      {losing.length > 0 && (
        <div className="notice warn">
          River Clock is <strong>no better</strong> than the simple guess at {losing.map((r) => `${hoursWords(r.h)} ahead`).join(", ")}.
        </div>
      )}
      <div style={{ height: 220 }}>
        <ResponsiveContainer>
          <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            {GRID}
            <XAxis dataKey="h" tickFormatter={(h: number) => hoursWords(h)} {...AXIS} />
            <YAxis tickFormatter={(v: number) => `${Math.round(v * 100)}%`} {...AXIS} width={40} />
            <Tooltip
              formatter={(v) => [`${Math.round(Number(v) * 100)}% less error (skill ${Number(v).toFixed(2)})`, "vs the simple guess"]}
              labelFormatter={(h) => `${hoursWords(Number(h))} ahead`}
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
  const summary = coverageSummary(proof.coverage);
  const flagged = summary?.flagged ?? [];
  return (
    <div className="card">
      <h2>Do our ranges hold the real level?</h2>
      <p className="sub">
        How often the real river level ended up inside our 50%, 80% and 90% forecast ranges. Dashed
        lines: where they should be.
      </p>
      {summary && (
        // Lead with the plain message (#103). Over-cover (cautious) is not a failure, so it
        // gets the neutral box; only too-narrow ranges get the warning colour.
        <div
          className={summary.direction === "narrow" || summary.direction === "mixed" ? "notice warn" : "notice"}
          title={DIRECTION_TERM[summary.direction]}
        >
          <strong>{summary.headline}</strong>
          <div>Over every test hour (most of them calm days), {summary.detail}</div>
          {flagged.length > 0 && (
            <details className="small">
              <summary>Details: {flagged.length} of {proof.coverage.length} checks more than 10 points from their target</summary>
              More than 10 points away from the target:{" "}
              {flagged
                .map((c) => `${Math.round(c.nominal * 100)}% range at +${c.h} h (${Math.round(c.actual * 100)}%)`)
                .join("; ")}
              .
            </details>
          )}
        </div>
      )}
      <div style={{ height: 220 }}>
        <ResponsiveContainer>
          <LineChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            {GRID}
            <XAxis dataKey="h" tickFormatter={(h: number) => hoursWords(h)} {...AXIS} />
            <YAxis domain={[0, 100]} tickFormatter={(v: number) => `${v}%`} {...AXIS} width={40} />
            <Tooltip formatter={(v, n) => [`${Number(v).toFixed(0)}%`, String(n)]} labelFormatter={(h) => `${hoursWords(Number(h))} ahead`} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {nominals.map((n, i) => (
              <ReferenceLine key={`r${n}`} y={n * 100} stroke={SERIES[i % 3]} strokeDasharray="4 3" strokeOpacity={0.6} />
            ))}
            {nominals.map((n, i) => (
              <Line
                key={n}
                dataKey={`n${Math.round(n * 100)}`}
                name={`${Math.round(n * 100)}% range`}
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

/** "Flood-chance error 11% lower than the simple guess." / "... 17% higher ..." (#103, audit P10). */
export function brierSentence(brier: number, brierPersistence: number): string {
  if (!(brierPersistence > 0)) return "No simple-guess score to compare with here.";
  const skill = 1 - brier / brierPersistence;
  const pc = Math.round(Math.abs(skill) * 100);
  if (pc === 0) return "Flood-chance error about the same as the simple guess.";
  return skill > 0
    ? `Flood-chance error ${pc}% lower than the simple guess.`
    : `Flood-chance error ${pc}% higher than the simple guess here: worse, not better.`;
}

/** Brier scores on rare floods are tiny (0.001): show two significant figures, not three decimals. */
const brierFmt = (v: number): string => (v > 0 && v < 0.01 ? v.toPrecision(2) : v.toFixed(3));

export function Reliability({ proof, spots }: { proof: Proof; spots: Spot[] }) {
  const spotKeys = Object.keys(proof.reliability);
  const [spot, setSpot] = useState(spotKeys.includes("botley") ? "botley" : (spotKeys[0] ?? ""));
  const entries = proof.reliability[spot] ?? [];
  const [h, setH] = useState<number>(entries.find((e) => e.h === 24)?.h ?? entries[0]?.h ?? 24);
  const entry = entries.find((e) => e.h === h) ?? entries[0];
  const name = (k: string) => spots.find((s) => s.key === k)?.name ?? k;

  return (
    <div className="card">
      <h2>When we say 30%, does it flood 30% of the time?</h2>
      <p className="sub">
        Dots on the dashed diagonal mean our chances are honest. Most of the time the chance is near 0% and nothing
        floods (the big dot at the bottom left).
      </p>
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
          Hours ahead
          <select value={entry?.h ?? h} onChange={(e) => setH(Number(e.target.value))}>
            {entries.map((e) => (
              <option key={e.h} value={e.h}>
                {hoursWords(e.h)}
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
                  label={{ value: "Chance River Clock gave", position: "insideBottom", offset: -8, fill: "#52514e", fontSize: 12 }} />
                <YAxis type="number" dataKey="pObs" domain={[0, 1]} tickFormatter={(v: number) => `${v * 100}%`} {...AXIS} width={44}
                  label={{ value: "How often it flooded", angle: -90, position: "insideLeft", fill: "#52514e", fontSize: 12 }} />
                <ZAxis type="number" dataKey="n" range={[40, 260]} />
                <ReferenceLine segment={[{ x: 0, y: 0 }, { x: 1, y: 1 }]} stroke="#898781" strokeDasharray="4 3" />
                <Tooltip
                  formatter={(v, n) => [n === "n" ? String(v) : `${(Number(v) * 100).toFixed(0)}%`, n === "pPred" ? "Chance given" : n === "pObs" ? "How often it flooded" : "Number of forecasts"]}
                />
                <Scatter data={entry.bins} fill="#2a78d6" stroke="#fcfcfb" strokeWidth={2} isAnimationActive={false} />
              </ScatterChart>
            </ResponsiveContainer>
          </div>
          <p className="small">
            {brierSentence(entry.brier, entry.brierPersistence)}{" "}
            <span className="muted">
              (<span className="term" title="Brier score: the average squared gap between our chance (0–1) and what happened (0 or 1). 0 is perfect; lower is better.">Brier score</span>{" "}
              {brierFmt(entry.brier)}, simple guess {brierFmt(entry.brierPersistence)}.) Bigger dot = more forecasts.
            </span>
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
  const [spot, setSpot] = useState(spotKeys.includes("botley") ? "botley" : (spotKeys[0] ?? ""));
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
      <h2>Earlier warning means more false alarms</h2>
      <p className="sub">
        Each dot is a different "act when the chance reaches X%" rule. Acting at a lower chance warns
        you earlier but cries wolf more often.
        {official?.meanLeadH != null && " Purple dot: the official Environment Agency Flood Warnings, scored the same way."}
        {anyCi && (
          <>
            {" "}
            <span className="term" title="90% bootstrap interval: we re-ran the scoring on random re-samples of the past floods; 9 in 10 results fell inside the whisker.">
              Whiskers
            </span>
            : how much this could change with different floods.
          </>
        )}
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
              label={{ value: "False alarms over the past floods", position: "insideBottom", offset: -8, fill: "#52514e", fontSize: 12 }} />
            <YAxis {...AXIS} width={44} tickFormatter={(v: number) => `${v} h`}
              label={{ value: "Hours of warning", angle: -90, position: "insideLeft", fill: "#52514e", fontSize: 12 }} />
            <Tooltip
              labelFormatter={(fa) => `${fa} false alarms`}
              formatter={(v, n, item) => {
                const p = (item?.payload as { pStar?: number } | undefined)?.pStar;
                return [v == null ? "–" : `${Number(v).toFixed(1)} hours`, `${String(n)} (act at ${p != null ? Math.round(p * 100) : "?"}%)`];
              }}
            />
            {/* One meaning per chart (#103, audit P12): only hours of warning before the flood.
                "Ahead of the official warning" has a different zero, so it lives in the table. */}
            <Line dataKey="meanLeadH" name="Average warning before the flood" stroke={SERIES[0]} strokeWidth={2} dot={{ r: 4 }} isAnimationActive={false} connectNulls>
              {anyCi && <ErrorBar dataKey="leadErr" direction="y" width={6} stroke={SERIES[0]} strokeWidth={1.5} isAnimationActive={false} />}
            </Line>
            {official?.meanLeadH != null && (
              <ReferenceDot
                x={official.falseAlarms}
                y={official.meanLeadH}
                r={6}
                fill="#6250d6"
                stroke="#fcfcfb"
                strokeWidth={2}
                ifOverflow="extendDomain"
                label={{ value: "EA warnings", position: "right", fill: "#6250d6", fontSize: 12, fontWeight: 600 }}
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="table-scroll">
        <table className="data">
          <thead>
            <tr>
              <th title="Act when the chance of flooding reaches this (p*)">Act at</th>
              <th>Caught*</th>
              <th>Missed*</th>
              <th>False alarms</th>
              <th>Average warning</th>
              <th>Ahead of official (− = later)</th>
              <th>Average warning, likely range</th>
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
                <td className="num">{r.meanLeadVsOfficialH == null ? "–" : `${r.meanLeadVsOfficialH > 0 ? "+" : ""}${r.meanLeadVsOfficialH.toFixed(1)} h`}</td>
                <td className="num">{r.ci90 ? `${r.ci90[0].toFixed(1)} to ${r.ci90[1].toFixed(1)} h` : "–"}</td>
              </tr>
            ))}
            {official && (
              <tr style={{ color: "#6250d6", fontWeight: 600 }}>
                <td>Official EA warnings</td>
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
      <p className="small muted" title={FLOOD_EPISODE_RULE}>
        * Caught and missed count {FLOOD_EPISODES}
        {rows.length > 0 && `: ${rows[0].hits + rows[0].misses} at ${name(spot)}`}. {FLOOD_EPISODE_NOTE}
      </p>
    </div>
  );
}
