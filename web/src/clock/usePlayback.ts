// Playback for the Timeline (#135): the Replay screen's clock (#120), as a
// hook. Simulated time moves 12 h per 2 real seconds (times the speed) on
// requestAnimationFrame; the forecast shown is the last one issued at or
// before it, so a fast speed skips forecasts instead of queueing them.
import { useCallback, useEffect, useRef, useState } from "react";
import { indexAt, simAdvance } from "../screens/replay/playback";

export type Playback = {
  idx: number;
  /** Furthest index reached (readings up to here may be shown faintly). */
  seenIdx: number;
  playing: boolean;
  toggle: () => void;
  setPlaying: (on: boolean) => void;
  /** Jump to an index and pause. */
  jump: (i: number) => void;
};

/**
 * `times` ascending epoch ms; playback starts at `start`, stops by itself at
 * `stopAt` (epoch ms) if that is ahead, or at the last index.
 */
export function usePlayback(times: number[], start: number, stopAt: number, autoplay: boolean, speed = 1): Playback {
  const last = times.length - 1;
  const [idx, setIdxState] = useState(start);
  const idxRef = useRef(start);
  const setIdx = useCallback((i: number) => {
    idxRef.current = i;
    setIdxState(i);
  }, []);
  const [seenIdx, setSeenIdx] = useState(start);
  useEffect(() => setSeenIdx((s) => Math.max(s, idx)), [idx]);

  const stopFor = useCallback((i: number) => (times[i] < stopAt ? stopAt : null), [times, stopAt]);
  const [play, setPlay] = useState<{ on: boolean; stopAt: number | null }>(() => ({ on: autoplay && last > 0, stopAt: autoplay ? stopFor(start) : null }));

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
      if (i >= last || (play.stopAt != null && sim >= play.stopAt)) {
        setPlay({ on: false, stopAt: null });
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [play, speed, times, last, setIdx]);

  const setPlaying = useCallback(
    (on: boolean) => {
      if (!on) return setPlay({ on: false, stopAt: null });
      // From the end, play again from the start of the story.
      const from = idxRef.current >= last ? start : idxRef.current;
      if (from !== idxRef.current) setIdx(from);
      setPlay({ on: last > 0, stopAt: stopFor(from) });
    },
    [last, start, stopFor, setIdx],
  );
  const toggle = useCallback(() => setPlaying(!play.on), [play.on, setPlaying]);
  const jump = useCallback(
    (i: number) => {
      setPlay({ on: false, stopAt: null });
      setIdx(Math.min(Math.max(i, 0), Math.max(last, 0)));
    },
    [last, setIdx],
  );
  return { idx, seenIdx, playing: play.on, toggle, setPlaying, jump };
}
