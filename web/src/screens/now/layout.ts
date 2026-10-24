// Keep the spot clocks on the map from covering each other. Osney and Botley
// Road are about 400 m apart, so at city zoom their clocks would overlap. Each
// clock is a box centred on its spot; overlapping boxes are pushed apart along
// the axis that needs the smaller move, a few rounds, and the clock is drawn at
// the nudged place with a leader line back to the true spot. Pure, so tested.

export type Pt = { x: number; y: number };

/** Offsets (px) that move boxes of size w × h, centred on pts, so none overlap. */
export function spreadApart(pts: Pt[], w: number, h: number, rounds = 80): Pt[] {
  const pos = pts.map((p) => ({ ...p }));
  for (let r = 0; r < rounds; r++) {
    let moved = false;
    for (let i = 0; i < pos.length; i++) {
      for (let j = i + 1; j < pos.length; j++) {
        const dx = pos[j].x - pos[i].x;
        const dy = pos[j].y - pos[i].y;
        const ox = w - Math.abs(dx); // overlap in x
        const oy = h - Math.abs(dy); // overlap in y
        if (ox <= 0.5 || oy <= 0.5) continue;
        moved = true;
        // Same point: split sideways, by index, so the result is deterministic.
        const sx = dx === 0 ? (i < j ? 1 : -1) : Math.sign(dx);
        const sy = dy === 0 ? 1 : Math.sign(dy);
        if (ox <= oy) {
          pos[i].x -= (sx * ox) / 2;
          pos[j].x += (sx * ox) / 2;
        } else {
          pos[i].y -= (sy * oy) / 2;
          pos[j].y += (sy * oy) / 2;
        }
      }
    }
    if (!moved) break;
  }
  return pos.map((p, k) => ({ x: p.x - pts[k].x, y: p.y - pts[k].y }));
}
