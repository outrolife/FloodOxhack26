// The visual kit (#118). Screens import from "../ui".
export { Screen } from "./Screen";
export { Headline } from "./Headline";
export { StatTile, StatRow, type StatTone } from "./StatTile";
export { ShowTheWorking } from "./ShowTheWorking";
export { KeyHint } from "./KeyHint";
export { SpotClock, stateFor, countdownText, CLOCK_STYLE, WATCH_AT, LIKELY_AT, type ClockState } from "./SpotClock";
// BaseMap is NOT re-exported here: Leaflet needs `window` at import time, which would break
// node-environment tests of any screen. Import it directly: `import { BaseMap } from "../ui/BaseMap"`.
export {
  NOW,
  PLAYPAUSE_EVENT,
  STEP_EVENT,
  PICK_EVENT,
  viewFromHash,
  useHashView,
  usePlayerKeys,
  usePickKeys,
  type View,
  type StepDetail,
  type PickDetail,
} from "./presenter";
export { pctPlain, chanceWords, hoursWords, gaugeName } from "../lib/plain";
export { clockFor, clocksFor, shortSpotName, type ClockProps } from "./clockData";
// MapClocks (spot clocks on a BaseMap) also needs Leaflet: import it from "../ui/MapClocks".
// Its placement rule is pure and tested: ui/placement.ts.
export { CLOCK_BOX, spreadApart, needsLeader } from "./placement";
