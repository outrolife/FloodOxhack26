// The flow map's spot markers (#118, browser feedback): small identical round
// markers whose ring fills with the 3-day flood chance. Pure rules, so tested;
// SpotDots.tsx draws them.
import type { Forecast, Spot } from "../contracts";
import { formatDate } from "../time";
import type { ClockProps } from "../ui/clockData";

/** Marker diameter (px). Every spot is the same size; the selected one only gets a thicker outline. */
export const DOT_PX = 32;
/** Footprint for the shared placement rule: the marker plus a small gap (labels sit beside it). */
export const DOT_BOX = { w: DOT_PX + 4, h: DOT_PX + 4 } as const;

/** Text inside the ring: the whole percentage, only from 1% (a rounded 0% would read as "impossible"). */
export function ringText(prob: number | null | undefined): string | null {
  if (prob == null || !Number.isFinite(prob) || prob < 0.01) return null;
  return `${Math.round(Math.min(prob, 1) * 100)}%`;
}

/** Last reading time of a gauge: the forecast's dataAsOf, else the last observed reading. */
export function lastReading(f: Pick<Forecast, "dataAsOf" | "observed"> | null, gauge: string): string | null {
  const asOf = f?.dataAsOf?.[gauge];
  if (asOf) return asOf;
  const obs = f?.observed?.[gauge];
  return obs?.length ? obs[obs.length - 1].t : null;
}

/**
 * Plain words for a spot without a forecast (grey hollow marker, shown on hover):
 * the gauge is offline, or the spot is timing-only / has too little history.
 */
export function quietNote(state: ClockProps["state"], last: string | null): string | null {
  if (state === "stale") return last ? `No live river reading here since ${formatDate(last)}` : "No live river reading here";
  if (state === "noforecast") return "Too little history at this gauge to forecast";
  return null;
}

/** Screen-reader and hover text for a marker with a forecast. */
export function chanceLabel(name: string, prob: number | null): string {
  const t = ringText(prob);
  return `${name}: ${t ?? "under 1%"} chance of flooding in the next 3 days`;
}

/** Which side of the marker its name goes: away from the way placement pushed it. */
export const labelSide = (dx: number): "left" | "right" => (dx < -1 ? "left" : "right");

export type SpotDot = ClockProps & { note: string | null };

/** Clock props plus the quiet note, for each spot. */
export function spotDots(clocks: ClockProps[], f: Pick<Forecast, "dataAsOf" | "observed"> | null, spots: Pick<Spot, "key" | "gauge">[]): SpotDot[] {
  return clocks.map((c) => {
    const gauge = spots.find((s) => s.key === c.key)?.gauge ?? c.key;
    return { ...c, note: quietNote(c.state, lastReading(f, gauge)) };
  });
}
