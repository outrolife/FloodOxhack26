"""Tests for model/features.py: no future data in features (SPEC §7.2, §15 item 6) and correctness.

Synthetic data only (seeded); no network, no data files.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from model.features import (
    MAX_WINDOW_H,
    PLACEHOLDER_LAGS,
    RAIN_KEY,
    UPSTREAMS,
    build_features,
    build_targets,
    compute_gauge_medians,
    feature_columns,
    pivot_hourly,
    upstream_lags_h,
)

START = pd.Timestamp("2026-09-01 00:00", tz="UTC")
N_HOURS = 40 * 24  # longer than the 21-day window
LEVEL_GAUGES = ["farmoor", "eynsham", "cassington", "godstow", "osney"]
TEST_LAGS = {"farmoor->osney": {"lag_lo": 30, "lag_main": 40, "lag_hi": 55}}


def make_hourly(seed: int = 0, n_hours: int = N_HOURS, drop_frac: float = 0.03) -> pd.DataFrame:
    """Long-format frame like data/processed/hourly.parquet, with a few hours missing per gauge."""
    rng = np.random.default_rng(seed)
    ts = pd.date_range(START, periods=n_hours, freq="h", tz="UTC")
    rows = []
    for i, g in enumerate(LEVEL_GAUGES):
        level = 1.0 + i + np.cumsum(rng.normal(0, 0.01, n_hours))  # each gauge its own datum
        rows.append(pd.DataFrame({"gauge": g, "ts_utc": ts, "level_mean": level, "rain_mm": np.nan}))
    rain = rng.gamma(0.3, 1.0, n_hours) * (rng.random(n_hours) < 0.3)
    rows.append(pd.DataFrame({"gauge": RAIN_KEY, "ts_utc": ts, "level_mean": np.nan, "rain_mm": rain}))
    df = pd.concat(rows, ignore_index=True)
    df["level_max"] = df["level_mean"]
    df["filled"] = False
    df["flagged"] = False
    keep = rng.random(len(df)) >= drop_frac
    return df[keep].reset_index(drop=True)


def perturb_after(df: pd.DataFrame, cut: pd.Timestamp, seed: int) -> pd.DataFrame:
    """Replace every value strictly after `cut` (all gauges, rain too) and drop some future rows."""
    rng = np.random.default_rng(seed)
    out = df.copy()
    future = out["ts_utc"] > cut
    is_rain = out["gauge"] == RAIN_KEY
    out.loc[future & ~is_rain, "level_mean"] = rng.normal(50, 20, int((future & ~is_rain).sum()))
    out.loc[future & is_rain, "rain_mm"] = rng.uniform(0, 100, int((future & is_rain).sum()))
    drop = future & (rng.random(len(out)) < 0.2)
    return out[~drop].reset_index(drop=True)


def assert_same(a: pd.DataFrame, b: pd.DataFrame) -> None:
    pd.testing.assert_frame_equal(a, b, check_exact=True)  # NaN == NaN here


# ---------------------------------------------------------------------------------------------
# Leakage (the important one)
# ---------------------------------------------------------------------------------------------


@pytest.mark.parametrize("target", ["osney", "godstow"])
def test_features_do_not_see_the_future(target: str) -> None:
    """Replace everything after t: features at every time <= t must not change.

    The anomaly medians are recomputed from the perturbed data with the cut as cutoff, so the test
    covers the whole chain (medians + features), not just build_features with fixed numbers.
    """
    hourly = make_hourly(seed=1)
    rng = np.random.default_rng(42)
    cuts = [START + pd.Timedelta(hours=int(h)) for h in rng.integers(30, N_HOURS - 30, size=6)]
    for i, cut in enumerate(cuts):
        base = build_features(hourly, target, compute_gauge_medians(hourly, cut), TEST_LAGS)
        changed = perturb_after(hourly, cut, seed=100 + i)
        feats = build_features(changed, target, compute_gauge_medians(changed, cut), TEST_LAGS)
        assert_same(base.loc[:cut], feats.loc[:cut])
        # Data that simply stops at the cut (live mode) gives identical rows too.
        truncated = hourly[hourly["ts_utc"] <= cut]
        assert_same(
            base.loc[:cut],
            build_features(truncated, target, compute_gauge_medians(truncated, cut), TEST_LAGS),
        )
        # The future really was different (the test is not vacuous).
        assert not base.loc[cut:].iloc[1:].equals(feats.loc[cut:].iloc[1:])


def test_medians_ignore_data_after_cutoff() -> None:
    hourly = make_hourly(seed=2)
    cutoff = START + pd.Timedelta(days=10, hours=5)
    before = compute_gauge_medians(hourly, cutoff)
    after = compute_gauge_medians(perturb_after(hourly, cutoff, seed=7), cutoff)
    assert before == after
    assert RAIN_KEY not in before
    expected = hourly[(hourly["gauge"] == "farmoor") & (hourly["ts_utc"] <= cutoff)]["level_mean"].median()
    assert before["farmoor"] == pytest.approx(expected)


def test_targets_look_forward_and_are_not_features() -> None:
    hourly = make_hourly(seed=3, drop_frac=0.0)
    y = build_targets(hourly, "osney")
    level = pivot_hourly(hourly)["osney"]
    t = START + pd.Timedelta(hours=100)
    assert y.loc[t, "y_6h"] == pytest.approx(level[t + pd.Timedelta(hours=6)] - level[t])
    assert y["y_72h"].iloc[-72:].isna().all()
    assert not set(y.columns) & set(feature_columns("osney"))


# ---------------------------------------------------------------------------------------------
# Correctness
# ---------------------------------------------------------------------------------------------


def _features(hourly: pd.DataFrame, target: str = "osney") -> pd.DataFrame:
    return build_features(
        hourly, target, compute_gauge_medians(hourly, START + pd.Timedelta(days=15)), TEST_LAGS
    )


def test_columns_and_lags() -> None:
    assert upstream_lags_h("farmoor", "osney", TEST_LAGS) == [0, 6, 12, 24, 30, 40, 55]
    placeholder = sorted({0, 6, 12, 24, *PLACEHOLDER_LAGS.values()})
    assert upstream_lags_h("eynsham", "osney", TEST_LAGS) == placeholder  # no entry -> placeholder
    assert upstream_lags_h(
        "godstow", "osney", {"godstow->osney": {"lag_lo": 6, "lag_main": 6, "lag_hi": 999}}
    ) == [0, 6, 12, 24, MAX_WINDOW_H]  # deduplicated and capped at 21 days
    feats = _features(make_hourly())
    assert list(feats.columns) == feature_columns("osney", TEST_LAGS)
    for up in UPSTREAMS["osney"]:
        assert f"{up}_anom_lag0h" in feats.columns


def test_lag_and_anomaly_at_t_equal_value_at_t_minus_lag() -> None:
    hourly = make_hourly(seed=4)
    medians = compute_gauge_medians(hourly, START + pd.Timedelta(days=15))
    feats = build_features(hourly, "osney", medians, TEST_LAGS)
    levels = pivot_hourly(hourly)
    for t in [START + pd.Timedelta(hours=h) for h in (200, 333, 700)]:
        for k in (6, 40):
            expected = levels.loc[t - pd.Timedelta(hours=k), "farmoor"] - medians["farmoor"]
            np.testing.assert_equal(feats.loc[t, f"farmoor_anom_lag{k}h"], expected)
        np.testing.assert_equal(
            feats.loc[t, "level_change_6h"],
            levels.loc[t, "osney"] - levels.loc[t - pd.Timedelta(hours=6), "osney"],
        )


def test_missing_hours_give_nan_not_shifted_values() -> None:
    hourly = make_hourly(seed=5, drop_frac=0.0)
    gap = START + pd.Timedelta(hours=300)
    hourly = hourly[~((hourly["gauge"] == "farmoor") & (hourly["ts_utc"] == gap))]
    hourly = hourly[~((hourly["gauge"] == "osney") & (hourly["ts_utc"] == gap))]
    feats = _features(hourly)
    six = pd.Timedelta(hours=6)
    assert np.isnan(feats.loc[gap, "level_now"])
    assert np.isnan(feats.loc[gap + six, "farmoor_anom_lag6h"])
    assert np.isnan(feats.loc[gap + six, "level_change_6h"])
    assert not np.isnan(feats.loc[gap + six + pd.Timedelta(hours=1), "farmoor_anom_lag6h"])
    # The index is still one row per hour.
    assert feats.index.to_series().diff().dropna().eq(pd.Timedelta(hours=1)).all()


def test_rain_sums() -> None:
    hourly = make_hourly(seed=6, drop_frac=0.0)
    rain = pivot_hourly(hourly, "rain_mm")[RAIN_KEY]
    feats = _features(hourly)
    t = START + pd.Timedelta(hours=600)
    for k, col in [
        (6, "rain_sum_6h"),
        (24, "rain_sum_24h"),
        (168, "rain_sum_168h"),
        (MAX_WINDOW_H, "rain_sum_21d"),
    ]:
        window = rain.loc[t - pd.Timedelta(hours=k - 1) : t]
        assert len(window) == k
        assert feats.loc[t, col] == pytest.approx(window.sum())
    # Hour t's own rain is included; hour t+1's is not.
    assert feats.loc[t, "rain_sum_6h"] - feats.loc[t - pd.Timedelta(hours=1), "rain_sum_6h"] == pytest.approx(
        rain[t] - rain[t - pd.Timedelta(hours=6)]
    )


def test_rain_sum_nan_when_window_mostly_missing() -> None:
    hourly = make_hourly(seed=7, drop_frac=0.0)
    t = START + pd.Timedelta(hours=500)
    lost = (
        (hourly["gauge"] == RAIN_KEY)
        & (hourly["ts_utc"] > t - pd.Timedelta(hours=6))
        & (hourly["ts_utc"] <= t)
    )
    feats = _features(hourly[~lost])
    assert np.isnan(feats.loc[t, "rain_sum_6h"])
    assert not np.isnan(feats.loc[t, "rain_sum_168h"])  # 6 of 168 hours missing is within tolerance


def test_21_day_cap() -> None:
    hourly = make_hourly(seed=8, drop_frac=0.0)
    feats = _features(hourly)
    level = pivot_hourly(hourly)["osney"]
    # Not enough history yet -> NaN, then exactly the last 504 hours.
    assert feats["level_mean_21d"].iloc[: int(0.9 * MAX_WINDOW_H) - 1].isna().all()
    t = START + pd.Timedelta(hours=800)
    window = level.loc[t - pd.Timedelta(hours=MAX_WINDOW_H - 1) : t]
    assert len(window) == MAX_WINDOW_H
    assert feats.loc[t, "level_mean_21d"] == pytest.approx(window.mean())
    # Changing data more than 21 days before t leaves row t unchanged.
    old = hourly["ts_utc"] <= t - pd.Timedelta(hours=MAX_WINDOW_H)
    changed = hourly.copy()
    changed.loc[old & (changed["gauge"] != RAIN_KEY), "level_mean"] += 5.0
    changed.loc[old & (changed["gauge"] == RAIN_KEY), "rain_mm"] += 5.0
    medians = compute_gauge_medians(hourly, START + pd.Timedelta(days=15))  # same baseline for both
    a = build_features(hourly, "osney", medians, TEST_LAGS).loc[t]
    b = build_features(changed, "osney", medians, TEST_LAGS).loc[t]
    pd.testing.assert_series_equal(a, b, rtol=1e-9)


def test_season_encoding() -> None:
    feats = _features(make_hourly())
    np.testing.assert_allclose(feats["doy_sin"] ** 2 + feats["doy_cos"] ** 2, 1.0)


# ---------------------------------------------------------------------------------------------
# UK clock change: BST -> GMT at 2026-10-25 01:00 UTC (SPEC §16)
# ---------------------------------------------------------------------------------------------


def _clock_change_frame(ts: pd.DatetimeIndex) -> pd.DataFrame:
    n = len(ts)
    return pd.DataFrame(
        {"gauge": "osney", "ts_utc": ts, "level_mean": 3.0 + 0.1 * np.arange(n), "rain_mm": np.nan}
    )


def test_clock_change_one_row_per_utc_hour() -> None:
    utc = pd.date_range("2026-10-24 22:00", "2026-10-25 04:00", freq="h", tz="UTC")
    # The same instants written in Europe/London: local 01:00 appears twice (BST, then GMT).
    london = utc.tz_convert("Europe/London")
    assert (london.hour == 1).sum() == 2
    for ts in (utc, london):
        hourly = _clock_change_frame(ts)
        medians = dict.fromkeys(UPSTREAMS["osney"], 0.0)
        feats = build_features(hourly, "osney", medians)
        assert feats.index.tz is not None and str(feats.index.tz) == "UTC"
        assert len(feats) == len(utc) and feats.index.is_unique
        assert feats.index.equals(pd.DatetimeIndex(utc, name="ts_utc"))
        window = feats.loc["2026-10-25 00:30":"2026-10-25 02:30"]
        assert list(window.index.hour) == [1, 2]
        np.testing.assert_allclose(feats["level_change_1h"].iloc[1:], 0.1)
        y = build_targets(hourly, "osney", horizons=[1])
        np.testing.assert_allclose(y["y_1h"].iloc[:-1], 0.1)


def test_naive_timestamps_rejected() -> None:
    hourly = _clock_change_frame(pd.date_range("2026-10-25 00:00", periods=4, freq="h"))
    with pytest.raises(ValueError, match="tz-aware"):
        build_features(hourly, "osney", dict.fromkeys(UPSTREAMS["osney"], 0.0))
