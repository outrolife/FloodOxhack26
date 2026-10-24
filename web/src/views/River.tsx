// River (live): map of the five spots, spot panel, and the river strip.
import { useState } from "react";
import type { SpotsFile, StationsFile, TravelTimesFile } from "../contracts";
import { useData } from "../data";
import { formatDateTime } from "../time";
import { SpotMap } from "../components/river/SpotMap";
import { SpotPanel } from "../components/river/SpotPanel";
import { FixtureNotice, Pending } from "../components/shared/DataNotice";
import { RiverStrip } from "../components/shared/RiverStrip";
import { useLive } from "../components/shared/useLive";

export default function River() {
  const stations = useData<StationsFile>("stations.json");
  const spots = useData<SpotsFile>("spots.json");
  const travel = useData<TravelTimesFile>("travel_times.json");
  const live = useLive();
  // Default to Botley (newbotley is the primary target, SPEC §4.1.1).
  const [selected, setSelected] = useState<string | null>("botley");

  if (stations.status !== "ready" || spots.status !== "ready" || travel.status !== "ready") {
    return <Pending states={[stations, spots, travel]} />;
  }

  const forecast = live.status === "ready" ? live.forecast : null;
  const spot = spots.data.find((s) => s.key === selected) ?? spots.data[0];
  const levelNow: Record<string, number> = {};
  for (const sf of forecast?.spots ?? []) {
    const g = spots.data.find((s) => s.key === sf.spot)?.gauge;
    if (g) levelNow[g] = sf.levelNow;
  }

  return (
    <>
      {live.status === "ready" && live.origin !== "api" && (
        <div className="notice warn">
          <strong>Live data unavailable.</strong> Showing the last saved forecast, issued{" "}
          {formatDateTime(live.forecast.issuedAt)}
          {live.origin === "fixture" && " (sample data)"}.
        </div>
      )}
      {live.status === "none" && (
        <div className="notice warn">
          <strong>Live data unavailable.</strong> No saved forecast either.
        </div>
      )}
      <FixtureNotice sources={[stations.source, spots.source, travel.source]} />

      <div className="grid-2">
        <section>
          <SpotMap
            spots={spots.data}
            stations={stations.data}
            forecast={forecast}
            selected={spot?.key ?? null}
            onSelect={setSelected}
          />
        </section>
        <aside>
          {spot && (
            <SpotPanel
              spot={spot}
              station={stations.data.find((s) => s.key === spot.gauge)}
              forecast={forecast}
              history={undefined}
            />
          )}
        </aside>
      </div>

      <section className="card">
        <h2>The water is already on its way</h2>
        <p className="sub">
          Upstream gauges feed Oxford. Each link shows the median time for a flood rise to travel
          downstream (T½, from past floods). Levels are on each gauge's own datum.
        </p>
        <RiverStrip stations={stations.data} pairs={travel.data} levelNow={levelNow} />
      </section>
    </>
  );
}
