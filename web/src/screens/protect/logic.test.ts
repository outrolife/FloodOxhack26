// Protect screen helpers (#121): budget selection, deploy-by times, frame choice, headline.
import { describe, expect, it } from "vitest";
import type { Sandbags, SpreadManifest } from "../../contracts";
import e2014Bags from "../../../public/data/spread/e2014/sandbags.json";
import e2014Manifest from "../../../public/data/spread/e2014/manifest.json";
import liveBags from "../../../public/data/spread/live/sandbags.json";
import outlines from "../../../public/data/geo/recorded_outlines.json";
import {
  type Candidate,
  type OutlineCollection,
  DEFAULT_BUDGET,
  buildingKind,
  firstDeadline,
  frameForHour,
  framesForIssue,
  headline,
  monthYear,
  nothingToProtect,
  outlineCovering,
  selectWithinBudget,
  timing,
  totalBags,
  validationSentence,
  wetByHour,
} from "./logic";

const cand = (id: string, score: number, bags: number, firstWet: string | null = null): Candidate => ({
  id,
  lat: 51.75,
  lon: -1.28,
  score,
  pWet48: score,
  medianDepthM: 0.1,
  firstWet,
  bags,
  reasons: [`Frequency ≥ 0.2 along 3 m of its 20 m walls by 48 h (OSM house)`],
  checks: ["Door and sill height"],
});

describe("selectWithinBudget (SPEC §11 S4 step 5)", () => {
  it("picks by score ÷ bags and skips what no longer fits", () => {
    const cs = [cand("a", 0.9, 90), cand("b", 0.5, 10), cand("c", 0.4, 50), cand("d", 0.3, 5)];
    // ratios: d 0.06, b 0.05, a 0.01, c 0.008. Budget 60: d (5), b (10), a doesn't fit (90), c (50) → 65 > 60, skip.
    const s = selectWithinBudget(cs, 60);
    expect(s.affordable.map((c) => c.id)).toEqual(["d", "b"]);
    expect(s.bagsUsed).toBe(15);
    // Budget 100: d, b, then a (90) doesn't fit in 85, c (50) fits.
    expect(selectWithinBudget(cs, 100).affordable.map((c) => c.id)).toEqual(["d", "b", "c"]);
  });

  it("lists the top N of the affordable set by score", () => {
    const cs = [cand("a", 0.2, 1), cand("b", 0.9, 10), cand("c", 0.5, 5), cand("d", 0.7, 7)];
    const s = selectWithinBudget(cs, 1000, 2);
    expect(s.affordable).toHaveLength(4);
    expect(s.shown.map((c) => c.id)).toEqual(["b", "d"]);
    expect(s.bagsShown).toBe(17);
  });

  it("never picks zero-score buildings and handles an empty file", () => {
    expect(selectWithinBudget([cand("z", 0, 1)], 500).shown).toEqual([]);
    expect(selectWithinBudget([], 500)).toEqual({ affordable: [], shown: [], bagsShown: 0, bagsUsed: 0 });
  });

  it("reproduces the committed e2014 screening at the default budget", () => {
    const data = e2014Bags as Sandbags;
    const s = selectWithinBudget(data.candidates, DEFAULT_BUDGET);
    expect(s.shown.map((c) => c.id)).toEqual(data.candidates.map((c) => c.id));
    expect(s.bagsShown).toBe(totalBags(data.candidates));
  });

  it("a smaller budget drops buildings, cheapest-per-score first kept", () => {
    const data = e2014Bags as Sandbags;
    const s = selectWithinBudget(data.candidates, 100);
    expect(s.bagsUsed).toBeLessThanOrEqual(100);
    expect(s.shown.length).toBeLessThan(data.candidates.length);
    expect(s.shown.length).toBeGreaterThan(0);
  });
});

describe("frames", () => {
  const manifest = e2014Manifest as SpreadManifest;
  const issued = (e2014Bags as Sandbags).issuedAt;

  it("uses the frames of the screening's own forecast, sorted by lead", () => {
    const fs = framesForIssue(manifest, issued);
    expect(fs.length).toBeGreaterThan(0);
    expect(new Set(fs.map((f) => f.issuedAt))).toEqual(new Set([issued]));
    expect(fs.map((f) => f.tau)).toEqual([...fs.map((f) => f.tau)].sort((a, b) => a - b));
  });

  it("never uses a forecast issued after the screening", () => {
    const m: SpreadManifest = {
      ...manifest,
      frames: [
        { tau: 6, issuedAt: "2014-01-04T00:00:00Z", png: "a.png" },
        { tau: 6, issuedAt: "2014-01-06T00:00:00Z", png: "b.png" },
      ],
    };
    expect(framesForIssue(m, "2014-01-05T00:00:00Z").map((f) => f.png)).toEqual(["a.png"]);
    expect(framesForIssue(m, "2014-01-01T00:00:00Z")).toEqual([]);
  });

  it("picks the nearest lead, ties to the shorter", () => {
    const fs = [6, 12, 24].map((tau) => ({ tau, issuedAt: issued, png: `${tau}.png` }));
    expect(frameForHour(fs, 12)?.tau).toBe(12);
    expect(frameForHour(fs, 18)?.tau).toBe(12);
    expect(frameForHour(fs, 100)?.tau).toBe(24);
    expect(frameForHour([], 12)).toBeNull();
  });
});

describe("timing (deploy-by)", () => {
  const taus = [6, 12, 24, 36, 48, 72];
  const issued = "2014-01-05T00:00:00Z";

  it("counts from the start of the first wet frame's interval, minus the deployment time", () => {
    const t = timing(cand("a", 0.8, 10, "2014-01-05T12:00:00Z"), issued, taus);
    expect(t).toEqual({
      firstWetH: 12,
      earliest: "2014-01-05T06:00:00Z",
      latest: "2014-01-05T12:00:00Z",
      deployBy: "2014-01-05T03:00:00Z",
    });
    expect(timing(cand("b", 0.6, 10, "2014-01-06T12:00:00Z"), issued, taus)?.deployBy).toBe("2014-01-05T21:00:00Z");
  });

  it("has no deadline when the building is never wet in half the runs", () => {
    expect(timing(cand("a", 0.2, 10, null), issued, taus)).toBeNull();
  });

  it("finds the earliest deadline and the wet-by-hour state", () => {
    const shown = [cand("a", 0.6, 1, "2014-01-06T12:00:00Z"), cand("b", 0.8, 1, "2014-01-05T12:00:00Z"), cand("c", 0.2, 1)];
    expect(firstDeadline(shown, issued, taus)).toBe("2014-01-05T03:00:00Z");
    expect(wetByHour(shown[1], issued, 6)).toBe(false);
    expect(wetByHour(shown[1], issued, 12)).toBe(true);
    expect(wetByHour(shown[2], issued, 72)).toBe(false);
  });
});

describe("headline", () => {
  const taus = [6, 12, 24, 36, 48, 72];

  it("e2014: the month from the data, the count and the earliest deadline", () => {
    const data = e2014Bags as Sandbags;
    const shown = selectWithinBudget(data.candidates, 500).shown;
    const h = headline({ context: "e2014", issuedAt: data.issuedAt, shown, budget: 500, deadline: "Sun 5 Jan, 03:00 GMT" });
    expect(monthYear(data.issuedAt)).toBe("January 2014");
    expect(h).toBe(
      "If January 2014 happened again, these 5 buildings would be first in line for 500 sandbags: the earliest needs them in place by Sun 5 Jan, 03:00 GMT.",
    );
    expect(firstDeadline(shown, data.issuedAt, taus)).toBe("2014-01-05T03:00:00Z");
  });

  it("live with nothing likely wet: nothing to protect", () => {
    const data = liveBags as Sandbags;
    const shown = selectWithinBudget(data.candidates, 500).shown;
    const deadline = firstDeadline(shown, data.issuedAt, taus);
    const h = headline({ context: "live", issuedAt: data.issuedAt, shown, budget: 500, deadline });
    if (deadline) expect(h).toContain("Right now");
    else expect(h).toBe("Nothing to protect right now.");
    expect(nothingToProtect([], data.issuedAt, taus)).toBe(true);
  });

  it("never says Flood Warning or Flood Alert", () => {
    const h = headline({ context: "e2014", issuedAt: "2014-01-05T00:00:00Z", shown: [], budget: 50, deadline: null });
    expect(h).not.toMatch(/flood (warning|alert)/i);
    expect(h).toContain("no building passes");
  });
});

describe("plain words", () => {
  it("states the IoU as an overlap", () => {
    expect(validationSentence({ eventId: "e2014", iou: 0.681 })).toContain("overlap by 68%");
    expect(validationSentence(null)).toBeNull();
  });

  it("finds the recorded 2013/14 outline for the e2014 forecast only", () => {
    const fc = outlines as OutlineCollection;
    expect(outlineCovering(fc, "2014-01-05T00:00:00Z")?.properties.label).toBe("November 2013 to February 2014");
    expect(outlineCovering(fc, "2026-10-24T18:07:00Z")).toBeNull();
    expect(outlineCovering(null, "2014-01-05T00:00:00Z")).toBeNull();
  });

  it("names the building type from its first reason", () => {
    expect(buildingKind((e2014Bags as Sandbags).candidates[0])).toBe("Retail");
    expect(buildingKind({ ...cand("x", 1, 1), reasons: [] })).toBe("Building");
  });
});
