// S4 (SPEC §11): the inspection list shows reasons, the human checks, the
// "Screening score, not modelled damage reduction" label and "Experimental".
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Sandbags } from "../../contracts";
import fixture from "../../../../tests/fixtures/stretch/sandbags.json";
import { SHOW_S4 } from "../../stretch";
import { SANDBAG_TITLE, SCORE_LABEL, SandbagList, osmUrl } from "./SandbagList";

const data = fixture as Sandbags;

describe("SandbagList", () => {
  it("renders nothing without data", () => {
    expect(renderToStaticMarkup(<SandbagList data={null} />)).toBe("");
  });

  it("shows the label, the Experimental badge, reasons and every check", () => {
    const html = renderToStaticMarkup(<SandbagList data={data} />);
    expect(html).toContain(SANDBAG_TITLE);
    expect(html).toContain(SCORE_LABEL);
    expect(html).toContain("Experimental");
    for (const c of data.candidates) {
      for (const r of c.reasons) expect(html).toContain(r);
      for (const k of c.checks) expect(html).toContain(k);
    }
    expect(html).toContain("Door and sill height");
    expect(html).toContain("Risk of diverting water to neighbours");
    expect(html).toContain(`${data.excluded.length} buildings screened out`);
    expect(html).toContain("OpenStreetMap contributors");
  });

  it("says so when nothing passes the screening", () => {
    const html = renderToStaticMarkup(<SandbagList data={{ ...data, candidates: [] }} />);
    expect(html).toContain("No building passes the screening");
  });

  it("links OSM ids to their OpenStreetMap page", () => {
    expect(osmUrl("osm-way-123", 51.75, -1.27)).toBe("https://www.openstreetmap.org/way/123");
    expect(osmUrl("x", 51.75, -1.27)).toContain("mlat=51.75");
  });

  it("is switched on (S4 signed off)", () => {
    expect(SHOW_S4).toBe(true);
  });
});
