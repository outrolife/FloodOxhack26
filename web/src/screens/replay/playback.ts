// Replay playback clock (#120). Playback runs on a simulated time that moves
// SIM_HOURS_PER_2S simulated hours per 2 real seconds (times the speed), driven
// by requestAnimationFrame. The forecast shown is the last one issued at or
// before that time, so a fast speed skips forecasts instead of queueing them.

export const SIM_HOURS_PER_2S = 12; // SPEC §10.2: one simulated 12 h per 2 s at 1×
export const SPEEDS = [1, 4] as const;
const HOUR = 3_600_000;

/** Simulated ms that pass in `realMs` of wall time at `speed`. */
export const simAdvance = (realMs: number, speed: number): number =>
  (realMs / 2000) * SIM_HOURS_PER_2S * HOUR * speed;

/** Index of the last time <= t in an ascending list (0 if t is before the first). */
export function indexAt(times: number[], t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  if (hi < 0 || t <= times[0]) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
