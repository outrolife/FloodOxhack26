"""model/calibrate.py: CQR rank, negative Q, apply, event windows (SPEC §7.4, §6.1)."""

from __future__ import annotations

import math

import numpy as np
import pandas as pd
import pytest

from model.calibrate import apply_cqr, conformal_q, event_mask, event_windows, fit_cqr


def test_conformal_rank_is_ceil_1_minus_a_n_plus_1() -> None:
    scores = np.arange(1.0, 20.0)  # n = 19 -> ceil(0.9 * 20) = 18 -> 18th smallest = 18
    assert conformal_q(scores, 0.10) == 18.0
    # n = 10, a = 0.5 -> ceil(5.5) = 6 -> 6th smallest
    s = np.array([5, 3, 9, 1, 7, 2, 8, 4, 6, 10], dtype=float)
    assert conformal_q(s, 0.5) == 6.0
    for n in (7, 33, 100):
        s = np.random.default_rng(n).normal(size=n)
        k = math.ceil(0.8 * (n + 1))
        assert conformal_q(s, 0.2) == np.sort(s)[min(k, n) - 1]


def test_conformal_q_can_be_negative_and_clamps_rank() -> None:
    assert conformal_q(np.array([-0.3, -0.2, -0.1, -0.05]), 0.5) == -0.1  # ceil(2.5) = 3
    assert conformal_q(np.array([1.0, 2.0, 3.0]), 0.1) == 3.0  # rank 4 > n -> largest
    assert conformal_q(np.array([np.nan, 1.0]), 0.5) == 1.0
    assert conformal_q(np.array([]), 0.1) == 0.0


def _too_wide_and_too_narrow(rng: np.random.Generator, n: int = 2000) -> tuple[np.ndarray, np.ndarray]:
    y = rng.normal(0, 1, n)
    from scipy.stats import norm

    z = norm.ppf([0.05, 0.10, 0.25, 0.5, 0.75, 0.90, 0.95])
    q = np.tile(z, (n, 1))
    q[:, [0, 6]] *= 0.5  # 90% interval too narrow
    q[:, [2, 4]] *= 2.0  # 50% interval too wide
    return q, y


def test_fit_and_apply_cqr_restore_coverage() -> None:
    rng = np.random.default_rng(0)
    q, y = _too_wide_and_too_narrow(rng)
    qs = fit_cqr(q, y)
    assert qs["05-95"] > 0  # widen
    assert qs["25-75"] < 0  # narrow
    q2, y2 = _too_wide_and_too_narrow(np.random.default_rng(1))
    cal = apply_cqr(q2, qs)
    cov90 = np.mean((y2 >= cal[:, 0]) & (y2 <= cal[:, 6]))
    cov50 = np.mean((y2 >= cal[:, 2]) & (y2 <= cal[:, 4]))
    assert cov90 == pytest.approx(0.90, abs=0.03)
    assert cov50 == pytest.approx(0.50, abs=0.04)
    np.testing.assert_array_equal(cal[:, 3], q2[:, 3])  # median unchanged
    assert np.all(np.diff(cal, axis=1) >= 0)


def test_apply_cqr_resorts_when_negative_q_crosses() -> None:
    q = np.array([[-1.0, -0.5, -0.1, 0.0, 0.1, 0.5, 1.0]])
    out = apply_cqr(q, {"25-75": -0.3})
    assert np.all(np.diff(out, axis=1) >= 0)


def test_fit_cqr_ignores_nan_rows() -> None:
    q = np.tile(np.linspace(-1, 1, 7), (5, 1))
    y = np.array([0.0, np.nan, 0.0, 0.0, 0.0])
    q[2, 3] = np.nan
    assert set(fit_cqr(q, y)) == {"05-95", "10-90", "25-75"}


def test_event_windows_merge_and_peak_rule() -> None:
    idx = pd.date_range("2014-01-01", periods=60 * 24, freq="h", tz="UTC")
    lv = pd.Series(1.0, index=idx)
    lv[idx[100:120]] = 3.5  # event A, peak 3.5
    lv[idx[200:210]] = 3.4  # 80 h later: merged with A
    lv[idx[1000:1010]] = 3.25  # peak only amber + 0.07: dropped
    w = event_windows(lv, amber=3.18)
    assert len(w) == 1
    assert w[0][0] == idx[100] - pd.Timedelta(days=7)
    assert w[0][1] == idx[209] + pd.Timedelta(days=3)
    m = event_mask(lv, 3.18)
    assert m[idx[150]] and not m[idx[1005]]
