// Data for the one-screen components (#135): the live forecast ("now") or one
// replay, plus spots.json and proof.json. Timeline and Scoreboard both call
// this; loadData caches each file, and the live forecast is cached for 15
// minutes (EA live data is polled at most every 15 minutes), so the files are
// fetched once however many components ask.
import { useEffect, useMemo, useState } from "react";
import type { Forecast, Proof, Replay, Spot, SpotsFile } from "../contracts";
import { loadData, loadLive, useData } from "../data";
import { replayFactsFor, warnAtFor, type ReplayFacts } from "../screens/replay/facts";
import type { ClockEventId } from "./choices";

const LIVE_TTL_MS = 15 * 60_000;
let liveCache: { at: number; p: Promise<Forecast | null> } | null = null;

/** The live forecast: the API if it answers, else the committed live.json (or its fixture). */
export function loadLiveOnce(): Promise<Forecast | null> {
  if (!liveCache || Date.now() - liveCache.at > LIVE_TTL_MS) {
    const p = (async () => (await loadLive<Forecast>()) ?? (await loadData<Forecast>("live.json")).value)().catch(() => null);
    liveCache = { at: Date.now(), p };
  }
  return liveCache.p;
}

export type ClockData =
  | { status: "loading" }
  | { status: "missing"; message: string }
  // pStar: the spot's warn-at level (proof.warnAt, else 0.5), for the "River Clock warned" marker and the Scoreboard.
  | { status: "ready"; kind: "now"; live: Forecast; spot: Spot; spots: Spot[]; proof: Proof | null; pStar: number }
  | { status: "ready"; kind: "replay"; replay: Replay; spot: Spot; spots: Spot[]; proof: Proof | null; pStar: number; facts: ReplayFacts };

type Source = { status: "loading" } | { status: "missing" } | { status: "now"; live: Forecast } | { status: "replay"; replay: Replay };

function useSource(event: ClockEventId): Source {
  const [state, setState] = useState<{ event: ClockEventId; src: Source }>({ event, src: { status: "loading" } });
  useEffect(() => {
    let alive = true;
    setState({ event, src: { status: "loading" } });
    const done = (src: Source) => alive && setState({ event, src });
    if (event === "now") {
      loadLiveOnce().then((live) => done(live ? { status: "now", live } : { status: "missing" }));
    } else {
      loadData<Replay>(`replays/${event}.json`).then(
        // The loader falls back to a sample replay for any id: keep only the real one.
        (r) => done(r.value.eventId === event ? { status: "replay", replay: r.value } : { status: "missing" }),
        () => done({ status: "missing" }),
      );
    }
    return () => {
      alive = false;
    };
  }, [event]);
  // Never show the previous event's data for one frame after a switch.
  return state.event === event ? state.src : { status: "loading" };
}

export function useClockEvent(event: ClockEventId, spotKey: string): ClockData {
  const src = useSource(event);
  const spotsState = useData<SpotsFile>("spots.json");
  const proofState = useData<Proof>("proof.json");
  const proof = proofState.status === "ready" ? proofState.data : null;
  const spots = spotsState.status === "ready" ? spotsState.data : null;
  const spot = spots?.find((s) => s.key === spotKey) ?? null;

  const facts = useMemo(
    () => (src.status === "replay" && spot ? replayFactsFor(src.replay, spot, proof) : null),
    [src, spot, proof],
  );

  if (spotsState.status === "error") return { status: "missing", message: "No spot list" };
  if (src.status === "missing") return { status: "missing", message: event === "now" ? "No live forecast" : "No replay for this flood yet" };
  if (src.status === "loading" || !spots || proofState.status === "loading") return { status: "loading" };
  if (!spot) return { status: "missing", message: "Unknown spot" };
  const pStar = warnAtFor(proof, spot.key);
  if (src.status === "now") return { status: "ready", kind: "now", live: src.live, spot, spots, proof, pStar };
  if (!facts) return { status: "loading" };
  return { status: "ready", kind: "replay", replay: src.replay, spot, spots, proof, pStar, facts };
}
