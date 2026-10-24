// Presenter mode and routes (#118). Hash routes #/now, #/replay, #/protect,
// #/trust, #/working. Keys: 1–4 screens, Space play/pause, ←/→ step
// (Shift: 6 steps), P presenter mode. Screens listen for the custom events.
import { useEffect, useState } from "react";

export const ROUTES = ["now", "replay", "protect", "trust", "working"] as const;
export type Route = (typeof ROUTES)[number];

export const ROUTE_LABEL: Record<Route, string> = {
  now: "Now",
  replay: "Replay",
  protect: "Protect",
  trust: "How good is it?",
  working: "Show the working",
};

/** Old tab hashes (#river, #time-machine …) still land somewhere sensible. */
const LEGACY: Record<string, Route> = {
  river: "now",
  "time-machine": "replay",
  decide: "working",
  proof: "trust",
  about: "working",
};

/** Space toggles play/pause on the Replay screen. */
export const PLAYPAUSE_EVENT = "rc:playpause";
/** ←/→ step the Replay screen; detail.delta is ±1 (Shift: ±6). */
export const STEP_EVENT = "rc:step";
export type StepDetail = { delta: number };

export function routeFromHash(hash: string = window.location.hash): Route {
  const h = hash.replace(/^#\/?/, "").split(/[/?]/)[0];
  if ((ROUTES as readonly string[]).includes(h)) return h as Route;
  return LEGACY[h] ?? "now";
}

export function navigate(route: Route): void {
  window.location.hash = `/${route}`;
}

/** Current route, following hash changes. */
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => routeFromHash());
  useEffect(() => {
    const on = () => setRoute(routeFromHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

/** Keys typed into these elements belong to them, not to the presenter. */
export function ownsKeys(el: EventTarget | null, key: string): boolean {
  if (typeof HTMLElement === "undefined" || !(el instanceof HTMLElement)) return false;
  if (el.isContentEditable || el.tagName === "SELECT" || el.tagName === "TEXTAREA") return true;
  if (el.tagName === "BUTTON" || el.tagName === "A" || el.getAttribute("role") === "button") return key === " " || key === "Enter";
  if (el instanceof HTMLInputElement) return el.type !== "range" || key !== " ";
  return false;
}

export type KeyAction =
  | { kind: "route"; route: Route }
  | { kind: "playpause" }
  | { kind: "step"; delta: number }
  | { kind: "presenter" }
  | null;

/** What a key press means (pure, so it is unit-tested). `route` is the current screen. */
export function keyAction(key: string, shift: boolean, route: Route): KeyAction {
  const n = ["1", "2", "3", "4"].indexOf(key);
  if (n >= 0) return { kind: "route", route: ROUTES[n] };
  if (key === "p" || key === "P") return { kind: "presenter" };
  // The old Time Machine under "Show the working" handles its own Space and arrows.
  if (route === "working") return null;
  if (key === " ") return { kind: "playpause" };
  if (key === "ArrowRight") return { kind: "step", delta: shift ? 6 : 1 };
  if (key === "ArrowLeft") return { kind: "step", delta: shift ? -6 : -1 };
  return null;
}

/** Install the presenter keys; returns presenter-mode state. */
export function usePresenter(route: Route): { presenter: boolean; togglePresenter: () => void } {
  const [presenter, setPresenter] = useState(false);
  useEffect(() => {
    document.documentElement.classList.toggle("presenter", presenter);
  }, [presenter]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || ownsKeys(e.target, e.key)) return;
      const a = keyAction(e.key, e.shiftKey, route);
      if (!a) return;
      e.preventDefault();
      if (a.kind === "route") navigate(a.route);
      else if (a.kind === "presenter") setPresenter((p) => !p);
      else if (a.kind === "playpause") window.dispatchEvent(new CustomEvent(PLAYPAUSE_EVENT));
      else window.dispatchEvent(new CustomEvent<StepDetail>(STEP_EVENT, { detail: { delta: a.delta } }));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [route]);
  return { presenter, togglePresenter: () => setPresenter((p) => !p) };
}

/** For screens: run `onPlayPause` on Space and `onStep(delta)` on ←/→. */
export function usePlayerKeys(onPlayPause: () => void, onStep: (delta: number) => void): void {
  useEffect(() => {
    const pp = () => onPlayPause();
    const st = (e: Event) => onStep((e as CustomEvent<StepDetail>).detail?.delta ?? 0);
    window.addEventListener(PLAYPAUSE_EVENT, pp);
    window.addEventListener(STEP_EVENT, st);
    return () => {
      window.removeEventListener(PLAYPAUSE_EVENT, pp);
      window.removeEventListener(STEP_EVENT, st);
    };
  });
}
