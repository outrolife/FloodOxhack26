// Replay (#118, #120): "Watch River Clock call the January 2014 flood."
// Opens on e2014 just before the flood and plays itself on the first visit.
// Map with the spot clocks filling on the left, the forecast fan sweeping
// forward on the right, and a scoreboard that fills in as each moment passes.
// Every number is read from the replay JSON and proof.json at runtime.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { EventsFile, Proof, Replay as ReplayData, Spot, SpotsFile, StationsFile, TravelTimesFile } from "../contracts";
import { loadData, useData } from "../data";
import { HOUR, formatDateTimeYear } from "../time";
import { Headline, Screen, SpotClock, usePlayerKeys } from "../ui";
import { Pending } from "../components/shared/DataNotice";
import { ProbBars } from "../components/shared/ProbBars";
import { RiverStrip } from "../components/shared/RiverStrip";
import { arrivalSentence } from "../components/shared/forecast";
import { matchTier, tierSentence } from "../components/timemachine/timeline";
import { perEventRow, replayFacts, startIndex, type ReplayFacts } from "./replay/facts";
import { buildScoreboard, scoreboardAt } from "./replay/scoreboard";
import { headlineText, shortSpotName } from "./replay/story";
import { SPEEDS, indexAt, simAdvance } from "./replay/playback";
import { clockAt } from "./replay/clocks";
import { Scoreboard } from "./replay/ScoreboardCard";
import { EventPicker } from "./replay/EventPicker";
import { ReplayChart, ChartKey, type ChartMarker } from "./replay/ReplayChart";
import { ReplayMap } from "./replay/ReplayMap";
import "./replay/replay.css";

const DEFAULT_EVENT = "e2014";
const DEFAULT_SPOT = "botley";
const AUTOPLAY_KEY = "rc-replay-autoplayed";
/** Playback stops this long after the scoreboard's last row fills in, so the story ends on the result. */
const STOP_AFTER_H = 12;

function firstVisit(): boolean {
  try {
    if (sessionStorage.getItem(AUTOPLAY_KEY)) return false;
    sessionStorage.setItem(AUTOPLAY_KEY, "1");
  } catch {
    // Storage blocked: autoplay anyway; it's only a convenience.
  }
  return true;
}

/** Loads the selected replay first, then the others one by one in the background (for the thumbnails). */
function useReplays(ids: string[], selected: string | null): { replays: Record<string, ReplayData>; failed: Set<string> } {
  const [replays, setReplays] = useState<Record<string, ReplayData>>({});
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const key = ids.join(",");
  useEffect(() => {
    if (!selected) return;
    let alive = true;
    const order = [selected, ...ids.filter((id) => id !== selected)];
    (async () => {
      for (const id of order) {
        try {
          const r = await loadData<ReplayData>(`replays/${id}.json`);
          if (!alive) return;
          // The loader falls back to a sample replay for any id: keep only the real one.
          if (r.value.eventId === id) setReplays((m) => (m[id] ? m : { ...m, [id]: r.value }));
          else setFailed((s) => new Set(s).add(id));
        } catch {
          if (alive) setFailed((s) => new Set(s).add(id));
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [key, selected]);
  return { replays, failed };
}

export default function Replay() {
  const events = useData<EventsFile>("events.json");
  const spots = useData<SpotsFile>("spots.json");
  const stations = useData<StationsFile>("stations.json");
  const travel = useData<TravelTimesFile>("travel_times.json");
  const proofState = useData<Proof>("proof.json");
  const proof = proofState.status === "ready" ? proofState.data : null;

  const [eventId, setEventId] = useState<string | null>(null);
  const [spotKey, setSpotKey] = useState(DEFAULT_SPOT);
  // Autoplay on the first visit this session; after that, a selected flood plays, a calm event waits at its peak chance.
  const [autoplay, setAutoplay] = useState<boolean>(() => firstVisit());

  const eventList = events.status === "ready" ? events.data : [];
  useEffect(() => {
    if (eventId || eventList.length === 0) return;
    setEventId((eventList.find((e) => e.id === DEFAULT_EVENT) ?? eventList.find((e) => e.headline) ?? eventList[0]).id);
  }, [eventList, eventId]);

  const ids = useMemo(() => eventList.map((e) => e.id), [eventList]);
  const { replays, failed } = useReplays(ids, eventId);

  const spotList = spots.status === "ready" ? spots.data : [];
  const forecastSpots = useMemo(() => spotList.filter((s) => s.mode === "probability"), [spotList]);
  const spot = forecastSpots.find((s) => s.key === spotKey) ?? forecastSpots[0];

  // Facts per loaded event for the selected spot: badges, headline, scoreboard.
  const factsByEvent = useMemo(() => {
    const out: Record<string, ReplayFacts> = {};
    if (!spot) return out;
    for (const [id, r] of Object.entries(replays)) out[id] = replayFacts(r, spot, perEventRow(proof, id, spot.key));
    return out;
  }, [replays, spot, proof]);

  const ready = events.status === "ready" && spots.status === "ready" && stations.status === "ready";
  if (!ready) return <Pending states={[events, spots, stations]} />;
  if (!spot) return <div className="notice warn">No forecast spots configured.</div>;

  const replay = eventId ? replays[eventId] : undefined;
  const meta = eventList.find((e) => e.id === eventId);
  const pairs = travel.status === "ready" ? travel.data : [];

  const pickEvent = (id: string) => {
    const f = factsByEvent[id];
    setAutoplay(f ? f.crossing != null : true);
    setEventId(id);
  };

  const picker = (
    <EventPicker events={eventList} replays={replays} facts={factsByEvent} spot={spot} selected={eventId ?? ""} onSelect={pickEvent} />
  );

  if (!replay || !meta) {
    const missing = eventId != null && failed.has(eventId);
    return (
      <Screen
        headline={<Headline>{missing ? "No replay has been computed for this event yet." : "Loading the replay…"}</Headline>}
        hero={
          <div className="rp-hero">
            <div className="ui-placeholder">{missing ? "Pick another flood below." : "Loading…"}</div>
            {picker}
          </div>
        }
      />
    );
  }

  return (
    <Player
      key={replay.eventId}
      replay={replay}
      eventName={meta.name}
      spots={spotList}
      spot={spot}
      facts={factsByEvent[replay.eventId]}
      autoplay={autoplay}
      picker={picker}
      spotPicker={
        <div className="rp-spots" role="group" aria-label="Choose a spot">
          {forecastSpots.map((s) => (
            <SpotPickerClock key={s.key} replay={replay} spot={s} selected={s.key === spot.key} onSelect={setSpotKey} />
          ))}
        </div>
      }
      stations={stations.data}
      pairs={pairs}
      onSelectSpot={setSpotKey}
    />
  );
}

/** The spot selector clocks show the highest chance River Clock gave each spot in this event. */
function SpotPickerClock({ replay, spot, selected, onSelect }: { replay: ReplayData; spot: Spot; selected: boolean; onSelect: (k: string) => void }) {
  const peak = useMemo(() => {
    let best: number | null = null;
    for (const f of replay.forecasts) {
      const c = clockAt(f, spot);
      if (c.prob != null) best = Math.max(best ?? 0, c.prob);
    }
    return best;
  }, [replay, spot]);
  return (
    <SpotClock
      label={shortSpotName(spot.name)}
      prob={peak}
      countdownH={null}
      state={peak == null ? "noforecast" : peak >= 0.5 ? "likely" : peak >= 0.1 ? "watch" : "calm"}
      size="sm"
      selected={selected}
      onClick={() => onSelect(spot.key)}
    />
  );
}

function Player({
  replay,
  eventName,
  spots,
  spot,
  facts,
  autoplay,
  picker,
  spotPicker,
  stations,
  pairs,
  onSelectSpot,
}: {
  replay: ReplayData;
  eventName: string;
  spots: SpotsFile;
  spot: Spot;
  facts: ReplayFacts;
  autoplay: boolean;
  picker: ReactNode;
  spotPicker: ReactNode;
  stations: StationsFile;
  pairs: TravelTimesFile;
  onSelectSpot: (key: string) => void;
}) {
  const forecasts = replay.forecasts;
  const last = forecasts.length - 1;
  const times = useMemo(() => forecasts.map((f) => Date.parse(f.issuedAt)), [forecasts]);
  const endT = forecasts[last]?.issuedAt ?? replay.end;

  const rows = useMemo(() => buildScoreboard(facts, spot.threshold, endT), [facts, spot.threshold, endT]);
  const storyEnd = useMemo(() => Math.max(...rows.map((r) => r.at ?? 0)) + STOP_AFTER_H * HOUR, [rows]);

  const [idx, setIdxState] = useState(() => startIndex(replay, spot, facts));
  const idxRef = useRef(idx);
  const setIdx = useCallback((i: number) => {
    idxRef.current = i;
    setIdxState(i);
  }, []);
  const [seenIdx, setSeenIdx] = useState(idx);
  useEffect(() => setSeenIdx((s) => Math.max(s, idx)), [idx]);

  const [warn, alert] = useMemo(
    () => [matchTier(replay, spot.key, spot.threshold, "warning"), matchTier(replay, spot.key, spot.threshold, "alert")] as const,
    [replay, spot.key, spot.threshold],
  );

  const [speed, setSpeed] = useState<number>(1);
  // Where playback stops by itself: just after the scoreboard completes, if that's still ahead.
  const stopFor = useCallback((i: number) => (times[i] < storyEnd ? storyEnd : null), [times, storyEnd]);
  const [play, setPlay] = useState<{ on: boolean; stopAt: number | null }>(() => ({ on: autoplay, stopAt: autoplay ? stopFor(idx) : null }));

  // requestAnimationFrame playback on a simulated clock: 12 simulated hours per 2 s at 1×.
  useEffect(() => {
    if (!play.on || times.length === 0) return;
    let raf = 0;
    let prev = performance.now();
    let sim = times[idxRef.current];
    const tick = (now: number) => {
      sim += simAdvance(now - prev, speed);
      prev = now;
      const i = indexAt(times, sim);
      if (i !== idxRef.current) setIdx(i);
      if (i >= times.length - 1 || (play.stopAt != null && sim >= play.stopAt)) {
        setPlay({ on: false, stopAt: null });
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [play, speed, times, setIdx]);

  const togglePlay = () => {
    if (play.on) return setPlay({ on: false, stopAt: null });
    const from = idxRef.current >= last ? 0 : idxRef.current;
    if (from !== idxRef.current) setIdx(from);
    setPlay({ on: true, stopAt: stopFor(from) });
  };
  const jump = (i: number) => {
    setPlay({ on: false, stopAt: null });
    setIdx(Math.min(Math.max(i, 0), last));
  };
  usePlayerKeys(togglePlay, (delta) => jump(idxRef.current + delta));

  if (forecasts.length === 0) return <div className="notice warn">This replay has no forecasts.</div>;

  const f = forecasts[idx];
  const t = times[idx];
  const seen = times[seenIdx];
  const sf = f.spots.find((s) => s.spot === spot.key);
  const board = scoreboardAt(rows, t, endT);

  const revealed = (x: string | null | undefined) => x != null && Date.parse(x) <= seen;
  const markers: ChartMarker[] = [];
  if (revealed(facts.rc50)) markers.push({ t: facts.rc50!, label: "River Clock: likely", colour: "#184f95" });
  if (facts.official && revealed(facts.official.issuedAt)) markers.push({ t: facts.official.issuedAt, label: "EA warning", colour: "#6250d6" });
  if (revealed(facts.crossing)) markers.push({ t: facts.crossing!, label: "River crossed", colour: "#b02a2a" });

  const eventRange: [number, number] = [Date.parse(replay.start), Math.max(Date.parse(replay.end), times[last] + 72 * HOUR)];

  // Show the working: the Time Machine's details at the playhead.
  const seenT = forecasts[seenIdx].issuedAt;
  const isRevealed = (x: string) => Date.parse(x) <= Date.parse(seenT);
  const warnSentence = tierSentence(warn, isRevealed, endT);
  const alertSentence = tierSentence(alert, isRevealed, endT);

  return (
    <Screen
      headline={
        <Headline sub="Replayed hour by hour with a model trained without this flood: at each moment it sees only what was known then.">
          {headlineText(facts, spot.name, spot.threshold, eventName)}
        </Headline>
      }
      hero={
        <div className="rp-hero">
          <div className="rp-main">
            <div className="rp-mapcol">
              <ReplayMap spots={spots} forecast={f} selected={spot.key} onSelect={onSelectSpot} />
              <div className="rp-map-caption small">Each clock: chance of flooding within 3 days, as River Clock said at the playhead.</div>
            </div>
            <div className="rp-chartcol">
              <div className="rp-chart-title">
                <strong>{shortSpotName(spot.name)}</strong> river level · <span className="rp-now">{formatDateTimeYear(f.issuedAt)}</span>
              </div>
              <ReplayChart
                observed={replay.observed[spot.gauge] ?? []}
                now={t}
                seen={seen}
                forecast={sf}
                threshold={spot.threshold}
                usualHigh={spot.amber}
                eventRange={eventRange}
                markers={markers}
              />
              <ChartKey />
              <div className="rp-controls">
                <button className="btn primary rp-play" onClick={togglePlay} aria-keyshortcuts="Space">
                  {play.on ? "❚❚ Pause" : "▶ Play"}
                </button>
                <span className="speed" role="group" aria-label="Playback speed">
                  {SPEEDS.map((s) => (
                    <button key={s} className="btn" aria-pressed={speed === s} onClick={() => setSpeed(s)}>
                      {s}×
                    </button>
                  ))}
                </span>
                <button className="btn" onClick={() => jump(startIndex(replay, spot, facts))}>
                  Restart
                </button>
                <input
                  className="rp-slider"
                  type="range"
                  min={0}
                  max={last}
                  value={idx}
                  onChange={(e) => jump(Number(e.target.value))}
                  aria-label="Replay time"
                  aria-valuetext={formatDateTimeYear(f.issuedAt)}
                />
              </div>
              <div className="small muted">Space: play or pause · ← →: step (Shift: 6 steps)</div>
            </div>
          </div>
          {picker}
        </div>
      }
      aside={
        <>
          {spotPicker}
          <Scoreboard rows={board} title={`${shortSpotName(spot.name)}, ${eventName}`} />
        </>
      }
      working={
        <div className="rp-working">
          <div>
            <h3>{spot.name} at {formatDateTimeYear(f.issuedAt)}</h3>
            <ProbBars sf={sf} issuedAt={f.issuedAt} />
            <p>
              <strong>{arrivalSentence(sf, f.stale.includes(spot.gauge), spot.threshold)}</strong>
            </p>
            {warnSentence && <p>{warnSentence}</p>}
            {alertSentence && <p>{alertSentence}</p>}
            <p className="small muted">
              The peak row compares the real highest level with the 5–95% range River Clock gave {facts.peakBand?.leadH ?? 72} h
              before it. Lead vs the EA comes from proof.json (positive: River Clock earlier). The full Time Machine is under{" "}
              <a href="#/working/time-machine">Show the working → Time Machine</a>.
            </p>
          </div>
          <div>
            <h3>Upstream at this time</h3>
            <RiverStrip stations={stations} pairs={pairs} series={replay.observed} until={f.issuedAt} />
          </div>
        </div>
      }
    />
  );
}
