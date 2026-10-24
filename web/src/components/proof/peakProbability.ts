// Peak flood probability per spot for events that did not flood there (#99:
// the e2026 near miss). proof.perEvent has no peak probability, so we read it
// from the event's own replay file: the highest pFlood River Clock gave at any
// lead in any forecast of the replay. The UI says so in a caption. Replays are
// cached by loadData, so the Time Machine and useOfficialPrecision reuse them.
import { useEffect, useState } from "react";
import type { Proof, Replay } from "../../contracts";
import { loadData } from "../../data";

/** eventId → spot → peak pFlood (0–1). */
export type PeakProbabilities = Record<string, Record<string, number>>;

/** Highest pFlood per spot over every forecast and lead of one replay. Spots with no pFlood (timing only) are left out. */
export function peakPFloodBySpot(replay: Pick<Replay, "forecasts">): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of replay.forecasts) {
    for (const s of f.spots) {
      for (const l of s.leads) {
        if (l.pFlood == null) continue;
        out[s.spot] = Math.max(out[s.spot] ?? 0, l.pFlood);
      }
    }
  }
  return out;
}

/** Events with at least one perEvent row that did not flood: the only ones whose peak we show. */
export function eventsNeedingPeaks(perEvent: Proof["perEvent"]): string[] {
  return [...new Set(perEvent.filter((r) => !r.crossed).map((r) => r.eventId))];
}

export function usePeakProbabilities(proof: Pick<Proof, "perEvent"> | null): PeakProbabilities {
  const [peaks, setPeaks] = useState<PeakProbabilities>({});
  useEffect(() => {
    if (!proof) return;
    let alive = true;
    const ids = eventsNeedingPeaks(proof.perEvent);
    Promise.allSettled(ids.map((id) => loadData<Replay>(`replays/${id}.json`))).then((results) => {
      if (!alive) return;
      const out: PeakProbabilities = {};
      results.forEach((res, i) => {
        // The loader falls back to the sample replay for any id: only use a replay of this event.
        if (res.status !== "fulfilled" || res.value.value.eventId !== ids[i]) return;
        out[ids[i]] = peakPFloodBySpot(res.value.value);
      });
      setPeaks(out);
    });
    return () => {
      alive = false;
    };
  }, [proof]);
  return peaks;
}
