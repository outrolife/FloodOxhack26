// SpotClock (#118): a trouble spot as a clock face whose ring fills with its
// flood chance, with a countdown underneath ("≈ 31 h"). State is shown three
// ways, never colour alone (#112): ring colour, a centre glyph shape
// (● calm, ▲ watch, ■ likely, ○ no forecast, ⊘ gauge offline) and a text label.
import type { KeyboardEvent } from "react";
import { pctPlain } from "../lib/plain";

export type ClockState = "calm" | "watch" | "likely" | "noforecast" | "stale";

/** Flood-state thresholds, shared with the old tabs (forecast.ts levelForP). */
export const WATCH_AT = 0.1;
export const LIKELY_AT = 0.5;

/** State for a flood chance: null → no forecast; ≥ 50% likely; ≥ 10% watch; else calm. */
export function stateFor(prob: number | null | undefined): ClockState {
  if (prob == null || Number.isNaN(prob)) return "noforecast";
  if (prob >= LIKELY_AT) return "likely";
  if (prob >= WATCH_AT) return "watch";
  return "calm";
}

/** Colour, plain label and shape per state. Status colours are for flood state only. */
export const CLOCK_STYLE: Record<ClockState, { colour: string; label: string; shape: string }> = {
  calm: { colour: "#009e73", label: "Unlikely", shape: "●" },
  watch: { colour: "#e09b00", label: "Possible", shape: "▲" },
  likely: { colour: "#d03b3b", label: "Likely", shape: "■" },
  noforecast: { colour: "#898781", label: "No forecast", shape: "○" },
  stale: { colour: "#898781", label: "Gauge offline", shape: "⊘" },
};

/** "≈ 31 h", "≈ 2 days 6 h", "now" or null. */
export function countdownText(h: number | null | undefined): string | null {
  if (h == null || Number.isNaN(h)) return null;
  if (h <= 0.5) return "now";
  const r = Math.round(h);
  if (r < 48) return `≈ ${r} h`;
  const d = Math.floor(r / 24);
  const rest = r % 24;
  return rest ? `≈ ${d} days ${rest} h` : `≈ ${d} days`;
}

const SIZES = { sm: 72, md: 112, lg: 168 } as const;

function Glyph({ state, cx, cy, r, colour }: { state: ClockState; cx: number; cy: number; r: number; colour: string }) {
  const ink = "#0b0b0b";
  switch (state) {
    case "calm":
      return <circle cx={cx} cy={cy} r={r} fill={colour} stroke={ink} strokeWidth={1} />;
    case "watch":
      return (
        <path
          d={`M${cx} ${cy - r * 1.15} L${cx + r * 1.1} ${cy + r * 0.8} L${cx - r * 1.1} ${cy + r * 0.8} Z`}
          fill={colour}
          stroke={ink}
          strokeWidth={1}
          strokeLinejoin="round"
        />
      );
    case "likely":
      return <rect x={cx - r * 0.9} y={cy - r * 0.9} width={r * 1.8} height={r * 1.8} fill={colour} stroke={ink} strokeWidth={1} />;
    case "noforecast":
      return <circle cx={cx} cy={cy} r={r} fill="#fff" stroke={colour} strokeWidth={2.5} />;
    case "stale":
      return (
        <g>
          <circle cx={cx} cy={cy} r={r} fill="#fff" stroke={colour} strokeWidth={2.5} />
          <line x1={cx - r * 0.7} y1={cy + r * 0.7} x2={cx + r * 0.7} y2={cy - r * 0.7} stroke={colour} strokeWidth={2.5} />
        </g>
      );
  }
}

export function SpotClock({
  label,
  prob,
  countdownH,
  state,
  size = "md",
  onClick,
  selected = false,
}: {
  label: string;
  /** Flood chance 0–1, or null when there is no forecast. */
  prob: number | null;
  /** Hours until the expected arrival (e.g. arrival.p50 − now), or null. */
  countdownH: number | null;
  state: ClockState;
  size?: "sm" | "md" | "lg";
  onClick?: () => void;
  selected?: boolean;
}) {
  const px = SIZES[size];
  const style = CLOCK_STYLE[state];
  const c = 50;
  const R = 42;
  const circ = 2 * Math.PI * R;
  const hasP = prob != null && (state === "calm" || state === "watch" || state === "likely");
  const frac = hasP ? Math.min(Math.max(prob as number, 0), 1) : 0;
  // A sliver always shows for a non-zero chance, so 1% doesn't look like nothing.
  const dash = frac > 0 ? Math.max(frac * circ, 2) : 0;
  const countdown = countdownText(countdownH);
  const centre = hasP ? pctPlain(prob) : style.label;
  const sentence = `${label}: ${style.label}${hasP ? `, ${pctPlain(prob)} chance of flooding` : ""}${countdown ? `, ${countdown}` : ""}`;
  const clickable = onClick != null;
  const onKey = (e: KeyboardEvent) => {
    if (clickable && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      onClick?.();
    }
  };

  return (
    <div
      className={`spot-clock spot-clock-${size}${selected ? " selected" : ""}${clickable ? " clickable" : ""}`}
      role={clickable ? "button" : "img"}
      tabIndex={clickable ? 0 : undefined}
      aria-label={sentence}
      aria-pressed={clickable ? selected : undefined}
      onClick={onClick}
      onKeyDown={onKey}
      data-state={state}
    >
      <svg width={px} height={px} viewBox="0 0 100 100" aria-hidden="true" focusable="false">
        <circle cx={c} cy={c} r={47} fill="#fff" stroke={selected ? "#0b0b0b" : "rgba(11,11,11,0.18)"} strokeWidth={selected ? 3 : 1.5} />
        {Array.from({ length: 12 }, (_, i) => {
          const a = (i / 12) * 2 * Math.PI;
          const long = i % 3 === 0;
          return (
            <line
              key={i}
              x1={c + Math.sin(a) * 47}
              y1={c - Math.cos(a) * 47}
              x2={c + Math.sin(a) * (long ? 40 : 43)}
              y2={c - Math.cos(a) * (long ? 40 : 43)}
              stroke="#c3c2b7"
              strokeWidth={long ? 2 : 1}
            />
          );
        })}
        <circle cx={c} cy={c} r={R} fill="none" stroke="#f0efec" strokeWidth={8} />
        {dash > 0 && (
          <circle
            cx={c}
            cy={c}
            r={R}
            fill="none"
            stroke={style.colour}
            strokeWidth={8}
            strokeDasharray={`${dash} ${circ}`}
            transform={`rotate(-90 ${c} ${c})`}
            strokeLinecap="butt"
            className="spot-clock-ring"
          />
        )}
        <Glyph state={state} cx={c} cy={33} r={6} colour={style.colour} />
        <text x={c} y={62} textAnchor="middle" fontSize={hasP ? 19 : 12} fontWeight={700} fill="#0b0b0b">
          {centre}
        </text>
      </svg>
      <div className="spot-clock-label">{label}</div>
      <div className="spot-clock-sub">
        <span aria-hidden="true">{style.shape}</span> {style.label}
        {countdown && <strong className="spot-clock-countdown"> {countdown}</strong>}
      </div>
    </div>
  );
}
