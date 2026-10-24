"""model/backtest.py: replay forecasts never use data after their issue time (SPEC §8.1, §15.6)."""

from __future__ import annotations

import json

import numpy as np
import pandas as pd
import pytest

from model.backtest import build_replay, crossings, event_window, forecasts_at, load_spots, lofo_models
from model.train import Splits, normalise_hourly, train_gauge
from tests.synth_data import TARGET, make_hourly

SPLITS = Splits(pd.Timestamp("2012-10-01", tz="UTC"), pd.Timestamp("2013-10-01", tz="UTC"))
FAST = {"n_estimators": 30, "early_stopping_rounds": 10}
SPOT = {"key": "botley", "gauge": TARGET, "threshold": 2.2, "amber": 2.01, "mode": "probability"}
EVENT = {"name": "synthetic", "start": "2013-11-01", "end": "2013-11-20"}


@pytest.fixture(scope="module")
def setup() -> tuple[pd.DataFrame, dict]:
    hourly = normalise_hourly(make_hourly())
    m = train_gauge(hourly, TARGET, lags={}, splits=SPLITS, **FAST)
    return hourly, {TARGET: m}


def _perturb_after(hourly: pd.DataFrame, t: pd.Timestamp) -> pd.DataFrame:
    rng = np.random.default_rng(1)
    out = hourly.copy()
    fut = out["ts_utc"] > t
    out.loc[fut, "level_mean"] = rng.normal(5, 2, int(fut.sum()))
    out.loc[fut, "rain_mm"] = rng.uniform(0, 50, int(fut.sum()))
    return out


def test_replay_forecast_uses_no_data_after_issue_time(setup) -> None:
    hourly, models = setup
    times = pd.date_range("2013-11-03", periods=6, freq="17h", tz="UTC")
    full = forecasts_at(hourly, models, [SPOT], times)
    for t, f_full in zip(times, full, strict=True):
        truncated = forecasts_at(hourly[hourly["ts_utc"] <= t], models, [SPOT], [t])[0]
        perturbed = forecasts_at(_perturb_after(hourly, t), models, [SPOT], [t])[0]
        assert truncated == f_full
        assert perturbed == f_full
        assert f_full["spots"][0]["leads"], "forecast should not be empty"


def test_forecast_shape_and_stale(setup) -> None:
    hourly, models = setup
    t = pd.Timestamp("2013-11-05 12:00", tz="UTC")
    gap = hourly[~((hourly["gauge"] == TARGET) & (hourly["ts_utc"] > t - pd.Timedelta(hours=5)))]
    f = forecasts_at(gap, models, [SPOT], [t])[0]
    assert f["issuedAt"] == "2013-11-05T12:00:00Z"
    assert TARGET in f["stale"]
    assert f["spots"][0]["leads"] == []  # stale gauge -> no forecast (SPEC §10.1)
    assert f["dataAsOf"][TARGET] == "2013-11-05T07:00:00Z"
    ok = forecasts_at(hourly, models, [SPOT], [t])[0]
    sp = ok["spots"][0]
    assert [x["h"] for x in sp["leads"]] == [6, 12, 24, 36, 48, 72]
    assert set(sp["arrival"]) == {"p10", "p50", "p90"}


def test_crossings() -> None:
    idx = pd.date_range("2014-01-01", periods=10, freq="h", tz="UTC")
    lv = [1, 2.8, 2.9, 2.5, 2.7, 2.9, 1, 1, 1, 1]
    hourly = pd.DataFrame({"gauge": TARGET, "ts_utc": idx, "level_mean": lv})
    out = crossings(hourly, [SPOT | {"threshold": 2.76}], idx[0], idx[-1])
    assert [c["t"] for c in out] == ["2014-01-01T01:00:00Z", "2014-01-01T05:00:00Z"]
    # already above at the window start is not a crossing
    assert crossings(hourly, [SPOT | {"threshold": 2.76}], idx[2], idx[-1])[0]["t"] == "2014-01-01T05:00:00Z"


def test_build_replay_lofo_and_contract(setup, tmp_path) -> None:
    hourly, _ = setup
    models = lofo_models(
        hourly, "esynth", EVENT, [TARGET], lags={}, cache_dir=tmp_path, splits=SPLITS, **FAST
    )
    m = models[TARGET]
    start, end = event_window(EVENT)
    assert m.excluded == [
        (
            (start - pd.Timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%SZ"),
            (end + pd.Timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%SZ"),
        )
    ]
    assert (
        lofo_models(hourly, "esynth", EVENT, [TARGET], lags={}, cache_dir=tmp_path)[TARGET].excluded
        == m.excluded
    )
    replay = build_replay(hourly, models, "esynth", EVENT, [SPOT])
    assert set(replay) == {
        "eventId",
        "name",
        "start",
        "end",
        "observed",
        "forecasts",
        "official",
        "crossings",
    }
    assert replay["end"] == "2013-11-20T23:00:00Z"
    assert len(replay["forecasts"]) == 20 * 24
    assert set(replay["observed"]) >= {TARGET, "farmoor"}
    json.dumps(replay, allow_nan=False)  # strict JSON: no NaN anywhere
    thin = build_replay(hourly, models, "esynth", EVENT, [SPOT], every_h=3)
    assert len(thin["forecasts"]) == 20 * 24 // 3 and thin["observed"] == replay["observed"]


def test_load_spots_modes() -> None:
    spots = {s["key"]: s for s in load_spots()}
    assert spots["botley"]["gauge"] == "newbotley" and spots["botley"]["mode"] == "probability"
    assert spots["botley"]["threshold"] == 2.76 and spots["botley"]["amber"] == 2.01
    assert spots["wolvercote"]["mode"] == "timing_only"
    assert spots["cherwell"]["gauge"] == "kingsmill"
