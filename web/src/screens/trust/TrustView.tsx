// "How good is it?" (#123) for given data: headline, three tiles, then
// "Show the working". Pure render, so it can be tested without fetching.
import type { ReactNode } from "react";
import type { Proof, Spot } from "../../contracts";
import { Headline, Screen } from "../../ui";
import { BeatsTile, EarlyTile, OddsTile, OfficialOutcome } from "./Tiles";
import { TILE_LEAD_H, beatsTile, earlyTile, headline, pooledNote, triggerWords } from "./trust";
import "./trust.css";

export function TrustView({ proof, spots, working }: { proof: Proof; spots: Spot[]; working?: ReactNode }) {
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
        <div className="trust-tiles">
          <BeatsTile data={beats} proof={proof} />
          <OddsTile proof={proof} spots={spots} h={beats?.h ?? TILE_LEAD_H} />
          <EarlyTile data={early} proof={proof} />
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
