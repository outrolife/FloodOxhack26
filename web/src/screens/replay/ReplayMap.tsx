// Replay map (#120): the offline Oxford basemap with each trouble spot's clock
// filling as the wave arrives, read from the forecast at the playhead with the
// kit's clockFor, and drawn with the kit's MapClocks so Now and Replay place
// clocks by the same rule (ui/placement.ts). Clicking a forecast spot's clock
// selects it.
import { useMemo } from "react";
import type { Forecast, Spot } from "../../contracts";
import { BaseMap } from "../../ui/BaseMap";
import { MapClocks } from "../../ui/MapClocks";
import { clocksFor } from "../../ui/clockData";

export function ReplayMap({
  spots,
  forecast,
  selected,
  onSelect,
}: {
  spots: Spot[];
  forecast: Forecast | undefined;
  selected: string;
  onSelect: (key: string) => void;
}) {
  // Fit the spots, not all of Oxford, so the clocks have room.
  const bounds = useMemo<[[number, number], [number, number]]>(() => {
    const lats = spots.map((s) => s.lat);
    const lons = spots.map((s) => s.lon);
    return [
      [Math.min(...lats) - 0.008, Math.min(...lons) - 0.02],
      [Math.max(...lats) + 0.008, Math.max(...lons) + 0.02],
    ];
  }, [spots]);
  const mode = new Map(spots.map((s) => [s.key, s.mode]));

  return (
    <BaseMap bounds={bounds} className="rp-map">
      <MapClocks
        clocks={clocksFor(forecast ?? null, spots).map((c) => ({
          ...c,
          size: c.key === selected ? "md" : "sm",
          selected: c.key === selected,
          onClick: mode.get(c.key) === "probability" ? () => onSelect(c.key) : undefined,
        }))}
      />
    </BaseMap>
  );
}
