// One-screen UI components (#135, part of #118). The shell imports from "../clock".
export { Timeline, TimelineKey, type TimelineProps } from "./Timeline";
export { Scoreboard, ScoreboardView, type ScoreboardProps } from "./Scoreboard";
export { ProofFooter, ProofFooterView, WORKING_EVENT, openWorking } from "./ProofFooter";
export { EVENT_CHOICES, DEFAULT_SPOT, choiceFor, type ClockEventId, type EventChoice } from "./choices";
export { useClockEvent, loadLiveOnce, type ClockData } from "./useClockEvent";
export {
  COLOURS,
  MARKER_LABEL,
  chanceAt,
  nowMarkers,
  nowScore,
  proofSummary,
  proofText,
  replayMarkers,
  replayScore,
  storyEnd,
  type Marker,
  type ProofSummary,
  type ScoreLine,
} from "./story";
