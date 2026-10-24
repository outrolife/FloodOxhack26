// Now screen (#119): pure data logic, no React. Everything a judge reads on the
// Now screen (the headline, the clocks, the advice lines, the top stats and the
// river-pulse speeds) is computed here from the contract files at runtime, so
// it can be tested without a browser and never contains illustrative numbers.
import type { Forecast, Spot, SpotForecast, Station, TravelPair } from "../../contracts";
import { PRESETS, formatPct, optimalTrigger, type Preset } from "../../lib/costLoss";
import { formatDateTime, formatShort, HOUR, formatDate } from "../../time";
import { LOW_CONFIDENCE_N, bestPair } from "../../components/shared/RiverStrip";
import { countdownText, stateFor, type ClockState as KitState } from "../../ui/SpotClock";
import { pctPlain } from "../../lib/plain";
import type { StatTone } from "../../ui/StatTile";

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** Short spot name for a clock label: "Botley Road / New Botley / Hinksey" -> "Botley Road". */
export function shortSpotName(name: string): string {
  return name.split(/\s+\/\s+|\s+\(/)[0].trim() || name;
}

/** Readable gauge name: "Eynsham Lock u/s" -> "Eynsham", "Cassington Weir B" -> "Cassington". */
export function plainGauge(name: string): string {
  return (
    name
      .replace(/\s+Weir\s+[A-Z]$/i, "")
      .replace(/\s+(Lock\s+)?(u\/s|d\/s)$/i, "")
      .trim() || name
  );
}

// ---------------------------------------------------------------------------
// Clocks: one per spot
// ---------------------------------------------------------------------------

export type ClockKind =
  | "forecast" // a flood probability is available
  | "flooding" // the gauge is already at or above the flood level
  | "stale" // the gauge has not reported for > 3 h: no forecast
  | "noforecast" // live-only / timing-only spot, or the model produced no leads
  | "nodata"; // no live forecast at all

export type SpotClockInfo = {
  spot: string;
  name: string; // short name for the clock label
  fullName: string;
  gauge: string;
  kind: ClockKind;
  /** Chance of flooding within 72 h (highest over leads), or null without a forecast. */
  p: number | null;
  /** Hours from `now` until the 50% arrival time, or null when there is none. */
  countdownH: number | null;
  /** "≈ 31 h", "now", or "—". */
  countdown: string;
  /** One short line under the clock, e.g. "under 1% in 3 days" or "gauge offline since 13 Oct". */
  status: string;
  /** Accessible name for the clock button. */
  aria: string;
};

const NO_COUNTDOWN = "—";

/** Highest pFlood over leads (pFlood is non-decreasing in lead, so this is P within 72 h). */
export function p72(sf: SpotForecast | undefined): number | null {
  if (!sf) return null;
  let best: number | null = null;
  for (const l of sf.leads) if (l.pFlood != null) best = Math.max(best ?? 0, l.pFlood);
  return best;
}

/** The chance as the clocks show it (kit pctPlain: "under 1%", "41%"). */
export function chanceText(p: number): string {
  return pctPlain(p);
}

/** Kit countdown ("≈ 31 h", "≈ 2 days 6 h", "now"), or "—" when there is no 50% arrival. */
export function formatCountdown(h: number | null): string {
  return countdownText(h) ?? NO_COUNTDOWN;
}

/** The kit SpotClock state for a clock: shape + colour + label (#112). */
export function kitState(c: SpotClockInfo): KitState {
  switch (c.kind) {
    case "flooding":
      return "likely";
    case "forecast":
      return stateFor(c.p);
    case "stale":
      return "stale";
    default:
      return "noforecast";
  }
}

/** Clock state for one spot from live.json. `now` is the wall-clock time in ms. */
export function clockState(spot: Spot, forecast: Forecast | null, now: number): SpotClockInfo {
  const base = { spot: spot.key, name: shortSpotName(spot.name), fullName: spot.name, gauge: spot.gauge };
  const done = (kind: ClockKind, p: number | null, countdownH: number | null, status: string): SpotClockInfo => {
    const countdown = formatCountdown(countdownH);
    const chance = p == null ? "no forecast" : `${chanceText(p)} chance of flooding in 3 days`;
    const arrives = countdownH == null ? "" : countdown === "now" ? ", flooding now" : `, likely in ${countdown.replace("≈ ", "about ")}`;
    return { ...base, kind, p, countdownH, countdown, status, aria: `${spot.name}: ${chance}${arrives}. ${status}.` };
  };

  if (!forecast) return done("nodata", null, null, "no live forecast");
  const sf = forecast.spots.find((s) => s.spot === spot.key);
  if (!sf) return done("nodata", null, null, "no live forecast for this spot");

  if (forecast.stale.includes(spot.gauge)) {
    const asOf = forecast.dataAsOf[spot.gauge];
    return done("stale", null, null, asOf ? `gauge offline since ${formatDate(asOf)}` : "gauge offline");
  }
  const p = p72(sf);
  if (sf.mode === "timing_only" || p == null) {
    return done("noforecast", null, null, sf.mode === "timing_only" ? "live gauge only, no forecast" : "no forecast right now");
  }
  if (sf.levelNow >= spot.threshold) return done("flooding", p, 0, "above flood level now");

  const p50 = sf.arrival?.p50;
  const countdownH = p50 ? (Date.parse(p50) - now) / HOUR : null;
  return done("forecast", p, countdownH, `${chanceText(p)} in 3 days`);
}

export function clockStates(spots: Spot[], forecast: Forecast | null, now: number): SpotClockInfo[] {
  return spots.map((s) => clockState(s, forecast, now));
}

// ---------------------------------------------------------------------------
// Headline
// ---------------------------------------------------------------------------

const join = (xs: string[]): string =>
  xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

/** The one sentence at the top of the Now screen, generated from the clocks. */
export function headline(clocks: SpotClockInfo[]): string {
  const forecastable = clocks.filter((c) => c.kind === "forecast" || c.kind === "flooding");
  if (forecastable.length === 0) return "Right now: no River Clock forecast is available. Check gov.uk/check-flooding.";

  const flooding = forecastable.filter((c) => c.kind === "flooding");
  if (flooding.length > 0) {
    const names = join(flooding.map((c) => c.name));
    return `Right now: the river at ${names} is above flood level.`;
  }

  const arriving = forecastable
    .filter((c) => c.countdownH != null)
    .sort((a, b) => (a.countdownH ?? 0) - (b.countdownH ?? 0));
  if (arriving.length > 0) {
    const c = arriving[0];
    return `Right now: flooding is likely at ${c.name} in about ${Math.max(1, Math.round(c.countdownH!))} hours.`;
  }

  const top = [...forecastable].sort((a, b) => (b.p ?? 0) - (a.p ?? 0))[0];
  const pTop = top.p ?? 0;
  if (pTop >= 0.1) return `Right now: flooding is possible at ${top.name} (${pctPlain(pTop)} chance in the next 3 days).`;
  if (pTop >= 0.005) {
    return `Right now: flooding is unlikely in the next 3 days (highest chance ${pctPlain(pTop)}, at ${top.name}).`;
  }
  const where =
    forecastable.length === clocks.length
      ? "anywhere in Oxford"
      : `at the ${forecastable.length} Oxford spots we can forecast`;
  return `Right now: no flooding expected ${where} in the next 3 days.`;
}

// ---------------------------------------------------------------------------
// Advice lines: one per audience, from the cost–loss presets (act when P ≥ C/L)
// ---------------------------------------------------------------------------

const ACTIONS: Record<Preset["id"], { act: string; wait: string }> = {
  resident: { act: "move your car to higher ground", wait: "no need to move your car yet" },
  commuter: { act: "plan a route that avoids this road", wait: "no need to change your route yet" },
  council: { act: "get road closures and barriers ready", wait: "no need to close roads or put up barriers yet" },
};

export type AdviceLine = {
  id: Preset["id"] | "all";
  label: string;
  /** true = act now, false = no action yet, null = no forecast to decide on. */
  act: boolean | null;
  text: string;
};

/** First lead time (as an ISO time) at which the flood chance reaches p*, or null. */
function firstLeadAtOrAbove(sf: SpotForecast, issuedAt: string, pStar: number): string | null {
  const l = [...sf.leads].sort((a, b) => a.h - b.h).find((x) => x.pFlood != null && x.pFlood >= pStar);
  return l ? new Date(Date.parse(issuedAt) + l.h * HOUR).toISOString() : null;
}

/** One plain sentence per audience for one spot, from the live probability within 72 h. */
export function adviceLines(clock: SpotClockInfo, sf: SpotForecast | undefined, issuedAt: string | undefined): AdviceLine[] {
  if (clock.kind !== "forecast" && clock.kind !== "flooding") {
    return [
      {
        id: "all",
        label: "Everyone",
        act: null,
        text: `Everyone: no River Clock forecast here (${clock.status}). Check gov.uk/check-flooding for official warnings.`,
      },
    ];
  }
  const p = clock.p ?? 0;
  return PRESETS.map((preset) => {
    const pStar = optimalTrigger(preset);
    const words = ACTIONS[preset.id];
    if (clock.kind === "flooding") {
      return { id: preset.id, label: preset.label, act: true, text: `${preset.label}: the water is already above flood level here; ${words.act} now.` };
    }
    if (p >= pStar) {
      const by = sf && issuedAt ? firstLeadAtOrAbove(sf, issuedAt, pStar) : null;
      const when = by ? ` before ${formatShort(by)}` : " now";
      return {
        id: preset.id,
        label: preset.label,
        act: true,
        text: `${preset.label}: ${words.act}${when} (chance ${formatPct(p)} in 3 days; worth it from ${formatPct(pStar)}).`,
      };
    }
    const why = p < 0.005 ? "chance under 1%" : `chance ${formatPct(p)}; worth acting from ${formatPct(pStar)}`;
    return { id: preset.id, label: preset.label, act: false, text: `${preset.label}: ${words.wait} (${why}).` };
  });
}

// ---------------------------------------------------------------------------
// Arrival window, as UK clock times
// ---------------------------------------------------------------------------

/** "Likely arrival: Mon 14:00 GMT to Tue 03:00 GMT (10% to 90% chance), most likely by Mon 20:00 GMT." */
export function arrivalWindow(clock: SpotClockInfo, sf: SpotForecast | undefined): string {
  if (clock.kind === "flooding") return "The river is above flood level now.";
  if (clock.kind !== "forecast" || !sf) return "No arrival time: no forecast for this spot.";
  const a = sf.arrival;
  if (a?.p50) {
    const range = a.p10 && a.p90 ? ` (window ${formatShort(a.p10)} to ${formatShort(a.p90)}, 10% to 90% chance)` : "";
    return `Chance of flooding passes 50% at ${formatShort(a.p50)}${range}.`;
  }
  if (a?.p10) return `Chance of flooding passes 10% at ${formatShort(a.p10)}; it stays under 50% for 72 h.`;
  return `No flood expected in the next 72 hours (chance ${chanceText(clock.p ?? 0)}).`;
}

// ---------------------------------------------------------------------------
// Top strip: at most three stats, plus the data timestamp
// ---------------------------------------------------------------------------

export type Trend = "rising" | "falling" | "steady";

/** Trend over the last `hours` of observed levels: ±1 cm counts as steady. */
export function trend(points: { t: string; level: number }[] | undefined, hours = 3): Trend | null {
  if (!points || points.length < 2) return null;
  const last = points[points.length - 1];
  const cutoff = Date.parse(last.t) - hours * HOUR;
  let ref: { t: string; level: number } | undefined;
  for (const p of points) if (Date.parse(p.t) <= cutoff) ref = p;
  if (!ref) return null;
  const d = last.level - ref.level;
  return d > 0.01 ? "rising" : d < -0.01 ? "falling" : "steady";
}

export type Stat = { value: string; label: string; sub?: string; tone: StatTone };

/** Up to three stats for the top strip (only what the data supports): a big value, a label, a sub-line. */
export function topStats(
  clocks: SpotClockInfo[],
  spots: Spot[],
  stations: Pick<Station, "key" | "name">[],
  forecast: Forecast | null,
  primary = "botley",
): Stat[] {
  if (!forecast) return [];
  const out: Stat[] = [];
  const usable = clocks.filter((c) => c.kind === "forecast" || c.kind === "flooding");

  // 1. The primary spot's gauge against its own flood level (never across gauges).
  const main = usable.find((c) => c.spot === primary) ?? usable[0];
  if (main) {
    const spot = spots.find((s) => s.key === main.spot)!;
    const sf = forecast.spots.find((s) => s.spot === main.spot);
    if (sf) {
      const gap = spot.threshold - sf.levelNow;
      const tr = trend(forecast.observed?.[spot.gauge]);
      const gaugeName = plainGauge(stations.find((s) => s.key === spot.gauge)?.name ?? spot.gauge);
      const outlook = (main.p ?? 0) < 0.005 ? "no flood expected in 72 h" : `${pctPlain(main.p ?? 0)} chance of flooding in 72 h`;
      out.push({
        value: `${Math.abs(gap).toFixed(2)} m`,
        label: `${gap > 0 ? "below" : "above"} flood level at ${gaugeName}`,
        sub: [tr, outlook].filter(Boolean).join(" · "),
        tone: kitState(main) as StatTone,
      });
    }
  }

  // 2. The highest chance anywhere we forecast.
  if (usable.length > 0) {
    const top = [...usable].sort((a, b) => (b.p ?? 0) - (a.p ?? 0))[0];
    const p = top.p ?? 0;
    out.push({
      value: pctPlain(p),
      label: "highest chance of flooding in 3 days",
      sub: p < 0.005 ? `across all ${usable.length} forecast spots` : `at ${top.name}`,
      tone: kitState(top) as StatTone,
    });
  }

  // 3. Coverage: how many spots have a forecast, and why the others don't.
  const missing = clocks.filter((c) => c.kind !== "forecast" && c.kind !== "flooding");
  out.push({
    value: `${usable.length} of ${clocks.length}`,
    label: "spots with a forecast",
    sub: missing.length ? missing.map((c) => `${c.name}: ${c.status}`).join(" · ") : undefined,
    tone: missing.length ? "muted" : "neutral",
  });
  return out.slice(0, 3);
}

/** "Data as of Sat 24 Oct, 18:30 BST" from the latest reading of a non-stale gauge. */
export function dataTimestamp(forecast: Forecast | null): string | null {
  if (!forecast) return null;
  const times = Object.entries(forecast.dataAsOf)
    .filter(([g]) => !forecast.stale.includes(g))
    .map(([, t]) => Date.parse(t))
    .filter(Number.isFinite);
  const latest = times.length ? Math.max(...times) : Date.parse(forecast.issuedAt);
  return `Data as of ${formatDateTime(latest)} · forecast issued ${formatDateTime(forecast.issuedAt)}`;
}

// ---------------------------------------------------------------------------
// River strip: travel-time links and their pulse speed
// ---------------------------------------------------------------------------

/** Upstream gauges and their Oxford targets, per river (SPEC §4.1). */
export const CHAINS: { river: string; upstream: string[]; targets: string[] }[] = [
  { river: "Thames", upstream: ["farmoor", "eynsham", "cassington"], targets: ["newbotley", "minns", "coldharbour"] },
  { river: "Cherwell", upstream: ["enslow", "islip"], targets: ["kingsmill"] },
];

/** Animation seconds per hour of real travel time: the pulse speed is proportional to T½. */
export const SECONDS_PER_HOUR = 0.25;
export const MIN_PULSE_S = 1.2;
export const MAX_PULSE_S = 16;

/** Pulse duration for a link: T½ × 0.25 s/h, kept between 1.2 s and 16 s so it stays visible. */
export function pulseSeconds(tHalfH: number): number {
  if (!Number.isFinite(tHalfH) || tHalfH <= 0) return MIN_PULSE_S;
  return Math.min(MAX_PULSE_S, Math.max(MIN_PULSE_S, tHalfH * SECONDS_PER_HOUR));
}

/** "≈ 10 h", or "< 1 h". */
export function hoursText(h: number): string {
  return h < 0.5 ? "< 1 h" : `≈ ${Math.round(h)} h`;
}

export type RiverLink = {
  up: string;
  down: string;
  upName: string;
  downName: string;
  tHalfH: number;
  n: number;
  lowConfidence: boolean;
  seconds: number;
  /** "Cassington → New Botley ≈ 10 h" */
  label: string;
  /** "based on 24 past rises" (+ low confidence). */
  basis: string;
};

/** One link per upstream gauge: its best-measured travel time to an Oxford target. */
export function riverLinks(stations: Pick<Station, "key" | "name">[], pairs: TravelPair[]): { river: string; links: RiverLink[] }[] {
  const name = (k: string) => plainGauge(stations.find((s) => s.key === k)?.name ?? k);
  return CHAINS.map((c) => {
    const links: RiverLink[] = [];
    for (const up of c.upstream) {
      if (!stations.some((s) => s.key === up)) continue;
      const p = bestPair(up, pairs.filter((x) => c.targets.includes(x.down)));
      if (!p) continue;
      const lowConfidence = p.n < LOW_CONFIDENCE_N;
      links.push({
        up,
        down: p.down,
        upName: name(up),
        downName: name(p.down),
        tHalfH: p.tHalf.median,
        n: p.n,
        lowConfidence,
        seconds: pulseSeconds(p.tHalf.median),
        label: `${name(up)} → ${name(p.down)} ${hoursText(p.tHalf.median)}`,
        basis: `based on ${p.n} past ${p.n === 1 ? "rise" : "rises"}${lowConfidence ? " · low confidence" : ""}`,
      });
    }
    return { river: c.river, links };
  }).filter((c) => c.links.length > 0);
}
