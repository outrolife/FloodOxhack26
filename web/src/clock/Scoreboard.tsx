// The one-screen Scoreboard (#135): at most two lines, big type.
// Replay: "River Clock warned 31 h before the flood" · "7 h before the EA
// warning" (honest sign), filled in only once the playhead `t` has passed each
// moment; calm events: "Stayed calm: highest chance X%". Now: "No flood
// expected in the next 3 days" or "X% chance of flooding by <time>".
// The outcome is carried by words and a shape (✓ / ✕), not colour alone.
import { useMemo } from "react";
import type { ClockEventId } from "./choices";
import { chanceAt, nowScore, replayScore, type ScoreLine } from "./story";
import { useClockEvent } from "./useClockEvent";
import "./clock.css";

export type ScoreboardProps = {
  event: ClockEventId;
  spot: string;
  /** Playhead, epoch ms (from Timeline's onTime). Omitted: the end of the event, everything known. Ignored for Now. */
  t?: number;
};

export function Scoreboard({ event, spot, t }: ScoreboardProps) {
  const data = useClockEvent(event, spot);
  const lines = useMemo<ScoreLine[] | null>(() => {
    if (data.status !== "ready") return null;
    if (data.kind === "now") return nowScore(data.live, data.spot);
    const at = t ?? Infinity;
    const endT = data.replay.forecasts.at(-1)?.issuedAt ?? data.replay.end;
    const lastT = Date.parse(endT);
    return replayScore(data.facts, at, endT, chanceAt(data.replay.forecasts, data.spot.key, Math.min(at, lastT)));
  }, [data, t]);
  if (!lines) return <ScoreboardView lines={[{ text: data.status === "missing" ? data.message : "…", tone: "neutral" }]} />;
  return <ScoreboardView lines={lines} />;
}

const MARK: Record<ScoreLine["tone"], string> = { good: "✓", bad: "✕", neutral: "" };
const MARK_WORD: Record<ScoreLine["tone"], string> = { good: "In River Clock's favour: ", bad: "Against River Clock: ", neutral: "" };

export function ScoreboardView({ lines }: { lines: ScoreLine[] }) {
  return (
    <section className="ck-score" aria-label="Scoreboard" aria-live="polite">
      {lines.slice(0, 2).map((l, i) => (
        <p key={i} className={`ck-score-line ck-score-${i === 0 ? "main" : "sub"} tone-${l.tone}`}>
          {MARK[l.tone] && (
            <span className="ck-mark" aria-hidden="true">
              {MARK[l.tone]}
            </span>
          )}
          <span className="ck-vh">{MARK_WORD[l.tone]}</span>
          {l.text}
        </p>
      ))}
    </section>
  );
}
