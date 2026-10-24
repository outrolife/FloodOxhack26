// Replay screen (#120): the facts one replay gives about one spot.
//
// Everything here is read from the replay JSON and proof.json perEvent at
// runtime. The only arithmetic is picking times out of the data and the hours
// between two of them (River Clock's call -> the crossing). The difference vs
// the EA is read from proof.perEvent.leadVsOfficialH, never recomputed.
import type { Proof, Replay, Spot } from "../../contracts";
import { matchTier, runUpIndex, type Official, type TierMatch } from "../../components/timemachine/timeline";
import { pFloodMax } from "../../components/shared/forecast";
import { hoursBetween } from "../../time";

export type PerEventRow = Proof["perEvent"][number];

/** The lead whose fan we score the peak against: the longest one, 3 days. */
export const PEAK_LEAD_H = 72;

export type ReplayFacts = {
  eventId: string;
  spot: string;
  /** First threshold crossing in the event (replay.crossings), or null. */
  crossing: string | null;
  /** River Clock's first "more likely than not" (>= 50%) issue time, matched like model/metrics.py, or null. */
  rc50: string | null;
  /** rc50 is only the edge of the 72 h window: River Clock was already at 50% before it. */
  rc50AlreadyOn: boolean;
  /** Hours from rc50 to the crossing (both read from the data), or null. */
  leadBeforeFloodH: number | null;
  /** First EA Flood Warning for the spot's area (proof.perEvent.officialIssuedAt, else the replay's match). */
  official: Official | null;
  /** proof.perEvent.leadVsOfficialH: positive = River Clock earlier than the EA. */
  leadVsOfficialH: number | null;
  /** Highest chance River Clock gave in the whole event (max pFlood, any lead) and when. */
  peakChance: { p: number; t: string; index: number } | null;
  /** Highest observed level in the event: proof.perEvent.peakObs, timed from the replay's observed series. */
  peakObs: { level: number; t: string | null } | null;
  /** The 5-95% range River Clock gave PEAK_LEAD_H before the peak, for the peak hour. */
  peakBand: { lo: number; hi: number; issuedAt: string; leadH: number; inside: boolean } | null;
  /** True when proof.perEvent says the spot crossed its threshold in this event. */
  crossed: boolean;
  /** No forecast for this spot in the replay at all (e.g. the timing-only Wolvercote). */
  noForecast: boolean;
};

const ms = Date.parse;

/** The perEvent row for one event and spot, if any. */
export function perEventRow(proof: Pick<Proof, "perEvent"> | null, eventId: string, spot: string): PerEventRow | null {
  return proof?.perEvent.find((r) => r.eventId === eventId && r.spot === spot) ?? null;
}

/** Highest pFlood (any lead) a replay gave a spot, the forecast it came from and its index. First one wins ties. */
export function peakChanceOf(forecasts: Replay["forecasts"], spot: string): ReplayFacts["peakChance"] {
  let best: ReplayFacts["peakChance"] = null;
  forecasts.forEach((f, index) => {
    const p = pFloodMax(f.spots.find((s) => s.spot === spot));
    if (p != null && (best == null || p > best.p)) best = { p, t: f.issuedAt, index };
  });
  return best;
}

/** Time of the highest observed level of a gauge in the replay (first if tied). */
function peakObsTime(observed: { t: string; level: number }[] | undefined): { t: string; level: number } | null {
  let best: { t: string; level: number } | null = null;
  for (const o of observed ?? []) if (best == null || o.level > best.level) best = o;
  return best;
}

/**
 * The forecast fan for the peak hour, issued `leadH` before it: the forecast
 * whose issue time + leadH is closest to the peak (earlier issue wins a tie).
 * Replays are hourly or two-hourly, so this is within an hour of the peak.
 */
export function peakBandFor(
  forecasts: Replay["forecasts"],
  spot: string,
  peak: { level: number; t: string },
  leadH = PEAK_LEAD_H,
): ReplayFacts["peakBand"] {
  const target = ms(peak.t) - leadH * 3_600_000;
  let best: { f: Replay["forecasts"][number]; d: number } | null = null;
  for (const f of forecasts) {
    const d = Math.abs(ms(f.issuedAt) - target);
    if (best == null || d < best.d) best = { f, d };
  }
  if (!best || best.d > 3 * 3_600_000) return null; // no forecast near enough (peak too early in the event)
  const lead = best.f.spots.find((s) => s.spot === spot)?.leads.find((l) => l.h === leadH);
  if (!lead) return null;
  const lo = lead.q["05"];
  const hi = lead.q["95"];
  return { lo, hi, issuedAt: best.f.issuedAt, leadH, inside: peak.level >= lo && peak.level <= hi };
}

/** Everything the scoreboard, badge and headline say about one spot in one replay. */
export function replayFacts(
  replay: Pick<Replay, "eventId" | "forecasts" | "official" | "crossings" | "observed">,
  spot: Pick<Spot, "key" | "gauge" | "threshold">,
  row: PerEventRow | null,
): ReplayFacts {
  const warn: TierMatch = matchTier(replay, spot.key, spot.threshold, "warning");
  const crossing = warn.crossing;
  const rc50 = warn.rc;

  // EA: proof's first Flood Warning for the area; the precision comes from the replay's copy of it.
  let official: Official | null = warn.official;
  if (row?.officialIssuedAt) {
    official =
      replay.official.find((o) => o.spot === spot.key && o.issuedAt === row.officialIssuedAt) ??
      ({ spot: spot.key, type: "warning", issuedAt: row.officialIssuedAt, precision: "time" } as Official);
  } else if (row && row.officialIssuedAt === null) {
    official = null;
  }

  const obsPeak = peakObsTime(replay.observed[spot.gauge]);
  const peakLevel = row?.peakObs ?? obsPeak?.level ?? null;
  // Time the proof's peak from the observed series (same file family, same hourly values).
  const peakObs = peakLevel == null ? null : { level: peakLevel, t: obsPeak?.t ?? null };
  const peakBand =
    peakObs?.t != null ? peakBandFor(replay.forecasts, spot.key, { level: peakObs.level, t: peakObs.t }) : null;

  const noForecast = !replay.forecasts.some((f) => (f.spots.find((s) => s.spot === spot.key)?.leads.length ?? 0) > 0);

  return {
    eventId: replay.eventId,
    spot: spot.key,
    crossing,
    rc50,
    rc50AlreadyOn: warn.alreadyOn,
    leadBeforeFloodH: rc50 && crossing ? hoursBetween(rc50, crossing) : null,
    official,
    leadVsOfficialH: row?.leadVsOfficialH ?? null,
    peakChance: peakChanceOf(replay.forecasts, spot.key),
    peakObs,
    peakBand,
    crossed: row ? row.crossed : crossing != null,
    noForecast,
  };
}

/**
 * Where a replay starts (#120): for a flood, 72 h before River Clock's 50%
 * (or before the crossing), as the Time Machine's "start just before the
 * flood"; for an event with no flood here, at River Clock's highest chance.
 */
export function startIndex(
  replay: Pick<Replay, "forecasts" | "official" | "crossings">,
  spot: Pick<Spot, "key" | "threshold">,
  facts: Pick<ReplayFacts, "crossing" | "peakChance">,
): number {
  if (facts.crossing) {
    const warn = matchTier(replay, spot.key, spot.threshold, "warning");
    const alert = matchTier(replay, spot.key, spot.threshold, "alert");
    const i = runUpIndex(replay.forecasts, warn, alert);
    if (i != null) return i;
  }
  return facts.peakChance?.index ?? 0;
}
