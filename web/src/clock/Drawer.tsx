// "Show the working" drawer (#118 one screen): everything that isn't the one
// screen (trust charts, sandbag screening, the old tabs) in a panel over it,
// loaded only when its tab opens. Hash #/working/<tab>; Esc or × closes it.
import { Suspense, lazy, useEffect, useRef } from "react";
import { Disclaimer } from "../components/shared/Disclaimer";
import { useHiddenSpots } from "./hiddenSpots";

export const WORKING_TABS = [
  { id: "trust", label: "How good is it?", View: lazy(() => import("../screens/Trust")) },
  { id: "protect", label: "Protect (sandbags)", View: lazy(() => import("../screens/Protect")) },
  { id: "river", label: "Live gauges", View: lazy(() => import("../views/River")) },
  { id: "time-machine", label: "Time Machine", View: lazy(() => import("../views/TimeMachine")) },
  { id: "decide", label: "Decide (cost–loss)", View: lazy(() => import("../views/Decide")) },
  { id: "proof", label: "Proof", View: lazy(() => import("../views/Proof")) },
  { id: "about", label: "About and credits", View: lazy(() => import("../views/About")) },
] as const;

export type WorkingId = (typeof WORKING_TABS)[number]["id"];

/** The tab a hash names, or the first one. */
export function tabFor(id: string | null): WorkingId {
  return (WORKING_TABS.find((t) => t.id === id)?.id ?? WORKING_TABS[0].id) as WorkingId;
}

export function Drawer({ tab, onTab, onClose }: { tab: WorkingId; onTab: (id: WorkingId) => void; onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const current = WORKING_TABS.find((t) => t.id === tab) ?? WORKING_TABS[0];
  const View = current.View;
  const hidden = useHiddenSpots();
  return (
    <div className="rc-drawer-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="rc-drawer" role="dialog" aria-modal="true" aria-label="Info">
        <header className="rc-drawer-head">
          <h2>Info</h2>
          <nav className="rc-drawer-tabs" aria-label="Working tabs">
            {WORKING_TABS.map((t) => (
              <button key={t.id} type="button" className="btn" aria-pressed={t.id === tab} onClick={() => onTab(t.id)}>
                {t.label}
              </button>
            ))}
          </nav>
          <button ref={close} type="button" className="rc-drawer-close" onClick={onClose} aria-label="Close Info">
            ×
          </button>
        </header>
        <div className="rc-drawer-body">
          {/* Map v3 (#152) shows only spots with data in the view; the rest are named here. */}
          {hidden.length > 0 && (
            <p className="rc-drawer-hidden">
              <strong>Not on the map right now:</strong>{" "}
              {hidden.map((h, i) => (
                <span key={h.key}>
                  {i > 0 && "; "}
                  {h.name} ({h.why})
                </span>
              ))}
              .
            </p>
          )}
          <Suspense fallback={<p className="muted">Loading…</p>}>
            <View />
          </Suspense>
        </div>
        <Disclaimer />
      </aside>
    </div>
  );
}
