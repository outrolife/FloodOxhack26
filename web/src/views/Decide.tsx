// Decide tab (SPEC §10.2 Decide, issue #15). All maths lives in
// lib/costLoss.ts; this view only wires data and controls to it.
import { useEffect, useMemo, useState } from "react";
import { loadData, loadLive, useData, type Source } from "../data";
import { formatDateTime } from "../time";
import {
  PRESETS,
  advice,
  expectedCosts,
  formatPct,
  liveProbability,
  officialFromProof,
  optimalTrigger,
  type Costs,
  type Forecast,
} from "../lib/costLoss";
import type { Proof, Spot } from "../contracts";
import { CostChart } from "../components/decide/CostChart";
import { OutcomesTable } from "../components/decide/Outcomes";
import { FixtureNotice } from "../components/shared/DataNotice";
import { FLOOD_EPISODES, FLOOD_EPISODE_NOTE, FLOOD_EPISODE_RULE } from "../components/shared/episodes";
import { formatCount, formatGBP, niceRound } from "../components/decide/format";
import { costTakeaway } from "../components/decide/takeaway";

/** The demo opens on Botley Road, the spot judges know (#103). */
const DEFAULT_SPOT = "botley";

/** A costlier example for the sliders (user inputs, not results): trigger 30%. */
const COSTLY_EXAMPLE = { C: 3_000, L: 10_000 };

// The slices of the §9 contracts this tab reads.
type ProofSlice = Pick<Proof, "tradeoff" | "officialOutcome">;
type SpotSlice = Pick<Spot, "key" | "name" | "mode">;

type LiveState =
  | { status: "loading" }
  | { status: "none" }
  | { status: "ready"; forecast: Forecast; origin: "api" | Source };

const LIVE_LEAD_H = 24;

// Log-scale sliders: position is log10(£).
const C_RANGE = [0, 5] as const; // £1 .. £100,000
const L_RANGE = [1, 6] as const; // £10 .. £1,000,000

function useLiveForecast(): LiveState {
  const [state, setState] = useState<LiveState>({ status: "loading" });
  useEffect(() => {
    let alive = true;
    (async () => {
      const api = await loadLive<Forecast>();
      if (api) return alive && setState({ status: "ready", forecast: api, origin: "api" });
      try {
        const snap = await loadData<Forecast>("live.json");
        if (alive) setState({ status: "ready", forecast: snap.value, origin: snap.source });
      } catch {
        if (alive) setState({ status: "none" });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  return state;
}

function LogSlider({ label, value, range, onChange }: { label: string; value: number; range: readonly [number, number]; onChange: (v: number) => void }) {
  return (
    <label style={{ display: "grid", gridTemplateColumns: "11rem 1fr 6.5rem", gap: "0.6rem", alignItems: "center" }}>
      <span>{label}</span>
      <input
        type="range"
        min={range[0]}
        max={range[1]}
        step={0.01}
        value={Math.log10(Math.max(value, 10 ** range[0]))}
        onChange={(e) => onChange(Math.max(1, niceRound(10 ** Number(e.target.value))))}
        aria-valuetext={formatGBP(value)}
      />
      <strong style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatGBP(value)}</strong>
    </label>
  );
}

export default function Decide() {
  const proof = useData<ProofSlice>("proof.json");
  const spots = useData<SpotSlice[]>("spots.json");
  const live = useLiveForecast();

  const [costs, setCosts] = useState<Costs>({ C: PRESETS[0].C, L: PRESETS[0].L });
  const [spotKey, setSpotKey] = useState<string | null>(null);

  // Spot list: spots.json, else whatever proof.tradeoff has.
  const spotList: SpotSlice[] = useMemo(() => {
    if (spots.status === "ready") return spots.data;
    if (proof.status === "ready")
      return Object.keys(proof.data.tradeoff).map((key) => ({ key, name: key, mode: "probability" as const }));
    return [];
  }, [spots, proof]);

  const tradeoff = proof.status === "ready" ? proof.data.tradeoff : {};
  const spot =
    spotKey ??
    (tradeoff[DEFAULT_SPOT]?.length ? DEFAULT_SPOT : undefined) ??
    spotList.find((s) => tradeoff[s.key]?.length)?.key ??
    spotList[0]?.key ??
    null;
  const spotName = spotList.find((s) => s.key === spot)?.name ?? spot ?? "";

  const pStar = optimalTrigger(costs);
  // Official warnings: read from proof.officialOutcome only, never re-derived (#99).
  const official = proof.status === "ready" && spot ? officialFromProof(proof.data, spot) : null;
  const result = useMemo(() => {
    if (proof.status !== "ready" || !spot) return null;
    const counts = official ? { hits: official.hits, misses: official.misses, falseAlarms: official.falseAlarms } : null;
    return expectedCosts({ rows: proof.data.tradeoff[spot] ?? [], costs, official: counts });
  }, [proof, spot, costs, official]);

  const liveP = liveProbability(live.status === "ready" ? live.forecast : null, spot ?? "", LIVE_LEAD_H);
  const adv = advice(pStar, liveP);
  const o = result?.outcomes ?? null;
  const activePreset = PRESETS.find((p) => p.C === costs.C && p.L === costs.L)?.id;

  return (
    <>
      {/* The backtest numbers and spot names come from these files: flag them when they are fixtures (#56). */}
      <FixtureNotice
        sources={[proof.status === "ready" ? proof.source : undefined, spots.status === "ready" ? spots.source : undefined]}
      />
      <section className="card">
        <h2>Decide: is it worth acting?</h2>
        <p className="sub">
          Acting costs <em>C</em>. Not acting when the flood comes loses <em>L</em>. With a calibrated probability{" "}
          <em>P</em>, acting pays off when <em>P</em> × <em>L</em> ≥ <em>C</em>, so the best trigger is{" "}
          <strong>p* = C / L</strong>.
        </p>
        <div className="controls" role="group" aria-label="Presets">
          {PRESETS.map((p) => (
            <button key={p.id} className="btn" aria-pressed={activePreset === p.id} onClick={() => setCosts({ C: p.C, L: p.L })}>
              {p.label} <span className="small">({p.action}: {formatGBP(p.C)} / {formatGBP(p.L)})</span>
            </button>
          ))}
        </div>
        <h3 style={{ marginTop: "0.6rem" }}>Try your own costs</h3>
        <p className="small muted">
          Drag the sliders: what acting costs you, and what a flood would cost you if you hadn't acted. Or{" "}
          <button
            className="btn"
            aria-pressed={costs.C === COSTLY_EXAMPLE.C && costs.L === COSTLY_EXAMPLE.L}
            onClick={() => setCosts(COSTLY_EXAMPLE)}
          >
            try a costly action ({formatGBP(COSTLY_EXAMPLE.C)} to protect {formatGBP(COSTLY_EXAMPLE.L)})
          </button>
        </p>
        <div style={{ display: "grid", gap: "0.4rem", maxWidth: 640 }}>
          <LogSlider label="Cost of acting, C" value={costs.C} range={C_RANGE} onChange={(C) => setCosts((c) => ({ ...c, C }))} />
          <LogSlider label="Loss if flooded, L" value={costs.L} range={L_RANGE} onChange={(L) => setCosts((c) => ({ ...c, L }))} />
        </div>
        <p style={{ marginTop: "0.8rem" }}>
          Your trigger: <span className="big">p* = {formatPct(pStar)}</span>
          {pStar >= 1 && <span className="muted"> (acting never pays off when C ≥ L)</span>}
        </p>
      </section>

      <section className="card advice" aria-live="polite">
        <div className="controls">
          <label>
            Spot
            <select value={spot ?? ""} onChange={(e) => setSpotKey(e.target.value)}>
              {spotList.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p>
          {adv.head}
          {pStar < 1 && (
            <>
              {" "}
              Now ({LIVE_LEAD_H} h ahead):{" "}
              {liveP.status === "ok" ? (
                <>
                  {formatPct(liveP.p)} →{" "}
                  <span className={adv.act ? "act" : "wait"}>{adv.act ? "act" : "don't act yet"}</span>.
                </>
              ) : (
                <span className="muted">{adv.now}</span>
              )}
            </>
          )}
        </p>
        <p className="muted small">
          {live.status === "loading" && "Loading live forecast…"}
          {live.status === "none" && "Live data unavailable."}
          {live.status === "ready" &&
            `Forecast issued ${formatDateTime(live.forecast.issuedAt)} · ${
              live.origin === "api" ? "live API" : live.origin === "data" ? "latest saved forecast (live.json)" : "sample data (offline fixture), not today's river"
            }.`}
        </p>
      </section>

      <section className="card">
        <h2>Over the backtest at {spotName ? `${spotName}, ` : ""}p* = {formatPct(pStar)}</h2>
        {proof.status === "loading" && <p className="muted">Loading backtest…</p>}
        {proof.status === "error" && <p className="notice warn">Backtest results unavailable: {proof.error}</p>}
        {result && (
          <>
            {o?.clamped && (
              <p className="notice">
                Your p* is {o.clamped} the backtested triggers, so FloodClock's outcomes are those at p* ={" "}
                {formatPct(o.pStarUsed)}. The cost bars still use your C and L.
              </p>
            )}
            {o ? (
              <OutcomesTable o={o} costs={costs} official={official} />
            ) : (
              <p className="muted">No FloodClock backtest outcomes for this spot yet.</p>
            )}

            <h3 style={{ marginTop: "1rem" }}>
              Total cost over the {formatCount(result.crossings)} past {FLOOD_EPISODES}*
            </h3>
            <CostChart strategies={result.strategies} costs={costs} best={result.best} />
            {costTakeaway(result.strategies, pStar) && (
              <p className="decide-takeaway">{costTakeaway(result.strategies, pStar)}</p>
            )}
            <p className="small muted" title={FLOOD_EPISODE_RULE}>* {FLOOD_EPISODE_NOTE}</p>
            <details className="small muted" style={{ marginTop: "0.5rem" }}>
              <summary>How the costs are counted</summary>
              <p>
                Each hit or false alarm costs C; each miss costs L. <strong>FloodClock</strong>: act when the forecast
                reaches p* (outcomes interpolated from the backtest). <strong>Official warnings</strong>: act on every EA
                Flood Warning for the spot's area (alerts don't count);{" "}
                {official
                  ? "scored with the same rules as FloodClock (a warning issued after the river went over the flood line is a miss)."
                  : "not scored: we have no scored record of official warnings for this spot."}{" "}
                <strong>Never act</strong>: every flood is a miss.{" "}
                <strong>Always act</strong>: act on every flood and on every false-alarm episode the most sensitive
                trigger flagged; a lower bound, since acting literally all the time would cost more.
              </p>
            </details>
          </>
        )}
      </section>
    </>
  );
}
