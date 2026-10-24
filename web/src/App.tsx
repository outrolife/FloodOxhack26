import { useEffect, useState } from "react";
import { Disclaimer } from "./components/shared/Disclaimer";
import River from "./views/River";
import TimeMachine from "./views/TimeMachine";
import Decide from "./views/Decide";
import Proof from "./views/Proof";
import About from "./views/About";

// Each tab is self-contained: a view in src/views/ plus its own components
// folder (src/components/<tab>/). Shared pieces live in src/components/shared/.
const TABS = [
  { id: "river", label: "River", View: River },
  { id: "time-machine", label: "Time Machine", View: TimeMachine },
  { id: "decide", label: "Decide", View: Decide },
  { id: "proof", label: "Proof", View: Proof },
  { id: "about", label: "About", View: About },
] as const;
type TabId = (typeof TABS)[number]["id"];

function tabFromHash(): TabId {
  const h = window.location.hash.replace(/^#\/?/, "");
  return (TABS.find((t) => t.id === h)?.id ?? "river") as TabId;
}

export default function App() {
  const [tab, setTab] = useState<TabId>(tabFromHash);

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
        </div>
        <nav className="tabs" role="tablist" aria-label="Sections">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={t.id === tab}
              onClick={() => {
                window.location.hash = t.id;
              }}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>
      <Disclaimer />
      <main role="tabpanel" aria-label={current.label}>
        <View />
      </main>
    </>
  );
}
