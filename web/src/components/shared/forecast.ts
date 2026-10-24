// Small helpers for reading a Forecast, shared by River and Time Machine.
import type { Forecast, Spot, SpotForecast } from "../../contracts";
import { formatShort } from "../../time";

export type Level = "low" | "elevated" | "high" | "unknown";

/** Status colours, reserved for flood state. Always shown with a text label. */
export const LEVEL_STYLE: Record<Level, { colour: string; label: string }> = {
  low: { colour: "#0ca30c", label: "Low (< 10%)" },
  elevated: { colour: "#fab219", label: "Elevated (10–50%)" },
  high: { colour: "#d03b3b", label: "High (≥ 50%)" },
  unknown: { colour: "#898781", label: "No probability (timing only or stale)" },
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

/** One-sentence arrival window, e.g. "50% chance by Tue 18:00 GMT". */
export function arrivalSentence(sf: SpotForecast | undefined, stale = false, threshold?: number): string {
  if (!sf) return "No forecast for this spot.";
  if (sf.leads.length === 0) {
    if (stale) return "No forecast: gauge data is stale.";
    return sf.mode === "timing_only" ? "No forecast for this timing-only spot." : "No forecast: no gauge history.";
  }
  // Already flooding: arrival is the issue time (SPEC §7.5), so "by <now>" would read oddly.
  if (threshold != null && sf.mode === "probability" && sf.levelNow >= threshold) {
    return `Already above the flood threshold (${sf.levelNow.toFixed(2)} m vs ${threshold.toFixed(2)} m).`;
  }
  const a = sf.arrival;
  if (sf.mode === "timing_only") {
    if (!a?.p50) return "Median forecast stays below the normal range for the next 72 h.";
    const window =
      a.p10 && a.p90 ? ` (travel-time window ${formatShort(a.p10)} to ${formatShort(a.p90)})` : "";
    return `Median forecast reaches the top of the normal range by ${formatShort(a.p50)}${window}.`;
  }
  if (a?.p90) return `90% chance of flooding by ${formatShort(a.p90)}.`;
  if (a?.p50) return `50% chance of flooding by ${formatShort(a.p50)}.`;
  if (a?.p10) return `10% chance of flooding by ${formatShort(a.p10)}.`;
  return "Under 10% chance of flooding in the next 72 h.";
}

/** Official EA page for a warning area. */
export function eaAreaUrl(code: string): string {
  return /^\d{3}[A-Z]{3}/.test(code)
    ? `https://check-for-flooding.service.gov.uk/target-area/${encodeURIComponent(code)}`
    : "https://check-for-flooding.service.gov.uk/";
}

export const pct = (p: number | null | undefined, digits = 0): string =>
  p == null ? "–" : `${(p * 100).toFixed(digits)}%`;
