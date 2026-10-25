// @vitest-environment jsdom
// #118 Explore UI: the search combobox, the point card and the sandbag estimate.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DEBOUNCE_MS, EXAMPLE_PLACE, NOT_FOUND_TEXT, OFFLINE_TEXT, SearchBox, lookupFailure } from "./SearchBox";
import { PointCard, chanceWords, nearbyLine } from "./PointCard";
import { SandbagCard, StepText } from "./SandbagCard";
import L from "leaflet";
import { dropsPin, explodeZones, mercatorUnit, zoneLabel, zoneStyle } from "./ExploreLayer";
import { countAt } from "./motion";
import { describePoint } from "./risk";
import { estimateSandbags } from "./sandbags";
import { GeocodeError, type Geocoder, type Place } from "./types";
import type { Selection } from "./useExplore";

const BOTLEY: Place = { label: "Botley Road, Oxford OX2 0HA", lat: 51.7522, lon: -1.2795, kind: "postcode", postcode: "OX2 0HA" };
const OSNEY: Place = { label: "Osney Island, Oxford OX2 0AZ", lat: 51.75, lon: -1.273, kind: "address" };

/** Reduced motion everywhere in these tests, so the count-up shows its target at once. */
function reducedMotion(on: boolean) {
  window.matchMedia = ((q: string) => ({
    matches: on && q.includes("reduce"),
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => reducedMotion(true));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Let resolved promises run (fake timers don't flush microtasks). */
const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe("SearchBox", () => {
  it("Try an example picks the example address without a lookup", () => {
    const onPick = vi.fn();
    const geocoder: Geocoder = { suggest: vi.fn(), reverse: vi.fn() };
    render(<SearchBox onPick={onPick} geocoder={geocoder} example={EXAMPLE_PLACE} />);
    fireEvent.click(screen.getByRole("button", { name: "Try an example" }));
    expect(onPick).toHaveBeenCalledWith(EXAMPLE_PLACE);
    expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe(EXAMPLE_PLACE.label);
    expect(geocoder.suggest).not.toHaveBeenCalled();
  });

  it("waits 300 ms, asks once for the latest text and aborts the stale request", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const suggest = vi.fn((q: string, signal?: AbortSignal) => {
      if (signal) signals.push(signal);
      return Promise.resolve(q.includes("OX2") ? [BOTLEY, OSNEY] : []);
    });
    const geocoder: Geocoder = { suggest, reverse: vi.fn() };
    render(<SearchBox onPick={() => {}} geocoder={geocoder} />);
    const box = screen.getByRole("combobox");
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "OX2" } });
    act(() => vi.advanceTimersByTime(DEBOUNCE_MS - 50));
    expect(suggest).not.toHaveBeenCalled();
    fireEvent.change(box, { target: { value: "OX2 0" } });
    act(() => vi.advanceTimersByTime(DEBOUNCE_MS));
    expect(suggest).toHaveBeenCalledTimes(1);
    expect(suggest.mock.calls[0][0]).toBe("OX2 0");
    await flush();
    expect(screen.getAllByRole("option")).toHaveLength(2);
    expect(box.getAttribute("aria-expanded")).toBe("true");
    // A new keystroke aborts the request in flight.
    fireEvent.change(box, { target: { value: "OX2 0H" } });
    act(() => vi.advanceTimersByTime(DEBOUNCE_MS));
    fireEvent.change(box, { target: { value: "OX2 0HA" } });
    expect(signals[1].aborted).toBe(true);
  });

  it("moves with the arrow keys, picks with Enter and closes with Esc", async () => {
    vi.useFakeTimers();
    const onPick = vi.fn();
    const geocoder: Geocoder = { suggest: () => Promise.resolve([BOTLEY, OSNEY]), reverse: vi.fn() };
    render(<SearchBox onPick={onPick} geocoder={geocoder} />);
    const box = screen.getByRole("combobox");
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "Oxford" } });
    act(() => vi.advanceTimersByTime(DEBOUNCE_MS));
    await flush();
    const options = screen.getAllByRole("option");
    expect(options[0].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[1].getAttribute("aria-selected")).toBe("true");
    expect(box.getAttribute("aria-activedescendant")).toBe(screen.getAllByRole("option")[1].id);
    fireEvent.keyDown(box, { key: "Escape" });
    expect(box.getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith(BOTLEY);
    expect((box as HTMLInputElement).value).toBe(BOTLEY.label);
  });

  it("shows a friendly message, never a crash, when the lookup fails", async () => {
    vi.useFakeTimers();
    const geocoder: Geocoder = { suggest: () => Promise.reject(new GeocodeError("We couldn't find that address. Try a postcode like OX2 0HA.", "not_found")), reverse: vi.fn() };
    render(<SearchBox onPick={() => {}} geocoder={geocoder} />);
    const box = screen.getByRole("combobox");
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "zzzz" } });
    act(() => vi.advanceTimersByTime(DEBOUNCE_MS));
    await flush();
    expect(screen.getByRole("status").textContent).toContain("Try a postcode like OX2 0HA");
    expect(screen.queryByText("Retry")).toBeNull();
  });

  it("offers Retry when offline", () => {
    expect(lookupFailure(new GeocodeError("x", "offline"))).toEqual({ text: OFFLINE_TEXT, retry: true });
    expect(lookupFailure(new GeocodeError("", "not_found")).text).toBe(NOT_FOUND_TEXT);
    expect(lookupFailure(new Error("boom")).retry).toBe(true);
  });
});

const sel = (over: Partial<Selection> = {}): Selection => ({ id: 1, lat: 51.7522, lon: -1.2795, source: "click", place: null, status: "loading", ...over });

describe("PointCard", () => {
  it("shows a skeleton while the address and the zones load", () => {
    render(<PointCard selection={sel()} risk={{ status: "loading" }} onClose={() => {}} onRetry={() => {}} />);
    expect(screen.getByRole("complementary").getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText("Looking up the address…")).toBeTruthy();
  });

  it("shows the badge in words, the sentence, the nearby forecast and the sandbag estimate", () => {
    const risk = describePoint("high", { key: "botley", name: "Botley Road", distanceM: 120, prob3d: 0.02 });
    render(<PointCard selection={sel({ place: BOTLEY, status: "ready", source: "search" })} risk={{ status: "ready", risk }} onClose={() => {}} onRetry={() => {}} />);
    expect(screen.getByText("High risk")).toBeTruthy();
    expect(screen.getByText(risk.sentence)).toBeTruthy();
    expect(screen.getByText("FloodClock now: 2% chance at Botley Road in the next 3 days")).toBeTruthy();
    expect(screen.getByText("Sandbag estimate")).toBeTruthy();
    expect(screen.getByText("How we calculated this")).toBeTruthy();
  });

  it("explains a failed lookup and retries", () => {
    const onRetry = vi.fn();
    render(
      <PointCard
        selection={sel({ status: "error", error: { text: OFFLINE_TEXT, retry: true } })}
        risk={{ status: "unavailable" }}
        onClose={() => {}}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("offline");
    fireEvent.click(screen.getByText("Retry"));
    expect(onRetry).toHaveBeenCalled();
    expect(screen.getByText(/flood zone map isn't available/)).toBeTruthy();
  });

  it("words chances like the rest of FloodClock", () => {
    expect(chanceWords(null)).toBeNull();
    expect(chanceWords(0.004)).toBe("under 1%");
    expect(chanceWords(0.02)).toBe("2%");
    expect(nearbyLine({ key: "k", name: "Osney", distanceM: 10, prob3d: 0.5 })).toBe("FloodClock now: 50% chance at Osney in the next 3 days");
  });
});

describe("SandbagCard", () => {
  it("shows the estimate and updates it when a door is added", () => {
    render(<SandbagCard band="high" />);
    const before = estimateSandbags("high").total;
    expect(screen.getByTestId("bag-total").textContent).toBe(String(before));
    fireEvent.click(screen.getByLabelText("More doors"));
    const after = estimateSandbags("high", { doors: 3, doorWidthM: 0.9, basement: false, floorLevel: "street" }).total;
    expect(screen.getByTestId("bag-total").textContent).toBe(String(after));
    expect(after).toBeGreaterThan(before);
    expect(screen.getByText("Estimate")).toBeTruthy();
    expect(screen.getByRole("link", { name: /gov.uk flood guidance/ }).getAttribute("href")).toContain("gov.uk");
  });

  it("renders the worked example without markdown", () => {
    const { container } = render(<StepText text="5. 2 doors = **40 sandbags**." />);
    expect(container.textContent).toBe("2 doors = 40 sandbags.");
    expect(container.querySelector("strong")?.textContent).toBe("40 sandbags");
  });
});

describe("map helpers", () => {
  it("drops a pin on the map and on zones, not on the map's own click targets", () => {
    const zone = document.createElementNS("http://www.w3.org/2000/svg", "path");
    zone.setAttribute("class", "leaflet-interactive fc-x-zone");
    const link = document.createElementNS("http://www.w3.org/2000/svg", "path");
    link.setAttribute("class", "leaflet-interactive");
    const marker = document.createElement("div");
    marker.className = "leaflet-marker-icon";
    const inner = document.createElement("span");
    marker.appendChild(inner);
    expect(dropsPin(document.createElement("div"))).toBe(true);
    expect(dropsPin(zone)).toBe(true);
    expect(dropsPin(link)).toBe(false);
    expect(dropsPin(inner)).toBe(false);
    // The zones canvas (its own pane): Leaflet marks it interactive while a zone is under the pointer.
    const pane = document.createElement("div");
    pane.className = "leaflet-pane leaflet-fc-zones-pane";
    const canvas = document.createElement("canvas");
    canvas.className = "leaflet-zoom-animated leaflet-interactive";
    pane.appendChild(canvas);
    expect(dropsPin(canvas)).toBe(true);
  });

  it("projects zone vertices to the same pixels as Leaflet", () => {
    for (const [lat, lng] of [[51.752, -1.258], [51.70631, -1.39789], [51.9, -1.0], [-33.9, 151.2], [89, 179.9]]) {
      for (const z of [10, 12.25, 13, 14.75, 16]) {
        const [u, v] = mercatorUnit(lat, lng);
        const s = L.CRS.EPSG3857.scale(z);
        const want = L.CRS.EPSG3857.latLngToPoint(L.latLng(lat, lng), z).round();
        expect([Math.round(s * u), Math.round(s * v)]).toEqual([want.x, want.y]);
      }
    }
  });

  it("labels and styles the zones, stronger on hover", () => {
    expect(zoneLabel("high")).toBe("High risk zone");
    expect(zoneLabel("nonsense")).toBe("Flood zone");
    expect(zoneStyle("medium").fillOpacity).toBeCloseTo(0.35);
    expect(zoneStyle("medium", true).fillOpacity!).toBeGreaterThan(0.35);
    expect(zoneStyle("medium", true).weight!).toBeGreaterThan(zoneStyle("medium").weight!);
  });

  it("splits each band's MultiPolygon into one zone per part, so hover highlights one zone", () => {
    const sq = (x: number) => [[[x, 0], [x + 1, 0], [x + 1, 1], [x, 0]]];
    const out = explodeZones({
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: { band: "high" }, geometry: { type: "MultiPolygon", coordinates: [sq(0), sq(2), sq(4)] } },
        { type: "Feature", properties: { band: "low" }, geometry: { type: "Polygon", coordinates: sq(6) } },
        { type: "Feature", properties: { band: "low" }, geometry: { type: "Point", coordinates: [0, 0] } },
      ],
    });
    expect(out.features).toHaveLength(4);
    expect(out.features.map((f) => f.properties?.band)).toEqual(["high", "high", "high", "low"]);
    expect(out.features.every((f) => f.geometry.type === "Polygon")).toBe(true);
  });

  it("counts up with an ease-out and lands on the target", () => {
    expect(countAt(0, 40, 0)).toBe(0);
    expect(countAt(0, 40, 0.5)).toBeGreaterThan(20);
    expect(countAt(0, 40, 1)).toBe(40);
    expect(countAt(0, 40, 2)).toBe(40);
  });
});
