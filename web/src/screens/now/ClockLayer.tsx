// The five spot clocks on the Now map, each pinned to its real coordinates
// (spots.json). Drawn with the kit's MapClocks, so Now and Replay place
// clocks by the same rule (ui/placement.ts): nudged apart with a leader line
// when they would overlap.
import type { Spot } from "../../contracts";
import { MapClocks, type MapClockItem } from "../../ui/MapClocks";
import { kitState, type SpotClockInfo } from "./logic";

export function ClockLayer({
  spots,
  clocks,
  selected,
  onSelect,
}: {
  spots: Spot[];
  clocks: SpotClockInfo[];
  selected: string | null;
  onSelect: (key: string) => void;
}) {
  const items: MapClockItem[] = [];
  for (const s of spots) {
    const c = clocks.find((x) => x.spot === s.key);
    if (!c) continue;
    items.push({
      key: s.key,
      lat: s.lat,
      lon: s.lon,
      label: c.name,
      prob: c.p,
      countdownH: c.countdownH,
      state: kitState(c),
      size: "md",
      selected: selected === s.key,
      onClick: () => onSelect(s.key),
      // The kit shows the countdown when there is one; otherwise say "—" or why there is no forecast.
      note:
        c.kind !== "forecast" || c.countdownH == null
          ? c.kind === "forecast"
            ? `likely flood time: ${c.countdown}`
            : c.status
          : undefined,
    });
  }
  return <MapClocks clocks={items} />;
}
