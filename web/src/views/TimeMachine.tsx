// Time Machine: replay a past flood hour by hour, seeing only what the model
// saw at each forecast time. The whole replay file is preloaded, so moving the
// slider never loads anything.
import { useEffect, useMemo, useState } from "react";
import type { EventsFile, Replay, SpotsFile, StationsFile, TravelTimesFile } from "../contracts";
import { useData } from "../data";
import { HOUR, formatDateTime, hoursBetween } from "../time";
import { FanChart, type Marker } from "../components/timemachine/FanChart";
import { compareSentence, firstOfficials, formatOfficial, officialLabel } from "../components/timemachine/timeline";
import { FixtureNotice, Pending } from "../components/shared/DataNotice";
import { ProbBars } from "../components/shared/ProbBars";
import { RiverStrip } from "../components/shared/RiverStrip";
import { arrivalSentence, pFloodMax } from "../components/shared/forecast";

const SIM_HOURS_PER_2S = 12; // SPEC §10.2: one simulated 12 h per 2 s (speed 1×)
const SPEEDS = [0.5, 1, 2, 4] as const;

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
  // ?step=N in the URL opens the replay at forecast N (handy for demos and screenshots).
  const [idx, setIdx] = useState(() => {
    const step = Number(new URLSearchParams(window.location.search).get("step")) || 0;
    return Math.min(Math.max(step, 0), Math.max(forecasts.length - 1, 0));
  });
  const [seenIdx, setSeenIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(1);
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
  const first50 = forecasts.find((fc) => (pFloodMax(fc.spots.find((s) => s.spot === spot.key)) ?? 0) >= 0.5);
  const { alert: officialAlert, warning: officialWarning } = firstOfficials(replay, spot.key);
  const crossing = replay.crossings.find((c) => c.spot === spot.key);

  // Markers appear only once the slider has reached them, so playing the
  // replay tells the story in order (SPEC §17.2).
  const revealed = (t: string) => Date.parse(t) <= Date.parse(seenT);
  const markers: Marker[] = [];
  if (first50 && revealed(first50.issuedAt))
    markers.push({ t: first50.issuedAt, label: "River Clock ≥ 50%", colour: "#184f95" });
  if (officialAlert && revealed(officialAlert.issuedAt))
    markers.push({ t: officialAlert.issuedAt, label: `EA ${officialLabel(officialAlert)}`, colour: "#a8336a" });
  if (officialWarning && revealed(officialWarning.issuedAt))
    markers.push({ t: officialWarning.issuedAt, label: `EA ${officialLabel(officialWarning)}`, colour: "#6250d6" });
  if (crossing && revealed(crossing.t)) markers.push({ t: crossing.t, label: "Threshold crossed", colour: "#d03b3b" });

  const lastF = Date.parse(forecasts[forecasts.length - 1].issuedAt);
  const domain: [number, number] = [Date.parse(replay.start), Math.max(Date.parse(replay.end), lastF + 72 * HOUR)];

  const warningSentence = compareSentence(first50?.issuedAt, officialWarning, "warning", revealed);
  const alertSentence = compareSentence(first50?.issuedAt, officialAlert, "alert", revealed);

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
          <span className="speed" role="group" aria-label="Playback speed">
            {SPEEDS.map((s) => (
              <button key={s} className="btn" aria-pressed={speed === s} onClick={() => setSpeed(s)}>
                {s}×
              </button>
            ))}
          </span>
          <span className="small">
            Forecast issued <strong>{formatDateTime(sliderT)}</strong>
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
          aria-valuetext={formatDateTime(sliderT)}
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
            Grey line: what actually happened, shown only for times the slider has already passed. The
            model never sees data after its forecast time.
          </p>
        </div>
      </section>
      <aside>
        <div className="card">
          <h2>{spot.name}</h2>
          <p className="sub">At {formatDateTime(sliderT)}</p>
          <ProbBars sf={sf} />
          <p style={{ marginTop: "0.6rem" }}>
            <strong>{arrivalSentence(sf, f.stale.includes(spot.gauge))}</strong>
          </p>
        </div>
        <div className="card">
          <h2>Upstream at this time</h2>
          <RiverStrip stations={stations} pairs={travel} series={replay.observed} until={sliderT} />
        </div>
      </aside>
    </div>
  );
}
