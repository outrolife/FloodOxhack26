// Data loading for River Clock.
//
// Every contract file (SPEC §9) lives at /data/<file>.json, served from
// web/public/data/. If a file is missing (or isn't valid JSON), we fall back to
// the matching sample in tests/fixtures/, which Vite bundles at build time.
// Nothing here needs the network, so the app runs fully offline.
// The one exception is live mode (/api/live), which degrades gracefully.

import { useEffect, useState } from "react";

export type Source = "data" | "fixture";
export type Loaded<T> = { value: T; source: Source; file: string };

// Lazily bundled fixtures, keyed by path relative to tests/fixtures/
// (e.g. "stations.json", "replays/e2014.json").
const FIXTURE_PREFIX = "../../tests/fixtures/";
const fixtureModules = import.meta.glob<unknown>("../../tests/fixtures/**/*.json", {
  import: "default",
});
const fixtures: Record<string, () => Promise<unknown>> = {};
for (const [k, load] of Object.entries(fixtureModules)) {
  fixtures[k.slice(FIXTURE_PREFIX.length)] = load;
}

/** Names a fixture might use for a given data path, most specific first. */
function fixtureCandidates(file: string): string[] {
  const out = [file];
  const m = /^replays\/(.+)\.json$/.exec(file);
  if (m) {
    const id = m[1];
    out.push(`replay_${id}.json`, `replay-${id}.json`, `${id}.json`, "replays/replay.json", "replay.json");
    // Any replay fixture beats nothing: the scaffold just needs a sample.
    for (const k of Object.keys(fixtures)) {
      if (k.startsWith("replays/") || k.startsWith("replay")) out.push(k);
    }
  }
  if (file === "live.json") out.push("forecast.json");
  out.push(`stretch/${file}`); // stretch contracts (SPEC §11) keep fixtures in stretch/
  return out;
}

export function hasFixture(file: string): boolean {
  return fixtureCandidates(file).some((c) => c in fixtures);
}

async function fetchJson(url: string, timeoutMs = 8000): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-cache" });
    // Vite's dev server answers unknown paths with index.html (200), so also
    // check the content type before trusting the body.
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !type.includes("json")) throw new Error(`${url}: ${res.status} ${type}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const cache = new Map<string, Promise<Loaded<unknown>>>();

// Files whose top level is an array (contracts.ts "File shapes"); all others are objects.
const LIST_FILES = new Set(["stations.json", "spots.json", "events.json", "travel_times.json"]);

/** Load /data/<file> (e.g. "stations.json" or "replays/e2014.json"). */
export function loadData<T>(file: string): Promise<Loaded<T>> {
  let p = cache.get(file);
  if (!p) {
    p = (async (): Promise<Loaded<unknown>> => {
      try {
        const value = await fetchJson(`${import.meta.env.BASE_URL}data/${file}`);
        // Cheap shape guard so a half-written or wrong-shaped file can't blank a tab.
        if (LIST_FILES.has(file) !== Array.isArray(value) || typeof value !== "object" || value === null) {
          throw new Error(`${file}: unexpected top-level shape`);
        }
        return { value, source: "data", file };
      } catch (e) {
        if (e instanceof Error && e.message.includes("unexpected top-level shape")) console.warn(e.message);
        for (const c of fixtureCandidates(file)) {
          const load = fixtures[c];
          if (load) return { value: await load(), source: "fixture", file: c };
        }
        throw new Error(`No data for ${file} (not in web/public/data/ and no fixture)`);
      }
    })();
    cache.set(file, p);
    p.catch(() => cache.delete(file));
  }
  return p as Promise<Loaded<T>>;
}

/** Live forecast from the API. Resolves to null when the API isn't reachable. */
export async function loadLive<T>(): Promise<T | null> {
  try {
    return (await fetchJson("/api/live", 5000)) as T;
  } catch {
    return null;
  }
}

export type AsyncState<T> =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; data: T; source: Source };

/** React hook around loadData. Pass null to skip loading. */
export function useData<T>(file: string | null): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ status: "loading" });
  useEffect(() => {
    if (!file) return;
    let alive = true;
    setState({ status: "loading" });
    loadData<T>(file).then(
      (r) => alive && setState({ status: "ready", data: r.value, source: r.source }),
      (e: unknown) => alive && setState({ status: "error", error: String(e) }),
    );
    return () => {
      alive = false;
    };
  }, [file]);
  return state;
}
