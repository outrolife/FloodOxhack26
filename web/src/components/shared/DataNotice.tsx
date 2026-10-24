import type { AsyncState, Source } from "../../data";

/** Renders loading / error states; null when everything is ready. */
export function Pending({ states }: { states: AsyncState<unknown>[] }) {
  const err = states.find((s) => s.status === "error");
  if (err && err.status === "error") return <div className="notice warn">Data unavailable: {err.error}</div>;
  if (states.some((s) => s.status === "loading")) return <p className="muted">Loading…</p>;
  return null;
}

/** Tells the viewer when a tab is running on test fixtures, not real outputs. */
export function FixtureNotice({ sources }: { sources: (Source | undefined)[] }) {
  if (!sources.includes("fixture")) return null;
  return (
    <div className="notice">
      Showing <strong>sample data</strong> (test fixtures): the pipeline hasn't written these files to{" "}
      <code>web/public/data/</code> yet. Numbers are illustrative.
    </div>
  );
}
