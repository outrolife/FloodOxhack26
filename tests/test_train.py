"""model/train.py: exact §7.3 params, splits, weights, persistence baseline, train loop on synthetic data."""

from __future__ import annotations

import json

import numpy as np
import pandas as pd
import pytest

from model.probability import ALPHAS, HORIZONS_H
from model.train import (
    DEFAULT_SPLITS,
    EARLY_STOPPING_ROUNDS,
    LGB_PARAMS,
    N_ESTIMATORS,
    GaugeModel,
    Splits,
    choose_splits,
    load_lags,
    normalise_hourly,
    pinball,
    sample_weights,
    train_gauge,
    weighted_quantiles,
    write_importance,
)
from tests.synth_data import make_hourly

SPLITS = Splits(pd.Timestamp("2012-10-01", tz="UTC"), pd.Timestamp("2013-10-01", tz="UTC"))
FAST = {"n_estimators": 60, "early_stopping_rounds": 10}


def test_params_are_exactly_spec_7_3() -> None:
    expected = {
        "objective": "quantile",
        "num_leaves": 31,
        "learning_rate": 0.05,
        "min_data_in_leaf": 50,
        "feature_fraction": 0.8,
        "bagging_fraction": 0.8,
        "bagging_freq": 1,
        "seed": 42,
    }
    assert {k: LGB_PARAMS[k] for k in expected} == expected
    assert N_ESTIMATORS == 2000 and EARLY_STOPPING_ROUNDS == 100
    assert ALPHAS == (0.05, 0.10, 0.25, 0.50, 0.75, 0.90, 0.95)
    assert HORIZONS_H == (6, 12, 24, 36, 48, 72)


def test_sample_weights() -> None:
    w = sample_weights(np.array([2.0, 2.88, 2.881, 3.5, np.nan]), amber=3.18)
    np.testing.assert_array_equal(w, [1, 1, 5, 5, 1])


def test_default_and_shifted_splits() -> None:
    assert DEFAULT_SPLITS.val_start == pd.Timestamp("2018-10-01", tz="UTC")
    assert DEFAULT_SPLITS.test_start == pd.Timestamp("2021-10-01", tz="UTC")
    assert choose_splits(pd.Timestamp("2006-03-01", tz="UTC"), pd.Timestamp("2026-10-01", tz="UTC")) == DEFAULT_SPLITS
    # 2011-10 .. 2026-09: 15 seasons -> 9 train, 3 val, 3 test
    s = choose_splits(pd.Timestamp("2011-10-01", tz="UTC"), pd.Timestamp("2026-09-30", tz="UTC"))
    assert s.val_start == pd.Timestamp("2020-10-01", tz="UTC")
    assert s.test_start == pd.Timestamp("2023-10-01", tz="UTC")


def test_split_masks_purge_targets_crossing_the_boundary() -> None:
    idx = pd.date_range("2018-09-29", "2018-10-02", freq="h", tz="UTC")
    tr, va, te = DEFAULT_SPLITS.masks(idx, h=24)
    last_train = idx[tr][-1]
    assert last_train + pd.Timedelta(hours=24) < DEFAULT_SPLITS.val_start
    assert last_train == pd.Timestamp("2018-09-29 23:00", tz="UTC")
    assert idx[va][0] == DEFAULT_SPLITS.val_start
    assert not (tr & va).any() and not te.any()


def test_weighted_quantiles_and_pinball() -> None:
    v = np.arange(100, dtype=float)
    np.testing.assert_allclose(weighted_quantiles(v, np.ones(100), [0.5]), [49.5])
    w = np.where(v >= 50, 3.0, 1.0)
    assert weighted_quantiles(v, w, [0.5])[0] > 55
    q = np.tile([-1, -0.5, -0.2, 0, 0.2, 0.5, 1.0], (3, 1))
    assert pinball(q, np.zeros(3)) == pytest.approx(np.mean([0.05, 0.05, 0.05, 0, 0.05, 0.05, 0.05]))


def test_normalise_hourly_adds_catchment_rain() -> None:
    df = make_hourly(years=0.1)
    out = normalise_hourly(df)
    rain = out[out["gauge"] == "rain_catchment"].set_index("ts_utc")["rain_mm"]
    raw = df[df["kind"] == "rain"].groupby("ts_utc")["rain_mm"].mean()
    pd.testing.assert_series_equal(rain, raw, check_names=False)
    assert not out["gauge"].isin(["256230TP", "254336TP"]).any()


def test_load_lags_both_shapes(tmp_path) -> None:
    p = tmp_path / "lags.json"
    p.write_text(json.dumps({"pairs": [{"up": "farmoor", "down": "osney", "lag_lo": 10, "lag_main": 18,
                                        "lag_hi": 30, "source": "events"}]}))
    assert load_lags(p) == {"farmoor->osney": {"lag_lo": 10, "lag_main": 18, "lag_hi": 30}}
    p.write_text(json.dumps({"farmoor->osney": {"lag_lo": 10.4, "lag_main": 18, "lag_hi": 30}}))
    assert load_lags(p)["farmoor->osney"]["lag_lo"] == 10
    assert load_lags(tmp_path / "missing.json") == {}


@pytest.fixture(scope="module")
def trained() -> tuple[GaugeModel, pd.DataFrame]:
    hourly = normalise_hourly(make_hourly())
    m = train_gauge(hourly, "osney", lags={"farmoor->osney": {"lag_lo": 24, "lag_main": 30, "lag_hi": 36}},
                    splits=SPLITS, **FAST)
    return m, hourly


def test_train_loop_shapes_and_calibration(trained) -> None:
    m, _ = trained
    assert m.horizons == list(HORIZONS_H)
    assert all(set(b) == set(ALPHAS) for b in m.boosters.values())
    for h in HORIZONS_H:
        assert set(m.cqr[h]) == {"05-95", "10-90", "25-75"}
        assert np.all(np.diff(m.persistence_eps[h]) >= 0)
        assert m.info["leads"][str(h)]["nCal"] > 0
    assert "farmoor_anom_lag30h" in m.feature_cols
    assert set(m.medians) == {"farmoor", "eynsham", "cassington", "godstow"}


def test_predictions_sorted_and_beat_persistence(trained) -> None:
    from model.train import build_xy

    m, hourly = trained
    X, Y = build_xy(hourly, "osney", m.medians, m.lags)
    _, _, te = m.splits.masks(X.index, 24)
    q = m.predict(X[te])
    for h in HORIZONS_H:
        assert np.all(np.diff(q[h], axis=1) >= 0)
    y = Y.loc[te, "y_24h"].to_numpy()
    model_loss = pinball(q[24], y)
    pers_loss = pinball(m.persistence(int(te.sum()))[24], y)
    assert model_loss < pers_loss  # upstream gauges carry the signal in this synthetic river


def test_save_load_roundtrip(trained, tmp_path) -> None:
    from model.train import build_xy

    m, hourly = trained
    m.save(tmp_path / "osney")
    m2 = GaugeModel.load(tmp_path / "osney")
    X, _ = build_xy(hourly, "osney", m.medians, m.lags)
    sample = X.iloc[-500:]
    a, b = m.predict(sample), m2.predict(sample)
    for h in HORIZONS_H:
        np.testing.assert_allclose(a[h], b[h])
    assert m2.cqr == m.cqr and m2.splits == m.splits
    path = write_importance([m2], tmp_path / "importance.json")
    imp = json.loads(path.read_text())["osney"]
    assert [x["h"] for x in imp] == list(HORIZONS_H)
    assert sum(f["gain"] for f in imp[0]["features"]) == pytest.approx(1.0, abs=1e-3)


def test_exclude_windows_drop_rows(trained) -> None:
    m, hourly = trained
    win = (pd.Timestamp("2011-01-01", tz="UTC"), pd.Timestamp("2011-06-30", tz="UTC"))
    m2 = train_gauge(hourly, "osney", lags=m.lags, splits=SPLITS, exclude_windows=[win], horizons=(6,), **FAST)
    assert m2.info["leads"]["6"]["nTrain"] < m.info["leads"]["6"]["nTrain"] - 4000
    assert m2.excluded == [("2011-01-01T00:00:00Z", "2011-06-30T00:00:00Z")]
