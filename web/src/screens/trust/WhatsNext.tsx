// "What's next" (#123): the honest rain-forecast experiment (#100). Its numbers
// come from the experiment on branch model/rain-features, not from proof.json,
// so the card names its source and says it is not switched on.
export function WhatsNext() {
  return (
    <div className="card trust-next">
      <h2>What's next: adding rain forecasts (tested, not switched on yet)</h2>
      <p>
        FloodClock only reads river gauges, so it can't see rain that hasn't fallen yet. We tested adding real archived
        ECMWF rain forecasts (available from 2024 onwards). Accuracy 72 hours ahead rose from <strong>+11%</strong> to{" "}
        <strong>+28%</strong> better than the simple guess, and for the November 2024 flood at Botley it would have warned{" "}
        <strong>29 hours earlier</strong>, matching the EA.
      </p>
      <p>
        But it also raised <strong>3 extra false alarms</strong>, scored worse on Botley's flood odds, and the honest test
        covers only one flood. That fails our own rule for adopting a change, so it stays off until we can test it on more
        floods.
      </p>
      <p className="small muted">
        Source: rain-features experiment (GitHub issue #100, branch <code>model/rain-features</code>). These figures are
        from that experiment, not from the scores above.
      </p>
    </div>
  );
}
