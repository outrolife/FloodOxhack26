"""Issue #125 C: regime CQR fits on validation rows only, and regimes use only data known at t."""

from __future__ import annotations

from types import SimpleNamespace

import numpy as np
import pandas as pd
import pytest

from analysis import calib_experiment as ce
from model import features as F
from model.calibrate import apply_cqr
from model.train import Splits, normalise_hourly
from tests.synth_data import make_hourly

LAGS = {"farmoor->newbotley": {"lag_lo": 2, "lag_main": 30, "lag_hi": 40}}


@pytest.fixture(scope="module")
def hourly() -> pd.DataFrame:
    return normalise_hourly(make_hourly(years=0.5, seed=4))


@pytest.fixture(scope="module")
def medians(hourly: pd.DataFrame) -> dict[str, float]:
    return F.compute_gauge_medians(hourly, hourly["ts_utc"].min() + pd.Timedelta(days=60))


def _amber(X: pd.DataFrame) -> float:
    # a line the synthetic river crosses, so all three regimes occur
    return float(np.nanquantile(X["level_now"], 0.9)) + ce.WEIGHT_MARGIN_M


@pytest.mark.parametrize("cut_days", [45, 110])
def test_regimes_use_only_rows_up_to_t(hourly, medians, cut_days):
    """Regime labels up to t are unchanged when rows after t are removed or perturbed."""
    full = F.build_features(hourly, "newbotley", medians, LAGS)
    amber = _amber(full)
    reg_full = pd.Series(ce.regimes(full, amber, 3), index=full.index)
    assert set(np.unique(reg_full)) == {ce.CALM, ce.RISING, ce.HIGH}

    t = hourly["ts_utc"].min() + pd.Timedelta(days=cut_days)
    past = F.build_features(hourly[hourly["ts_utc"] <= t], "newbotley", medians, LAGS)
    reg_past = pd.Series(ce.regimes(past, amber, 3), index=past.index)
    pd.testing.assert_series_equal(reg_full.loc[:t], reg_past.loc[:t])

    noisy = hourly.copy()
    after = noisy["ts_utc"] > t
    rng = np.random.default_rng(1)
    noisy.loc[after, "level_mean"] += rng.normal(0, 2.0, after.sum())
    noisy.loc[after, "rain_mm"] = noisy.loc[after, "rain_mm"] * 5 + 3
    pert = F.build_features(noisy, "newbotley", medians, LAGS)
    reg_pert = pd.Series(ce.regimes(pert, amber, 3), index=pert.index)
    pd.testing.assert_series_equal(reg_full.loc[:t], reg_pert.loc[:t])
    assert not reg_full.loc[t + pd.Timedelta(hours=1) :].equals(reg_pert.loc[t + pd.Timedelta(hours=1) :])


def test_regimes_row_local(hourly, medians):
    """A row's label is a function of that row alone (shuffling rows shuffles labels)."""
    X = F.build_features(hourly, "newbotley", medians, LAGS).dropna(subset=["level_now"])
    amber = _amber(X)
    perm = np.random.default_rng(2).permutation(len(X))
    assert np.array_equal(ce.regimes(X, amber, 3)[perm], ce.regimes(X.iloc[perm], amber, 3))
    assert (ce.regimes(X, amber, 1) == ce.CALM).all()
    r2 = ce.regimes(X, amber, 2)
    assert set(np.unique(r2)) <= {ce.CALM, ce.HIGH}
    assert np.array_equal(r2 == ce.HIGH, X["level_now"].to_numpy() > amber - ce.WEIGHT_MARGIN_M)


def _fake(n_days: int = 400, seed: int = 0):
    """A fake model and frame: 400 days hourly, validation = days 150-300, test from day 300."""
    rng = np.random.default_rng(seed)
    idx = pd.date_range("2020-01-01", periods=n_days * 24, freq="h", tz="UTC", name="ts_utc")
    splits = Splits(idx[150 * 24], idx[300 * 24])
    lv = 1.5 + 0.5 * np.sin(np.arange(len(idx)) / 200.0) + rng.normal(0, 0.05, len(idx))
    X = pd.DataFrame(
        {
            "level_now": lv,
            "farmoor_change_24h": rng.normal(0, 0.05, len(idx)),
            "rain_sum_72h": rng.gamma(1.0, 5.0, len(idx)),
        },
        index=idx,
    )
    hs = [6, 72]
    Y = pd.DataFrame({f"y_{h}h": rng.normal(0, 0.1 + 0.2 * (lv > 1.7), len(idx)) for h in hs}, index=idx)
    base = np.array([-0.15, -0.1, -0.05, 0.0, 0.05, 0.1, 0.15])
    raw = {h: np.tile(base, (len(idx), 1)) for h in hs}
    m = SimpleNamespace(
        amber=2.0,
        splits=splits,
        horizons=hs,
        cqr={h: {"05-95": 0.1, "10-90": 0.05, "25-75": 0.02} for h in hs},
    )
    ev = pd.Series(lv > 1.8, index=idx)
    return m, X, Y, raw, ev


def test_fit_uses_only_validation_rows():
    """Changing outcomes, predictions and regimes outside validation leaves every Q unchanged."""
    m, X, Y, raw, ev = _fake()
    a = ce.fit_variants(m, X, Y, raw, ev, min_rows=50)
    for h in m.horizons:
        _, va, _ = m.splits.masks(X.index, h)
        assert not va[X.index >= m.splits.test_start].any()
        # validation rows whose target time t + h is in the test period are not used either
        assert not va[(X.index + pd.Timedelta(hours=h)) >= m.splits.test_start].any()
    X2, Y2 = X.copy(), Y.copy()
    raw2 = {h: q.copy() for h, q in raw.items()}
    for h in m.horizons:
        _, va, _ = m.splits.masks(X.index, h)
        outside = ~va
        Y2.loc[outside, f"y_{h}h"] = 99.0
        raw2[h][outside] += 5.0
    out = (X.index < m.splits.val_start) | (X.index >= m.splits.test_start)
    X2.loc[out, "level_now"] = 5.0  # all "high" outside validation
    b = ce.fit_variants(m, X2, Y2, raw2, ev, min_rows=50)
    for v in ce.VARIANTS:
        assert a[v] == b[v], v
    # and the fit does react to validation rows
    Y3 = Y.copy()
    Y3.loc[(X.index >= m.splits.val_start) & (X.index < m.splits.test_start), "y_72h"] *= 3
    c = ce.fit_variants(m, X, Y3, raw, ev, min_rows=50)
    assert c["m2"][72] != a["m2"][72]


def test_regime_q_and_fallback():
    m, X, Y, raw, ev = _fake()
    f = ce.fit_variants(m, X, Y, raw, ev, min_rows=50)
    h = 72
    # the high-water rows are noisier: wider Q than calm in the Mondrian variant
    assert f["m2"][h][ce.HIGH]["05-95"] > f["m2"][h][ce.CALM]["05-95"]
    # hybrids keep the shipped Q outside calm
    assert f["m2h"][h][ce.HIGH] == m.cqr[h]
    assert f["m3h"][h][ce.RISING] == m.cqr[h] and f["m3h"][h][ce.HIGH] == m.cqr[h]
    assert f["current"][h][ce.CALM] == m.cqr[h]
    # a huge minimum makes every regime fall back to the pooled Q
    g = ce.fit_variants(m, X, Y, raw, ev, min_rows=10**9)
    assert g["m3"][h][ce.HIGH] == g["pooled_all"][h][ce.HIGH] == g["m3"][h][ce.CALM]
    assert g["m3h"][h][ce.CALM] == m.cqr[h]


def test_apply_regime_q_rowwise():
    q = np.tile(np.array([-0.3, -0.2, -0.1, 0.0, 0.1, 0.2, 0.3]), (4, 1))
    reg = np.array([ce.CALM, ce.HIGH, ce.RISING, ce.HIGH])
    qs = {
        ce.CALM: {"05-95": -0.05, "10-90": 0.0, "25-75": 0.0},
        ce.RISING: {"05-95": 0.0, "10-90": 0.0, "25-75": 0.0},
        ce.HIGH: {"05-95": 0.2, "10-90": 0.1, "25-75": 0.05},
    }
    out = ce.apply_regime_q(q, reg, qs)
    for i, r in enumerate(reg):
        assert np.allclose(out[i], apply_cqr(q[i : i + 1], qs[r])[0])
    assert np.allclose(out[0, [0, 6]], [-0.25, 0.25]) and np.allclose(out[1, [0, 6]], [-0.5, 0.5])
