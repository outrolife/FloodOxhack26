// River Clock shell (#118, one screen): the brand, the presenter toggle, the
// one screen, the "Show the working" drawer and the disclaimer. The hash keeps
// what's shown (#/now, #/e2014) and the drawer (#/working/<tab>), so a reload
// or a shared link lands in the same place. Owner: s-s01s-ux (web/src/ui/, web/src/clock/, App.tsx).
import { useCallback, useEffect, useState } from "react";
import { Disclaimer } from "./components/shared/Disclaimer";
import { NOW, useHashView, usePresenter } from "./ui/presenter";
import ClockScreen from "./clock/ClockScreen";
import { Drawer, tabFor, type WorkingId } from "./clock/Drawer";
import { WORKING_EVENT } from "./clock/ProofFooter";
import { EVENT_CHOICES } from "./clock/choices";
import "./ui/ui.css";

function InfoIcon() {
  return (
    <svg className="ui-header-link-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="6.8" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="8" cy="4.9" r="0.95" fill="currentColor" />
      <path d="M8 7.2v4.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export default function App() {
  const view = useHashView();
  const known = (id: string | null): id is string => id != null && EVENT_CHOICES.some((c) => c.id === id);
  const [event, setEvent] = useState<string>(() => (known(view.event) ? view.event : NOW));
  useEffect(() => {
    if (known(view.event)) setEvent(view.event);
  }, [view.event]);

  const drawerOpen = view.working != null;
  // The presenter keys (1-9, Space, arrows, P) stay; only the header button went.
  usePresenter(drawerOpen);

  const pick = useCallback((id: string) => {
    setEvent(id);
    window.location.hash = `/${id}`;
  }, []);
  const openTab = (id: WorkingId) => {
    window.location.hash = `/working/${id}`;
  };
  const closeDrawer = useCallback(() => {
    window.location.hash = `/${event}`;
  }, [event]);
  // The proof footer's "Show the working" asks for the drawer through rc:working.
  useEffect(() => {
    const on = () => {
      window.location.hash = "/working";
    };
    window.addEventListener(WORKING_EVENT, on);
    return () => window.removeEventListener(WORKING_EVENT, on);
  }, []);

  return (
    <div className="ui-app">
      <header className="ui-header">
        <a className="ui-brand" href={`#/${NOW}`} onClick={() => setEvent(NOW)}>
          <span className="ui-brand-text">
            <span className="ui-wordmark">
              Flood<span className="ui-wordmark-accent">Clock</span>
            </span>
            <span className="ui-tagline">When will the river reach Oxford's flood spots?</span>
          </span>
        </a>
        <a className="ui-header-link" href="#/working">
          <InfoIcon />
          Info
        </a>
      </header>
      <main className="ui-main" aria-label="FloodClock">
        <ClockScreen event={event} onEvent={pick} />
      </main>
      {drawerOpen && <Drawer tab={tabFor(view.working)} onTab={openTab} onClose={closeDrawer} />}
      <footer className="ui-footer">
        <Disclaimer />
      </footer>
    </div>
  );
}
