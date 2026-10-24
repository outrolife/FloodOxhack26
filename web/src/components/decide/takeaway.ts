// One plain sentence under the Decide cost chart (#103 item 4), built from the
// strategy costs on screen, so a judge reads the point of the chart without
// decoding it. No numbers are hard-coded: every £ comes from `strategies`.
import type { StrategyCost, StrategyKey } from "../../lib/costLoss";
import { formatPct } from "../../lib/costLoss";
import { formatGBP } from "./format";

/** At or below this trigger an action counts as "cheap" (act on a small chance). */
export const CHEAP_TRIGGER = 0.1;

/** Two costs this close (as a fraction of the larger) are "about the same". */
export const SIMILAR = 0.25;

/** Every strategy whose cost equals the lowest (ties included). */
export function lowestKeys(strategies: StrategyCost[]): StrategyKey[] {
  const costs = strategies.filter((s) => s.cost !== null).map((s) => s.cost as number);
  if (costs.length === 0) return [];
  const min = Math.min(...costs);
  return strategies.filter((s) => s.cost !== null && Math.abs((s.cost as number) - min) < 0.5).map((s) => s.key);
}

const similar = (a: number, b: number) => Math.abs(a - b) <= SIMILAR * Math.max(a, b, 1);

export function costTakeaway(strategies: StrategyCost[], pStar: number): string | null {
  const cost = (k: StrategyKey) => strategies.find((s) => s.key === k)?.cost ?? null;
  const rc = cost("riverClock");
  const official = cost("official");
  const always = cost("alwaysAct");
  if (rc === null || pStar >= 1) return null;

  const vsOfficial =
    official === null
      ? ""
      : rc < official
        ? ` Acting on River Clock costs ${formatGBP(rc)} here, against ${formatGBP(official)} for waiting for the official warning.`
        : rc > official
          ? ` Here, acting on the official warnings (${formatGBP(official)}) would have cost less than River Clock (${formatGBP(rc)}).`
          : ` Here River Clock and the official warnings cost the same (${formatGBP(rc)}).`;

  if (pStar <= CHEAP_TRIGGER) {
    const alwaysNote =
      always !== null && similar(rc, always)
        ? ` Acting every time costs about the same (${formatGBP(always)}), so River Clock's value shows when you compare it with the official warning.`
        : "";
    return `Cheap action (act at ${formatPct(pStar)} chance or more): act early, even on a small chance.${alwaysNote}${vsOfficial}`;
  }
  const alwaysNote =
    always !== null && rc < always ? ` Acting every time would cost ${formatGBP(always)}: the forecast saves you the false alarms.` : "";
  return `Costly action (act at ${formatPct(pStar)} chance or more): wait until a flood is likely.${alwaysNote}${vsOfficial}`;
}
