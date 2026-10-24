// Live forecast: try the API (/api/live); if it is unreachable, fall back to
// the committed live.json (or its fixture) and say "Live data unavailable".
import { useEffect, useState } from "react";
import type { Forecast } from "../../contracts";
import { loadData, loadLive, type Source } from "../../data";

export type LiveState =
  | { status: "loading" }
  | { status: "ready"; forecast: Forecast; origin: "api" | Source }
  | { status: "none" };

export function useLive(): LiveState {
  const [state, setState] = useState<LiveState>({ status: "loading" });
  useEffect(() => {
    let alive = true;
    (async () => {
      const api = await loadLive<Forecast>();
      if (!alive) return;
      if (api) return setState({ status: "ready", forecast: api, origin: "api" });
      try {
        const saved = await loadData<Forecast>("live.json");
        if (alive) setState({ status: "ready", forecast: saved.value, origin: saved.source });
      } catch {
        if (alive) setState({ status: "none" });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  return state;
}
