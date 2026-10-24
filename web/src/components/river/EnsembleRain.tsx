// S2 (SPEC §11): "Rain in the next 72 h" fan from the Open-Meteo ECMWF ensemble.
// Context only: the forecast model does not use future rain. Hidden when
// ensemble_rain.json is missing (fixture fallback), malformed or over 24 h old.
// To hide S2 entirely, remove <EnsembleRainPanel /> from views/River.tsx.
import { useState } from "react";
import type { EnsembleRain } from "../../contracts";
import { useData, type Source } from "../../data";
import { HOUR, formatDateTime } from "../../time";

export const MAX_AGE_H = 24;

/** True when the file is real data, well formed and issued within the last 24 h. */
export function isUsable(d: EnsembleRain | undefined, source: Source | undefined, nowMs: number): d is EnsembleRain {
  if (!d || source !== "data") return false;
  const t = Date.parse(d.issuedAt);
  if (!Number.isFinite(t) || nowMs - t > MAX_AGE_H * HOUR) return false;
  const n = d.hours?.length ?? 0;
  return n > 1 && (["p10", "p50", "p90"] as const).every((k) => d.cumMm?.[k]?.length === n);
}

const W = 560;
const H = 190;
const PAD = { l: 44, r: 24, t: 10, b: 24 };

/** Round the axis top up to a whole 5 mm (at least 5 mm, so a dry forecast still reads as dry). */
const axisTop = (v: number) => Math.max(5, Math.ceil(v / 5) * 5);

const fmtMm = (v: number) => (v < 10 ? v.toFixed(1) : v.toFixed(0));

export function EnsembleRainView({ data, source, nowMs }: { data?: EnsembleRain; source?: Source; nowMs: number }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!isUsable(data, source, nowMs)) return null;

  const { hours, cumMm } = data;
  const last = hours.length - 1;
  const xMax = hours[last];
  const yMax = axisTop(Math.max(...cumMm.p90));
  const x = (h: number) => PAD.l + (h / xMax) * (W - PAD.l - PAD.r);
  const y = (mm: number) => H - PAD.b - (mm / yMax) * (H - PAD.t - PAD.b);
  const pts = (vals: number[]) => vals.map((v, i) => `${x(hours[i]).toFixed(1)},${y(v).toFixed(1)}`);
  const line = (vals: number[]) => pts(vals).join(" ");
  // Band polygon: along the top (p90) left to right, then back along the bottom (p10).
  const band = [...pts(cumMm.p90), ...pts(cumMm.p10).reverse()].join(" ");
  const xTicks = [0, 24, 48, 72].filter((h) => h <= xMax);
  const yTicks = [0, yMax / 2, yMax];
  const issued = Date.parse(data.issuedAt);
  const at = hover ?? last;

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const h = ((e.clientX - r.left) / r.width * W - PAD.l) / (W - PAD.l - PAD.r) * xMax;
    let best = 0;
    for (let i = 1; i < hours.length; i++) if (Math.abs(hours[i] - h) < Math.abs(hours[best] - h)) best = i;
    setHover(best);
  };

  return (
    <section className="card">
      <h2>
        Rain in the next 72 h <span className="chip">Experimental</span>
      </h2>
      <p className="sub">
        <strong>Context only: our forecast does not yet use future rain.</strong> Cumulative rain from
        the ECMWF ensemble (51 runs), averaged over Eynsham, Enslow and Oxford. Shaded: 10–90% of runs;
        line: median.
      </p>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        style={{ maxWidth: 560, display: "block" }}
        role="img"
        aria-label={`Rain forecast: median ${fmtMm(cumMm.p50[last])} mm in ${xMax} h, 10–90% range ${fmtMm(cumMm.p10[last])}–${fmtMm(cumMm.p90[last])} mm`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {yTicks.map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="var(--grid)" />
            <text x={PAD.l - 4} y={y(v) + 3} textAnchor="end" fontSize={11} fill="var(--ink-2)">
              {`${v} mm`}
            </text>
          </g>
        ))}
        {xTicks.map((h) => (
          <text key={h} x={x(h)} y={H - 6} textAnchor="middle" fontSize={11} fill="var(--ink-2)">
            {h === 0 ? "now" : `+${h} h`}
          </text>
        ))}
        <polygon points={band} fill="var(--series-1-faint)" />
        <polyline points={line(cumMm.p50)} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" />
        {hover != null && (
          <line x1={x(hours[at])} x2={x(hours[at])} y1={PAD.t} y2={H - PAD.b} stroke="var(--ink-2)" strokeWidth={1} />
        )}
      </svg>
      <p className="small" aria-live="polite">
        By {formatDateTime(issued + hours[at] * HOUR)}: median <strong>{`${fmtMm(cumMm.p50[at])} mm`}</strong>{" "}
        {`(10–90%: ${fmtMm(cumMm.p10[at])}–${fmtMm(cumMm.p90[at])} mm).`}
      </p>
      <p className="small muted">
        Issued {formatDateTime(data.issuedAt)}. Weather data by{" "}
        <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">
          Open-Meteo.com
        </a>{" "}
        (ECMWF IFS ensemble),{" "}
        <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">
          CC BY 4.0
        </a>
        .
      </p>
    </section>
  );
}

/** River tab panel: loads ensemble_rain.json and renders nothing unless it is fresh, real data. */
export function EnsembleRainPanel() {
  const state = useData<EnsembleRain>("ensemble_rain.json");
  if (state.status !== "ready") return null;
  return <EnsembleRainView data={state.data} source={state.source} nowMs={Date.now()} />;
}
