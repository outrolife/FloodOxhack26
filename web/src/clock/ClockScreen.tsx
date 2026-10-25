// River Clock, the one screen (#118): the event switch on top, the flow map as
// the full-width hero (rivers rise and flow, small spot markers) with the
// two-line Scoreboard for the selected spot on it, the Timeline underneath at
// full width (#135), and a one-line proof footer. "Now" reads the live forecast; a past flood loads only its own
// replay, on demand (useClockEvent, shared with the Timeline, so one fetch).
import { Suspense, lazy, useCallback, useMemo, useState } from "react";
import type { EventsFile, Forecast, Spot, StationsFile, TravelTimesFile } from "../contracts";
import { mapFlavour } from "./flowgl";
import type { MapView } from "./flowgl";
import { useData } from "../data";
import { formatDateTime, formatDateTimeYear } from "../time";
import { usePickKeys } from "../ui/presenter";
import { indexAt } from "../screens/replay/playback";
import { DEFAULT_SPOT, EVENT_CHOICES, type EventChoice } from "./choices";
import { gaugeLevelsAt } from "./flow";
import { FlowKey, FlowMap } from "./FlowMap";
import { ProofFooter } from "./ProofFooter";
import { Scoreboard } from "./Scoreboard";
import { Timeline } from "./Timeline";
import { useClockEvent } from "./useClockEvent";
import { eaBadge, justWarned } from "./markers";
import { replayFactsFor } from "../screens/replay/facts";
import "./shell.css";

/** Map v3 (#152, MapLibre + deck.gl): its own chunk, loaded only with ?map=gl (or once it is the default). */
const FlowMapGL = lazy(() => import("./FlowMapGL"));

/** Readings are known an hour after they happen (#93), as in the Timeline. */
const REPLAY_LAG_H = 1;

/** Stable empty lists while stations.json / spots.json load, so memos keyed on them don't re-run. */
const NONE_STATIONS: StationsFile = [];
const NONE_SPOTS: Spot[] = [];
const NONE_PAIRS: TravelTimesFile = [];
const NONE_STALE: string[] = [];

/** The switch: choices on it, and the rest under "More". Keys 1–5 pick the ones on it, in order. */
export const SWITCH = EVENT_CHOICES.filter((c) => !c.more);
export const MORE = EVENT_CHOICES.filter((c) => c.more);

export function EventSwitch({
  value,
  onChange,
  names,
}: {
  value: string;
  onChange: (id: string) => void;
  /** Full event names from events.json, for tooltips and the More menu. */
  names: Record<string, string>;
}) {
  const inMore = MORE.find((o) => o.id === value);
  const title = (c: EventChoice) => (c.id === "now" ? "The live forecast" : (names[c.id] ?? c.label));
  return (
    <nav className="rc-switch" aria-label="What to show">
      {SWITCH.map((c, i) => (
        <button
          key={c.id}
          type="button"
          className="rc-switch-btn"
          aria-pressed={c.id === value}
          aria-keyshortcuts={String(i + 1)}
          title={`${title(c)} (key ${i + 1})`}
          onClick={() => onChange(c.id)}
        >
          {c.label}
        </button>
      ))}
      {MORE.length > 0 && (
        <select
          className={`rc-switch-more${inMore ? " active" : ""}`}
          aria-label="More past floods"
          value={inMore ? inMore.id : ""}
          onChange={(e) => e.target.value && onChange(e.target.value)}
        >
          <option value="">More…</option>
          {MORE.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
              {names[c.id] && names[c.id] !== c.label ? ` (${names[c.id]})` : ""}
            </option>
          ))}
        </select>
      )}
    </nav>
  );
}

export default function ClockScreen({ event, onEvent }: { event: string; onEvent: (id: string) => void }) {
  const events = useData<EventsFile>("events.json");
  const stations = useData<StationsFile>("stations.json");
  const travel = useData<TravelTimesFile>("travel_times.json");
  const [spot, setSpot] = useState(DEFAULT_SPOT);
  const [mapView, setMapView] = useState<MapView>("oxford");
  // ?map=leaflet draws the local Leaflet fallback; otherwise show the catchment-capable MapLibre map.
  const [gl] = useState(() => typeof window !== "undefined" && mapFlavour(window.location.search) === "gl");
  const data = useClockEvent(event, spot);

  const [time, setTime] = useState<{ event: string; t: number } | null>(null);
  const onTime = useCallback((t: number) => setTime({ event, t }), [event]);

  usePickKeys((n) => {
    const c = SWITCH[n - 1];
    if (c) onEvent(c.id);
  });

  const replay = data.status === "ready" && data.kind === "replay" ? data.replay : null;
  const live: Forecast | null = data.status === "ready" && data.kind === "now" ? data.live : null;
  const times = useMemo(() => (replay?.forecasts ?? []).map((f) => Date.parse(f.issuedAt)), [replay]);
  const names = useMemo(
    () => Object.fromEntries((events.status === "ready" ? events.data : []).map((e) => [e.id, e.name])),
    [events],
  );

  // The whole screen (switch, map, timeline) is drawn at once; parts fill in as their files load (#118: never a blank page).
  const stationList = stations.status === "ready" && Array.isArray(stations.data) ? stations.data : NONE_STATIONS;
  const spotList = data.status === "ready" ? data.spots : NONE_SPOTS;

  // The moment on screen: what the Timeline reported for this event, else its first forecast.
  const t = time?.event === event ? time.t : live ? Date.parse(live.issuedAt) : times.length ? times[0] : null;

  // Replays: every forecast spot's facts at its own warn-at level, for its map badge and warning pulse.
  const proof = data.status === "ready" ? data.proof : null;
  const allFacts = useMemo(
    () => (replay ? spotList.filter((s) => s.mode === "probability").map((s) => replayFactsFor(replay, s, proof)) : []),
    [replay, spotList, proof],
  );
  const marks =
    replay && t != null ? Object.fromEntries(allFacts.map((f) => [f.spot, { badge: eaBadge(f, t), pulse: justWarned(f, t) }])) : undefined;

  let forecast: Forecast | null = null;
  let observed: Record<string, { t: string; level: number }[]> | undefined;
  let levels: Record<string, number | null> = {};
  if (live && t != null) {
    forecast = live;
    observed = live.observed;
    levels = gaugeLevelsAt({ stations: stationList, observed, t });
  } else if (replay && t != null && times.length) {
    forecast = replay.forecasts[indexAt(times, t)];
    observed = replay.observed;
    levels = gaugeLevelsAt({ stations: stationList, observed, t, lagH: REPLAY_LAG_H });
  }

  const mapProps = {
    spots: spotList,
    stations: stationList,
    pairs: travel.status === "ready" ? travel.data : NONE_PAIRS,
    levels,
    forecast,
    observed,
    stale: forecast?.stale ?? NONE_STALE,
    selected: spot,
    onSelect: setSpot,
    marks,
    t,
    lagH: replay ? REPLAY_LAG_H : 0,
    mapView,
    onMapViewChange: setMapView,
  };

  const label = event === "now" ? "Now" : (names[event] ?? event);
  const spotName = spotList.find((s) => s.key === spot)?.name.split(" / ")[0].trim() ?? null;
  const note =
    stations.status === "error"
      ? "No gauge list"
      : data.status === "loading"
      ? event === "now"
        ? "Reading the live river…"
        : `Loading the ${label} replay…`
      : data.status === "missing"
        ? data.message
        : null;

  return (
    <div className="rc-screen">
      <div className="rc-top">
        <EventSwitch value={event} onChange={onEvent} names={names} />
      </div>

      <div className="rc-hero">
        {gl ? (
          <Suspense fallback={<div className="ui-basemap rc-flowmap rc-gl" aria-busy="true" />}>
            <FlowMapGL {...mapProps} />
          </Suspense>
        ) : (
          <FlowMap {...mapProps} />
        )}
        <div className="rc-map-views" role="group" aria-label="Map view">
          {([
            ["oxford", "Oxford"],
            ["catchment", "Catchment"],
          ] as const).map(([view, label]) => (
            <button key={view} type="button" aria-pressed={mapView === view} onClick={() => setMapView(view)}>
              {label}
            </button>
          ))}
        </div>
        <div className="rc-badge" aria-live="polite">
          <strong>{label}</strong>
          {t != null && <span> · {event === "now" ? formatDateTime(t) : formatDateTimeYear(t)}</span>}
          {note && <span className="rc-badge-note"> · {note}</span>}
        </div>
        <FlowKey />
        {/* The Scoreboard sits on the map (top right), so the map keeps the full width. */}
        <div className="rc-hero-score">
          {spotName && <div className="rc-hero-score-spot">{spotName}</div>}
          <Scoreboard event={event} spot={spot} t={t ?? undefined} />
        </div>
      </div>

      <div className="rc-below">
        <Timeline key={event} event={event} spot={spot} onTime={onTime} />
      </div>

      <ProofFooter />
    </div>
  );
}
