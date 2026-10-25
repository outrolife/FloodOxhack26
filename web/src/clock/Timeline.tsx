// The one-screen UI's hero chart (#135): wide and short, under the flow map.
// For the selected spot: River Clock's forecast fan from the playhead (middle
// line and likely range), the real level (solid up to the playhead − 1 h, #93;
// faint where the playhead has already been), the flood level and usual high
// as labelled lines, and the "River Clock warned · EA warned · Flooded"
// markers as playback passes them. Space / ←→ arrive as rc:playpause / rc:step.
//
// Reuses the Replay screen's chart, facts, start index and playback clock.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Forecast, Replay, Spot } from "../contracts";
import { HOUR, formatDateTimeYear } from "../time";
import { usePlayerKeys } from "../ui/presenter";
import { ReplayChart } from "../screens/replay/ReplayChart";
import { startIndex, type ReplayFacts } from "../screens/replay/facts";
import { indexAt } from "../screens/replay/playback";
import type { ClockEventId } from "./choices";
import { nowMarkers, replayMarkers, storyEnd } from "./story";
import { useClockEvent } from "./useClockEvent";
import { usePlayback } from "./usePlayback";
import "./clock.css";

export type TimelineProps = {
  /** "now" (live.json) or an event id (replays/<id>.json). */
  event: ClockEventId;
  /** Spot key, e.g. "botley". */
  spot: string;
  /** Called with the playhead (forecast issue time, epoch ms) whenever it moves. For Now: the live issue time. */
  onTime?: (t: number) => void;
  /** Seek to this time (epoch ms) when it changes; pauses playback. Passing back the value from onTime is a no-op. */
  t?: number;
  /** Start (true) or pause (false) playback. Omitted: a flood at this spot plays when it loads, a calm event waits. */
  playing?: boolean;
};

export function Timeline({ event, spot, onTime, t, playing }: TimelineProps) {
  const data = useClockEvent(event, spot);
  if (data.status === "loading")
    return (
      <div className="ck-timeline ck-pending is-loading" aria-busy="true">
        Loading…
      </div>
    );
  if (data.status === "missing") return <div className="ck-timeline ck-pending">{data.message}</div>;
  if (data.kind === "now") return <NowTimeline live={data.live} spot={data.spot} pStar={data.pStar} onTime={onTime} />;
  return (
    <ReplayTimeline key={data.replay.eventId} replay={data.replay} spot={data.spot} facts={data.facts} onTime={onTime} t={t} playing={playing} />
  );
}

/** Keeps the latest callback without re-running effects when the parent passes a new function. */
function useLatest<T>(v: T) {
  const r = useRef(v);
  r.current = v;
  return r;
}

export function NowTimeline({ live, spot, pStar, onTime }: { live: Forecast; spot: Spot; pStar?: number; onTime?: (t: number) => void }) {
  const now = Date.parse(live.issuedAt);
  const cb = useLatest(onTime);
  useEffect(() => cb.current?.(now), [now, cb]);
  const observed = live.observed?.[spot.gauge] ?? [];
  const sf = (live.stale ?? []).includes(spot.gauge) ? undefined : live.spots?.find((s) => s.spot === spot.key);
  const first = observed.length ? Date.parse(observed[0].t) : now - 7 * 24 * HOUR;
  return (
    <div className="ck-timeline">
      <div className="ck-chart">
        <ReplayChart
          observed={observed}
          now={now}
          seen={now}
          forecast={sf}
          threshold={spot.threshold}
          usualHigh={spot.amber}
          eventRange={[first, now + 84 * HOUR]}
          markers={nowMarkers(live, spot, pStar)}
        />
      </div>
      <div className="ck-bar">
        <TimelineKey />
        <span className="ck-when">Forecast {formatDateTimeYear(live.issuedAt)}</span>
      </div>
    </div>
  );
}

export function ReplayTimeline({
  replay,
  spot,
  facts,
  onTime,
  t,
  playing,
}: {
  replay: Replay;
  spot: Spot;
  facts: ReplayFacts;
  onTime?: (t: number) => void;
  t?: number;
  playing?: boolean;
}) {
  const forecasts = replay.forecasts ?? [];
  const last = forecasts.length - 1;
  const times = useMemo(() => forecasts.map((f) => Date.parse(f.issuedAt)), [forecasts]);
  const endT = forecasts[last]?.issuedAt ?? replay.end;
  // Where the story starts: 72 h before River Clock's call for a flood, River Clock's highest chance for a calm event.
  const [start] = useState(() => startIndex(replay, spot, facts));
  const stopAt = useMemo(() => storyEnd(facts, endT), [facts, endT]);
  const pb = usePlayback(times, start, stopAt, playing ?? facts.crossing != null);
  const { idx, seenIdx, jump, setPlaying, toggle } = pb;

  // The `playing` prop after mount (the first value is the autoplay above).
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (playing !== undefined) setPlaying(playing);
  }, [playing, setPlaying]);

  // Tell the shell where the playhead is; remember it so the echo back through `t` is ignored.
  const cb = useLatest(onTime);
  const emitted = useRef<number | null>(null);
  const now = times[idx];
  useEffect(() => {
    if (now == null) return;
    emitted.current = now;
    cb.current?.(now);
  }, [now, cb]);
  // Seek only when `t` changes after mount: a `t` left over from the previous event must not stop autoplay.
  const prevT = useRef(t);
  useEffect(() => {
    if (t === prevT.current) return;
    prevT.current = t;
    if (t == null || t === emitted.current || times.length === 0) return;
    jump(indexAt(times, t));
  }, [t, times, jump]);

  const idxRef = useLatest(idx);
  usePlayerKeys(toggle, (delta) => jump(idxRef.current + delta));

  if (forecasts.length === 0) return <div className="ck-timeline ck-pending">This replay has no forecasts</div>;

  const f = forecasts[idx];
  const sf = f.spots.find((s) => s.spot === spot.key);
  const eventRange: [number, number] = [Date.parse(replay.start), Math.max(Date.parse(replay.end), times[last] + 72 * HOUR)];

  return (
    <div className="ck-timeline">
      <div className="ck-chart">
        <ReplayChart
          observed={replay.observed?.[spot.gauge] ?? []}
          now={now}
          seen={times[seenIdx]}
          forecast={sf}
          threshold={spot.threshold}
          usualHigh={spot.amber}
          eventRange={eventRange}
          markers={replayMarkers(facts, times[seenIdx])}
        />
      </div>
      <div className="ck-bar">
        <button type="button" className="btn primary ck-play" onClick={toggle} aria-keyshortcuts="Space">
          {pb.playing ? "❚❚ Pause" : "▶ Play"}
        </button>
        <input
          className="ck-scrub"
          type="range"
          min={0}
          max={last}
          value={idx}
          onChange={(e) => jump(Number(e.target.value))}
          aria-label="Replay time"
          aria-valuetext={formatDateTimeYear(f.issuedAt)}
        />
        <span className="ck-when">{formatDateTimeYear(f.issuedAt)}</span>
      </div>
      <TimelineKey />
    </div>
  );
}

/** The chart's key, in words (never colour alone). Flood level and usual high are labelled on the chart. */
export function TimelineKey() {
  return (
    <div className="ck-key small">
      <span>
        <i className="ck-sw ck-sw-real" /> Real level
      </span>
      <span>
        <i className="ck-sw ck-sw-band" /> FloodClock: likely range
      </span>
      <span>
        <i className="ck-sw ck-sw-mid" /> middle
      </span>
    </div>
  );
}
