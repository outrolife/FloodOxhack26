// Cost-loss decision logic for the Decide tab (SPEC §8.2, §10.2 Decide).
//
// Pure and framework-free: no React, no fetching. Everything here works from
// the static contract files (proof.json, live.json), so it runs offline.
//
// The cost-loss model
// -------------------
// A user can take a protective action that costs C (move the car, close the
// road). If a flood arrives and they did not act, they lose L. With a
// calibrated probability P, acting is worth it when P * L > C, i.e. when
// P >= p* = C / L. That is the optimal trigger.
//
// Expected cost over the backtest, per spot (all four strategies use the same
// per-event cost rule from the spec):
//   - hit (acted, flood came):        C
//   - false alarm (acted, no flood):  C
//   - miss (flood, did not act):      L
//   - quiet period with no action:    0
// so cost = (hits + falseAlarms) * C + misses * L.
//
// Strategies and their assumptions:
//   - River Clock at p*: outcome counts from proof.tradeoff[spot],
//     linearly interpolated at p*. Outside the backtested p* grid the nearest
//     row is used (and flagged as clamped): counts can't be extrapolated
//     because false alarms at very low triggers are unknown.
//   - Official warnings: act whenever an EA Flood Warning (or Severe Flood
//     Warning; Flood Alerts don't count) is issued for the spot's area. Counts
//     and mean lead come from proof.officialOutcome (officialFromProof) only.
//   - Never act: every crossing is a miss. cost = N * L, where N is the number
//     of crossings (hits + misses, from the same interpolated tradeoff row).
//   - Always act: act on every candidate episode, so no misses. Candidate
//     episodes = the N crossings plus the false-alarm episodes flagged by the
//     most permissive trigger in the table (the max falseAlarms over rows).
//     cost = (N + maxFalseAlarms) * C. This is a lower bound on literally
//     acting all the time, which the backtest can't count; it is the cheapest
//     way to never be caught out given the episodes we know about.

// ---- Input types (from the §9 contracts) ----

import type { Forecast, Proof } from "../contracts";

export type { Forecast, SpotForecast } from "../contracts";
export type TradeoffRow = Proof["tradeoff"][string][number];

// ---- Presets ----

export type Costs = { C: number; L: number };

export type Preset = Costs & { id: "resident" | "commuter" | "council"; label: string; action: string };

export const PRESETS: readonly Preset[] = [
  { id: "resident", label: "Resident", action: "move car", C: 20, L: 2_000 },
  { id: "commuter", label: "Commuter", action: "reroute", C: 5, L: 100 },
  { id: "council", label: "Council", action: "close road / barriers", C: 5_000, L: 100_000 },
];

// ---- Optimal trigger ----

/** p* = C / L, clamped to [0, 1]. If L <= 0 there is nothing to protect: p* = 1. */
export function optimalTrigger({ C, L }: Costs): number {
  if (!(L > 0)) return 1;
  if (!(C > 0)) return 0;
  return Math.min(1, C / L);
}

// ---- Tradeoff interpolation ----

export type Counts = { hits: number; misses: number; falseAlarms: number };

export type Outcomes = Counts & {
  /** Mean lead time of hits, hours. null when there are no hits. */
  meanLeadH: number | null;
  /** Mean of (official issue time − our first trigger), hours. */
  meanLeadVsOfficialH: number | null;
  /** The p* the counts actually come from (differs from the request when clamped). */
  pStarUsed: number;
  /** "below"/"above" when p* is outside the backtested grid; counts are from the nearest row. */
  clamped: "below" | "above" | null;
  /** The two backtested p* rows the values are interpolated between, or null when p* is a row. */
  between: [number, number] | null;
};

/**
 * Interpolate tradeoff rows at an arbitrary p*. Counts are linearly
 * interpolated (so they can be fractional). Mean leads are averaged with
 * weights (interpolation weight × hits), i.e. the mean lead of the
 * interpolated hits; a null lead (no hits) contributes nothing.
 * Returns null when there are no rows.
 */
export function interpolateTradeoff(rows: readonly TradeoffRow[], pStar: number): Outcomes | null {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => a.pStar - b.pStar);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (pStar <= first.pStar) return fromRow(first, pStar < first.pStar ? "below" : null);
  if (pStar >= last.pStar) return fromRow(last, pStar > last.pStar ? "above" : null);

  let i = 0;
  while (sorted[i + 1].pStar < pStar) i++;
  const a = sorted[i];
  const b = sorted[i + 1];
  if (b.pStar === pStar) return fromRow(b, null);
  const w = (pStar - a.pStar) / (b.pStar - a.pStar);
  const lerp = (x: number, y: number) => x + (y - x) * w;
  return {
    hits: lerp(a.hits, b.hits),
    misses: lerp(a.misses, b.misses),
    falseAlarms: lerp(a.falseAlarms, b.falseAlarms),
    meanLeadH: weightedLead(a, b, w, "meanLeadH"),
    meanLeadVsOfficialH: weightedLead(a, b, w, "meanLeadVsOfficialH"),
    pStarUsed: pStar,
    clamped: null,
    between: [a.pStar, b.pStar],
  };
}

function fromRow(r: TradeoffRow, clamped: Outcomes["clamped"]): Outcomes {
  return {
    hits: r.hits,
    misses: r.misses,
    falseAlarms: r.falseAlarms,
    meanLeadH: r.meanLeadH,
    meanLeadVsOfficialH: r.meanLeadVsOfficialH,
    pStarUsed: r.pStar,
    clamped,
    between: null,
  };
}

function weightedLead(
  a: TradeoffRow,
  b: TradeoffRow,
  w: number,
  key: "meanLeadH" | "meanLeadVsOfficialH",
): number | null {
  const wa = a[key] === null ? 0 : (1 - w) * a.hits;
  const wb = b[key] === null ? 0 : w * b.hits;
  if (wa + wb > 0) return (wa * (a[key] ?? 0) + wb * (b[key] ?? 0)) / (wa + wb);
  // No hit mass (e.g. zero-hit rows that still report a lead): plain lerp of what exists.
  if (a[key] !== null && b[key] !== null) return a[key]! + (b[key]! - a[key]!) * w;
  return a[key] ?? b[key] ?? null;
}

// ---- Official warnings ----
// The only source is proof.officialOutcome: the backtest scores official
// warnings with the same rules as River Clock (SPEC §8.2). The UI never
// re-derives them (from replays or perEvent), because a second scoring can
// disagree with the backend's (#99). Without officialOutcome the official
// strategy is shown as "not scored".

export type OfficialOutcome = NonNullable<Proof["officialOutcome"]>[string];

/** Official-warning outcomes for one spot straight from proof.officialOutcome, or null if absent. */
export function officialFromProof(proof: Pick<Proof, "officialOutcome">, spot: string): OfficialOutcome | null {
  return proof.officialOutcome?.[spot] ?? null;
}

// ---- Expected cost ----

/** Cost rule from the spec: hit or false alarm costs C; a miss costs L. */
export function totalCost(o: Counts, { C, L }: Costs): number {
  return (o.hits + o.falseAlarms) * C + o.misses * L;
}

export type StrategyKey = "riverClock" | "official" | "neverAct" | "alwaysAct";

export type StrategyCost = {
  key: StrategyKey;
  label: string;
  /** null when the strategy can't be scored (e.g. no official-warning data). */
  counts: Counts | null;
  cost: number | null;
};

export const STRATEGY_LABELS: Record<StrategyKey, string> = {
  riverClock: "FloodClock",
  official: "Official warnings",
  neverAct: "Never act",
  alwaysAct: "Always act",
};

export type ExpectedCostInput = {
  rows: readonly TradeoffRow[];
  costs: Costs;
  /** Official-warning counts for this spot, or null if unknown. */
  official: Counts | null;
  /** p* to evaluate River Clock at; defaults to optimalTrigger(costs). */
  pStar?: number;
};

export type ExpectedCostResult = {
  pStar: number;
  outcomes: Outcomes | null;
  /** Number of crossings in the backtest (hits + misses at p*). */
  crossings: number;
  strategies: StrategyCost[];
  /** Key of the cheapest scored strategy, or null if none are scored. */
  best: StrategyKey | null;
};

/** Expected cost over the backtest for the four strategies (see header). */
export function expectedCosts({ rows, costs, official, pStar }: ExpectedCostInput): ExpectedCostResult {
  const p = pStar ?? optimalTrigger(costs);
  const outcomes = interpolateTradeoff(rows, p);
  const crossings = outcomes ? outcomes.hits + outcomes.misses : 0;
  const maxFalseAlarms = rows.reduce((m, r) => Math.max(m, r.falseAlarms), 0);

  const rc: Counts | null = outcomes
    ? { hits: outcomes.hits, misses: outcomes.misses, falseAlarms: outcomes.falseAlarms }
    : null;
  const never: Counts | null = outcomes ? { hits: 0, misses: crossings, falseAlarms: 0 } : null;
  const always: Counts | null = outcomes ? { hits: crossings, misses: 0, falseAlarms: maxFalseAlarms } : null;

  const entry = (key: StrategyKey, counts: Counts | null): StrategyCost => ({
    key,
    label: STRATEGY_LABELS[key],
    counts,
    cost: counts ? totalCost(counts, costs) : null,
  });
  const strategies = [
    entry("riverClock", rc),
    entry("official", official),
    entry("neverAct", never),
    entry("alwaysAct", always),
  ];

  let best: StrategyKey | null = null;
  let bestCost = Infinity;
  for (const s of strategies) {
    if (s.cost !== null && s.cost < bestCost) {
      bestCost = s.cost;
      best = s.key;
    }
  }
  return { pStar: p, outcomes, crossings, strategies, best };
}

// ---- Live advice ----

export type LiveProbability =
  | { status: "ok"; p: number }
  | { status: "unavailable" | "no-spot" | "stale" | "timing-only" };

/**
 * Flood probability for one spot at lead h (default 24 h) from a Forecast.
 * Uses the exact lead if present, else interpolates linearly between the
 * nearest leads with a pFlood. Leads past the last one are not extrapolated.
 */
export function liveProbability(forecast: Forecast | null, spot: string, h = 24): LiveProbability {
  if (!forecast) return { status: "unavailable" };
  const s = forecast.spots.find((x) => x.spot === spot);
  if (!s) return { status: "no-spot" };
  if (s.mode === "timing_only") return { status: "timing-only" };
  const leads = s.leads
    .filter((l): l is typeof l & { pFlood: number } => l.pFlood !== null)
    .sort((a, b) => a.h - b.h);
  if (leads.length === 0) return { status: "stale" };
  const exact = leads.find((l) => l.h === h);
  if (exact) return { status: "ok", p: exact.pFlood };
  const after = leads.findIndex((l) => l.h > h);
  if (after <= 0) return { status: "stale" }; // h outside the forecast's leads
  const a = leads[after - 1];
  const b = leads[after];
  const w = (h - a.h) / (b.h - a.h);
  return { status: "ok", p: a.pFlood + (b.pFlood - a.pFlood) * w };
}

/** Format a probability as a percentage: one decimal below 10% when needed, else whole. */
export function formatPct(p: number): string {
  const pct = p * 100;
  if (pct > 0 && pct < 10 && Math.abs(pct - Math.round(pct)) > 0.05) return `${pct.toFixed(1)}%`;
  return `${Math.round(pct)}%`;
}

/**
 * text is the full sentence; head is its first part ("At your costs, act when
 * P ≥ X%."); now is the "Now: …" remainder without the "Now: " prefix.
 */
export type Advice = { act: boolean | null; text: string; head: string; now: string };

const LIVE_REASON: Record<Exclude<LiveProbability["status"], "ok">, string> = {
  unavailable: "Live data unavailable",
  "no-spot": "Live data unavailable for this spot",
  stale: "Live data stale for this spot",
  "timing-only": "No flood probability for this spot (timing only)",
};

/** "At your costs, act when P ≥ X%. Now: Y% → act / don't act yet." */
export function advice(pStar: number, live: LiveProbability): Advice {
  if (pStar >= 1) {
    const head = "At your costs, acting never pays off (the action costs at least as much as the loss).";
    return { act: false, text: head, head, now: "" };
  }
  const head = `At your costs, act when P ≥ ${formatPct(pStar)}.`;
  if (live.status !== "ok") {
    const now = `${LIVE_REASON[live.status]}.`;
    return { act: null, text: `${head} Now: ${now}`, head, now };
  }
  const act = live.p >= pStar;
  const now = `${formatPct(live.p)} → ${act ? "act" : "don't act yet"}.`;
  return { act, text: `${head} Now: ${now}`, head, now };
}
