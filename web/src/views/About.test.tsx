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

  it("does not list Open-Meteo, which nothing uses", () => {
    expect(html).not.toMatch(/open-meteo/i);
  });

  it("states the known limitations", () => {
    for (const s of ["Minns Estate", "Cold Harbour", "No forecast for Wolvercote", "13 Oct 2026", "April 2023", "Leave-one-flood-out", "No future rainfall"]) {
      expect(html).toContain(s);
    }
  });

  it("keeps the disclaimer and the gov.uk link", () => {
    expect(html).toContain("not an official flood warning");
    expect(html).toContain('href="https://www.gov.uk/check-flooding"');
  });
});
