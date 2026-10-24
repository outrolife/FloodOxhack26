// Replay screen (#120): the one-line outcome badge on each event thumbnail and
// the headline sentence over the screen. Words only; every number comes from
// ReplayFacts (read from the replay and proof.json).
import type { ReplayFacts } from "./facts";

export type Outcome =
  | { kind: "called"; leadH: number; atLeast: boolean } // flooded; River Clock said > 50% first
  | { kind: "missed"; peakP: number | null } // flooded; River Clock stayed under 50% before it
  | { kind: "calm"; peakP: number } // no flood; River Clock stayed under 50%
  | { kind: "falseAlarm"; peakP: number } // no flood; River Clock went over 50%
  | { kind: "noForecast" };

const pctText = (p: number) => `${Math.round(p * 100)}%`;

export function outcomeOf(f: ReplayFacts): Outcome {
  if (f.noForecast) return { kind: "noForecast" };
  if (f.crossing || f.crossed) {
    if (f.rc50 && f.leadBeforeFloodH != null) {
      return { kind: "called", leadH: Math.round(f.leadBeforeFloodH), atLeast: f.rc50AlreadyOn };
    }
    return { kind: "missed", peakP: f.peakChance?.p ?? null };
  }
  const p = f.peakChance?.p ?? 0;
  return p >= 0.5 ? { kind: "falseAlarm", peakP: p } : { kind: "calm", peakP: p };
}

/** "Called 37 h before the flood", "Stayed calm: highest chance 28%". */
export function badgeText(o: Outcome): string {
  switch (o.kind) {
    case "called":
      return `Called ${o.atLeast ? "at least " : ""}${o.leadH} h before the flood`;
    case "missed":
      return "Flooded before River Clock reached 50%";
    case "calm":
      return `Stayed calm: highest chance ${pctText(o.peakP)}`;
    case "falseAlarm":
      return `False alarm: reached ${pctText(o.peakP)}, no flood`;
    case "noForecast":
      return "No forecast for this spot";
  }
}

/** good = River Clock did well, bad = it did not; the badge also says it in words. */
export function outcomeTone(o: Outcome): "good" | "bad" | "neutral" {
  if (o.kind === "called" || o.kind === "calm") return "good";
  if (o.kind === "noForecast") return "neutral";
  return "bad";
}

const fmtMonthYear = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", month: "long", year: "numeric" });
/** "January 2014" in UK time. */
export const monthYear = (t: string): string => fmtMonthYear.format(new Date(t));

/** "Botley Road / New Botley / Hinksey" -> "Botley Road". */
export const shortSpotName = (name: string): string => name.split(" / ")[0].trim();

/**
 * The sentence over the screen, e.g. "January 2014: River Clock said Botley
 * Road would likely flood 37 hours before it did."
 */
export function headlineText(f: ReplayFacts, spotName: string, threshold: number, eventName: string): string {
  const o = outcomeOf(f);
  const name = shortSpotName(spotName);
  const when = f.crossing ? monthYear(f.crossing) : f.peakObs?.t ? monthYear(f.peakObs.t) : eventName;
  const below = f.peakObs ? Math.round((threshold - f.peakObs.level) * 100) : null;
  const within = below != null && below >= 0 ? `came within ${below} cm of flood level` : "stayed below flood level";
  switch (o.kind) {
    case "called":
      return `${when}: River Clock said ${name} would likely flood ${o.atLeast ? "at least " : ""}${o.leadH} hours before it did.`;
    case "missed":
      return `${when}: ${name} flooded before River Clock's chance reached 50%.`;
    case "calm":
      return `${when}: the river at ${name} ${within}, and River Clock never went above ${pctText(o.peakP)}.`;
    case "falseAlarm":
      return `${when}: River Clock gave ${name} up to ${pctText(o.peakP)}, but the river ${within}.`;
    case "noForecast":
      return `${eventName}: River Clock has no forecast for ${name}.`;
  }
}
