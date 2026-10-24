// MapClock (#118): a SpotClock pinned to a map position, for <BaseMap>
// children. Now and Replay use the same component, so the clocks on both
// screens look and behave the same. Import directly ("../ui/MapClock"):
// like BaseMap it needs Leaflet, which needs `window`.
import { CircleMarker, Tooltip } from "react-leaflet";
import { SpotClock, type ClockState } from "./SpotClock";

export function MapClock({
  lat,
  lon,
  label,
  prob,
  countdownH,
  state,
  size = "sm",
  selected = false,
  onClick,
  direction = "center",
}: {
  lat: number;
  lon: number;
  label: string;
  prob: number | null;
  countdownH: number | null;
  state: ClockState;
  size?: "sm" | "md" | "lg";
  selected?: boolean;
  onClick?: () => void;
  /** Where the clock sits relative to the point (default centred on it). */
  direction?: "center" | "top" | "bottom" | "left" | "right";
}) {
  return (
    <CircleMarker
      center={[lat, lon]}
      radius={3}
      pathOptions={{ color: "#0b0b0b", weight: 1, fillColor: "#0b0b0b", fillOpacity: 1 }}
      interactive={false}
    >
      <Tooltip
        permanent
        interactive
        direction={direction}
        opacity={1}
        className={`ui-map-clock${selected ? " selected" : ""}`}
      >
        <SpotClock label={label} prob={prob} countdownH={countdownH} state={state} size={size} selected={selected} onClick={onClick} />
      </Tooltip>
    </CircleMarker>
  );
}
