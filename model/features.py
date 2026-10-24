"""Feature frame per target gauge: everything known at time t, nothing after it (SPEC §7.2).

Issue #6.

Input
-----
The long-format hourly frame written by ``pipeline/clean.py`` (``data/processed/hourly.parquet``),
one row per (gauge, hour)::

    gauge       str   gauge key (``osney``, ``farmoor``, ...) or the derived ``rain_catchment``
    ts_utc      tz-aware UTC timestamp, hour start
    level_mean  float level (m, that gauge's own datum); NaN for rain
    level_max   float (not used here)
    rain_mm     float hourly rain total (mm); NaN for levels
    filled, flagged  bool (not used here)

The functions take that DataFrame; they never read the file themselves.

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
from collections.abc import Iterable, Mapping
from pathlib import Path

import numpy as np
import pandas as pd

log = logging.getLogger(__name__)

RAIN_KEY = "rain_catchment"
LAGS_PATH = Path("data/processed/lags.json")

HORIZONS_H: tuple[int, ...] = (6, 12, 24, 36, 48, 72)  # SPEC §7.1 lead times
MAX_WINDOW_H = 21 * 24  # 21-day cap on every window and lag (SPEC §7.2)
MIN_COVERAGE = 0.9  # rolling sums/means need >= 90 % of their hours present

TARGET_CHANGE_H: tuple[int, ...] = (1, 3, 6, 24)
UPSTREAM_FIXED_LAGS_H: tuple[int, ...] = (0, 6, 12, 24)
UPSTREAM_CHANGE_H: tuple[int, ...] = (3, 24)
RAIN_SUM_H: tuple[int, ...] = (6, 24, 72, 168, MAX_WINDOW_H)

# Upstream gauges for each target gauge (SPEC §4.1 flow paths and §6.2 pairs).
# Thames: farmoor, eynsham, cassington -> godstow -> osney -> iffley.
# newbotley (Bulstake Stream) is fed by the Thames system: farmoor, eynsham, cassington, godstow.
# Cherwell: enslow, islip -> kingsmill.
# config/stations.yaml does not exist yet; if it gains a `flow_paths:` section, keep this in sync.
UPSTREAMS: dict[str, tuple[str, ...]] = {
    "godstow": ("farmoor", "eynsham", "cassington"),
    "osney": ("farmoor", "eynsham", "cassington", "godstow"),
    "iffley": ("farmoor", "eynsham", "cassington", "godstow", "osney"),
    "newbotley": ("farmoor", "eynsham", "cassington", "godstow"),
    "kingsmill": ("enslow", "islip"),
}

# PLACEHOLDER travel-time lags (hours), used for any pair missing from data/processed/lags.json.
# These are NOT measurements. They are a deliberately wide guess consistent with the 48-72 h
# rain-to-peak catchment response in the EA OFAS hydrology report (SPEC §18): upstream rises reach
# Oxford within roughly half a day to two days. Replace with lags.json from analysis/travel_times.py
# (issue #7) as soon as it exists.
PLACEHOLDER_LAGS: dict[str, int] = {"lag_lo": 12, "lag_main": 24, "lag_hi": 48}


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


# ---------------------------------------------------------------------------------------------
# Leak-free per-gauge medians and lags
# ---------------------------------------------------------------------------------------------


def compute_gauge_medians(
    hourly: pd.DataFrame, cutoff_utc: str | pd.Timestamp, gauges: Iterable[str] | None = None
) -> dict[str, float]:
    """Each gauge's median ``level_mean`` over rows with ``ts_utc <= cutoff_utc`` (inclusive).

    Use the end of the training period as the cutoff (SPEC §7.3), so the anomaly baseline never
    contains validation, test or live data. A gauge with no data before the cutoff gets NaN.
    """
    cutoff = pd.Timestamp(cutoff_utc)
    cutoff = cutoff.tz_localize("UTC") if cutoff.tzinfo is None else cutoff.tz_convert("UTC")
    df = hourly[hourly["gauge"] != RAIN_KEY]
    df = df[_utc_ts(df["ts_utc"]) <= cutoff]
    medians = df.groupby("gauge")["level_mean"].median()
    keys = list(gauges) if gauges is not None else sorted(hourly["gauge"].unique())
    return {g: float(medians.get(g, np.nan)) for g in keys if g != RAIN_KEY}


def load_lags(path: Path | str = LAGS_PATH) -> dict[str, dict[str, int]]:
    """Read ``lags.json`` (SPEC §6.3): ``{"farmoor->osney": {"lag_lo": .., "lag_main": .., "lag_hi": ..}}``.

    Returns ``{}`` if the file does not exist yet (then every pair uses ``PLACEHOLDER_LAGS``).
    """
    path = Path(path)
    if not path.exists():
        log.warning("%s not found; using PLACEHOLDER_LAGS for every pair", path)
        return {}
    raw = json.loads(path.read_text())
    return {pair: {k: int(round(v[k])) for k in ("lag_lo", "lag_main", "lag_hi")} for pair, v in raw.items()}


def upstream_lags_h(
    upstream: str, target: str, lags: Mapping[str, Mapping[str, float]] | None = None
) -> list[int]:
    """Sorted, deduplicated anomaly lags (h) for one pair: {0, 6, 12, 24, lag_lo, lag_main, lag_hi}.

    Travel-time lags come from ``lags["<upstream>-><target>"]``, else ``PLACEHOLDER_LAGS``. Each is
    rounded to whole hours and clipped to [0, 21 days].
    """
    pair = f"{upstream}->{target}"
    travel = (lags or {}).get(pair)
    if travel is None:
        travel = PLACEHOLDER_LAGS
    out = set(UPSTREAM_FIXED_LAGS_H)
    for key in ("lag_lo", "lag_main", "lag_hi"):
        lag = int(round(float(travel[key])))
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


def feature_columns(target: str, lags: Mapping[str, Mapping[str, float]] | None = None) -> list[str]:
    """Feature column names, in order, that ``build_features`` returns for ``target``."""
    cols = ["level_now", *[f"level_change_{k}h" for k in TARGET_CHANGE_H], "level_mean_21d"]
    for up in UPSTREAMS[target]:
        cols += [f"{up}_anom_lag{k}h" for k in upstream_lags_h(up, target, lags)]
        cols += [f"{up}_change_{k}h" for k in UPSTREAM_CHANGE_H]
    cols += [f"rain_sum_{k}h" if k != MAX_WINDOW_H else "rain_sum_21d" for k in RAIN_SUM_H]
    cols += ["doy_sin", "doy_cos"]
    return cols


def build_features(
    hourly: pd.DataFrame,
    target: str,
    medians: Mapping[str, float],
    lags: Mapping[str, Mapping[str, float]] | None = None,
) -> pd.DataFrame:
    """Feature frame for one target gauge (SPEC §7.2). Row t uses only data labelled <= t.

    Args:
        hourly: long hourly frame (see module docstring).
        target: target gauge key, one of ``UPSTREAMS``.
        medians: per-gauge long-term median level from ``compute_gauge_medians`` with a training
            cutoff. Must contain every upstream gauge of ``target`` (value may be NaN).
        lags: travel-time lags as in ``lags.json``; pairs not given use ``PLACEHOLDER_LAGS``.

    Returns:
        DataFrame indexed by a complete hourly UTC ``ts_utc`` range (spanning all level and rain rows),
        columns ``feature_columns(target)``.
        Upstream gauges or rain absent from ``hourly`` give all-NaN columns (stable schema).
    """
    if target not in UPSTREAMS:
        raise ValueError(f"unknown target gauge {target!r}; expected one of {sorted(UPSTREAMS)}")
    missing = [g for g in UPSTREAMS[target] if g not in medians]
    if missing:
        raise KeyError(f"medians missing for upstream gauges {missing}; use compute_gauge_medians()")

    levels = pivot_hourly(hourly[hourly["gauge"] != RAIN_KEY], "level_mean")
    if target not in levels.columns:
        raise ValueError(f"no level data for target gauge {target!r}")
    rain_rows = hourly[hourly["gauge"] == RAIN_KEY]
    rain = pivot_hourly(rain_rows, "rain_mm")[RAIN_KEY] if not rain_rows.empty else None
    # One complete hourly index spanning both levels and rain.
    start, end = levels.index.min(), levels.index.max()
    if rain is not None:
        start, end = min(start, rain.index.min()), max(end, rain.index.max())
    index = pd.date_range(start, end, freq="h", tz="UTC", name="ts_utc")
    levels = levels.reindex(index)
    rain = rain.reindex(index) if rain is not None else pd.Series(np.nan, index=index)

    feats: dict[str, pd.Series] = {}

    # Target gauge: its own level is fine to use raw (one model per gauge, one datum).
    level = levels[target]
    feats["level_now"] = level
    for k in TARGET_CHANGE_H:
        feats[f"level_change_{k}h"] = level - level.shift(k)
    feats["level_mean_21d"] = _rolling(level, MAX_WINDOW_H, "mean")

    # Upstream gauges: anomaly vs their own training-period median, never raw stage.
    for up in UPSTREAMS[target]:
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
    return out[feature_columns(target, lags)]


# ---------------------------------------------------------------------------------------------
# Training targets (look FORWARD by definition; never use these as features)
# ---------------------------------------------------------------------------------------------


def build_targets(hourly: pd.DataFrame, target: str, horizons: Iterable[int] = HORIZONS_H) -> pd.DataFrame:
    """Training targets ``y_{h}h = level_mean(t + h) - level_mean(t)`` (SPEC §7.1).

    Same hourly UTC index as ``build_features``. NaN where either end is missing or t + h is beyond
    the data. These columns look into the future by design: join them to the features only for
    training and evaluation, never feed them to the model as inputs.
    """
    levels = pivot_hourly(hourly[hourly["gauge"] != RAIN_KEY], "level_mean")
    if target not in levels.columns:
        raise ValueError(f"no level data for target gauge {target!r}")
    level = levels[target]
    return pd.DataFrame({f"y_{h}h": level.shift(-h) - level for h in horizons}, index=levels.index)
