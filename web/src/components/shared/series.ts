// Fast time lookups on hourly level series (sorted by time, as in
// Replay.observed and Forecast.observed). The Time Machine redraws a dozen
// series on every slider step; parsing every ISO string each time made
// scrubbing a 1,489-hour replay visibly slow, so parsed times are cached per
// array.
export type Point = { t: string; level: number };

const cache = new WeakMap<readonly Point[], Float64Array>();

/** Epoch-ms time of every point (parsed once per array). */
export function timesOf(points: readonly Point[]): Float64Array {
  let ts = cache.get(points);
  if (!ts) {
    ts = Float64Array.from(points, (p) => Date.parse(p.t));
    cache.set(points, ts);
  }
  return ts;
}

/** How many points are at or before `cut` (epoch ms); binary search. */
export function countAtOrBefore(points: readonly Point[], cut: number): number {
  const ts = timesOf(points);
  let lo = 0;
  let hi = ts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] <= cut) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
