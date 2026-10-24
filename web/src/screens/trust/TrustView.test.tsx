// The How good is it? screen renders from proof.json alone (#123): fixture and committed data.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Proof, Spot } from "../../contracts";
import fixture from "../../../../tests/fixtures/proof.json";
import fixtureSpots from "../../../../tests/fixtures/spots.json";
import { TrustView } from "./TrustView";
import { WhatsNext } from "./WhatsNext";
import { beatsTile, binsAt, earlyTile, officialComparison, pickInformativeBin, oddsCaption, POOLED } from "./trust";

const readPublic = <T,>(f: string): T =>
  JSON.parse(readFileSync(new URL(`../../../public/data/${f}`, import.meta.url), "utf8")) as T;

const unescape = (html: string) => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

for (const [label, proof, spots] of [
  ["fixture", fixture as unknown as Proof, fixtureSpots as Spot[]],
  ["committed data", readPublic<Proof>("proof.json"), readPublic<Spot[]>("spots.json")],
] as const) {
  describe(`TrustView on the ${label}`, () => {
    const html = unescape(renderToStaticMarkup(<TrustView proof={proof} spots={spots} working={<WhatsNext />} />));

    it("shows the three tiles with their numbers from the data", () => {
      const b = beatsTile(proof)!;
      expect(html).toContain("Beats 'nothing changes'");
      expect(html).toContain(b.caption);
      const bin = pickInformativeBin(binsAt(proof, POOLED)!)!;
      expect(html).toContain("Honest odds");
      expect(html).toContain(oddsCaption(bin));
      const e = earlyTile(proof, spots);
      expect(html).toContain("Early, without crying wolf");
      expect(html).toContain(`${e.caught} of ${e.floods} floods caught`);
    });

    it("labels pooled vs per spot and the EA comparison honestly", () => {
      expect(html).toMatch(/pooled across our (four )?gauges/i);
      expect(html).toContain("All spots (pooled)");
      expect(html).toContain("Against the official EA warning");
      const c = officialComparison(earlyTile(proof, spots))!;
      expect(html).toContain(`${c.oursText} · ${c.officialText}. ${c.verdict}`);
      expect(html).not.toContain("lower bound");
    });

    it("never calls our output a Flood Warning or Flood Alert", () => {
      // testPeriodNote may name the EA's own "Flood Warning" product; that's about the EA, not us.
      expect(html.replace(proof.testPeriodNote, "")).not.toMatch(/Flood (Warning|Alert)/);
    });

    it("keeps the working collapsed, with What's next inside", () => {
      expect(html).toMatch(/<details class="ui-working">/);
      expect(html).toContain("not switched on yet");
    });
  });
}

describe("TrustView on the committed data", () => {
  it("shows Wolvercote as having no flood odds, not hidden", () => {
    const html = renderToStaticMarkup(
      <TrustView proof={readPublic<Proof>("proof.json")} spots={readPublic<Spot[]>("spots.json")} />,
    );
    expect(html).toContain("Wolvercote");
    expect(html).toContain("no flood odds");
  });
});
