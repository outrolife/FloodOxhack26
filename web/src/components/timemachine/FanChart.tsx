// Time Machine main chart: observed level up to the slider (solid), observed
// "future" only where the slider has already been (faint), and the forecast fan
// issued at the slider time. Threshold and amber lines; timeline markers.
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { SpotForecast } from "../../contracts";
import { HOUR, formatDateTimeYear, formatDayMonth, zoneAt } from "../../time";
import { countAtOrBefore, timesOf } from "../shared/series";
import { yDomain } from "./yDomain";

type Point = { t: string; level: number };
type Row = {
  t: number;
  obs?: number;
  obsFaint?: number;
  band90?: [number, number];
  band50?: [number, number];
  median?: number;
};

export type Marker = { t: string; label: string; colour: string };

/**
 * Day ticks at UTC noon (so the UK date label is right in GMT and BST),
 * thinned to every 2nd/7th day on long windows.
 */
function dayTicks([a, b]: [number, number]): number[] {
  const day = 24 * HOUR;
  const days = (b - a) / day;
  const step = days > 40 ? 7 : days > 16 ? 2 : 1;
  const out: number[] = [];
  for (let t = Math.ceil((a - day / 2) / day) * day + day / 2; t <= b; t += step * day) if (t >= a) out.push(t);
  return out;
}

// Marker labels sit in their own row at the top of the plot (one row per
// marker), with a white halo, so nearby markers never overprint each other.
// Renderers are cached: a new function on every slider step makes Recharts
// re-register the reference line and redo its layout (~50 ms per step).
type LabelRenderer = (props: { viewBox?: { x?: number; y?: number } }) => React.ReactElement;
const labelCache = new Map<string, LabelRenderer>();
function markerLabel(text: string, colour: string, row: number): LabelRenderer {
  const key = `${text}|${colour}|${row}`;
  let fn = labelCache.get(key);
  if (!fn) labelCache.set(key, (fn = makeMarkerLabel(text, colour, row)));
  return fn;
}
function makeMarkerLabel(text: string, colour: string, row: number): LabelRenderer {
  return (props) => {
    const x = (props.viewBox?.x ?? 0) + 4;
    const y = (props.viewBox?.y ?? 0) + 12 + row * 14;
    return (
      <text x={x} y={y} fill={colour} fontSize={12} fontWeight={600} stroke="#fcfcfb" strokeWidth={3} paintOrder="stroke">
        {text}
      </text>
    );
  };
}

export function FanChart({
  observed,
  sliderT,
  seenT,
  forecast,
  issuedAt,
  threshold,
  amber,
  domain,
  markers,
}: {
  observed: Point[];
  sliderT: string;
  /** Furthest time the slider has reached; observed data up to here may be shown faintly. */
  seenT: string;
  forecast: SpotForecast | undefined;
  issuedAt: string;
  threshold: number | null;
  amber: number;
  domain: [number, number];
  markers: Marker[];
}) {
  const now = Date.parse(sliderT);
  const seen = Date.parse(seenT);
  const rows = new Map<number, Row>();
  const row = (t: number): Row => {
    let r = rows.get(t);
    if (!r) rows.set(t, (r = { t }));
    return r;
  };

  // Only observations inside the visible window (and never past what the
  // slider has reached) become chart rows: fewer points, faster scrubbing.
  const ts = timesOf(observed);
  const from = countAtOrBefore(observed, domain[0] - 1);
  const to = countAtOrBefore(observed, Math.min(Math.max(now, seen), domain[1]));
  for (let k = from; k < to; k++) {
    const t = ts[k];
    const level = observed[k].level;
    if (t <= now) row(t).obs = level;
    if (t >= now && t <= seen && seen > now) row(t).obsFaint = level;
  }

  if (forecast && forecast.leads.length > 0) {
    const t0 = Date.parse(issuedAt);
    const r0 = row(t0);
    const v = forecast.levelNow;
    r0.band90 = [v, v];
    r0.band50 = [v, v];
    r0.median = v;
    for (const l of forecast.leads) {
      const r = row(t0 + l.h * HOUR);
      r.band90 = [l.q["05"], l.q["95"]];
      r.band50 = [l.q["25"], l.q["75"]];
      r.median = l.q["50"];
    }
  }

  const data = [...rows.values()].sort((a, b) => a.t - b.t);
  // Only what is on screen sets the axis: never observations past the slider (#59).
  const [yMin, yMax] = yDomain({
    observedSoFar: data.flatMap((r) => (r.obs != null ? [r.obs] : [])),
    revealed: data.flatMap((r) => (r.obsFaint != null ? [r.obsFaint] : [])),
    band: data.flatMap((r) => r.band90 ?? []),
    threshold,
    amber,
  });

  return (
    <div style={{ width: "100%" }}>
      <div style={{ width: "100%", height: 360 }}>
      <ResponsiveContainer>
        <ComposedChart data={data} margin={{ top: 16, right: 16, bottom: 8, left: 0 }}>
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
            tick={{ fill: "#52514e", fontSize: 12 }}
            minTickGap={40}
          />
          <YAxis
            domain={[yMin, yMax]}
            stroke="#c3c2b7"
            tick={{ fill: "#52514e", fontSize: 12 }}
            tickFormatter={(v: number) => v.toFixed(1)}
            width={44}
            label={{ value: "m (gauge datum)", angle: -90, position: "insideLeft", fill: "#52514e", fontSize: 12 }}
          />
          <Tooltip
            labelFormatter={(t) => formatDateTimeYear(Number(t))}
            formatter={(v, name) => {
              const fmt = (x: unknown) => (typeof x === "number" ? x.toFixed(2) : String(x));
              const txt = Array.isArray(v) ? `${fmt(v[0])} – ${fmt(v[1])} m` : `${fmt(v)} m`;
              return [txt, String(name)];
            }}
          />
          <Area dataKey="band90" name="Forecast 5–95%" stroke="none" fill="#cde2fb" fillOpacity={1} isAnimationActive={false} connectNulls />
          <Area dataKey="band50" name="Forecast 25–75%" stroke="none" fill="#86b6ef" fillOpacity={1} isAnimationActive={false} connectNulls />
          <Line dataKey="median" name="Forecast median" stroke="#184f95" strokeWidth={2} strokeDasharray="5 3" dot={false} isAnimationActive={false} connectNulls />
          <Line dataKey="obsFaint" name="Observed (later)" stroke="#898781" strokeOpacity={0.45} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
          <Line dataKey="obs" name="Observed" stroke="#0b0b0b" strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
          {threshold != null && (
            <ReferenceLine y={threshold} stroke="#d03b3b" strokeDasharray="6 3" label={{ value: `Flood threshold ${threshold.toFixed(2)} m`, position: "insideTopLeft", fill: "#d03b3b", fontSize: 12 }} />
          )}
          <ReferenceLine y={amber} stroke="#eda100" strokeDasharray="3 3" label={{ value: `Normal top ${amber.toFixed(2)} m`, position: "insideBottomLeft", fill: "#8a5d00", fontSize: 12 }} />
          {markers.map((m, i) => (
            <ReferenceLine
              key={m.label}
              x={Date.parse(m.t)}
              stroke={m.colour}
              strokeWidth={1.5}
              label={markerLabel(m.label, m.colour, i)}
            />
          ))}
          <ReferenceLine x={now} stroke="#52514e" strokeWidth={2} />
        </ComposedChart>
      </ResponsiveContainer>
      </div>
      <div className="small muted">
        Times in UK time ({zoneAt(sliderT)} at the slider). Dark vertical line: forecast issue time.
      </div>
    </div>
  );
}
