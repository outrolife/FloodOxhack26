// S3 (SPEC §11): flood-spread overlay. Frame choice never leaks the future,
// the toggle disappears without a manifest, and the limitations text is shown.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SpreadManifest } from "../../contracts";
import fixture from "../../../../tests/fixtures/stretch/spread/e2014/manifest.json";
import {
  NO_SPREAD_NOTE,
  SPREAD_LIMITATIONS,
  type SpreadFrame,
  frameUrl,
  SPREAD_RAMP,
  iouSentence,
  legendGradient,
  legendPos,
  pickFrame,
  usableManifest,
} from "./frames";
import { SpreadPanel, TOGGLE_LABEL, noSpread } from "./SpreadPanel";

const manifest = fixture as SpreadManifest;
const f = (tau: number, issuedAt: string): SpreadFrame => ({ tau, issuedAt, png: `spread/x/${issuedAt}-${tau}.png` });

describe("pickFrame", () => {
  const frames = [6, 12, 24, 36, 48, 72].map((h) => f(h, "2014-01-07T00:00:00Z"));

  it("picks the exact lead when it exists", () => {
    const p = pickFrame(frames, 36);
    expect(p.kind === "frame" && p.frame.tau).toBe(36);
  });

  it("picks the nearest lead otherwise, ties to the shorter one", () => {
    const p1 = pickFrame(frames, 60);
    expect(p1.kind === "frame" && p1.frame.tau).toBe(48); // 12 h from 48 and from 72: shorter wins
    const p2 = pickFrame(frames, 65);
    expect(p2.kind === "frame" && p2.frame.tau).toBe(72);
    const p3 = pickFrame([f(24, "2014-01-07T00:00:00Z")], 6);
    expect(p3.kind === "frame" && p3.frame.tau).toBe(24);
  });

  it("never picks a frame issued after the slider time", () => {
    const multi = [
      f(24, "2014-01-06T00:00:00Z"),
      f(24, "2014-01-07T00:00:00Z"),
      f(24, "2014-01-08T00:00:00Z"),
      f(6, "2014-01-07T12:00:00Z"),
    ];
    const at = "2014-01-07T18:00:00Z";
    const p = pickFrame(multi, 24, at);
    expect(p.kind).toBe("frame");
    if (p.kind !== "frame") return;
    // Latest issue at or before the slider (07 12:00, its only lead), not 08 00:00.
    expect(p.frame.issuedAt).toBe("2014-01-07T12:00:00Z");
    expect(Date.parse(p.frame.issuedAt)).toBeLessThanOrEqual(Date.parse(at));
    // Exactly at an issue time counts.
    const q = pickFrame(multi, 24, "2014-01-08T00:00:00Z");
    expect(q.kind === "frame" && q.frame.issuedAt).toBe("2014-01-08T00:00:00Z");
  });

  it("shows nothing before the first issue time", () => {
    const p = pickFrame(frames, 24, "2014-01-06T23:59:00Z");
    expect(p).toEqual({ kind: "notYet", firstIssuedAt: "2014-01-07T00:00:00Z" });
    expect(pickFrame([], 24).kind).toBe("none");
  });

  it("works on the fixture manifest", () => {
    const p = pickFrame(manifest.frames, 24, "2014-01-09T00:00:00Z");
    expect(p.kind === "frame" && p.frame.png).toBe("spread/e2014/tau24.png");
  });
});

describe("legend ramp", () => {
  it("uses exactly the PNG ramp stops (green to red), with 5% at the left end and 100% at the right", () => {
    expect(SPREAD_RAMP).toEqual([
      { at: 0.05, colour: "#1a9850" },
      { at: 0.3, colour: "#91cf60" },
      { at: 0.5, colour: "#fee08b" },
      { at: 0.75, colour: "#fc8d59" },
      { at: 1, colour: "#d73027" },
    ]);
    expect(legendPos(0.05)).toBe(0);
    expect(legendPos(1)).toBe(100);
    expect(legendPos(0.5)).toBeCloseTo(47.37, 1);
    expect(legendGradient()).toBe(
      "linear-gradient(to right, #1a9850 0.0%, #91cf60 26.3%, #fee08b 47.4%, #fc8d59 73.7%, #d73027 100.0%)",
    );
  });
});

describe("frameUrl", () => {
  it("resolves frames under /data/, bare names relative to the manifest's folder", () => {
    expect(frameUrl("spread/live/tau24.png", "live")).toMatch(/data\/spread\/live\/tau24\.png$/);
    expect(frameUrl("tau24.png", "live")).toMatch(/data\/spread\/live\/tau24\.png$/);
  });
});

const panel = (m: SpreadManifest | null, on: boolean, hideWhenMissing = false) =>
  renderToStaticMarkup(
    <SpreadPanel
      manifest={m}
      on={on}
      onToggle={() => {}}
      tau={24}
      onTau={() => {}}
      pick={m ? pickFrame(m.frames, 24, "2014-01-09T00:00:00Z") : { kind: "none" }}
      at="2014-01-09T00:00:00Z"
      hideWhenMissing={hideWhenMissing}
    />,
  );

describe("SpreadPanel", () => {
  it("is hidden on the River map when there is no manifest", () => {
    expect(panel(null, false, true)).toBe("");
  });

  it("is a disabled toggle with a note in the Time Machine when there is no manifest", () => {
    const html = panel(null, false);
    expect(html).toContain(TOGGLE_LABEL);
    expect(html).toContain("disabled");
    expect(html).toContain(NO_SPREAD_NOTE);
  });

  it("is off by default: just the toggle, no caveats or legend", () => {
    const html = panel(manifest, false);
    expect(html).toContain(TOGGLE_LABEL);
    expect(html).not.toContain("Experimental</span>");
    expect(html).not.toContain("IoU");
  });

  it("shows the badge, SPEC limitations verbatim, legend and IoU when on", () => {
    const html = panel(manifest, true);
    expect(html).toContain(">Experimental</span>");
    expect(html).toContain(
      "Experimental. A simple terrain fill: ignores channel flow, walls, drains, pumps and defences. Ensemble frequency, not a verified flood probability.",
    );
    expect(html).toContain(SPREAD_LIMITATIONS);
    expect(html).toContain("Matches the recorded Jan 2014 outline: IoU 0.62");
    expect(html).toContain("Share of 200 simulated floods that wet this square");
    expect(html).toContain("+24 h");
  });

  it("draws the legend as one green-to-red gradient bar ticked at 5, 25, 50, 75 and 100%", () => {
    const html = panel(manifest, true);
    expect(html).toContain(`background:${legendGradient()}`);
    for (const t of ["5%", "25%", "50%", "75%", "100%"]) expect(html).toContain(`>${t}</span>`);
    expect(html).not.toContain("75–100%"); // the old 4-class legend is gone
  });

  it("says no spread is expected when the run's largest extent is 0 ha", () => {
    const extent = (ha: number) => `Largest extent wet in at least half the runs, over these frames: ${ha} ha of the 250 ha box.`;
    const live = { ...manifest, validation: null, caveats: [...manifest.caveats, extent(0)] };
    expect(noSpread(live)).toBe(true);
    expect(noSpread({ ...live, caveats: [extent(145)] })).toBe(false);
    expect(noSpread(manifest)).toBe(false);
    const html = renderToStaticMarkup(
      <SpreadPanel manifest={live} on onToggle={() => {}} tau={24} onTau={() => {}} pick={pickFrame(live.frames, 24)} />,
    );
    expect(html).toContain("No spread expected at today&#x27;s levels");
    expect(html).toContain("About this run");
  });

  it("formats the IoU sentence", () => {
    expect(iouSentence({ eventId: "e2014", iou: 0.5 })).toBe("Matches the recorded Jan 2014 outline: IoU 0.50");
    expect(iouSentence(null)).toBeNull();
  });
});

describe("manifest loading", () => {
  const freshLoadData = async () => {
    vi.resetModules();
    return (await import("../../data")).loadData;
  };
  afterEach(() => vi.unstubAllGlobals());

  it("has no live manifest without real data, so the River toggle stays hidden", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));
    await expect((await freshLoadData())("spread/live/manifest.json")).rejects.toThrow();
  });

  it("never draws the e2014 fixture placeholder: only a real run is usable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));
    const r = await (await freshLoadData())("spread/e2014/manifest.json");
    expect(r.source).toBe("fixture");
    expect(usableManifest({ status: "ready", data: r.value, source: r.source })).toBeNull();
    expect(usableManifest({ status: "ready", data: manifest, source: "data" })).toBe(manifest);
    expect(usableManifest({ status: "error" })).toBeNull();
  });
});
