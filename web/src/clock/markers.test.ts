// Spot markers and link words on the flow map (#118 browser feedback).
import { describe, expect, it } from "vitest";
import { DOT_BOX, DOT_PX, PULSE_H, chanceLabel, eaBadge, justWarned, labelSide, lastReading, quietNote, ringText, spotDots, withData } from "./markers";
import { linkWords } from "./flow";
import { CLOCK_BOX, spreadApart } from "../ui/placement";

describe("spot markers", () => {
  it("shows rounded percentages, including 0%, inside the ring", () => {
    expect(ringText(null)).toBeNull();
    expect(ringText(0)).toBe("0%");
    expect(ringText(0.004)).toBe("0%");
    expect(ringText(0.005)).toBe("1%");
    expect(ringText(0.01)).toBe("1%");
    expect(ringText(0.324)).toBe("32%");
    expect(ringText(1)).toBe("100%");
    expect(chanceLabel("Botley Road", 0.004)).toBe(
      "Botley Road: 0% chance of flooding in the next 3 days, rounded to the nearest whole percent (model estimate 0.40%)",
    );
  });
  it("is small: every marker the same ~32 px", () => {
    expect(DOT_PX).toBeGreaterThanOrEqual(28);
    expect(DOT_PX).toBeLessThanOrEqual(34);
    // Osney and Botley Road at the same point move far less apart than the old clock cards did.
    const small = spreadApart([{ x: 100, y: 100 }, { x: 104, y: 100 }], DOT_BOX);
    const big = spreadApart([{ x: 100, y: 100 }, { x: 104, y: 100 }], CLOCK_BOX.md);
    expect(Math.abs(small[0].x - small[1].x)).toBeLessThan(Math.abs(big[0].x - big[1].x) / 3);
  });
  it("says why a spot has no forecast, in plain words", () => {
    expect(quietNote("stale", "2026-10-13T09:00:00Z")).toBe("No live river reading here since 13 Oct 2026");
    expect(quietNote("stale", null)).toBe("No live river reading here");
    expect(quietNote("noforecast", null)).toBe("Too little history at this gauge to forecast");
    expect(quietNote("likely", null)).toBeNull();
    const f = { dataAsOf: { wolvercote: "2026-10-13T09:00:00Z" }, observed: { other: [{ t: "2026-10-24T09:00:00Z", level: 1 }] } };
    expect(lastReading(f, "wolvercote")).toBe("2026-10-13T09:00:00Z");
    expect(lastReading(f, "other")).toBe("2026-10-24T09:00:00Z");
    expect(lastReading(null, "x")).toBeNull();
    const dots = spotDots(
      [{ key: "w", label: "Wolvercote", lat: 0, lon: 0, prob: null, countdownH: null, state: "stale" }],
      f,
      [{ key: "w", gauge: "wolvercote" }],
    );
    expect(dots[0].note).toMatch(/since 13 Oct/);
  });
  it("puts the name on the side away from the push", () => {
    expect(labelSide(-10)).toBe("left");
    expect(labelSide(0)).toBe("right");
  });
});

describe("link words (hover, no permanent labels)", () => {
  it("says where the water goes and how long it takes", () => {
    expect(linkWords({ tHalfH: 30.6, n: 7, lowConfidence: false }, "Islip", "Kings Mill")).toBe(
      "Water passing Islip reaches Kings Mill about 31 h later (from 7 past rises)",
    );
    expect(linkWords({ tHalfH: 12, n: 1, lowConfidence: true }, "A", "B")).toBe(
      "Water passing A reaches B about 12 h later (only from 1 past rise, so a rough guide)",
    );
  });
});

describe("replay badges and the warning pulse", () => {
  const f = {
    rc50: "2014-01-04T05:00:00Z",
    official: { spot: "botley", type: "warning" as const, issuedAt: "2014-01-04T12:00:00Z", precision: "time" as const },
    leadVsOfficialH: 7.06,
  };
  const T = Date.parse;
  it("shows FloodClock vs the EA only once both have happened, with its honest sign", () => {
    expect(eaBadge(f, T("2014-01-04T06:00:00Z"))).toBeNull();
    expect(eaBadge(f, T("2014-01-04T12:00:00Z"))).toEqual({ text: "Warned 7 h before EA", tone: "good" });
    expect(eaBadge({ ...f, leadVsOfficialH: -8.2 }, Infinity)).toEqual({ text: "8 h after EA", tone: "bad" });
    expect(eaBadge({ ...f, leadVsOfficialH: 0.2 }, Infinity)?.text).toBe("Same time as EA");
    expect(eaBadge({ ...f, leadVsOfficialH: null }, Infinity)).toBeNull();
    expect(eaBadge({ ...f, official: null }, Infinity)).toBeNull();
    expect(eaBadge(null, Infinity)).toBeNull();
  });
  it("pulses for 12 simulated hours after FloodClock's warning", () => {
    expect(justWarned(f, T("2014-01-04T04:00:00Z"))).toBe(false);
    expect(justWarned(f, T("2014-01-04T05:00:00Z"))).toBe(true);
    expect(justWarned(f, T("2014-01-04T05:00:00Z") + PULSE_H * 3_600_000)).toBe(false);
    expect(justWarned({ rc50: null }, Infinity)).toBe(false);
  });
});

describe("withData", () => {
  const f = { stale: [] } as unknown as Parameters<typeof withData>[1];
  const dots = [
    { key: "osney", state: "watch" as const },
    { key: "wolvercote", state: "noforecast" as const },
    { key: "cherwell", state: "stale" as const },
  ];
  it("leaves spots with no forecast or an offline gauge off the map", () => {
    expect(withData(dots, f).map((d) => d.key)).toEqual(["osney"]);
  });
  it("shows every spot until a forecast has loaded", () => {
    expect(withData(dots, null)).toHaveLength(3);
  });
});
