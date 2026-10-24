import { describe, expect, it } from "vitest";
import { spreadApart } from "./layout";

const overlaps = (a: { x: number; y: number }, b: { x: number; y: number }, w: number, h: number) =>
  Math.abs(a.x - b.x) < w - 1 && Math.abs(a.y - b.y) < h - 1;

describe("spreadApart (clocks never cover each other)", () => {
  it("leaves far-apart clocks where they are", () => {
    expect(spreadApart([{ x: 0, y: 0 }, { x: 500, y: 0 }], 140, 170)).toEqual([{ x: 0, y: 0 }, { x: 0, y: 0 }]);
  });

  it("separates close clocks, including identical points", () => {
    const pts = [
      { x: 100, y: 100 },
      { x: 130, y: 110 },
      { x: 100, y: 100 },
      { x: 400, y: 300 },
    ];
    const off = spreadApart(pts, 140, 170);
    const moved = pts.map((p, i) => ({ x: p.x + off[i].x, y: p.y + off[i].y }));
    for (let i = 0; i < moved.length; i++)
      for (let j = i + 1; j < moved.length; j++) expect(overlaps(moved[i], moved[j], 140, 170)).toBe(false);
  });
});
