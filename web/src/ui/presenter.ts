// One-screen routing and presenter keys (#118).
// Hash: #/now or #/<eventId> picks what the screen shows; #/working[/<tab>]
// opens the "Show the working" drawer on top. Old hashes still land somewhere
// sensible. Keys: 1–9 pick the event switch's buttons in order, Space
// play/pause, ←/→ step (Shift: 6 steps), P presenter mode. The Timeline
// listens for the custom events through usePlayerKeys.
import { useEffect, useState } from "react";

export const NOW = "now";

export type View = { event: string | null; working: string | null };

/** Old screen and tab hashes → the event to show or the drawer tab to open. */
const LEGACY: Record<string, View> = {
  replay: { event: "e2014", working: null },
  "time-machine": { event: null, working: "time-machine" },
  river: { event: NOW, working: null },
  protect: { event: null, working: "protect" },
  trust: { event: null, working: "trust" },
  proof: { event: null, working: "trust" },
  decide: { event: null, working: "decide" },
  about: { event: null, working: "about" },
};

/** What a hash asks for. `event: null` = keep the current one. */
export function viewFromHash(hash: string = window.location.hash): View {
  const parts = hash.replace(/^#\/?/, "").split(/[/?]/).filter(Boolean);
  const [head, sub] = parts;
  if (!head) return { event: null, working: null };
  if (head === "working") return { event: null, working: sub ?? "" };
  if (LEGACY[head]) return LEGACY[head];
  return { event: head, working: null };
}

/** Space toggles play/pause on the Timeline. */
export const PLAYPAUSE_EVENT = "rc:playpause";
/** ←/→ step the Timeline; detail.delta is ±1 (Shift: ±6). */
export const STEP_EVENT = "rc:step";
/** Keys 1–9: detail.n is the switch button number (1 = Now). */
export const PICK_EVENT = "rc:pick";
export type StepDetail = { delta: number };
export type PickDetail = { n: number };

/** Keys typed into these elements belong to them, not to the presenter. */
export function ownsKeys(el: EventTarget | null, key: string): boolean {
  if (typeof HTMLElement === "undefined" || !(el instanceof HTMLElement)) return false;
  if (el.isContentEditable || el.tagName === "SELECT" || el.tagName === "TEXTAREA") return true;
  if (el.tagName === "BUTTON" || el.tagName === "A" || el.getAttribute("role") === "button") return key === " " || key === "Enter";
  if (el instanceof HTMLInputElement) return el.type !== "range" || key !== " ";
  return false;
}

export type KeyAction =
  | { kind: "pick"; n: number }
  | { kind: "playpause" }
  | { kind: "step"; delta: number }
  | { kind: "presenter" }
  | null;

/** What a key press means (pure, so it is unit-tested). With the drawer open, the old tabs keep their own keys. */
export function keyAction(key: string, shift: boolean, drawerOpen: boolean): KeyAction {
  if (key === "p" || key === "P") return { kind: "presenter" };
  if (drawerOpen) return null;
  if (/^[1-9]$/.test(key)) return { kind: "pick", n: Number(key) };
  if (key === " ") return { kind: "playpause" };
  if (key === "ArrowRight") return { kind: "step", delta: shift ? 6 : 1 };
  if (key === "ArrowLeft") return { kind: "step", delta: shift ? -6 : -1 };
  return null;
}

/** Current hash view, following hash changes. */
export function useHashView(): View {
  const [view, setView] = useState<View>(() => viewFromHash());
  useEffect(() => {
    const on = () => setView(viewFromHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return view;
}

/** Install the presenter keys; returns presenter-mode state. */
export function usePresenter(drawerOpen: boolean): { presenter: boolean; togglePresenter: () => void } {
  const [presenter, setPresenter] = useState(false);
  useEffect(() => {
    document.documentElement.classList.toggle("presenter", presenter);
  }, [presenter]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || ownsKeys(e.target, e.key)) return;
      const a = keyAction(e.key, e.shiftKey, drawerOpen);
      if (!a) return;
      e.preventDefault();
      if (a.kind === "presenter") setPresenter((p) => !p);
      else if (a.kind === "pick") window.dispatchEvent(new CustomEvent<PickDetail>(PICK_EVENT, { detail: { n: a.n } }));
      else if (a.kind === "playpause") window.dispatchEvent(new CustomEvent(PLAYPAUSE_EVENT));
      else window.dispatchEvent(new CustomEvent<StepDetail>(STEP_EVENT, { detail: { delta: a.delta } }));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);
  return { presenter, togglePresenter: () => setPresenter((p) => !p) };
}

/** For the Timeline: run `onPlayPause` on Space and `onStep(delta)` on ←/→. */
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

/** For the event switch: run `onPick(n)` on keys 1–9. */
export function usePickKeys(onPick: (n: number) => void): void {
  useEffect(() => {
    const on = (e: Event) => onPick((e as CustomEvent<PickDetail>).detail?.n ?? 0);
    window.addEventListener(PICK_EVENT, on);
    return () => window.removeEventListener(PICK_EVENT, on);
  });
}
