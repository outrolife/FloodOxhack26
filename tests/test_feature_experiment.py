"""Issue #125 B: derived features are known at t (no future data) and well defined."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from analysis import feature_experiment as fe
from model import features as F
from model.train import normalise_hourly
from tests.synth_data import make_hourly

LAGS = {"farmoor->newbotley": {"lag_lo": 2, "lag_main": 30, "lag_hi": 40}}


@pytest.fixture(scope="module")
def hourly() -> pd.DataFrame:
    return normalise_hourly(make_hourly(years=0.5, seed=3))


@pytest.fixture(scope="module")
def medians(hourly: pd.DataFrame) -> dict[str, float]:
    return F.compute_gauge_medians(hourly, hourly["ts_utc"].min() + pd.Timedelta(days=60))


def test_columns_match_schema(hourly, medians):
    X = fe.extra_features(hourly, "newbotley", medians, LAGS)
    assert list(X.columns) == fe.extra_columns("newbotley", LAGS)
    assert X.index.equals(F.build_features(hourly, "newbotley", medians, LAGS).index)
    assert X.notna().mean().min() > 0.5  # every column is mostly populated on synthetic data
    dropped = fe.extra_features(hourly, "newbotley", medians, LAGS, drop=["rain"])
    assert not any(c.startswith("rain_") for c in dropped.columns)


@pytest.mark.parametrize("cut_days", [40, 100])
def test_no_future_data(hourly, medians, cut_days):
    """Row t is identical when every row after t is removed or perturbed."""
    full = fe.extra_features(hourly, "newbotley", medians, LAGS)
    t = hourly["ts_utc"].min() + pd.Timedelta(days=cut_days)
    past = hourly[hourly["ts_utc"] <= t]
    trunc = fe.extra_features(past, "newbotley", medians, LAGS)
    pd.testing.assert_series_equal(full.loc[t], trunc.loc[t])

    noisy = hourly.copy()
    after = noisy["ts_utc"] > t
    rng = np.random.default_rng(0)
    noisy.loc[after, "level_mean"] += rng.normal(0, 1.0, after.sum())
    noisy.loc[after, "rain_mm"] = noisy.loc[after, "rain_mm"] * 5 + 3
    pert = fe.extra_features(noisy, "newbotley", medians, LAGS)
    pd.testing.assert_frame_equal(full.loc[:t], pert.loc[:t])
    assert not full.loc[t + pd.Timedelta(hours=1) :].equals(pert.loc[t + pd.Timedelta(hours=1) :])


def test_hours_since_peak():
    idx = pd.date_range("2020-01-01", periods=100, freq="h", tz="UTC")
    s = pd.Series(np.zeros(100), index=idx)
    s.iloc[50] = 5.0
    age = fe.hours_since_peak(s, 72)
    assert age.iloc[:71].isna().all()  # window not yet full
    assert age.iloc[71] == 21 and age.iloc[99] == 49
    s2 = pd.Series(np.arange(100.0), index=idx)  # rising: the peak is now
    assert (fe.hours_since_peak(s2, 72).dropna() == 0).all()
    s3 = s.copy()
    s3.iloc[80:90] = np.nan  # 10 of 72 missing: below 90 % coverage
    assert fe.hours_since_peak(s3, 72).iloc[95] != fe.hours_since_peak(s3, 72).iloc[95]


def test_api_decay_and_coverage():
    idx = pd.date_range("2020-01-01", periods=fe.API_WINDOW_H + 48, freq="h", tz="UTC")
    r = pd.Series(0.0, index=idx)
    r.iloc[0] = 10.0
    api = fe.antecedent_precip_index(r)
    assert api.iloc[: int(0.9 * fe.API_WINDOW_H) - 1].isna().all()  # < 90 % of 21 days seen
    # at t = 24 h after the rain the weight is 0.9 (only counted where the 21-day window is covered)
    r2 = pd.Series(0.0, index=idx)
    t0 = fe.API_WINDOW_H
    r2.iloc[t0] = 10.0
    api2 = fe.antecedent_precip_index(r2)
    assert api2.iloc[t0] == pytest.approx(10.0)
    assert api2.iloc[t0 + 24] == pytest.approx(9.0)
    r3 = r2.copy()
    r3.iloc[: fe.API_WINDOW_H // 5] = np.nan
    assert np.isnan(fe.antecedent_precip_index(r3).iloc[fe.API_WINDOW_H // 5 + 10])


def test_rise_uses_travel_lag(hourly, medians):
    X = fe.extra_features(hourly, "newbotley", medians, LAGS)
    lv = F.pivot_hourly(hourly[hourly["gauge"] == "farmoor"])["farmoor"].reindex(X.index)
    expect = lv - lv.shift(30)
    pd.testing.assert_series_equal(X["farmoor_anom_rise_main"], expect, check_names=False)
    assert fe.lag_main_h("eynsham", "newbotley", {"eynsham->newbotley": {"lag_main": 0}}) == 1


def test_train_wrap_and_score_end_to_end(tmp_path):
    """Both arms train with the same harness; saved variant models rebuild their extra columns."""
    from model import backtest

    hourly = normalise_hourly(make_hourly(years=4.0, seed=1))
    fast = {"n_estimators": 20, "early_stopping_rounds": 5, "params": {"num_threads": 2}}
    lags = {"farmoor->newbotley": {"lag_lo": 24, "lag_main": 30, "lag_hi": 36}}
    base = fe.train_arm_gauge(hourly, "newbotley", lags, "baseline", **fast)
    var = fe.train_arm_gauge(hourly, "newbotley", lags, "features", **fast)
    assert var.feature_cols == base.feature_cols + fe.extra_columns("newbotley", lags)
    var.save(tmp_path / "newbotley")
    loaded = fe.load_models(tmp_path)
    wrapped = fe.wrap_arm(hourly, loaded)["newbotley"]
    assert wrapped.extra is not None and wrapped.splits == var.splits
    X = F.build_features(hourly, "newbotley", var.medians, var.lags).iloc[-500:]
    np.testing.assert_allclose(wrapped.predict(X)[72], var.predict(X.join(wrapped.extra))[72])
    spots = [s for s in backtest.load_spots() if s["gauge"] == "newbotley"]
    res = {"testStart": str(var.splits.test_start), "dataEnd": str(hourly["ts_utc"].max()), "events": []}
    res["scores"] = [
        fe.score_arm(n, fe.wrap_arm(hourly, {"newbotley": m}), hourly, spots)
        for n, m in (("baseline", base), ("features", var))
    ]
    res["importance"] = {"features": fe.importance_summary({"newbotley": var})}
    assert [r["h"] for r in res["scores"][1]["skill"]] == list(F.HORIZONS_H)
    assert "botley" in res["scores"][0]["brier"]
    text = fe.report(res)
    assert "Pinball skill" in text and "Gain share" in text
