// All data is UTC (ISO 8601). We only convert to Europe/London for display,
// and only through Intl, never with manual offsets: clocks change on
// Sun 25 Oct 2026 (BST -> GMT) and Intl handles that for us.

const TZ = "Europe/London";

const fmtDayTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZoneName: "short",
});

const fmtShort = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZoneName: "short",
});

const fmtDate = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  day: "numeric",
  month: "short",
  year: "numeric",
});

const fmtAxis = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  day: "numeric",
  month: "short",
  hour: "2-digit",
});

const toDate = (t: string | number | Date): Date => (t instanceof Date ? t : new Date(t));

/** "Thu 9 Jan, 18:00 GMT" */
export const formatDateTime = (t: string | number | Date): string => fmtDayTime.format(toDate(t));
/** "Thu 18:00 GMT" */
export const formatShort = (t: string | number | Date): string => fmtShort.format(toDate(t));
/** "9 Jan 2014" */
export const formatDate = (t: string | number | Date): string => fmtDate.format(toDate(t));
/** Compact chart-axis label, "9 Jan, 18" (zone given in the axis title). */
export const formatAxis = (t: string | number | Date): string => fmtAxis.format(toDate(t));

/** Zone abbreviation in force at time t ("BST" or "GMT"). */
export function zoneAt(t: string | number | Date): string {
  const part = fmtShort.formatToParts(toDate(t)).find((p) => p.type === "timeZoneName");
  return part?.value ?? "UK time";
}

export const ms = (t: string): number => Date.parse(t);
export const HOUR = 3_600_000;

/** Signed hours between two ISO times (b - a). */
export const hoursBetween = (a: string, b: string): number => (ms(b) - ms(a)) / HOUR;
