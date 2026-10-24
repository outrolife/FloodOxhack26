"""Tests for analysis/upstream_experiment.py (#125 A): the new upstream features see no future data,
and the extended upstream map never leaks into the shipped default. Synthetic data only."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from analysis import upstream_experiment as ue
from model import features

START = pd.Timestamp("2026-09-01 00:00", tz="UTC")
N_HOURS = 40 * 24
LAGS = {
    "shifford->newbotley": {"lag_lo": 20, "lag_main": 40, "lag_hi": 70},
    "banbury->kingsmill": {"lag_lo": 30, "lag_main": 45, "lag_hi": 60},
}


def make_hourly(seed: int = 0) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    ts = pd.date_range(START, periods=N_HOURS, freq="h", tz="UTC")
    gauges = [
        "farmoor",
        "eynsham",
        "cassington",
        "newbotley",
        "minns",
        "coldharbour",
        "enslow",
        "islip",
        "kingsmill",
        *ue.NEW_GAUGES,
    ]
    rows = []
    for i, g in enumerate(gauges):
        level = 1.0 + i + np.cumsum(rng.normal(0, 0.01, N_HOURS))
        rows.append(
            pd.DataFrame({"gauge": g, "ts_utc": ts, "kind": "level", "level_mean": level, "rain_mm": np.nan})
        )
    rain = rng.gamma(0.3, 1.0, N_HOURS) * (rng.random(N_HOURS) < 0.3)
    rows.append(
        pd.DataFrame(
            {"gauge": features.RAIN_KEY, "ts_utc": ts, "kind": "rain", "level_mean": np.nan, "rain_mm": rain}
        )
    )
    df = pd.concat(rows, ignore_index=True)
    df["level_max"] = df["level_mean"]
    df["filled"] = False
    df["flagged"] = False
    keep = rng.random(len(df)) >= 0.03
    return df[keep].reset_index(drop=True)


def perturb_after(df: pd.DataFrame, cut: pd.Timestamp, seed: int) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    out = df.copy()
    future = out["ts_utc"] > cut
    lv = future & out["kind"].eq("level")
    out.loc[lv, "level_mean"] = rng.normal(50, 20, int(lv.sum()))
    rn = future & out["kind"].eq("rain")
    out.loc[rn, "rain_mm"] = rng.uniform(0, 100, int(rn.sum()))
    return out[~(future & (rng.random(len(out)) < 0.2))].reset_index(drop=True)


def _build(hourly: pd.DataFrame, target: str, cut: pd.Timestamp) -> pd.DataFrame:
    with ue.extended_upstreams(ue.extended_map()):
        med = features.compute_gauge_medians(hourly, cut, gauges=features.UPSTREAMS[target])
        return features.build_features(hourly, target, med, LAGS)


@pytest.mark.parametrize("target", ["newbotley", "kingsmill"])
def test_new_upstream_features_do_not_see_the_future(target: str) -> None:
    hourly = make_hourly(seed=1)
    rng = np.random.default_rng(7)
    new_cols = None
    for i, h in enumerate(rng.integers(30, N_HOURS - 30, size=5)):
        cut = START + pd.Timedelta(hours=int(h))
        base = _build(hourly, target, cut)
        new_cols = [c for c in base.columns if c.split("_")[0] in ue.NEW_GAUGES]
        assert new_cols, "the extended map must add columns for the new gauges"
        changed = _build(perturb_after(hourly, cut, seed=100 + i), target, cut)
        pd.testing.assert_frame_equal(base.loc[:cut], changed.loc[:cut], check_exact=True)
        truncated = _build(hourly[hourly["ts_utc"] <= cut], target, cut)
        pd.testing.assert_frame_equal(base.loc[:cut], truncated.loc[:cut], check_exact=True)
        assert not base.loc[cut:, new_cols].iloc[1:].equals(changed.loc[cut:, new_cols].iloc[1:])


def test_travel_lags_used_and_capped() -> None:
    hourly = make_hourly(seed=2)
    X = _build(hourly, "newbotley", START + pd.Timedelta(days=30))
    for k in (0, 6, 12, 24, 20, 40, 70):
        assert f"shifford_anom_lag{k}h" in X.columns
    lags = {"buscot->newbotley": {"lag_lo": 10, "lag_main": 200, "lag_hi": 900}}
    assert max(features.upstream_lags_h("buscot", "newbotley", lags)) == features.MAX_WINDOW_H


def test_anomaly_lag_is_value_at_t_minus_lag() -> None:
    hourly = make_hourly(seed=3)
    cut = START + pd.Timedelta(days=30)
    X = _build(hourly, "newbotley", cut)
    with ue.extended_upstreams(ue.extended_map()):
        med = features.compute_gauge_medians(hourly, cut, gauges=features.UPSTREAMS["newbotley"])
    lv = features.pivot_hourly(hourly[hourly["kind"] == "level"])["shifford"]
    t = START + pd.Timedelta(days=20)
    assert X.loc[t, "shifford_anom_lag40h"] == pytest.approx(
        lv.loc[t - pd.Timedelta(hours=40)] - med["shifford"]
    )


def test_default_upstreams_unchanged_outside_the_block() -> None:
    before = dict(features.UPSTREAMS)
    with ue.extended_upstreams(ue.extended_map()):
        assert "shifford" in features.UPSTREAMS["newbotley"]
    assert features.UPSTREAMS == before
    assert not any(g in ue.NEW_GAUGES for ups in features.UPSTREAMS.values() for g in ups)
    with pytest.raises(RuntimeError), ue.extended_upstreams(ue.extended_map()):
        raise RuntimeError
    assert features.UPSTREAMS == before


def test_extended_map_keeps_current_gauges_first() -> None:
    ext = ue.extended_map()
    for t, ups in features.UPSTREAMS.items():
        assert ext[t][: len(ups)] == tuple(ups)
    assert set(ext["kingsmill"]) >= {"enslow", "islip", *ue.CHOSEN["cherwell"]}
