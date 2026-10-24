// The live scoreboard (#120). Rows keep their place; each fills in when the
// playhead reaches its moment. Pending rows show only their label and "…".
// Outcome is shown with a shape and words, never colour alone (#112).
import type { ScoreRowState } from "./scoreboard";
import { latestRevealed } from "./scoreboard";

const MARK: Record<ScoreRowState["tone"], string> = { good: "✓", bad: "✕", neutral: "•" };
const MARK_WORD: Record<ScoreRowState["tone"], string> = { good: "in River Clock's favour", bad: "against River Clock", neutral: "" };

export function Scoreboard({ rows, title }: { rows: ScoreRowState[]; title: string }) {
  const latest = latestRevealed(rows);
  return (
    <section className="rp-score" aria-label={title}>
      <h2 className="rp-score-title">{title}</h2>
      <ol className="rp-score-rows" aria-live="polite">
        {rows.map((r, i) => (
          <li
            key={r.key}
            className={`rp-score-row${r.revealed ? " revealed" : " pending"}${i === latest ? " latest" : ""} tone-${r.tone}`}
          >
            <span className="rp-score-mark" aria-hidden="true">
              {r.revealed ? MARK[r.tone] : "○"}
            </span>
            <span className="rp-score-text">
              <span className="rp-score-label">{r.label}</span>
              {r.revealed ? (
                <>
                  <span className="rp-score-value">
                    {r.value}
                    {MARK_WORD[r.tone] && <span className="rp-vh"> ({MARK_WORD[r.tone]})</span>}
                  </span>
                  {r.detail && <span className="rp-score-detail">{r.detail}</span>}
                </>
              ) : (
                <span className="rp-score-value rp-score-wait">…</span>
              )}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
