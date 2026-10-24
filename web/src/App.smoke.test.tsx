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

    render(<App />);
    // Let effects run and timers fire while every fetch is still pending.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(fetchStub).toHaveBeenCalled();
    expect(screen.getByRole("banner").textContent).toContain("River Clock");
    expect(screen.getByRole("navigation", { name: "What to show" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Now" }).getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector(".ui-basemap .leaflet-container")).not.toBeNull();
    expect(screen.getAllByText(/not an official warning/i).length).toBeGreaterThan(0);
    expect(errors).toEqual([]);

    // The files arrive.
    await act(async () => {
      open();
    });
    if (existsSync(DATA + "proof.json") && existsSync(DATA + "spots.json")) {
      await waitFor(() => expect(document.querySelector(".ck-score-caption")?.textContent).toMatch(/^Warns at \d+% chance/), {
        timeout: 5000,
      });
    }
    expect(screen.getByRole("navigation", { name: "What to show" })).toBeTruthy();
    expect(document.querySelector(".ui-basemap .leaflet-container")).not.toBeNull();
    if (existsSync(DATA + "spots.json")) {
      // Small identical spot markers, one per spot; no big clock cards and no permanent link labels on the map.
      const spots = JSON.parse(readFileSync(DATA + "spots.json", "utf8")) as unknown[];
      await waitFor(() => expect(document.querySelectorAll(".rc-hero .rc-dot")).toHaveLength(spots.length));
      expect(document.querySelector(".rc-hero .spot-clock")).toBeNull();
      expect(document.querySelector(".rc-hero .leaflet-tooltip.rc-link-label")).toBeNull();
      expect(document.querySelector(".rc-hero .rc-hero-score .ck-score")).not.toBeNull();
    }
    expect(errors).toEqual([]);
  });
});
