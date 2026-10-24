// #118: one way to turn a forecast into clock props, for Now and Replay.
import { describe, expect, it } from "vitest";
import type { Forecast, Spot } from "../contracts";
import live from "../../public/data/live.json";
import spots from "../../public/data/spots.json";
import { clockFor, clocksFor } from "./clockData";

const q = { "05": 1, "10": 1, "25": 1, "50": 1, "75": 1, "90": 1, "95": 1 };
const spot = { key: "botley", name: "Botley Road / New Botley / Hinksey", gauge: "newbotley", lat: 51.75, lon: -1.28 };
const f = (p: number, extra: Partial<Forecast["spots"][number]> = {}, stale: string[] = []): Forecast => ({
  issuedAt: "2014-01-04T12:00:00Z",
  dataAsOf: {},
  stale,
  spots: [{ spot: "botley", levelNow: 2, mode: "probability", arrival: { p10: null, p50: "2014-01-06T01:00:00Z", p90: null }, leads: [{ h: 24, q, pFlood: p / 2, pAmber: p }, { h: 72, q, pFlood: p, pAmber: p }], ...extra }],
});

describe("clockFor", () => {
  it("uses the highest chance over the leads and counts down to arrival.p50", () => {
    const c = clockFor(f(0.63), spot);
    expect(c).toMatchObject({ label: "Botley Road", prob: 0.63, state: "likely" });
    expect(c.countdownH).toBeCloseTo(37);
  });
  it("shows offline and no-forecast spots as such", () => {
    expect(clockFor(f(0.2, {}, ["newbotley"]), spot).state).toBe("stale");
    expect(clockFor(f(0.2, { mode: "timing_only" }), spot).state).toBe("noforecast");
    expect(clockFor(null, spot).state).toBe("noforecast");
  });
  it("covers every spot in the committed live forecast, Wolvercote without a forecast", () => {
    const clocks = clocksFor(live as Forecast, spots as Spot[]);
    expect(clocks).toHaveLength((spots as Spot[]).length);
    expect(clocks.find((c) => c.key === "wolvercote")?.state).toBe("noforecast");
  });
});
