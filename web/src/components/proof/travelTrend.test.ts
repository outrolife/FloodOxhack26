// #103 item 2: only claim "bigger rises travel faster" when the trend is robust.
import { describe, expect, it } from "vitest";
import type { TravelPair } from "../../contracts";
import liveTravel from "../../../public/data/travel_times.json";
import { DEFAULT_PAIR, defaultPairIndex } from "./TravelAndData";
import { MIN_TREND_N, NO_CLEAR_PATTERN, spearman, theilSen, travelTrend } from "./travelTrend";

const used = (p: TravelPair) =>
  p.events.filter((e) => !e.excluded && e.tHalf != null).map((e) => ({ rise: e.rise, tHalf: e.tHalf as number }));

describe("travel-time trend (#103)", () => {
  it("ranks and slopes behave on a clean line", () => {
    const pts = Array.from({ length: 10 }, (_, i) => ({ rise: i * 0.1, tHalf: 30 - i * 2 }));
    expect(spearman(pts)).toBeCloseTo(-1);
    expect(theilSen(pts)).toBeCloseTo(-20);
    const t = travelTrend(pts, -20);
    expect(t.robust).toBe(true);
    expect(t.text).toBe("Bigger rises travel faster: about 20 h less per metre of extra rise.");
  });

  it("says no clear pattern when a few outliers drive the straight-line slope", () => {
    // Flat cloud plus two huge travel times at small rises: the straight-line slope is steep, the ranks are not.
    const pts = [
      ...Array.from({ length: 10 }, (_, i) => ({ rise: 0.3 + (i % 5) * 0.1, tHalf: 10 + ((i * 7) % 5) })),
      { rise: 0.35, tHalf: 130 },
      { rise: 0.32, tHalf: 110 },
    ];
    const t = travelTrend(pts, -45);
    expect(t.robust).toBe(false);
    expect(t.text).toBe(NO_CLEAR_PATTERN);
  });

  it(`needs at least ${MIN_TREND_N} rises`, () => {
    const pts = Array.from({ length: MIN_TREND_N - 1 }, (_, i) => ({ rise: i, tHalf: 20 - i }));
    expect(travelTrend(pts, -1).robust).toBe(false);
  });

  it("does not repeat the outlier-driven Cassington → New Botley slope from the committed data", () => {
    const pairs = liveTravel as TravelPair[];
    const p = pairs.find((x) => x.up === "cassington" && x.down === "newbotley");
    if (!p) return;
    const t = travelTrend(used(p), p.slopeHoursPerMetre);
    expect(t.text).not.toContain("43.5");
    expect(t.detail).toContain(`${used(p).length} matched rises`);
  });

  it("opens the panel on Enslow → Kings Mill when that pair exists", () => {
    const pairs = liveTravel as TravelPair[];
    const i = defaultPairIndex(pairs);
    if (pairs.some((p) => p.up === DEFAULT_PAIR.up && p.down === DEFAULT_PAIR.down && p.n > 0)) {
      expect(pairs[i].up).toBe("enslow");
      expect(pairs[i].down).toBe("kingsmill");
    }
  });
});
