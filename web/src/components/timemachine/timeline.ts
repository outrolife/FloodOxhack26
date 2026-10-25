// Timeline comparison for the Time Machine (#14, #82): when River Clock
// reached 10% / 50% for a spot vs the EA Flood Alert / Flood Warning for that
// spot's area, matched to the same flood (rules below).
import type { Replay } from "../../contracts";
import { formatDate, formatDateTimeYear, hoursBetween, londonDaysBetween } from "../../time";

export type Official = Replay["official"][number];

const TYPE_LABEL: Record<Official["type"], string> = {
  alert: "Flood Alert",
  warning: "Flood Warning",
  severe: "Severe Flood Warning",
};

export const officialLabel = (o: Official): string => TYPE_LABEL[o.type];

// Focus view of the chart: 7 days of history before the forecast time and the
// 72 h fan plus a little room after it, slid back inside the event at either end.
const HOUR_MS = 3_600_000;
export const FOCUS_BEFORE_H = 7 * 24;
export const FOCUS_AFTER_H = 84;

/** Visible x-range [start, end] (epoch ms) for forecast time t inside an event's range. */
export function focusWindow(t: number, [a, b]: [number, number]): [number, number] {
  const width = (FOCUS_BEFORE_H + FOCUS_AFTER_H) * HOUR_MS;
  if (b - a <= width) return [a, b];
  const start = Math.min(Math.max(t - FOCUS_BEFORE_H * HOUR_MS, a), b - width);
  return [start, start + width];
}

/** Issue time in UK time, or just the date when only the date is known. */
export const formatOfficial = (o: Official): string =>
  o.precision === "date" ? `on ${formatDate(o.issuedAt)} (time not recorded)` : formatDateTimeYear(o.issuedAt);

// ---- Matching River Clock with official messages (#82) ----
//
// Tiers are matched: a Flood Alert ("flooding is possible") is compared with
// River Clock's first >= 10%, a Flood Warning (or Severe) with its first >= 50%.
//
// Which times are compared follows model/metrics.py:
//   - flood onset c = the spot's first threshold crossing in the event;
//   - River Clock trigger = first issue time in [c - 72 h, c) with flood
//     probability (max pFlood over leads) >= p while the level is still below
//     the threshold (once it is above, the flood is here);
//   - official message = first one of the tier issued in [c - 72 h, c), the
//     same window metrics.event_outcomes scores official warnings with.
// With no crossing in the event: River Clock's first trigger in the event, and
// the first official of the tier within 72 h of it (either side), or none.
// So an alert for an earlier rise that never flooded (e2014's Christmas alert)
// is never set against the January flood.

export const MATCH_WINDOW_H = 72;

export type Tier = "alert" | "warning";

export const TIER: Record<Tier, { p: number; noun: string; types: Official["type"][] }> = {
  alert: { p: 0.1, noun: "Flood Alert", types: ["alert"] },
  warning: { p: 0.5, noun: "Flood Warning", types: ["warning", "severe"] },
};

/** The parts of a Replay the comparison reads. */
export type ReplayTimeline = Pick<Replay, "forecasts" | "official" | "crossings">;

export type TierMatch = {
  tier: Tier;
  /** First threshold crossing for the spot in this event, or null. */
  crossing: string | null;
  /** River Clock's matched trigger time (issue time), or null. */
  rc: string | null;
  /**
   * The forecast just before `rc` was already a trigger, i.e. River Clock was
   * at or above the level before the 72 h window opened: `rc` is then only
   * the window edge, so its lead is a lower bound.
   */
  alreadyOn: boolean;
  /** The official message matched to it, or null. */
  official: Official | null;
  /** With a crossing but no official in the 72 h before it: the first one issued within 72 h after. */
  lateOfficial: Official | null;
};

const H = 3_600_000;
const ms = (t: string) => Date.parse(t);

/** Flood probability of one forecast for a spot (max pFlood over leads), null if none or already above threshold. */
function triggerP(f: Replay["forecasts"][number], spot: string, threshold: number): number | null {
  const sf = f.spots.find((s) => s.spot === spot);
  if (!sf || sf.levelNow >= threshold) return null;
  let best: number | null = null;
  for (const l of sf.leads) if (l.pFlood != null) best = Math.max(best ?? 0, l.pFlood);
  return best;
}

/**
 * Match River Clock and the EA for one spot and tier (see the rules above).
 * `pStar` overrides the tier's trigger level (e.g. a spot's proof.warnAt level).
 */
export function matchTier(replay: ReplayTimeline, spot: string, threshold: number, tier: Tier, pStar?: number): TierMatch {
  const { types } = TIER[tier];
  const p = pStar ?? TIER[tier].p;
  const officials = replay.official
    .filter((o) => o.spot === spot && types.includes(o.type))
    .sort((a, b) => ms(a.issuedAt) - ms(b.issuedAt));
  const forecasts = [...replay.forecasts].sort((a, b) => ms(a.issuedAt) - ms(b.issuedAt));
  const isTrigger = (f: (typeof forecasts)[number]) => (triggerP(f, spot, threshold) ?? -1) >= p;
  const triggers = forecasts.filter(isTrigger).map((f) => f.issuedAt);
  const alreadyOnAt = (rc: string | null) => {
    if (!rc) return false;
    const i = forecasts.findIndex((f) => f.issuedAt === rc);
    return i > 0 && isTrigger(forecasts[i - 1]);
  };
  const crossing =
    replay.crossings
      .filter((c) => c.spot === spot)
      .map((c) => c.t)
      .sort((a, b) => ms(a) - ms(b))[0] ?? null;
  const win = MATCH_WINDOW_H * H;

  if (crossing) {
    const c = ms(crossing);
    const inWindow = (t: string) => ms(t) >= c - win && ms(t) < c;
    const official = officials.find((o) => inWindow(o.issuedAt)) ?? null;
    const lateOfficial = official
      ? null
      : (officials.find((o) => ms(o.issuedAt) >= c && ms(o.issuedAt) <= c + win) ?? null);
    const rc = triggers.find(inWindow) ?? null;
    return { tier, crossing, rc, alreadyOn: alreadyOnAt(rc), official, lateOfficial };
  }
  const rc = triggers[0] ?? null;
  const official = rc ? (officials.find((o) => Math.abs(ms(o.issuedAt) - ms(rc)) <= win) ?? null) : null;
  return { tier, crossing: null, rc, alreadyOn: false, official, lateOfficial: null };
}

/** Signed hours from River Clock's trigger to the official issue (positive: River Clock earlier). */
function gainH(rc: string, o: Official): { h: number; approx: string } {
  // Date-only official times are compared as UK calendar days x 24, like model/official.py.
  if (o.precision === "date") {
    return { h: londonDaysBetween(rc, o.issuedAt) * 24, approx: " (the official time is known only to the day, so this is approximate)" };
  }
  return { h: hoursBetween(rc, o.issuedAt), approx: "" };
}

const hrs = (h: number) => {
  const n = Math.round(Math.abs(h));
  return `${n} ${n === 1 ? "hour" : "hours"}`;
};

/** Hours of run-up the "start just before the flood" button shows before River Clock's 50% (#103). */
export const RUN_UP_H = 72;

/**
 * Forecast index to start a replay "just before the flood" (#103): RUN_UP_H
 * before River Clock first reached 50% for this flood, else before the
 * crossing, else before its first 10%. For e2014 at Botley this is 1 Jan 2014
 * 12:00 GMT (step 150, as in docs/demo.md). null if the event has none of these.
 */
export function runUpIndex(
  forecasts: Pick<Replay["forecasts"][number], "issuedAt">[],
  warning: Pick<TierMatch, "rc" | "crossing">,
  alert: Pick<TierMatch, "rc">,
): number | null {
  const anchor = warning.rc ?? warning.crossing ?? alert.rc;
  if (!anchor || forecasts.length === 0) return null;
  const target = ms(anchor) - RUN_UP_H * H;
  let idx = 0;
  for (let i = 0; i < forecasts.length; i++) if (ms(forecasts[i].issuedAt) <= target) idx = i;
  return idx;
}

/**
 * One sentence for a tier match, or null if there is nothing to say or the
 * slider hasn't reached every time it mentions yet (no spoilers). `endT` is
 * the event's last forecast time: "stayed below the threshold" is only known
 * there.
 */
export function tierSentence(m: TierMatch, revealed: (t: string) => boolean, endT: string): string | null {
  const { p, noun: tierNoun } = TIER[m.tier];
  const pct = `${Math.round(p * 100)}%`;
  const noun = m.official ? officialLabel(m.official) : tierNoun;
  const seen = (...ts: (string | null | undefined)[]) => ts.every((t) => t == null || revealed(t));

  // Both markers are on screen but the outcome isn't yet (#103): say the head
  // start now, without saying whether or when the river floods.
  const soFar = (): string | null => {
    if (!m.rc || !m.official || m.alreadyOn || !seen(m.rc, m.official.issuedAt)) return null;
    const { h, approx } = gainH(m.rc, m.official);
    const when = Math.abs(h) < 0.5 ? "at about the same time as" : `${hrs(h)} ${h > 0 ? "earlier" : "later"} than`;
    return `So far: FloodClock reached ${pct} ${when} the EA ${noun}${approx}. Keep playing to see what the river did.`;
  };

  if (m.crossing) {
    if (!seen(m.crossing, m.rc, m.official?.issuedAt)) return soFar();
    const c = m.crossing;
    // Already at the level when the 72 h window opened: say so, and leads are lower bounds.
    const already = m.alreadyOn
      ? `FloodClock was already at ${pct} or more ${MATCH_WINDOW_H} hours before the river reached flood level`
      : null;
    if (m.rc && m.official) {
      const { h, approx } = gainH(m.rc, m.official);
      if (already) return `${already}, at least ${hrs(h)} before the EA ${noun}${approx}.`;
      if (Math.abs(h) < 0.5) return `FloodClock reached ${pct} at about the same time as the EA ${noun}${approx}.`;
      return `FloodClock reached ${pct} ${hrs(h)} ${h > 0 ? "earlier" : "later"} than the EA ${noun}${approx}.`;
    }
    if (m.rc) {
      const before =
        already ?? `FloodClock reached ${pct} ${hrs(hoursBetween(m.rc, c))} before the river reached flood level`;
      if (m.lateOfficial && seen(m.lateOfficial.issuedAt)) {
        return `${before}; the EA ${officialLabel(m.lateOfficial)} came ${hrs(hoursBetween(c, m.lateOfficial.issuedAt))} after the river reached flood level.`;
      }
      return `${before}; no new EA ${tierNoun} was issued in those ${MATCH_WINDOW_H} hours.`;
    }
    if (m.official) {
      return `The EA ${noun} came ${hrs(hoursBetween(m.official.issuedAt, c))} before the river reached flood level; FloodClock did not reach ${pct} in the ${MATCH_WINDOW_H} hours before that.`;
    }
    return `Neither FloodClock (${pct}) nor an EA ${tierNoun} came in the ${MATCH_WINDOW_H} hours before the river reached flood level.`;
  }

  // No crossing in this event.
  if (!m.rc || !seen(m.rc, m.official?.issuedAt)) return null;
  if (!seen(endT)) return soFar();
  const stayed = "the river stayed below flood level";
  if (m.official) {
    const { h, approx } = gainH(m.rc, m.official);
    const when = Math.abs(h) < 0.5 ? "at about the same time as" : `${hrs(h)} ${h > 0 ? "earlier" : "later"} than`;
    return `FloodClock reached ${pct} ${when} the EA ${noun}${approx}, and ${stayed}.`;
  }
  return `FloodClock reached ${pct} on ${formatDateTimeYear(m.rc)} and ${stayed}; no EA ${tierNoun} was issued within ${MATCH_WINDOW_H} hours of that.`;
}

