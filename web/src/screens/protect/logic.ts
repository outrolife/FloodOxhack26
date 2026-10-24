// Protect screen (#121, SPEC §11 S3/S4): pure helpers, no React and no Leaflet.
//
// Everything shown on the screen is computed here from the data files
// (spread/{context}/manifest.json and sandbags.json), so it can be tested and
// explained line by line.
import type { Sandbags, SpreadManifest } from "../../contracts";
import type { SpreadFrame } from "../../components/spread/frames";

export type Candidate = Sandbags["candidates"][number];

/** Default bag budget (SPEC §11 S4: "UI slider, default 500"). */
export const DEFAULT_BUDGET = 500;
/** How many buildings the screen lists (SPEC §11 S4 step 5: "output the top 5"). */
export const TOP_N = 5;
/**
 * Time to get bags in place, hours. SPEC §11 S4 step 2 default (3 h), the same
 * value stretch/s4/screen.py used to exclude buildings that are wet too soon.
 */
export const DEPLOY_HOURS = 3;

const HOUR = 3_600_000;
const ms = (t: string): number => Date.parse(t);
const iso = (t: number): string => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");

export type Selection = {
  /** Every building the greedy pass can afford, in pick order. */
  affordable: Candidate[];
  /** The top N of those by score (what the screen lists and pins). */
  shown: Candidate[];
  /** Bags used by the shown buildings. */
  bagsShown: number;
  /** Bags used by every affordable building. */
  bagsUsed: number;
};

/**
 * SPEC §11 S4 step 5, the same rule as stretch/s4/screen.py `greedy` + `screen`:
 * sort by score ÷ bags (ties: higher score, then id), take each building that
 * still fits in the budget (skipping ones that don't), then list the `topN`
 * highest-scoring of the affordable set (ties: fewer bags, then id).
 *
 * It runs on whatever candidates sandbags.json holds. Today that file lists the
 * top 5 for its own budget, so budgets above that file's total pick the same 5.
 */
export function selectWithinBudget(candidates: Candidate[], budget: number, topN = TOP_N): Selection {
  const order = [...candidates].sort(
    (a, b) => b.score / b.bags - a.score / a.bags || b.score - a.score || cmp(a.id, b.id),
  );
  const affordable: Candidate[] = [];
  let left = budget;
  for (const c of order) {
    if (c.score > 0 && c.bags > 0 && c.bags <= left) {
      affordable.push(c);
      left -= c.bags;
    }
  }
  const shown = [...affordable]
    .sort((a, b) => b.score - a.score || a.bags - b.bags || cmp(a.id, b.id))
    .slice(0, topN);
  return {
    affordable,
    shown,
    bagsShown: shown.reduce((n, c) => n + c.bags, 0),
    bagsUsed: affordable.reduce((n, c) => n + c.bags, 0),
  };
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Total bags of all candidates in the file (the most the budget slider can spend). */
export const totalBags = (candidates: Candidate[]): number => candidates.reduce((n, c) => n + c.bags, 0);

/**
 * The spread frames that belong to the screening's forecast: the latest issue
 * time at or before `issuedAt` (never a later one: that would be the future),
 * sorted by lead. Empty if the manifest has nothing that early.
 */
export function framesForIssue(manifest: SpreadManifest, issuedAt: string): SpreadFrame[] {
  const at = ms(issuedAt);
  const usable = manifest.frames.filter((f) => ms(f.issuedAt) <= at);
  if (usable.length === 0) return [];
  const latest = Math.max(...usable.map((f) => ms(f.issuedAt)));
  return usable.filter((f) => ms(f.issuedAt) === latest).sort((a, b) => a.tau - b.tau);
}

/** The frame with the nearest lead to `tau` (ties go to the shorter lead), or null. */
export function frameForHour(frames: SpreadFrame[], tau: number): SpreadFrame | null {
  let best: SpreadFrame | null = null;
  for (const f of frames) {
    if (!best) best = f;
    else {
      const d = Math.abs(f.tau - tau);
      const db = Math.abs(best.tau - tau);
      if (d < db || (d === db && f.tau < best.tau)) best = f;
    }
  }
  return best;
}

/** Hours from the forecast to a candidate's first wet frame (frequency ≥ 0.5), or null. */
export function firstWetHours(c: Candidate, issuedAt: string): number | null {
  return c.firstWet ? Math.round((ms(c.firstWet) - ms(issuedAt)) / HOUR) : null;
}

export type Timing = {
  /** Lead of the first frame in which the building is wet in at least half the runs. */
  firstWetH: number;
  /** Earliest the water could arrive: the start of that frame's lead interval. */
  earliest: string;
  /** The frame time itself: by then it's wet in at least half the runs. */
  latest: string;
  /** Bags in place by: earliest arrival minus the deployment time. */
  deployBy: string;
};

/**
 * Arrival window and deploy-by time for a candidate.
 *
 * S3 only knows the frames (6, 12, 24, 36, 48, 72 h), so "first wet at +12 h"
 * means the water arrives somewhere between +6 h and +12 h. Like the S4
 * exclusion rule, we count from the start of that interval, so the deploy-by
 * time is before the earliest the water could come:
 *   deployBy = issuedAt + (previous frame lead, or 0) − DEPLOY_HOURS.
 * Null when the building is never wet in half the runs (no deadline).
 */
export function timing(c: Candidate, issuedAt: string, taus: number[], deployH = DEPLOY_HOURS): Timing | null {
  const h = firstWetHours(c, issuedAt);
  if (h === null || !c.firstWet) return null;
  const earlier = taus.filter((t) => t < h);
  const startH = earlier.length ? Math.max(...earlier) : 0;
  const t0 = ms(issuedAt);
  return {
    firstWetH: h,
    earliest: iso(t0 + startH * HOUR),
    latest: c.firstWet,
    deployBy: iso(t0 + (startH - deployH) * HOUR),
  };
}

/** Is the building wet (in half the runs) in the frame for `tau`? */
export function wetByHour(c: Candidate, issuedAt: string, tau: number): boolean {
  const h = firstWetHours(c, issuedAt);
  return h !== null && h <= tau;
}

/** Earliest deploy-by time among the shown candidates, or null if none has a deadline. */
export function firstDeadline(shown: Candidate[], issuedAt: string, taus: number[]): string | null {
  const times = shown.map((c) => timing(c, issuedAt, taus)?.deployBy).filter((t): t is string => !!t);
  return times.length ? times.reduce((a, b) => (ms(b) < ms(a) ? b : a)) : null;
}

/** "January 2014" for a UTC time, in UK wall-clock months. */
export function monthYear(t: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", month: "long", year: "numeric" }).format(
    new Date(t),
  );
}

export type HeadlineInput = {
  /** "e2014" (or another replay id) or "live". */
  context: string;
  issuedAt: string;
  shown: Candidate[];
  budget: number;
  /** Earliest deploy-by time, already formatted for the UK (or null). */
  deadline: string | null;
};

const buildings = (n: number): string => (n === 1 ? "building" : "buildings");

/**
 * The headline sentence, built from the data only. Screening wording: these are
 * the places to *check* first, never an instruction.
 */
export function headline({ context, issuedAt, shown, budget, deadline }: HeadlineInput): string {
  const n = shown.length;
  const bags = `${budget.toLocaleString("en-GB")} sandbags`;
  if (context === "live") {
    if (n === 0 || !deadline) return "Nothing to protect right now.";
    const lead = `Right now, ${n === 1 ? "1 building is" : `${n} buildings are`} first in line for ${bags}`;
    return `${lead}: the earliest needs them in place by ${deadline}.`;
  }
  const when = `If ${monthYear(issuedAt)} happened again`;
  if (n === 0) return `${when}, no building passes the sandbag screening with ${bags}.`;
  const lead = `${when}, ${n === 1 ? "this building would" : `these ${n} buildings would`} be first in line for ${bags}`;
  return deadline ? `${lead}: the earliest needs them in place by ${deadline}.` : `${lead}.`;
}

/** True when the live screening has nothing with a deadline (nothing likely to get wet). */
export function nothingToProtect(shown: Candidate[], issuedAt: string, taus: number[]): boolean {
  return firstDeadline(shown, issuedAt, taus) === null;
}

/**
 * The S3 check in plain words: IoU is the overlap of the two areas divided by
 * their combined area.
 */
export function validationSentence(v: SpreadManifest["validation"]): string | null {
  if (!v) return null;
  const pct = Math.round(v.iou * 100);
  const label = v.eventId === "e2014" ? "2014" : v.eventId;
  return `Checked against the real recorded ${label} flood outline: the two areas overlap by ${pct}% (overlap ÷ combined area).`;
}

/** "water could reach here in ≈ 12 h" style caption for the hour slider. */
export function hourCaption(tau: number): string {
  return `Shaded: where water could reach within ≈ ${tau} h`;
}

/** Short name for a building from its first reason ("OSM retail" → "Retail"), else "Building". */
export function buildingKind(c: Candidate): string {
  const m = /\(OSM ([^,)]+)/.exec(c.reasons[0] ?? "");
  const kind = m?.[1]?.trim() ?? "building";
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}
