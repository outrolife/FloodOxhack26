// Small helpers for reading a Forecast, shared by River and Time Machine.
import type { Forecast, Spot, SpotForecast } from "../../contracts";
import { formatDate, formatShort } from "../../time";
import { pctPlain } from "../../lib/plain";

export type Level = "low" | "elevated" | "high" | "unknown";

/** Status colours, reserved for flood state. Always shown with a text label and a
 *  per-tier shape (LevelGlyph). Green is a bluish green so that, for red-green
 *  colour blindness, it stays distinct from red (which reads as olive-brown). */
export const LEVEL_STYLE: Record<Level, { colour: string; label: string }> = {
  // Plain words plus the numbers (#103). Never the EA's "Flood Alert/Warning" names for our outputs.
  low: { colour: "var(--fc-risk-low)", label: "Unlikely (under 1 in 10)" },
  elevated: { colour: "var(--fc-risk-medium)", label: "Possible (1 in 10 to 1 in 2)" },
  high: { colour: "var(--fc-risk-high)", label: "Likely (1 in 2 or more)" },
  unknown: { colour: "#898781", label: "No forecast right now" },
};

export function levelForP(p: number | null | undefined): Level {
  if (p == null || Number.isNaN(p)) return "unknown";
  if (p >= 0.5) return "high";
  if (p >= 0.1) return "elevated";
  return "low";
}

/** pFlood at lead h (exact lead only; leads are fixed at 6..72 h). */
export function pFloodAt(sf: SpotForecast | undefined, h: number): number | null {
  return sf?.leads.find((l) => l.h === h)?.pFlood ?? null;
}

/** Highest pFlood across leads (p is non-decreasing in h, so this is P by 72 h). */
export function pFloodMax(sf: SpotForecast | undefined): number | null {
  if (!sf || sf.leads.length === 0) return null;
  let best: number | null = null;
  for (const l of sf.leads) if (l.pFlood != null) best = Math.max(best ?? 0, l.pFlood);
  return best;
}

export function isStale(f: Forecast, spot: Spot): boolean {
  return f.stale.includes(spot.gauge);
}

/** Map marker status: pFlood at 24 h; grey if timing_only, stale or no leads. */
export function spotLevel(f: Forecast | null, spot: Spot): Level {
  if (!f) return "unknown";
  const sf = f.spots.find((s) => s.spot === spot.key);
  if (!sf || sf.mode === "timing_only" || isStale(f, spot) || sf.leads.length === 0) return "unknown";
  return levelForP(pFloodAt(sf, 24));
}

/**
 * Why a spot has no forecast, in plain words (jargon audit R4, R18), or null
 * if it has one. `lastReading` is the gauge's dataAsOf, when known.
 */
export function noForecastReason(
  sf: SpotForecast | undefined,
  stale: boolean,
  lastReading?: string,
): string | null {
  if (!sf) return "No forecast for this spot.";
  if (stale) return `No forecast: this gauge has sent no readings since ${lastReading ? formatDate(lastReading) : "a while"}.`;
  if (sf.mode === "timing_only")
    return "No flood forecast here: this gauge has no long history to learn from, so we show its live level only.";
  if (sf.leads.length === 0) return "No forecast at this time: not enough recent gauge readings.";
  return null;
}

/** One-sentence arrival window, e.g. "As likely as not to flood by Tue 18:00 GMT (1 in 2)." */
export function arrivalSentence(sf: SpotForecast | undefined, stale = false, threshold?: number, lastReading?: string): string {
  if (!sf) return "No forecast for this spot.";
  if (sf.leads.length === 0) return noForecastReason(sf, stale, lastReading) ?? "No forecast for this spot.";
  // Already flooding: arrival is the issue time (SPEC §7.5), so "by <now>" would read oddly.
  if (threshold != null && sf.mode === "probability" && sf.levelNow >= threshold) {
    return `Already above flood level (${sf.levelNow.toFixed(2)} m; floods at ${threshold.toFixed(2)} m).`;
  }
  const a = sf.arrival;
  if (sf.mode === "timing_only") {
    if (!a?.p50) return "Our middle estimate stays below the usual high for the next 3 days.";
    const window =
      a.p10 && a.p90 ? ` (water from upstream due between ${formatShort(a.p10)} and ${formatShort(a.p90)})` : "";
    return `Our middle estimate: the river goes above its usual high by ${formatShort(a.p50)}${window}.`;
  }
  if (a?.p90) return `Flooding very likely by ${formatShort(a.p90)} (9 in 10).`;
  if (a?.p50) return `As likely as not to flood by ${formatShort(a.p50)} (1 in 2).`;
  if (a?.p10) return `About 1 in 10 chance of flooding by ${formatShort(a.p10)}.`;
  const max = pFloodMax(sf);
  if (max != null && max < 0.01) return "Very unlikely to flood in the next 3 days (under 1%).";
  return "Under 1 in 10 chance of flooding in the next 3 days.";
}

/** Official EA page for a warning area. */
export function eaAreaUrl(code: string): string {
  return /^\d{3}[A-Z]{3}/.test(code)
    ? `https://check-for-flooding.service.gov.uk/target-area/${encodeURIComponent(code)}`
    : "https://check-for-flooding.service.gov.uk/";
}

/** Whole-percent chance; below 0.5% says "under 1%" (a rounded 0% reads as "impossible"). */
export const pct = (p: number | null | undefined, digits = 0): string =>
  p == null ? "–" : digits === 0 ? pctPlain(p) : `${(p * 100).toFixed(digits)}%`;
