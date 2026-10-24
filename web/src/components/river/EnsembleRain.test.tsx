// S2 panel (SPEC §11): shown only for fresh real data, with its labels and credit.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { EnsembleRain } from "../../contracts";
import fixture from "../../../../tests/fixtures/stretch/ensemble_rain.json";
import { EnsembleRainView, isUsable } from "./EnsembleRain";

const data = fixture as EnsembleRain;
const issued = Date.parse(data.issuedAt);
const HOUR = 3600_000;
const render = (props: Parameters<typeof EnsembleRainView>[0]) => renderToStaticMarkup(<EnsembleRainView {...props} />);

describe("EnsembleRainView", () => {
  it("shows the fan with the Experimental label, the context note and the CC BY credit", () => {
    const html = render({ data, source: "data", nowMs: issued + 2 * HOUR });
    expect(html).toContain("Rain in the next 72 h");
    expect(html).toContain("Experimental");
    expect(html).toContain("Context only: our forecast does not yet use future rain.");
    expect(html).toContain("Open-Meteo.com");
    expect(html).toContain("CC BY 4.0");
    expect(html).toContain("<polygon");
    expect(html).toContain("15 mm"); // fixture p50 at +72 h is 15.2
  });

  it("is hidden when the file is missing (only the bundled fixture loaded)", () => {
    expect(render({ data, source: "fixture", nowMs: issued })).toBe("");
    expect(render({ data: undefined, source: undefined, nowMs: issued })).toBe("");
  });

  it("is hidden when the file is over 24 h old", () => {
    expect(render({ data, source: "data", nowMs: issued + 24 * HOUR })).not.toBe("");
    expect(render({ data, source: "data", nowMs: issued + 25 * HOUR })).toBe("");
  });

  it("is hidden when the file is malformed", () => {
    const bad = { ...data, cumMm: { ...data.cumMm, p90: [1] } };
    expect(isUsable(bad, "data", issued)).toBe(false);
    expect(isUsable({ ...data, issuedAt: "not a date" }, "data", issued)).toBe(false);
  });
});

describe("ensemble_rain.json loading", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("falls back to the fixture when web/public/data has no file, which the panel then hides", async () => {
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));
    const { loadData } = await import("../../data");
    const r = await loadData<EnsembleRain>("ensemble_rain.json");
    expect(r.source).toBe("fixture");
    expect(isUsable(r.value, r.source, issued)).toBe(false);
  });
});
