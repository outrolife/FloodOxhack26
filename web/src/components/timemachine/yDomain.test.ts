// The Time Machine y-axis must not give away the peak before the slider gets there (#59).
import { describe, expect, it } from "vitest";
import { yDomain } from "./yDomain";

describe("yDomain", () => {
  const base = { threshold: 2.9, amber: 2.13 };

  it("ignores observations past the slider: only what's on screen sets the range", () => {
    // Level so far 1.95 m; the event later peaks at 3.2 m, but that isn't passed in.
    const [lo, hi] = yDomain({ ...base, observedSoFar: [1.95, 2.0], band: [1.9, 2.6] });
    expect(lo).toBe(1.8);
    expect(hi).toBe(3.0); // threshold 2.9 + 0.1 padding, not the 3.2 m peak
    expect(hi).toBeLessThan(3.2);
  });

  it("grows to fit the forecast fan when it goes above the threshold", () => {
    expect(yDomain({ ...base, observedSoFar: [2.5], band: [2.4, 3.35] })[1]).toBe(3.5);
  });

  it("includes observations the slider has already revealed (shown faintly)", () => {
    expect(yDomain({ ...base, observedSoFar: [2.0], revealed: [3.2] })[1]).toBe(3.3);
  });

  it("always shows the threshold and amber lines", () => {
    const [lo, hi] = yDomain({ ...base, observedSoFar: [2.5] });
    expect(lo).toBeLessThanOrEqual(2.13);
    expect(hi).toBeGreaterThanOrEqual(2.9);
  });

  it("works with no threshold (timing-only spot) and skips non-finite values", () => {
    expect(yDomain({ threshold: null, amber: 2.57, observedSoFar: [2.4, Number.NaN] })).toEqual([2.3, 2.7]);
  });
});
