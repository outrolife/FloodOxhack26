import { describe, expect, it } from "vitest";
import {
  PRESETS,
  advice,
  expectedCosts,
  formatPct,
  interpolateTradeoff,
  liveProbability,
  officialFromPerEvent,
  officialFromReplays,
  officialMeanLeadH,
  optimalTrigger,
  totalCost,
  type Forecast,
  type TradeoffRow,
} from "./costLoss";

const row = (pStar: number, hits: number, misses: number, falseAlarms: number, lead: number | null, vsOff: number | null = null): TradeoffRow => ({
  pStar,
  hits,
  misses,
  falseAlarms,
  meanLeadH: lead,
  meanLeadVsOfficialH: vsOff,
});

// 6 crossings in total; lowering the trigger trades misses for false alarms.
const ROWS: TradeoffRow[] = [
  row(0.5, 4, 2, 1, 20, 4),
  row(0.1, 6, 0, 8, 40, 12),
  row(0.3, 5, 1, 3, 30, 8),
  row(0.9, 1, 5, 0, null, null),
];

describe("presets", () => {
  it("match the spec", () => {
    expect(PRESETS.map((p) => [p.id, p.C, p.L])).toEqual([
      ["resident", 20, 2000],
      ["commuter", 5, 100],
      ["council", 5000, 100000],
    ]);
  });
});

describe("optimalTrigger", () => {
  it("is C / L", () => {
    expect(optimalTrigger({ C: 20, L: 2000 })).toBeCloseTo(0.01);
    expect(optimalTrigger({ C: 5, L: 100 })).toBeCloseTo(0.05);
    expect(optimalTrigger({ C: 5000, L: 100000 })).toBeCloseTo(0.05);
  });
  it("clamps to [0, 1] and handles degenerate costs", () => {
    expect(optimalTrigger({ C: 300, L: 100 })).toBe(1);
    expect(optimalTrigger({ C: 0, L: 100 })).toBe(0);
    expect(optimalTrigger({ C: 10, L: 0 })).toBe(1);
  });
});

describe("interpolateTradeoff", () => {
  it("returns exact rows regardless of input order", () => {
    const o = interpolateTradeoff(ROWS, 0.3)!;
    expect([o.hits, o.misses, o.falseAlarms, o.meanLeadH, o.clamped]).toEqual([5, 1, 3, 30, null]);
  });
  it("interpolates linearly between rows", () => {
    const o = interpolateTradeoff(ROWS, 0.2)!;
    expect(o.hits).toBeCloseTo(5.5);
    expect(o.misses).toBeCloseTo(0.5);
    expect(o.falseAlarms).toBeCloseTo(5.5);
    // hit-weighted: (0.5*6*40 + 0.5*5*30) / (0.5*6 + 0.5*5)
    expect(o.meanLeadH).toBeCloseTo((120 + 75) / 5.5);
    expect(o.pStarUsed).toBeCloseTo(0.2);
  });
  it("ignores null leads (no hits) when interpolating", () => {
    const o = interpolateTradeoff(ROWS, 0.7)!;
    expect(o.hits).toBeCloseTo(2.5);
    expect(o.meanLeadH).toBe(20);
    expect(o.meanLeadVsOfficialH).toBe(4);
  });
  it("clamps outside the grid and flags it", () => {
    const lo = interpolateTradeoff(ROWS, 0.01)!;
    expect([lo.hits, lo.falseAlarms, lo.pStarUsed, lo.clamped]).toEqual([6, 8, 0.1, "below"]);
    const hi = interpolateTradeoff(ROWS, 0.95)!;
    expect([hi.hits, hi.meanLeadH, hi.clamped]).toEqual([1, null, "above"]);
    expect(interpolateTradeoff(ROWS, 0.1)!.clamped).toBeNull();
  });
  it("returns null with no rows", () => {
    expect(interpolateTradeoff([], 0.5)).toBeNull();
  });
});

describe("expectedCosts", () => {
  it("scores the four strategies with hit/FA = C, miss = L", () => {
    const official = { hits: 3, misses: 3, falseAlarms: 1 };
    const r = expectedCosts({ rows: ROWS, costs: { C: 10, L: 100 }, official, pStar: 0.3 });
    expect(r.crossings).toBe(6);
    const cost = Object.fromEntries(r.strategies.map((s) => [s.key, s.cost]));
    expect(cost.riverClock).toBe((5 + 3) * 10 + 1 * 100); // 180
    expect(cost.official).toBe((3 + 1) * 10 + 3 * 100); // 340
    expect(cost.neverAct).toBe(6 * 100); // 600
    expect(cost.alwaysAct).toBe((6 + 8) * 10); // 140: all crossings + max false alarms
    expect(r.best).toBe("alwaysAct");
  });
  it("defaults p* to C / L and keeps strategy order", () => {
    const r = expectedCosts({ rows: ROWS, costs: { C: 50, L: 100 }, official: null });
    expect(r.pStar).toBeCloseTo(0.5);
    expect(r.strategies.map((s) => s.key)).toEqual(["riverClock", "official", "neverAct", "alwaysAct"]);
    expect(r.strategies[1].cost).toBeNull();
    // RC at 0.5: (4+1)*50 + 2*100 = 450; never = 600; always = 14*50 = 700
    expect(r.strategies[0].cost).toBe(450);
    expect(r.best).toBe("riverClock");
  });
  it("handles a spot with no tradeoff rows", () => {
    const r = expectedCosts({ rows: [], costs: { C: 1, L: 10 }, official: { hits: 1, misses: 0, falseAlarms: 0 } });
    expect(r.outcomes).toBeNull();
    expect(r.strategies.filter((s) => s.cost !== null).map((s) => s.key)).toEqual(["official"]);
    expect(r.best).toBe("official");
  });
  it("totalCost matches the rule", () => {
    expect(totalCost({ hits: 2, misses: 1, falseAlarms: 3 }, { C: 5, L: 100 })).toBe(125);
  });
});

describe("official warnings", () => {
  it("derives counts from replays (warnings only, issued before crossing)", () => {
    const c = officialFromReplays(
      [
        // warned before crossing: hit
        { eventId: "a", official: [{ spot: "osney", type: "warning", issuedAt: "2014-01-05T10:00:00Z", precision: "time" }], crossings: [{ spot: "osney", t: "2014-01-06T00:00:00Z" }] },
        // warned after crossing: miss
        { eventId: "b", official: [{ spot: "osney", type: "severe", issuedAt: "2020-01-07T00:00:00Z", precision: "time" }], crossings: [{ spot: "osney", t: "2020-01-06T00:00:00Z" }] },
        // alert only + crossing: miss
        { eventId: "c", official: [{ spot: "osney", type: "alert", issuedAt: "2021-01-01T00:00:00Z", precision: "time" }], crossings: [{ spot: "osney", t: "2021-01-02T00:00:00Z" }] },
        // warning, no crossing: false alarm
        { eventId: "d", official: [{ spot: "osney", type: "warning", issuedAt: "2024-01-01T00:00:00Z", precision: "date" }], crossings: [] },
        // other spot only: ignored
        { eventId: "e", official: [{ spot: "botley", type: "warning", issuedAt: "2024-01-01T00:00:00Z", precision: "time" }], crossings: [] },
      ],
      "osney",
    );
    expect(c).toEqual({ hits: 1, misses: 2, falseAlarms: 1 });
    expect(officialFromReplays([], "osney")).toBeNull();
  });
  it("derives counts from perEvent", () => {
    const ev = (spot: string, crossed: boolean, lead: number | null) => ({ eventId: "x", spot, crossed, peakObs: 1, arrivalErrH: null, leadVsOfficialH: lead });
    const c = officialFromPerEvent([ev("osney", true, 6), ev("osney", true, null), ev("osney", false, -2), ev("osney", false, null), ev("botley", true, 3)], "osney");
    expect(c).toEqual({ hits: 1, misses: 1, falseAlarms: 1 });
    expect(officialFromPerEvent([], "osney")).toBeNull();
  });
  it("estimates official mean lead from ours minus our gain", () => {
    expect(officialMeanLeadH(interpolateTradeoff(ROWS, 0.3)!)).toBe(22);
    expect(officialMeanLeadH(interpolateTradeoff(ROWS, 0.9)!)).toBeNull();
  });
});

const q = { "05": 0, "10": 0, "25": 0, "50": 0, "75": 0, "90": 0, "95": 0 };
const FORECAST: Forecast = {
  issuedAt: "2026-10-24T16:00:00Z",
  dataAsOf: { osney: "2026-10-24T15:45:00Z" },
  stale: ["kings"],
  spots: [
    { spot: "osney", levelNow: 1, mode: "probability", arrival: null, leads: [
      { h: 12, q, pFlood: 0.1, pAmber: 0.3 },
      { h: 24, q, pFlood: 0.34, pAmber: 0.6 },
    ] },
    { spot: "botley", levelNow: 1, mode: "probability", arrival: null, leads: [
      { h: 36, q, pFlood: 0.4, pAmber: 0.6 },
      { h: 12, q, pFlood: 0.2, pAmber: 0.3 },
    ] },
    { spot: "kings", levelNow: 1, mode: "probability", arrival: null, leads: [] },
    { spot: "abingdon", levelNow: 1, mode: "timing_only", arrival: null, leads: [{ h: 24, q, pFlood: null, pAmber: 0.2 }] },
  ],
};

describe("liveProbability", () => {
  it("reads the 24 h lead", () => {
    expect(liveProbability(FORECAST, "osney")).toEqual({ status: "ok", p: 0.34 });
  });
  it("interpolates between leads", () => {
    const r = liveProbability(FORECAST, "botley");
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.p).toBeCloseTo(0.3);
  });
  it("reports why there is no probability", () => {
    expect(liveProbability(null, "osney").status).toBe("unavailable");
    expect(liveProbability(FORECAST, "nowhere").status).toBe("no-spot");
    expect(liveProbability(FORECAST, "kings").status).toBe("stale");
    expect(liveProbability(FORECAST, "abingdon").status).toBe("timing-only");
    expect(liveProbability(FORECAST, "osney", 48).status).toBe("stale");
  });
});

describe("advice", () => {
  it("says act when P >= p*", () => {
    expect(advice(0.05, { status: "ok", p: 0.34 })).toEqual({
      act: true,
      text: "At your costs, act when P ≥ 5%. Now: 34% → act.",
      head: "At your costs, act when P ≥ 5%.",
      now: "34% → act.",
    });
    expect(advice(0.05, { status: "ok", p: 0.05 }).act).toBe(true);
  });
  it("says don't act yet when P < p*", () => {
    expect(advice(0.5, { status: "ok", p: 0.34 })).toMatchObject({ act: false, text: "At your costs, act when P ≥ 50%. Now: 34% → don't act yet." });
  });
  it("degrades without live data", () => {
    expect(advice(0.01, { status: "unavailable" })).toMatchObject({
      act: null,
      text: "At your costs, act when P ≥ 1%. Now: Live data unavailable.",
      now: "Live data unavailable.",
    });
  });
  it("handles C >= L", () => {
    expect(advice(1, { status: "ok", p: 0.99 }).act).toBe(false);
  });
  it("formats percentages", () => {
    expect(formatPct(0.01)).toBe("1%");
    expect(formatPct(0.025)).toBe("2.5%");
    expect(formatPct(0.333)).toBe("33%");
    expect(formatPct(0)).toBe("0%");
  });
});
