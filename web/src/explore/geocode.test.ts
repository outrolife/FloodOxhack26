import { describe, expect, it, vi } from "vitest";
import { createGeocoder, looksLikePostcode, photonLabel, type LocalPlace } from "./geocode";
import { GeocodeError } from "./types";

type Route = (url: string, init?: RequestInit) => Response | Promise<Response> | "throw" | "hang";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fetch mock that answers by the first matching URL fragment. */
function mockFetch(routes: Record<string, Route>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    for (const [frag, route] of Object.entries(routes)) {
      if (!url.includes(frag)) continue;
      const r = await route(url, init);
      if (r === "throw") throw new TypeError("Failed to fetch");
      if (r === "hang")
        return new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))),
        );
      return r;
    }
    return json({}, 404);
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

const local: LocalPlace[] = [
  { name: "Botley Road", lat: 51.751, lon: -1.282 },
  { name: "Abingdon", lat: 51.67, lon: -1.28 },
];
const opts = { localPlaces: async () => local, isOnline: () => true };

const photonFeature = (props: Record<string, string>, lon = -1.28, lat = 51.75) => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [lon, lat] },
  properties: props,
});

describe("looksLikePostcode", () => {
  it("accepts full and partial postcodes, not words", () => {
    for (const q of ["OX2", "ox2 0", "OX2 0HA", "ox20ha", "SW1A 1AA", "M1"]) expect(looksLikePostcode(q)).toBe(true);
    for (const q of ["Botley Road", "Oxford", "12 High St"]) expect(looksLikePostcode(q)).toBe(false);
  });
});

describe("photonLabel", () => {
  it("builds '12 Botley Road, Oxford OX2 0HA'", () => {
    expect(photonLabel({ housenumber: "12", street: "Botley Road", city: "Oxford", postcode: "OX2 0HA" })).toBe("12 Botley Road, Oxford OX2 0HA");
    expect(photonLabel({ name: "Oxford" })).toBe("Oxford");
    expect(photonLabel({ name: "Osney Lock", street: "Bridge Street", city: "Oxford" })).toBe("Osney Lock, Bridge Street, Oxford");
  });
});

describe("suggest", () => {
  it("ignores queries shorter than 3 characters", async () => {
    const f = mockFetch({});
    expect(await createGeocoder(f, opts).suggest("OX")).toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });

  it("keeps the space in a partial postcode: 'OX1 4' never suggests OX14", async () => {
    const f = mockFetch({
      "/autocomplete": () => json({ status: 200, result: ["OX1 4AB", "OX14 1AA"] }),
      "api.postcodes.io/postcodes": (_u, init) => {
        const codes = (JSON.parse(String(init?.body)) as { postcodes: string[] }).postcodes;
        return json({ status: 200, result: codes.map((c) => ({ query: c, result: { postcode: c, latitude: 51.75, longitude: -1.25, admin_district: "Oxford" } })) });
      },
    });
    const places = await createGeocoder(f, opts).suggest("OX1 4");
    expect(String(f.mock.calls[0][0])).toContain("/postcodes/OX1%204A/autocomplete");
    expect(places.map((p) => p.postcode ?? p.label)).toEqual([expect.stringContaining("OX1 4AB")]);
  });

  it("uses postcodes.io autocomplete then a bulk lookup for postcodes", async () => {
    const f = mockFetch({
      "/autocomplete": () => json({ status: 200, result: ["OX2 0HA", "OX2 0HB"] }),
      "api.postcodes.io/postcodes": (_u, init) => {
        expect(JSON.parse(String(init?.body))).toEqual({ postcodes: ["OX2 0HA", "OX2 0HB"] });
        return json({
          result: [
            { query: "OX2 0HA", result: { postcode: "OX2 0HA", latitude: 51.75, longitude: -1.28, admin_district: "Oxford" } },
            { query: "OX2 0HB", result: null },
          ],
        });
      },
    });
    const out = await createGeocoder(f, opts).suggest("ox2 0h");
    expect(out).toEqual([{ label: "OX2 0HA, Oxford", lat: 51.75, lon: -1.28, kind: "postcode", postcode: "OX2 0HA" }]);
    expect(String(f.mock.calls[0][0])).toContain("https://api.postcodes.io/postcodes/ox2%200h/autocomplete");
  });

  it("returns [] when a postcode has no matches", async () => {
    const f = mockFetch({ "/autocomplete": () => json({ status: 200, result: null }) });
    expect(await createGeocoder(f, opts).suggest("ZZ9 9")).toEqual([]);
  });

  it("uses Photon for addresses, biased to Oxford, GB only, deduped", async () => {
    const f = mockFetch({
      "photon.komoot.io/api/": () =>
        json({
          type: "FeatureCollection",
          features: [
            photonFeature({ housenumber: "12", street: "Botley Road", city: "Oxford", postcode: "OX2 0HA", countrycode: "GB" }),
            photonFeature({ housenumber: "12", street: "Botley Road", city: "Oxford", postcode: "OX2 0HA", countrycode: "GB" }),
            photonFeature({ name: "Botley", city: "Paris", countrycode: "FR" }),
            photonFeature({ name: "Botley", county: "Hampshire", countrycode: "GB" }, -1.27, 50.91),
          ],
        }),
    });
    const out = await createGeocoder(f, opts).suggest("botley road");
    expect(out.map((p) => p.label)).toEqual(["12 Botley Road, Oxford OX2 0HA", "Botley, Hampshire"]);
    expect(out[0]).toMatchObject({ kind: "address", postcode: "OX2 0HA", lat: 51.75, lon: -1.28 });
    expect(out[1].kind).toBe("place");
    const url = String(f.mock.calls[0][0]);
    expect(url).toContain("lat=51.752&lon=-1.258&limit=6&lang=en");
    expect(url).not.toContain("nominatim");
  });

  it("caches results (LRU)", async () => {
    const f = mockFetch({ "photon.komoot.io/api/": () => json({ type: "FeatureCollection", features: [] }) });
    const g = createGeocoder(f, { ...opts, cacheSize: 2 });
    await g.suggest("Oxford");
    await g.suggest("oxford ");
    expect(f).toHaveBeenCalledTimes(1);
    await g.suggest("Abingdon");
    await g.suggest("Witney");
    await g.suggest("Oxford"); // evicted
    expect(f).toHaveBeenCalledTimes(4);
  });

  it("maps HTTP 429 to rate_limited with a friendly message", async () => {
    const f = mockFetch({ "photon.komoot.io": () => json({}, 429) });
    const err = await createGeocoder(f, opts).suggest("Oxford").catch((e) => e);
    expect(err).toBeInstanceOf(GeocodeError);
    expect(err.reason).toBe("rate_limited");
    expect(err.message).toMatch(/Too many searches/);
  });

  it("maps network errors and timeouts to network", async () => {
    const down = mockFetch({ "photon.komoot.io": () => "throw" });
    await expect(createGeocoder(down, opts).suggest("Oxford")).rejects.toMatchObject({ reason: "network" });
    const slow = mockFetch({ "photon.komoot.io": () => "hang" });
    const err = await createGeocoder(slow, { ...opts, timeoutMs: 20 }).suggest("Oxford").catch((e) => e);
    expect(err).toMatchObject({ reason: "network" });
    expect(err.message).toMatch(/too long/);
  });

  it("rejects with AbortError when the caller cancels", async () => {
    const f = mockFetch({ "photon.komoot.io": () => "hang" });
    const ctrl = new AbortController();
    const p = createGeocoder(f, opts).suggest("Oxford", ctrl.signal);
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });

  it("offline: matches local names, else throws offline", async () => {
    const f = mockFetch({});
    const g = createGeocoder(f, { ...opts, isOnline: () => false });
    expect(await g.suggest("botley")).toEqual([{ label: "Botley Road (offline)", lat: 51.751, lon: -1.282, kind: "place" }]);
    await expect(g.suggest("Witney")).rejects.toMatchObject({ reason: "offline", message: expect.stringMatching(/offline/) });
    expect(f).not.toHaveBeenCalled();
  });
});

describe("reverse", () => {
  it("uses Photon reverse and keeps the clicked point", async () => {
    const f = mockFetch({
      "photon.komoot.io/reverse": () =>
        json({ type: "FeatureCollection", features: [photonFeature({ housenumber: "12", street: "Botley Road", city: "Oxford", postcode: "OX2 0HA", countrycode: "GB" })] }),
    });
    const p = await createGeocoder(f, opts).reverse(51.7511, -1.2799);
    expect(p).toEqual({ label: "12 Botley Road, Oxford OX2 0HA", lat: 51.7511, lon: -1.2799, kind: "address", postcode: "OX2 0HA" });
    expect(String(f.mock.calls[0][0])).toContain("https://photon.komoot.io/reverse?lat=51.7511&lon=-1.2799");
  });

  it("falls back to the nearest postcode", async () => {
    const f = mockFetch({
      "photon.komoot.io/reverse": () => json({}, 500),
      "api.postcodes.io/postcodes?lon=": () => json({ result: [{ postcode: "OX2 0HA", latitude: 51.75, longitude: -1.28 }] }),
    });
    const p = await createGeocoder(f, opts).reverse(51.75, -1.28);
    expect(p).toEqual({ label: "Near OX2 0HA", lat: 51.75, lon: -1.28, kind: "postcode", postcode: "OX2 0HA" });
  });

  it("falls back to the nearest local place when both services fail or find nothing", async () => {
    const f = mockFetch({
      "photon.komoot.io/reverse": () => json({ type: "FeatureCollection", features: [] }),
      "api.postcodes.io": () => "throw",
    });
    const p = await createGeocoder(f, opts).reverse(51.752, -1.283);
    // Online but both services failed: no "(offline)" in the label.
    expect(p).toEqual({ label: "Near Botley Road", lat: 51.752, lon: -1.283, kind: "place" });
  });

  it("goes straight to the local fallback when offline", async () => {
    const f = mockFetch({});
    const p = await createGeocoder(f, { ...opts, isOnline: () => false }).reverse(51.67, -1.28);
    expect(p.label).toBe("Near Abingdon (offline)");
    expect(f).not.toHaveBeenCalled();
  });

  it("throws GeocodeError only when even the local fallback is impossible", async () => {
    const f = mockFetch({ "photon.komoot.io": () => json({}, 429), "api.postcodes.io": () => json({}, 429) });
    const g = createGeocoder(f, { ...opts, localPlaces: async () => [] });
    await expect(g.reverse(51.75, -1.28)).rejects.toMatchObject({ reason: "rate_limited" });
    const off = createGeocoder(mockFetch({}), { isOnline: () => false, localPlaces: async () => [] });
    await expect(off.reverse(51.75, -1.28)).rejects.toMatchObject({ reason: "offline" });
    const broken = createGeocoder(mockFetch({}), { isOnline: () => true, localPlaces: () => Promise.reject(new Error("x")) });
    await expect(broken.reverse(51.75, -1.28)).rejects.toBeInstanceOf(GeocodeError);
  });

  it("caches online answers but not the offline fallback", async () => {
    const f = mockFetch({ "photon.komoot.io/reverse": () => json({ type: "FeatureCollection", features: [] }), "api.postcodes.io": () => json({ result: null }) });
    const g = createGeocoder(f, opts);
    await g.reverse(51.75, -1.28);
    await g.reverse(51.75, -1.28);
    expect(f).toHaveBeenCalledTimes(4);
  });
});
