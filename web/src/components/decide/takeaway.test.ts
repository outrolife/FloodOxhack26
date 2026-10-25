// #103 item 4: one plain sentence under the Decide cost chart, from the data.
import { describe, expect, it } from "vitest";
import type { StrategyCost, StrategyKey } from "../../lib/costLoss";
import { expectedCosts, officialFromProof, PRESETS } from "../../lib/costLoss";
import type { Proof } from "../../contracts";
import proofFixture from "../../../../tests/fixtures/proof.json";
import { costTakeaway, lowestKeys } from "./takeaway";

const s = (key: StrategyKey, cost: number | null): StrategyCost => ({ key, label: key, counts: null, cost });

describe("Decide takeaway (#103)", () => {
  it("cheap action: act early; says Always act is about the same and points at the official comparison", () => {
    const t = costTakeaway([s("riverClock", 420), s("official", 4160), s("neverAct", 16000), s("alwaysAct", 500)], 0.01)!;
    expect(t).toMatch(/^Cheap action \(act at 1% chance or more\): act early, even on a small chance\./);
    expect(t).toContain("Acting every time costs about the same (£500)");
    expect(t).toContain("Acting on FloodClock costs £420 here, against £4,160 for waiting for the official warning.");
  });

  it("costly action: wait until likely, and name the false alarms saved", () => {
    const t = costTakeaway([s("riverClock", 30000), s("official", 50000), s("neverAct", 80000), s("alwaysAct", 45000)], 0.3)!;
    expect(t).toMatch(/^Costly action \(act at 30% chance or more\): wait until a flood is likely\./);
    expect(t).toContain("Acting every time would cost £45,000");
  });

  it("is honest when the official warnings would have cost less", () => {
    const t = costTakeaway([s("riverClock", 900), s("official", 600), s("alwaysAct", 2000)], 0.05)!;
    expect(t).toContain("acting on the official warnings (£600) would have cost less than FloodClock (£900)");
  });

  it("returns nothing when acting never pays or FloodClock has no score", () => {
    expect(costTakeaway([s("riverClock", 100)], 1)).toBeNull();
    expect(costTakeaway([s("riverClock", null), s("official", 5)], 0.1)).toBeNull();
  });

  it("marks ties as joint lowest rather than crowning FloodClock alone", () => {
    expect(lowestKeys([s("riverClock", 110000), s("official", 200000), s("alwaysAct", 110000)])).toEqual(["riverClock", "alwaysAct"]);
    expect(lowestKeys([s("riverClock", 1), s("official", null)])).toEqual(["riverClock"]);
  });

  it("builds a sentence from the fixture's real numbers", () => {
    const proof = proofFixture as Proof;
    const spot = Object.keys(proof.tradeoff)[0];
    const costs = { C: PRESETS[0].C, L: PRESETS[0].L };
    const official = officialFromProof(proof, spot);
    const r = expectedCosts({ rows: proof.tradeoff[spot], costs, official });
    const t = costTakeaway(r.strategies, r.pStar);
    const rc = r.strategies.find((x) => x.key === "riverClock")!.cost;
    if (rc !== null) expect(t).toContain("Cheap action");
  });
});
