// What each spot's clock shows at the playhead (#120): the chance of flooding
// within 72 h (max pFlood over leads, the same number the scoreboard's "more
// likely than not" uses) and the countdown to the 50% arrival time.
import type { Forecast, Spot } from "../../contracts";
import { pFloodMax } from "../../components/shared/forecast";
import { stateFor, type ClockState } from "../../ui";

export type ClockView = { prob: number | null; countdownH: number | null; state: ClockState };

export function clockAt(f: Forecast | undefined, spot: Spot): ClockView {
  if (spot.mode === "timing_only") return { prob: null, countdownH: null, state: "noforecast" };
  if (!f) return { prob: null, countdownH: null, state: "noforecast" };
  if (f.stale.includes(spot.gauge)) return { prob: null, countdownH: null, state: "stale" };
  const sf = f.spots.find((s) => s.spot === spot.key);
  const prob = pFloodMax(sf);
  if (!sf || prob == null) return { prob: null, countdownH: null, state: "noforecast" };
  const now = Date.parse(f.issuedAt);
  let countdownH: number | null = null;
  if (sf.levelNow >= spot.threshold) countdownH = 0; // already above flood level: "now"
  else if (sf.arrival?.p50) countdownH = Math.max(0, (Date.parse(sf.arrival.p50) - now) / 3_600_000);
  return { prob, countdownH, state: stateFor(prob) };
}
