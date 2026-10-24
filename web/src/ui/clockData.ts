// Forecast → SpotClock props (#118), shared by Now and Replay so both screens
// read a forecast the same way. Pure, so it is unit-tested.
//   prob       = highest chance of flooding over the 72 h leads (chance "within 3 days")
//   countdownH = hours from the forecast time to the middle arrival estimate (arrival.p50), if any
//   state      = "stale" if the gauge is offline, "noforecast" if timing-only or no leads,
//                else stateFor(prob)
import type { Forecast, Spot } from "../contracts";
import { stateFor, type ClockState } from "./SpotClock";

export type ClockProps = { key: string; label: string; lat: number; lon: number; prob: number | null; countdownH: number | null; state: ClockState };

/** "Botley Road / New Botley / Hinksey" → "Botley Road". */
export const shortSpotName = (name: string): string => name.split(" / ")[0].trim();

export function clockFor(f: Forecast | null, spot: Pick<Spot, "key" | "name" | "gauge" | "lat" | "lon">): ClockProps {
  const base = { key: spot.key, label: shortSpotName(spot.name), lat: spot.lat, lon: spot.lon };
  const sf = f?.spots.find((s) => s.spot === spot.key);
  if (!f || !sf) return { ...base, prob: null, countdownH: null, state: "noforecast" };
  if (f.stale.includes(spot.gauge)) return { ...base, prob: null, countdownH: null, state: "stale" };
  if (sf.mode === "timing_only" || sf.leads.length === 0) return { ...base, prob: null, countdownH: null, state: "noforecast" };
  let prob: number | null = null;
  for (const l of sf.leads) if (l.pFlood != null) prob = Math.max(prob ?? 0, l.pFlood);
  const p50 = sf.arrival?.p50;
  const countdownH = p50 ? Math.max((Date.parse(p50) - Date.parse(f.issuedAt)) / 3_600_000, 0) : null;
  return { ...base, prob, countdownH, state: prob == null ? "noforecast" : stateFor(prob) };
}

export function clocksFor(f: Forecast | null, spots: Pick<Spot, "key" | "name" | "gauge" | "lat" | "lon">[]): ClockProps[] {
  return spots.map((s) => clockFor(f, s));
}
