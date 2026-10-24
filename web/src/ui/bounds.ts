/** Map bounds helpers with no Leaflet import (safe to use in node tests). */

export type Bounds = [[number, number], [number, number]];

/** Default view: the five trouble spots with some room around them. */
export const OXFORD_BOUNDS: Bounds = [
  [51.722, -1.305],
  [51.786, -1.232],
];

/**
 * Bounds Leaflet can fit: four finite numbers and a box with some extent.
 * Callers often derive bounds from data that hasn't loaded yet (Math.max of an
 * empty list is -Infinity), and Leaflet throws "Invalid LatLng (0, NaN)" on
 * such bounds, which used to unmount the whole app. Fall back to Oxford.
 */
export function safeBounds(b: Bounds | undefined): Bounds {
  if (!b) return OXFORD_BOUNDS;
  const flat = [b[0][0], b[0][1], b[1][0], b[1][1]];
  const ok = flat.every(Number.isFinite) && b[0][0] !== b[1][0] && b[0][1] !== b[1][1];
  return ok ? b : OXFORD_BOUNDS;
}

