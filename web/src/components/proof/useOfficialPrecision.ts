// Which official EA issue times are known to the day only (SPEC §8.2:
// "Fallback if dates only: compare in days, set precision: "date", and say so
// in the UI"). proof.json doesn't carry precision, so we read it from each
// event's replay (official[].precision). Replays load in the background and are
// cached, so the Time Machine reuses them. A replay fixture for a different
// event is ignored. An optional per-row `officialPrecision` on proof.perEvent
// (proposed in #38) is honoured too.
import { useEffect, useState } from "react";
import type { Proof, Replay } from "../../contracts";
import { loadData } from "../../data";

export type PrecisionInfo = {
  /** "eventId:spot" pairs whose official comparison is date-only. */
  dateOnly: Set<string>;
  /** Events whose replay we could read (others are unknown). */
  checked: Set<string>;
};

export const precisionKey = (eventId: string, spot: string) => `${eventId}:${spot}`;

export function useOfficialPrecision(proof: Proof | null): PrecisionInfo {
  const [info, setInfo] = useState<PrecisionInfo>({ dateOnly: new Set(), checked: new Set() });

  useEffect(() => {
    if (!proof) return;
    let alive = true;
    const dateOnly = new Set<string>();
    for (const r of proof.perEvent) {
      const p = (r as { officialPrecision?: string }).officialPrecision;
      if (p === "date") dateOnly.add(precisionKey(r.eventId, r.spot));
    }
    const ids = [...new Set(proof.perEvent.map((r) => r.eventId))];
    Promise.allSettled(ids.map((id) => loadData<Replay>(`replays/${id}.json`))).then((results) => {
      if (!alive) return;
      const checked = new Set<string>();
      results.forEach((res, i) => {
        if (res.status !== "fulfilled" || res.value.value.eventId !== ids[i]) return;
        checked.add(ids[i]);
        for (const o of res.value.value.official) {
          if (o.precision === "date") dateOnly.add(precisionKey(ids[i], o.spot));
        }
      });
      setInfo({ dateOnly, checked });
    });
    return () => {
      alive = false;
    };
  }, [proof]);

  return info;
}
