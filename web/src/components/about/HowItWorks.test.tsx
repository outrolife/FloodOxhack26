// The About diagram shows the five pipeline stages and reads its travel-time example from data (#102).
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TravelPair } from "../../contracts";
import shipped from "../../../public/data/travel_times.json";
import About from "../../views/About";
import { HowItWorksDiagram, travelExample } from "./HowItWorks";

const pair = (up: string, down: string, median: number, n = 6): TravelPair => ({
  up,
  down,
  n,
  tHalf: { p10: median - 4, median, p90: median + 4 },
  tPeak: { p10: median - 4, median, p90: median + 4 },
  events: [],
  xcorr: [],
  slopeHoursPerMetre: null,
});

describe("HowItWorksDiagram", () => {
  it("renders the five stages in order, as an accessible SVG", () => {
    const html = renderToStaticMarkup(<HowItWorksDiagram travel={travelExample([pair("enslow", "kingsmill", 18.6)])} />);
    expect(html).toContain('role="img"');
    expect(html).toMatch(/<title id="[^"]+">How River Clock works<\/title>/);
    expect(html).toContain("<desc");
    expect((html.match(/class="hiw-stage"/g) ?? []).length).toBe(5);
    const order = ["Upstream EA river gauges", "Travel times", "LightGBM quantile forecasts", "Calibrated flood probability", "Decide: act when P ≥ C/L"];
    let at = -1;
    const desc = /<desc[^>]*>(.*?)<\/desc>/s.exec(html)?.[1] ?? "";
    for (const s of order) {
      const i = desc.indexOf(s);
      expect(i, s).toBeGreaterThan(at);
      at = i;
    }
    expect(html).toContain("Thames, Windrush, Evenlode");
    expect(html).toContain("6 to 72 h ahead");
    expect(html).toContain("act when P ≥ C / L");
  });

  it("shows the example travel time from the data, rounded", () => {
    const html = renderToStaticMarkup(<HowItWorksDiagram travel={travelExample([pair("enslow", "kingsmill", 18.6)])} />);
    expect(html).toContain("Enslow → Kings Mill");
    expect(html).toContain("≈ 19 h (15–23 h)");
    expect(html).toContain("median of 6 past floods");
  });

  it("matches the shipped travel_times.json", () => {
    const t = travelExample(shipped as TravelPair[]);
    expect(t).not.toBeNull();
    const p = (shipped as TravelPair[]).find((x) => x.up === "enslow" && x.down === "kingsmill")!;
    expect(t!.median).toBe(Math.round(p.tHalf.median));
  });

  it("falls back to words when the pair is missing", () => {
    expect(travelExample([pair("islip", "kingsmill", 31)])).toBeNull();
    expect(travelExample(undefined)).toBeNull();
    const html = renderToStaticMarkup(<HowItWorksDiagram travel={null} />);
    expect(html).toContain("measured from");
    expect(html).not.toContain("≈");
  });
});

describe("About", () => {
  it("puts the diagram above the five-step text and keeps the disclaimer", () => {
    const html = renderToStaticMarkup(<About />);
    expect(html.indexOf("How it works at a glance")).toBeGreaterThanOrEqual(0);
    expect(html.indexOf("How it works at a glance")).toBeLessThan(html.indexOf("Measure the clock."));
    expect(html).toContain("not in place of them");
    expect(html).toContain("not an official flood warning");
  });
});
