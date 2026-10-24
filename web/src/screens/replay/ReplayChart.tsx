// Replay chart (#120): the river level at the selected spot's gauge, with the
// forecast fan issued at the playhead sweeping forward from it. The real level
// is solid up to the playhead; ahead of it, it shows faintly only where the
// playhead has already been (SPEC §10.2, no spoilers). Flood level and usual
// high are labelled in plain words on the chart. Adapted from the Time
// Machine's FanChart, which stays as it is under "Show the working".
import { memo } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";
import type { SpotForecast } from "../../contracts";
import { HOUR, formatDayMonth } from "../../time";
import { countAtOrBefore, timesOf, type Point } from "../../components/shared/series";
import { yDomain } from "../../components/timemachine/yDomain";

type Row = { t: number; obs?: number; obsFaint?: number; band90?: [number, number]; band50?: [number, number]; median?: number };

export type ChartMarker = { t: string; label: string; colour: string };

/** Visible window: 4 days behind the playhead, the 72 h fan plus a little room ahead. */
export const BEHIND_H = 96;
export const AHEAD_H = 84;

export function chartWindow(now: number, [a, b]: [number, number]): [number, number] {
  const width = (BEHIND_H + AHEAD_H) * HOUR;
  if (b - a <= width) return [a, b];
  const start = Math.min(Math.max(now - BEHIND_H * HOUR, a), b - width);
  return [start, start + width];
}

function dayTicks([a, b]: [number, number]): number[] {
  const day = 24 * HOUR;
  const out: number[] = [];
  // UTC noon, so the UK date label is right in GMT and BST.
  for (let t = Math.ceil((a - day / 2) / day) * day + day / 2; t <= b; t += day) if (t >= a) out.push(t);
  return out;
}

const labelCache = new Map<string, (p: { viewBox?: { x?: number; y?: number } }) => React.ReactElement>();
/** Marker label in its own row at the top, with a halo, so markers close together never overprint. */
function markerLabel(text: string, colour: string, row: number) {
  const key = `${text}|${colour}|${row}`;
  let fn = labelCache.get(key);
  if (!fn) {
    fn = (props) => (
      <text
        x={(props.viewBox?.x ?? 0) + 5}
        y={(props.viewBox?.y ?? 0) + 14 + row * 16}
        fill={colour}
        fontSize={13}
        fontWeight={700}
        stroke="#fcfcfb"
        strokeWidth={4}
        paintOrder="stroke"
      >
        {text}
      </text>
    );
    labelCache.set(key, fn);
  }
  return fn;
}

export const ReplayChart = memo(function ReplayChart({
  observed,
  now,
  seen,
  forecast,
  threshold,
  usualHigh,
  eventRange,
  markers,
}: {
  observed: Point[];
  /** Playhead (forecast issue time), epoch ms. */
  now: number;
  /** Furthest time the playhead has reached, epoch ms. */
  seen: number;
  forecast: SpotForecast | undefined;
  threshold: number;
  usualHigh: number;
  eventRange: [number, number];
  markers: ChartMarker[];
}) {
  const domain = chartWindow(now, eventRange);
  const rows = new Map<number, Row>();
  const row = (t: number): Row => {
    let r = rows.get(t);
    if (!r) rows.set(t, (r = { t }));
    return r;
  };

  const ts = timesOf(observed);
  const from = countAtOrBefore(observed, domain[0] - 1);
  const to = countAtOrBefore(observed, Math.min(Math.max(now, seen), domain[1]));
  for (let k = from; k < to; k++) {
    const t = ts[k];
    if (t <= now) row(t).obs = observed[k].level;
    if (t >= now && t <= seen && seen > now) row(t).obsFaint = observed[k].level;
  }

  if (forecast && forecast.leads.length > 0) {
    const r0 = row(now);
    const v = forecast.levelNow;
    r0.band90 = [v, v];
    r0.band50 = [v, v];
    r0.median = v;
    for (const l of forecast.leads) {
      const r = row(now + l.h * HOUR);
      r.band90 = [l.q["05"], l.q["95"]];
      r.band50 = [l.q["25"], l.q["75"]];
      r.median = l.q["50"];
    }
  }

  const data = [...rows.values()].sort((a, b) => a.t - b.t);
  const [yMin, yMax] = yDomain({
    observedSoFar: data.flatMap((r) => (r.obs != null ? [r.obs] : [])),
    revealed: data.flatMap((r) => (r.obsFaint != null ? [r.obsFaint] : [])),
    band: data.flatMap((r) => r.band90 ?? []),
    threshold,
    amber: usualHigh,
  });

  return (
    <div className="rp-chart" role="img" aria-label="River level so far and River Clock's forecast range from the playhead">
      <ResponsiveContainer>
        <ComposedChart data={data} margin={{ top: 8, right: 20, bottom: 4, left: 4 }}>
          <CartesianGrid stroke="#e1e0d9" vertical={false} />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={domain}
            ticks={dayTicks(domain)}
            allowDataOverflow
            tickFormatter={(t: number) => formatDayMonth(t)}
            stroke="#c3c2b7"
            tick={{ fill: "#52514e", fontSize: 13 }}
          />
          <YAxis
            domain={[yMin, yMax]}
            allowDataOverflow
            stroke="#c3c2b7"
            tick={{ fill: "#52514e", fontSize: 13 }}
            tickFormatter={(v: number) => `${v.toFixed(1)} m`}
            width={54}
          />
          <Area dataKey="band90" stroke="none" fill="#cde2fb" fillOpacity={1} isAnimationActive={false} connectNulls />
          <Area dataKey="band50" stroke="none" fill="#86b6ef" fillOpacity={1} isAnimationActive={false} connectNulls />
          <Line dataKey="median" stroke="#184f95" strokeWidth={2} strokeDasharray="5 3" dot={false} isAnimationActive={false} connectNulls />
          <Line dataKey="obsFaint" stroke="#898781" strokeOpacity={0.5} strokeWidth={2.5} dot={false} isAnimationActive={false} connectNulls />
          <Line dataKey="obs" stroke="#0b0b0b" strokeWidth={3} dot={false} isAnimationActive={false} connectNulls />
          <ReferenceLine
            y={threshold}
            stroke="#d03b3b"
            strokeWidth={2}
            strokeDasharray="7 4"
            label={{ value: `Flood level ${threshold.toFixed(2)} m`, position: "insideBottomRight", fill: "#b02a2a", fontSize: 13, fontWeight: 700 }}
          />
          <ReferenceLine
            y={usualHigh}
            stroke="#e09b00"
            strokeDasharray="3 3"
            label={{ value: `Usual high ${usualHigh.toFixed(2)} m`, position: "insideBottomRight", fill: "#7a5200", fontSize: 13 }}
          />
          {markers.map((m, i) => (
            <ReferenceLine key={m.label} x={Date.parse(m.t)} stroke={m.colour} strokeWidth={2} label={markerLabel(m.label, m.colour, i)} />
          ))}
          <ReferenceLine x={now} stroke="#0b0b0b" strokeWidth={2} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
});

/** The chart's key, in words (no colour-only legend). */
export function ChartKey() {
  return (
    <div className="rp-key small">
      <span><i className="rp-sw rp-sw-obs" /> River level so far</span>
      <span><i className="rp-sw rp-sw-faint" /> What happened next (once passed)</span>
      <span><i className="rp-sw rp-sw-band" /> River Clock's forecast: likely range, wide range (5–95%), dashed middle</span>
    </div>
  );
}
