import { describe, expect, it } from "vitest";
import { OXFORD_BOUNDS, safeBounds } from "./bounds";

describe("safeBounds", () => {
  it("keeps valid bounds", () => {
    const b: [[number, number], [number, number]] = [[51.7, -1.3], [51.8, -1.2]];
    expect(safeBounds(b)).toBe(b);
  });

  it("falls back to Oxford for bounds built from no data (the blank-page crash)", () => {
    const empty: [[number, number], [number, number]] = [[Infinity, Infinity], [-Infinity, -Infinity]];
    expect(safeBounds(empty)).toBe(OXFORD_BOUNDS);
    expect(safeBounds([[0, NaN], [0, NaN]])).toBe(OXFORD_BOUNDS);
    expect(safeBounds(undefined)).toBe(OXFORD_BOUNDS);
  });

  it("falls back for a box with no extent", () => {
    expect(safeBounds([[51.75, -1.27], [51.75, -1.27]])).toBe(OXFORD_BOUNDS);
  });
});
