// #99 items 2, 3, 4 and 6 on the Proof tab: coverage direction from the data,
// flood-episode labels, peak probability for non-flooded events (from the
// replay), and the arrival-error blank explained.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { EventMeta, Proof, Replay, Spot } from "../../contracts";
import proofFixture from "../../../../tests/fixtures/proof.json";
import replayFixture from "../../../../tests/fixtures/replays/e2014.json";
import eventsFixture from "../../../../tests/fixtures/events.json";
import spotsFixture from "../../../../tests/fixtures/spots.json";
import { coverageSummary, direction } from "./coverage";
import { eventsNeedingPeaks, peakPFloodBySpot } from "./peakProbability";
import { Coverage, Tradeoff } from "./SkillCharts";
import { ARRIVAL_BLANK, PerEventTable } from "./TravelAndData";

const proof = proofFixture as Proof;
const events = eventsFixture as EventMeta[];
const spots = spotsFixture as Spot[];
const cell = (h: number, nominal: number, actual: number) => ({ h, nominal, actual });

describe("coverage direction (#99 item 2)", () => {
  it("says intervals are wider than nominal (conservative) when they over-cover", () => {
    const s = coverageSummary([cell(6, 0.5, 0.65), cell(72, 0.5, 0.78), cell(6, 0.9, 0.94), cell(72, 0.9, 0.97)])!;
    expect(s.direction).toBe("wide");
    expect(s.text).toBe(
      "Our forecast ranges are cautious (wider than needed): our 50% range held the real level 65–78% of the time; our 90% range held the real level 94–97% of the time.",
    );
    expect(s.flagged.map((c) => c.actual)).toEqual([0.65, 0.78]);
  });

  it("says narrower than nominal (overconfident) for the fixture, which under-covers at long leads", () => {
    const s = coverageSummary(proof.coverage)!;
    expect(s.direction).toBe("narrow");
    expect(s.text).toMatch(/^Our forecast ranges are overconfident \(narrower than they should be\): our 50% range held the real level 45–52% of the time/);
  });

  it("names each level's direction when they disagree, and ignores 1–2 point noise", () => {
    expect(direction([cell(6, 0.5, 0.51), cell(6, 0.8, 0.78)])).toBe("on-target");
    const s = coverageSummary([cell(6, 0.5, 0.7), cell(6, 0.9, 0.8)])!;
    expect(s.direction).toBe("mixed");
    expect(s.text).toMatch(/^Our forecast ranges are cautious for some ranges and overconfident for others/);
    expect(s.text).toContain("our 50% range held the real level 70% of the time: cautious;");
    expect(s.text).toContain("our 90% range held the real level 80% of the time: overconfident.");
  });

  it("renders the direction in the Proof notice", () => {
    const wide: Proof = { ...proof, coverage: [cell(24, 0.5, 0.72), cell(24, 0.9, 0.95)] };
    const html = renderToStaticMarkup(<Coverage proof={wide} />);
    expect(html).toContain("Our forecast ranges are cautious (wider than needed)");
    expect(html).toContain("More than 10 points away from the target");
    expect(html).toContain('title="coverage above nominal (conservative intervals)"');
  });
});

describe("flood episodes on Proof (#99 item 3)", () => {
  it("labels trade-off hits and misses as flood episodes with the 72 h rule", () => {
    const html = renderToStaticMarkup(<Tradeoff proof={proof} spots={spots} dateOnlySpots={new Set()} />);
    expect(html).toContain("Hits and misses are flood episodes (counted once per flood)");
    const first = [...proof.tradeoff.osney].sort((a, b) => a.pStar - b.pStar)[0];
    expect(html).toContain(`: ${first.hits + first.misses} at Osney`);
    expect(html).toContain("still the same flood");
  });
});

describe("peak flood probability for non-flooded events (#99 item 4)", () => {
  it("takes the highest pFlood per spot over every forecast and lead of a replay", () => {
    const replay = replayFixture as Replay;
    const peaks = peakPFloodBySpot(replay);
    for (const [spot, peak] of Object.entries(peaks)) {
      const all = replay.forecasts.flatMap((f) => f.spots.filter((s) => s.spot === spot).flatMap((s) => s.leads.map((l) => l.pFlood ?? 0)));
      expect(peak).toBe(Math.max(...all));
    }
    const lead = (h: number, pFlood: number | null) => ({ h, q: { "05": 0, "10": 0, "25": 0, "50": 0, "75": 0, "90": 0, "95": 0 }, pFlood, pAmber: 0 });
    const f = (spot: string, ps: (number | null)[]) => ({
      issuedAt: "2026-01-15T00:00:00Z",
      dataAsOf: {},
      stale: [],
      spots: [{ spot, levelNow: 1, mode: "probability" as const, arrival: null, leads: ps.map((p, i) => lead(6 * (i + 1), p)) }],
    });
    expect(peakPFloodBySpot({ forecasts: [f("botley", [0.1, 0.2]), f("botley", [0.05, 0.28]), f("wolvercote", [null])] })).toEqual({ botley: 0.28 });
  });

  it("only loads replays for events with a non-flooded row", () => {
    expect(eventsNeedingPeaks(proof.perEvent)).toEqual(["e2024b", "e2026"]);
  });

  it("shows the peak on non-flooded rows, with a caption saying where it comes from", () => {
    const html = renderToStaticMarkup(
      <PerEventTable proof={proof} events={events} spots={spots} dateOnly={new Set()} peaks={{ e2026: { osney: 0.2062, abingdonrd: 0.12 } }} />,
    );
    expect(html).toContain("No<span");
    expect(html).toContain("highest flood chance 21% ‡");
    expect(html).toContain("highest flood chance 12% ‡");
    expect(html).toContain("replays/&lt;event&gt;.json");
  });

  it("never shows a peak on flooded rows, and no caption without peaks", () => {
    const html = renderToStaticMarkup(
      <PerEventTable proof={proof} events={events} spots={spots} dateOnly={new Set()} peaks={{ e2014: { osney: 0.99 } }} />,
    );
    expect(html).not.toContain("highest flood chance");
    expect(html).not.toContain("‡");
  });
});

describe("arrival-error blanks (#99 item 6)", () => {
  it("explains a blank arrival error in a footnote and a tooltip", () => {
    const html = renderToStaticMarkup(<PerEventTable proof={proof} events={events} spots={spots} dateOnly={new Set()} />);
    expect(ARRIVAL_BLANK).toBe("River Clock had not reached 50% 24 h before the river crossed the flood line");
    expect(html).toContain(`blank (–) = ${ARRIVAL_BLANK}`);
    const crossedBlank: Proof = { ...proof, perEvent: [{ ...proof.perEvent[0], arrivalErrH: null }] };
    expect(renderToStaticMarkup(<PerEventTable proof={crossedBlank} events={events} spots={spots} dateOnly={new Set()} />)).toContain(
      `title="${ARRIVAL_BLANK}"`,
    );
  });

  it("has no footnote when every arrival error is filled in", () => {
    const full: Proof = { ...proof, perEvent: proof.perEvent.filter((r) => r.arrivalErrH != null) };
    expect(renderToStaticMarkup(<PerEventTable proof={full} events={events} spots={spots} dateOnly={new Set()} />)).not.toContain("blank (–)");
  });
});
