// #118 "the map doesn't even show": two causes, both guarded here.
// 1. The demo server sent oxford-base.geojson as application/octet-stream and
//    the loader refused it as "not JSON", so BaseMap drew an empty map.
// 2. A Leaflet container without a definite height is 0 px high and draws nothing.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("loading the basemap", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  const serve = (type: string, body: string) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": type } })),
    );

  for (const type of ["application/geo+json", "application/octet-stream", "text/plain; charset=utf-8"]) {
    it(`accepts GeoJSON served as ${type}`, async () => {
      serve(type, JSON.stringify({ type: "FeatureCollection", features: [] }));
      const { loadData } = await import("../data");
      const r = await loadData<{ type: string }>("geo/oxford-base.geojson");
      expect(r.source).toBe("data");
      expect(r.value.type).toBe("FeatureCollection");
    });
  }

  it("still refuses the dev server's index.html fallback", async () => {
    serve("text/html", "<!doctype html><div id=root></div>");
    const { loadData } = await import("../data");
    await expect(loadData("geo/oxford-base.geojson")).rejects.toThrow();
  });
});

describe("the map container has a real size", () => {
  const css = readFileSync(new URL("./ui.css", import.meta.url), "utf8");
  const rule = (sel: string) => {
    const m = new RegExp(`(^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css);
    return m ? m[2] : "";
  };
  const px = (v: string) => {
    const m = /^([\d.]+)(px|vh)$/.exec(v.trim());
    if (!m) return 0;
    return m[2] === "px" ? Number(m[1]) : (Number(m[1]) / 100) * 768; // a small laptop screen
  };
  const decl = (body: string, prop: string) => new RegExp(`(?:^|;|\\s)${prop}:\\s*([^;]+)`).exec(body)?.[1] ?? "";

  it(".ui-basemap has an explicit, non-zero height and min-height", () => {
    const body = rule(".ui-basemap");
    expect(px(decl(body, "height"))).toBeGreaterThan(200);
    expect(px(decl(body, "min-height"))).toBeGreaterThan(200);
  });

  it("the Leaflet container fills it", () => {
    const body = rule(".ui-basemap .leaflet-container");
    expect(body).toMatch(/position:\s*absolute/);
    expect(body).toMatch(/inset:\s*0/);
  });
});
