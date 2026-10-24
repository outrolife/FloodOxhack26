// Map layout helpers for SpotMap (#103), kept free of Leaflet so they can be tested in node.
import type { Spot } from "../../contracts";

/** Room around the spots when the map fits them (px), so edge markers and their labels stay in view. */
export const FIT_PADDING: [number, number] = [48, 48];

/** Short on-map label: the first part of the spot name ("Botley Road / New Botley / Hinksey" → "Botley Road"). */
export const shortSpotName = (name: string): string => name.split(" / ")[0].trim();

/**
 * Which side each always-on label sits: Botley sits just west of Osney, so
 * its label goes left; Cherwell is the easternmost spot, so its label goes
 * left to stay inside the map. Everything else goes right.
 */
const LABEL_SIDE: Record<string, "left" | "right"> = { botley: "left", cherwell: "left" };
export const labelSide = (key: string): "left" | "right" => LABEL_SIDE[key] ?? "right";

/** [[south, west], [north, east]] around every spot, or null if there are none. */
export function spotBounds(spots: Pick<Spot, "lat" | "lon">[]): [[number, number], [number, number]] | null {
  if (spots.length === 0) return null;
  const lats = spots.map((s) => s.lat);
  const lons = spots.map((s) => s.lon);
  return [
    [Math.min(...lats), Math.min(...lons)],
    [Math.max(...lats), Math.max(...lons)],
  ];
}
