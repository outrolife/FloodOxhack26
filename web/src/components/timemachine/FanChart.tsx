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
import { HOUR, formatAxis, formatDateTime, zoneAt } from "../../time";

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

// Stagger marker labels so nearby markers don't overprint each other.
const MARKER_POS = ["insideTopRight", "insideTopLeft", "insideBottomRight", "insideBottomLeft"] as const;

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

  for (const p of observed) {
    const t = Date.parse(p.t);
    if (t <= now) row(t).obs = p.level;
    if (t >= now && t <= seen && seen > now) row(t).obsFaint = p.level;
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
  const values: number[] = [amber];
  if (threshold != null) values.push(threshold);
  for (const r of data) {
    if (r.obs != null) values.push(r.obs);
    if (r.obsFaint != null) values.push(r.obsFaint);
    if (r.band90) values.push(...r.band90);
  }
  for (const p of observed) values.push(p.level); // stable y-axis while playing
  const yMin = Math.floor((Math.min(...values) - 0.1) * 10) / 10;
  const yMax = Math.ceil((Math.max(...values) + 0.1) * 10) / 10;

  return (
    <div style={{ width: "100%", height: 360 }}>
      <ResponsiveContainer>
        <ComposedChart data={data} margin={{ top: 16, right: 16, bottom: 8, left: 0 }}>
          <CartesianGrid stroke="#e1e0d9" vertical={false} />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={domain}
            allowDataOverflow
            tickFormatter={(t: number) => formatAxis(t)}
            stroke="#c3c2b7"
            tick={{ fill: "#52514e", fontSize: 11 }}
            minTickGap={40}
          />
          <YAxis
            domain={[yMin, yMax]}
            stroke="#c3c2b7"
            tick={{ fill: "#52514e", fontSize: 11 }}
            tickFormatter={(v: number) => v.toFixed(1)}
            width={44}
            label={{ value: "m (gauge datum)", angle: -90, position: "insideLeft", fill: "#898781", fontSize: 11 }}
          />
          <Tooltip
            labelFormatter={(t) => formatDateTime(Number(t))}
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
            <ReferenceLine y={threshold} stroke="#d03b3b" strokeDasharray="6 3" label={{ value: `Flood threshold ${threshold.toFixed(2)} m`, position: "insideTopLeft", fill: "#d03b3b", fontSize: 11 }} />
          )}
          <ReferenceLine y={amber} stroke="#eda100" strokeDasharray="3 3" label={{ value: `Normal top ${amber.toFixed(2)} m`, position: "insideBottomLeft", fill: "#8a5d00", fontSize: 11 }} />
          {markers.map((m, i) => (
            <ReferenceLine
              key={m.label}
              x={Date.parse(m.t)}
              stroke={m.colour}
              strokeWidth={1.5}
              label={{ value: m.label, position: MARKER_POS[i % MARKER_POS.length], fill: m.colour, fontSize: 11 }}
            />
          ))}
          <ReferenceLine x={now} stroke="#52514e" strokeWidth={1} label={{ value: "now", position: "top", fill: "#52514e", fontSize: 11 }} />
        </ComposedChart>
      </ResponsiveContainer>
      <div className="small muted">Times in UK time ({zoneAt(sliderT)} at the slider).</div>
    </div>
  );
}
