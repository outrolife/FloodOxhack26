"""Tests for analysis/earlier_warnings.py (issue #134): every new feature at row t is unchanged when the
data after t (or after t - 7 d for the live-honest soil moisture) is perturbed.

Synthetic data only (seeded); no network, no data files.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from analysis.earlier_warnings import (
    CROSS_UPSTREAMS,
    SM_LAYERS,
    SM_LIVE_LAG_H,
    coinc_columns,
    coinc_features,
    fit_rain_error,
    mos_future_rain,
    noisy_future_rain,
    soil_columns,
    soil_features,
)
from model import features as F

START = pd.Timestamp("2020-01-01 00:00", tz="UTC")
N = 30 * 24


def _idx(n: int = N) -> pd.DatetimeIndex:
    return pd.date_range(START, periods=n, freq="h", tz="UTC", name="ts_utc")


def _soil(seed: int = 0) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    return pd.DataFrame({x: 0.3 + 0.01 * rng.standard_normal(N).cumsum() for x in SM_LAYERS}, index=_idx())


def _hourly(seed: int = 0) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    gauges = {"newbotley", "kingsmill", *F.UPSTREAMS["newbotley"], *F.UPSTREAMS["kingsmill"]}
    rows = []
    for g in sorted(gauges):
        v = 1.0 + 0.02 * rng.standard_normal(N).cumsum()
        rows.append(
            pd.DataFrame({"gauge": g, "ts_utc": _idx(), "kind": "level", "level_mean": v, "rain_mm": np.nan})
        )
    return pd.concat(rows, ignore_index=True)


def _perturb_after(df: pd.DataFrame, t: pd.Timestamp, seed: int = 9) -> pd.DataFrame:
    bad = df.copy()
    rng = np.random.default_rng(seed)
    m = bad.index > t
    bad.loc[m] = bad.loc[m] + rng.standard_normal(bad.loc[m].shape)
    return bad


@pytest.mark.parametrize("lag_h", [0, SM_LIVE_LAG_H])
@pytest.mark.parametrize("t_off", [400, 500, 600])
def test_soil_features_ignore_data_after_t_minus_lag(lag_h: int, t_off: int):
    sm = _soil()
    t = START + pd.Timedelta(hours=t_off)
    before = soil_features(sm, _idx(), lag_h).loc[t]
    after = soil_features(_perturb_after(sm, t - pd.Timedelta(hours=lag_h)), _idx(), lag_h).loc[t]
    pd.testing.assert_series_equal(before, after)
    assert list(before.index) == soil_columns(lag_h)
    # ... and the value really is the one at t - lag
    assert before[f"sm_{SM_LAYERS[0]}_{'now' if lag_h == 0 else 'lag7d'}"] == pytest.approx(
        sm.loc[t - pd.Timedelta(hours=lag_h), SM_LAYERS[0]]
    )


def test_soil_features_missing_hour_is_nan_not_shifted():
    sm = _soil().drop(index=START + pd.Timedelta(hours=300))
    out = soil_features(sm, _idx(), 0)
    assert np.isnan(out.loc[START + pd.Timedelta(hours=300), soil_columns(0)[0]])
    assert np.isnan(out.loc[START + pd.Timedelta(hours=300 + 168), soil_columns(0)[3]])  # 7-day change


@pytest.mark.parametrize("target", ["newbotley", "kingsmill"])
@pytest.mark.parametrize("t_off", [100, 400])
def test_coinc_features_ignore_data_after_t(target: str, t_off: int):
    hourly = _hourly()
    t = START + pd.Timedelta(hours=t_off)
    gauges = [*F.UPSTREAMS[target], *CROSS_UPSTREAMS[target]]
    med = {g: 1.0 for g in gauges}
    before = coinc_features(hourly, target, med, _idx()).loc[t]
    bad = hourly.copy()
    later = bad["ts_utc"] > t
    bad.loc[later, "level_mean"] += np.random.default_rng(3).standard_normal(int(later.sum()))
    after = coinc_features(bad, target, med, _idx()).loc[t]
    pd.testing.assert_series_equal(before, after)
    assert list(before.index) == coinc_columns(target)


def test_mos_is_honest_and_noise_is_marked_as_future():
    rng = np.random.default_rng(1)
    cols = ["rain_next_0_24h", "rain_next_24_48h", "rain_next_48_72h"]
    obs = pd.DataFrame({c: rng.gamma(0.5, 6.0, N) for c in cols}, index=_idx())
    fc = (0.8 * obs + rng.gamma(0.5, 2.0, obs.shape)).clip(lower=0)
    err = fit_rain_error(obs, fc, (START, START + pd.Timedelta(days=20)))
    noisy = noisy_future_rain(obs, err)
    assert noisy.attrs["uses_future_observations"] is True
    assert (noisy >= 0).all().all() and noisy.shape == obs.shape
    # Deterministic (fixed seed)
    pd.testing.assert_frame_equal(noisy, noisy_future_rain(obs, err))
    # MOS reads only the forecast: perturbing the observations does not change it
    m1 = mos_future_rain(fc, err)
    assert m1.attrs["uses_future_observations"] is False
    t = START + pd.Timedelta(hours=600)
    m2 = mos_future_rain(_perturb_after(fc, t), err)
    pd.testing.assert_series_equal(m1.loc[t], m2.loc[t])
