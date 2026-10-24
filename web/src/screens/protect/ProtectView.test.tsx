// Protect screen (#121): the labels, the data-driven headline and the live "nothing to protect" state.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Sandbags, SpreadManifest } from "../../contracts";
import e2014Bags from "../../../public/data/spread/e2014/sandbags.json";
import e2014Manifest from "../../../public/data/spread/e2014/manifest.json";
import liveManifest from "../../../public/data/spread/live/manifest.json";
import { type MapProps, ProtectView, SCREENING_LABEL } from "./ProtectView";

const noop = () => {};

function render(over: Partial<Parameters<typeof ProtectView>[0]> = {}, onMap?: (p: MapProps) => void) {
  return renderToStaticMarkup(
    <ProtectView
      context="e2014"
      onContext={noop}
      manifest={e2014Manifest as SpreadManifest}
      sandbags={e2014Bags as Sandbags}
      outline={null}
      budget={500}
      onBudget={noop}
      tau={24}
      onTau={noop}
      playing={false}
      onPlay={noop}
      selected={null}
      onSelect={noop}
      renderMap={(p) => {
        onMap?.(p);
        return <div data-map={p.pins.length} />;
      }}
      {...over}
    />,
  );
}

describe("ProtectView", () => {
  it("e2014: headline from the data, both labels, the IoU in words, cards with checks", () => {
    let map: MapProps | null = null;
    const html = render({}, (p) => (map = p));
    expect(html).toContain("If January 2014 happened again, these 5 buildings would be first in line for 500 sandbags");
    expect(html).toContain(SCREENING_LABEL);
    expect(html).toContain("Experimental");
    expect(html).toContain("Screening score, not modelled damage reduction.");
    expect(html).toContain("overlap by 68%");
    expect(html).toContain("Door and sill height");
    expect(html).toContain("Risk of diverting water to neighbours");
    expect(html).toContain("gov.uk/check-flooding");
    expect(html).not.toMatch(/flood (warning|alert)/i);
    expect(map!.pins.map((p) => p.n)).toEqual([1, 2, 3, 4, 5]);
    expect(map!.frameUrl).toMatch(/spread\/e2014\/tau24_.*\.png$/);
    // +24 h: only the first building (wet from +12 h) is reached.
    expect(map!.pins.filter((p) => p.wet).map((p) => p.n)).toEqual([1]);
    expect(html).toContain("1 of 5 buildings are reached by then");
  });

  it("the budget slider drops buildings when the budget is small", () => {
    let map: MapProps | null = null;
    render({ budget: 60 }, (p) => (map = p));
    expect(map!.pins.length).toBeLessThan(5);
    expect(map!.pins.reduce((n, p) => n + p.c.bags, 0)).toBeLessThanOrEqual(60);
  });

  it("live with nothing likely wet: says so and offers the 2014 replay", () => {
    const quiet: Sandbags = { issuedAt: "2026-10-24T18:07:00Z", budget: 500, candidates: [], excluded: [] };
    const html = render({ context: "live", manifest: liveManifest as SpreadManifest, sandbags: quiet });
    expect(html).toContain("Nothing to protect right now.");
    expect(html).toContain("See it for January 2014");
  });
});
