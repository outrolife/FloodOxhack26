"""Tests for analysis/rain_experiment.py (issue #100): the honest rain-forecast features never use data
issued after t, and the perfect-prognosis features are labelled as looking into the future.

Synthetic data only (seeded); no network, no data files.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from analysis.rain_experiment import (
    AVAIL_BUFFER_H,
    MAX_DAY,
    RAIN_FEATURES,
    WINDOWS,
    day_offset,
    forecast_future_rain,
    issue_time_upper_bound,
    observed_future_rain,
)

START = pd.Timestamp("2025-01-01 00:00", tz="UTC")
N = 20 * 24


def _rain(seed: int = 0) -> pd.Series:
    rng = np.random.default_rng(seed)
    idx = pd.date_range(START, periods=N, freq="h", tz="UTC", name="ts_utc")
    return pd.Series(rng.gamma(0.3, 2.0, N), index=idx)


def _archive(seed: int = 1) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    idx = pd.date_range(START, periods=N, freq="h", tz="UTC", name="ts_utc")
    return pd.DataFrame({f"d{d}": rng.gamma(0.3, 2.0, N) for d in range(1, MAX_DAY + 1)}, index=idx)


def test_day_offset_keeps_the_availability_buffer():
    for k in range(1, WINDOWS[-1][2] + 1):
        d = day_offset(k)
        assert d <= MAX_DAY
        # The run behind future hour k was issued >= 24 d h before that hour ends, i.e. at
        # tau + k - 24 d <= tau - buffer.
        assert k - 24 * d <= -AVAIL_BUFFER_H
    assert day_offset(1) == 1 and day_offset(18) == 1 and day_offset(19) == 2 and day_offset(72) == 4


@pytest.mark.parametrize("t_off", [100, 200, 300])
def test_forecast_features_ignore_forecasts_issued_after_t(t_off: int):
    """Perturb every archive value that could have been issued after tau - buffer: row t is unchanged."""
    arch = _archive()
    t = START + pd.Timedelta(hours=t_off)
    tau = t + pd.Timedelta(hours=1)
    before = forecast_future_rain(arch).loc[t]
    bad = arch.copy()
    rng = np.random.default_rng(7)
    for d in range(1, MAX_DAY + 1):
        issued = issue_time_upper_bound(bad.index, d)
        late = issued + pd.Timedelta(hours=AVAIL_BUFFER_H) > tau
        bad.loc[late, f"d{d}"] = rng.gamma(2.0, 10.0, int(late.sum()))
    after = forecast_future_rain(bad).loc[t]
    pd.testing.assert_series_equal(before, after)
    assert np.isfinite(before.to_numpy()).all()


def test_forecast_features_never_read_observed_rain():
    """Observed rain after t can change arbitrarily: the honest builder does not take it at all."""
    arch = _archive()
    f = forecast_future_rain(arch)
    assert f.attrs["uses_future_observations"] is False
    assert list(f.columns) == list(RAIN_FEATURES)
    # Rebuilding from the same archive (any observed rain is irrelevant) is identical.
    pd.testing.assert_frame_equal(f, forecast_future_rain(arch.copy()))


def test_observed_future_rain_is_labelled_and_looks_forward():
    """Training-mode features are flagged and DO depend on rain after t (perfect prognosis)."""
    rain = _rain()
    t = START + pd.Timedelta(hours=150)
    f = observed_future_rain(rain)
    assert f.attrs["uses_future_observations"] is True
    assert "upper bound" in f.attrs["label"]
    # Value check: next 0-24 h = sum of the hours labelled t+1 .. t+24.
    expect = rain.loc[t + pd.Timedelta(hours=1) : t + pd.Timedelta(hours=24)].sum()
    assert f.loc[t, "rain_next_0_24h"] == pytest.approx(expect)
    # Rain at or before t does not enter; rain after t does.
    past = rain.copy()
    past.loc[:t] = 0.0
    pd.testing.assert_series_equal(observed_future_rain(past).loc[t], f.loc[t])
    future = rain.copy()
    future.loc[t + pd.Timedelta(hours=1) :] += 5.0
    assert (observed_future_rain(future).loc[t] > f.loc[t]).all()


def test_forecast_windows_line_up_with_observed_windows():
    """With a 'perfect' archive (every offset = the observed rain) both builders agree."""
    rain = _rain()
    arch = pd.DataFrame({f"d{d}": rain for d in range(1, MAX_DAY + 1)})
    obs = observed_future_rain(rain)
    fc = forecast_future_rain(arch)
    common = obs.dropna().index.intersection(fc.dropna().index)
    assert len(common) > 100
    pd.testing.assert_frame_equal(obs.loc[common], fc.loc[common], check_exact=False)


def test_gaps_give_nan_not_undercount():
    rain = _rain()
    t = START + pd.Timedelta(hours=100)
    holes = rain.copy()
    holes.loc[t + pd.Timedelta(hours=1) : t + pd.Timedelta(hours=6)] = np.nan  # 6 of 24 missing
    assert np.isnan(observed_future_rain(holes).loc[t, "rain_next_0_24h"])
