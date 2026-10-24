// "Start here" landing (#118): one question, one sentence, three big buttons
// (Now · Replay · Protect) and a small fourth link to "How good is it?". The
// number on each button is also its key. Shown on first visit; any screen
// change (button, key 1–4, header nav) closes it. Dismissal is a per-viewer
// convenience in localStorage, wrapped in try/catch so it works without storage.
import { useEffect, useState } from "react";
import { NAVIGATE_EVENT, navigate, type Route } from "./presenter";

const KEY = "riverclock.startHere.dismissed";

export const START_TITLE = "Will Oxford flood in the next 3 days, and when?";
export const START_LEAD =
  "River Clock watches the river gauges upstream and counts down to when the water reaches five Oxford trouble spots.";

export const START_BUTTONS: { route: Route; title: string; text: string }[] = [
  { route: "now", title: "Now", text: "Where is the water now, and when does it get here?" },
  { route: "replay", title: "Replay", text: "Watch River Clock call the January 2014 flood, hour by hour." },
  { route: "protect", title: "Protect", text: "Where would sandbags do the most good, and by when?" },
];

/** The small fourth link, under the three big buttons. */
export const START_TRUST = { route: "trust" as Route, title: "How good is it?", text: "how often it was right before" };

function read(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}
function write(v: boolean): void {
  try {
    if (v) window.localStorage.setItem(KEY, "1");
    else window.localStorage.removeItem(KEY);
  } catch {
    // Storage blocked: the landing just shows again next time.
  }
}

/** Show the landing on first visit unless the URL already names a screen. */
export function useStartHere(): { open: boolean; show: () => void; hide: () => void } {
  const [open, setOpen] = useState(() => !read() && !/^#\/?\w/.test(window.location.hash));
  const hide = () => {
    write(true);
    setOpen(false);
  };
  // Picking a screen any way at all (key 1–4, the header nav) closes the landing.
  useEffect(() => {
    if (!open) return;
    const on = () => {
      write(true);
      setOpen(false);
    };
    window.addEventListener(NAVIGATE_EVENT, on);
    return () => window.removeEventListener(NAVIGATE_EVENT, on);
  }, [open]);
  return {
    open,
    show: () => {
      write(false);
      setOpen(true);
    },
    hide,
  };
}

export function StartHere({ onDone }: { onDone: () => void }) {
  return (
    <div className="ui-start" role="region" aria-labelledby="ui-start-title">
      <div className="ui-start-head">
        <h1 id="ui-start-title" className="ui-start-title">
          {START_TITLE}
        </h1>
        <p className="ui-start-lead">{START_LEAD}</p>
      </div>
      <div className="ui-start-buttons">
        {START_BUTTONS.map((b, i) => (
          <button key={b.route} className="ui-start-button" onClick={() => navigate(b.route)} aria-keyshortcuts={String(i + 1)}>
            <span className="ui-start-n" aria-hidden="true">
              {i + 1}
            </span>
            <span className="ui-start-name">{b.title}</span>
            <span className="ui-start-text">{b.text}</span>
          </button>
        ))}
      </div>
      <button className="ui-start-trust" onClick={() => navigate(START_TRUST.route)} aria-keyshortcuts="4">
        <kbd className="ui-key">4</kbd> <strong>{START_TRUST.title}</strong> See {START_TRUST.text}.
      </button>
      <p className="ui-start-keys">
        Keys <kbd className="ui-key">1</kbd>–<kbd className="ui-key">4</kbd> switch screens ·{" "}
        <kbd className="ui-key">Space</kbd> plays · <kbd className="ui-key">P</kbd> presenter mode ·{" "}
        <button className="ui-start-skip" onClick={onDone}>
          Skip
        </button>
      </p>
    </div>
  );
}
