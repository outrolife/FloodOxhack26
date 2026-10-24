// Which way interval coverage is off (#99). Pure: proof.coverage in, a plain
// English sentence out. The direction comes from the data, never hard-coded:
//   actual > nominal → ranges wider than needed (cautious / conservative)
//   actual < nominal → ranges narrower than they should be (overconfident)
import type { Proof } from "../../contracts";

type Cell = Proof["coverage"][number];

/** Cells more than this far from nominal (as a fraction) are flagged (SPEC §15.5). */
export const COVERAGE_FLAG = 0.1;

/** Cells within this many percentage points of nominal count as on target. */
export const ON_TARGET_PTS = 2;

export type Direction = "wide" | "narrow" | "mixed" | "on-target";

export const DIRECTION_TEXT: Record<Direction, string> = {
  wide: "cautious (wider than needed)",
  narrow: "overconfident (narrower than they should be)",
  mixed: "cautious for some ranges and overconfident for others",
  "on-target": "about right",
};

/** One word per level, used when the levels disagree. */
const DIRECTION_SHORT: Record<Direction, string> = {
  wide: "cautious",
  narrow: "overconfident",
  mixed: "mixed",
  "on-target": "about right",
};

/** The precise statistical wording, for a title tooltip. */
export const DIRECTION_TERM: Record<Direction, string> = {
  wide: "coverage above nominal (conservative intervals)",
  narrow: "coverage below nominal (overconfident intervals)",
  mixed: "coverage above nominal for some levels and below for others",
  "on-target": `coverage within ${ON_TARGET_PTS} points of nominal`,
};

const pct = (v: number) => Math.round(v * 100);
const range = (vals: number[]) => {
  const lo = pct(Math.min(...vals));
  const hi = pct(Math.max(...vals));
  return lo === hi ? `${lo}%` : `${lo}–${hi}%`;
};

/** Direction of a set of cells, in whole percentage points (no float noise). */
export function direction(cells: Cell[]): Direction {
  const off = cells.map((c) => pct(c.actual) - pct(c.nominal));
  const over = off.some((d) => d > ON_TARGET_PTS);
  const under = off.some((d) => d < -ON_TARGET_PTS);
  if (over && under) return "mixed";
  if (over) return "wide";
  if (under) return "narrow";
  return "on-target";
}

export type CoverageSummary = {
  /** Overall direction over every cell. */
  direction: Direction;
  /** Cells off nominal by more than COVERAGE_FLAG. */
  flagged: Cell[];
  /** e.g. "Our forecast ranges are cautious (wider than needed): our 50% range held the real level 65–78% of the time; …" */
  text: string;
};

export function coverageSummary(coverage: Cell[]): CoverageSummary | null {
  if (coverage.length === 0) return null;
  const overall = direction(coverage);
  const nominals = [...new Set(coverage.map((c) => c.nominal))].sort((a, b) => a - b);
  const parts = nominals.map((n) => {
    const cells = coverage.filter((c) => c.nominal === n);
    // When the levels disagree, say which way each one is off.
    const dir = overall === "mixed" ? `: ${DIRECTION_SHORT[direction(cells)]}` : "";
    return `our ${pct(n)}% range held the real level ${range(cells.map((c) => c.actual))} of the time${dir}`;
  });
  return {
    direction: overall,
    flagged: coverage.filter((c) => Math.abs(c.actual - c.nominal) > COVERAGE_FLAG),
    text: `Our forecast ranges are ${DIRECTION_TEXT[overall]}: ${parts.join("; ")}.`,
  };
}
