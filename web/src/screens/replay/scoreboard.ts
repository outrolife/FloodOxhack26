// The Replay scoreboard (#120): five rows that fill in, in a fixed order, as
// the playhead passes the moment each one becomes known. Before that a row
// shows only its label, so playing the replay never gives the story away.
import { formatDate, formatDateTime } from "../../time";
import type { ReplayFacts } from "./facts";

export type RowKey = "rc" | "ea" | "diff" | "cross" | "peak";

export type ScoreRow = {
  key: RowKey;
  /** Shown from the start. */
  label: string;
  /** Shown once revealed. */
  value: string;
  /** Optional second line once revealed. */
  detail?: string;
  /** Epoch ms at which the row is known; null = known only at the end of the event. */
  at: number | null;
  /** How the row reads: good news for River Clock, bad news, or neutral. Shape + words carry it too. */
  tone: "good" | "bad" | "neutral";
};

export type ScoreRowState = ScoreRow & { revealed: boolean };

const ms = Date.parse;
const hrs = (h: number) => `${Math.round(Math.abs(h))} h`;
const metres = (v: number) => `${v.toFixed(2)} m`;
const pctText = (p: number) => `${Math.round(p * 100)}%`;
/** The EA's time, or just its day when only the date was recorded. */
const eaTime = (o: NonNullable<ReplayFacts["official"]>) =>
  o.precision === "date" ? `${formatDate(o.issuedAt)} (time not recorded)` : formatDateTime(o.issuedAt);

/** Words for River Clock vs the EA, from proof.perEvent.leadVsOfficialH (positive = River Clock earlier). */
export function differenceText(h: number): string {
  if (Math.abs(h) < 0.5) return "About the same time as the EA warning";
  return h > 0 ? `River Clock ${hrs(h)} earlier than the EA warning` : `River Clock ${hrs(h)} after the EA warning`;
}

/** The five rows for one spot in one replay. `endT` is the replay's last forecast time. */
export function buildScoreboard(f: ReplayFacts, threshold: number, endT: string): ScoreRow[] {
  const end = ms(endT);
  const rows: ScoreRow[] = [];

  // 1. River Clock's call.
  if (f.rc50) {
    rows.push({
      key: "rc",
      label: "River Clock: more likely than not",
      value: formatDateTime(f.rc50),
      detail: f.rc50AlreadyOn ? "Already at 50% or more 3 days before the flood" : undefined,
      at: ms(f.rc50),
      tone: f.crossed ? "good" : "bad",
    });
  } else if (f.crossing) {
    rows.push({
      key: "rc",
      label: "River Clock: more likely than not",
      value: "Not before the flood",
      detail: "It stayed under 50% in the 3 days before the river crossed",
      at: ms(f.crossing),
      tone: "bad",
    });
  } else {
    const pc = f.peakChance;
    rows.push({
      key: "rc",
      label: "River Clock: more likely than not",
      value: pc ? `Never: highest chance ${pctText(pc.p)}` : "No forecast",
      detail: pc ? `Highest at ${formatDateTime(pc.t)}` : undefined,
      at: pc ? ms(pc.t) : end,
      tone: "good",
    });
  }

  // 2. The EA's Flood Warning.
  const o = f.official;
  const noEaAt = f.crossing ? ms(f.crossing) : (f.peakObs?.t ? ms(f.peakObs.t) : end);
  rows.push(
    o
      ? { key: "ea", label: "EA Flood Warning", value: eaTime(o), at: ms(o.issuedAt), tone: "neutral" }
      : {
          key: "ea",
          label: "EA Flood Warning",
          value: f.crossing ? "None before the flood" : "None issued",
          at: noEaAt,
          tone: "neutral",
        },
  );

  // 3. The difference, read from proof.perEvent (never recomputed).
  if (f.leadVsOfficialH != null && f.rc50 && o) {
    const h = f.leadVsOfficialH;
    rows.push({
      key: "diff",
      label: "Difference",
      value: differenceText(h),
      at: Math.max(ms(f.rc50), ms(o.issuedAt)),
      tone: h >= 0.5 ? "good" : h <= -0.5 ? "bad" : "neutral",
    });
  } else {
    rows.push({
      key: "diff",
      label: "Difference",
      value: !o ? "No EA warning to compare with" : !f.rc50 ? "River Clock did not reach 50%" : "Not scored",
      at: Math.max(rows[0].at ?? end, rows[1].at ?? end),
      tone: "neutral",
    });
  }

  // 4. What the river did.
  if (f.crossing) {
    rows.push({
      key: "cross",
      label: "River crossed flood level",
      value: formatDateTime(f.crossing),
      detail:
        f.leadBeforeFloodH != null
          ? `${hrs(f.leadBeforeFloodH)} after River Clock said more likely than not`
          : undefined,
      at: ms(f.crossing),
      tone: "neutral",
    });
  } else {
    const below = f.peakObs ? Math.round((threshold - f.peakObs.level) * 100) : null;
    rows.push({
      key: "cross",
      label: "River crossed flood level",
      value: "No: it stayed below",
      detail: below != null && below >= 0 ? `Highest ${metres(f.peakObs!.level)}, ${below} cm under the flood level` : undefined,
      at: f.peakObs?.t ? ms(f.peakObs.t) : end,
      tone: "neutral",
    });
  }

  // 5. The peak: the range River Clock gave 3 days before, against what happened.
  const b = f.peakBand;
  const p = f.peakObs;
  rows.push({
    key: "peak",
    label: "Peak level",
    value: p
      ? b
        ? `Predicted ${metres(b.lo)}–${metres(b.hi)} · actual ${metres(p.level)}`
        : `Actual ${metres(p.level)}`
      : "No observations",
    detail: b && p ? `${b.inside ? "Inside" : "Outside"} the likely range given ${b.leadH} h before` : undefined,
    at: p?.t ? ms(p.t) : end,
    tone: b ? (b.inside ? "good" : "bad") : "neutral",
  });

  return rows;
}

/** The scoreboard at playhead time t (epoch ms): which rows are filled in. */
export function scoreboardAt(rows: ScoreRow[], t: number, endT?: string): ScoreRowState[] {
  const end = endT ? ms(endT) : Infinity;
  return rows.map((r) => ({ ...r, revealed: t >= (r.at ?? end) }));
}

/** Index of the row revealed most recently at t (to highlight it), or -1. */
export function latestRevealed(rows: ScoreRowState[]): number {
  let best = -1;
  rows.forEach((r, i) => {
    if (r.revealed && (best < 0 || (r.at ?? 0) >= (rows[best].at ?? 0))) best = i;
  });
  return best;
}
