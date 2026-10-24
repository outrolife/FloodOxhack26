"""Feature frame per target gauge: everything known at time t, nothing after it (SPEC §7.2).

Issue #6. Draft by s-s01s-model, finished by alfredo-features.

Public API
----------
::

    TARGETS, LIVE_ONLY, UPSTREAMS, HORIZONS_H, MAX_WINDOW_H, RAIN_KEY, DATA_DIR, LAGS_PATH

    compute_gauge_medians(hourly, cutoff_utc, gauges=None) -> dict[str, float]
    load_lags(path=LAGS_PATH) -> dict[str, dict[str, int]]              # {} if the file is missing
    upstream_lags_h(upstream, target, lags=None) -> list[int]
    feature_columns(target, lags=None) -> list[str]
    build_features(hourly, target, medians, lags=None) -> pd.DataFrame  # index ts_utc
    build_targets(hourly, target, horizons=HORIZONS_H) -> pd.DataFrame  # y_6h ... y_72h
    catchment_rain(hourly) -> pd.Series                                 # hourly mean of rain gauges
    pivot_hourly(hourly, value_col="level_mean") -> pd.DataFrame        # long -> wide, full hourly index

Typical use (training, #8)::

    hourly = pd.read_parquet(DATA_DIR / "processed" / "hourly.parquet")
    medians = compute_gauge_medians(hourly, "2018-09-30 23:00")  # end of the training split
    lags = load_lags()
    X = build_features(hourly, "newbotley", medians, lags)
    Y = build_targets(hourly, "newbotley")  # join with X.join(Y)

Targets follow SPEC §4.1.1 (PR #30): newbotley (primary), kingsmill, minns, coldharbour. The locks
godstow, osney and iffley are ``LIVE_ONLY``: they have no downstream-stage history, so they get no
features and no model.

Live mode and replays pass only the rows with ``ts_utc <= t`` and read ``X.loc[t]``. That row is
identical to the one computed from the full record (the leakage test checks this).

Input
-----
The long-format hourly frame written by ``pipeline/clean.py`` (``data/processed/hourly.parquet``),
one row per (gauge, hour)::

    gauge       str   config key (``newbotley``, ``farmoor``, ...), a rain gauge ref (``256230TP``)
                      or the derived catchment series ``rain_catchment``
    ts_utc      tz-aware timestamp, hour start (converted to UTC; naive timestamps are rejected)
    kind        "level" | "rain"   (rain_catchment and the rain gauges are "rain")
    level_mean  float level (m, that gauge's own datum); NaN for rain
    rain_mm     float hourly rain total (mm); NaN for levels
    level_max, filled, flagged     (not used here)

If ``kind`` is present it decides which rows are rain. Without it (older drafts), a row is rain if its
gauge is ``rain_catchment``, or if that gauge has no ``level_mean`` values at all but does have
``rain_mm`` values. Catchment rain (SPEC §4.1) is the pipeline's ``rain_catchment`` series if it is
present, used on its own and never averaged with the individual gauges; otherwise it is the mean of
the rain gauges available in each hour (``catchment_rain``).

The functions take that DataFrame; they never read the parquet file themselves.

Time convention (the leakage rule)
----------------------------------
Every frame is reindexed to a complete hourly UTC index, so "6 h ago" always means 6 hours, not 6 rows;
missing hours become NaN rather than shifting values. The row labelled ``t`` uses only rows whose label is
``<= t``. Because a label is the *start* of its hour, the row for ``t`` is complete once hour ``t`` has
ended, i.e. at wall-clock ``t + 1 h``. The targets (``build_targets``) use the same labels, so the
model never sees data after the hour it is issued from.

Per-gauge anomalies
-------------------
Stage values are never compared across gauges (each has its own datum). Upstream gauges enter as an
*anomaly*: level minus that gauge's own long-term median. The median is a parameter of
``build_features``, not something it computes, because a median over the whole record would leak
future data. Compute it once with ``compute_gauge_medians(hourly, cutoff_utc)`` using the end of the
training period (SPEC §7.3: 2018-09-30) as the cutoff, and save it with the models so live mode and
the Time Machine use exactly the same numbers.

Travel-time lags
----------------
Each upstream gauge's anomaly is lagged by {0, 6, 12, 24, lag_lo, lag_main, lag_hi} h, deduplicated
and sorted. The travel-time lags come from ``lags.json`` (issue #7, SPEC §6.3). A pair missing from
it, or a missing file, falls back to the fixed lags {0, 6, 12, 24} only. The column set therefore
depends on ``lags``: save ``feature_columns(target, lags)`` with each model, and build live and
replay features with the same ``lags``.

Windows
-------
No window or lag reaches back more than 21 days (``MAX_WINDOW_H``), so live mode works with the
~4 weeks of readings the flood-monitoring API returns. A rolling sum or mean is NaN when more than
10 % of the hours in its window are missing (``MIN_COVERAGE``); a lag or change is NaN when either
end is missing. Missing values stay NaN: LightGBM handles them.
"""

from __future__ import annotations

import json
import logging
import math
import os
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

log = logging.getLogger(__name__)

RAIN_KEY = "rain_catchment"
DATA_DIR = Path(os.environ.get("RC_DATA_DIR", Path(__file__).resolve().parent.parent / "data"))
LAGS_PATH = DATA_DIR / "processed" / "lags.json"

HORIZONS_H: tuple[int, ...] = (6, 12, 24, 36, 48, 72)  # SPEC §7.1 lead times
MAX_WINDOW_H = 21 * 24  # 21-day cap on every window and lag (SPEC §7.2)
MIN_COVERAGE = 0.9  # rolling sums/means need >= 90 % of their hours present

TARGET_CHANGE_H: tuple[int, ...] = (1, 3, 6, 24)
UPSTREAM_FIXED_LAGS_H: tuple[int, ...] = (0, 6, 12, 24)
UPSTREAM_CHANGE_H: tuple[int, ...] = (3, 24)
RAIN_SUM_H: tuple[int, ...] = (6, 24, 72, 168, MAX_WINDOW_H)
TRAVEL_LAG_KEYS: tuple[str, ...] = ("lag_lo", "lag_main", "lag_hi")

# The river walk (SPEC §4.1 flow paths, §7.2; #125 A): for each trained target, every gauge the water
# passes walking upstream from it: first the near gauges, then the ones further up. The single source
# is the ``flow_paths:`` section of config/stations.yaml. FALLBACK_UPSTREAMS is an identical copy, used
# only when that file or section is missing or malformed (tests, fixtures). Keep the two in sync.
#   newbotley, minns: farmoor, eynsham (u/s series), cassington (Evenlode), then shifford and
#     hannington (Thames above Eynsham), worsham (Windrush), shipton (Evenlode above Cassington).
#     Adopted for these two targets on #125 (experiment A). The order is experiment A's column order.
#   coldharbour: farmoor, eynsham, cassington only (the further gauges lowered its 72 h skill in A).
#   kingsmill: enslow, islip only (same reason).
# The main-channel locks godstow, osney, iffley have no downstream-stage history: they are live only
# (LIVE_ONLY), never trained targets and never upstream features.
STATIONS_YAML = Path(__file__).resolve().parent.parent / "config" / "stations.yaml"
_THAMES_UP: tuple[str, ...] = ("farmoor", "eynsham", "cassington")
_THAMES_WALK: tuple[str, ...] = (*_THAMES_UP, "shifford", "hannington", "worsham", "shipton")
FALLBACK_UPSTREAMS: dict[str, tuple[str, ...]] = {
    "newbotley": _THAMES_WALK,
    "minns": _THAMES_WALK,
    "coldharbour": _THAMES_UP,
    "kingsmill": ("enslow", "islip"),
}


def load_flow_paths(path: Path | str = STATIONS_YAML) -> dict[str, tuple[str, ...]]:
    """Target -> upstream gauges (the river walk) from the ``flow_paths:`` section of stations.yaml.

    The section is ``{basin: {target: [gauge, ...]}}``. Basins only group the targets, so the result
    is flat, with targets in file order. Falls back to ``FALLBACK_UPSTREAMS`` if the file or section is
    missing or malformed (a list that is not all strings, a gauge listed twice, a target listed twice).
    """
    path = Path(path)
    raw: Any = None
    try:
        import yaml

        if path.exists():
            raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    except Exception as exc:  # unreadable or bad yaml: never take the model down over config
        log.warning("could not read %s (%s); using FALLBACK_UPSTREAMS", path, exc)
    paths = raw.get("flow_paths") if isinstance(raw, dict) else None
    out: dict[str, tuple[str, ...]] = {}
    for name, basin in paths.items() if isinstance(paths, dict) else ():
        if not isinstance(basin, dict) or not basin:  # e.g. `cherwell: [kingsmill]` or empty
            log.warning("flow_paths basin %r is malformed; using FALLBACK_UPSTREAMS", name)
            return dict(FALLBACK_UPSTREAMS)
        for target, ups in basin.items():
            ok = isinstance(ups, list) and all(isinstance(u, str) for u in ups)
            if not ok or len(set(ups)) != len(ups) or target in out:
                log.warning("flow_paths entry for %s is malformed; using FALLBACK_UPSTREAMS", target)
                return dict(FALLBACK_UPSTREAMS)
            out[str(target)] = tuple(ups)
    if not out:
        log.warning("%s has no usable flow_paths; using FALLBACK_UPSTREAMS", path)
        return dict(FALLBACK_UPSTREAMS)
    return out


UPSTREAMS: dict[str, tuple[str, ...]] = load_flow_paths()
TARGETS: tuple[str, ...] = tuple(UPSTREAMS)  # newbotley first: the primary target
LIVE_ONLY: tuple[str, ...] = ("godstow", "osney", "iffley")

LagsArg = Mapping[str, Any] | None
_WARNED_PAIRS: set[str] = set()  # pairs already warned about as missing from lags.json (warn once)


# ---------------------------------------------------------------------------------------------
# Input handling
# ---------------------------------------------------------------------------------------------


def _utc_ts(ts: pd.Series) -> pd.Series:
    """Validate timestamps: tz-aware (converted to UTC) and on the hour. Naive times are rejected."""
    ts = pd.to_datetime(ts)
    if ts.dt.tz is None:
        raise ValueError("ts_utc must be tz-aware (UTC); refusing to guess the zone of naive timestamps")
    ts = ts.dt.tz_convert("UTC")
    if (ts != ts.dt.floor("h")).any():
        raise ValueError("ts_utc must be hour starts (hourly data from pipeline/clean.py)")
    return ts


def _is_rain(hourly: pd.DataFrame) -> pd.Series:
    """Boolean mask of rain rows (see "Input" in the module docstring)."""
    if "kind" in hourly.columns:
        return hourly["kind"].eq("rain")
    by_gauge = hourly["gauge"]
    has_level = hourly["level_mean"].notna().groupby(by_gauge).transform("any")
    if "rain_mm" in hourly.columns:
        has_rain = hourly["rain_mm"].notna().groupby(by_gauge).transform("any")
    else:
        has_rain = pd.Series(False, index=hourly.index)
    return by_gauge.eq(RAIN_KEY) | (~has_level & has_rain)


def _level_rows(hourly: pd.DataFrame) -> pd.DataFrame:
    return hourly[~_is_rain(hourly)]


def pivot_hourly(hourly: pd.DataFrame, value_col: str = "level_mean") -> pd.DataFrame:
    """Long frame -> wide frame: index = complete hourly UTC range, one column per gauge.

    Every hour between the first and last timestamp in ``hourly`` gets a row, so a missing hour is a
    NaN row, never a silently shifted value. Raises on duplicate (gauge, hour) rows.
    """
    df = hourly[["gauge", "ts_utc", value_col]].copy()
    df["ts_utc"] = _utc_ts(df["ts_utc"])
    if df.duplicated(["gauge", "ts_utc"]).any():
        raise ValueError("duplicate (gauge, ts_utc) rows; pipeline/clean.py should deduplicate")
    wide = df.pivot(index="ts_utc", columns="gauge", values=value_col)
    if wide.empty:
        return wide
    full = pd.date_range(wide.index.min(), wide.index.max(), freq="h", tz="UTC", name="ts_utc")
    wide = wide.reindex(full).astype(float)
    wide.columns.name = None
    return wide


def catchment_rain(hourly: pd.DataFrame) -> pd.Series:
    """Hourly catchment rain (mm): mean of the rain gauges available in each hour (SPEC §4.1).

    Uses the pipeline's derived ``rain_catchment`` series if present; otherwise averages every rain
    gauge in ``hourly`` per hour, skipping gauges that are missing that hour. An hour with no gauge
    reporting is NaN. Returns an empty Series if there is no rain data at all.
    """
    rain_rows = hourly[_is_rain(hourly)]
    if rain_rows.empty:
        empty = pd.DatetimeIndex([], tz="UTC", name="ts_utc")
        return pd.Series(np.nan, index=empty, name=RAIN_KEY, dtype=float)
    if rain_rows["gauge"].eq(RAIN_KEY).any():
        rain_rows = rain_rows[rain_rows["gauge"] == RAIN_KEY]
    wide = pivot_hourly(rain_rows, "rain_mm")
    log.info("catchment rain from %d gauge(s): %s", wide.shape[1], ", ".join(map(str, wide.columns)))
    return wide.mean(axis=1, skipna=True).rename(RAIN_KEY)


# ---------------------------------------------------------------------------------------------
# Leak-free per-gauge medians and lags
# ---------------------------------------------------------------------------------------------


def compute_gauge_medians(
    hourly: pd.DataFrame, cutoff_utc: str | pd.Timestamp, gauges: Iterable[str] | None = None
) -> dict[str, float]:
    """Each level gauge's median ``level_mean`` over rows with ``ts_utc <= cutoff_utc`` (inclusive).

    Use the end of the training period as the cutoff (SPEC §7.3), so the anomaly baseline never
    contains validation, test or live data. A naive cutoff is read as UTC. By default the result
    covers every level gauge in ``hourly`` plus every gauge in ``UPSTREAMS``; a gauge with no data
    before the cutoff gets NaN (so its anomaly columns are NaN). Rain gauges are skipped.
    """
    cutoff = pd.Timestamp(cutoff_utc)
    cutoff = cutoff.tz_localize("UTC") if cutoff.tzinfo is None else cutoff.tz_convert("UTC")
    levels = _level_rows(hourly)
    df = levels[_utc_ts(levels["ts_utc"]) <= cutoff]
    medians = df.groupby("gauge")["level_mean"].median()
    if gauges is not None:
        keys = list(gauges)
    else:
        configured = {g for ups in UPSTREAMS.values() for g in ups} | set(UPSTREAMS)
        keys = sorted(set(levels["gauge"].unique()) | configured)
    return {g: float(medians.get(g, np.nan)) for g in keys}


def _normalise_lags(lags: LagsArg) -> dict[str, dict[str, int]]:
    """Accept lags.json as read from disk (``{"pairs": [...]}``) or as ``{"up->down": {...}}``."""
    if not lags:
        return {}
    if "pairs" in lags:
        out: dict[str, dict[str, int]] = {}
        for p in lags["pairs"]:
            vals = {k: p.get(k) for k in TRAVEL_LAG_KEYS}
            vals = {k: int(round(float(v))) for k, v in vals.items() if v is not None and np.isfinite(v)}
            out[f"{p['up']}->{p['down']}"] = vals
        return out
    return {
        pair: {k: int(round(float(v[k]))) for k in TRAVEL_LAG_KEYS if v.get(k) is not None}
        for pair, v in lags.items()
    }


def load_lags(path: Path | str = LAGS_PATH) -> dict[str, dict[str, int]]:
    """Read ``lags.json`` (SPEC §6.3, issue #7) into ``{"farmoor->newbotley": {"lag_lo": .., ...}}``.

    File format: ``{"pairs": [{"up", "down", "lag_lo", "lag_main", "lag_hi", "source"}]}`` with
    integer hours. Returns ``{}`` if the file does not exist yet; then every pair uses only the fixed
    lags {0, 6, 12, 24}.
    """
    path = Path(path)
    if not path.exists():
        log.warning(
            "%s not found; upstream anomalies use only the fixed lags %s", path, UPSTREAM_FIXED_LAGS_H
        )
        return {}
    return _normalise_lags(json.loads(path.read_text(encoding="utf-8")))


def upstream_lags_h(upstream: str, target: str, lags: LagsArg = None) -> list[int]:
    """Sorted, deduplicated anomaly lags (h) for one pair: {0, 6, 12, 24, lag_lo, lag_main, lag_hi}.

    Travel-time lags come from ``lags["<upstream>-><target>"]`` (``lags`` as from ``load_lags``, or
    the raw lags.json dict). A pair that is missing falls back to {0, 6, 12, 24}. Each lag is rounded
    to whole hours and clipped to [0, 21 days].
    """
    pair = f"{upstream}->{target}"
    norm = _normalise_lags(lags)
    if norm and pair not in norm and pair not in _WARNED_PAIRS:
        _WARNED_PAIRS.add(pair)
        log.warning("%s missing from lags.json: fixed lags %s only (run `make travel`)", pair,
                    UPSTREAM_FIXED_LAGS_H)
    travel = norm.get(pair, {})
    out = set(UPSTREAM_FIXED_LAGS_H)
    for key, lag in travel.items():
        if not 0 <= lag <= MAX_WINDOW_H:
            log.warning("%s %s=%d h outside [0, %d]; clipping", pair, key, lag, MAX_WINDOW_H)
            lag = min(max(lag, 0), MAX_WINDOW_H)
        out.add(lag)
    return sorted(out)


# ---------------------------------------------------------------------------------------------
# Features
# ---------------------------------------------------------------------------------------------


def _rolling(series: pd.Series, hours: int, how: str) -> pd.Series:
    """Trailing window over the ``hours`` rows ending at t (inclusive); NaN below MIN_COVERAGE."""
    roll = series.rolling(window=hours, min_periods=math.ceil(MIN_COVERAGE * hours))
    return roll.sum() if how == "sum" else roll.mean()


def _bad_target(target: str) -> str:
    if target in LIVE_ONLY:
        return f"{target!r} is live only (no downstream-stage history, SPEC §4.1.1); targets: {TARGETS}"
    return f"unknown target gauge {target!r}; expected one of {TARGETS}"


def upstreams_for(target: str, upstreams: Iterable[str] | None = None) -> tuple[str, ...]:
    """``target``'s upstream gauges: ``upstreams`` if given (a saved model's own list), else the
    configured river walk ``UPSTREAMS[target]``."""
    if target not in UPSTREAMS and upstreams is None:
        raise ValueError(_bad_target(target))
    return tuple(UPSTREAMS[target] if upstreams is None else upstreams)


def feature_columns(
    target: str, lags: LagsArg = None, upstreams: Iterable[str] | None = None
) -> list[str]:
    """Feature column names, in order, that ``build_features`` returns for ``target``."""
    ups = upstreams_for(target, upstreams)
    cols = ["level_now", *[f"level_change_{k}h" for k in TARGET_CHANGE_H], "level_mean_21d"]
    for up in ups:
        cols += [f"{up}_anom_lag{k}h" for k in upstream_lags_h(up, target, lags)]
        cols += [f"{up}_change_{k}h" for k in UPSTREAM_CHANGE_H]
    cols += [f"rain_sum_{k}h" if k != MAX_WINDOW_H else "rain_sum_21d" for k in RAIN_SUM_H]
    cols += ["doy_sin", "doy_cos"]
    return cols


def build_features(
    hourly: pd.DataFrame,
    target: str,
    medians: Mapping[str, float],
    lags: LagsArg = None,
    upstreams: Iterable[str] | None = None,
) -> pd.DataFrame:
    """Feature frame for one target gauge (SPEC §7.2). Row t uses only data labelled <= t.

    Args:
        hourly: long hourly frame (see module docstring).
        target: target gauge key, one of ``TARGETS``.
        medians: per-gauge long-term median level from ``compute_gauge_medians`` with a training
            cutoff. Must contain every upstream gauge of ``target`` (value may be NaN).
        lags: travel-time lags from ``load_lags`` (or the raw lags.json dict); pairs not given use
            only the fixed lags {0, 6, 12, 24}.
        upstreams: the upstream gauges to use, in order. Default: the configured river walk
            ``UPSTREAMS[target]``. Live mode and replays pass the list a saved model was trained
            with (``GaugeModel.upstreams``), so a model keeps working after the config changes.

    Returns:
        DataFrame indexed by a complete hourly UTC ``ts_utc`` range (spanning all level and rain rows),
        columns ``feature_columns(target, lags)``, all float. Upstream gauges or rain absent from
        ``hourly`` give all-NaN columns, so the schema is stable.
    """
    ups = upstreams_for(target, upstreams)
    missing = [g for g in ups if g not in medians]
    if missing:
        raise KeyError(f"medians missing for upstream gauges {missing}; use compute_gauge_medians()")
    lags = _normalise_lags(lags)

    levels = pivot_hourly(_level_rows(hourly), "level_mean")
    if target not in levels.columns:
        raise ValueError(f"no level data for target gauge {target!r}")
    rain = catchment_rain(hourly)
    # One complete hourly index spanning both levels and rain.
    start, end = levels.index.min(), levels.index.max()
    if not rain.empty:
        start, end = min(start, rain.index.min()), max(end, rain.index.max())
    index = pd.date_range(start, end, freq="h", tz="UTC", name="ts_utc")
    levels = levels.reindex(index)
    rain = rain.reindex(index)

    feats: dict[str, pd.Series] = {}

    # Target gauge: its own level is fine to use raw (one model per gauge, one datum).
    level = levels[target]
    feats["level_now"] = level
    for k in TARGET_CHANGE_H:
        feats[f"level_change_{k}h"] = level - level.shift(k)
    feats["level_mean_21d"] = _rolling(level, MAX_WINDOW_H, "mean")

    # Upstream gauges: anomaly vs their own training-period median, never raw stage.
    for up in ups:
        up_level = levels[up] if up in levels.columns else pd.Series(np.nan, index=index)
        anom = up_level - medians[up]
        for k in upstream_lags_h(up, target, lags):
            feats[f"{up}_anom_lag{k}h"] = anom.shift(k)
        for k in UPSTREAM_CHANGE_H:
            feats[f"{up}_change_{k}h"] = up_level - up_level.shift(k)

    # Catchment rain: trailing sums ending at hour t (inclusive).
    for k in RAIN_SUM_H:
        name = f"rain_sum_{k}h" if k != MAX_WINDOW_H else "rain_sum_21d"
        feats[name] = _rolling(rain, k, "sum")

    # Season from the UTC timestamp itself (known at t by definition).
    doy = (index.day_of_year - 1 + index.hour / 24.0) / 365.25
    feats["doy_sin"] = pd.Series(np.sin(2 * np.pi * doy), index=index)
    feats["doy_cos"] = pd.Series(np.cos(2 * np.pi * doy), index=index)

    out = pd.DataFrame(feats, index=index)
    return out[feature_columns(target, lags, ups)].astype(float)


# ---------------------------------------------------------------------------------------------
# Training targets (look FORWARD by definition; never use these as features)
# ---------------------------------------------------------------------------------------------


def build_targets(hourly: pd.DataFrame, target: str, horizons: Iterable[int] = HORIZONS_H) -> pd.DataFrame:
    """Training targets ``y_{h}h = level_mean(t + h) - level_mean(t)`` (SPEC §7.1).

    Indexed by the complete hourly UTC range of the level rows; align to ``build_features`` with
    ``X.join(Y)`` or ``Y.reindex(X.index)``. NaN where either end is missing or t + h is beyond the
    data. These columns look into the future by design: join them to the features only for training
    and evaluation, never feed them to the model as inputs.
    """
    levels = pivot_hourly(_level_rows(hourly), "level_mean")
    if target not in levels.columns:
        raise ValueError(f"no level data for target gauge {target!r}")
    level = levels[target]
    return pd.DataFrame({f"y_{h}h": level.shift(-h) - level for h in horizons}, index=levels.index)
