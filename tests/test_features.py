"""Tests for model/features.py: no future data in features (SPEC §7.2, §15 item 6) and correctness.

Synthetic data only (seeded); no network, no data files.
"""

from __future__ import annotations

import json
import time

import numpy as np
import pandas as pd
import pytest

from model.features import (
    BRANCHES,
    LIVE_ONLY,
    MAX_WINDOW_H,
    RAIN_KEY,
    TARGETS,
    UPSTREAM_FIXED_LAGS_H,
    UPSTREAMS,
    build_features,
    build_targets,
    catchment_rain,
    compute_gauge_medians,
    feature_columns,
    input_gauges,
    load_lags,
    pivot_hourly,
    upstream_lags_h,
)

START = pd.Timestamp("2026-09-01 00:00", tz="UTC")
N_HOURS = 40 * 24  # longer than the 21-day window
LEVEL_GAUGES = ["farmoor", "eynsham", "cassington", "newbotley", "minns", "coldharbour"]
RAIN_GAUGES = ["256230TP", "254336TP", "261021TP"]
TEST_LAGS = {"farmoor->newbotley": {"lag_lo": 30, "lag_main": 40, "lag_hi": 55}}


def make_hourly(
    seed: int = 0, n_hours: int = N_HOURS, drop_frac: float = 0.03, fmt: str = "derived"
) -> pd.DataFrame:
    """Long-format frame like data/processed/hourly.parquet, with a few hours missing per gauge.

    ``fmt="derived"``: the pipeline's variant (no ``kind``; one derived ``rain_catchment`` series).
    ``fmt="kind"``: the variant agreed on issue #3 (``kind`` column, one row set per rain gauge ref).
    ``fmt="final"``: the final #3 format: ``kind`` column, rain gauge refs *and* ``rain_catchment``
    (kind="rain"). Here the derived series is deliberately 2x the gauge mean, so a builder that
    averaged it together with the gauges would give different numbers.
    """
    rng = np.random.default_rng(seed)
    ts = pd.date_range(START, periods=n_hours, freq="h", tz="UTC")
    rows = []
    for i, g in enumerate(LEVEL_GAUGES):
        level = 1.0 + i + np.cumsum(rng.normal(0, 0.01, n_hours))  # each gauge its own datum
        rows.append(
            pd.DataFrame({"gauge": g, "ts_utc": ts, "kind": "level", "level_mean": level, "rain_mm": np.nan})
        )
    gauge_rain = []
    for g in [RAIN_KEY] if fmt == "derived" else RAIN_GAUGES:
        rain = rng.gamma(0.3, 1.0, n_hours) * (rng.random(n_hours) < 0.3)
        gauge_rain.append(rain)
        rows.append(
            pd.DataFrame({"gauge": g, "ts_utc": ts, "kind": "rain", "level_mean": np.nan, "rain_mm": rain})
        )
    if fmt == "final":
        derived = 2.0 * np.mean(gauge_rain, axis=0)
        rows.append(
            pd.DataFrame(
                {"gauge": RAIN_KEY, "ts_utc": ts, "kind": "rain", "level_mean": np.nan, "rain_mm": derived}
            )
        )
    df = pd.concat(rows, ignore_index=True)
    df["filled"] = False
    df["level_max"] = df["level_mean"]
    df["flagged"] = False
    if fmt == "derived":
        df = df.drop(columns="kind")
    keep = rng.random(len(df)) >= drop_frac
    return df[keep].reset_index(drop=True)


def _rain_mask(df: pd.DataFrame) -> pd.Series:
    return df["level_mean"].isna() & df["rain_mm"].notna() | df["gauge"].isin([RAIN_KEY, *RAIN_GAUGES])


def perturb_after(df: pd.DataFrame, cut: pd.Timestamp, seed: int) -> pd.DataFrame:
    """Replace every value strictly after `cut` (all gauges, rain too) and drop some future rows."""
    rng = np.random.default_rng(seed)
    out = df.copy()
    future = out["ts_utc"] > cut
    is_rain = _rain_mask(out)
    out.loc[future & ~is_rain, "level_mean"] = rng.normal(50, 20, int((future & ~is_rain).sum()))
    out.loc[future & is_rain, "rain_mm"] = rng.uniform(0, 100, int((future & is_rain).sum()))
    drop = future & (rng.random(len(out)) < 0.2)
    return out[~drop].reset_index(drop=True)


def assert_same(a: pd.DataFrame, b: pd.DataFrame) -> None:
    pd.testing.assert_frame_equal(a, b, check_exact=True)  # NaN == NaN here


# ---------------------------------------------------------------------------------------------
# Leakage (the important one)
# ---------------------------------------------------------------------------------------------


@pytest.mark.parametrize("fmt", ["derived", "kind", "final"])
@pytest.mark.parametrize("target", ["newbotley", "minns", "coldharbour"])
def test_features_do_not_see_the_future(target: str, fmt: str) -> None:
    """Replace everything after t: features at every time <= t must not change.

    The anomaly medians are recomputed from the perturbed data with the cut as cutoff, so the test
    covers the whole chain (medians + features), not just build_features with fixed numbers.
    """
    hourly = make_hourly(seed=1, fmt=fmt)
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


@pytest.mark.parametrize("fmt", ["derived", "kind", "final"])
def test_medians_ignore_data_after_cutoff(fmt: str) -> None:
    hourly = make_hourly(seed=2, fmt=fmt)
    cutoff = START + pd.Timedelta(days=10, hours=5)
    before = compute_gauge_medians(hourly, cutoff)
    after = compute_gauge_medians(perturb_after(hourly, cutoff, seed=7), cutoff)
    pd.testing.assert_series_equal(pd.Series(before), pd.Series(after))
    assert set(LEVEL_GAUGES) <= set(before) and not set(before) & {RAIN_KEY, *RAIN_GAUGES}
    assert np.isnan(before["enslow"])  # configured but absent -> NaN, so build_features still works
    expected = hourly[(hourly["gauge"] == "farmoor") & (hourly["ts_utc"] <= cutoff)]["level_mean"].median()
    assert before["farmoor"] == pytest.approx(expected)


def test_targets_look_forward_and_are_not_features() -> None:
    hourly = make_hourly(seed=3, drop_frac=0.0)
    y = build_targets(hourly, "newbotley")
    level = pivot_hourly(hourly)["newbotley"]
    t = START + pd.Timedelta(hours=100)
    assert y.loc[t, "y_6h"] == pytest.approx(level[t + pd.Timedelta(hours=6)] - level[t])
    assert y["y_72h"].iloc[-72:].isna().all()
    assert not set(y.columns) & set(feature_columns("newbotley"))


# ---------------------------------------------------------------------------------------------
# Correctness
# ---------------------------------------------------------------------------------------------


def _features(hourly: pd.DataFrame, target: str = "newbotley") -> pd.DataFrame:
    return build_features(
        hourly, target, compute_gauge_medians(hourly, START + pd.Timedelta(days=15)), TEST_LAGS
    )


def test_columns_and_lags() -> None:
    assert upstream_lags_h("farmoor", "newbotley", TEST_LAGS) == [0, 6, 12, 24, 30, 40, 55]
    feats = _features(make_hourly())
    assert list(feats.columns) == feature_columns("newbotley", TEST_LAGS)
    assert all(dt == np.float64 for dt in feats.dtypes)
    for up in UPSTREAMS["newbotley"]:
        assert f"{up}_anom_lag0h" in feats.columns
        assert f"{up}_change_3h" in feats.columns and f"{up}_change_24h" in feats.columns
    assert feature_columns("newbotley")[:6] == [
        "level_now",
        "level_change_1h",
        "level_change_3h",
        "level_change_6h",
        "level_change_24h",
        "level_mean_21d",
    ]
    assert feature_columns("newbotley")[-7:] == [
        "rain_sum_6h",
        "rain_sum_24h",
        "rain_sum_72h",
        "rain_sum_168h",
        "rain_sum_21d",
        "doy_sin",
        "doy_cos",
    ]
    for target in TARGETS:
        cols = feature_columns(target)
        assert len(cols) == len(set(cols))


def test_lags_deduplicated_and_capped() -> None:
    lags = {"cassington->newbotley": {"lag_lo": 6, "lag_main": 12, "lag_hi": 999}}
    # 6 and 12 already in the fixed set; 999 h is capped at 21 days.
    assert upstream_lags_h("cassington", "newbotley", lags) == [0, 6, 12, 24, MAX_WINDOW_H]
    cols = feature_columns("newbotley", lags)
    assert [c for c in cols if c.startswith("cassington_anom")] == [
        f"cassington_anom_lag{k}h" for k in (0, 6, 12, 24, MAX_WINDOW_H)
    ]


def test_lags_fallback_to_fixed_set(tmp_path) -> None:
    fixed = list(UPSTREAM_FIXED_LAGS_H)
    assert fixed == [0, 6, 12, 24]
    assert upstream_lags_h("eynsham", "newbotley", TEST_LAGS) == fixed  # pair not in lags.json
    assert upstream_lags_h("eynsham", "newbotley", None) == fixed  # no lags.json at all
    assert load_lags(tmp_path / "missing.json") == {}
    assert feature_columns("newbotley", load_lags(tmp_path / "missing.json")) == feature_columns("newbotley")


def test_load_lags_reads_issue_7_format(tmp_path) -> None:
    raw = {
        "pairs": [
            {
                "up": "farmoor",
                "down": "newbotley",
                "lag_lo": 30,
                "lag_main": 40,
                "lag_hi": 55,
                "source": "events",
            },
            {
                "up": "cassington",
                "down": "newbotley",
                "lag_lo": 0,
                "lag_main": 3,
                "lag_hi": 9,
                "source": "xcorr",
            },
        ]
    }
    path = tmp_path / "lags.json"
    path.write_text(json.dumps(raw), encoding="utf-8")
    lags = load_lags(path)
    assert lags["farmoor->newbotley"] == {"lag_lo": 30, "lag_main": 40, "lag_hi": 55}
    assert upstream_lags_h("cassington", "newbotley", lags) == [0, 3, 6, 9, 12, 24]
    # The raw JSON dict works directly too.
    assert feature_columns("newbotley", raw) == feature_columns("newbotley", lags)


def test_lag_and_anomaly_at_t_equal_value_at_t_minus_lag() -> None:
    hourly = make_hourly(seed=4)
    medians = compute_gauge_medians(hourly, START + pd.Timedelta(days=15))
    feats = build_features(hourly, "newbotley", medians, TEST_LAGS)
    levels = pivot_hourly(hourly)
    for t in [START + pd.Timedelta(hours=h) for h in (200, 333, 700)]:
        for k in (6, 40):
            expected = levels.loc[t - pd.Timedelta(hours=k), "farmoor"] - medians["farmoor"]
            np.testing.assert_equal(feats.loc[t, f"farmoor_anom_lag{k}h"], expected)
        np.testing.assert_equal(
            feats.loc[t, "level_change_6h"],
            levels.loc[t, "newbotley"] - levels.loc[t - pd.Timedelta(hours=6), "newbotley"],
        )


def test_missing_hours_give_nan_not_shifted_values() -> None:
    hourly = make_hourly(seed=5, drop_frac=0.0)
    gap = START + pd.Timedelta(hours=300)
    hourly = hourly[~((hourly["gauge"] == "farmoor") & (hourly["ts_utc"] == gap))]
    hourly = hourly[~((hourly["gauge"] == "newbotley") & (hourly["ts_utc"] == gap))]
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


def test_catchment_rain_is_mean_of_available_gauges() -> None:
    hourly = make_hourly(seed=9, drop_frac=0.0, fmt="kind")
    t1 = START + pd.Timedelta(hours=100)
    t2 = START + pd.Timedelta(hours=101)
    gone = (hourly["gauge"] == RAIN_GAUGES[0]) & (hourly["ts_utc"] == t1)
    gone |= hourly["gauge"].isin(RAIN_GAUGES) & (hourly["ts_utc"] == t2)
    hourly = hourly[~gone]
    rain = catchment_rain(hourly)
    wide = pivot_hourly(hourly[hourly["kind"] == "rain"], "rain_mm")
    t0 = START + pd.Timedelta(hours=99)
    assert rain[t0] == pytest.approx(wide.loc[t0, RAIN_GAUGES].mean())
    assert rain[t1] == pytest.approx(wide.loc[t1, RAIN_GAUGES[1:]].mean())  # one gauge missing
    assert np.isnan(rain[t2])  # no gauge reporting -> NaN, not 0
    feats = _features(hourly)
    assert np.isnan(feats.loc[t2, "rain_sum_6h"])  # 5 of 6 hours is below 90 % coverage
    # The pipeline's derived series wins over individual gauges (no double counting).
    derived = pd.DataFrame(
        {"gauge": RAIN_KEY, "ts_utc": [t0], "kind": "rain", "level_mean": np.nan, "rain_mm": [7.0]}
    )
    assert catchment_rain(pd.concat([hourly, derived])).dropna().tolist() == [7.0]


def test_final_format_uses_rain_catchment_alone() -> None:
    """Final #3 format: rain_catchment (kind="rain") next to the gauges is used as is, not averaged in."""
    hourly = make_hourly(seed=13, drop_frac=0.0, fmt="final")
    rain = catchment_rain(hourly)
    wide = pivot_hourly(hourly[hourly["kind"] == "rain"], "rain_mm")
    pd.testing.assert_series_equal(rain, wide[RAIN_KEY], check_names=False)
    assert not np.allclose(rain, wide.mean(axis=1))  # averaging all four would differ
    feats = _features(hourly)
    t = START + pd.Timedelta(hours=600)
    window = wide[RAIN_KEY].loc[t - pd.Timedelta(hours=23) : t]
    assert feats.loc[t, "rain_sum_24h"] == pytest.approx(window.sum())
    assert sorted(compute_gauge_medians(hourly, t)) == sorted(
        set(LEVEL_GAUGES) | {g for t in TARGETS for g in input_gauges(t)} | set(TARGETS)
    )


def test_targets_and_flow_paths_follow_pr_30() -> None:
    """SPEC §4.1.1 (PR #30): four trained targets; the main-channel locks are live only."""
    assert TARGETS == ("newbotley", "minns", "coldharbour", "kingsmill")
    for target in ("newbotley", "minns", "coldharbour"):
        assert UPSTREAMS[target] == ("farmoor", "eynsham", "cassington")
    assert UPSTREAMS["kingsmill"] == ("enslow", "islip")
    for lock in LIVE_ONLY:
        assert lock not in TARGETS
        assert all(lock not in ups for ups in UPSTREAMS.values())
        with pytest.raises(ValueError, match="live only"):
            feature_columns(lock)
    with pytest.raises(ValueError, match="unknown target"):
        feature_columns("nowhere")


@pytest.mark.parametrize("target", ["minns", "coldharbour"])
def test_new_targets_build_features_and_targets(target: str) -> None:
    hourly = make_hourly(seed=14, drop_frac=0.0, fmt="final")
    medians = compute_gauge_medians(hourly, START + pd.Timedelta(days=15))
    feats = build_features(hourly, target, medians, TEST_LAGS)
    assert list(feats.columns) == feature_columns(target, TEST_LAGS)
    n_branch = 2 * len(BRANCHES.get(target, {}))  # #134 branch signals (coldharbour: 3 branches x 2)
    assert len(feats.columns) == 6 + 3 * 6 + 7 + n_branch  # no godstow columns
    assert not any(c.startswith(("godstow", "osney", "iffley")) for c in feats.columns)
    levels = pivot_hourly(hourly[hourly["kind"] == "level"])
    t = START + pd.Timedelta(hours=700)
    np.testing.assert_equal(feats.loc[t, "level_now"], levels.loc[t, target])
    np.testing.assert_equal(
        feats.loc[t, "cassington_anom_lag12h"],
        levels.loc[t - pd.Timedelta(hours=12), "cassington"] - medians["cassington"],
    )
    y = build_targets(hourly, target)
    np.testing.assert_equal(
        y.loc[t, "y_24h"], levels.loc[t + pd.Timedelta(hours=24), target] - levels.loc[t, target]
    )
    own = [c for c in feats.columns if not c.startswith("br_")]  # no branch gauges in this data
    assert feats[own].iloc[MAX_WINDOW_H + 30 :].notna().mean().min() > 0.9


def test_nan_propagation() -> None:
    hourly = make_hourly(seed=10, drop_frac=0.0)
    t = START + pd.Timedelta(hours=700)  # past the first 21 days, so level_mean_21d exists
    # A NaN value (e.g. a long gap the pipeline left unfilled) behaves like a missing row.
    hourly.loc[(hourly["gauge"] == "newbotley") & (hourly["ts_utc"] == t), "level_mean"] = np.nan
    # Eynsham is entirely absent: its columns exist but are all NaN.
    hourly = hourly[hourly["gauge"] != "eynsham"]
    feats = _features(hourly)
    assert np.isnan(feats.loc[t, "level_now"])
    for k in (1, 3, 6, 24):
        assert np.isnan(feats.loc[t, f"level_change_{k}h"])
        assert np.isnan(feats.loc[t + pd.Timedelta(hours=k), f"level_change_{k}h"])
        assert not np.isnan(feats.loc[t + pd.Timedelta(hours=k + 1), f"level_change_{k}h"])
    assert not np.isnan(feats.loc[t, "level_mean_21d"])  # 1 of 504 hours missing is tolerated
    eyn = [c for c in feats.columns if c.startswith("eynsham_")]
    assert eyn and feats[eyn].isna().all().all()
    assert feats.drop(columns=eyn).iloc[MAX_WINDOW_H + 30 :].notna().mean().min() > 0.9


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
    level = pivot_hourly(hourly)["newbotley"]
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
    a = build_features(hourly, "newbotley", medians, TEST_LAGS).loc[t]
    b = build_features(changed, "newbotley", medians, TEST_LAGS).loc[t]
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
        {"gauge": "newbotley", "ts_utc": ts, "level_mean": 3.0 + 0.1 * np.arange(n), "rain_mm": np.nan}
    )


def test_clock_change_one_row_per_utc_hour() -> None:
    utc = pd.date_range("2026-10-24 22:00", "2026-10-25 04:00", freq="h", tz="UTC")
    # The same instants written in Europe/London: local 01:00 appears twice (BST, then GMT).
    london = utc.tz_convert("Europe/London")
    assert (london.hour == 1).sum() == 2
    for ts in (utc, london):
        hourly = _clock_change_frame(ts)
        medians = dict.fromkeys(UPSTREAMS["newbotley"], 0.0)
        feats = build_features(hourly, "newbotley", medians)
        assert feats.index.tz is not None and str(feats.index.tz) == "UTC"
        assert len(feats) == len(utc) and feats.index.is_unique
        assert feats.index.equals(pd.DatetimeIndex(utc, name="ts_utc"))
        window = feats.loc["2026-10-25 00:30":"2026-10-25 02:30"]
        assert list(window.index.hour) == [1, 2]
        np.testing.assert_allclose(feats["level_change_1h"].iloc[1:], 0.1)
        y = build_targets(hourly, "newbotley", horizons=[1])
        np.testing.assert_allclose(y["y_1h"].iloc[:-1], 0.1)


def test_clock_change_with_missing_hour_stays_continuous() -> None:
    """Full fixture across the DST change, with every gauge missing 01:00 UTC: no row is lost."""
    hourly = make_hourly(seed=11, drop_frac=0.0, fmt="kind")
    shift = pd.Timestamp("2026-10-25 01:00", tz="UTC") - (START + pd.Timedelta(hours=N_HOURS // 2))
    hourly["ts_utc"] = hourly["ts_utc"] + shift  # put the clock change mid-series
    gap = pd.Timestamp("2026-10-25 01:00", tz="UTC")
    hourly = hourly[hourly["ts_utc"] != gap]
    hourly["ts_utc"] = hourly["ts_utc"].dt.tz_convert("Europe/London")  # wall-clock input is fine
    medians = compute_gauge_medians(hourly, "2026-10-01")
    feats = build_features(hourly, "newbotley", medians, TEST_LAGS)
    assert str(feats.index.tz) == "UTC"
    assert feats.index.to_series().diff().dropna().eq(pd.Timedelta(hours=1)).all()
    window = feats.loc["2026-10-25 00:30":"2026-10-25 02:30"]
    assert list(window.index) == [gap, gap + pd.Timedelta(hours=1)]
    assert np.isnan(window.loc[gap, "level_now"])
    assert not np.isnan(window.loc[gap + pd.Timedelta(hours=1), "level_now"])
    assert np.isnan(window.loc[gap + pd.Timedelta(hours=1), "level_change_1h"])
    y = build_targets(hourly, "newbotley")
    assert y.index.equals(feats.index)


def test_fast_on_twenty_years() -> None:
    """Vectorised: ~20 years of hourly data for 5 level and 3 rain gauges builds in seconds."""
    n = 20 * 8766
    hourly = make_hourly(seed=12, n_hours=n, drop_frac=0.01, fmt="kind")
    t0 = time.perf_counter()
    medians = compute_gauge_medians(hourly, START + pd.Timedelta(days=365 * 12))
    feats = build_features(hourly, "newbotley", medians, TEST_LAGS)
    build_targets(hourly, "newbotley")
    elapsed = time.perf_counter() - t0
    assert len(feats) == n
    assert elapsed < 30, f"took {elapsed:.1f} s"


def test_naive_timestamps_rejected() -> None:
    hourly = _clock_change_frame(pd.date_range("2026-10-25 00:00", periods=4, freq="h"))
    with pytest.raises(ValueError, match="tz-aware"):
        build_features(hourly, "newbotley", dict.fromkeys(UPSTREAMS["newbotley"], 0.0))
