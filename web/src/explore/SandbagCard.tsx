// "Sandbag estimate" (#118 Explore): a few questions about the property with
// sensible defaults, the total counted up (instant with reduced motion), and
// "How we calculated this" with the formula and the worked example in words.
import { useId, useMemo, useState } from "react";
import { DEFAULT_INPUTS, FORMULA_PLAIN, estimateSandbags } from "./logic";
import { useCountUp } from "./motion";
import type { FloorLevel, PropertyInputs, RiskBand } from "./types";

export const GOV_FLOOD_GUIDANCE = "https://www.gov.uk/prepare-for-flooding";

export const FLOOR_OPTIONS: { value: FloorLevel; label: string }[] = [
  { value: "street", label: "At street level" },
  { value: "one_step", label: "One step up" },
  { value: "raised", label: "Raised (several steps)" },
  { value: "upper", label: "Upper-floor flat" },
];

export const DOORS_MIN = 1;
export const DOORS_MAX = 8;
export const WIDTH_MIN = 0.6;
export const WIDTH_MAX = 2.4;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The width as typed: kept as text while typing ("0." is fine), committed when it parses. */
function WidthInput({ id, value, onChange }: { id: string; value: number; onChange: (v: number) => void }) {
  const [text, setText] = useState<string | null>(null);
  return (
    <input
      id={id}
      type="number"
      inputMode="decimal"
      min={WIDTH_MIN}
      max={WIDTH_MAX}
      step={0.1}
      value={text ?? String(value)}
      onChange={(e) => {
        setText(e.target.value);
        const v = Number(e.target.value);
        if (e.target.value !== "" && Number.isFinite(v) && v >= WIDTH_MIN && v <= WIDTH_MAX) onChange(v);
      }}
      onBlur={() => {
        const v = Number(text);
        if (text != null && text !== "" && Number.isFinite(v)) onChange(clamp(v, WIDTH_MIN, WIDTH_MAX));
        setText(null);
      }}
    />
  );
}

export function SandbagCard({ band, initial = DEFAULT_INPUTS }: { band: RiskBand; initial?: PropertyInputs }) {
  const id = useId();
  const [inputs, setInputs] = useState<PropertyInputs>(initial);
  const set = <K extends keyof PropertyInputs>(k: K, v: PropertyInputs[K]) => setInputs((p) => ({ ...p, [k]: v }));
  const est = useMemo(() => estimateSandbags(band, inputs), [band, inputs]);
  const shown = useCountUp(est.total);

  return (
    <section className="fc-x-bags" aria-labelledby={`${id}-h`}>
      <div className="fc-x-bags-head">
        <h3 id={`${id}-h`} className="fc-x-h3">
          Sandbag estimate
        </h3>
        <span className="fc-x-chip">Estimate</span>
      </div>

      <div className="fc-x-form">
        <div className="fc-x-field">
          <span className="fc-x-label" id={`${id}-doors`}>
            External doors
          </span>
          <div className="fc-x-stepper" role="group" aria-labelledby={`${id}-doors`}>
            <button type="button" aria-label="Fewer doors" disabled={inputs.doors <= DOORS_MIN} onClick={() => set("doors", clamp(inputs.doors - 1, DOORS_MIN, DOORS_MAX))}>
              −
            </button>
            <output aria-live="polite" aria-label={`${inputs.doors} doors`}>{inputs.doors}</output>
            <button type="button" aria-label="More doors" disabled={inputs.doors >= DOORS_MAX} onClick={() => set("doors", clamp(inputs.doors + 1, DOORS_MIN, DOORS_MAX))}>
              +
            </button>
          </div>
        </div>

        <div className="fc-x-field">
          <label className="fc-x-label" htmlFor={`${id}-w`}>
            Door width
          </label>
          <div className="fc-x-width">
            <input
              type="range"
              aria-label="Door width slider"
              min={WIDTH_MIN}
              max={WIDTH_MAX}
              step={0.1}
              value={inputs.doorWidthM}
              onChange={(e) => set("doorWidthM", clamp(Number(e.target.value), WIDTH_MIN, WIDTH_MAX))}
            />
            <span className="fc-x-num">
              <WidthInput id={`${id}-w`} value={inputs.doorWidthM} onChange={(v) => set("doorWidthM", v)} />
              <span aria-hidden="true">m</span>
            </span>
          </div>
        </div>

        <div className="fc-x-field fc-x-field-row">
          <label className="fc-x-label" htmlFor={`${id}-b`}>
            Basement or cellar
          </label>
          <span className="fc-x-switch">
            <input id={`${id}-b`} type="checkbox" role="switch" checked={inputs.basement} onChange={(e) => set("basement", e.target.checked)} />
            <span aria-hidden="true" />
          </span>
        </div>

        <div className="fc-x-field">
          <label className="fc-x-label" htmlFor={`${id}-f`}>
            Floor level
          </label>
          <select id={`${id}-f`} className="fc-x-select" value={inputs.floorLevel} onChange={(e) => set("floorLevel", e.target.value as FloorLevel)}>
            {FLOOR_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="fc-x-total" aria-live="polite" aria-atomic="true">
        <span className="fc-x-total-n" data-testid="bag-total">
          {shown}
        </span>
        <span className="fc-x-total-unit">
          sandbag{est.total === 1 ? "" : "s"}
          <small>estimated, for {est.openings} opening{est.openings === 1 ? "" : "s"}</small>
        </span>
        <span className="fc-x-sr">Estimate: {est.total} sandbags.</span>
      </div>
      {est.total === 0 && <p className="fc-x-note">No sandbags needed at this floor level for the likely depth here.</p>}
      {est.capped && (
        <p className="fc-x-note fc-x-note-warn">
          Water this deep is beyond what sandbags can reliably hold back. Plan to move valuables up and follow official warnings.
        </p>
      )}

      <details className="fc-x-how">
        <summary>How we calculated this</summary>
        <p>{FORMULA_PLAIN}</p>
        <ol>
          {est.steps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
      </details>

      <p className="fc-x-fine">
        A rough guide, not advice for your property.{" "}
        <a href={GOV_FLOOD_GUIDANCE} target="_blank" rel="noreferrer">
          Read the gov.uk flood guidance
        </a>
        .
      </p>
    </section>
  );
}
