"""model/probability.py: CDF interpolation, tails, clipping, monotone leads, arrival (SPEC §7.5)."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from model.probability import (
    ALPHAS,
    HORIZONS_H,
    arrival_window,
    cdf,
    exceedance,
    first_crossing_h,
    monotone_in_lead,
    sort_quantiles,
    spot_forecast,
    timing_only_arrival,
)

Q = np.array([-0.4, -0.3, -0.1, 0.0, 0.1, 0.3, 0.4])  # symmetric around 0
T0 = pd.Timestamp("2014-01-05 00:00", tz="UTC")


def test_cdf_hits_alphas_at_quantiles() -> None:
    np.testing.assert_allclose(cdf(np.tile(Q, (7, 1)), Q), ALPHAS)


def test_cdf_interpolates_linearly_inside() -> None:
    # halfway between q25 (-0.1) and q50 (0.0) -> halfway between 0.25 and 0.50
    assert cdf(Q, -0.05) == pytest.approx(0.375)
    assert cdf(Q, 0.2) == pytest.approx(0.825)


def test_cdf_tails_extrapolate_with_outer_slopes_and_clip() -> None:
    # lower slope: 0.20 per 0.3 m (q05 -> q25); 0.15 m below q05 -> 0.05 - 0.1 = -0.05 -> clipped to 0
    assert cdf(Q, -0.475) == pytest.approx(0.0)
    assert cdf(Q, -0.4 - 0.075) == pytest.approx(0.0)
    assert cdf(Q, -0.4 - 0.0375) == pytest.approx(0.025)
    # upper slope: 0.20 per 0.3 m (q75 -> q95)
    assert cdf(Q, 0.4 + 0.0375) == pytest.approx(0.975)
    assert cdf(Q, 5.0) == 1.0
    assert cdf(Q, -5.0) == 0.0


def test_cdf_degenerate_quantiles_step() -> None:
    q = np.zeros(7)
    assert cdf(q, -0.01) == 0.0
    assert cdf(q, 0.0) == pytest.approx(0.95)  # tie takes the highest alpha on the grid
    assert cdf(q, 0.01) == 1.0


def test_cdf_vectorised_and_nan() -> None:
    qs = np.stack([Q, Q + 1.0, np.full(7, np.nan)])
    out = cdf(qs, np.array([0.0, 1.0, 0.0]))
    np.testing.assert_allclose(out[:2], [0.5, 0.5])
    assert np.isnan(out[2])


def test_cdf_unsorted_input_is_sorted() -> None:
    assert cdf(Q[::-1], 0.0) == pytest.approx(0.5)
    np.testing.assert_array_equal(sort_quantiles(Q[::-1]), Q)


def test_exceedance_monotone_in_lead() -> None:
    # spread grows then the centre falls: raw p would drop at the last lead
    qd = np.stack([Q * 0.2, Q * 0.5 + 0.1, Q + 0.3, Q + 0.6, Q + 0.2, Q - 0.5])
    p = exceedance(3.5, qd, 3.79)
    assert np.all(np.diff(p) >= 0)
    raw = 1 - cdf(qd + 3.5, 3.79)
    assert raw[-1] < raw[3]
    assert p[-1] == pytest.approx(raw[3])


def test_monotone_ignores_nan() -> None:
    out = monotone_in_lead(np.array([0.2, np.nan, 0.1, 0.5]))
    assert out[0] == 0.2 and np.isnan(out[1]) and out[2] == 0.2 and out[3] == 0.5


def test_first_crossing_interpolates_and_none() -> None:
    assert first_crossing_h([6, 12], [0.0, 0.2], 0.1) == pytest.approx(9.0)
    assert first_crossing_h([6, 12], [0.2, 0.4], 0.1, v0=0.0) == pytest.approx(3.0)
    assert first_crossing_h([6, 12], [0.0, 0.05], 0.1) is None
    assert first_crossing_h([6, 12], [np.nan, 0.3], 0.1, v0=0.1) == 0.0


def test_arrival_window() -> None:
    p = [0.0, 0.05, 0.2, 0.6, 0.95, 0.99]
    a = arrival_window(T0, HORIZONS_H, p, level_now=3.0, line=3.79)
    # 0.1 between 12 h (0.05) and 24 h (0.2): 12 + 12 * (0.05/0.15) = 16 h
    assert a["p10"] == "2014-01-05T16:00:00Z"
    # 0.5 between 24 h (0.2) and 36 h (0.6): 24 + 12 * 0.75 = 33 h
    assert a["p50"] == "2014-01-06T09:00:00Z"
    # 0.9 between 36 h (0.6) and 48 h (0.95): 36 + 12 * (0.3/0.35)
    assert a["p90"] is not None and a["p90"].startswith("2014-01-06T22:")
    none = arrival_window(T0, HORIZONS_H, [0.0] * 6, level_now=3.0, line=3.79)
    assert none == {"p10": None, "p50": None, "p90": None}
    already = arrival_window(T0, HORIZONS_H, [1.0] * 6, level_now=3.9, line=3.79)
    assert already["p50"] == "2014-01-05T00:00:00Z"
    # above the line now but forecast to fall: the flood has arrived, all three are the issue time (PR #67)
    falling = arrival_window(T0, HORIZONS_H, [0.6, 0.5, 0.3, 0.2, 0.1, 0.1], level_now=3.9, line=3.79)
    assert falling == dict.fromkeys(("p10", "p50", "p90"), "2014-01-05T00:00:00Z")
    # at the line to 3 decimals counts as above (matches the published levelNow)
    assert (
        arrival_window(T0, HORIZONS_H, [0.0] * 6, level_now=3.7896, line=3.79)["p90"]
        == "2014-01-05T00:00:00Z"
    )


def test_spot_forecast_shape_and_probabilities() -> None:
    qd = np.stack([Q * (h / 24) + 0.01 * h for h in HORIZONS_H])
    spot = {"key": "osney", "threshold": 3.79, "amber": 3.18}
    f = spot_forecast(spot, 3.5, qd, T0)
    assert f["spot"] == "osney" and f["mode"] == "probability" and f["levelNow"] == 3.5
    assert [lead["h"] for lead in f["leads"]] == list(HORIZONS_H)
    assert set(f["leads"][0]["q"]) == {"05", "10", "25", "50", "75", "90", "95"}
    pf = [lead["pFlood"] for lead in f["leads"]]
    pa = [lead["pAmber"] for lead in f["leads"]]
    assert all(0 <= x <= 1 for x in pf + pa)
    assert pf == sorted(pf) and pa == sorted(pa)
    assert all(a >= b for a, b in zip(pa, pf, strict=True))  # amber is below the flood line
    assert set(f["arrival"]) == {"p10", "p50", "p90"}


def test_spot_forecast_nan_level_gives_empty_leads() -> None:
    f = spot_forecast({"key": "osney", "threshold": 3.79, "amber": 3.18}, np.nan, np.zeros((6, 7)), T0)
    assert f["leads"] == [] and f["arrival"] is None


def test_timing_only() -> None:
    qd = np.stack([np.full(7, 0.05 * h / 6) for h in HORIZONS_H])  # median rises 5 cm per 6 h
    spot = {"key": "cherwell", "threshold": 2.6, "amber": 2.40, "mode": "timing_only"}
    f = spot_forecast(spot, 2.30, qd, T0)
    assert all(lead["pFlood"] is None for lead in f["leads"])
    assert f["arrival"]["p50"] == "2014-01-05T12:00:00Z"  # +0.10 m at 12 h
    assert f["arrival"]["p10"] is None and f["arrival"]["p90"] is None

    rise = {"t_half": pd.Timestamp("2014-01-04 18:00", tz="UTC"), "p10": 10, "median": 18, "p90": 30}
    a = timing_only_arrival(T0, HORIZONS_H, np.zeros((6, 7)), 2.30, 2.40, rise)
    assert a == {"p10": "2014-01-05T04:00:00Z", "p50": "2014-01-05T12:00:00Z", "p90": "2014-01-06T00:00:00Z"}
    assert timing_only_arrival(T0, HORIZONS_H, np.zeros((6, 7)), 2.30, 2.40) is None
