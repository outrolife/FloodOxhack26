// "How good is it?" (#123) for given data: headline, three tiles, then
// "Show the working". Pure render, so it can be tested without fetching.
import { type ReactNode, useState } from "react";
import type { Proof, Spot } from "../../contracts";
import { Headline, KeyHint, Screen, usePlayerKeys } from "../../ui";
import { BeatsTile, EarlyTile, OddsTile, OfficialOutcome } from "./Tiles";
import { TILE_LEAD_H, beatsTile, earlyTile, headline, pooledNote, triggerWords } from "./trust";
import "./trust.css";

const TILES = 3;

/** Presenter keys here: ←/→ highlight the next tile; Space opens or closes "Show the working". */
function useTrustKeys(): number | null {
  const [active, setActive] = useState<number | null>(null);
  usePlayerKeys(
    () => {
      const d = document.querySelector<HTMLDetailsElement>(".ui-main details.ui-working");
      if (!d) return;
      d.open = !d.open;
      if (d.open) d.scrollIntoView({ behavior: "smooth", block: "start" });
    },
    (delta) => {
      const next = active == null ? (delta >= 0 ? 0 : TILES - 1) : (((active + Math.sign(delta)) % TILES) + TILES) % TILES;
      setActive(next);
      document.querySelectorAll(".trust-tiles > .trust-tile")[next]?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    },
  );
  return active;
}

export function TrustView({ proof, spots, working }: { proof: Proof; spots: Spot[]; working?: ReactNode }) {
  const active = useTrustKeys();
  const beats = beatsTile(proof, TILE_LEAD_H);
  const early = earlyTile(proof, spots);
  const sub = [
    beats ? `Accuracy ${pooledNote(proof)}` : null,
    early.floods ? `floods counted per trouble spot, alarm at a ${triggerWords(early.pStar)} chance` : null,
  ]
    .filter(Boolean)
    .join("; ");
  return (
    <Screen
      headline={<Headline sub={sub ? `${sub}.` : undefined}>{headline(beats, early.floods ? early : null)}</Headline>}
      hero={
        <div className="trust-tiles" data-active={active ?? undefined}>
          <BeatsTile data={beats} proof={proof} />
          <OddsTile proof={proof} spots={spots} h={beats?.h ?? TILE_LEAD_H} />
          <EarlyTile data={early} proof={proof} />
          <KeyHint keys={[["← →", "next tile"], ["Space", "show the working"]]} />
        </div>
      }
      working={
        <>
          <OfficialOutcome data={early} />
          {working}
          <p className="small muted">{proof.testPeriodNote}</p>
        </>
      }
    />
  );
}
