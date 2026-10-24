// Y-axis range for the Time Machine chart (#59). It uses only what the viewer
// is allowed to see at the slider: observed levels up to the slider, observed
// levels the slider has already passed (shown faintly), the forecast fan issued
// at the slider, and the threshold and amber lines. Observations the slider
// hasn't reached yet are left out, so the axis can't give away the peak.

export type YInputs = {
  /** Observed levels at or before the slider time. */
  observedSoFar: number[];
  /** Observed levels already revealed (slider has been there before). */
  revealed?: number[];
  /** Forecast band edges (5th and 95th percentiles) issued at the slider. */
  band?: number[];
  threshold: number | null;
  amber: number;
};

/** [min, max] padded by `pad` metres and rounded outwards to 0.1 m. */
export function yDomain({ observedSoFar, revealed = [], band = [], threshold, amber }: YInputs, pad = 0.1): [number, number] {
  const values = [amber, ...observedSoFar, ...revealed, ...band];
  if (threshold != null) values.push(threshold);
  const finite = values.filter(Number.isFinite);
  const lo = Math.min(...finite);
  const hi = Math.max(...finite);
  const EPS = 1e-9; // so float noise (e.g. 2.9 + 0.1 = 3.0000000000000004) doesn't add a step
  return [Math.floor((lo - pad) * 10 + EPS) / 10, Math.ceil((hi + pad) * 10 - EPS) / 10];
}
