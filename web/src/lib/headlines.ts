// One-sentence takeaway at the top of every tab (#103; rules from
// docs/research/jargon-audit.md §2). Every number comes from the data passed
// in: nothing here is hard-coded, so the headlines follow each regeneration.
import type { Forecast, Proof, Spot } from "../contracts";
import { formatDate, formatShort, hoursBetween } from "../time";
import type { TierMatch } from "../components/timemachine/timeline";
import { chanceWords, hoursWords, pctPlain } from "./plain";

/** "Botley Road / New Botley / Hinksey" → "Botley Road". */
export const shortSpotName = (name: string): string => name.split(" / ")[0].trim();

/** "A", "A and B", "A, B and C". */
export function listWords(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const hoursText = (h: number): string => {
  const n = Math.round(Math.abs(h));
  return `${n} ${n === 1 ? "hour" : "hours"}`;
};

export type Headline = { headline: string; detail?: string };

// ---------------------------------------------------------------- River

type RiverSpot = Pick<Spot, "key" | "name" | "gauge" | "amber" | "mode">;

/**
 * River: "Right now: no flooding expected at A, B or C in the next 3 days
 * (each under 1%)." or "Flooding possible at Botley Road: about 1 in 3 (32%)
 * by Tue 18:00 GMT." Spots without a forecast get one clause each saying why.
 */
export function riverHeadline(f: Forecast | null, spots: RiverSpot[]): Headline | null {
  if (!f) return null;
  type Row = { name: string; p: number; by: string | null };
  const rows: Row[] = [];
  const noForecast: string[] = [];
  let aboveUsual = 0;
  let withLevel = 0;
  for (const spot of spots) {
    const sf = f.spots.find((s) => s.spot === spot.key);
    const name = shortSpotName(spot.name);
    const stale = f.stale.includes(spot.gauge);
    if (sf && !stale) {
      withLevel++;
      if (sf.levelNow > spot.amber) aboveUsual++;
    }
    if (!sf || stale || sf.mode === "timing_only" || sf.leads.length === 0) {
      const asOf = f.dataAsOf[spot.gauge];
      if (stale) noForecast.push(`${name}: gauge offline since ${asOf ? formatDate(asOf) : "an earlier date"}`);
      else if (sf?.mode === "timing_only") noForecast.push(`${name}: live level only, no forecast`);
      else noForecast.push(`${name}: no forecast right now`);
      continue;
    }
    let p = 0;
    for (const l of sf.leads) if (l.pFlood != null) p = Math.max(p, l.pFlood);
    const a = sf.arrival;
    const by = p >= 0.5 ? (a?.p50 ?? null) : p >= 0.1 ? (a?.p10 ?? null) : null;
    rows.push({ name, p, by });
  }
  if (rows.length === 0 && noForecast.length === 0) return null;
  rows.sort((x, y) => y.p - x.p);
  const top = rows[0];
  let headline: string;
  if (top && top.p >= 0.1) {
    const word = top.p >= 0.5 ? "likely" : "possible";
    const by = top.by ? ` by ${formatShort(top.by)}` : " in the next 3 days";
    const others = rows.slice(1).filter((r) => r.p >= 0.1).map((r) => `${r.name} ${pctPlain(r.p)}`);
    headline =
      `Right now: flooding ${word} at ${top.name}, ${chanceWords(top.p)}${by}.` +
      (others.length ? ` Also above 1 in 10: ${listWords(others)}.` : "");
  } else if (rows.length > 0) {
    const max = top.p;
    const each = max < 0.005 ? "each under 1%" : `at most ${pctPlain(max)}`;
    headline = `Right now: no flooding expected at ${listWords(rows.map((r) => r.name))} in the next 3 days (${each}).`;
  } else {
    headline = "Right now: no flood forecast is available for any spot.";
  }
  const parts: string[] = [];
  if (withLevel > 0)
    parts.push(
      aboveUsual === 0
        ? "Every forecast gauge is below its usual high."
        : `${aboveUsual} of ${withLevel} forecast gauges ${aboveUsual === 1 ? "is" : "are"} higher than usual.`,
    );
  if (noForecast.length) parts.push(`${noForecast.join(". ")}.`);
  return { headline, detail: parts.join(" ") || undefined };
}

// ---------------------------------------------------------- Time Machine

/**
 * Time Machine, no spoilers: before the flood is on screen, an invitation;
 * once the crossing has been revealed, the result, e.g. "Jan–Feb 2014: River
 * Clock gave Botley Road a 1 in 2 chance of flooding 37 hours before the river
 * reached flood level, and 7 hours before the official Flood Warning."
 */
export function timeMachineHeadline(
  eventName: string,
  spotName: string,
  warn: Pick<TierMatch, "rc" | "crossing" | "official" | "alreadyOn">,
  revealed: (t: string) => boolean,
  /** No crossing here: once the whole event has been played, the highest chance River Clock gave (near miss). */
  nearMiss?: { maxP: number | null; ended: boolean },
): Headline {
  const spot = shortSpotName(spotName);
  const invite: Headline = {
    headline: `Replay ${eventName} at ${spot} as if it were happening now.`,
    detail: "Press Play: at every moment the forecast only knows what had been measured by then, from a model that never saw this flood.",
  };
  if (!warn.crossing) {
    if (!nearMiss?.ended || nearMiss.maxP == null) return invite;
    return {
      headline: `${eventName}: the river stayed below flood level at ${spot}, and River Clock's highest chance of flooding was ${chanceWords(nearMiss.maxP)}.`,
      detail: "A near miss: a forecast that cries wolf here would have raised a false alarm.",
    };
  }
  if (!revealed(warn.crossing)) return invite;
  if (!warn.rc) {
    return {
      headline: `${eventName}: the river reached flood level at ${spot} before River Clock gave it a 1 in 2 chance.`,
      detail: "Not every flood is caught early; the Proof tab counts every past flood.",
    };
  }
  const lead = hoursBetween(warn.rc, warn.crossing);
  const ahead = warn.alreadyOn
    ? `already gave ${spot} a 1 in 2 chance of flooding 3 days or more before the river reached flood level`
    : `gave ${spot} a 1 in 2 chance of flooding ${hoursText(lead)} before the river reached flood level`;
  let vsOfficial = "";
  if (warn.official && revealed(warn.official.issuedAt)) {
    const h = hoursBetween(warn.rc, warn.official.issuedAt);
    const label = warn.official.type === "severe" ? "Severe Flood Warning" : "Flood Warning";
    vsOfficial =
      Math.abs(h) < 0.5
        ? `, at about the same time as the official ${label}`
        : `, and ${hoursText(h)} ${h > 0 ? "before" : "after"} the official ${label}`;
  }
  return {
    headline: `${eventName}: River Clock ${ahead}${vsOfficial}.`,
    detail: "One flood is one example: averaged over every past flood the comparison with the official warnings is mixed (Proof tab).",
  };
}

// ---------------------------------------------------------------- Decide

/**
 * Decide, verdict first: "Resident (move car): act once the chance of flooding
 * passes 1%. Right now at Botley Road: under 1% in the next 1 day, so not yet."
 */
export function decideVerdict(opts: {
  who: string | null;
  C: number;
  L: number;
  pStar: number;
  spotName: string;
  liveP: number | null;
  liveH: number;
  liveReason?: string;
  gbp: (v: number) => string;
}): Headline {
  const { who, C, L, pStar, spotName, liveP, liveH, liveReason, gbp } = opts;
  const lead = who ?? `With your costs (${gbp(C)} to act, ${gbp(L)} if flooded)`;
  if (pStar >= 1) {
    return { headline: `${lead}: acting never pays off, because it costs at least as much as the loss.` };
  }
  const head = `${lead}: act once the chance of flooding passes ${pctPlain(pStar)}.`;
  const spot = shortSpotName(spotName);
  if (liveP == null) return { headline: head, detail: liveReason ? `Right now at ${spot}: ${liveReason}.` : undefined };
  const act = liveP >= pStar;
  return {
    headline: head,
    detail: `Right now at ${spot}: ${pctPlain(liveP)} chance in the next ${liveH} hours, so ${act ? "act now" : "not yet"}.`,
  };
}

// ----------------------------------------------------------------- Proof

type ProofSlice = Pick<Proof, "skillByLead" | "tradeoff">;

/** Trigger whose replay counts the Proof headline quotes (a 1 in 2 chance). */
export const PROOF_TRIGGER = 0.5;

/**
 * Proof: the headline number plus one honest limit, e.g. "Tested on forecasts
 * it never trained on, River Clock's error is 39% smaller than the simple
 * guess 6 hours ahead and 11% smaller 3 days ahead (all gauges pooled)."
 */
export function proofHeadline(proof: ProofSlice, spots: Pick<Spot, "key" | "name">[]): Headline | null {
  const rows = [...proof.skillByLead].sort((a, b) => a.h - b.h);
  if (rows.length === 0) return null;
  const first = rows[0];
  const last = rows[rows.length - 1];
  const pc = (s: number) => `${Math.round(Math.abs(s) * 100)}%`;
  const losing = rows.filter((r) => r.skill <= 0);
  const errWord = (s: number) => (s > 0 ? `${pc(s)} smaller` : `${pc(s)} larger`);
  let headline =
    `Tested on forecasts it never trained on, River Clock's error is ${errWord(first.skill)} than the simple guess ` +
    `("the river stays where it is") ${hoursWords(first.h)} ahead and ${errWord(last.skill)} ${hoursWords(last.h)} ahead (all gauges pooled).`;
  if (losing.length) headline += ` It is no better than the simple guess at ${listWords(losing.map((r) => hoursWords(r.h)))} ahead.`;

  const name = (k: string) => shortSpotName(spots.find((s) => s.key === k)?.name ?? k);
  let hits = 0;
  let misses = 0;
  let fa = 0;
  const earlier: string[] = [];
  const later: string[] = [];
  let nSpots = 0;
  for (const [k, list] of Object.entries(proof.tradeoff)) {
    const r = list.find((x) => Math.abs(x.pStar - PROOF_TRIGGER) < 1e-9);
    if (!r) continue;
    nSpots++;
    hits += r.hits;
    misses += r.misses;
    fa += r.falseAlarms;
    if (r.meanLeadVsOfficialH != null) (r.meanLeadVsOfficialH >= 0 ? earlier : later).push(name(k));
  }
  const parts: string[] = [];
  if (nSpots > 0) {
    const floods = hits + misses;
    parts.push(
      `In replays of past floods, acting at a 1 in 2 chance caught ${hits === floods ? "every one" : `${hits}`} of ${floods} floods across ${nSpots} spots, with ${fa} false ${fa === 1 ? "alarm" : "alarms"}.`,
    );
  }
  if (earlier.length && later.length)
    parts.push(`Against the official warnings' timing it is mixed: earlier on average at ${listWords(earlier)}, later at ${listWords(later)}.`);
  else if (later.length) parts.push(`On average it was later than the official warnings at ${listWords(later)}.`);
  return { headline, detail: parts.join(" ") || undefined };
}

// ----------------------------------------------------------------- About

export const ABOUT_HEADLINE: Headline = {
  headline:
    "River Clock measures how long a flood takes to travel down the Thames and Cherwell to Oxford, then reads today's upstream gauges to give five flood-prone spots a chance of flooding, hour by hour, for the next 3 days.",
  detail: "A student prototype for decision support, not an official warning.",
};
