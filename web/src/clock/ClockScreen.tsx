// FloodClock, the one screen (#118): a controls bar on top (what to show, the
// map view, the moment on screen), the flow map as the full-width hero (rivers
// rise and flow, small spot markers) with the two-line Scoreboard for the
// selected spot, the map key as a strip under the map, the Timeline underneath
// at full width (#135), and a one-line proof footer. "Now" reads the live
// forecast; a past flood loads only its own replay, on demand (useClockEvent,
// shared with the Timeline, so one fetch).
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
import { PointCard, SearchBox, ZonesLegend, useExplore } from "../explore";
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

/** The featured choices (the old switch) and the rest. */
export const SWITCH = EVENT_CHOICES.filter((c) => !c.more);
export const MORE = EVENT_CHOICES.filter((c) => c.more);
/** Number keys 1-9 pick these, in order: 1-5 the featured ones (as before), then the rest. */
export const KEY_ORDER: readonly EventChoice[] = [...SWITCH, ...MORE];

/** The one dropdown: what the screen shows. A native <select> (keyboard, touch and screen readers for free), grouped. */
export function EventSwitch({
  value,
  onChange,
  names,
}: {
  value: string;
  onChange: (id: string) => void;
  /** Full event names from events.json. */
  names: Record<string, string>;
}) {
  const name = (c: EventChoice) => (c.id === "now" ? "Now: live forecast" : (names[c.id] ?? c.label));
  const option = (c: EventChoice) => (
    <option key={c.id} value={c.id}>
      {name(c)}
    </option>
  );
  const live = SWITCH.filter((c) => c.id === "now");
  const featured = SWITCH.filter((c) => c.id !== "now");
  return (
    <label className="rc-field rc-event">
      <span className="rc-field-label">Showing</span>
      <span className={`rc-select-wrap${value === "now" ? " live" : ""}`}>
        <select
          className="rc-select"
          aria-label="What to show"
          title={`A live forecast or a past flood (keys 1-${KEY_ORDER.length})`}
          aria-keyshortcuts={KEY_ORDER.map((_, i) => String(i + 1)).join(" ")}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          <optgroup label="Live">{live.map(option)}</optgroup>
          <optgroup label="Past floods (replays)">{featured.map(option)}</optgroup>
          {MORE.length > 0 && <optgroup label="Earlier floods (replays)">{MORE.map(option)}</optgroup>}
        </select>
      </span>
    </label>
  );
}

/** Oxford or the whole catchment: a two-way segmented control (two choices read faster as buttons than a menu). */
function MapViewSwitch({ value, onChange }: { value: MapView; onChange: (v: MapView) => void }) {
  return (
    <div className="rc-field">
      <span className="rc-field-label" id="rc-mapview-label">
        Map
      </span>
      <div className="rc-seg" role="group" aria-labelledby="rc-mapview-label">
        {([
          ["oxford", "Oxford"],
          ["catchment", "Catchment"],
        ] as const).map(([view, label]) => (
          <button key={view} type="button" aria-pressed={value === view} onClick={() => onChange(view)}>
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function ClockScreen({ event, onEvent }: { event: string; onEvent: (id: string) => void }) {
  const events = useData<EventsFile>("events.json");
  const stations = useData<StationsFile>("stations.json");
  const travel = useData<TravelTimesFile>("travel_times.json");
  const [spot, setSpot] = useState(DEFAULT_SPOT);
  const [mapView, setMapView] = useState<MapView>("oxford");
  // Keep MapLibre opt-in until its worker is verified in production.
  const [gl] = useState(() => typeof window !== "undefined" && mapFlavour(window.location.search) === "gl");
  const data = useClockEvent(event, spot);

  const [time, setTime] = useState<{ event: string; t: number } | null>(null);
  const onTime = useCallback((t: number) => setTime({ event, t }), [event]);

  usePickKeys((n) => {
    const c = KEY_ORDER[n - 1];
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

  // Explore (#118): any point's river flood risk and a sandbag estimate. "FloodClock now" only from the live forecast.
  const explore = useExplore({ spots: spotList, forecast: live });

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
    explore: explore.layer,
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
      {/* The controls bar: what to show, the map view and the moment on screen, all off the map. */}
      <div className="rc-controls">
        <EventSwitch value={event} onChange={onEvent} names={names} />
        <MapViewSwitch value={mapView} onChange={setMapView} />
        <div className="rc-when" aria-live="polite">
          <span className={`rc-when-tag${event === "now" ? " live" : ""}`}>{event === "now" ? "Live" : "Replay"}</span>
          {t != null && <strong className="rc-when-time">{event === "now" ? formatDateTime(t) : formatDateTimeYear(t)}</strong>}
          {note && <span className="rc-when-note">{note}</span>}
        </div>
        <SearchBox onPick={explore.onPick} />
      </div>

      <div className="rc-stage">
        <div className="rc-hero">
          {gl ? (
            <Suspense fallback={<div className="ui-basemap rc-flowmap rc-gl" aria-busy="true" />}>
              <FlowMapGL {...mapProps} />
            </Suspense>
          ) : (
            <FlowMap {...mapProps} />
          )}
          {/* Explore (#118): the zones key and the point card sit over the map. */}
          {!gl && <ZonesLegend zones={explore.zones} show={explore.showZones} onToggle={explore.setShowZones} />}
          {explore.selection && <PointCard selection={explore.selection} risk={explore.risk} onClose={explore.close} onRetry={explore.retry} />}
        </div>
        {/* The Scoreboard: over the map's top right on wide screens, under the map on phones. */}
        <div className="rc-hero-score">
          {spotName && <div className="rc-hero-score-spot">{spotName}</div>}
          <Scoreboard event={event} spot={spot} t={t ?? undefined} />
        </div>
        {/* The key: a strip along the map's bottom edge, outside the map. */}
        <FlowKey />
      </div>

      <div className="rc-below">
        <Timeline key={event} event={event} spot={spot} onTime={onTime} />
      </div>

      <ProofFooter />
    </div>
  );
}
