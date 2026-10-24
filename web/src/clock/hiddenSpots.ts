// Spots left off the map because they have no data for the current view
// (map v3, #152). The map publishes them here; "Show the working" lists them,
// so the map only carries spots that say something.
import { useSyncExternalStore } from "react";
import type { HiddenSpot } from "./flowgl";

let current: HiddenSpot[] = [];
const listeners = new Set<() => void>();

export function setHiddenSpots(next: HiddenSpot[]): void {
  const same = next.length === current.length && next.every((h, i) => h.key === current[i].key && h.why === current[i].why);
  if (same) return;
  current = next;
  for (const l of listeners) l();
}

export const getHiddenSpots = (): HiddenSpot[] => current;

export function useHiddenSpots(): HiddenSpot[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getHiddenSpots,
    getHiddenSpots,
  );
}
