// The flow map's spot markers (#118, browser feedback): small identical round
// markers whose ring fills with the 3-day flood chance. Pure rules, so tested;
// SpotDots.tsx draws them.
import type { Forecast, Spot } from "../contracts";
import { formatDate } from "../time";
import type { ClockProps } from "../ui/clockData";
import type { ReplayFacts } from "../screens/replay/facts";

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

/** A badge under a spot marker in a replay: River Clock vs the EA, once both have happened. */
export type DotBadge = { text: string; tone: "good" | "bad" | "neutral" };

/** Simulated hours a pulse ring shows after River Clock's warning fires. */
export const PULSE_H = 12;

const ms = Date.parse;

/**
 * "Warned 7 h before EA" / "8 h after EA" / "Same time as EA" (honest sign,
 * proof.json's lead at the spot's warn-at level, ReplayFacts.leadVsOfficialH),
 * shown only once the playhead `t` has passed both River Clock's warning and
 * the EA's first Flood Warning. Null otherwise.
 */
export function eaBadge(f: Pick<ReplayFacts, "rc50" | "official" | "leadVsOfficialH"> | null | undefined, t: number): DotBadge | null {
  if (!f?.rc50 || !f.official || f.leadVsOfficialH == null) return null;
  if (t < Math.max(ms(f.rc50), ms(f.official.issuedAt))) return null;
  const h = f.leadVsOfficialH;
  const n = Math.round(Math.abs(h));
  if (Math.abs(h) < 0.5) return { text: "Same time as EA", tone: "neutral" };
  return h > 0 ? { text: `Warned ${n} h before EA`, tone: "good" } : { text: `${n} h after EA`, tone: "bad" };
}

/** True for PULSE_H simulated hours after River Clock's warning fires (replays). */
export function justWarned(f: Pick<ReplayFacts, "rc50"> | null | undefined, t: number): boolean {
  if (!f?.rc50) return false;
  const w = ms(f.rc50);
  return t >= w && t < w + PULSE_H * 3_600_000;
}

export type SpotDot = ClockProps & { note: string | null; badge?: DotBadge | null; pulse?: boolean };

/** Clock props plus the quiet note, for each spot. */
export function spotDots(clocks: ClockProps[], f: Pick<Forecast, "dataAsOf" | "observed"> | null, spots: Pick<Spot, "key" | "gauge">[]): SpotDot[] {
  return clocks.map((c) => {
    const gauge = spots.find((s) => s.key === c.key)?.gauge ?? c.key;
    return { ...c, note: quietNote(c.state, lastReading(f, gauge)) };
  });
}

/**
 * Spots with something to show (browser feedback, #152): a spot whose gauge is offline or that has
 * no forecast is left off the map rather than drawn as an empty grey marker. Wolvercote (timing-only)
 * never shows; Cherwell shows in replays and is hidden in Now while Kings Mill is offline. Before a
 * forecast has loaded every spot shows, so the map is not empty while it loads.
 */
export function withData<T extends Pick<ClockProps, "state">>(dots: T[], f: Forecast | null): T[] {
  if (!f) return dots;
  return dots.filter((d) => d.state !== "stale" && d.state !== "noforecast");
}
