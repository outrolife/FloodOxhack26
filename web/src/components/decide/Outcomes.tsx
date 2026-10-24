// Decide: River Clock's backtest outcomes at p*, next to the official warnings.
// Display only: every number comes from proof.json (tradeoff rows, interpolated
// at p* when it falls between rows, and officialOutcome as is). Nothing about
// official warnings is re-derived here (#99).
import type { Costs, OfficialOutcome, Outcomes } from "../../lib/costLoss";
import { formatPct } from "../../lib/costLoss";
import { FLOOD_EPISODE_RULE, FLOOD_EPISODES } from "../shared/episodes";
import { formatCount, formatGBP, formatHours, formatSignedHours } from "./format";

export function OutcomesTable({ o, costs, official }: { o: Outcomes; costs: Costs; official: OfficialOutcome | null }) {
  const off = (v: number) => (official ? formatCount(v) : "–");
  return (
    <>
      <div className="table-scroll">
        <table className="data" style={{ maxWidth: 720 }}>
          <thead>
            <tr>
              <th title={FLOOD_EPISODE_RULE}>Over past floods ({FLOOD_EPISODES})</th>
              <th className="num">River Clock</th>
              <th className="num">Official warnings</th>
              <th>Cost each</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Hits (acted before the flood)</td>
              <td className="num">{formatCount(o.hits)}</td>
              <td className="num">{off(official?.hits ?? 0)}</td>
              <td>C = {formatGBP(costs.C)}</td>
            </tr>
            <tr>
              <td>False alarms (acted, no flood)</td>
              <td className="num">{formatCount(o.falseAlarms)}</td>
              <td className="num">{off(official?.falseAlarms ?? 0)}</td>
              <td>C = {formatGBP(costs.C)}</td>
            </tr>
            <tr>
              <td>Misses (flood, no warning in time)</td>
              <td className="num">{formatCount(o.misses)}</td>
              <td className="num">{off(official?.misses ?? 0)}</td>
              <td>L = {formatGBP(costs.L)}</td>
            </tr>
            <tr>
              <td>Average warning time before the flood</td>
              <td className="num">{formatHours(o.meanLeadH)}</td>
              <td className="num">{official ? formatHours(official.meanLeadH) : "–"}</td>
              <td />
            </tr>
            <tr>
              <td title="proof.json tradeoff[].meanLeadVsOfficialH: official issue time − River Clock's first trigger">
                How much earlier than the official warning River Clock first raised the alarm
              </td>
              <td className="num">{formatSignedHours(o.meanLeadVsOfficialH)}</td>
              <td className="num">0 h</td>
              <td className="muted small">+ = earlier than the EA</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="small muted" title="Sources: proof.json officialOutcome (official columns) and tradeoff (River Clock columns)">
        {official
          ? "Official warnings: every Environment Agency Flood Warning for this spot's area, scored with the same rules as River Clock. "
          : "We have no scored record of official warnings for this spot, so they aren't scored here. "}
        "How much earlier" compares River Clock's first alarm for a flood with the EA's first warning for the same
        flood, so it can be more than 72 h when River Clock's alarm started early.
        {o.between &&
          ` Your trigger is between two that we tested (${formatPct(o.between[0])} and ${formatPct(o.between[1])}), so River Clock's numbers are estimated between those two.`}
      </p>
    </>
  );
}
