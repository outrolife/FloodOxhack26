// How the backtest counts floods (model/metrics.py, SPEC §8.2). One wording,
// used wherever the UI shows hit / miss / flood counts, so Decide and Proof
// say the same thing (#99). Plain English for judges; the precise rule is in
// FLOOD_EPISODE_RULE (for tooltips).

/** Short label for the unit the backtest counts. */
export const FLOOD_EPISODES = "flood episodes (counted once per flood)";

/** Footnote: the 72 h rule and the already-flooding rule, in plain words. */
export const FLOOD_EPISODE_NOTE =
  "We count each flood once: if the river goes back over the flood line less than 72 h (3 days) later, " +
  "it is still the same flood. Two separate floods in one event (3 days or more apart) count twice, so " +
  "these counts can be higher than the number of \"Yes\" rows in the event-by-event table. A forecast " +
  "made when the river is already over the line doesn't count as a warning, right or wrong.";

/** The precise rule (model/metrics.py), for a title tooltip. */
export const FLOOD_EPISODE_RULE =
  "Flood onset = an up-crossing of the threshold at least 72 h after the previous one; " +
  "forecasts issued while the gauge is already above the threshold are not triggers.";
