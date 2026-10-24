// "Start here" landing (#118): one sentence and three big buttons, shown on
// first visit and dismissible. Dismissal is a per-viewer convenience in
// localStorage, wrapped in try/catch so the page works without storage.
import { useState } from "react";
import { navigate, type Route } from "./presenter";

const KEY = "riverclock.startHere.dismissed";

export const START_BUTTONS: { route: Route; title: string; text: string }[] = [
  { route: "now", title: "Now", text: "Where is the water, and when does it get here?" },
  { route: "replay", title: "Replay", text: "Watch River Clock call the January 2014 flood." },
  { route: "protect", title: "Protect", text: "Where would sandbags do the most good, and by when?" },
];

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
  return {
    open,
    show: () => {
      write(false);
      setOpen(true);
    },
    hide: () => {
      write(true);
      setOpen(false);
    },
  };
}

export function StartHere({ onDone }: { onDone: () => void }) {
  return (
    <div className="ui-start" role="dialog" aria-modal="false" aria-labelledby="ui-start-title">
      <h1 id="ui-start-title" className="ui-start-title">
        Oxford floods slowly, from upstream. River Clock reads the river like a clock and tells you when the water
        will get here.
      </h1>
      <div className="ui-start-buttons">
        {START_BUTTONS.map((b, i) => (
          <button
            key={b.route}
            className="ui-start-button"
            onClick={() => {
              navigate(b.route);
              onDone();
            }}
          >
            <span className="ui-start-n">{i + 1}</span>
            <span className="ui-start-name">{b.title}</span>
            <span className="ui-start-text">{b.text}</span>
          </button>
        ))}
      </div>
      <button className="ui-start-skip" onClick={onDone}>
        Skip
      </button>
    </div>
  );
}
