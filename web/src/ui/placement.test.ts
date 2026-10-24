// The one clock-placement rule shared by Now and Replay (#118).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Spot } from "../contracts";
import { CLOCK_BOX, needsLeader, spreadApart, type Box, type Pt } from "./placement";

const overlaps = (a: Pt, b: Pt, A: Box, B: Box) =>
  Math.abs(a.x - b.x) < (A.w + B.w) / 2 - 1 && Math.abs(a.y - b.y) < (A.h + B.h) / 2 - 1;

const noOverlap = (pts: Pt[], off: Pt[], boxes: Box[]) => {
  const moved = pts.map((p, i) => ({ x: p.x + off[i].x, y: p.y + off[i].y }));
  for (let i = 0; i < moved.length; i++)
    for (let j = i + 1; j < moved.length; j++) expect(overlaps(moved[i], moved[j], boxes[i], boxes[j])).toBe(false);
  return moved;
};

describe("spreadApart (clocks never cover each other)", () => {
  it("leaves far-apart clocks where they are", () => {
    expect(spreadApart([{ x: 0, y: 0 }, { x: 500, y: 0 }], { w: 140, h: 170 })).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ]);
  });

  it("separates close clocks, including identical points", () => {
    const pts = [
      { x: 100, y: 100 },
      { x: 130, y: 110 },
      { x: 100, y: 100 },
      { x: 400, y: 300 },
    ];
    const box = { w: 140, h: 170 };
    noOverlap(pts, spreadApart(pts, box), pts.map(() => box));
  });

  it("handles mixed sizes (Replay: the selected clock is bigger)", () => {
    const pts = [
      { x: 200, y: 200 },
      { x: 215, y: 205 },
    ];
    const boxes = [CLOCK_BOX.md, CLOCK_BOX.sm];
    noOverlap(pts, spreadApart(pts, boxes), boxes);
  });

  it("keeps clocks inside the map when their spot is on it, even in a corner", () => {
    const frame = { w: 500, h: 420 };
    const pts = [
      { x: 10, y: 10 },
      { x: 20, y: 15 },
    ];
    const boxes = [CLOCK_BOX.sm, CLOCK_BOX.sm];
    const moved = noOverlap(pts, spreadApart(pts, boxes, frame), boxes);
    for (const [i, p] of moved.entries()) {
      expect(p.x - boxes[i].w / 2).toBeGreaterThanOrEqual(-0.01);
      expect(p.y - boxes[i].h / 2).toBeGreaterThanOrEqual(-0.01);
      expect(p.x + boxes[i].w / 2).toBeLessThanOrEqual(frame.w + 0.01);
      expect(p.y + boxes[i].h / 2).toBeLessThanOrEqual(frame.h + 0.01);
    }
  });

  it("separates the real five spots at city zoom (Osney and Botley are ~400 m apart)", () => {
    const spots = JSON.parse(readFileSync(new URL("../../public/data/spots.json", import.meta.url), "utf8")) as Spot[];
    // Web Mercator pixels at zoom 14, the city view.
    const scale = 256 * 2 ** 14;
    const px = (s: Spot) => ({
      x: ((s.lon + 180) / 360) * scale,
      y: ((1 - Math.log(Math.tan((s.lat * Math.PI) / 180) + 1 / Math.cos((s.lat * Math.PI) / 180)) / Math.PI) / 2) * scale,
    });
    const pts = spots.map(px);
    const boxes = spots.map(() => CLOCK_BOX.md);
    const off = spreadApart(pts, boxes);
    noOverlap(pts, off, boxes);
    expect(off.some(needsLeader)).toBe(true);
  });
});
