// River (live): map of the five spots, spot panel, and the river strip.
import { useState } from "react";
import type { SpotsFile, StationsFile, TravelTimesFile } from "../contracts";
import { useData } from "../data";
import { formatDateTime } from "../time";
import { SpotMap } from "../components/river/SpotMap";
import { SpotPanel } from "../components/river/SpotPanel";
import { RiskLayers } from "../components/river/RiskLayers"; // S1 (SPEC §11); remove this and <RiskLayers /> to hide
import { EnsembleRainPanel } from "../components/river/EnsembleRain"; // S2 (SPEC §11); remove this and <EnsembleRainPanel /> to hide
import { SpreadOverlay } from "../components/spread/SpreadOverlay"; // S3 (SPEC §11); hide with SHOW_S3 in stretch.ts
import { FixtureNotice, Pending } from "../components/shared/DataNotice";
import { LOW_CONFIDENCE_N, RiverStrip } from "../components/shared/RiverStrip";
import { useLive } from "../components/shared/useLive";
import { liveObserved } from "../components/shared/observed";

/** A saved forecast older than this gets the warning style (#103, jargon audit R1). */
const OLD_FORECAST_H = 6;
const savedIsOld = (issuedAt: string): boolean => Date.now() - Date.parse(issuedAt) > OLD_FORECAST_H * 3_600_000;

export default function River() {
  const stations = useData<StationsFile>("stations.json");
  const spots = useData<SpotsFile>("spots.json");
  const travel = useData<TravelTimesFile>("travel_times.json");
  const live = useLive();
  // Default to Botley (newbotley is the primary target, SPEC §4.1.1).
  const [selected, setSelected] = useState<string | null>("botley");

  // Travel times are optional here: the map and spot panel work without them.
  if (stations.status !== "ready" || spots.status !== "ready") {
    return <Pending states={[stations, spots]} />;
  }
  const pairs = travel.status === "ready" ? travel.data : [];

  const forecast = live.status === "ready" ? live.forecast : null;
  const observed = liveObserved(forecast); // optional 7-day history (#38)
  const spot = spots.data.find((s) => s.key === selected) ?? spots.data[0];
  const levelNow: Record<string, number> = {};
  for (const sf of forecast?.spots ?? []) {
    const g = spots.data.find((s) => s.key === sf.spot)?.gauge;
    if (g) levelNow[g] = sf.levelNow;
  }

  return (
    <>
      {live.status === "ready" && live.origin !== "api" && (
        // A recent saved forecast is normal (no live API at the judging table): say so neutrally (#103).
        // Warn only when it is old, or sample data.
        <div className={savedIsOld(live.forecast.issuedAt) || live.origin === "fixture" ? "notice warn" : "notice"}>
          Forecast made {formatDateTime(live.forecast.issuedAt)}, from the latest saved gauge readings
          {live.origin === "fixture" ? " (sample data, not today's river)" : ""}
          {savedIsOld(live.forecast.issuedAt) ? ". It is more than 6 hours old: check gov.uk/check-flooding for today" : ""}.
        </div>
      )}
      {live.status === "none" && (
        <div className="notice warn">
          <strong>Live data unavailable.</strong> No saved forecast either.
        </div>
      )}
      {forecast?.note && (
        // SPEC §9: Forecast.note is shown when non-empty (e.g. the labelled persistence fallback).
        <div className="notice">{forecast.note}</div>
      )}
      <FixtureNotice sources={[stations.source, spots.source, travel.status === "ready" ? travel.source : undefined]} />

      <div className="grid-2">
        <section>
          <SpotMap
            spots={spots.data}
            stations={stations.data}
            forecast={forecast}
            selected={spot?.key ?? null}
            onSelect={setSelected}
          >
            <RiskLayers />
            <SpreadOverlay context="live" />
          </SpotMap>
        </section>
        <aside>
          {spot && (
            <SpotPanel
              spot={spot}
              station={stations.data.find((s) => s.key === spot.gauge)}
              forecast={forecast}
              history={observed?.[spot.gauge]}
            />
          )}
        </aside>
      </div>

      <section className="card">
        <h2>The water is already on its way</h2>
        <p className="sub">
          Upstream gauges feed Oxford. Each arrow shows how long a flood rise usually takes to get from
          one gauge to a gauge downstream, measured from past floods, and how many past rises that is
          based on (hover for details). Links based on fewer than {LOW_CONFIDENCE_N} are greyed out as
          low confidence. Each gauge measures from its own zero, so compare a gauge only with its own past.
        </p>
        <RiverStrip
          stations={stations.data}
          pairs={pairs}
          series={observed ?? undefined}
          levelNow={levelNow}
          stale={forecast?.stale}
          dataAsOf={forecast?.dataAsOf}
        />
        {!observed && (
          <p className="small muted">Last 7 days not available.</p>
        )}
        {travel.status === "error" && <p className="small muted">Travel times not available yet.</p>}
      </section>

      <EnsembleRainPanel />
    </>
  );
}
