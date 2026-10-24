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
import { costComparison, costTakeaway } from "../components/decide/takeaway";
import { TabHeadline } from "../components/shared/TabHeadline";
import { decideVerdict } from "../lib/headlines";

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
  const preset = PRESETS.find((p) => p.C === costs.C && p.L === costs.L);
  const activePreset = preset?.id;
  const comparison = result ? costComparison(result.strategies, result.crossings, spotName) : null;

  return (
    <>
      {/* The backtest numbers and spot names come from these files: flag them when they are fixtures (#56). */}
      <FixtureNotice
        sources={[proof.status === "ready" ? proof.source : undefined, spots.status === "ready" ? spots.source : undefined]}
      />
      {/* Verdict first (#103): who you are, when to act, and what to do right now. */}
      <TabHeadline
        h={decideVerdict({
          who: preset ? `${preset.label} (${preset.action}: ${formatGBP(preset.C)} to protect ${formatGBP(preset.L)})` : null,
          C: costs.C,
          L: costs.L,
          pStar,
          spotName,
          liveP: liveP.status === "ok" ? liveP.p : null,
          liveH: LIVE_LEAD_H,
          liveReason: liveP.status === "ok" ? undefined : adv.now.replace(/\.$/, "").replace(/^No/, "no"),
          gbp: formatGBP,
        })}
      >
        {comparison && <p className="tab-headline-detail">{comparison}</p>}
      </TabHeadline>

      <section className="card">
        <h2>Is it worth acting?</h2>
        <div className="controls" role="group" aria-label="Who are you?">
          {PRESETS.map((p) => (
            <button key={p.id} className="btn" aria-pressed={activePreset === p.id} onClick={() => setCosts({ C: p.C, L: p.L })}>
              {p.label}: {p.action} <span className="small">(costs {formatGBP(p.C)}, protects {formatGBP(p.L)})</span>
            </button>
          ))}
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
        <div>
          Act once the chance of flooding reaches <span className="big">{formatPct(pStar)}</span>
          {pStar >= 1 && <span className="muted"> (acting costs as much as the loss, so it never pays)</span>}{" "}
          <details className="why">
            <summary>Why?</summary>
            Acting costs you <em>C</em> ({formatGBP(costs.C)}). Not acting when it floods costs <em>L</em> (
            {formatGBP(costs.L)}). If the chance of flooding is <em>P</em>, waiting costs <em>P</em> × <em>L</em> on
            average, so acting wins once <em>P</em> × <em>L</em> is more than <em>C</em>: at <em>P</em> = <em>C</em> ÷{" "}
            <em>L</em> = {formatPct(pStar)} (the act-at chance, <em>p*</em>). This only works if our chances are honest
            (when we say 30%, it floods about 30% of the time); the Proof tab checks that.
          </details>
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
          <LogSlider label="What acting costs you" value={costs.C} range={C_RANGE} onChange={(C) => setCosts((c) => ({ ...c, C }))} />
          <LogSlider label="What you'd lose if it floods" value={costs.L} range={L_RANGE} onChange={(L) => setCosts((c) => ({ ...c, L }))} />
        </div>
        <p className="muted small" style={{ marginTop: "0.6rem" }}>
          {live.status === "loading" && "Loading the latest forecast…"}
          {live.status === "none" && "No forecast available right now."}
          {live.status === "ready" &&
            `Forecast made ${formatDateTime(live.forecast.issuedAt)}${
              live.origin === "fixture" ? " · sample data, not today's river" : ""
            }.`}
        </p>
      </section>

      <section className="card">
        <h2>If you'd used this rule in past floods{spotName ? ` (${spotName}, act at ${formatPct(pStar)})` : ""}</h2>
        {proof.status === "loading" && <p className="muted">Loading backtest…</p>}
        {proof.status === "error" && <p className="notice warn">Backtest results unavailable: {proof.error}</p>}
        {result && (
          <>
            {o?.clamped && (
              <p className="notice">
                We tested act-at chances from the lowest to the highest in the results, and yours is {o.clamped} them, so
                River Clock's results use the nearest one we tested ({formatPct(o.pStarUsed)}). Costs still use your amounts.
              </p>
            )}
            {o ? (
              <OutcomesTable o={o} costs={costs} official={official} />
            ) : (
              <p className="muted">No River Clock backtest outcomes for this spot yet.</p>
            )}

            <h3 style={{ marginTop: "1rem" }}>
              What each approach would have cost over {formatCount(result.crossings)} past {FLOOD_EPISODES}*
            </h3>
            <CostChart strategies={result.strategies} costs={costs} best={result.best} />
            {costTakeaway(result.strategies, pStar) && (
              <p className="decide-takeaway">{costTakeaway(result.strategies, pStar)}</p>
            )}
            <p className="small muted" title={FLOOD_EPISODE_RULE}>* {FLOOD_EPISODE_NOTE}</p>
            <details className="small muted" style={{ marginTop: "0.5rem" }}>
              <summary>How the costs are counted</summary>
              <p>
                Each time you act costs C; each flood you miss costs L. <strong>River Clock</strong>: act when the forecast
                reaches p* (outcomes interpolated from the backtest). <strong>Official warnings</strong>: act on every EA
                Flood Warning for the spot's area (alerts don't count);{" "}
                {official
                  ? "scored with the same rules as River Clock (a warning issued after the river went over the flood line is a miss)."
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
