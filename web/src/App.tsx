// River Clock shell (#118): four visual-first screens, the old tabs under
// "Show the working", presenter keys, a first-visit "Start here" landing and
// the disclaimer on every screen. Owner: s-s01s-ux (web/src/ui/, App.tsx).
import { lazy, Suspense, useEffect, useState } from "react";
import { Disclaimer } from "./components/shared/Disclaimer";
import { ROUTES, ROUTE_LABEL, navigate, useRoute, usePresenter, type Route } from "./ui/presenter";
import { StartHere, useStartHere } from "./ui/StartHere";
import "./ui/ui.css";
import Now from "./screens/Now";
import Replay from "./screens/Replay";
import Protect from "./screens/Protect";
import Trust from "./screens/Trust";

// The old tabs stay reachable under "Show the working" (not deleted), loaded on demand.
const River = lazy(() => import("./views/River"));
const TimeMachine = lazy(() => import("./views/TimeMachine"));
const Decide = lazy(() => import("./views/Decide"));
const Proof = lazy(() => import("./views/Proof"));
const About = lazy(() => import("./views/About"));

export const WORKING_TABS = [
  { id: "river", label: "River (live detail)", View: River },
  { id: "time-machine", label: "Time Machine", View: TimeMachine },
  { id: "decide", label: "Decide (cost–loss)", View: Decide },
  { id: "proof", label: "Proof", View: Proof },
  { id: "about", label: "About and credits", View: About },
] as const;
type WorkingId = (typeof WORKING_TABS)[number]["id"];

const SCREENS: Record<Exclude<Route, "working">, () => React.ReactElement> = { now: Now, replay: Replay, protect: Protect, trust: Trust };

function workingFromHash(): WorkingId {
  const sub = window.location.hash.replace(/^#\/?working\/?/, "").split(/[/?]/)[0];
  return (WORKING_TABS.find((t) => t.id === sub)?.id ?? "proof") as WorkingId;
}

function Working() {
  const [tab, setTab] = useState<WorkingId>(workingFromHash);
  useEffect(() => {
    const on = () => setTab(workingFromHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const current = WORKING_TABS.find((t) => t.id === tab) ?? WORKING_TABS[3];
  const View = current.View;
  return (
    <div className="ui-working-page">
      <p className="ui-working-intro">
        The expert detail behind the four screens: every chart, table and caveat, as built for the original tabs.
      </p>
      <nav className="ui-subtabs" aria-label="Show the working">
        {WORKING_TABS.map((t) => (
          <button
            key={t.id}
            className="btn"
            aria-pressed={t.id === tab}
            onClick={() => {
              window.location.hash = `/working/${t.id}`;
            }}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <View />
      </Suspense>
    </div>
  );
}

export default function App() {
  const route = useRoute();
  const { presenter, togglePresenter } = usePresenter(route);
  const start = useStartHere();
  const Current = route === "working" ? Working : SCREENS[route];

  return (
    <div className="ui-app">
      <header className="ui-header">
        <a
          className="ui-brand"
          href="#/now"
          onClick={(e) => {
            e.preventDefault();
            start.show();
          }}
          title="Back to Start here"
        >
          River Clock
        </a>
        <nav className="ui-nav" aria-label="Screens">
          {ROUTES.map((r, i) => (
            <button key={r} className="ui-nav-item" aria-current={r === route ? "page" : undefined} onClick={() => navigate(r)}>
              {i < 4 && <kbd className="ui-key">{i + 1}</kbd>}
              {ROUTE_LABEL[r]}
            </button>
          ))}
        </nav>
        <button className="ui-presenter-toggle" aria-pressed={presenter} onClick={togglePresenter} title="Presenter mode (P)">
          <kbd className="ui-key">P</kbd> Presenter
        </button>
      </header>
      {start.open ? (
        <StartHere onDone={start.hide} />
      ) : (
        <main className="ui-main" aria-label={ROUTE_LABEL[route]}>
          <Current />
        </main>
      )}
      <footer className="ui-footer">
        <Disclaimer />
      </footer>
    </div>
  );
}
