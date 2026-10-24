// Where each spot clock sits on a map (#118): one rule for Now and Replay.
//
// Osney and Botley Road are about 400 m apart, so at city zoom their clocks
// would cover each other. Each clock is a box centred on its spot. Boxes that
// overlap are pushed apart along the axis that needs the smaller move, a few
// rounds, then kept inside the map. The clock is drawn at the nudged place
// with a thin leader line back to a dot on the true spot. Pure, so tested.

export type Pt = { x: number; y: number };
export type Box = { w: number; h: number };

/** Footprint (px) of a SpotClock with its two text lines, by size, plus a small gap. */
export const CLOCK_BOX: Record<"sm" | "md" | "lg", Box> = {
  sm: { w: 112, h: 126 },
  md: { w: 150, h: 178 },
  lg: { w: 200, h: 236 },
};
/** Extra height for one short note line under a clock. */
export const NOTE_H = 18;

/** Offsets beyond this (px) are drawn with a leader line back to the spot. */
export const LEADER_MIN_PX = 4;

/**
 * Offsets (px) that move boxes centred on `pts` so that none overlap.
 * `boxes` is one size for all, or one per point. With `frame` (the map's size,
 * points in container pixels), boxes whose spot is inside the frame are also
 * kept inside it, so no clock is cut off at the edge.
 */
export function spreadApart(pts: Pt[], boxes: Box | Box[], frame?: Box, rounds = 80): Pt[] {
  const box = (i: number): Box => (Array.isArray(boxes) ? (boxes[i] ?? boxes[0]) : boxes);
  const pos = pts.map((p) => ({ ...p }));
  const inside = pts.map((p) => frame != null && p.x >= 0 && p.y >= 0 && p.x <= frame.w && p.y <= frame.h);
  const clamp = (i: number) => {
    if (!frame || !inside[i]) return;
    const { w, h } = box(i);
    if (frame.w > w) pos[i].x = Math.min(Math.max(pos[i].x, w / 2), frame.w - w / 2);
    if (frame.h > h) pos[i].y = Math.min(Math.max(pos[i].y, h / 2), frame.h - h / 2);
  };
  for (let i = 0; i < pos.length; i++) clamp(i);
  for (let r = 0; r < rounds; r++) {
    let moved = false;
    for (let i = 0; i < pos.length; i++) {
      for (let j = i + 1; j < pos.length; j++) {
        const dx = pos[j].x - pos[i].x;
        const dy = pos[j].y - pos[i].y;
        const ox = (box(i).w + box(j).w) / 2 - Math.abs(dx); // overlap in x
        const oy = (box(i).h + box(j).h) / 2 - Math.abs(dy); // overlap in y
        if (ox <= 0.5 || oy <= 0.5) continue;
        moved = true;
        // Same point: split sideways, by index, so the result is deterministic.
        const sx = dx === 0 ? 1 : Math.sign(dx);
        const sy = dy === 0 ? 1 : Math.sign(dy);
        const before = [{ ...pos[i] }, { ...pos[j] }];
        const push = (axis: "x" | "y") => {
          const o = axis === "x" ? ox : oy;
          const s = axis === "x" ? sx : sy;
          pos[i][axis] -= (s * o) / 2;
          pos[j][axis] += (s * o) / 2;
          clamp(i);
          clamp(j);
        };
        const still = (axis: "x" | "y") =>
          (axis === "x" ? (box(i).w + box(j).w) / 2 : (box(i).h + box(j).h) / 2) - Math.abs(pos[j][axis] - pos[i][axis]) > 0.5;
        const first = ox <= oy ? "x" : "y";
        push(first);
        // Against the edge of the map the cheap axis may be blocked: use the other one.
        if (still(first)) {
          pos[i] = before[0];
          pos[j] = before[1];
          push(first === "x" ? "y" : "x");
        }
      }
    }
    if (!moved) break;
  }
  return pos.map((p, k) => ({ x: p.x - pts[k].x, y: p.y - pts[k].y }));
}

/** True when an offset is big enough to need a leader line back to the spot. */
export const needsLeader = (o: Pt): boolean => Math.hypot(o.x, o.y) > LEADER_MIN_PX;
