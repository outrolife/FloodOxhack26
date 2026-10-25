// One-glance "how it works" diagram for the About tab (#102, SPEC §1, §6, §7, §10.2).
// Five boxes, left to right: gauges -> travel times -> quantile forecasts ->
// calibrated probability -> decision. The travel-time example is read from
// travel_times.json at runtime, so it always matches the data the app ships.
import { useId } from "react";
import type { TravelPair, TravelTimesFile } from "../../contracts";
import { useData } from "../../data";

/** The pair shown as the example: Enslow (Cherwell) -> Kings Mill, our cleanest travel time. */
export const EXAMPLE_PAIR = { up: "enslow", down: "kingsmill", upName: "Enslow", downName: "Kings Mill" };

export type TravelExample = { median: number; p10: number; p90: number; n: number };

/** Rounded half-rise travel time for the example pair, or null if it's missing or unusable. */
export function travelExample(pairs: TravelPair[] | undefined): TravelExample | null {
  const p = pairs?.find((x) => x.up === EXAMPLE_PAIR.up && x.down === EXAMPLE_PAIR.down);
  if (!p || !Number.isFinite(p.tHalf?.median) || p.tHalf.median <= 0) return null;
  return {
    median: Math.round(p.tHalf.median),
    p10: Math.round(p.tHalf.p10),
    p90: Math.round(p.tHalf.p90),
    n: p.n,
  };
}

type Stage = { title: string[]; detail: string[]; plain: string[]; label: string };

export function stages(t: TravelExample | null): Stage[] {
  const route = `${EXAMPLE_PAIR.upName} → ${EXAMPLE_PAIR.downName}`;
  return [
    {
      label: "Upstream EA river gauges",
      title: ["Upstream", "EA river gauges"],
      detail: ["Thames, Windrush, Evenlode", "and Cherwell gauges"],
      plain: ["Water already in the river", "upstream of Oxford."],
    },
    {
      label: "Travel times",
      title: ["Travel times"],
      detail: t
        ? [route, `≈ ${t.median} h (${t.p10}–${t.p90} h)`, `median of ${t.n} past floods`]
        : [route, "measured from", "past floods"],
      plain: ["How long a flood wave takes", "to reach Oxford."],
    },
    {
      label: "LightGBM quantile forecasts, 6 to 72 h",
      title: ["LightGBM quantile", "forecasts"],
      detail: ["6 to 72 h ahead,", "5th to 95th percentile"],
      plain: ["A range of likely river", "levels, not one guess."],
    },
    {
      label: "Calibrated flood probability per spot",
      title: ["Calibrated flood", "probability"],
      detail: ["for each trouble spot,", "and when it reaches 50%"],
      plain: ["The chance each spot passes", "its flood level, and when."],
    },
    {
      label: "Decide: act when P ≥ C/L",
      title: ["Decide"],
      detail: ["act when P ≥ C / L", "C = cost of acting", "L = loss it avoids"],
      plain: ["Act when the chance is", "worth what acting costs."],
    },
  ];
}

// Layout in viewBox units (scaled to the card width).
const W = 1200;
const BOX_W = 204;
const GAP = (W - 5 * BOX_W) / 4; // room for each arrow
const BOX_Y = 18;
const BOX_H = 150;
const PLAIN_Y = BOX_Y + BOX_H + 28;
const H = PLAIN_Y + 30;

// Colours: one blue family that differs in lightness, so the boxes read the
// same for colour-blind viewers; meaning is carried by text and step numbers.
const FILL = "#eef3fa";
const STROKE = "#2a78d6";
const DARK = "#184f95";
const INK = "#0b0b0b";
const INK_2 = "#52514e";

export function HowItWorksDiagram({ travel }: { travel: TravelExample | null }) {
  const id = useId();
  const titleId = `${id}-title`;
  const descId = `${id}-desc`;
  const markerId = `${id}-arrow`;
  const list = stages(travel);
  const desc =
    "Five steps, left to right. " +
    list
      .map((s, i) => `${i + 1}. ${s.label}: ${s.detail.join(" ")}. ${s.plain.join(" ")}`)
      .join(" ");

  return (
    <div className="hiw" style={{ overflowX: "auto" }}>
      <svg
        className="hiw-svg"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-labelledby={`${titleId} ${descId}`}
        style={{ width: "100%", minWidth: 860, height: "auto", display: "block" }}
      >
        <title id={titleId}>How River Clock works</title>
        <desc id={descId}>{desc}</desc>
        <defs>
          <marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0,0 L10,5 L0,10 z" fill={INK_2} />
          </marker>
        </defs>
        {list.map((s, i) => {
          const x = i * (BOX_W + GAP);
          const cx = x + BOX_W / 2;
          const last = i === list.length - 1;
          const text = last ? "#fff" : INK;
          const sub = last ? "#e6eefa" : INK_2;
          const titleTop = BOX_Y + 40;
          const detailTop = titleTop + s.title.length * 21 + 6;
          return (
            <g key={s.label} className="hiw-stage" data-stage={i + 1}>
              <rect
                x={x + 1}
                y={BOX_Y}
                width={BOX_W - 2}
                height={BOX_H}
                rx={10}
                fill={last ? DARK : FILL}
                stroke={last ? DARK : STROKE}
                strokeWidth={2}
              />
              <circle cx={cx} cy={BOX_Y} r={14} fill={last ? "#fff" : DARK} stroke={DARK} strokeWidth={2} />
              <text x={cx} y={BOX_Y + 5} textAnchor="middle" fontSize={14} fontWeight={700} fill={last ? DARK : "#fff"}>
                {i + 1}
              </text>
              <text textAnchor="middle" fontSize={17} fontWeight={700} fill={text}>
                {s.title.map((line, k) => (
                  <tspan key={k} x={cx} y={titleTop + k * 21}>
                    {line}
                  </tspan>
                ))}
              </text>
              <text textAnchor="middle" fontSize={14} fill={sub}>
                {s.detail.map((line, k) => (
                  <tspan key={k} x={cx} y={detailTop + k * 18}>
                    {line}
                  </tspan>
                ))}
              </text>
              <text textAnchor="middle" fontSize={14} fill={INK} className="hiw-plain">
                {s.plain.map((line, k) => (
                  <tspan key={k} x={cx} y={PLAIN_Y + k * 18}>
                    {line}
                  </tspan>
                ))}
              </text>
              {!last && (
                <line
                  x1={x + BOX_W + 6}
                  y1={BOX_Y + BOX_H / 2}
                  x2={x + BOX_W + GAP - 6}
                  y2={BOX_Y + BOX_H / 2}
                  stroke={INK_2}
                  strokeWidth={2.5}
                  markerEnd={`url(#${markerId})`}
                />
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** About-tab card: the diagram with the live travel-time example and an honest caption. */
export default function HowItWorks() {
  const travel = useData<TravelTimesFile>("travel_times.json");
  const example = travel.status === "ready" ? travelExample(travel.data) : null;
  return (
    <section className="card hiw-card" style={{ gridColumn: "1 / -1" }} aria-labelledby="hiw-heading">
      <h2 id="hiw-heading">How it works at a glance</h2>
      <HowItWorksDiagram travel={example} />
      <p className="small muted" style={{ marginTop: "0.6rem", marginBottom: 0 }}>
        River Clock reads water already in the river and rain that has already fallen; it does not
        forecast rain still to come. It is a decision-support prototype that sits alongside official
        Environment Agency warnings, not in place of them.
      </p>
    </section>
  );
}
