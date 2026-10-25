// The one-screen UI (#135): what the Timeline markers, the 2-line Scoreboard
// and the proof footer say. Pure functions only, so every wording rule is
// unit-tested. Every number is read from the data at runtime:
//   - replay facts (River Clock's first chance at or above the spot's warn-at
//     level, the EA warning, the crossing) come from screens/replay/facts.ts,
//     the same rules as the Replay screen and model/metrics.py;
//   - each spot's warn-at level is proof.warnAt[spot].pStar (chosen on the
//     pre-2021 floods only), else 50%;
//   - River Clock vs the EA is read from proof.json at that level
//     (proof.warnAt[spot].perEvent, else proof.perEvent at 50%), never
//     recomputed, and shown with its honest sign;
//   - the footer's counts are summed from proof.tradeoff (River Clock at each
//     spot's warn-at level) and proof.officialOutcome (EA Flood Warnings),
//     scored on the same rules.
// Our outputs are never called a "Flood Warning" or "Flood Alert".
import type { EventMeta, Forecast, Proof, Replay, Spot } from "../contracts";
import { HOUR, formatDateTime, formatShort } from "../time";
import { pctPlain } from "../lib/plain";
import { pFloodMax } from "../components/shared/forecast";
import { DEFAULT_WARN_AT, OBS_LAG_H, leadVsOfficialAt, warnAtFor, type ReplayFacts } from "../screens/replay/facts";
import { indexAt } from "../screens/replay/playback";

/** The palette: blue = River Clock, grey = the EA, black = what the river really did. Always with a label. */
export const COLOURS = { rc: "#184f95", ea: "#6b6a65", real: "#0b0b0b" } as const;

export const MARKER_LABEL = { rc: "FloodClock warned", ea: "EA warned", flood: "Flooded" } as const;

/**
 * River Clock "warns" at its first chance at or above the spot's warn-at level
 * (proof.warnAt[spot].pStar; matched like model/metrics.py). This is the
 * level when proof.json has none.
 */
export const WARN_AT = DEFAULT_WARN_AT;

/**
 * The caption under the Scoreboard: "Warns at 30% chance (level chosen on
 * 2007–2021 floods)". The years span the events the level was chosen on
 * (proof.warnAt[spot].validation.events, dated from events.json); without
 * warnAt it is just the 50% default.
 */
export function warnAtCaption(proof: Pick<Proof, "warnAt"> | null | undefined, spot: string, events: Pick<EventMeta, "id" | "start" | "end">[] | null | undefined): string {
  const text = `Warns at ${pctPlain(warnAtFor(proof, spot))} chance`;
  const ids = proof?.warnAt?.[spot]?.validation?.events ?? [];
  const chosenOn = (events ?? []).filter((e) => ids.includes(e.id));
  if (chosenOn.length === 0) return text;
  const from = Math.min(...chosenOn.map((e) => new Date(e.start).getUTCFullYear()));
  const to = Math.max(...chosenOn.map((e) => new Date(e.end).getUTCFullYear()));
  if (!Number.isFinite(from) || !Number.isFinite(to)) return text;
  return `${text} (level chosen on ${from === to ? from : `${from}–${to}`} floods)`;
}

/**
 * When a spot shares its EA warning area with another spot (Abingdon Rd with
 * Botley), its "vs the EA" is measured against that shared warning: say so,
 * from spots.json, in a few words. Null otherwise.
 */
export function sharedAreaNote(spot: Pick<Spot, "key" | "warningArea">, spots: Pick<Spot, "key" | "name" | "warningArea">[] | null | undefined): string | null {
  if (!spot.warningArea) return null;
  const other = (spots ?? []).find((s) => s.key !== spot.key && s.warningArea === spot.warningArea);
  if (!other) return null;
  // The first spot with the area owns it: Botley's own note would be pointless.
  const first = (spots ?? []).find((s) => s.warningArea === spot.warningArea);
  if (first?.key === spot.key) return null;
  return `EA times are for the ${other.name.split(" / ")[0].trim()} warning area`;
}

export type Marker = { t: string; label: string; colour: string };
export type Tone = "good" | "bad" | "neutral";
export type ScoreLine = { text: string; tone: Tone };

const ms = Date.parse;
const LAG = OBS_LAG_H * HOUR;
const hrs = (h: number) => `${Math.round(Math.abs(h))} h`;

// ---------------------------------------------------------------------------
// Timeline markers
// ---------------------------------------------------------------------------

/**
 * The vertical markers on the Timeline once the playhead has passed them
 * (`seen` = furthest playhead, epoch ms). A crossing is seen one hour after it
 * happens, like any reading (#93).
 */
export function replayMarkers(f: Pick<ReplayFacts, "rc50" | "official" | "crossing">, seen: number): Marker[] {
  const out: Marker[] = [];
  if (f.rc50 && ms(f.rc50) <= seen) out.push({ t: f.rc50, label: MARKER_LABEL.rc, colour: COLOURS.rc });
  if (f.official && ms(f.official.issuedAt) <= seen) out.push({ t: f.official.issuedAt, label: MARKER_LABEL.ea, colour: COLOURS.ea });
  if (f.crossing && ms(f.crossing) + LAG <= seen) out.push({ t: f.crossing, label: MARKER_LABEL.flood, colour: COLOURS.real });
  return out;
}

/** First observed time a gauge went from below to at/above `threshold` (or started above it), up to `until`. */
export function firstCrossing(observed: { t: string; level: number }[], threshold: number, until: number): string | null {
  for (const o of observed) {
    if (ms(o.t) > until) break;
    if (o.level >= threshold) return o.t;
  }
  return null;
}

/** Markers for Now: River Clock's call if this forecast is at or above the spot's warn-at level, and "Flooded" if the river is over the line in the last 7 days. */
export function nowMarkers(live: Forecast, spot: Pick<Spot, "key" | "gauge" | "threshold">, pStar: number = WARN_AT): Marker[] {
  const out: Marker[] = [];
  const sf = live.spots?.find((s) => s.spot === spot.key);
  const p = sf && sf.mode === "probability" && !(live.stale ?? []).includes(spot.gauge) ? pFloodMax(sf) : null;
  if (p != null && p >= pStar && sf!.levelNow < spot.threshold) {
    out.push({ t: live.issuedAt, label: MARKER_LABEL.rc, colour: COLOURS.rc });
  }
  const c = firstCrossing(live.observed?.[spot.gauge] ?? [], spot.threshold, ms(live.issuedAt) - LAG);
  if (c) out.push({ t: c, label: MARKER_LABEL.flood, colour: COLOURS.real });
  return out;
}

// ---------------------------------------------------------------------------
// Scoreboard (at most 2 lines)
// ---------------------------------------------------------------------------

/** Highest chance (any lead) River Clock gives a spot in the replay forecast in force at t. */
export function chanceAt(forecasts: Replay["forecasts"] | undefined, spot: string, t: number): number | null {
  if (!forecasts?.length || Number.isNaN(t)) return null;
  const i = indexAt(
    forecasts.map((f) => ms(f.issuedAt)),
    t,
  );
  return pFloodMax(forecasts[i].spots.find((s) => s.spot === spot));
}

/** River Clock vs the EA from proof.perEvent.leadVsOfficialH (positive = River Clock earlier). */
export function eaDifference(h: number): ScoreLine {
  if (Math.abs(h) < 0.5) return { text: "Same time as the EA warning", tone: "neutral" };
  return h > 0 ? { text: `${hrs(h)} before the EA warning`, tone: "good" } : { text: `${hrs(h)} after the EA warning`, tone: "bad" };
}

/**
 * The Scoreboard for one spot in one replay at playhead t (epoch ms; Infinity
 * = the end, everything known). Lines fill in only once the playhead has
 * passed the moment they describe, so playing never gives the story away.
 */
export function replayScore(f: ReplayFacts, t: number, endT: string, chanceNow: number | null): ScoreLine[] {
  if (f.noForecast) return [{ text: "No forecast for this spot", tone: "neutral" }];
  const atEnd = t >= ms(endT);
  const rcSeen = f.rc50 != null && t >= ms(f.rc50);
  const o = f.official;
  const eaSeen = o != null && t >= ms(o.issuedAt);
  const flooded = f.crossing != null || f.crossed;
  // A flood is known an hour after the crossing (#93); without a crossing time, only at the end.
  const floodSeen = f.crossing ? t >= ms(f.crossing) + LAG : f.crossed && atEnd;
  const peak = f.peakChance?.p ?? 0;
  const soFar: ScoreLine =
    chanceNow == null
      ? { text: "No forecast at this time", tone: "neutral" }
      : { text: `Chance of flooding within 3 days: ${pctPlain(chanceNow)}`, tone: "neutral" };
  const level = pctPlain(f.pStar ?? WARN_AT);
  const calling: ScoreLine = { text: `FloodClock warned: chance of flooding reached ${level}`, tone: "neutral" };

  // Line 1: River Clock against the river.
  let first: ScoreLine;
  if (flooded) {
    if (floodSeen) {
      first =
        f.rc50 && f.leadBeforeFloodH != null
          ? { text: `FloodClock warned ${f.rc50AlreadyOn ? "at least " : ""}${hrs(f.leadBeforeFloodH)} before the flood`, tone: "good" }
          : { text: `Flooded before FloodClock reached ${level}`, tone: "bad" };
    } else first = rcSeen ? calling : soFar;
  } else if (atEnd) {
    first = f.rc50
      ? { text: `False alarm: reached ${pctPlain(peak)}, no flood`, tone: "bad" }
      : { text: `Stayed calm: highest chance ${pctPlain(peak)}`, tone: "good" };
  } else first = rcSeen ? calling : soFar;

  // Line 2: River Clock against the EA's Flood Warning.
  let second: ScoreLine;
  if (f.rc50 && o && f.leadVsOfficialH != null && rcSeen && eaSeen) {
    second = eaDifference(f.leadVsOfficialH);
  } else if (eaSeen) {
    second =
      f.crossing && floodSeen
        ? {
            text: `EA warned ${hrs((ms(f.crossing) - ms(o!.issuedAt)) / HOUR)} ${ms(o!.issuedAt) <= ms(f.crossing) ? "before" : "after"} the flood`,
            tone: "neutral",
          }
        : { text: `EA warned ${formatDateTime(o!.issuedAt)}`, tone: "neutral" };
  } else if (!o && flooded && floodSeen) {
    second = { text: "No EA warning before the flood", tone: "neutral" };
  } else if (!o && !flooded && atEnd) {
    second = { text: "No EA warning either", tone: "neutral" };
  } else {
    second = { text: "EA: no warning yet", tone: "neutral" };
  }
  return [first, second];
}

/** The Scoreboard for Now, from the live forecast. */
export function nowScore(live: Forecast, spot: Pick<Spot, "key" | "gauge" | "threshold">, pStar: number = WARN_AT): ScoreLine[] {
  const sf = live.spots?.find((s) => s.spot === spot.key);
  if (!sf || sf.mode !== "probability" || !sf.leads?.length || (live.stale ?? []).includes(spot.gauge)) {
    return [{ text: "No forecast here right now", tone: "neutral" }];
  }
  const below = Math.round((spot.threshold - sf.levelNow) * 100);
  if (below <= 0) return [{ text: "Above flood level now", tone: "bad" }];
  const gap = below >= 100 ? `${(below / 100).toFixed(1)} m` : `${below} cm`;
  const level: ScoreLine = { text: `River ${gap} below flood level`, tone: "neutral" };
  const p = pFloodMax(sf) ?? 0;
  if (p < 0.005) return [{ text: "No flood expected in the next 3 days", tone: "good" }, level];
  // The first lead at which the chance reaches its 3-day high (it never falls with lead).
  const lead = sf.leads.find((l) => (l.pFlood ?? 0) >= p - 1e-9) ?? sf.leads[sf.leads.length - 1];
  const by = ms(live.issuedAt) + lead.h * HOUR;
  return [{ text: `${pctPlain(p)} chance of flooding by ${formatShort(by)}`, tone: p >= pStar ? "bad" : "neutral" }, level];
}

// ---------------------------------------------------------------------------
// Proof footer
// ---------------------------------------------------------------------------

export type ProofSummary = {
  floods: number;
  rc: { hits: number; falseAlarms: number };
  ea: { hits: number; falseAlarms: number } | null;
  /** Floods where both River Clock and the EA warned (perEvent.leadVsOfficialH set), and how many River Clock was earlier at. */
  earlier: number;
  compared: number;
};

/** proof.tradeoff row at a trigger level (the nearest pStar if that one is missing). */
function rowAt(rows: Proof["tradeoff"][string] | undefined, p: number) {
  let best: NonNullable<typeof rows>[number] | null = null;
  for (const r of rows ?? []) if (!best || Math.abs(r.pStar - p) < Math.abs(best.pStar - p)) best = r;
  return best;
}

/** Sums over the forecast spots in proof.json, River Clock at each spot's warn-at level. */
export function proofSummary(proof: Pick<Proof, "tradeoff" | "officialOutcome" | "perEvent"> & Partial<Pick<Proof, "warnAt">>): ProofSummary {
  const spots = Object.keys(proof.tradeoff ?? {});
  let floods = 0;
  const rc = { hits: 0, falseAlarms: 0 };
  for (const s of spots) {
    const r = rowAt(proof.tradeoff[s], warnAtFor(proof, s));
    if (!r) continue;
    floods += r.hits + r.misses;
    rc.hits += r.hits;
    rc.falseAlarms += r.falseAlarms;
  }
  let ea: ProofSummary["ea"] = null;
  if (proof.officialOutcome) {
    ea = { hits: 0, falseAlarms: 0 };
    for (const s of spots) {
      const o = proof.officialOutcome[s];
      if (o) {
        ea.hits += o.hits;
        ea.falseAlarms += o.falseAlarms;
      }
    }
  }
  // The same lead vs the EA the Scoreboard shows for each flood (at the spot's warn-at level).
  const leads = (proof.perEvent ?? [])
    .filter((r) => spots.includes(r.spot) && r.crossed)
    .map((r) => leadVsOfficialAt(proof, r.eventId, r.spot))
    .filter((h): h is number => h != null);
  return { floods, rc, ea, earlier: leads.filter((h) => h > 0).length, compared: leads.length };
}

const falseAlarms = (n: number) => `${n} false alarm${n === 1 ? "" : "s"}`;

/** The footer's sentence, in two parts so the UI can break it on narrow screens. */
export function proofText(s: ProofSummary): { main: string; earlier: string | null } {
  const ea = s.ea ? ` · the official warning caught ${s.ea.hits} (${falseAlarms(s.ea.falseAlarms)})` : "";
  return {
    main: `Across ${s.floods} past floods: FloodClock caught ${s.rc.hits} (${falseAlarms(s.rc.falseAlarms)})${ea}`,
    earlier:
      s.compared > 0 ? `earlier than the official warning at ${s.earlier} of ${s.compared} floods where both warned` : null,
  };
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

/** Playback stops by itself this long after the last thing the Scoreboard reveals. */
export const STOP_AFTER_H = 12;

/** Epoch ms at which a replay's story is complete (the flood seen, the EA and River Clock both in), plus STOP_AFTER_H. */
export function storyEnd(f: ReplayFacts, endT: string): number {
  const ts = [f.rc50 ? ms(f.rc50) : 0, f.official ? ms(f.official.issuedAt) : 0];
  if (f.crossing) ts.push(ms(f.crossing) + LAG);
  else ts.push(ms(endT)); // no flood: "stayed calm" is known only at the end
  return Math.min(Math.max(...ts) + STOP_AFTER_H * HOUR, ms(endT));
}
