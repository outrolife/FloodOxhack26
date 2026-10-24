// Time Machine: replay a past flood hour by hour, seeing only what the model
// saw at each forecast time. The whole replay file is preloaded, so moving the
// slider never loads anything.
import { useEffect, useMemo, useState } from "react";
import type { EventsFile, Forecast, Replay, SpotsFile, StationsFile, TravelTimesFile } from "../contracts";
import { useData } from "../data";
import { HOUR, formatDateTimeYear, hoursBetween } from "../time";
import { FanChart, type Marker } from "../components/timemachine/FanChart";
import {
  focusWindow,
  formatOfficial,
  matchTier,
  officialLabel,
  runUpIndex,
  tierSentence,
  type Tier,
  type TierMatch,
} from "../components/timemachine/timeline";
import { FixtureNotice, Pending } from "../components/shared/DataNotice";
import { ProbBars } from "../components/shared/ProbBars";
import { RiverStrip } from "../components/shared/RiverStrip";
import { arrivalSentence } from "../components/shared/forecast";
import { SpreadMapCard } from "../components/spread/SpreadOverlay"; // S3 (SPEC §11); hide with SHOW_S3 in stretch.ts

const SIM_HOURS_PER_2S = 12; // SPEC §10.2: one simulated 12 h per 2 s (speed 1×)
const SPEEDS = [0.5, 1, 2, 4] as const;

// River Clock vs EA matches per spot and tier (#82); cached per replay so the
// slider doesn't rescan every forecast on each step.
const matchCache = new WeakMap<Forecast[], Map<string, TierMatch>>();
function cachedMatch(replay: Replay, spot: string, threshold: number, tier: Tier): TierMatch {
  let bySpot = matchCache.get(replay.forecasts);
  if (!bySpot) matchCache.set(replay.forecasts, (bySpot = new Map()));
  const key = `${spot}|${tier}`;
  let m = bySpot.get(key);
  if (!m) bySpot.set(key, (m = matchTier(replay, spot, threshold, tier)));
  return m;
}


/** Keys typed into these elements belong to them, not to the player. */
function ownsKeys(el: EventTarget | null, key: string): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable || el.tagName === "SELECT" || el.tagName === "TEXTAREA") return true;
  if (el.tagName === "BUTTON" || el.tagName === "A") return key === " " || key === "Enter";
  if (el instanceof HTMLInputElement) return el.type !== "range" || key !== " "; // range: arrows are native
  return false;
}

export default function TimeMachine() {
  const events = useData<EventsFile>("events.json");
  const spots = useData<SpotsFile>("spots.json");
  const stations = useData<StationsFile>("stations.json");
  const travel = useData<TravelTimesFile>("travel_times.json");
  const [eventId, setEventId] = useState<string | null>(null);

  // Default event: e2014 if present, else the headline event, else the first.
  useEffect(() => {
    if (eventId || events.status !== "ready") return;
    const list = events.data;
    setEventId((list.find((e) => e.id === "e2014") ?? list.find((e) => e.headline) ?? list[0])?.id ?? null);
  }, [events, eventId]);

  const replay = useData<Replay>(eventId ? `replays/${eventId}.json` : null);

  // Travel times only label the river strip, so they are optional here.
  const ready = events.status === "ready" && spots.status === "ready" && stations.status === "ready";
  if (!ready) return <Pending states={[events, spots, stations]} />;
  const pairs = travel.status === "ready" ? travel.data : [];

  return (
    <>
      <div className="controls">
        <label>
          Flood event
          <select value={eventId ?? ""} onChange={(e) => setEventId(e.target.value)}>
            {events.data.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
                {e.headline ? " (headline)" : ""}
              </option>
            ))}
          </select>
        </label>
      </div>
      {replay.status === "loading" && eventId && <p className="muted">Loading replay…</p>}
      {replay.status === "error" && (
        <div className="notice warn">No replay has been computed for this event yet.</div>
      )}
      {replay.status === "ready" && (
        <>
          <FixtureNotice sources={[replay.source, spots.source, stations.source]} />
          {replay.data.eventId !== eventId && (
            <div className="notice warn">
              No replay for this event yet; showing the sample replay of {replay.data.name} instead.
            </div>
          )}
          <ReplayPlayer
            key={replay.data.eventId + eventId}
            replay={replay.data}
            spots={spots.data}
            stations={stations.data}
            travel={pairs}
          />
        </>
      )}
    </>
  );
}

function ReplayPlayer({
  replay,
  spots,
  stations,
  travel,
}: {
  replay: Replay;
  spots: SpotsFile;
  stations: StationsFile;
  travel: TravelTimesFile;
}) {
  const forecasts = replay.forecasts;
  const spotKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const f of forecasts) for (const s of f.spots) keys.add(s.spot);
    return spots.filter((s) => keys.has(s.key));
  }, [forecasts, spots]);

  const [spotKey, setSpotKey] = useState<string>(
    // Headline replay is on newbotley (Botley spot), SPEC §4.3; fall back to osney, then any.
    () => (spotKeys.find((s) => s.key === "botley") ?? spotKeys.find((s) => s.key === "osney") ?? spotKeys[0])?.key ?? "",
  );
  // Where "Start just before the flood" jumps to for a spot (#103): 72 h before River Clock's 50%.
  const runUpFor = (key: string): number | null => {
    const s = spots.find((x) => x.key === key);
    if (!s) return null;
    return runUpIndex(forecasts, cachedMatch(replay, s.key, s.threshold, "warning"), cachedMatch(replay, s.key, s.threshold, "alert"));
  };
  // ?step=N in the URL opens the replay at forecast N (handy for demos and screenshots).
  // Without it, open just before the flood (#103), so Play tells the story in seconds, not a minute.
  const [idx, setIdx] = useState(() => {
    const raw = new URLSearchParams(window.location.search).get("step");
    const step = raw != null && raw !== "" ? Number(raw) || 0 : (runUpFor(spotKey) ?? 0);
    return Math.min(Math.max(step, 0), Math.max(forecasts.length - 1, 0));
  });
  const [seenIdx, setSeenIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(1);
  // "focus": a window that follows the slider, so the 72 h fan is readable;
  // "event": the whole event (up to two months) at once.
  const [zoom, setZoom] = useState<"focus" | "event">("focus");
  const last = forecasts.length - 1;

  useEffect(() => setSeenIdx((s) => Math.max(s, idx)), [idx]);

  // Play: advance one forecast step at 12 simulated hours per 2 s (times speed).
  useEffect(() => {
    if (!playing) return;
    if (idx >= last) {
      setPlaying(false);
      return;
    }
    const stepH = Math.max(hoursBetween(forecasts[idx].issuedAt, forecasts[idx + 1].issuedAt), 0.25);
    const delay = (2000 * stepH) / (SIM_HOURS_PER_2S * speed);
    const timer = setTimeout(() => setIdx((i) => Math.min(i + 1, last)), delay);
    return () => clearTimeout(timer);
  }, [playing, idx, forecasts, speed, last]);

  const togglePlay = () => {
    if (!playing && idx >= last) setIdx(0);
    setPlaying((p) => !p);
  };

  // Keyboard: Space plays/pauses, arrows step (Shift = 6 steps), Home/End jump.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || ownsKeys(e.target, e.key)) return;
      const step = e.shiftKey ? 6 : 1;
      let next: number | null = null;
      if (e.key === " ") {
        e.preventDefault();
        togglePlay();
        return;
      }
      if (e.key === "ArrowRight") next = idx + step;
      else if (e.key === "ArrowLeft") next = idx - step;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = last;
      if (next == null) return;
      e.preventDefault();
      setPlaying(false);
      setIdx(Math.min(Math.max(next, 0), last));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (forecasts.length === 0) return <div className="notice warn">This replay has no forecasts.</div>;

  const spot = spots.find((s) => s.key === spotKey) ?? spotKeys[0];
  if (!spot) return <div className="notice warn">This replay has no forecasts for any known spot.</div>;

  const f = forecasts[Math.min(idx, forecasts.length - 1)];
  const sf = f.spots.find((s) => s.spot === spot.key);
  const sliderT = f.issuedAt;
  const seenT = forecasts[Math.min(seenIdx, forecasts.length - 1)].issuedAt;
  const observed = replay.observed[spot.gauge] ?? [];

  // Timeline markers.
  // River Clock vs EA, tiers matched and tied to the same flood (#82):
  // alert vs first >= 10%, warning vs first >= 50%.
  const alertMatch = cachedMatch(replay, spot.key, spot.threshold, "alert");
  const warnMatch = cachedMatch(replay, spot.key, spot.threshold, "warning");
  const crossing = warnMatch.crossing;
  const officialAlert = alertMatch.official ?? alertMatch.lateOfficial;
  const officialWarning = warnMatch.official ?? warnMatch.lateOfficial;

  // Markers appear only once the slider has reached them, so playing the
  // replay tells the story in order (SPEC §17.2). Only matched times are
  // marked, so nothing sits days away from the flood it doesn't belong to.
  const revealed = (t: string) => Date.parse(t) <= Date.parse(seenT);
  const markers: Marker[] = [];
  if (alertMatch.official && alertMatch.rc && revealed(alertMatch.rc))
    markers.push({ t: alertMatch.rc, label: "River Clock ≥ 10%", colour: "#2a78d6" });
  if (warnMatch.rc && revealed(warnMatch.rc))
    markers.push({ t: warnMatch.rc, label: "River Clock ≥ 50%", colour: "#184f95" });
  if (officialAlert && revealed(officialAlert.issuedAt))
    markers.push({ t: officialAlert.issuedAt, label: `EA ${officialLabel(officialAlert)}`, colour: "#a8336a" });
  if (officialWarning && revealed(officialWarning.issuedAt))
    markers.push({ t: officialWarning.issuedAt, label: `EA ${officialLabel(officialWarning)}`, colour: "#6250d6" });
  if (crossing && revealed(crossing)) markers.push({ t: crossing, label: "Threshold crossed", colour: "#d03b3b" });

  const lastF = Date.parse(forecasts[forecasts.length - 1].issuedAt);
  const eventDomain: [number, number] = [Date.parse(replay.start), Math.max(Date.parse(replay.end), lastF + 72 * HOUR)];
  const domain = zoom === "event" ? eventDomain : focusWindow(Date.parse(sliderT), eventDomain);

  const endT = forecasts[forecasts.length - 1].issuedAt;
  const runUp = runUpFor(spot.key);
  const warningSentence = tierSentence(warnMatch, revealed, endT);
  const alertSentence = tierSentence(alertMatch, revealed, endT);

  return (
    <div className="grid-2">
      <section className="card">
        <div className="controls">
          <label>
            Spot
            <select value={spot.key} onChange={(e) => setSpotKey(e.target.value)}>
              {spotKeys.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <button className="btn primary" onClick={togglePlay} aria-keyshortcuts="Space">
            {playing ? "Pause" : "Play"}
          </button>
          {runUp != null && (
            <button
              className="btn"
              onClick={() => {
                setPlaying(false);
                setIdx(runUp);
              }}
              title={`Jump to ${formatDateTimeYear(forecasts[runUp].issuedAt)}, 3 days before River Clock first gave ${spot.name} a 50% chance (or before the flood), then press Play`}
            >
              Start just before the flood
            </button>
          )}
          <span className="speed" role="group" aria-label="Playback speed">
            {SPEEDS.map((s) => (
              <button key={s} className="btn" aria-pressed={speed === s} onClick={() => setSpeed(s)}>
                {s}×
              </button>
            ))}
          </span>
          <span className="speed" role="group" aria-label="Chart range">
            <button className="btn" aria-pressed={zoom === "focus"} onClick={() => setZoom("focus")}>
              10 days
            </button>
            <button className="btn" aria-pressed={zoom === "event"} onClick={() => setZoom("event")}>
              Whole event
            </button>
          </span>
          <span className="small">
            Forecast issued <strong>{formatDateTimeYear(sliderT)}</strong>
          </span>
        </div>
        <input
          className="tm-slider"
          type="range"
          min={0}
          max={forecasts.length - 1}
          value={idx}
          onChange={(e) => {
            setPlaying(false);
            setIdx(Number(e.target.value));
          }}
          aria-label="Forecast time"
          aria-valuetext={formatDateTimeYear(sliderT)}
        />
        <div className="small muted">
          Keys: Space play/pause · ← → step one forecast (Shift: 6) · Home/End jump to start/end
        </div>
        <FanChart
          observed={observed}
          sliderT={sliderT}
          seenT={seenT}
          forecast={sf}
          issuedAt={f.issuedAt}
          threshold={spot.threshold}
          amber={spot.amber}
          domain={domain}
          markers={markers}
        />
        <div className="timeline-note">
          {warningSentence && (
            <p>
              <strong>{warningSentence}</strong>
              {officialWarning && revealed(officialWarning.issuedAt) && (
                <> Issued {formatOfficial(officialWarning)}.</>
              )}
            </p>
          )}
          {alertSentence && (
            <p>
              {alertSentence}
              {officialAlert && revealed(officialAlert.issuedAt) && <> Issued {formatOfficial(officialAlert)}.</>}
            </p>
          )}
          <p className="muted">
            Black line: the river level observed so far. Faint grey line: what happened next, shown only
            after the slider has passed it. The model never sees data after its forecast time.
          </p>
        </div>
      </section>
      <aside>
        <div className="card">
          <h2>{spot.name}</h2>
          <p className="sub">At {formatDateTimeYear(sliderT)}</p>
          <ProbBars sf={sf} />
          <p style={{ marginTop: "0.6rem" }}>
            <strong>{arrivalSentence(sf, f.stale.includes(spot.gauge), spot.threshold)}</strong>
          </p>
        </div>
        <SpreadMapCard eventId={replay.eventId} at={sliderT} />
        <div className="card">
          <h2>Upstream at this time</h2>
          <RiverStrip stations={stations} pairs={travel} series={replay.observed} until={sliderT} />
        </div>
      </aside>
    </div>
  );
}
