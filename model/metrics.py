"""Proof metrics (SPEC §8.2): pure functions, no I/O, no models.

``model/proof.py`` feeds these with test-period predictions and §9 ``Replay`` dicts and writes
``web/public/data/proof.json``. Everything here takes plain arrays, pandas objects or §9 dicts, so each
number can be checked by hand (``tests/test_metrics.py``).

No look-ahead: every comparison pairs a forecast issued at t with an observation at a later time
(t + h for quantiles and probabilities, the crossing time for triggers). Nothing observed after t is
used to build the forecast; these functions only score it afterwards.

Definitions (used in the UI and by judges):
- **Pinball loss** for quantile level a: ``mean(max(a (y - q), (a - 1) (y - q)))``. We report the mean
  over the seven levels. **Skill** = 1 - model / persistence (above 0 = better than persistence).
- **Coverage** of the 50/80/90% intervals (q25-q75, q10-q90, q05-q95): fraction of observations inside,
  bounds included.
- **Brier score** = ``mean((p - o)^2)``. The app's ``pFlood_h`` is non-decreasing in h (SPEC §7.5
  step 4), i.e. "over the line **by** t + h", so o = 1 if the level is at or above the line at any hour
  in (t, t + h] (#91). Issue times when the river is already at or above the line are left out: the
  flood is here, so they are not forecasts of a crossing (the same rule as the triggers below).
  **Reliability**: 10 equal-width bins of p; per bin the mean forecast (pPred), the observed frequency
  (pObs) and the count (n). Empty bins are left out, because the §9 contract has ``pObs: number``.
- **Trigger** at p*: an issue time whose forecast flood probability (max over leads) is >= p*, while
  the gauge is still below the line (once it is above, the flood is here: no trigger, no false alarm).
  **Episode**: a run of triggers in which consecutive triggers are less than 24 h apart; a trigger 24 h
  or more after the previous one starts a new episode.
- **Flood onset**: the observed up-crossings of the threshold, keeping only those 72 h or more after
  the previous up-crossing. A level hovering at the line crosses it many times in one flood; those
  repeats are one flood, scored once.
- **Hit**: a flood onset c with at least one trigger in the 72 h before it, i.e. issued in [c - 72 h, c).
  **Lead** = c - the first trigger in that window (so at most 72 h).
  **Miss**: a crossing with no trigger in that window.
  **False alarm**: an episode with no crossing from its first trigger to 72 h after its last one.
  An episode that overlaps a crossing (e.g. one that only starts once the river is already over the
  line) is never a false alarm; if it started too late, the crossing is already counted as a miss.
- **Official warnings as a trigger**: an EA Flood Warning is one message, not an hourly forecast, so
  it counts as in force from its issue time until 24 h after the last Update to it (before the next
  fresh warning), capped at the event end (#92). Its in-force times on our issue-time grid plus its own
  issue time, leaving out times when the river is already over the line (as for our trigger), are then
  scored with the same hit/miss/false-alarm rules.
- **Arrival error**: the forecast issued 24 h (or 48 h) before a crossing gives a 50% arrival time;
  error = that time - the actual crossing, in hours (negative = predicted too early).
- **Bootstrap**: resample events with replacement (1,000 times, seed 42) and recompute the statistic;
  the 90% interval is the 5th to 95th percentile of the resampled values.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping, Sequence
from typing import Any

import numpy as np
import pandas as pd

ALPHAS: tuple[float, ...] = (0.05, 0.10, 0.25, 0.50, 0.75, 0.90, 0.95)
QUANT_KEYS: tuple[str, ...] = ("05", "10", "25", "50", "75", "90", "95")
# Nominal coverage -> (lower, upper) column index into ALPHAS.
INTERVALS: dict[float, tuple[int, int]] = {0.5: (2, 4), 0.8: (1, 5), 0.9: (0, 6)}
# SPEC §8.2 p* in {0.1, ..., 0.9}, plus 0.01, 0.02 and 0.05 for the Decide presets (#38).
P_STARS: tuple[float, ...] = (0.01, 0.02, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9)
HIT_WINDOW = pd.Timedelta(hours=72)
EPISODE_GAP = pd.Timedelta(hours=24)
ARRIVAL_OFFSETS_H: tuple[int, ...] = (24, 48)
N_BOOT = 1000
SEED = 42


def _utc(x: Any) -> pd.Timestamp:
    t = pd.Timestamp(x)
    return t.tz_localize("UTC") if t.tzinfo is None else t.tz_convert("UTC")


def _hours(td: pd.Timedelta) -> float:
    return td.total_seconds() / 3600


def _finite_rows(q: np.ndarray, y: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Drop rows where y or any quantile is NaN (gaps in the record are not scored)."""
    q = np.asarray(q, dtype=float)
    y = np.asarray(y, dtype=float)
    ok = np.isfinite(y) & np.isfinite(q).all(axis=1)
    return q[ok], y[ok]


# --------------------------------------------------------------------------- quantile scores


def pinball_loss(q: np.ndarray, y: np.ndarray, alphas: Sequence[float] = ALPHAS) -> float:
    """Mean pinball loss over rows and quantile levels. ``q``: (n, len(alphas)); ``y``: (n,)."""
    q, y = _finite_rows(q, y)
    if len(y) == 0:
        return float("nan")
    a = np.asarray(alphas, dtype=float)[None, :]
    diff = y[:, None] - q
    return float(np.maximum(a * diff, (a - 1) * diff).mean())


def skill(model_score: float, baseline_score: float) -> float:
    """1 - model / baseline (pinball or Brier). NaN if the baseline is 0 or missing."""
    if not np.isfinite(baseline_score) or baseline_score == 0 or not np.isfinite(model_score):
        return float("nan")
    return 1.0 - model_score / baseline_score


def interval_coverage(q: np.ndarray, y: np.ndarray) -> dict[float, float]:
    """Fraction of y inside the 50/80/90% intervals (bounds included). ``q`` columns follow ALPHAS."""
    q, y = _finite_rows(q, y)
    if len(y) == 0:
        return {nom: float("nan") for nom in INTERVALS}
    return {nom: float(((q[:, lo] <= y) & (y <= q[:, hi])).mean()) for nom, (lo, hi) in INTERVALS.items()}


def skill_by_lead(
    model_q: Mapping[int, np.ndarray],
    persistence_q: Mapping[int, np.ndarray],
    y: Mapping[int, np.ndarray],
    nd: int = 4,
) -> list[dict[str, float]]:
    """``Proof.skillByLead``: one row per lead h, scored on the same rows for model and persistence."""
    rows = []
    for h in sorted(model_q):
        m = pinball_loss(model_q[h], y[h])
        p = pinball_loss(persistence_q[h], y[h])
        s = skill(m, p)
        rows.append(
            {
                "h": int(h),
                "pinballModel": round(m, nd),
                "pinballPersistence": round(p, nd),
                "skill": round(s, nd),
            }
        )
    return rows


def coverage_by_lead(
    model_q: Mapping[int, np.ndarray], y: Mapping[int, np.ndarray], nd: int = 4
) -> list[dict[str, float]]:
    """``Proof.coverage``: one row per (lead, nominal level)."""
    rows = []
    for h in sorted(model_q):
        for nom, actual in interval_coverage(model_q[h], y[h]).items():
            rows.append({"h": int(h), "nominal": nom, "actual": round(actual, nd)})
    return rows


# --------------------------------------------------------------------------- exceedance scores


def _finite_pairs(p: np.ndarray, o: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    p = np.asarray(p, dtype=float)
    o = np.asarray(o, dtype=float)
    ok = np.isfinite(p) & np.isfinite(o)
    return p[ok], o[ok]


def brier_score(p: np.ndarray, o: np.ndarray) -> float:
    """Mean squared difference between probability p and outcome o (0 or 1)."""
    p, o = _finite_pairs(p, o)
    return float(np.mean((p - o) ** 2)) if len(p) else float("nan")


def reliability_bins(p: np.ndarray, o: np.ndarray, n_bins: int = 10, nd: int = 4) -> list[dict[str, float]]:
    """Reliability diagram points: equal-width bins on [0, 1]; p = 1 goes in the top bin.

    Empty bins are dropped (``pObs`` must be a number in the §9 contract).
    """
    p, o = _finite_pairs(p, o)
    idx = np.minimum((p * n_bins).astype(int), n_bins - 1)
    out = []
    for b in range(n_bins):
        sel = idx == b
        n = int(sel.sum())
        if n == 0:
            continue
        out.append(
            {"pPred": round(float(p[sel].mean()), nd), "pObs": round(float(o[sel].mean()), nd), "n": n}
        )
    return out


def exceedance_outcome(y_level: np.ndarray, line: float) -> np.ndarray:
    """1.0 where the observed level is at or above ``line``, 0.0 below, NaN where missing."""
    y = np.asarray(y_level, dtype=float)
    return np.where(np.isfinite(y), (y >= line).astype(float), np.nan)


def max_level_ahead(level: pd.Series, index: pd.DatetimeIndex, h: int) -> np.ndarray:
    """Per time t in ``index``: the highest hourly ``level`` in (t, t + h] (missing hours skipped).

    ``level`` is an hourly series on a UTC index. NaN when no hour in (t, t + h] was observed.
    """
    s = level.sort_index()
    s = s[~s.index.duplicated()]
    idx = pd.DatetimeIndex(index)
    lo = min(s.index.min(), idx.min())
    hi = max(s.index.max(), idx.max()) + pd.Timedelta(hours=h)
    full = s.reindex(pd.date_range(lo, hi, freq="h"))
    # The rolling window ending at t + h covers t + 1 ... t + h; shifting by -h puts it at t.
    ahead = full.rolling(h, min_periods=1).max().shift(-h)
    return ahead.reindex(idx).to_numpy(dtype=float)


def exceedance_by_outcome(
    level_now: np.ndarray, level_at_h: np.ndarray, max_ahead: np.ndarray, line: float
) -> np.ndarray:
    """1.0 if the level reaches ``line`` at any hour in (t, t + h], 0.0 if not, NaN if unscored.

    NaN where the level at t + h is missing (the row is not scored, as for pinball loss) or where
    ``level_now`` is already at or above the line (the flood is here; not a forecast of a crossing).
    """
    now = np.asarray(level_now, dtype=float)
    at_h = np.asarray(level_at_h, dtype=float)
    peak = np.fmax(np.asarray(max_ahead, dtype=float), at_h)
    o = (peak >= line).astype(float)
    return np.where(np.isfinite(at_h) & np.isfinite(now) & (now < line), o, np.nan)


def reliability_entry(
    h: int, p_model: np.ndarray, p_persistence: np.ndarray, o: np.ndarray, nd: int = 4
) -> dict[str, Any]:
    """One ``Proof.reliability[spot][]`` item: bins, Brier for model and persistence on the same rows."""
    p_model = np.asarray(p_model, dtype=float)
    p_persistence = np.asarray(p_persistence, dtype=float)
    o = np.asarray(o, dtype=float)
    ok = np.isfinite(p_model) & np.isfinite(p_persistence) & np.isfinite(o)
    return {
        "h": int(h),
        "bins": reliability_bins(p_model[ok], o[ok], nd=nd),
        "brier": round(brier_score(p_model[ok], o[ok]), nd),
        "brierPersistence": round(brier_score(p_persistence[ok], o[ok]), nd),
    }


# --------------------------------------------------------------------------- triggers and events


def trigger_times(p: pd.Series, p_star: float) -> pd.DatetimeIndex:
    """Issue times where the flood probability is >= p* (NaN never triggers)."""
    s = p.sort_index()
    return pd.DatetimeIndex(s.index[(s >= p_star).to_numpy()])


def flood_onsets(crossings: Iterable[Any], gap: pd.Timedelta = HIT_WINDOW) -> list[pd.Timestamp]:
    """Up-crossings that start a new flood: those ``gap`` (72 h) or more after the previous up-crossing."""
    out: list[pd.Timestamp] = []
    prev: pd.Timestamp | None = None
    for c in sorted(_utc(x) for x in crossings):
        if prev is None or c - prev >= gap:
            out.append(c)
        prev = c
    return out


def episodes(
    times: Iterable[Any], gap: pd.Timedelta = EPISODE_GAP
) -> list[tuple[pd.Timestamp, pd.Timestamp]]:
    """Group sorted trigger times into (first, last) episodes; a gap of >= ``gap`` starts a new one."""
    ts = sorted(_utc(t) for t in times)
    out: list[tuple[pd.Timestamp, pd.Timestamp]] = []
    for t in ts:
        if out and t - out[-1][1] < gap:
            out[-1] = (out[-1][0], t)
        else:
            out.append((t, t))
    return out


def event_outcomes(
    triggers: Iterable[Any],
    crossings: Iterable[Any],
    window: pd.Timedelta = HIT_WINDOW,
    gap: pd.Timedelta = EPISODE_GAP,
) -> dict[str, Any]:
    """Hits, misses, false alarms and leads (hours) for one spot from trigger and crossing times.

    Works for our triggers (``trigger_times``) and for official warning issue times alike.
    """
    trig = sorted(_utc(t) for t in triggers)
    cross = sorted(_utc(c) for c in crossings)
    leads: list[float] = []
    per_crossing: list[dict[str, Any]] = []
    for c in cross:
        before = [t for t in trig if c - window <= t < c]
        lead = _hours(c - before[0]) if before else None
        if lead is not None:
            leads.append(lead)
        per_crossing.append(
            {"t": c, "hit": lead is not None, "leadH": lead, "firstTrigger": before[0] if before else None}
        )
    eps = episodes(trig, gap)
    false_alarms = [(a, b) for a, b in eps if not any(a <= c <= b + window for c in cross)]
    return {
        "hits": len(leads),
        "misses": len(cross) - len(leads),
        "falseAlarms": len(false_alarms),
        "leads": leads,
        "crossings": per_crossing,
        "falseAlarmEpisodes": false_alarms,
    }


def mean_or_none(values: Sequence[float], nd: int = 2) -> float | None:
    vals = [float(v) for v in values if v is not None and np.isfinite(v)]
    return round(float(np.mean(vals)), nd) if vals else None


def tradeoff_rows(
    p_by_event: Mapping[str, pd.Series],
    crossings_by_event: Mapping[str, Sequence[Any]],
    p_stars: Sequence[float] = P_STARS,
    lead_vs_official: Callable[[float], float | None] | None = None,
    n_boot: int = N_BOOT,
    seed: int = SEED,
) -> list[dict[str, Any]]:
    """``Proof.tradeoff[spot]``: outcomes summed over events, per p*.

    ``p_by_event`` maps event id -> that spot's flood probability per issue time;
    ``crossings_by_event`` maps event id -> crossing times. ``meanLeadH`` pools the leads of all hits;
    ``ci90`` is its 90% bootstrap interval over events (omitted when there are no hits).
    ``lead_vs_official(p*)`` gives ``meanLeadVsOfficialH`` (e.g. ``official.mean_lead_vs_official``).
    """
    rows = []
    for p_star in p_stars:
        hits = misses = fas = 0
        leads_per_event: list[list[float]] = []
        for eid, p in p_by_event.items():
            res = event_outcomes(trigger_times(p, p_star), crossings_by_event.get(eid, []))
            hits += res["hits"]
            misses += res["misses"]
            fas += res["falseAlarms"]
            leads_per_event.append(res["leads"])
        all_leads = [x for ls in leads_per_event for x in ls]
        row: dict[str, Any] = {
            "pStar": float(p_star),
            "hits": hits,
            "misses": misses,
            "falseAlarms": fas,
            "meanLeadH": mean_or_none(all_leads),
            "meanLeadVsOfficialH": lead_vs_official(p_star) if lead_vs_official else None,
        }
        ci = bootstrap_ci(leads_per_event, pooled_mean, n_boot=n_boot, seed=seed)
        if ci is not None:
            row["ci90"] = [round(ci[0], 2), round(ci[1], 2)]
        rows.append(row)
    return rows


OFFICIAL_HOLD = pd.Timedelta(hours=24)


def in_force_times(
    messages: Iterable[tuple[Any, bool]],
    grid: Iterable[Any],
    end: Any = None,
    hold: pd.Timedelta = OFFICIAL_HOLD,
) -> pd.DatetimeIndex:
    """Times on ``grid`` when an official warning is in force (#92).

    ``messages`` are ``(issued_at, is_update)``. A fresh warning is in force from its issue time to
    ``hold`` after the last Update issued before the next fresh warning (or after itself if none),
    capped at ``end``. Without this, a warning issued more than 72 h before a crossing and still in
    force at it scored as a miss plus a false alarm.
    """
    msgs = sorted((_utc(t), bool(u)) for t, u in messages)
    fresh = [t for t, u in msgs if not u]
    updates = [t for t, u in msgs if u]
    spans = []
    for i, f in enumerate(fresh):
        nxt = fresh[i + 1] if i + 1 < len(fresh) else None
        last = max([u for u in updates if u >= f and (nxt is None or u < nxt)], default=f)
        until = last + hold
        if end is not None:
            until = min(until, _utc(end))
        spans.append((f, until))
    g = sorted(_utc(t) for t in grid)
    return pd.DatetimeIndex([t for t in g if any(a <= t <= b for a, b in spans)])


def official_outcome(
    official_by_event: Mapping[str, Sequence[Any]],
    crossings_by_event: Mapping[str, Sequence[Any]],
) -> dict[str, Any]:
    """``Proof.officialOutcome[spot]``: the EA warnings scored with the same hit/miss/false-alarm rules.

    ``official_by_event`` maps event id -> the times the official warning counts as a trigger
    (``in_force_times``; callers choose the level, e.g. Flood Warning and above).
    """
    hits = misses = fas = 0
    leads: list[float] = []
    for eid in sorted(set(official_by_event) | set(crossings_by_event)):
        res = event_outcomes(official_by_event.get(eid, []), crossings_by_event.get(eid, []))
        hits += res["hits"]
        misses += res["misses"]
        fas += res["falseAlarms"]
        leads += res["leads"]
    return {"hits": hits, "misses": misses, "falseAlarms": fas, "meanLeadH": mean_or_none(leads)}


# --------------------------------------------------------------------------- replay helpers


def spot_probability(
    forecasts: Iterable[Mapping[str, Any]], spot: str, threshold: float | None = None
) -> pd.Series:
    """Flood probability per issue time for ``spot``: max ``pFlood`` over leads (= the 72 h value).

    Same rule as ``model.official.trigger_series``. ``timing_only`` spots give NaN and never trigger.
    With ``threshold``, issue times when ``levelNow`` is already at or above it give NaN: the flood is
    already here, so such a "trigger" is neither a warning of a crossing nor a false alarm.
    """
    times: list[pd.Timestamp] = []
    vals: list[float] = []
    for fc in forecasts:
        for sf in fc["spots"]:
            if sf["spot"] == spot:
                ps = [ld["pFlood"] for ld in sf["leads"] if ld.get("pFlood") is not None]
                above = (
                    threshold is not None and sf.get("levelNow") is not None and sf["levelNow"] >= threshold
                )
                times.append(_utc(fc["issuedAt"]))
                vals.append(max(ps) if ps and not above else np.nan)
    return pd.Series(vals, index=pd.DatetimeIndex(times), dtype=float).sort_index()


def arrival_error_h(
    forecasts: Iterable[Mapping[str, Any]], spot: str, crossing: Any, offset_h: int, tolerance_h: int = 1
) -> float | None:
    """Predicted 50% arrival - actual crossing (hours), for the forecast issued ``offset_h`` before it.

    Uses the latest forecast issued in [crossing - offset - tolerance, crossing - offset] (replays are
    hourly, or every 2 h for e2014, so a 1 h tolerance always finds one). None if there is none or it
    gives no 50% arrival within 72 h.
    """
    latest = _utc(crossing) - pd.Timedelta(hours=offset_h)
    earliest = latest - pd.Timedelta(hours=tolerance_h)
    best = None
    for fc in forecasts:
        t = _utc(fc["issuedAt"])
        if earliest <= t <= latest and (best is None or t > _utc(best["issuedAt"])):
            best = fc
    if best is None:
        return None
    for sf in best["spots"]:
        if sf["spot"] == spot and sf.get("arrival") and sf["arrival"].get("p50"):
            return round(_hours(_utc(sf["arrival"]["p50"]) - _utc(crossing)), 2)
    return None


def arrival_errors(
    forecasts: Sequence[Mapping[str, Any]],
    spot: str,
    crossings: Iterable[Any],
    offsets_h: Sequence[int] = ARRIVAL_OFFSETS_H,
) -> dict[int, list[float]]:
    """Arrival errors per offset (24 h, 48 h) over a spot's crossings; missing ones are skipped."""
    out: dict[int, list[float]] = {h: [] for h in offsets_h}
    for c in crossings:
        for h in offsets_h:
            e = arrival_error_h(forecasts, spot, c, h)
            if e is not None:
                out[h].append(e)
    return out


def replay_pairs(replay: Mapping[str, Any], spot: str, gauge: str, h: int) -> pd.DataFrame:
    """Forecast-observation pairs from a §9 Replay for one spot and lead h.

    One row per forecast issued at t: the seven quantiles (q05..q95), pFlood, pAmber and the observed
    level at exactly t + h (NaN if not observed). Only the later observation is used, to score.
    """
    obs = {_utc(r["t"]): float(r["level"]) for r in replay["observed"].get(gauge, [])}
    rows = []
    for fc in replay["forecasts"]:
        t = _utc(fc["issuedAt"])
        for sf in fc["spots"]:
            if sf["spot"] != spot:
                continue
            ld = next((x for x in sf["leads"] if x["h"] == h), None)
            if ld is None:
                continue
            rows.append(
                {
                    "issuedAt": t,
                    **{f"q{k}": float(ld["q"][k]) for k in QUANT_KEYS},
                    "pFlood": np.nan if ld.get("pFlood") is None else float(ld["pFlood"]),
                    "pAmber": float(ld["pAmber"]),
                    "obs": obs.get(t + pd.Timedelta(hours=h), np.nan),
                }
            )
    cols = ["issuedAt", *[f"q{k}" for k in QUANT_KEYS], "pFlood", "pAmber", "obs"]
    return pd.DataFrame(rows, columns=cols)


# --------------------------------------------------------------------------- uncertainty


def pooled_mean(groups: Sequence[Sequence[float]]) -> float:
    """Mean of all values in all groups (NaN if there are none)."""
    vals = [v for g in groups for v in g]
    return float(np.mean(vals)) if vals else float("nan")


def bootstrap_ci(
    groups: Sequence[Sequence[float]],
    stat: Callable[[Sequence[Sequence[float]]], float] = pooled_mean,
    n_boot: int = N_BOOT,
    seed: int = SEED,
    level: float = 0.90,
) -> tuple[float, float] | None:
    """Bootstrap over events: resample the groups (one per event) with replacement, recompute ``stat``.

    Returns the central ``level`` interval of the finite resampled values, or None when the statistic
    is undefined on the original data. Resamples where it is undefined (e.g. no hits drawn) are skipped.
    """
    if not groups or not np.isfinite(stat(groups)):
        return None
    rng = np.random.default_rng(seed)
    k = len(groups)
    vals = []
    for _ in range(n_boot):
        draw = rng.integers(0, k, size=k)
        v = stat([groups[i] for i in draw])
        if np.isfinite(v):
            vals.append(v)
    lo, hi = np.percentile(vals, [50 * (1 - level), 50 * (1 + level)])
    return float(lo), float(hi)
