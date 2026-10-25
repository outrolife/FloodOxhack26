// @vitest-environment jsdom
//
// Blank-page guard (#118, after the #143 crash): render the whole <App/> in
// jsdom with fetch stubbed to read web/public/data. First with every fetch
// still pending (the moment a slow network shows), then once the files
// arrive. The header, the switch and the map container must be on screen
// throughout, and nothing may log a console error.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";

// Not import.meta.url: under jsdom it is an http URL. vitest provides __dirname.
const DATA = resolve(__dirname, "../public/data") + "/";

// CI runners are slow: the real replays are several MB of JSON. Generous waits; the checks stay the same.
const WAIT_MS = 15_000;
const TEST_MS = 40_000;

/** A fetch Response for /data/<file> from web/public/data (404 for anything else, e.g. /api/live). */
function respond(url: string) {
  const path = new URL(url, "http://localhost/").pathname;
  const file = path.startsWith("/data/") ? DATA + decodeURIComponent(path.slice("/data/".length)) : null;
  const ok = file != null && existsSync(file);
  const text = ok ? readFileSync(file, "utf8") : "";
  return {
    ok,
    status: ok ? 200 : 404,
    headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? (ok ? "application/json" : "text/plain") : null) },
    json: async () => JSON.parse(text) as unknown,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("App smoke test (jsdom)", () => {
  it("renders the header, the switch and the map while data is loading, then loads without console errors", async () => {
    const errors: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
    // Every fetch waits until the gate opens: a slow network.
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      await gate;
      return respond(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    });
    vi.stubGlobal("fetch", fetchStub);

    window.history.replaceState(null, "", "/?map=leaflet#/now");
    render(<App />);
    // Let effects run and timers fire while every fetch is still pending.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(fetchStub).toHaveBeenCalled();
    expect(screen.getByRole("banner").textContent).toContain("River Clock");
    expect((screen.getByRole("combobox", { name: "What to show" }) as HTMLSelectElement).value).toBe("now");
    expect(document.querySelector(".ui-basemap-toggle")).toBeNull(); // street map by default, no toggle
    expect(document.querySelector(".ui-basemap .leaflet-container")).not.toBeNull();
    expect(screen.getAllByText(/not an official warning/i).length).toBeGreaterThan(0);
    expect(errors).toEqual([]);

    // The files arrive.
    await act(async () => {
      open();
    });
    if (existsSync(DATA + "proof.json") && existsSync(DATA + "spots.json")) {
      await waitFor(() => expect(document.querySelector(".ck-score-caption")?.textContent).toMatch(/^Warns at \d+% chance/), {
        timeout: WAIT_MS,
      });
    }
    expect(screen.getByRole("combobox", { name: "What to show" })).toBeTruthy();
    expect(document.querySelector(".ui-basemap .leaflet-container")).not.toBeNull();
    expect(document.querySelector(".rc-stage > .rc-flowkey")).not.toBeNull(); // the key is under the map, not on it
    if (existsSync(DATA + "spots.json")) {
      // Small identical spot markers, one per spot with data (no-forecast / offline spots are left off,
      // markers.withData); no big clock cards and no permanent link labels on the map.
      const spots = JSON.parse(readFileSync(DATA + "spots.json", "utf8")) as unknown[];
      await waitFor(() => {
        const n = document.querySelectorAll(".rc-hero .rc-dot").length;
        expect(n).toBeGreaterThan(0);
        expect(n).toBeLessThan(spots.length); // Wolvercote (timing-only) never shows
      }, { timeout: WAIT_MS });
      expect(document.querySelector(".rc-hero .spot-clock")).toBeNull();
      expect(document.querySelector(".rc-hero .leaflet-tooltip.rc-link-label")).toBeNull();
      expect(document.querySelector(".rc-stage .rc-hero-score .ck-score")).not.toBeNull();
    }
    if (existsSync(DATA + "stations.json")) {
      // Every gauge in stations.json is a small gauge icon (upstream, live_only and Oxford targets alike).
      const stations = JSON.parse(readFileSync(DATA + "stations.json", "utf8")) as unknown[];
      await waitFor(() => expect(document.querySelectorAll(".rc-hero .rc-gauge-icon")).toHaveLength(stations.length), { timeout: WAIT_MS });
      // The selected spot's river walk: its upstream gauges stand out (Botley Road has measured travel times).
      if (existsSync(DATA + "travel_times.json")) {
        await waitFor(() => expect(document.querySelectorAll(".rc-hero .rc-gauge-icon.emph").length).toBeGreaterThan(1), { timeout: WAIT_MS });
      }
    }
    await act(async () => screen.getByRole("button", { name: "Catchment" }).click());
    await waitFor(() => expect(document.querySelector(".rc-flowmap")?.classList.contains("rc-catchment")).toBe(true), { timeout: WAIT_MS });
    expect(screen.getByRole("button", { name: "Catchment" }).getAttribute("aria-pressed")).toBe("true");
    await act(async () => screen.getByRole("button", { name: "Oxford" }).click());
    await waitFor(() => expect(document.querySelector(".rc-flowmap")?.classList.contains("rc-catchment")).toBe(false), { timeout: WAIT_MS });
    expect(errors).toEqual([]);
  }, TEST_MS);

  it.skipIf(!existsSync(DATA + "replays/e2014.json"))("plays a past flood (#/e2014) without console errors", async () => {
    const errors: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => respond(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)),
    );
    window.history.replaceState(null, "", "/?map=leaflet#/e2014");
    window.location.hash = "/e2014";
    render(<App />);
    await waitFor(() => expect((screen.getByRole("combobox", { name: "What to show" }) as HTMLSelectElement).value).toBe("e2014"), { timeout: WAIT_MS });
    await waitFor(() => expect(document.querySelector(".ck-play")).not.toBeNull(), { timeout: WAIT_MS });
    // Let playback run a few frames.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(document.querySelectorAll(".rc-hero .rc-dot").length).toBeGreaterThan(0);
    expect(errors).toEqual([]);
    window.location.hash = "";
  }, TEST_MS);
});
