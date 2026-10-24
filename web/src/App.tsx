import { useEffect, useState } from "react";
import { Disclaimer } from "./components/shared/Disclaimer";
import { StartHere, useStartHere } from "./components/shared/StartHere";
import River from "./views/River";
import TimeMachine from "./views/TimeMachine";
import Decide from "./views/Decide";
import Proof from "./views/Proof";
import About from "./views/About";

// Each tab is self-contained: a view in src/views/ plus its own components
// folder (src/components/<tab>/). Shared pieces live in src/components/shared/.
// `hint` says what each tab holds (#103, jargon audit G2).
const TABS = [
  { id: "river", label: "River", hint: "Right now", View: River },
  { id: "time-machine", label: "Time Machine", hint: "Replay a real flood", View: TimeMachine },
  { id: "decide", label: "Decide", hint: "Should I act?", View: Decide },
  { id: "proof", label: "Proof", hint: "Does it work?", View: Proof },
  { id: "about", label: "About", hint: "How it works", View: About },
] as const;
type TabId = (typeof TABS)[number]["id"];

function tabFromHash(): TabId {
  const h = window.location.hash.replace(/^#\/?/, "");
  return (TABS.find((t) => t.id === h)?.id ?? "river") as TabId;
}

export default function App() {
  const [tab, setTab] = useState<TabId>(tabFromHash);
  const start = useStartHere();

  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const current = TABS.find((t) => t.id === tab) ?? TABS[0];
  const View = current.View;

  return (
    <>
      <header className="app-header">
        <div>
          <h1>River Clock</h1>
          <div className="tagline">Water upstream is Oxford's future. We read it as a clock.</div>
          <div className="tagline">Flood forecasts for five Oxford spots, up to 3 days ahead, from river gauges upstream.</div>
        </div>
        <nav className="tabs" role="tablist" aria-label="Sections">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={t.id === tab}
              title={t.hint}
              onClick={() => {
                window.location.hash = t.id;
              }}
            >
              {t.label}
              {" "}<span className="tab-hint">{t.hint}</span>
            </button>
          ))}
          {!start.open && (
            <button className="start-here-open" onClick={start.show} title="Show the three-step path again">
              ? Start here
            </button>
          )}
        </nav>
      </header>
      <Disclaimer />
      {start.open && <StartHere current={tab} onHide={start.hide} />}
      <main role="tabpanel" aria-label={current.label}>
        <View />
      </main>
    </>
  );
}
