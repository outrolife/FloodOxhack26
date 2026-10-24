// Protect screen (#121, #118): "Where would 500 sandbags do the most good, and by when?"
// S3 flood spread + S4 sandbag screening (SPEC §11), promoted into the core.
// Data: spread/{e2014|live}/manifest.json + PNG frames, spread/{…}/sandbags.json,
// geo/recorded_outlines.json. Logic in protect/logic.ts; layout in protect/ProtectView.tsx.
import { useCallback, useEffect, useState } from "react";
import type { Sandbags, SpreadManifest } from "../contracts";
import { DEFAULT_LEAD, manifestFile, usableManifest } from "../components/spread/frames";
import { useData } from "../data";
import { Headline, Screen, usePlayerKeys } from "../ui";
import { DEFAULT_BUDGET, type OutlineCollection, framesForIssue, outlineCovering } from "./protect/logic";
import { ProtectMap } from "./protect/ProtectMap";
import { type Context, ProtectMissing, ProtectView } from "./protect/ProtectView";

const PLAY_MS = 1400;

export default function Protect() {
  const [context, setContext] = useState<Context>("e2014");
  const manifestState = useData<SpreadManifest>(manifestFile(context));
  const bagsState = useData<Sandbags>(`spread/${context}/sandbags.json`);
  const outlines = useData<OutlineCollection>(context === "live" ? null : "geo/recorded_outlines.json");

  const [budget, setBudget] = useState<number | null>(null);
  const [tau, setTau] = useState<number>(DEFAULT_LEAD);
  const [playing, setPlaying] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  // Only real runs count (never the test fixtures), as on the old River tab.
  const manifest = usableManifest(manifestState);
  const sandbags = usableManifest(bagsState);
  const taus = manifest && sandbags ? framesForIssue(manifest, sandbags.issuedAt).map((f) => f.tau) : [];
  const tausKey = taus.join(",");

  const step = useCallback(
    (delta: number) => {
      const list = tausKey ? tausKey.split(",").map(Number) : [];
      if (list.length === 0) return;
      setTau((cur) => {
        const i = list.findIndex((t) => t >= cur);
        const at = i < 0 ? list.length - 1 : i;
        return list[(at + delta + list.length) % list.length];
      });
    },
    [tausKey],
  );
  usePlayerKeys(() => setPlaying((p) => !p), step);

  // "Play the hours": step through the frames, stopping at the last one.
  useEffect(() => {
    if (!playing || !tausKey) return;
    const next = tausKey
      .split(",")
      .map(Number)
      .find((t) => t > tau);
    const id = window.setTimeout(() => (next === undefined ? setPlaying(false) : setTau(next)), PLAY_MS);
    return () => window.clearTimeout(id);
  }, [playing, tausKey, tau]);

  const switchTo = (c: Context) => {
    setContext(c);
    setSelected(null);
    setPlaying(false);
  };
  const play = (on: boolean) => {
    // Playing from the last frame starts again at the first.
    if (on && taus.length && tau >= taus[taus.length - 1]) setTau(taus[0]);
    setPlaying(on);
  };

  if (manifestState.status === "loading" || bagsState.status === "loading") {
    return <Screen headline={<Headline>Loading the flood-spread run…</Headline>} hero={<div className="ui-placeholder">Loading…</div>} />;
  }
  if (!manifest || !sandbags) return <ProtectMissing context={context} onContext={switchTo} />;

  const outline =
    context === "live" ? null : outlineCovering(outlines.status === "ready" ? outlines.data : null, sandbags.issuedAt);

  return (
    <ProtectView
      context={context}
      onContext={switchTo}
      manifest={manifest}
      sandbags={sandbags}
      outline={outline}
      budget={budget ?? sandbags.budget ?? DEFAULT_BUDGET}
      onBudget={setBudget}
      tau={tau}
      onTau={(h) => {
        setPlaying(false);
        setTau(h);
      }}
      playing={playing}
      onPlay={play}
      selected={selected}
      onSelect={setSelected}
      renderMap={(p) => <ProtectMap {...p} />}
    />
  );
}
