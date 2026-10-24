const gbp = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 });
const gbpCompact = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  notation: "compact",
  maximumFractionDigits: 1,
});

/** "£12,500" */
export const formatGBP = (v: number): string => gbp.format(v);
/** "£12.5K" (axis ticks) */
export const formatGBPCompact = (v: number): string => gbpCompact.format(v);

/** Interpolated counts can be fractional: whole numbers stay whole, else one decimal. */
export function formatCount(v: number): string {
  const r = Math.round(v * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/** "38.5 h" or "–" */
export const formatHours = (v: number | null): string => (v === null ? "–" : `${formatCount(v)} h`);

/** Round to 2 significant figures, for log-scale slider values. */
export function niceRound(v: number): number {
  if (v <= 0) return 0;
  const mag = 10 ** (Math.floor(Math.log10(v)) - 1);
  return Math.round(v / mag) * mag;
}
