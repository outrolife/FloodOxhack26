// Placeholder. The real Decide tab (presets, C/L sliders, p* = C/L, expected
// cost bars, live advice) is issue #15, built on web/src/lib/costLoss.ts.
export default function Decide() {
  return (
    <section className="card">
      <h2>Decide</h2>
      <p>
        When is it worth acting? With a cost of acting <em>C</em> and a loss if you don't{" "}
        <em>L</em>, act when the flood probability reaches <strong>p* = C / L</strong>.
      </p>
      <p className="muted small">
        Coming next (issue #15): Resident, Commuter and Council presets, cost sliders, expected
        cost over the backtest against official warnings, and advice for the live forecast.
      </p>
    </section>
  );
}
