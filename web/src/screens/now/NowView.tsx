// The Now screen's layout, without Leaflet (the map comes in through `map`),
// so it can be rendered in node tests. Now.tsx loads the data and passes the
// BaseMap with the clock layer.
import { type ReactNode, useEffect, useState } from "react";
import type { Forecast, Spot, Station, TravelPair } from "../../contracts";
import { formatDateTime } from "../../time";
import { Headline, KeyHint, Screen, StatRow, StatTile, usePlayerKeys } from "../../ui";
import { CLOCK_STYLE, LIKELY_AT, WATCH_AT, type ClockState } from "../../ui/SpotClock";
import { clockStates, dataTimestamp, headline, riverLinks, topStats, type SpotClockInfo } from "./logic";
import { RiverPulse } from "./RiverPulse";
import { SpotCard } from "./SpotCard";
import "./now.css";

export type LiveOrigin = "api" | "data" | "fixture" | "none";

export type MapSlot = (p: { clocks: SpotClockInfo[]; selected: string | null; onSelect: (key: string) => void }) => ReactNode;

/** Presenter tour (Space): each spot card stays up this long before the next. */
export const TOUR_MS = 6000;

/** The spot `delta` places after `current` in map order, wrapping round (none selected: the first or last). */
export function stepSpot(keys: string[], current: string | null, delta: number): string | null {
  if (keys.length === 0) return null;
  const i = current == null ? -1 : keys.indexOf(current);
  if (i < 0) return keys[delta >= 0 ? 0 : keys.length - 1];
  return keys[(((i + delta) % keys.length) + keys.length) % keys.length];
}

const LEGEND: ClockState[] = ["calm", "watch", "likely", "noforecast", "stale"];
const W = Math.round(WATCH_AT * 100);
const L = Math.round(LIKELY_AT * 100);

function Legend() {
  return (
    <div className="now-legend" role="group" aria-label="How to read a clock">
      <strong>How to read a clock:</strong> the ring fills with the chance of flooding in the next 3 days; the time under
      it counts down to when the chance passes 50%.
      <ul>
        {LEGEND.map((s) => (
          <li key={s}>
            <span aria-hidden="true" style={{ color: CLOCK_STYLE[s].colour }}>
              {CLOCK_STYLE[s].shape}
            </span>{" "}
            {CLOCK_STYLE[s].label}
            {s === "calm" ? ` (under ${W}%)` : s === "watch" ? ` (${W}–${L}%)` : s === "likely" ? ` (${L}% or more)` : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function NowView({
  spots,
  stations,
  pairs,
  forecast,
  origin,
  now,
  map,
  working,
  initialSelected = "botley",
}: {
  spots: Spot[];
  stations: Station[];
  pairs: TravelPair[];
  forecast: Forecast | null;
  origin: LiveOrigin;
  /** Wall-clock time, ms (for the countdowns). */
  now: number;
  map: MapSlot;
  working?: ReactNode;
  initialSelected?: string | null;
}) {
  const [selected, setSelectedState] = useState<string | null>(initialSelected);
  const [touring, setTouring] = useState(false);
  const keys = spots.map((s) => s.key);
  // A click picks a spot and stops the tour; ←/→ step through the spots; Space tours them.
  const setSelected = (k: string | null) => {
    setTouring(false);
    setSelectedState(k);
  };
  usePlayerKeys(
    () => {
      if (!touring) setSelectedState((cur) => cur ?? keys[0] ?? null);
      setTouring((t) => !t);
    },
    (delta) => setSelected(stepSpot(keys, selected, delta)),
  );
  const keysKey = keys.join(",");
  useEffect(() => {
    if (!touring) return;
    const list = keysKey.split(",");
    const id = window.setInterval(() => setSelectedState((cur) => stepSpot(list, cur, 1)), TOUR_MS);
    return () => window.clearInterval(id);
  }, [touring, keysKey]);
  const clocks = clockStates(spots, forecast, now);
  const stats = topStats(clocks, spots, stations, forecast);
  const chains = riverLinks(stations, pairs);
  const spot = spots.find((s) => s.key === selected);
  const clock = clocks.find((c) => c.spot === selected);
  const stamp = dataTimestamp(forecast);

  const aside = (
    <>
      {origin !== "api" && (
        <div className="notice warn">
          {forecast ? (
            <>
              <strong>Live data unavailable.</strong> Showing the last saved forecast, issued {formatDateTime(forecast.issuedAt)}
              {origin === "fixture" && " (sample data)"}.
            </>
          ) : (
            <>
              <strong>Live data unavailable.</strong> No saved forecast either.
            </>
          )}
        </div>
      )}
      {forecast?.note && <div className="notice">{forecast.note}</div>}
      {spot && clock ? (
        <SpotCard
          spot={spot}
          clock={clock}
          station={stations.find((s) => s.key === spot.gauge)}
          forecast={forecast}
          onClose={() => setSelected(null)}
        />
      ) : (
        <div className="card now-pick">
          <p className="now-pick-text">Click a clock on the map to see when the water could arrive and what to do.</p>
          <Legend />
        </div>
      )}
      <KeyHint keys={[["← →", "next spot"], ["Space", touring ? "stop the tour" : "tour the spots"]]} />
    </>
  );

  return (
    <Screen
      headline={<Headline sub={stamp ?? undefined}>{headline(clocks)}</Headline>}
      stats={
        stats.length > 0 && (
          <StatRow>
            {stats.map((s) => (
              <StatTile key={s.label} value={s.value} label={s.label} sub={s.sub} tone={s.tone} />
            ))}
          </StatRow>
        )
      }
      hero={
        <div className="now-hero">
          <RiverPulse chains={chains} />
          <div className="now-map">{map({ clocks, selected, onSelect: setSelected })}</div>
        </div>
      }
      aside={aside}
      working={working}
      workingTitle="Show the working: live gauges, 7-day levels, flood-risk layers and rain"
    />
  );
}
