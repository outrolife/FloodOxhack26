// Time Machine: replay a past flood hour by hour, seeing only what the model
// saw at each forecast time. The whole replay file is preloaded, so moving the
// slider never loads anything.
import { useEffect, useMemo, useState } from "react";
import type { EventsFile, Replay, SpotsFile, StationsFile, TravelTimesFile } from "../contracts";
import { useData } from "../data";
import { HOUR, formatDateTime, hoursBetween } from "../time";
import { FanChart, type Marker } from "../components/timemachine/FanChart";
import { FixtureNotice, Pending } from "../components/shared/DataNotice";
import { ProbBars } from "../components/shared/ProbBars";
import { RiverStrip } from "../components/shared/RiverStrip";
import { arrivalSentence, pFloodMax } from "../components/shared/forecast";

const SIM_HOURS_PER_2S = 12; // SPEC §10.2: one simulated 12 h per 2 s

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

  const ready =
    events.status === "ready" && spots.status === "ready" && stations.status === "ready" && travel.status === "ready";
  if (!ready) return <Pending states={[events, spots, stations, travel]} />;

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
            travel={travel.data}
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

  useEffect(() => setSeenIdx((s) => Math.max(s, idx)), [idx]);

  // Play: advance one forecast step at a rate of 12 simulated hours per 2 s.
  useEffect(() => {
    if (!playing) return;
    if (idx >= forecasts.length - 1) {
      setPlaying(false);
      return;
    }
    const stepH = Math.max(hoursBetween(forecasts[idx].issuedAt, forecasts[idx + 1].issuedAt), 0.25);
    const timer = setTimeout(() => setIdx((i) => Math.min(i + 1, forecasts.length - 1)), (2000 * stepH) / SIM_HOURS_PER_2S);
    return () => clearTimeout(timer);
  }, [playing, idx, forecasts]);

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
  const officials = replay.official
    .filter((o) => o.spot === spot.key)
    .sort((a, b) => Date.parse(a.issuedAt) - Date.parse(b.issuedAt));
  const officialWarning = officials.find((o) => o.type !== "alert");
  const officialAlert = officials.find((o) => o.type === "alert");
  const crossing = replay.crossings.find((c) => c.spot === spot.key);

  // Markers appear only once the slider has reached them, so playing the
  // replay tells the story in order (SPEC §17.2).
  const revealed = (t: string | undefined) => t != null && Date.parse(t) <= Date.parse(seenT);
  const markers: Marker[] = [];
  if (first50 && revealed(first50.issuedAt))
    markers.push({ t: first50.issuedAt, label: "River Clock ≥ 50%", colour: "#184f95" });
  if (officialWarning && revealed(officialWarning.issuedAt))
    markers.push({ t: officialWarning.issuedAt, label: `EA ${officialWarning.type}`, colour: "#6250d6" });
  if (crossing && revealed(crossing.t)) markers.push({ t: crossing.t, label: "Threshold crossed", colour: "#d03b3b" });

  const lastF = Date.parse(forecasts[forecasts.length - 1].issuedAt);
  const domain: [number, number] = [Date.parse(replay.start), Math.max(Date.parse(replay.end), lastF + 72 * HOUR)];

  let leadSentence: string | null = null;
  const lastEvent = Math.max(
    first50 ? Date.parse(first50.issuedAt) : 0,
    officialWarning ? Date.parse(officialWarning.issuedAt) : 0,
  );
  if (lastEvent > Date.parse(seenT)) {
    leadSentence = null; // not there yet
  } else if (first50 && officialWarning) {
    const d = hoursBetween(first50.issuedAt, officialWarning.issuedAt);
    const datePrec = officialWarning.precision === "date" ? " (official time known to the day only)" : "";
    leadSentence =
      d >= 0
        ? `River Clock reached 50% ${d.toFixed(0)} h before the official ${officialWarning.type}${datePrec}.`
        : `River Clock reached 50% ${(-d).toFixed(0)} h after the official ${officialWarning.type}${datePrec}.`;
  } else if (first50) {
    leadSentence = "River Clock reached 50%; no official flood warning for this spot so far.";
  } else if (officialWarning) {
    leadSentence = `River Clock never reached 50% for this spot; the EA issued a ${officialWarning.type}.`;
  }

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
          <button
            className="btn primary"
            onClick={() => {
              if (idx >= forecasts.length - 1) setIdx(0);
              setPlaying((p) => !p);
            }}
          >
            {playing ? "Pause" : "Play"}
          </button>
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
        />
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
          {leadSentence && <p><strong>{leadSentence}</strong></p>}
          {officialAlert && revealed(officialAlert.issuedAt) && <p>EA flood alert for the area issued {formatDateTime(officialAlert.issuedAt)}.</p>}
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
