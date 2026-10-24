// One glyph per flood-state tier, so the map never relies on colour alone
// (projectors wash colours out; about 1 in 12 men has red-green colour blindness):
//   ● low   ▲ elevated   ■ high   ○ no probability (timing only or stale)
// The same SVG is used for the map markers, the legend and the status chip.
import { LEVEL_STYLE, type Level } from "./forecast";

const INK = "#0b0b0b";

/** The tier's shape in a 24×24 box, drawn with the given fill and stroke. */
function shape(level: Level, fill: string, stroke: string, width: number): string {
  const s = `fill="${fill}" stroke="${stroke}" stroke-width="${width}" stroke-linejoin="round"`;
  switch (level) {
    case "low":
      return `<circle cx="12" cy="12" r="7.5" ${s}/>`;
    case "elevated":
      return `<path d="M12 3.2 L21.4 19.6 L2.6 19.6 Z" ${s}/>`;
    case "high":
      return `<rect x="4.5" y="4.5" width="15" height="15" ${s}/>`;
    case "unknown":
      return `<circle cx="12" cy="12" r="7" ${s}/>`;
  }
}

/**
 * SVG markup for a tier glyph. `halo` adds a white outline so it stands out on
 * map tiles; `selected` adds a dark ring around it.
 */
export function glyphSvg(level: Level, size: number, opts: { halo?: boolean; selected?: boolean } = {}): string {
  const colour = LEVEL_STYLE[level].colour;
  // "No probability" is hollow: a thick grey ring on white.
  const fill = level === "unknown" ? "#ffffff" : colour;
  const stroke = level === "unknown" ? colour : INK;
  const width = level === "unknown" ? 3 : 1.4;
  const parts = [
    opts.selected ? `<circle cx="12" cy="12" r="11" fill="#ffffff" stroke="${INK}" stroke-width="2"/>` : "",
    opts.halo ? shape(level, "#ffffff", "#ffffff", width + 3.5) : "",
    shape(level, fill, stroke, width),
  ];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${parts.join("")}</svg>`;
}

/** Inline glyph for legends and chips (decorative: always next to its text label). */
export function LevelGlyph({ level, size = 14 }: { level: Level; size?: number }) {
  return (
    <span
      className="glyph"
      aria-hidden="true"
      style={{ width: size, height: size }}
      dangerouslySetInnerHTML={{ __html: glyphSvg(level, size) }}
    />
  );
}
