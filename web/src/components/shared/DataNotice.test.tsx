// The sample-data notice (#56): shown whenever a tab's file came from
// tests/fixtures/, and gone automatically once web/public/data/ has the real file.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Source } from "../../data";
import { FixtureNotice } from "./DataNotice";

const notice = (sources: (Source | undefined)[]) => renderToStaticMarkup(<FixtureNotice sources={sources} />);

describe("FixtureNotice", () => {
  it("shows when any source is a fixture", () => {
    expect(notice(["fixture", "data"])).toMatch(/sample data/);
    expect(notice([undefined, "fixture"])).toMatch(/sample data/);
  });

  it("is hidden when every loaded file is real data", () => {
    expect(notice(["data", "data"])).toBe("");
    expect(notice(["data", undefined])).toBe("");
  });
});

describe("proof.json source (drives the Decide notice)", () => {
  // data.ts caches each file, so load a fresh copy of the module per test.
  const freshLoadData = async () => {
    vi.resetModules();
    return (await import("../../data")).loadData;
  };
  afterEach(() => vi.unstubAllGlobals());

  it("falls back to the fixture, so the notice shows, when web/public/data has no proof.json", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));
    const r = await (await freshLoadData())("proof.json");
    expect(r.source).toBe("fixture");
    expect(notice([r.source])).toMatch(/sample data/);
  });

  it("uses the real file, so the notice disappears, once proof.json exists", async () => {
    const body = JSON.stringify({ tradeoff: {}, perEvent: [] });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": "application/json" } })),
    );
    const r = await (await freshLoadData())("proof.json");
    expect(r.source).toBe("data");
    expect(notice([r.source])).toBe("");
  });
});
