// #118: the visual kit's contract (screen agents build on these).
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Headline, Screen, ShowTheWorking, SpotClock, StatTile, countdownText, stateFor } from ".";
import { keyAction, viewFromHash } from "./presenter";

describe("SpotClock", () => {
  it("maps a chance to a state", () => {
    expect(stateFor(null)).toBe("noforecast");
    expect(stateFor(0.001)).toBe("calm");
    expect(stateFor(0.1)).toBe("watch");
    expect(stateFor(0.5)).toBe("likely");
  });
  it("writes countdowns", () => {
    expect(countdownText(null)).toBeNull();
    expect(countdownText(0.2)).toBe("now");
    expect(countdownText(31.4)).toBe("≈ 31 h");
    expect(countdownText(54)).toBe("≈ 2 days 6 h");
    expect(countdownText(72)).toBe("≈ 3 days");
  });
  it("says its state in words and shape, not colour alone", () => {
    const html = renderToStaticMarkup(<SpotClock label="Botley Road" prob={0.32} countdownH={31} state="watch" />);
    expect(html).toContain('aria-label="Botley Road: Possible, 32% chance of flooding, ≈ 31 h"');
    expect(html).toContain("▲");
    expect(html).toContain("32%");
    const off = renderToStaticMarkup(<SpotClock label="Cherwell" prob={null} countdownH={null} state="stale" onClick={() => {}} />);
    expect(off).toContain("Gauge offline");
    expect(off).toContain('role="button"');
    expect(renderToStaticMarkup(<SpotClock label="Osney" prob={0} countdownH={null} state="calm" />)).toContain("under 1%");
  });
});

describe("Screen and friends", () => {
  it("renders headline, stats, hero, aside and folds the working", () => {
    const html = renderToStaticMarkup(
      <Screen
        headline={<Headline>Right now: calm.</Headline>}
        stats={<StatTile value="39%" label="less error" tone="model" />}
        hero={<div>HERO</div>}
        aside={<div>ASIDE</div>}
        working={<p>DETAIL</p>}
      />,
    );
    expect(html).toContain("Right now: calm.");
    expect(html).toContain("ui-stat-model");
    expect(html).toContain("HERO");
    expect(html).toContain("has-aside");
    expect(html).toMatch(/<details class="ui-working"><summary>Show the working<\/summary>.*DETAIL/);
  });
  it("ShowTheWorking is collapsed by default", () => {
    expect(renderToStaticMarkup(<ShowTheWorking>x</ShowTheWorking>)).not.toContain("open");
  });
});

describe("presenter", () => {
  it("reads the hash: an event, the drawer, and old screen hashes", () => {
    expect(viewFromHash("")).toEqual({ event: null, working: null });
    expect(viewFromHash("#/now")).toEqual({ event: "now", working: null });
    expect(viewFromHash("#/e2014")).toEqual({ event: "e2014", working: null });
    expect(viewFromHash("#/working/proof")).toEqual({ event: null, working: "proof" });
    expect(viewFromHash("#/working")).toEqual({ event: null, working: "" });
    expect(viewFromHash("#/replay")).toEqual({ event: "e2014", working: null });
    expect(viewFromHash("#/protect")).toEqual({ event: null, working: "protect" });
  });
  it("maps keys to actions", () => {
    expect(keyAction("2", false, false)).toEqual({ kind: "pick", n: 2 });
    expect(keyAction("5", false, false)).toEqual({ kind: "pick", n: 5 });
    expect(keyAction("p", false, false)).toEqual({ kind: "presenter" });
    expect(keyAction(" ", false, false)).toEqual({ kind: "playpause" });
    expect(keyAction("ArrowRight", true, false)).toEqual({ kind: "step", delta: 6 });
    expect(keyAction("ArrowLeft", false, false)).toEqual({ kind: "step", delta: -1 });
    // With the drawer open the old Time Machine keeps its own keys; P still works.
    expect(keyAction(" ", false, true)).toBeNull();
    expect(keyAction("1", false, true)).toBeNull();
    expect(keyAction("P", false, true)).toEqual({ kind: "presenter" });
  });
});
