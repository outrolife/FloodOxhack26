// #118: the visual kit's contract (screen agents build on these).
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Headline, Screen, ShowTheWorking, SpotClock, StatTile, countdownText, stateFor } from ".";
import { keyAction, routeFromHash } from "./presenter";
import { START_BUTTONS, START_TRUST, StartHere } from "./StartHere";
import { KeyHint } from "./KeyHint";

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
  it("routes, including old tab hashes", () => {
    expect(routeFromHash("#/replay")).toBe("replay");
    expect(routeFromHash("#/working/proof")).toBe("working");
    expect(routeFromHash("#time-machine")).toBe("replay");
    expect(routeFromHash("")).toBe("now");
  });
  it("maps keys to actions", () => {
    expect(keyAction("2", false, "now")).toEqual({ kind: "route", route: "replay" });
    expect(keyAction("p", false, "now")).toEqual({ kind: "presenter" });
    expect(keyAction(" ", false, "replay")).toEqual({ kind: "playpause" });
    expect(keyAction("ArrowRight", true, "replay")).toEqual({ kind: "step", delta: 6 });
    expect(keyAction("ArrowLeft", false, "replay")).toEqual({ kind: "step", delta: -1 });
    // The old Time Machine under Show the working keeps its own keys.
    expect(keyAction(" ", false, "working")).toBeNull();
  });
  it("Start here offers Now, Replay and Protect", () => {
    expect(START_BUTTONS.map((b) => b.route)).toEqual(["now", "replay", "protect"]);
  });
  it("Start here has a small fourth link to How good is it?, keyed 4", () => {
    expect(START_TRUST.route).toBe("trust");
    const html = renderToStaticMarkup(<StartHere onDone={() => {}} />);
    expect((html.match(/class="ui-start-button"/g) ?? []).length).toBe(3);
    expect(html).toContain('class="ui-start-trust"');
    expect(html).toContain('aria-keyshortcuts="4"');
    expect(html).toContain("How good is it?");
  });
  it("KeyHint names each key once, in the shared style", () => {
    const html = renderToStaticMarkup(<KeyHint keys={[["Space", "play"], ["← →", "one step"]]} />);
    expect(html).toContain('<p class="ui-keyhint">');
    expect((html.match(/<kbd class="ui-key">/g) ?? []).length).toBe(2);
  });
});
