// "Start here": a dismissible three-step path for a walk-up judge (#103;
// presentation research rec. 10). Shown on first visit; the header's
// "Start here" button brings it back. Dismissal is a per-viewer convenience in
// localStorage, wrapped in try/catch so the page works without storage.
import { useState } from "react";

const KEY = "riverclock.startHere.dismissed";

export const START_STEPS = [
  { tab: "river", title: "The water travels", text: "Rises upstream reach Oxford hours to days later. See today's river." },
  { tab: "time-machine", title: "Replay 2014", text: "Watch River Clock forecast a real flood, seeing only what was known at the time." },
  { tab: "decide", title: "Would it have helped you?", text: "Pick who you are and see when acting is worth it." },
] as const;

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(v: boolean): void {
  try {
    if (v) window.localStorage.setItem(KEY, "1");
    else window.localStorage.removeItem(KEY);
  } catch {
    // Storage blocked (private window, preview): the strip just shows again next time.
  }
}

export function useStartHere(): { open: boolean; show: () => void; hide: () => void } {
  const [open, setOpen] = useState(() => !readDismissed());
  return {
    open,
    show: () => {
      writeDismissed(false);
      setOpen(true);
    },
    hide: () => {
      writeDismissed(true);
      setOpen(false);
    },
  };
}

export function StartHere({ current, onHide }: { current: string; onHide: () => void }) {
  return (
    <nav className="start-here" aria-label="Start here">
      <strong className="start-here-label">Start here:</strong>
      <ol>
        {START_STEPS.map((s, i) => (
          <li key={s.tab}>
            <button
              className="btn"
              aria-current={current === s.tab ? "step" : undefined}
              onClick={() => {
                window.location.hash = s.tab;
              }}
              title={s.text}
            >
              <span className="start-here-n">{i + 1}</span> {s.title}
            </button>
          </li>
        ))}
      </ol>
      <button className="btn start-here-close" onClick={onHide} aria-label="Hide the start-here steps">
        Hide
      </button>
    </nav>
  );
}
