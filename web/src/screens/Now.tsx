// Now screen (#119): "Where is the water, and when does it get here?"
// Full-screen Oxford map with the five spot clocks, the river strip with a
// travel-time pulse on the left, a spot card on click, ≤ 3 live stats, and the
// old River-tab detail under "Show the working". All data from live.json,
// spots.json, stations.json and travel_times.json at runtime (offline-safe).
import { Suspense, lazy, useEffect, useRef, useState } from "react";
import type { SpotsFile, StationsFile, TravelTimesFile } from "../contracts";
import { useData } from "../data";
import { Headline, Screen } from "../ui";
import { BaseMap } from "../ui/BaseMap";
import { useLive } from "../components/shared/useLive";
import { ClockLayer } from "./now/ClockLayer";
import { NowView } from "./now/NowView";

// The River tab's detail (spot panel, sparklines, S1 risk layers, S2 rain, S3/S4), loaded on demand.
const River = lazy(() => import("../views/River"));

/** Mount the River detail only once "Show the working" is opened, so its Leaflet map gets a real size. */
function WorkingRiver() {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const details = ref.current?.closest("details");
    if (!details) return setOpen(true);
    const on = () => details.open && setOpen(true);
    on();
    details.addEventListener("toggle", on);
    return () => details.removeEventListener("toggle", on);
  }, []);
  return (
    <div ref={ref}>
      {open && (
        <Suspense fallback={<p className="muted">Loading…</p>}>
          <River />
        </Suspense>
      )}
    </div>
  );
}

/** Wall-clock time, refreshed every minute so countdowns stay current. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

export default function Now() {
  const spots = useData<SpotsFile>("spots.json");
  const stations = useData<StationsFile>("stations.json");
  const travel = useData<TravelTimesFile>("travel_times.json");
  const live = useLive();
  const now = useNow();

  if (spots.status === "error" || stations.status === "error") {
    return <Screen headline={<Headline>Spot data unavailable.</Headline>} hero={<p className="ui-placeholder">{spots.status === "error" ? spots.error : stations.status === "error" ? stations.error : ""}</p>} />;
  }
  if (spots.status !== "ready" || stations.status !== "ready" || live.status === "loading") {
    return <Screen headline={<Headline>Reading the river…</Headline>} hero={<div className="ui-placeholder is-loading" aria-busy="true">Loading live data</div>} />;
  }
  const forecast = live.status === "ready" ? live.forecast : null;

  return (
    <NowView
      spots={spots.data}
      stations={stations.data}
      pairs={travel.status === "ready" ? travel.data : []}
      forecast={forecast}
      origin={live.status === "ready" ? live.origin : "none"}
      now={forecast ? Math.max(now, Date.parse(forecast.issuedAt)) : now}
      map={({ clocks, selected, onSelect }) => (
        <BaseMap>
          <ClockLayer spots={spots.data} clocks={clocks} selected={selected} onSelect={onSelect} />
        </BaseMap>
      )}
      working={<WorkingRiver />}
    />
  );
}
