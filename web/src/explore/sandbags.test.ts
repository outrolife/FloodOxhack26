import { describe, expect, it } from "vitest";
import { DEFAULT_INPUTS, FORMULA_PLAIN, estimateForDepth, estimateSandbags, sanitizeInputs } from "./sandbags";

describe("estimateSandbags", () => {
  it("matches the worked example: high risk, 2 street-level 0.9 m doors = 40 bags", () => {
    const e = estimateSandbags("high", DEFAULT_INPUTS);
    expect(e).toMatchObject({ depthM: 0.6, effectiveDepthM: 0.6, layers: 6, bagsPerLayer: 3, openings: 2, subtotal: 36, margin: 4, total: 40, capped: false });
    expect(e.steps[0]).toBe("1. High risk zone → plan for about 0.6 m of water.");
    expect(e.steps[4]).toBe("5. 2 doors × 6 layers × 3 bags = 36 bags, plus 10% spare (4) = **40 sandbags**.");
    expect(e.steps).toHaveLength(5);
  });

  it("takes off the floor raise", () => {
    const e = estimateSandbags("high", { ...DEFAULT_INPUTS, floorLevel: "one_step" });
    expect(e.effectiveDepthM).toBeCloseTo(0.45);
    expect(e.layers).toBe(5);
    expect(e.total).toBe(2 * 5 * 3 + 3);
    expect(e.steps[1]).toContain("0.6 m − 0.15 m = 0.45 m");
  });

  it("needs no bags for an upper-floor flat", () => {
    const e = estimateSandbags("high", { ...DEFAULT_INPUTS, floorLevel: "upper", basement: true });
    expect(e).toMatchObject({ effectiveDepthM: 0, layers: 0, total: 0, capped: false });
    expect(e.steps.join(" ")).toContain("Upper-floor flat");
  });

  it("needs no bags when the floor is above the water", () => {
    const e = estimateSandbags("very_low", { ...DEFAULT_INPUTS, floorLevel: "raised" });
    expect(e.total).toBe(0);
    expect(e.layers).toBe(0);
  });

  it("adds one opening for a basement", () => {
    const e = estimateSandbags("medium", { ...DEFAULT_INPUTS, basement: true });
    expect(e.openings).toBe(3);
    expect(e.layers).toBe(4);
    expect(e.subtotal).toBe(3 * 4 * 3);
    expect(e.margin).toBe(4);
    expect(e.total).toBe(40);
    expect(e.steps[4]).toContain("2 doors + 1 basement = 3 openings");
  });

  it("caps the layers at 6 and says why", () => {
    const e = estimateForDepth(1.0, DEFAULT_INPUTS, "Deep water");
    expect(e.capped).toBe(true);
    expect(e.layers).toBe(6);
    expect(e.steps[2]).toContain("not effective above about 0.6 m");
  });

  it("low and none bands use their depths", () => {
    expect(estimateSandbags("low").layers).toBe(3); // 0.25 m → 3 layers
    const none = estimateSandbags("none");
    expect(none.layers).toBe(1);
    expect(none.steps[0]).toContain("Outside the mapped zones");
  });

  it("wider doors need more bags per layer", () => {
    expect(estimateSandbags("high", { ...DEFAULT_INPUTS, doors: 1, doorWidthM: 1.8 }).bagsPerLayer).toBe(5); // 2.1/0.45 = 4.67
  });
});

describe("sanitizeInputs", () => {
  it("clamps doors and width and keeps a valid floor level", () => {
    expect(sanitizeInputs({ doors: 0, doorWidthM: 0.1 })).toMatchObject({ doors: 1, doorWidthM: 0.6 });
    expect(sanitizeInputs({ doors: 99, doorWidthM: 9 })).toMatchObject({ doors: 10, doorWidthM: 3 });
    expect(sanitizeInputs({ doors: 2.6 }).doors).toBe(3);
    expect(sanitizeInputs({ doors: NaN, floorLevel: "attic" as never })).toMatchObject({ doors: 2, floorLevel: "street" });
    expect(sanitizeInputs(null)).toEqual(DEFAULT_INPUTS);
  });
});

it("FORMULA_PLAIN explains the method", () => {
  expect(FORMULA_PLAIN.length).toBeGreaterThanOrEqual(5);
  expect(FORMULA_PLAIN.join(" ")).toContain("0.6 m");
});
