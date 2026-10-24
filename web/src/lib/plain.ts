// Plain-language layer (#103, docs/research/jargon-audit.md): one vocabulary
// for the whole app, chances in words a judge can absorb, and readable gauge
// names. Pure functions only, so every wording rule is unit-tested.

/** One name per idea (jargon audit §1.0). The precise term goes in a tooltip. */
export const TERMS = {
  floodLevel: "flood level",
  usualHigh: "usual high",
  chance: "chance of flooding",
  simpleGuess: "the simple guess",
  likelyRange: "likely range",
  wideRange: "wide range",
  pastFloods: "past floods",
} as const;

/** "What's this?" tooltips: the precise meaning behind each everyday word. */
export const TERM_TIPS = {
  floodLevel:
    "Flood level: the height on this spot's gauge at which the Environment Agency says property flooding becomes possible nearby. Each gauge measures from its own zero, so heights can't be compared between gauges.",
  usualHigh:
    "Usual high: the top of the river's normal range at this gauge (the EA's typicalRangeHigh). Above it the river is higher than usual, but not necessarily flooding.",
  chance:
    "Chance of flooding: the forecast probability that the river is at or above flood level by that time (pFlood).",
  simpleGuess:
    "The simple guess ('persistence'): the river stays where it is now, give or take its usual ups and downs. A forecast that can't beat it isn't worth much.",
  likelyRange:
    "Likely range: the middle half of the forecast (25th to 75th percentile). Wide range: 5th to 95th percentile, about 9 times in 10.",
} as const;

/** "under 1%" below 0.5% (a rounded 0% reads as "impossible"), else a whole percent. */
export function pctPlain(p: number | null | undefined): string {
  if (p == null || Number.isNaN(p)) return "–";
  if (p < 0.005) return "under 1%";
  if (p > 0.995) return "over 99%";
  return `${Math.round(p * 100)}%`;
}

// Friendly "1 in N" denominators: nobody pictures "1 in 7.3".
const ONE_IN = [2, 3, 4, 5, 10, 20, 50, 100];

/**
 * A chance in words plus the number, e.g. "about 1 in 3 (32%)",
 * "about 6 in 10 (63%)", "under 1%". Natural frequencies are easier to read
 * than bare percentages (presentation research, refs 8–9).
 */
export function chanceWords(p: number | null | undefined): string {
  if (p == null || Number.isNaN(p)) return "no forecast";
  if (p < 0.005) return "under 1%";
  if (p > 0.995) return "almost certain (over 99%)";
  const pc = `${Math.round(p * 100)}%`;
  if (p > 0.55) return `about ${Math.round(p * 10)} in 10 (${pc})`;
  if (p >= 0.45) return `about 1 in 2 (${pc})`;
  const n = 1 / p;
  let best = ONE_IN[0];
  for (const d of ONE_IN) if (Math.abs(Math.log(d) - Math.log(n)) < Math.abs(Math.log(best) - Math.log(n))) best = d;
  return `about 1 in ${best} (${pc})`;
}

/** "6 hours", "1 day", "3 days", "36 hours": hours ahead in words. */
export function hoursWords(h: number): string {
  if (h >= 48 && h % 24 === 0) return `${h / 24} days`;
  if (h === 24) return "1 day";
  return `${h} hours`;
}

/**
 * Readable gauge names (jargon audit R5): EA shorthand expanded, internal
 * weir letters dropped. Station names stay as they are in stations.json (Data
 * owns them); this is display only.
 */
export function gaugeName(name: string): string {
  return name
    .replace(/\s+u\/s$/i, " (upstream side)")
    .replace(/\s+d\/s$/i, " (downstream side)")
    .replace(/\s+Weir\s+[A-Z]$/, " Weir")
    .replace(/^Kings Mill \(upstream side\)$/, "Kings Mill");
}
