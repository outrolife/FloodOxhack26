// Replay map (#120): the offline Oxford basemap with each trouble spot's clock
// filling as the wave arrives, read from the forecast at the playhead with the
// kit's clockFor, and drawn with the kit's MapClock so Now and Replay match.
// The spots sit a few hundred metres apart, so each clock sits to one side of
// its spot. Clicking a forecast spot's clock selects it.
import { useMemo } from "react";
import type { Forecast, Spot } from "../../contracts";
import { BaseMap } from "../../ui/BaseMap";
import { MapClock } from "../../ui/MapClock";
import { clocksFor } from "../../ui/clockData";

/** Which side of its spot each clock sits on, so neighbours don't overlap. */
const SIDE: Record<string, "top" | "bottom" | "left" | "right"> = {
  wolvercote: "top",
  botley: "left",
  osney: "bottom",
  abingdonrd: "right",
  cherwell: "top",
};

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
      {clocksFor(forecast ?? null, spots).map((c) => {
        const isSel = c.key === selected;
        return (
          <MapClock
            key={c.key}
            lat={c.lat}
            lon={c.lon}
            label={c.label}
            prob={c.prob}
            countdownH={c.countdownH}
            state={c.state}
            size={isSel ? "md" : "sm"}
            selected={isSel}
            direction={SIDE[c.key] ?? "top"}
            onClick={mode.get(c.key) === "probability" ? () => onSelect(c.key) : undefined}
          />
        );
      })}
    </BaseMap>
  );
}
