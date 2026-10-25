// Tile values for "How good is it?" (#123) come from proof.json, never hard-coded.
import { describe, expect, it } from "vitest";
import type { Proof, Spot } from "../../contracts";
import fixture from "../../../../tests/fixtures/proof.json";
import fixtureSpots from "../../../../tests/fixtures/spots.json";
import {
  POOLED,
  beatsTile,
  binIndex,
  binsAt,
  caughtText,
  earlyTile,
  headline,
  leadWords,
  officialComparison,
  oddsCaption,
  oddsVerdict,
  perEventVsOfficial,
  pickInformativeBin,
  pooledNote,
  reliabilitySpots,
  skillTrendText,
  topBinNote,
  tradeoffAt,
  triggerPhrase,
  triggerWords,
  vsOfficialLabel,
  vsOfficialSummary,
} from "./trust";

const NOTE = "Skill is scored on the test period; they pool the trained gauges newbotley, minns, coldharbour, kingsmill. Few events.";

const skillByLead: Proof["skillByLead"] = [
  { h: 6, pinballModel: 0.0033, pinballPersistence: 0.0054, skill: 0.3915 },
  { h: 24, pinballModel: 0.0113, pinballPersistence: 0.0154, skill: 0.2664 },
  { h: 72, pinballModel: 0.03, pinballPersistence: 0.0337, skill: 0.1079 },
];

const spots: Pick<Spot, "key" | "name" | "mode">[] = [
  { key: "osney", name: "Osney Island / Binsey", mode: "probability" },
  { key: "botley", name: "Botley Road / New Botley / Hinksey", mode: "probability" },
  { key: "wolvercote", name: "Wolvercote / Port Meadow", mode: "timing_only" },
];

const row = (pStar: number, hits: number, misses: number, fa: number, lead: number | null, vs: number | null) => ({
  pStar,
  hits,
  misses,
  falseAlarms: fa,
  meanLeadH: lead,
  meanLeadVsOfficialH: vs,
});

const tradeoff: Proof["tradeoff"] = {
  botley: [row(0.2, 8, 0, 9, 40, 5), row(0.5, 8, 0, 3, 28, -5.08), row(0.9, 6, 2, 0, 10, -20)],
  osney: [row(0.5, 7, 0, 2, 17, 2.88)],
};

describe("helpers", () => {
  it("says lead times in words", () => {
    expect(leadWords(6)).toBe("6 hours");
    expect(leadWords(24)).toBe("24 hours");
    expect(leadWords(72)).toBe("3 days");
  });
  it("reads the pooled gauges from testPeriodNote", () => {
    expect(pooledNote({ testPeriodNote: NOTE })).toBe("pooled across our four gauges");
    expect(pooledNote({ testPeriodNote: "no list here" })).toBe("pooled across our gauges");
  });
  it("names the trigger as odds", () => {
    expect(triggerWords(0.5)).toBe("1-in-2");
    expect(triggerWords(0.2)).toBe("1-in-5");
    expect(triggerWords(0.3)).toBe("30%");
  });
});

describe("tile 1: beats 'nothing changes'", () => {
  it("uses the 24 h row and its own numbers", () => {
    const t = beatsTile({ skillByLead })!;
    expect(t.h).toBe(24);
    expect(t.skillPct).toBe(27);
    expect(t.ratio).toBeCloseTo(0.0113 / 0.0154, 6);
    expect(t.caption).toBe("27% more accurate than assuming the river stays the same, 24 hours ahead");
    expect(t.trend.map((r) => r.h)).toEqual([6, 24, 72]);
  });
  it("describes the fade across leads from the data", () => {
    expect(skillTrendText(skillByLead)).toBe("Strongest short-term (39% at 6 hours), fading to 11% better by 3 days.");
    expect(skillTrendText([{ h: 6, skill: 0.2 }, { h: 72, skill: -0.01 }])).toMatch(/no better than the simple guess by 3 days/);
  });
  it("is honest when the model loses", () => {
    const t = beatsTile({ skillByLead: [{ h: 24, pinballModel: 0.02, pinballPersistence: 0.016, skill: -0.25 }] })!;
    expect(t.caption).toBe("25% less accurate than assuming the river stays the same, 24 hours ahead");
  });
  it("falls back to the nearest lead, and to null with no data", () => {
    expect(beatsTile({ skillByLead: [skillByLead[0], skillByLead[2]] })!.h).toBe(6);
    expect(beatsTile({ skillByLead: [] })).toBeNull();
  });
});

describe("tile 2: honest odds", () => {
  const reliability: Proof["reliability"] = {
    botley: [
      {
        h: 24,
        brier: 0.001,
        brierPersistence: 0.002,
        bins: [
          { pPred: 0.0001, pObs: 0.0003, n: 44000 },
          { pPred: 0.148, pObs: 0.1818, n: 22 },
          { pPred: 0.3479, pObs: 0.375, n: 24 },
          { pPred: 0.9954, pObs: 0.8226, n: 124 },
        ],
      },
      { h: 72, brier: 0.01, brierPersistence: 0.02, bins: [{ pPred: 0.5, pObs: 0.5, n: 3 }] },
    ],
    cherwell: [
      {
        h: 24,
        brier: 0.001,
        brierPersistence: 0.002,
        bins: [
          { pPred: 0.0001, pObs: 0.0005, n: 43000 },
          { pPred: 0.1543, pObs: 0.25, n: 16 },
          { pPred: 0.3583, pObs: 0.8182, n: 11 },
          { pPred: 0.9744, pObs: 0.5072, n: 69 },
        ],
      },
    ],
  };

  it("maps a bin mean back to its equal-width bin", () => {
    expect(binIndex(0)).toBe(0);
    expect(binIndex(0.148)).toBe(1);
    expect(binIndex(0.9954)).toBe(9);
    expect(binIndex(1)).toBe(9);
  });

  it("pools the same bin across spots, weighted by n", () => {
    const bins = binsAt({ reliability }, POOLED)!;
    expect(bins).toHaveLength(4);
    const b1 = bins[1];
    expect(b1.n).toBe(38);
    expect(b1.pPred).toBeCloseTo((0.148 * 22 + 0.1543 * 16) / 38, 6);
    expect(b1.pObs).toBeCloseTo((0.1818 * 22 + 0.25 * 16) / 38, 6);
  });

  it("reads one spot's bins, and lists spots at the lead", () => {
    expect(binsAt({ reliability }, "cherwell")).toHaveLength(4);
    expect(binsAt({ reliability }, "osney")).toBeNull();
    expect(reliabilitySpots({ reliability })).toEqual(["botley", "cherwell"]);
    expect(reliabilitySpots({ reliability }, 72)).toEqual(["botley"]);
  });

  it("picks the best-filled middle bin, not the calm-day or near-certain ones", () => {
    const bins = binsAt({ reliability }, POOLED)!;
    const b = pickInformativeBin(bins)!;
    expect(b.n).toBe(38); // 0.1–0.2 (38) beats 0.3–0.4 (35); 0–0.1 and 0.9–1 are skipped
    expect(oddsCaption(b)).toBe("When we said about 15%, it flooded 21% of the time");
    expect(oddsVerdict(b)).toBe("close");
  });

  it("breaks ties towards 50%, and falls back when there is no middle bin", () => {
    expect(
      pickInformativeBin([
        { pPred: 0.15, pObs: 0.1, n: 10 },
        { pPred: 0.45, pObs: 0.4, n: 10 },
      ])!.pPred,
    ).toBe(0.45);
    expect(pickInformativeBin([{ pPred: 0.01, pObs: 0, n: 100 }, { pPred: 0.97, pObs: 0.8, n: 5 }])!.n).toBe(100);
    expect(pickInformativeBin([])).toBeNull();
  });

  it("says when a bin is off the line, and which way", () => {
    expect(oddsVerdict({ pPred: 0.36, pObs: 0.82, n: 11 })).toBe("more");
    expect(oddsVerdict({ pPred: 0.97, pObs: 0.51, n: 69 })).toBe("less");
  });

  it("states the near-certain bin plainly", () => {
    expect(topBinNote(binsAt({ reliability }, "botley")!)).toBe(
      "When we were near-certain (100%), it flooded 82% of the time (124 forecast hours).",
    );
    expect(topBinNote([{ pPred: 0.5, pObs: 0.5, n: 4 }])).toBeNull();
  });
});

describe("tile 3: early, without crying wolf", () => {
  it("takes the p* 0.5 row, nearest otherwise", () => {
    expect(tradeoffAt(tradeoff.botley)!.falseAlarms).toBe(3);
    expect(tradeoffAt(tradeoff.botley, 0.8)!.pStar).toBe(0.9);
    expect(tradeoffAt([])).toBeNull();
  });

  it("totals floods caught and false alarms, in spots.json order", () => {
    const t = earlyTile({ tradeoff }, spots);
    expect(t.rows.map((r) => r.spot)).toEqual(["osney", "botley"]);
    expect(t.rows[1].name).toBe("Botley Road");
    expect(t.floods).toBe(15);
    expect(t.caught).toBe(15);
    expect(t.falseAlarms).toBe(5);
    expect(t.typicalLeadH).toBeCloseTo((17 * 7 + 28 * 8) / 15, 6);
    expect(caughtText(t)).toBe("15 of 15 floods caught");
    expect(t.noForecast.map((s) => s.spot)).toEqual(["wolvercote"]);
  });

  it("counts each spot at its own trigger when given one per spot (as the footer does)", () => {
    const perSpot = earlyTile({ tradeoff }, spots, (spot) => (spot === "botley" ? 0.8 : 0.5));
    expect(perSpot.pStar).toBeNull();
    expect(perSpot.rows.map((r) => r.pStar)).toEqual([0.5, tradeoffAt(tradeoff.botley, 0.8)!.pStar]);
    expect(triggerPhrase(perSpot.pStar)).toBe("each spot's own warning level");
    expect(triggerPhrase(0.5)).toBe("a 1-in-2 chance");
  });

  it("says the EA comparison as mixed when it is mixed", () => {
    const t = earlyTile({ tradeoff }, spots);
    expect(vsOfficialSummary(t.rows).text).toBe("Ahead of the official warning at 1 spot, behind at 1 spot.");
    const behindOnly = vsOfficialSummary([{ ...t.rows[1] }]);
    expect(behindOnly.text).toBe("Behind the official warning at 1 spot.");
    expect(vsOfficialSummary([{ ...t.rows[0], vsOfficialH: 0.4 }]).text).toBe("Level with it at 1 spot.");
    expect(vsOfficialSummary([{ ...t.rows[0], vsOfficialH: null }]).text).toBe("No official warnings to compare with.");
    expect(vsOfficialLabel(2.88)).toBe("3 h ahead");
    expect(vsOfficialLabel(-5.08)).toBe("5 h behind");
    expect(vsOfficialLabel(null)).toBe("no official warning to compare");
  });

  it("counts flood by flood too", () => {
    const perEvent = [3.8, -15.7, 20.9, null, 0.2].map((v, i) => ({
      eventId: `e${i}`,
      spot: "osney",
      crossed: true,
      peakObs: 3,
      arrivalErrH: null,
      leadVsOfficialH: v,
    }));
    const r = perEventVsOfficial({ perEvent });
    expect([r.ahead, r.behind, r.level, r.total]).toEqual([2, 1, 1, 4]);
    expect(r.text).toBe("Flood by flood: earlier than the official warning 2 times, later 1 time, level 1 time (of 4 floods with a warning to compare).");
  });
});

describe("tile 3: fair side-by-side with the official warning", () => {
  const officialOutcome: Proof["officialOutcome"] = {
    botley: { hits: 8, misses: 0, falseAlarms: 0, meanLeadH: 37.8 },
    osney: { hits: 5, misses: 2, falseAlarms: 1, meanLeadH: 24.3 },
  };
  it("totals both on the same spots and says the trade-off", () => {
    const c = officialComparison(earlyTile({ tradeoff, officialOutcome }, spots))!;
    expect(c.oursText).toBe("River Clock caught 15 of 15 floods (5 false alarms)");
    expect(c.officialText).toBe("the official warning caught 13 of 15 (1 false alarm)");
    expect(c.verdict).toBe("River Clock catches more floods; the official warning raises fewer false alarms.");
  });
  it("leaves out spots with no official score, and is null when none have one", () => {
    const c = officialComparison(earlyTile({ tradeoff, officialOutcome: { botley: officialOutcome!.botley } }, spots))!;
    expect(c.ours.floods).toBe(8);
    expect(c.verdict).toBe("Both catch as many floods; the official warning raises fewer false alarms.");
    expect(officialComparison(earlyTile({ tradeoff }, spots))).toBeNull();
  });
});

describe("headline", () => {
  it("says both halves from the data", () => {
    const b = beatsTile({ skillByLead });
    expect(headline(b, { caught: 30, floods: 30 })).toBe(
      "Tested on floods it never saw: 27% more accurate than a simple guess a day ahead, and it caught all 30 floods.",
    );
    expect(headline(b, { caught: 28, floods: 30 })).toMatch(/it caught 28 of 30 floods\.$/);
    expect(headline(null, null)).toMatch(/once proof\.json is written/);
  });
});

describe("on the committed fixture", () => {
  const proof = fixture as unknown as Proof;
  it("produces every tile", () => {
    expect(beatsTile(proof)).not.toBeNull();
    const bins = binsAt(proof, POOLED)!;
    expect(pickInformativeBin(bins)).not.toBeNull();
    const t = earlyTile(proof, fixtureSpots as Spot[]);
    expect(t.floods).toBeGreaterThan(0);
    expect(t.rows.every((r) => r.official)).toBe(true);
  });
});
