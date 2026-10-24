// Timeline comparison for the Time Machine (#14): when River Clock first
// reached 50% for a spot vs when the EA issued its first Flood Alert and its
// first Flood Warning for that spot's area.
import type { Replay } from "../../contracts";
import { formatDate, formatDateTime, hoursBetween } from "../../time";

export type Official = Replay["official"][number];

const TYPE_LABEL: Record<Official["type"], string> = {
  alert: "Flood Alert",
  warning: "Flood Warning",
  severe: "Severe Flood Warning",
};

export const officialLabel = (o: Official): string => TYPE_LABEL[o.type];

/** Issue time in UK time, or just the date when only the date is known. */
export const formatOfficial = (o: Official): string =>
  o.precision === "date" ? `on ${formatDate(o.issuedAt)} (time not recorded)` : formatDateTime(o.issuedAt);

/** First alert and first warning (warning or severe) for one spot. */
export function firstOfficials(replay: Replay, spot: string): { alert?: Official; warning?: Official } {
  const list = replay.official
    .filter((o) => o.spot === spot)
    .sort((a, b) => Date.parse(a.issuedAt) - Date.parse(b.issuedAt));
  return { alert: list.find((o) => o.type === "alert"), warning: list.find((o) => o.type !== "alert") };
}

/**
 * One sentence comparing River Clock's first >= 50% time with an official
 * issue time, e.g. "River Clock reached 50% 34 h earlier than the official
 * Flood Warning." Returns null until both known times have been revealed.
 */
export function compareSentence(
  rc50: string | undefined,
  official: Official | undefined,
  kind: "alert" | "warning",
  revealed: (t: string) => boolean,
): string | null {
  const noun = official ? officialLabel(official) : kind === "alert" ? "Flood Alert" : "Flood Warning";
  if (rc50 && official) {
    if (!revealed(rc50) || !revealed(official.issuedAt)) return null;
    const d = hoursBetween(rc50, official.issuedAt);
    const approx = official.precision === "date" ? " (official issue known to the day only, so this is approximate)" : "";
    const h = Math.abs(d).toFixed(0);
    if (Math.abs(d) < 0.5) return `River Clock reached 50% at about the same time as the official ${noun}${approx}.`;
    return d > 0
      ? `River Clock reached 50% ${h} h earlier than the official ${noun}${approx}.`
      : `River Clock reached 50% ${h} h later than the official ${noun}${approx}.`;
  }
  if (rc50 && !official) {
    if (!revealed(rc50)) return null;
    return `River Clock reached 50%; no official ${noun} for this spot so far.`;
  }
  if (official && !rc50) {
    if (!revealed(official.issuedAt)) return null;
    return `The EA issued a ${noun}; River Clock has not reached 50% for this spot.`;
  }
  return null;
}
