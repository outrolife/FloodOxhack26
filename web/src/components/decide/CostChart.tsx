import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Costs, StrategyCost, StrategyKey } from "../../lib/costLoss";
import { formatCount, formatGBP, formatGBPCompact } from "./format";

// River Clock carries the model colour, official warnings the comparison
// colour; the two baselines share one neutral. Every bar is labelled on the
// axis and at its tip, so identity never depends on colour alone.
const COLOUR: Record<StrategyKey, string> = {
  riverClock: "var(--series-1)",
  official: "var(--series-2)",
  neverAct: "var(--unknown)",
  alwaysAct: "var(--unknown)",
};

type Row = StrategyCost & { cost: number };

export function CostChart({ strategies, costs, best }: { strategies: StrategyCost[]; costs: Costs; best: StrategyKey | null }) {
  const rows = strategies.filter((s): s is Row => s.cost !== null);
  const missing = strategies.filter((s) => s.cost === null);
  if (rows.length === 0) return <p className="muted">No backtest outcomes for this spot yet.</p>;

  return (
    <div>
      <div style={{ width: "100%", height: 56 * rows.length + 40 }}>
        <ResponsiveContainer>
          <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 90, bottom: 4, left: 8 }}>
            <CartesianGrid horizontal={false} stroke="var(--grid)" />
            <XAxis type="number" tickFormatter={(v: number) => formatGBPCompact(v)} stroke="var(--axis)" tick={{ fill: "var(--ink-2)", fontSize: 12 }} />
            <YAxis
              type="category"
              dataKey="label"
              width={130}
              stroke="var(--axis)"
              tick={{ fill: "var(--ink)", fontSize: 13 }}
              tickLine={false}
            />
            <Tooltip
              cursor={{ fill: "rgba(11,11,11,0.04)" }}
              content={({ active, payload }) => {
                const r = active && payload?.[0] ? (payload[0].payload as Row) : null;
                if (!r || !r.counts) return null;
                const { hits, falseAlarms, misses } = r.counts;
                return (
                  <div className="card small" style={{ margin: 0, padding: "0.4rem 0.6rem" }}>
                    <strong>{r.label}</strong>: {formatGBP(r.cost)}
                    <br />
                    {formatCount(hits)} hits + {formatCount(falseAlarms)} false alarms × {formatGBP(costs.C)}
                    <br />
                    {formatCount(misses)} misses × {formatGBP(costs.L)}
                  </div>
                );
              }}
            />
            <Bar dataKey="cost" barSize={24} radius={[0, 4, 4, 0]} isAnimationActive={false}>
              {rows.map((r) => (
                <Cell key={r.key} fill={COLOUR[r.key]} />
              ))}
              <LabelList
                dataKey="cost"
                position="right"
                content={(props) => {
                  const { x, y, width, height, value, index } = props as {
                    x: number; y: number; width: number; height: number; value: number; index: number;
                  };
                  const isBest = rows[index]?.key === best;
                  return (
                    <text x={x + width + 6} y={y + height / 2} dominantBaseline="central" fill="var(--ink)" fontSize={13} fontWeight={isBest ? 700 : 400}>
                      {formatGBP(value)}{isBest ? " · lowest" : ""}
                    </text>
                  );
                }}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      {missing.map((s) => (
        <p key={s.key} className="muted small">
          {s.label}: no data for this spot.
        </p>
      ))}
    </div>
  );
}
