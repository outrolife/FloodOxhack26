// "How good is it?" (#123, part of #118): every tile value, caption and the
// headline, as pure functions of proof.json (+ spots.json for names).
// Nothing here is hard-coded: when proof.json is regenerated (#94, #91) the
// sentences follow the new numbers.
import type { Proof, Spot } from "../../contracts";

/** The lead time the big tiles talk about. */
export const TILE_LEAD_H = 24;
/** The "1-in-2" trigger used for the floods-caught tile (SPEC §8.2 trade-off). */
export const TRIGGER_P = 0.5;
/** Within this many hours of the official warning counts as "level with" it. */
export const LEVEL_H = 1;
/** Reliability bins off the diagonal by more than this (fraction) get "more/less often". */
export const ODDS_CLOSE = 0.1;

export const pct = (v: number): number => Math.round(v * 100);

/** 6 → "6 hours", 24 → "24 hours", 48 → "2 days", 72 → "3 days". */
export function leadWords(h: number): string {
  if (h >= 48 && h % 24 === 0) return `${h / 24} days`;
  return h === 1 ? "1 hour" : `${h} hours`;
}

const NUMBER_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
export const numberWord = (n: number): string => NUMBER_WORDS[n] ?? String(n);

const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

/** "Botley Road / New Botley / Hinksey" → "Botley Road". */
export function shortName(spot: Pick<Spot, "name"> | undefined, key: string): string {
  return spot ? spot.name.split(" / ")[0] : key;
}

/**
 * The gauges the skill and reliability scores pool, read from testPeriodNote
 * ("… they pool the trained gauges newbotley, minns, coldharbour, kingsmill.").
 * Null when the note doesn't say.
 */
export function pooledGauges(proof: Pick<Proof, "testPeriodNote">): string[] | null {
  const m = /pool the trained gauges ([^.;]+)/i.exec(proof.testPeriodNote ?? "");
  if (!m) return null;
  const keys = m[1]
    .split(/,|\band\b/)
    .map((s) => s.trim())
    .filter(Boolean);
  return keys.length ? keys : null;
}

/** "pooled across our four gauges" (or "pooled across our gauges" if the note doesn't list them). */
export function pooledNote(proof: Pick<Proof, "testPeriodNote">): string {
  const g = pooledGauges(proof);
  return g ? `pooled across our ${numberWord(g.length)} ${plural(g.length, "gauge")}` : "pooled across our gauges";
}

// ---------------------------------------------------------------- Tile 1

export type SkillRow = Proof["skillByLead"][number];

export type BeatsTile = {
  h: number;
  /** River Clock's error (pinball loss, m) and the "nothing changes" baseline's. */
  model: number;
  baseline: number;
  /** model / baseline: the length of the blue bar when the orange one is 1. */
  ratio: number;
  skill: number;
  skillPct: number;
  caption: string;
  trend: { h: number; skill: number }[];
  trendText: string;
};

function nearestBy<T>(rows: T[], key: (r: T) => number, target: number): T | undefined {
  let best: T | undefined;
  for (const r of rows) {
    if (best === undefined || Math.abs(key(r) - target) < Math.abs(key(best) - target)) best = r;
  }
  return best;
}

export function skillCaption(skill: number, h: number): string {
  const p = pct(skill);
  const tail = `than assuming the river stays the same, ${leadWords(h)} ahead`;
  if (p > 0) return `${p}% more accurate ${tail}`;
  if (p < 0) return `${-p}% less accurate ${tail}`;
  return `About as accurate as assuming the river stays the same, ${leadWords(h)} ahead`;
}

/** "Strongest short-term (39% at 6 hours), fading to 11% by 3 days." */
export function skillTrendText(rows: { h: number; skill: number }[]): string {
  if (rows.length < 2) return "";
  const sorted = [...rows].sort((a, b) => a.h - b.h);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const best = sorted.reduce((a, b) => (b.skill > a.skill ? b : a));
  const end =
    pct(last.skill) > 0
      ? `${pct(last.skill)}% better by ${leadWords(last.h)}`
      : `no better than the simple guess by ${leadWords(last.h)}`;
  if (best.h === first.h && last.skill < best.skill) {
    return `Strongest short-term (${pct(best.skill)}% at ${leadWords(best.h)}), fading to ${end}.`;
  }
  return `Best ${leadWords(best.h)} ahead (${pct(best.skill)}%); ${end}.`;
}

export function beatsTile(proof: Pick<Proof, "skillByLead">, h = TILE_LEAD_H): BeatsTile | null {
  const rows = [...(proof.skillByLead ?? [])].sort((a, b) => a.h - b.h);
  const row = rows.find((r) => r.h === h) ?? nearestBy(rows, (r) => r.h, h);
  if (!row || !(row.pinballPersistence > 0)) return null;
  return {
    h: row.h,
    model: row.pinballModel,
    baseline: row.pinballPersistence,
    ratio: row.pinballModel / row.pinballPersistence,
    skill: row.skill,
    skillPct: pct(row.skill),
    caption: skillCaption(row.skill, row.h),
    trend: rows.map((r) => ({ h: r.h, skill: r.skill })),
    trendText: skillTrendText(rows),
  };
}

// ---------------------------------------------------------------- Tile 2

export type Bin = { pPred: number; pObs: number; n: number };
export const POOLED = "pooled";

/** Spots with a reliability entry at lead h, in proof.json order. */
export function reliabilitySpots(proof: Pick<Proof, "reliability">, h = TILE_LEAD_H): string[] {
  return Object.entries(proof.reliability ?? {})
    .filter(([, rows]) => rows.some((r) => r.h === h))
    .map(([k]) => k);
}

/** proof.json uses 10 equal-width bins (model/metrics.py); recover a bin's index from its mean. */
export const binIndex = (pPred: number): number => Math.min(9, Math.max(0, Math.floor(pPred * 10 + 1e-9)));

/**
 * Reliability bins at lead h for one spot, or pooled over every spot.
 * Pooling merges the same equal-width bin across spots, weighting by n, so a
 * pooled dot is exactly what one reliability diagram over all spots would show.
 */
export function binsAt(proof: Pick<Proof, "reliability">, spot: string, h = TILE_LEAD_H): Bin[] | null {
  const rel = proof.reliability ?? {};
  if (spot !== POOLED) {
    const row = rel[spot]?.find((r) => r.h === h);
    return row ? row.bins.filter((b) => b.n > 0) : null;
  }
  const acc = new Map<number, { n: number; p: number; o: number }>();
  let any = false;
  for (const rows of Object.values(rel)) {
    const row = rows.find((r) => r.h === h);
    if (!row) continue;
    any = true;
    for (const b of row.bins) {
      if (!(b.n > 0)) continue;
      const i = binIndex(b.pPred);
      const a = acc.get(i) ?? { n: 0, p: 0, o: 0 };
      a.n += b.n;
      a.p += b.pPred * b.n;
      a.o += b.pObs * b.n;
      acc.set(i, a);
    }
  }
  if (!any) return null;
  return [...acc.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, a]) => ({ pPred: a.p / a.n, pObs: a.o / a.n, n: a.n }));
}

/**
 * The bin worth a sentence: the best-filled one between 10% and 90%. The
 * near-0 bin (calm days) and the near-certain bin (river already over) are
 * huge but tell a judge nothing about whether "a 30% chance" means 30%.
 * Ties go to the bin nearer 50%.
 */
export function pickInformativeBin(bins: Bin[]): Bin | null {
  const live = bins.filter((b) => b.n > 0);
  const middle = live.filter((b) => b.pPred >= 0.1 && b.pPred < 0.9);
  const pool = middle.length ? middle : live;
  let best: Bin | null = null;
  for (const b of pool) {
    if (
      !best ||
      b.n > best.n ||
      (b.n === best.n && Math.abs(b.pPred - 0.5) < Math.abs(best.pPred - 0.5))
    ) {
      best = b;
    }
  }
  return best;
}

/** "When we said about 15%, it flooded 18% of the time." */
export function oddsCaption(bin: Bin): string {
  return `When we said about ${pct(bin.pPred)}%, it flooded ${pct(bin.pObs)}% of the time`;
}

export type OddsVerdict = "close" | "more" | "less";

export function oddsVerdict(bin: Bin): OddsVerdict {
  const d = bin.pObs - bin.pPred;
  if (Math.abs(d) <= ODDS_CLOSE) return "close";
  return d > 0 ? "more" : "less";
}

export const VERDICT_TEXT: Record<OddsVerdict, string> = {
  close: "close to the line",
  more: "it flooded more often than we said",
  less: "it flooded less often than we said",
};

/** The near-certain bin (≥ 90%), said plainly, because that's where we are overconfident if anywhere. */
export function topBinNote(bins: Bin[]): string | null {
  const top = bins.filter((b) => b.n > 0 && b.pPred >= 0.9).sort((a, b) => b.n - a.n)[0];
  if (!top) return null;
  return `When we were near-certain (${pct(top.pPred)}%), it flooded ${pct(top.pObs)}% of the time (${top.n.toLocaleString("en-GB")} forecast hours).`;
}

// ---------------------------------------------------------------- Tile 3

export type TradeoffRow = Proof["tradeoff"][string][number];

export type SpotEarly = {
  spot: string;
  name: string;
  pStar: number;
  hits: number;
  misses: number;
  falseAlarms: number;
  floods: number;
  /** Mean hours of warning before the river crossed. */
  leadH: number | null;
  ci90?: [number, number];
  /** Mean hours ahead of (+) or behind (−) the official EA warning. */
  vsOfficialH: number | null;
  official?: NonNullable<Proof["officialOutcome"]>[string];
};

export type EarlyTile = {
  pStar: number;
  rows: SpotEarly[];
  floods: number;
  caught: number;
  falseAlarms: number;
  /** Hit-weighted mean warning time over the spots, hours. */
  typicalLeadH: number | null;
  /** Spots in spots.json with no trade-off row (e.g. Wolvercote, live-only). */
  noForecast: { spot: string; name: string; mode: Spot["mode"] }[];
};

/** The trade-off row at p*, or the nearest p* when that exact one isn't listed. */
export function tradeoffAt(rows: TradeoffRow[], pStar = TRIGGER_P): TradeoffRow | null {
  return rows.find((r) => Math.abs(r.pStar - pStar) < 1e-6) ?? nearestBy(rows, (r) => r.pStar, pStar) ?? null;
}

export function earlyTile(
  proof: Pick<Proof, "tradeoff" | "officialOutcome">,
  spots: Pick<Spot, "key" | "name" | "mode">[],
  pStar = TRIGGER_P,
): EarlyTile {
  const trade = proof.tradeoff ?? {};
  const spotOrder = spots.map((s) => s.key);
  const keys = Object.keys(trade).sort((a, b) => {
    const ia = spotOrder.indexOf(a);
    const ib = spotOrder.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const rows: SpotEarly[] = [];
  for (const k of keys) {
    const r = tradeoffAt(trade[k], pStar);
    if (!r) continue;
    rows.push({
      spot: k,
      name: shortName(spots.find((s) => s.key === k), k),
      pStar: r.pStar,
      hits: r.hits,
      misses: r.misses,
      falseAlarms: r.falseAlarms,
      floods: r.hits + r.misses,
      leadH: r.meanLeadH,
      ci90: r.ci90,
      vsOfficialH: r.meanLeadVsOfficialH,
      official: proof.officialOutcome?.[k],
    });
  }
  const withLead = rows.filter((r) => r.leadH !== null && r.hits > 0);
  const leadHits = withLead.reduce((s, r) => s + r.hits, 0);
  return {
    pStar: rows[0]?.pStar ?? pStar,
    rows,
    floods: rows.reduce((s, r) => s + r.floods, 0),
    caught: rows.reduce((s, r) => s + r.hits, 0),
    falseAlarms: rows.reduce((s, r) => s + r.falseAlarms, 0),
    typicalLeadH: leadHits > 0 ? withLead.reduce((s, r) => s + (r.leadH as number) * r.hits, 0) / leadHits : null,
    noForecast: spots
      .filter((s) => !(s.key in trade))
      .map((s) => ({ spot: s.key, name: shortName(s, s.key), mode: s.mode })),
  };
}

/** p* 0.5 → "1-in-2"; 0.2 → "1-in-5"; otherwise "40%". */
export function triggerWords(pStar: number): string {
  const inv = 1 / pStar;
  return Math.abs(inv - Math.round(inv)) < 1e-6 ? `1-in-${Math.round(inv)}` : `${pct(pStar)}%`;
}

/** "30 of 30 floods caught" (or "all 30"); false alarms said separately. */
export function caughtText(t: Pick<EarlyTile, "caught" | "floods">): string {
  return `${t.caught} of ${t.floods} ${plural(t.floods, "flood")} caught`;
}

export type VsOfficial = {
  ahead: SpotEarly[];
  behind: SpotEarly[];
  level: SpotEarly[];
  none: SpotEarly[];
  text: string;
};

/** "Ahead of the official warning at 2 spots, behind at 2." Mixed results are said as mixed. */
export function vsOfficialSummary(rows: SpotEarly[]): VsOfficial {
  const has = rows.filter((r) => r.vsOfficialH !== null);
  const ahead = has.filter((r) => (r.vsOfficialH as number) >= LEVEL_H);
  const behind = has.filter((r) => (r.vsOfficialH as number) <= -LEVEL_H);
  const level = has.filter((r) => Math.abs(r.vsOfficialH as number) < LEVEL_H);
  const none = rows.filter((r) => r.vsOfficialH === null);
  const parts: string[] = [];
  const spotsWord = (n: number) => `${n} ${plural(n, "spot")}`;
  if (ahead.length) parts.push(`ahead of the official warning at ${spotsWord(ahead.length)}`);
  if (behind.length) parts.push(`${ahead.length ? "behind" : "behind the official warning"} at ${spotsWord(behind.length)}`);
  if (level.length) parts.push(`level with it at ${spotsWord(level.length)}`);
  const s = parts.length ? parts.join(", ") : "no official warnings to compare with";
  return { ahead, behind, level, none, text: `${s[0].toUpperCase()}${s.slice(1)}.` };
}

/** Flood by flood (perEvent.leadVsOfficialH), so a spot average can't hide the spread. */
export function perEventVsOfficial(proof: Pick<Proof, "perEvent">): {
  ahead: number;
  behind: number;
  level: number;
  total: number;
  text: string;
} {
  const v = (proof.perEvent ?? [])
    .map((e) => e.leadVsOfficialH)
    .filter((x): x is number => x !== null && x !== undefined);
  const ahead = v.filter((x) => x >= LEVEL_H).length;
  const behind = v.filter((x) => x <= -LEVEL_H).length;
  const level = v.length - ahead - behind;
  const text = v.length
    ? `Flood by flood: earlier than the official warning ${ahead} ${plural(ahead, "time")}, later ${behind} ${plural(behind, "time")}${
        level ? `, level ${level} ${plural(level, "time")}` : ""
      } (of ${v.length} floods with a warning to compare).`
    : "";
  return { ahead, behind, level, total: v.length, text };
}

/** "+3 h ahead" / "5 h behind" / "level". */
export function vsOfficialLabel(h: number | null): string {
  if (h === null) return "no official warning to compare";
  if (Math.abs(h) < LEVEL_H) return "level with the official warning";
  return h > 0 ? `${Math.round(h)} h ahead` : `${Math.round(-h)} h behind`;
}

// ---------------------------------------------------------------- Headline

/**
 * "Tested on floods it never saw: 27% more accurate than a simple guess a day
 * ahead, and it caught all 30 floods." Each half only appears when its data exists.
 */
export function headline(beats: BeatsTile | null, early: Pick<EarlyTile, "caught" | "floods"> | null): string {
  const parts: string[] = [];
  if (beats) {
    const when = beats.h === 24 ? "a day ahead" : `${leadWords(beats.h)} ahead`;
    const p = beats.skillPct;
    parts.push(
      p > 0
        ? `${p}% more accurate than a simple guess ${when}`
        : p < 0
          ? `${-p}% less accurate than a simple guess ${when}`
          : `about as accurate as a simple guess ${when}`,
    );
  }
  if (early && early.floods > 0) {
    parts.push(
      early.caught === early.floods
        ? `it caught all ${early.floods} floods`
        : `it caught ${early.caught} of ${early.floods} floods`,
    );
  }
  if (!parts.length) return "How good is it? Scores appear here once proof.json is written.";
  return `Tested on floods it never saw: ${parts.join(", and ")}.`;
}
