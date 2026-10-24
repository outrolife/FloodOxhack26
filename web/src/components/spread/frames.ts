// S3 (SPEC §11): pure helpers for the experimental flood-spread overlay.
// No React and no Leaflet here, so the frame choice is easy to test.
import type { SpreadManifest } from "../../contracts";

export type SpreadFrame = SpreadManifest["frames"][number];

/** Lead times the spread runs are computed for (SPEC §11 S3), in hours. */
export const SPREAD_LEADS = [6, 12, 24, 36, 48, 72] as const;

/** Default lead: the River map colours spots by the 24 h chance, so match it. */
export const DEFAULT_LEAD = 24;

/** SPEC §11 S3 "Limitations shown in UI", verbatim. */
export const SPREAD_LIMITATIONS =
  "Experimental. A simple terrain fill: ignores channel flow, walls, drains, pumps and defences. Ensemble frequency, not a verified flood probability.";

/**
 * Colour ramp of the PNG frames: share of the runs (0-1) in which a 25 m square
 * is wet, green to red. Squares below the first stop are transparent. Must match
 * the ramp in stretch/s3 (alfredo-s3).
 */
export const SPREAD_RAMP: { at: number; colour: string }[] = [
  { at: 0.05, colour: "#1a9850" },
  { at: 0.3, colour: "#91cf60" },
  { at: 0.5, colour: "#fee08b" },
  { at: 0.75, colour: "#fc8d59" },
  { at: 1, colour: "#d73027" },
];

/** Ticks under the legend bar. */
export const SPREAD_TICKS = [0.05, 0.25, 0.5, 0.75, 1];

/** Position (0-100%) of a share along the legend bar, which runs from the first ramp stop to 100%. */
export function legendPos(share: number): number {
  const lo = SPREAD_RAMP[0].at;
  return ((share - lo) / (1 - lo)) * 100;
}

/** CSS gradient for the legend bar, with the ramp's stops at their true positions. */
export function legendGradient(): string {
  const stops = SPREAD_RAMP.map((s) => `${s.colour} ${legendPos(s.at).toFixed(1)}%`);
  return `linear-gradient(to right, ${stops.join(", ")})`;
}

/** Legend title. */
export const legendTitle = (runs: number): string => `Share of ${runs} simulated floods that wet this square`;

/** Shown when there's no manifest for this context (the toggle is disabled). */
export const NO_SPREAD_NOTE = "No flood-spread run for this event yet.";

export type FramePick =
  | { kind: "frame"; frame: SpreadFrame }
  /** Every frame was issued after `at`: showing one would leak the future. */
  | { kind: "notYet"; firstIssuedAt: string }
  | { kind: "none" };

/**
 * The frame to draw for lead `tau` (hours).
 *
 * With `at` (the Time Machine slider time), only frames issued at or before `at`
 * count, and of those the latest issue time wins, so the map never shows a
 * forecast from the slider's future. Without `at` (live), the latest issue wins.
 * Within that issue, the frame with the nearest lead is chosen (ties go to the
 * shorter lead).
 */
export function pickFrame(frames: SpreadFrame[], tau: number, at?: string): FramePick {
  if (frames.length === 0) return { kind: "none" };
  const atMs = at === undefined ? Infinity : Date.parse(at);
  const usable = frames.filter((f) => Date.parse(f.issuedAt) <= atMs);
  if (usable.length === 0) {
    const first = frames.reduce((a, b) => (Date.parse(b.issuedAt) < Date.parse(a.issuedAt) ? b : a));
    return { kind: "notYet", firstIssuedAt: first.issuedAt };
  }
  const latest = Math.max(...usable.map((f) => Date.parse(f.issuedAt)));
  const sameIssue = usable.filter((f) => Date.parse(f.issuedAt) === latest);
  const best = sameIssue.reduce((a, b) => {
    const da = Math.abs(a.tau - tau);
    const db = Math.abs(b.tau - tau);
    return db < da || (db === da && b.tau < a.tau) ? b : a;
  });
  return { kind: "frame", frame: best };
}

/** "Matches the recorded Jan 2014 outline: IoU 0.62", or null without validation. */
export function iouSentence(validation: SpreadManifest["validation"], eventLabel?: string): string | null {
  if (!validation) return null;
  const label = eventLabel ?? EVENT_MONTHS[validation.eventId] ?? validation.eventId;
  return `Matches the recorded ${label} outline: IoU ${validation.iou.toFixed(2)}`;
}

// SPEC §11 S3 validates against e2014 only; other ids are shown as they are.
const EVENT_MONTHS: Record<string, string> = { e2014: "Jan 2014" };

/** Manifest file for a context: "live" or an event id such as "e2014". */
export const manifestFile = (context: string): string => `spread/${context}/manifest.json`;

/**
 * URL of a frame's PNG. `png` is relative to /data/ (e.g. "spread/e2014/tau24.png");
 * a bare file name is taken as relative to the manifest's folder.
 */
export function frameUrl(png: string, context: string): string {
  const path = png.includes("/") ? png.replace(/^\/+/, "") : `spread/${context}/${png}`;
  return `${import.meta.env.BASE_URL}data/${path}`;
}

/**
 * Only a real run counts. The fixture manifest (tests/fixtures/) is for tests:
 * the app never draws a placeholder overlay, so a missing run means no overlay.
 */
export function usableManifest<T>(state: { status: string; data?: T; source?: string }): T | null {
  return state.status === "ready" && state.source === "data" ? (state.data ?? null) : null;
}
