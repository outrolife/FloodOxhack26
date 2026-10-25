// Compact 72 h forecast fan for the spot card: the likely range (25–75%) and
// wide range (5–95%) of the river level, the median, the flood level, and
// the chance of flooding by each lead underneath. Times are UK clock times.
import { Area, ComposedChart, Line, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from "recharts";
import type { SpotForecast } from "../../contracts";
import { HOUR, formatShort, zoneAt } from "../../time";
import { yDomain } from "../../components/timemachine/yDomain";
import { pctPlain } from "../../lib/plain";

type Row = { h: number; wide: [number, number]; likely: [number, number]; median: number };

/** Chart rows: the current level at 0 h, then one row per lead. */
export function fanRows(sf: SpotForecast): Row[] {
  const v = sf.levelNow;
  return [
    { h: 0, wide: [v, v], likely: [v, v], median: v },
    ...[...sf.leads]
      .sort((a, b) => a.h - b.h)
      .map((l) => ({ h: l.h, wide: [l.q["05"], l.q["95"]] as [number, number], likely: [l.q["25"], l.q["75"]] as [number, number], median: l.q["50"] })),
  ];
}

/** "Sun 07:00": a tick label without the zone (the caption names it once). */
const tick = (issuedAt: string, h: number) => (h === 0 ? "now" : formatShort(Date.parse(issuedAt) + h * HOUR).replace(/ (GMT|BST)$/, ""));

export function MiniFan({ sf, issuedAt, threshold, amber }: { sf: SpotForecast; issuedAt: string; threshold: number; amber: number }) {
  const rows = fanRows(sf);
  const [lo, hi] = yDomain({ observedSoFar: [sf.levelNow], band: rows.flatMap((r) => r.wide), threshold, amber });
  const last = Date.parse(issuedAt) + 72 * HOUR;
  return (
    <figure className="now-fan">
      <div style={{ width: "100%", height: 170 }}>
        <ResponsiveContainer>
          <ComposedChart data={rows} margin={{ top: 14, right: 8, bottom: 0, left: 0 }}>
            <XAxis
              dataKey="h"
              type="number"
              domain={[0, 72]}
              ticks={[0, 24, 48, 72]}
              tickFormatter={(h: number) => tick(issuedAt, h)}
              stroke="#c3c2b7"
              tick={{ fill: "#52514e", fontSize: 12 }}
            />
            <YAxis domain={[lo, hi]} width={36} stroke="#c3c2b7" tick={{ fill: "#52514e", fontSize: 12 }} tickFormatter={(v: number) => v.toFixed(1)} />
            <Area dataKey="wide" stroke="none" fill="#cde2fb" fillOpacity={1} isAnimationActive={false} />
            <Area dataKey="likely" stroke="none" fill="#86b6ef" fillOpacity={1} isAnimationActive={false} />
            <Line dataKey="median" stroke="#184f95" strokeWidth={2} strokeDasharray="5 3" dot={false} isAnimationActive={false} />
            <ReferenceLine
              y={threshold}
              stroke="var(--fc-risk-high)"
              strokeDasharray="6 3"
              label={{ value: `Flood level ${threshold.toFixed(2)} m`, position: "insideTopLeft", fill: "var(--fc-risk-high)", fontSize: 12 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <figcaption className="now-fan-caption">
        River level, next 72 h (m on this gauge; UK time, {zoneAt(issuedAt)} now{zoneAt(last) !== zoneAt(issuedAt) ? `, ${zoneAt(last)} later` : ""}).
        Dark blue: likely range; pale: wide range.
      </figcaption>
      <dl className="now-fan-chances" aria-label="Chance of flooding by each time">
        {[...sf.leads]
          .sort((a, b) => a.h - b.h)
          .map((l) => (
            <div key={l.h}>
              <dt>+{l.h} h</dt>
              <dd>{l.pFlood == null ? "–" : pctPlain(l.pFlood)}</dd>
            </div>
          ))}
      </dl>
    </figure>
  );
}
