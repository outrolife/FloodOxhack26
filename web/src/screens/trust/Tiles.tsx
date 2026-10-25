// The three big tiles of "How good is it?" (#123). Light SVG and CSS bars,
// no chart library: one visual and one caption per tile, values from trust.ts.
// Palette: blue (--series-1) = River Clock, orange (--series-2) = the baseline.
import { useId, useState, type ReactNode } from "react";
import type { Proof, Spot } from "../../contracts";
import {
  POOLED,
  VERDICT_TEXT,
  binsAt,
  caughtText,
  leadWords,
  oddsCaption,
  oddsVerdict,
  officialComparison,
  pct,
  perEventVsOfficial,
  pickInformativeBin,
  pooledNote,
  reliabilitySpots,
  shortName,
  topBinNote,
  triggerPhrase,
  vsOfficialLabel,
  vsOfficialSummary,
  type BeatsTile as BeatsData,
  type Bin,
  type EarlyTile as EarlyData,
} from "./trust";

function Tile({ kicker, children, id }: { kicker: string; children: ReactNode; id: string }) {
  return (
    <section className="trust-tile" aria-labelledby={id}>
      <h2 className="trust-kicker" id={id}>
        {kicker}
      </h2>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------- 1

export function BeatsTile({ data, proof }: { data: BeatsData | null; proof: Proof }) {
  const id = useId();
  if (!data) {
    return (
      <Tile kicker="Beats 'nothing changes'" id={id}>
        <p className="muted">No skill scores in proof.json yet.</p>
      </Tile>
    );
  }
  const win = data.skillPct > 0;
  return (
    <Tile kicker="Beats 'nothing changes'" id={id}>
      <div className={`trust-big ${win ? "is-model" : ""}`}>
        {data.skillPct}%
        <span className="trust-big-unit">{win ? "more accurate" : "skill"}</span>
      </div>
      <p className="trust-caption">{data.caption}.</p>
      <div
        className="trust-bars"
        role="img"
        aria-label={`Average forecast error ${leadWords(data.h)} ahead: River Clock ${data.model.toFixed(4)} m, the river stays the same ${data.baseline.toFixed(4)} m.`}
      >
        <div className="trust-bar-row">
          <span className="trust-bar-label">River Clock's error</span>
          <span className="trust-bar-track">
            <span className="trust-bar is-model" style={{ width: `${Math.min(100, data.ratio * 100)}%` }} />
          </span>
        </div>
        <div className="trust-bar-row">
          <span className="trust-bar-label">"Nothing changes" error</span>
          <span className="trust-bar-track">
            <span className="trust-bar is-baseline" style={{ width: `${Math.min(100, 100 / Math.max(data.ratio, 1))}%` }} />
          </span>
        </div>
      </div>
      <SkillSparkline trend={data.trend} highlightH={data.h} />
      <p className="trust-note">
        {data.trendText} Shorter bar = smaller error. {cap(pooledNote(proof))}, on test data from after training.
      </p>
    </Tile>
  );
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

function SkillSparkline({ trend, highlightH }: { trend: { h: number; skill: number }[]; highlightH: number }) {
  if (trend.length < 2) return null;
  const W = 300;
  const H = 64;
  const pad = { l: 8, r: 8, t: 14, b: 16 };
  const hMax = Math.max(...trend.map((r) => r.h));
  const hMin = Math.min(...trend.map((r) => r.h));
  const sMax = Math.max(0.05, ...trend.map((r) => r.skill));
  const sMin = Math.min(0, ...trend.map((r) => r.skill));
  const x = (h: number) => pad.l + ((h - hMin) / Math.max(1, hMax - hMin)) * (W - pad.l - pad.r);
  const y = (s: number) => pad.t + ((sMax - s) / (sMax - sMin)) * (H - pad.t - pad.b);
  const pts = trend.map((r) => `${x(r.h).toFixed(1)},${y(r.skill).toFixed(1)}`).join(" ");
  const first = trend[0];
  const last = trend[trend.length - 1];
  return (
    <svg
      className="trust-spark"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`Accuracy gain by lead time: ${trend.map((r) => `${leadWords(r.h)} ${pct(r.skill)}%`).join(", ")}.`}
    >
      <line x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} className="trust-axis" />
      <polyline points={pts} className="trust-spark-line" />
      {trend.map((r) => (
        <circle key={r.h} cx={x(r.h)} cy={y(r.skill)} r={r.h === highlightH ? 4.5 : 3} className="trust-spark-dot">
          <title>{`${leadWords(r.h)} ahead: ${pct(r.skill)}% more accurate`}</title>
        </circle>
      ))}
      <text x={x(first.h)} y={y(first.skill) - 5} className="trust-svg-label" textAnchor="start">
        {pct(first.skill)}%
      </text>
      <text x={x(last.h)} y={y(last.skill) - 5} className="trust-svg-label" textAnchor="end">
        {pct(last.skill)}%
      </text>
      <text x={x(first.h)} y={H - 3} className="trust-svg-tick" textAnchor="start">
        {leadWords(first.h)}
      </text>
      <text x={x(last.h)} y={H - 3} className="trust-svg-tick" textAnchor="end">
        {leadWords(last.h)} ahead
      </text>
    </svg>
  );
}

// ---------------------------------------------------------------- 2

export function OddsTile({ proof, spots, h }: { proof: Proof; spots: Spot[]; h: number }) {
  const id = useId();
  const choices = reliabilitySpots(proof, h);
  const [spot, setSpot] = useState<string>(POOLED);
  const bins = binsAt(proof, spot, h) ?? [];
  const chosen = pickInformativeBin(bins);
  const top = topBinNote(bins);
  const label = spot === POOLED ? `all ${choices.length} trouble spots with odds` : shortName(spots.find((s) => s.key === spot), spot);
  return (
    <Tile kicker="Honest odds" id={id}>
      {chosen ? (
        <>
          <div className="trust-big is-model">
            {pct(chosen.pPred)}% <span className="trust-big-arrow" aria-hidden>→</span> {pct(chosen.pObs)}%
            <span className="trust-big-unit">said → happened</span>
          </div>
          <p className="trust-caption">
            {oddsCaption(chosen)} ({chosen.n.toLocaleString("en-GB")} forecast hours, {leadWords(h)} ahead):{" "}
            {VERDICT_TEXT[oddsVerdict(chosen)]}.
          </p>
        </>
      ) : (
        <p className="muted">No reliability scores at {leadWords(h)} in proof.json yet.</p>
      )}
      <ReliabilityDots bins={bins} chosen={chosen} />
      <label className="trust-select">
        Showing{" "}
        <select value={spot} onChange={(e) => setSpot(e.target.value)}>
          <option value={POOLED}>All spots (pooled)</option>
          {choices.map((k) => (
            <option key={k} value={k}>
              {shortName(spots.find((s) => s.key === k), k)}
            </option>
          ))}
        </select>
      </label>
      <p className="trust-note">
        Perfect odds sit on the dashed line. Bigger dot = more forecasts. {spot === POOLED ? `Pooled across ${label}.` : `${label} only.`}{" "}
        {top}
      </p>
    </Tile>
  );
}

function ReliabilityDots({ bins, chosen }: { bins: Bin[]; chosen: Bin | null }) {
  const S = 240;
  const pad = { l: 34, r: 10, t: 10, b: 30 };
  const span = S - pad.l - pad.r;
  const x = (p: number) => pad.l + p * span;
  const y = (p: number) => pad.t + (1 - p) * (S - pad.t - pad.b);
  // Log scale so the thousands of calm hours don't swamp the handful of stormy ones.
  const r = (n: number) => Math.min(13, 3 + 2.4 * Math.log10(Math.max(1, n)));
  const ticks = [0, 0.5, 1];
  return (
    <svg
      className="trust-reliability"
      viewBox={`0 0 ${S} ${S}`}
      role="img"
      aria-label={`Reliability: ${bins.map((b) => `said ${pct(b.pPred)}%, happened ${pct(b.pObs)}% (${b.n})`).join("; ")}.`}
    >
      <rect x={pad.l} y={pad.t} width={span} height={S - pad.t - pad.b} className="trust-plot-bg" />
      {ticks.map((t) => (
        <g key={t}>
          <text x={x(t)} y={S - pad.b + 14} className="trust-svg-tick" textAnchor="middle">
            {pct(t)}%
          </text>
          <text x={pad.l - 5} y={y(t) + 4} className="trust-svg-tick" textAnchor="end">
            {pct(t)}%
          </text>
        </g>
      ))}
      <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} className="trust-diagonal" />
      <text x={x(0.98)} y={y(0.98) + 14} className="trust-svg-tick" textAnchor="end">
        perfect
      </text>
      {bins.map((b, i) => (
        <circle key={i} cx={x(b.pPred)} cy={y(b.pObs)} r={r(b.n)} className={`trust-dot${b === chosen ? " is-chosen" : ""}`}>
          <title>{`We said about ${pct(b.pPred)}%, it flooded ${pct(b.pObs)}% of the time (${b.n.toLocaleString("en-GB")} forecast hours)`}</title>
        </circle>
      ))}
      <text x={pad.l + span / 2} y={S - 2} className="trust-svg-axis" textAnchor="middle">
        We said
      </text>
      <text x={10} y={pad.t + (S - pad.t - pad.b) / 2} className="trust-svg-axis" textAnchor="middle" transform={`rotate(-90 10 ${pad.t + (S - pad.t - pad.b) / 2})`}>
        It flooded
      </text>
    </svg>
  );
}

// ---------------------------------------------------------------- 3

export function EarlyTile({ data, proof }: { data: EarlyData; proof: Proof }) {
  const id = useId();
  if (data.rows.length === 0) {
    return (
      <Tile kicker="Early, without crying wolf" id={id}>
        <p className="muted">No trade-off scores in proof.json yet.</p>
      </Tile>
    );
  }
  const leadMax = Math.max(1, ...data.rows.map((r) => Math.max(r.leadH ?? 0, r.ci90?.[1] ?? 0)));
  const vs = vsOfficialSummary(data.rows);
  const vsMax = Math.max(1, ...data.rows.map((r) => Math.abs(r.vsOfficialH ?? 0)));
  const perEvent = perEventVsOfficial(proof);
  const cmp = officialComparison(data);
  return (
    <Tile kicker="Early, without crying wolf" id={id}>
      <div className="trust-big is-model">
        {data.caught} of {data.floods}
        <span className="trust-big-unit">floods caught</span>
      </div>
      <p className="trust-caption">
        {caughtText(data)}, with {data.falseAlarms} false {data.falseAlarms === 1 ? "alarm" : "alarms"}
        {data.typicalLeadH !== null && <>, and about {Math.round(data.typicalLeadH)} hours of warning before the river crossed (average)</>}.
        Alarm at {triggerPhrase(data.pStar)}.
      </p>

      <h3 className="trust-sub">Warning time before the river crossed</h3>
      <ul className="trust-spots">
        {data.rows.map((r) => (
          <li key={r.spot}>
            <span className="trust-spot-name">{r.name}</span>
            <span className="trust-bar-track" title={r.ci90 ? `90% range ${Math.round(r.ci90[0])}–${Math.round(r.ci90[1])} h` : undefined}>
              {r.leadH !== null && <span className="trust-bar is-model" style={{ width: `${(r.leadH / leadMax) * 100}%` }} />}
              {r.ci90 && (
                <span
                  className="trust-whisker"
                  style={{ left: `${(r.ci90[0] / leadMax) * 100}%`, width: `${((r.ci90[1] - r.ci90[0]) / leadMax) * 100}%` }}
                  aria-hidden
                />
              )}
            </span>
            <span className="trust-spot-value">{r.leadH !== null ? `≈ ${Math.round(r.leadH)} h` : "–"}</span>
            <span className="trust-spot-meta">
              {r.hits}/{r.floods} caught · {r.falseAlarms} false
            </span>
          </li>
        ))}
        {data.noForecast.map((s) => (
          <li key={s.spot} className="is-none">
            <span className="trust-spot-name">{s.name}</span>
            <span className="trust-spot-meta trust-span">
              {s.mode === "timing_only" ? "no flood odds: live-only gauge, timing only" : "not scored"}
            </span>
          </li>
        ))}
      </ul>

      <h3 className="trust-sub">Against the official EA warning</h3>
      {cmp && (
        <>
          <p className="trust-caption">
            {cmp.oursText} · {cmp.officialText}. {cmp.verdict}
          </p>
          <ul className="trust-vs" aria-label="Floods caught and false alarms, River Clock and the official warning, same floods and rules">
            {[
              { who: "River Clock", s: cmp.ours, cls: "is-model" },
              { who: "Official warning", s: cmp.official, cls: "is-official" },
            ].map(({ who, s, cls }) => (
              <li key={who}>
                <span className="trust-spot-name">{who}</span>
                <span className="trust-bar-track">
                  <span className={`trust-bar ${cls}`} style={{ width: `${s.floods ? (s.caught / s.floods) * 100 : 0}%` }} />
                </span>
                <span className="trust-spot-value">
                  {s.caught}/{s.floods}
                </span>
                <span className="trust-spot-meta">
                  {s.falseAlarms} false {s.falseAlarms === 1 ? "alarm" : "alarms"}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="trust-caption">How much earlier, per spot: {vs.text[0].toLowerCase() + vs.text.slice(1)}</p>
      <ul className="trust-diverge" aria-label="Hours ahead of (right) or behind (left) the official warning, per spot">
        {data.rows.map((r) => {
          const v = r.vsOfficialH;
          const w = v === null ? 0 : (Math.abs(v) / vsMax) * 50;
          return (
            <li key={r.spot}>
              <span className="trust-spot-name">{r.name}</span>
              <span className="trust-diverge-track">
                <span className="trust-diverge-mid" aria-hidden />
                {v !== null && (
                  <span
                    className={`trust-diverge-bar ${v >= 0 ? "is-ahead" : "is-behind"}`}
                    style={v >= 0 ? { left: "50%", width: `${w}%` } : { right: "50%", width: `${w}%` }}
                  />
                )}
              </span>
              <span className="trust-spot-value">{vsOfficialLabel(v)}</span>
            </li>
          );
        })}
      </ul>
      <p className="trust-note">
        <span className="trust-legend is-behind" aria-hidden /> behind · ahead <span className="trust-legend is-ahead" aria-hidden />{" "}
        Average per spot, so it is mixed. {perEvent.text} Floods are counted per trouble spot.
      </p>
    </Tile>
  );
}

/** The EA's own record scored with the same rules, for "Show the working". */
export function OfficialOutcome({ data }: { data: EarlyData }) {
  const rows = data.rows.filter((r) => r.official);
  if (!rows.length) return null;
  return (
    <div className="card">
      <h2>River Clock and the official warnings, scored the same way</h2>
      <table className="trust-table">
        <thead>
          <tr>
            <th>Spot</th>
            <th>River Clock caught</th>
            <th>River Clock false alarms</th>
            <th>EA caught</th>
            <th>EA false alarms</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.spot}>
              <td>{r.name}</td>
              <td>
                {r.hits} of {r.floods}
              </td>
              <td>{r.falseAlarms}</td>
              <td>
                {r.official!.hits} of {r.official!.hits + r.official!.misses}
              </td>
              <td>{r.official!.falseAlarms}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="small muted">
        Both are scored on the same floods, hours and rules (how an official warning counts as in force is in the note
        at the bottom). River Clock alarms at {triggerPhrase(data.pStar)}; a lower trigger catches more and cries
        wolf more often.
      </p>
    </div>
  );
}
