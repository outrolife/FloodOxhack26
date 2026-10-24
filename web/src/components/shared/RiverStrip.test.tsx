// #99 item 5: the River strip shows n for each travel time and greys pairs
// measured on fewer than 5 floods, with a text tag (not hidden).
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Station, TravelPair } from "../../contracts";
import travelFixture from "../../../../tests/fixtures/travel_times.json";
import stationsFixture from "../../../../tests/fixtures/stations.json";
import { LOW_CONFIDENCE_N, RiverStrip, basedOn, linkInfo } from "./RiverStrip";

const pairs = travelFixture as TravelPair[];
const stations = stationsFixture as Station[];
const pair = (up: string, down: string, n: number, tHalf: number, tPeak: number): TravelPair => ({
  up,
  down,
  n,
  tHalf: { p10: tHalf, median: tHalf, p90: tHalf },
  tPeak: { p10: tPeak, median: tPeak, p90: tPeak },
  events: [],
  xcorr: [],
  slopeHoursPerMetre: null,
});

describe("River strip travel times (#99 item 5)", () => {
  it("flags pairs measured on fewer than 5 floods as low confidence", () => {
    expect(LOW_CONFIDENCE_N).toBe(5);
    const low = linkInfo("eynsham", [pair("eynsham", "newbotley", 3, 0.6, 8)], stations)!;
    expect(low.text).toBe("≈ 1 h to New Botley");
    expect(low.n).toBe(3);
    expect(low.lowConfidence).toBe(true);
    expect(low.title).toContain("n = 3 events; peak-to-peak median 8.0 h");
    expect(linkInfo("eynsham", [pair("eynsham", "newbotley", 5, 7, 8)], stations)!.lowConfidence).toBe(false);
  });

  it("uses the fixture's own n (islip to Kings Mill has n = 2)", () => {
    const islip = pairs.find((p) => p.up === "islip")!;
    const info = linkInfo("islip", pairs, stations)!;
    expect(info.n).toBe(islip.n);
    expect(info.lowConfidence).toBe(islip.n < LOW_CONFIDENCE_N);
    expect(info.text).toContain("(cross-correlation only)");
  });

  it("says how many past rises a link is based on, in words", () => {
    expect(basedOn(4)).toBe("based on 4 past rises");
    expect(basedOn(1)).toBe("based on 1 past rise");
  });

  it("renders n on every link and greys low-confidence ones with a label, without hiding them", () => {
    const html = renderToStaticMarkup(<RiverStrip stations={stations} pairs={pairs} />);
    for (const up of new Set(pairs.map((p) => p.up))) {
      const info = linkInfo(up, pairs, stations)!;
      expect(html).toContain(`${info.text} · ${basedOn(info.n)}`);
      expect(html).toContain(`n = ${info.n} events`);
    }
    expect(html).toContain('class="strip-link low"');
    expect(html).toContain("low confidence");
    // Well-measured links stay normal.
    expect(html).toContain('class="strip-link"');
  });
});
