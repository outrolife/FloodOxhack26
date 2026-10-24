// #103: the three-step "Start here" path and the tab headline wrapper.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { START_STEPS, StartHere } from "./StartHere";
import { TabHeadline } from "./TabHeadline";

describe("Start here", () => {
  it("offers the three steps in order, with a way to hide it", () => {
    expect(START_STEPS.map((s) => s.tab)).toEqual(["river", "time-machine", "decide"]);
    const html = renderToStaticMarkup(<StartHere current="river" onHide={() => {}} />);
    expect(html).toContain("The water travels");
    expect(html).toContain("Replay 2014");
    expect(html).toContain("Would it have helped you?");
    expect(html).toContain('aria-current="step"');
    expect(html).toContain("Hide");
  });
});

describe("TabHeadline", () => {
  it("renders the headline and detail, or nothing", () => {
    expect(renderToStaticMarkup(<TabHeadline h={null} />)).toBe("");
    const html = renderToStaticMarkup(<TabHeadline h={{ headline: "Right now: calm.", detail: "Details." }} />);
    expect(html).toContain('<p class="tab-headline-main">Right now: calm.</p>');
    expect(html).toContain("Details.");
  });
});
