// Optional observed history on a live Forecast (`Forecast.observed`, SPEC §9:
// hourly levels over the last 7 days, same shape as Replay.observed). The
// field is optional and comes from the live API, so points are still checked:
// anything malformed is dropped and the UI shows "7-day history unavailable".
import type { Forecast } from "../../contracts";

export type Point = { t: string; level: number };

const DAY_MS = 86_400_000;

function isPoint(p: unknown): p is Point {
  if (typeof p !== "object" || p === null) return false;
  const o = p as Record<string, unknown>;
  return typeof o.t === "string" && typeof o.level === "number" && Number.isFinite(o.level) && !Number.isNaN(Date.parse(o.t));
}

/** Last 7 days of observed levels per gauge, or null if the forecast has none. */
export function liveObserved(f: Forecast | null): Record<string, Point[]> | null {
  const raw = f?.observed;
  if (!f || typeof raw !== "object" || raw === null) return null;
  const end = Date.parse(f.issuedAt);
  const start = end - 7 * DAY_MS;
  const out: Record<string, Point[]> = {};
  for (const [gauge, series] of Object.entries(raw)) {
    if (!Array.isArray(series)) continue;
    const pts = series
      .filter(isPoint)
      .filter((p) => {
        const t = Date.parse(p.t);
        return t >= start && t <= end;
      })
      .sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
    if (pts.length > 1) out[gauge] = pts;
  }
  return Object.keys(out).length > 0 ? out : null;
}
