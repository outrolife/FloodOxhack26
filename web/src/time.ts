// All data is UTC (ISO 8601). We only convert to Europe/London for display,
// and only through Intl, never with manual offsets: clocks change on
// Sun 25 Oct 2026 (BST -> GMT) and Intl handles that for us.
//
// The zone label ("BST"/"GMT") is derived from the UTC offset Intl gives us,
// not from Intl's own zone name: Chrome prints "GMT+0" for UK winter time
// where Node prints "GMT" (#59).

const TZ = "Europe/London";

const fmtDayTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

const fmtShort = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
});

// Numeric UK wall-clock fields, for working out the offset from UTC.
const fmtParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  hourCycle: "h23",
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
export const formatDateTime = (t: string | number | Date): string => `${fmtDayTime.format(toDate(t))} ${zoneAt(t)}`;
/** "Thu 18:00 GMT" */
export const formatShort = (t: string | number | Date): string => `${fmtShort.format(toDate(t))} ${zoneAt(t)}`;
/** "9 Jan 2014" */
export const formatDate = (t: string | number | Date): string => fmtDate.format(toDate(t));
/** Compact chart-axis label, "9 Jan, 18" (zone given in the axis title). */
export const formatAxis = (t: string | number | Date): string => fmtAxis.format(toDate(t));

const fmtDayTimeYear = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const fmtDayMonth = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "numeric", month: "short" });

/** "Thu 9 Jan 2014, 18:00 GMT": for past events (Time Machine), where the year matters. */
export const formatDateTimeYear = (t: string | number | Date): string =>
  // With a year, en-GB puts a comma after the weekday ("Thu, 9 Jan 2014"); drop it to match formatDateTime.
  `${fmtDayTimeYear.format(toDate(t)).replace(/^(\w+),/, "$1")} ${zoneAt(t)}`;
/** Day-tick axis label, "9 Jan". */
export const formatDayMonth = (t: string | number | Date): string => fmtDayMonth.format(toDate(t));

/** Minutes Europe/London is ahead of UTC at time t (0 in GMT, 60 in BST). */
export function londonOffsetMinutes(t: string | number | Date): number {
  const d = toDate(t);
  const p: Record<string, number> = {};
  for (const x of fmtParts.formatToParts(d)) if (x.type !== "literal") p[x.type] = Number(x.value);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  const utc = Math.floor(d.getTime() / 60_000) * 60_000; // drop seconds, as the wall clock does
  return Math.round((wall - utc) / 60_000);
}

/** UK zone name for an offset from UTC: "GMT" (0), "BST" (+60), else "UTC+n". */
export function zoneFromOffset(minutes: number): string {
  if (minutes === 0) return "GMT";
  if (minutes === 60) return "BST";
  const h = minutes / 60;
  return `UTC${h >= 0 ? "+" : ""}${h}`;
}

/** Zone abbreviation in force at time t ("BST" or "GMT"). */
export function zoneAt(t: string | number | Date): string {
  const off = londonOffsetMinutes(t);
  return Number.isFinite(off) ? zoneFromOffset(off) : "UK time";
}

const fmtIsoDay = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });

/** Whole UK calendar days from a to b (for date-only official times, SPEC §8.2). */
export function londonDaysBetween(a: string, b: string): number {
  const day = (t: string) => Date.parse(`${fmtIsoDay.format(toDate(t))}T00:00:00Z`);
  return Math.round((day(b) - day(a)) / 86_400_000);
}

export const ms = (t: string): number => Date.parse(t);
export const HOUR = 3_600_000;

/** Signed hours between two ISO times (b - a). */
export const hoursBetween = (a: string, b: string): number => (ms(b) - ms(a)) / HOUR;
