// Screen layout (#118): headline sentence on top, ≤ 3 stats, a dominant hero
// visual filling the viewport, an optional side panel, and the expert detail
// folded underneath in "Show the working".
import type { ReactNode } from "react";
import { ShowTheWorking } from "./ShowTheWorking";

export function Screen({
  headline,
  hero,
  stats,
  aside,
  working,
  workingTitle,
}: {
  /** Usually a <Headline>. */
  headline: ReactNode;
  /** The one big visual (map, chart, scoreboard). */
  hero: ReactNode;
  /** Up to three <StatTile>s (wrap them in <StatRow> or pass them directly). */
  stats?: ReactNode;
  /** Side panel next to the hero (a spot card, controls). */
  aside?: ReactNode;
  /** Expert detail, rendered inside a collapsed <ShowTheWorking>. */
  working?: ReactNode;
  workingTitle?: ReactNode;
}) {
  return (
    <div className={`ui-screen${aside ? " has-aside" : ""}`}>
      <div className="ui-screen-head">
        {headline}
        {stats && <div className="ui-screen-stats">{stats}</div>}
      </div>
      <div className="ui-screen-body">
        <div className="ui-screen-hero">{hero}</div>
        {aside && <aside className="ui-screen-aside">{aside}</aside>}
      </div>
      {working && <ShowTheWorking title={workingTitle}>{working}</ShowTheWorking>}
    </div>
  );
}
