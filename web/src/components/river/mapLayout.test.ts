// #103 item 10: map markers are labelled and every spot (incl. Abingdon Road) is in view.
import { describe, expect, it } from "vitest";
import type { Spot } from "../../contracts";
import spotsData from "../../../public/data/spots.json";
import { labelSide, shortSpotName, spotBounds } from "./mapLayout";

const spots = spotsData as Spot[];

describe("spot map layout (#103)", () => {
  it("fits bounds around every spot, so the southernmost (Abingdon Road) is inside", () => {
    const b = spotBounds(spots)!;
    for (const s of spots) {
      expect(s.lat).toBeGreaterThanOrEqual(b[0][0]);
      expect(s.lat).toBeLessThanOrEqual(b[1][0]);
      expect(s.lon).toBeGreaterThanOrEqual(b[0][1]);
      expect(s.lon).toBeLessThanOrEqual(b[1][1]);
    }
    expect(spotBounds([])).toBeNull();
  });

  it("labels spots with a short name", () => {
    expect(shortSpotName("Botley Road / New Botley / Hinksey")).toBe("Botley Road");
    expect(shortSpotName("Cherwell (Kings Mill)")).toBe("Cherwell (Kings Mill)");
  });

  it("puts Botley's label on the other side from Osney's", () => {
    expect(labelSide("botley")).not.toBe(labelSide("osney"));
  });
});
