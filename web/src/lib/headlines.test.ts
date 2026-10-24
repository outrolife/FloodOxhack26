// #103: the one-sentence takeaway at the top of each tab, generated from data.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import type { Forecast, Proof, Replay, Spot } from "../contracts";
import proofFixture from "../../../tests/fixtures/proof.json";
import spotsData from "../../public/data/spots.json";
import { matchTier } from "../components/timemachine/timeline";
import { decideVerdict, listWords, proofHeadline, riverHeadline, shortSpotName, timeMachineHeadline } from "./headlines";

const spots = spotsData as Spot[];
const all = () => true;
const none = () => false;
const gbp = (v: number) => `£${v.toLocaleString("en-GB")}`;
const q = { "05": 1, "10": 1, "25": 1, "50": 1, "75": 1, "90": 1, "95": 1 };

function forecast(p: Record<string, number>, extra: Partial<Forecast> = {}): Forecast {
  return {
    issuedAt: "2026-10-24T18:00:00Z",
    dataAsOf: { kingsmill: "2026-10-13T14:45:00Z" },
    stale: [],
    spots: Object.entries(p).map(([spot, pf]) => ({
      spot,
      levelNow: 1,
      mode: "probability" as const,
      arrival: pf >= 0.1 ? { p10: "2026-10-26T18:00:00Z", p50: pf >= 0.5 ? "2026-10-27T06:00:00Z" : null, p90: null } : null,
      leads: [{ h: 72, q, pFlood: pf, pAmber: pf }],
    })),
    ...extra,
  };
}

describe("words", () => {
  it("lists and shortens", () => {
    expect(listWords(["A"])).toBe("A");
    expect(listWords(["A", "B", "C"])).toBe("A, B and C");
    expect(shortSpotName("Botley Road / New Botley / Hinksey")).toBe("Botley Road");
  });
});

describe("River headline", () => {
  const three = spots.filter((s) => ["osney", "botley", "abingdonrd"].includes(s.key));

  it("says no flooding expected, each under 1%, when every chance is tiny", () => {
    const h = riverHeadline(forecast({ osney: 0, botley: 0.001, abingdonrd: 0 }), three)!;
    expect(h.headline).toMatch(/^Right now: no flooding expected at .*Botley Road.* in the next 3 days \(each under 1%\)\.$/);
    expect(h.detail).toBe("Every forecast gauge is below its usual high.");
  });

  it("names the spot, the chance in words and the time when flooding is possible", () => {
    const h = riverHeadline(forecast({ osney: 0.02, botley: 0.32, abingdonrd: 0 }), three)!;
    expect(h.headline).toMatch(/^Right now: flooding possible at Botley Road, about 1 in 3 \(32%\) by .*\.$/);
  });

  it("says why a spot has no forecast", () => {
    const cherwell = spots.filter((s) => s.key === "cherwell");
    const h = riverHeadline(forecast({ cherwell: 0 }, { stale: ["kingsmill"] }), cherwell)!;
    expect(h.detail).toContain("gauge offline since");
    expect(riverHeadline(null, three)).toBeNull();
  });

  it("works on the committed live.json", () => {
    const path = new URL("../../public/data/live.json", import.meta.url);
    if (!existsSync(path)) return;
    const live = JSON.parse(readFileSync(path, "utf8")) as Forecast;
    const h = riverHeadline(live, spots)!;
    expect(h.headline).toMatch(/^Right now: /);
    expect(h.headline).not.toMatch(/ 0%/);
  });
});

describe("Time Machine headline", () => {
  const warn = {
    rc: "2014-01-04T12:00:00Z",
    crossing: "2014-01-06T01:00:00Z",
    alreadyOn: false,
    official: { spot: "botley", type: "warning" as const, issuedAt: "2014-01-04T19:03:30Z", precision: "time" as const },
  };
  it("invites before the flood is revealed (no spoilers)", () => {
    const h = timeMachineHeadline("Jan–Feb 2014", "Botley Road / New Botley / Hinksey", warn, none);
    expect(h.headline).toBe("Replay Jan–Feb 2014 at Botley Road as if it were happening now.");
    expect(h.headline).not.toMatch(/hours/);
  });
  it("gives the result once the crossing is revealed", () => {
    const h = timeMachineHeadline("Jan–Feb 2014", "Botley Road / New Botley / Hinksey", warn, all);
    expect(h.headline).toBe(
      "Jan–Feb 2014: River Clock gave Botley Road a 1 in 2 chance of flooding 37 hours before the river reached flood level, and 7 hours before the official Flood Warning.",
    );
  });
  it("reports a near miss only once the whole event has been played", () => {
    const nm = { rc: null, crossing: null, alreadyOn: false, official: null };
    expect(timeMachineHeadline("Jan–Mar 2026", "Botley Road", nm, all, { maxP: 0.28, ended: false }).headline).toMatch(/^Replay/);
    expect(timeMachineHeadline("Jan–Mar 2026", "Botley Road", nm, all, { maxP: 0.28, ended: true }).headline).toBe(
      "Jan–Mar 2026: the river stayed below flood level at Botley Road, and River Clock's highest chance of flooding was about 1 in 4 (28%).",
    );
  });
  it("matches the committed e2014 replay", () => {
    const path = new URL("../../public/data/replays/e2014.json", import.meta.url);
    if (!existsSync(path)) return;
    const r = JSON.parse(readFileSync(path, "utf8")) as Replay;
    const m = matchTier(r, "botley", 2.76, "warning");
    expect(timeMachineHeadline(r.name, "Botley Road", m, all).headline).toMatch(/ hours before the river reached flood level/);
  });
});

describe("Decide verdict", () => {
  it("leads with who you are and the act-at chance, then now", () => {
    const h = decideVerdict({ who: "Resident (move car: £20 to protect £2,000)", C: 20, L: 2000, pStar: 0.01, spotName: "Botley Road / New Botley", liveP: 0.001, liveH: 24, gbp });
    expect(h.headline).toBe("Resident (move car: £20 to protect £2,000): act once the chance of flooding passes 1%.");
    expect(h.detail).toBe("Right now at Botley Road: under 1% chance in the next 24 hours, so not yet.");
    const act = decideVerdict({ who: null, C: 20, L: 2000, pStar: 0.01, spotName: "Botley Road", liveP: 0.3, liveH: 24, gbp });
    expect(act.headline).toMatch(/^With your costs \(£20 to act, £2,000 if flooded\)/);
    expect(act.detail).toMatch(/so act now\.$/);
  });
  it("says when acting never pays", () => {
    expect(decideVerdict({ who: null, C: 10, L: 5, pStar: 1, spotName: "X", liveP: null, liveH: 24, gbp }).headline).toMatch(/never pays off/);
  });
});

describe("Proof headline", () => {
  it("quotes first and last lead skill, pooled, and the replay counts at 1 in 2, from the data", () => {
    const proof = proofFixture as Proof;
    const h = proofHeadline(proof, spots)!;
    const rows = [...proof.skillByLead].sort((a, b) => a.h - b.h);
    expect(h.headline).toContain(`${Math.round(Math.abs(rows[0].skill) * 100)}%`);
    expect(h.headline).toContain("(all gauges pooled)");
    if (Object.values(proof.tradeoff).some((l) => l.some((r) => r.pStar === 0.5))) {
      expect(h.detail).toMatch(/acting at a 1 in 2 chance caught/);
    }
  });
  it("owns a loss to the simple guess", () => {
    const proof = { skillByLead: [{ h: 6, pinballModel: 1, pinballPersistence: 2, skill: 0.4 }, { h: 72, pinballModel: 1, pinballPersistence: 1, skill: -0.05 }], tradeoff: {} };
    expect(proofHeadline(proof, spots)!.headline).toMatch(/5% larger 3 days ahead .* no better than the simple guess at 3 days ahead\.$/);
  });
});
