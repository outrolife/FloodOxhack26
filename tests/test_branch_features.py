"""Branch signals (issue #134 A-branch): no future data, the right lag direction, existing columns
unchanged. Synthetic data only (seeded); no network, no data files."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from model import features
from model.features import (
    BRANCH_SCALE_M,
    BRANCHES,
    MAX_WINDOW_H,
    branch_shifts,
    branch_travel,
    build_features,
    compute_gauge_medians,
    feature_columns,
    input_gauges,
)

START = pd.Timestamp("2026-09-01 00:00", tz="UTC")
N_HOURS = 40 * 24
GAUGES = [
    "farmoor", "eynsham", "cassington", "coldharbour",
    "enslow", "islip", "kingsmill",
    "hannington", "shifford", "worsham", "shipton", "banbury", "lowerarncott",
]  # fmt: skip
LAGS = {
    "hannington->coldharbour": {"lag_lo": 29, "lag_main": 40, "lag_hi": 69},
    "shifford->coldharbour": {"lag_lo": 4, "lag_main": 29, "lag_hi": 91},
    "worsham->coldharbour": {"lag_lo": 28, "lag_main": 45, "lag_hi": 82},
    "shipton->coldharbour": {"lag_lo": 37, "lag_main": 76, "lag_hi": 109},
    "banbury->kingsmill": {"lag_lo": 31, "lag_main": 37, "lag_hi": 45},
    "lowerarncott->kingsmill": {"lag_lo": 13, "lag_main": 39, "lag_hi": 89},
    "farmoor->coldharbour": {"lag_lo": 7, "lag_main": 23, "lag_hi": 41},
}


def make_hourly(seed: int = 0, drop_frac: float = 0.02) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    ts = pd.date_range(START, periods=N_HOURS, freq="h", tz="UTC")
    rows = []
    for i, g in enumerate(GAUGES):
        level = 1.0 + i + np.cumsum(rng.normal(0, 0.01, N_HOURS))  # each gauge its own datum
        rows.append(pd.DataFrame({"gauge": g, "ts_utc": ts, "kind": "level", "level_mean": level}))
    rain = rng.gamma(0.3, 1.0, N_HOURS) * (rng.random(N_HOURS) < 0.3)
    rows.append(pd.DataFrame({"gauge": features.RAIN_KEY, "ts_utc": ts, "kind": "rain", "rain_mm": rain}))
    df = pd.concat(rows, ignore_index=True)
    df["level_max"] = df["level_mean"]
    df["filled"] = False
    df["flagged"] = False
    keep = rng.random(len(df)) >= drop_frac
    return df[keep].reset_index(drop=True)


def perturb_after(df: pd.DataFrame, cut: pd.Timestamp, seed: int) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    out = df.copy()
    future = out["ts_utc"] > cut
    lev = future & out["level_mean"].notna()
    out.loc[lev, "level_mean"] = rng.normal(50, 20, int(lev.sum()))
    rain = future & out["rain_mm"].notna()
    out.loc[rain, "rain_mm"] = rng.uniform(0, 100, int(rain.sum()))
    return out[~(future & (rng.random(len(out)) < 0.2))].reset_index(drop=True)


@pytest.fixture(params=["routed", "front"])
def align(request, monkeypatch) -> str:
    monkeypatch.setattr(features, "BRANCH_ALIGN", request.param)
    return request.param


@pytest.mark.parametrize("target", ["coldharbour", "kingsmill"])
def test_branch_features_do_not_see_the_future(target: str, align: str) -> None:
    hourly = make_hourly(seed=1)
    rng = np.random.default_rng(7)
    for i, h in enumerate(rng.integers(150, N_HOURS - 30, size=4)):
        cut = START + pd.Timedelta(hours=int(h))
        base = build_features(hourly, target, compute_gauge_medians(hourly, cut), LAGS)
        changed = perturb_after(hourly, cut, seed=50 + i)
        feats = build_features(changed, target, compute_gauge_medians(changed, cut), LAGS)
        br = [c for c in base.columns if c.startswith("br_")]
        assert br
        pd.testing.assert_frame_equal(base.loc[:cut], feats.loc[:cut], check_exact=True)
        truncated = hourly[hourly["ts_utc"] <= cut]
        pd.testing.assert_frame_equal(
            base.loc[:cut],
            build_features(truncated, target, compute_gauge_medians(truncated, cut), LAGS),
            check_exact=True,
        )


def test_branch_columns_and_counts() -> None:
    base = feature_columns("minns", LAGS)
    assert not any(c.startswith("br_") for c in base)  # newbotley/minns: no branch columns
    cold = [c for c in feature_columns("coldharbour", LAGS) if c.startswith("br_")]
    king = [c for c in feature_columns("kingsmill", LAGS) if c.startswith("br_")]
    assert cold == [f"br_{b}_{k}" for b in ("thamesup", "windrush", "evenlode") for k in ("routed", "max")]
    assert king == ["br_cherwellup_routed", "br_ray_routed"]
    assert set(input_gauges("coldharbour")) == {"farmoor", "eynsham", "cassington", *BRANCH_SCALE_M} - {
        "banbury",
        "lowerarncott",
    }
    assert input_gauges("kingsmill") == ("enslow", "islip", "banbury", "lowerarncott")


@pytest.mark.parametrize("target", ["coldharbour", "kingsmill"])
def test_existing_columns_unchanged(target: str, monkeypatch) -> None:
    hourly = make_hourly(seed=3)
    med = compute_gauge_medians(hourly, START + pd.Timedelta(days=15))
    with_br = build_features(hourly, target, med, LAGS)
    monkeypatch.setattr(features, "BRANCHES", {})
    without = build_features(hourly, target, med, LAGS)
    assert list(with_br.columns[: without.shape[1]]) == list(without.columns)
    pd.testing.assert_frame_equal(with_br[without.columns], without, check_exact=True)


def test_routed_signal_is_the_anomaly_travel_time_ago() -> None:
    """br_<b>_routed(t) = mean of z_g(t - lag_main): the lag looks back, never forward."""
    hourly = make_hourly(seed=4, drop_frac=0.0)
    med = compute_gauge_medians(hourly, START + pd.Timedelta(days=15))
    X = build_features(hourly, "coldharbour", med, LAGS)
    lv = hourly.pivot(index="ts_utc", columns="gauge", values="level_mean")

    def z(g: str, t: pd.Timestamp) -> float:
        return (lv.loc[t, g] - med[g]) / BRANCH_SCALE_M[g]

    for h in (300, 555, 800):
        t = START + pd.Timedelta(hours=h)
        np.testing.assert_allclose(X.loc[t, "br_windrush_routed"], z("worsham", t - pd.Timedelta(hours=45)))
        exp = np.mean(
            [z("hannington", t - pd.Timedelta(hours=40)), z("shifford", t - pd.Timedelta(hours=29))]
        )
        np.testing.assert_allclose(X.loc[t, "br_thamesup_routed"], exp)
        win = [z("shipton", t - pd.Timedelta(hours=k)) for k in range(37, 110)]
        np.testing.assert_allclose(X.loc[t, "br_evenlode_max"], max(win))


def test_spike_appears_after_the_travel_time_not_before() -> None:
    hourly = make_hourly(seed=5, drop_frac=0.0)
    spike_t = START + pd.Timedelta(hours=500)
    m = (hourly["gauge"] == "banbury") & (hourly["ts_utc"] == spike_t)
    hourly.loc[m, "level_mean"] += 100.0
    med = compute_gauge_medians(hourly, START + pd.Timedelta(days=15))
    s = build_features(hourly, "kingsmill", med, LAGS)["br_cherwellup_routed"]
    jump = s.diff().abs()
    assert jump.idxmax() == spike_t + pd.Timedelta(hours=37)
    assert (s.loc[: spike_t + pd.Timedelta(hours=36)].dropna() < 50).all()


def test_front_alignment_shifts_from_the_fastest_gauge(monkeypatch) -> None:
    monkeypatch.setattr(features, "BRANCH_ALIGN", "front")
    sh = branch_shifts("coldharbour", "thamesup", LAGS)
    assert sh["shifford"] == (0, 87, 0)  # fastest: lag 0, window [t - (91 - 4), t]
    assert sh["hannington"] == (11, 40 + 11, 11)
    assert all(v >= 0 for vals in sh.values() for v in vals)


def test_missing_pair_and_missing_median() -> None:
    assert branch_travel("worsham", "coldharbour", None) == {"lag_lo": 0, "lag_main": 0, "lag_hi": 24}
    big = {"shipton->coldharbour": {"lag_lo": 900, "lag_main": 950, "lag_hi": 999}}
    assert set(branch_travel("shipton", "coldharbour", big).values()) == {MAX_WINDOW_H}
    # A model trained before #134 has no medians for the branch gauges: NaN columns, no error.
    hourly = make_hourly(seed=6)
    med = compute_gauge_medians(hourly, START + pd.Timedelta(days=15), gauges=["enslow", "islip"])
    X = build_features(hourly, "kingsmill", med, LAGS)
    assert X["br_ray_routed"].isna().all()
    assert X["enslow_anom_lag0h"].notna().any()


def test_branch_gauges_are_configured() -> None:
    assert set(BRANCH_SCALE_M) == {g for bs in BRANCHES.values() for gs in bs.values() for g in gs}
    assert all(v > 0 for v in BRANCH_SCALE_M.values())
