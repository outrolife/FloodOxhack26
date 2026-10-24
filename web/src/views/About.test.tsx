// About lists the sources we actually use and keeps the disclaimer (SPEC §15.7, #57).
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import About from "./About";

const html = renderToStaticMarkup(<About />);

describe("About", () => {
  it("credits every source the pipeline and app use", () => {
    for (const s of [
      "EA Hydrology API",
      "flood-monitoring daily archive",
      "EA Historic Flood Warnings",
      "GOV.UK Check for flooding",
      "Nominatim and Overpass",
      "OpenStreetMap contributors",
      "Open Government Licence v3.0",
      "Open Database Licence",
    ]) {
      expect(html).toContain(s);
    }
  });

  it("credits Open-Meteo (CC BY 4.0) for the S2 rain context, and says the model doesn't use it", () => {
    expect(html).toContain("Open-Meteo");
    expect(html).toContain("CC BY 4.0");
    expect(html).toMatch(/not a model input/);
  });

  it("states the known limitations", () => {
    for (const s of ["Minns Estate", "Cold Harbour", "No forecast for Wolvercote", "13 Oct 2026", "April 2023", "Replays may have learned from later floods", "No future rainfall"]) {
      expect(html).toContain(s);
    }
  });

  it("keeps the disclaimer and the gov.uk link", () => {
    expect(html).toContain("not an official flood warning");
    expect(html).toContain('href="https://www.gov.uk/check-flooding"');
  });
});
