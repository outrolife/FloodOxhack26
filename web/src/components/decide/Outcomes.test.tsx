// #99 items 1 and 3: Decide shows official warnings exactly as proof.json has
// them (officialOutcome, tradeoff[].meanLeadVsOfficialH), with no local
// re-derivation, and labels the counts as flood episodes.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Proof } from "../../contracts";
import fixture from "../../../../tests/fixtures/proof.json";
import * as costLoss from "../../lib/costLoss";
import { PRESETS, expectedCosts, interpolateTradeoff, officialFromProof } from "../../lib/costLoss";
import { FLOOD_EPISODE_NOTE } from "../shared/episodes";
import { OutcomesTable } from "./Outcomes";

const proof = fixture as Proof;
const resident = { C: PRESETS[0].C, L: PRESETS[0].L };
const counts = (o: NonNullable<ReturnType<typeof officialFromProof>>) => ({ hits: o.hits, misses: o.misses, falseAlarms: o.falseAlarms });

describe("Decide official warnings (#99 item 1)", () => {
  it("prices official warnings from proof.officialOutcome counts", () => {
    const official = officialFromProof(proof, "osney")!;
    expect(official).toEqual(proof.officialOutcome!.osney);
    const r = expectedCosts({ rows: proof.tradeoff.osney, costs: resident, official: counts(official) });
    const { hits, misses, falseAlarms } = proof.officialOutcome!.osney;
    expect(r.strategies.find((s) => s.key === "official")?.cost).toBe((hits + falseAlarms) * resident.C + misses * resident.L);
  });

  it("shows the official mean lead and lead-vs-official straight from proof.json", () => {
    const o = interpolateTradeoff(proof.tradeoff.osney, 0.05)!;
    const official = officialFromProof(proof, "osney");
    const html = renderToStaticMarkup(<OutcomesTable o={o} costs={resident} official={official} />);
    const row = proof.tradeoff.osney.find((r) => r.pStar === 0.05)!;
    expect(html).toContain(`${official!.meanLeadH} h`); // officialOutcome.meanLeadH
    expect(html).toContain(`+${row.meanLeadVsOfficialH} h`); // tradeoff[].meanLeadVsOfficialH
    // The old local estimate (our lead − our gain) must not appear.
    expect(html).not.toContain(`${row.meanLeadH! - row.meanLeadVsOfficialH!} h`);
    expect(html).toContain("scored with the same rules as River Clock");
  });

  it("says official warnings are not scored when officialOutcome is missing, instead of guessing", () => {
    const o = interpolateTradeoff(proof.tradeoff.osney, 0.05)!;
    const html = renderToStaticMarkup(<OutcomesTable o={o} costs={resident} official={officialFromProof({}, "osney")} />);
    expect(html).toContain("so they aren&#x27;t scored here");
    const r = expectedCosts({ rows: proof.tradeoff.osney, costs: resident, official: null });
    expect(r.strategies.find((s) => s.key === "official")?.cost).toBeNull();
  });

  it("no longer exports the replay / perEvent re-derivations", () => {
    const mod = costLoss as Record<string, unknown>;
    for (const gone of ["officialFromReplays", "officialFromPerEvent", "officialMeanLeadH"]) expect(mod[gone]).toBeUndefined();
  });

  it("says when River Clock's numbers are interpolated between backtested triggers", () => {
    const o = interpolateTradeoff(proof.tradeoff.osney, 0.03)!;
    const html = renderToStaticMarkup(<OutcomesTable o={o} costs={resident} official={null} />);
    expect(html).toContain("between two that we tested (2% and 5%)");
  });
});

describe("Decide flood episodes (#99 item 3)", () => {
  it("labels the counts as flood episodes and explains the 72 h rule", () => {
    const o = interpolateTradeoff(proof.tradeoff.osney, 0.05)!;
    const html = renderToStaticMarkup(<OutcomesTable o={o} costs={resident} official={null} />);
    expect(html).toContain("flood episodes (counted once per flood)");
    expect(FLOOD_EPISODE_NOTE).toContain("less than 72 h (3 days) later, it is still the same flood");
    expect(FLOOD_EPISODE_NOTE).toContain("already over the line doesn't count as a warning");
  });
});
