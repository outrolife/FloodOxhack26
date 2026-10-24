// The one-screen UI's top switch (#118, #135): "Now" and the past floods, with
// one-word labels. The first five are always shown; the rest go under "more".
// Event ids are the ones in events.json; the shell may hide a choice whose
// replay file is missing.

/** "now" = live.json; anything else = replays/<id>.json. */
export type ClockEventId = "now" | (string & {});

export type EventChoice = {
  id: ClockEventId;
  /** One word for the switch. */
  label: string;
  /** Spot selected when this choice is picked. */
  defaultSpot: string;
  /** false = on the switch; true = under "more". */
  more: boolean;
};

export const DEFAULT_SPOT = "botley";

export const EVENT_CHOICES: readonly EventChoice[] = [
  { id: "now", label: "Now", defaultSpot: DEFAULT_SPOT, more: false },
  { id: "e2014", label: "2014", defaultSpot: DEFAULT_SPOT, more: false },
  { id: "e2024a", label: "Henk", defaultSpot: DEFAULT_SPOT, more: false }, // Storm Henk, Jan 2024
  { id: "e2024b", label: "Bert", defaultSpot: DEFAULT_SPOT, more: false }, // Storm Bert, Nov 2024
  { id: "e2026", label: "2026", defaultSpot: DEFAULT_SPOT, more: false },
  { id: "e2007", label: "2007", defaultSpot: DEFAULT_SPOT, more: true },
  { id: "e2012", label: "2012", defaultSpot: DEFAULT_SPOT, more: true },
  { id: "e2021", label: "2021", defaultSpot: DEFAULT_SPOT, more: true },
];

export const choiceFor = (id: ClockEventId): EventChoice | undefined => EVENT_CHOICES.find((c) => c.id === id);
