// #103: plain-language wording rules (docs/research/jargon-audit.md).
import { describe, expect, it } from "vitest";
import { chanceWords, gaugeName, hoursWords, pctPlain } from "./plain";

describe("chances in words", () => {
  it("never shows a rounded 0%", () => {
    expect(pctPlain(0)).toBe("under 1%");
    expect(pctPlain(0.004)).toBe("under 1%");
    expect(pctPlain(0.32)).toBe("32%");
    expect(chanceWords(0.001)).toBe("under 1%");
  });

  it("uses friendly 1-in-N for small chances and N-in-10 for large ones", () => {
    expect(chanceWords(0.32)).toBe("about 1 in 3 (32%)");
    expect(chanceWords(0.1)).toBe("about 1 in 10 (10%)");
    expect(chanceWords(0.08)).toBe("about 1 in 10 (8%)");
    expect(chanceWords(0.28)).toBe("about 1 in 4 (28%)");
    expect(chanceWords(0.5)).toBe("about 1 in 2 (50%)");
    expect(chanceWords(0.63)).toBe("about 6 in 10 (63%)");
    expect(chanceWords(0.9)).toBe("about 9 in 10 (90%)");
    expect(chanceWords(null)).toBe("no forecast");
  });

  it("writes hours ahead in words", () => {
    expect(hoursWords(6)).toBe("6 hours");
    expect(hoursWords(24)).toBe("1 day");
    expect(hoursWords(36)).toBe("36 hours");
    expect(hoursWords(72)).toBe("3 days");
  });
});

describe("gauge display names", () => {
  it("expands u/s and d/s and drops weir letters", () => {
    expect(gaugeName("Godstow Lock d/s")).toBe("Godstow Lock (downstream side)");
    expect(gaugeName("Eynsham Lock u/s")).toBe("Eynsham Lock (upstream side)");
    expect(gaugeName("Cassington Weir B")).toBe("Cassington Weir");
    expect(gaugeName("Enslow Weir A")).toBe("Enslow Weir");
    expect(gaugeName("Kings Mill u/s")).toBe("Kings Mill");
    expect(gaugeName("New Botley")).toBe("New Botley");
  });
});
