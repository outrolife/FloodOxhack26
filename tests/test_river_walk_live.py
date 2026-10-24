"""Live path for the river walk (#125 A, PM condition 2): the new upstream gauges in live mode.

newbotley and minns read four more upstream gauges (shifford, hannington, worsham, shipton). If one of
them is stale (> 3 h, or missing), those two spots fall back to labelled persistence; coldharbour and
kingsmill, which do not read it, keep their model forecast unchanged. No network: a fake EA.
"""

from __future__ import annotations

from datetime import timedelta
from pathlib import Path

import pandas as pd
import pytest

from model import features
from model import forecast_live as fl
from pipeline import ingest_live as il
from tests.test_live import FakeEA, _tiny_model
from tests.test_live_hardening import T0, OddEA, check_contract, ingest

WALK_NEW = ("shifford", "hannington", "worsham", "shipton")
SPOT_OF = {"newbotley": "botley", "minns": "osney", "coldharbour": "abingdonrd", "kingsmill": "cherwell"}


@pytest.fixture(scope="module")
def forecaster(tmp_path_factory: pytest.TempPathFactory) -> fl.TrainedForecaster:
    d = tmp_path_factory.mktemp("walk_models")
    for target in SPOT_OF:
        _tiny_model(target).save(d / target)
    fc = fl.load_model_forecaster(d)
    assert fc is not None
    return fc


def _spot(fc: dict, key: str) -> dict:
    return next(s for s in fc["spots"] if s["spot"] == key)


def test_live_ingest_fetches_the_new_upstream_gauges(tmp_path: Path) -> None:
    for g in WALK_NEW:
        assert g in il.LEVEL_MEASURES  # polled every 15 min with the others
    hourly, meta = ingest(tmp_path, FakeEA(T0 - timedelta(minutes=15), hours=24 * 28), T0)
    assert set(WALK_NEW) <= set(meta["gauges"]) and set(WALK_NEW) <= set(hourly["gauge"])


def test_models_read_the_walk_and_spots_depend_on_it(forecaster: fl.TrainedForecaster) -> None:
    for target in ("newbotley", "minns"):
        assert forecaster.upstreams[target] == list(features.UPSTREAMS[target])
        assert set(WALK_NEW) <= set(forecaster.upstreams[target])
    assert not set(WALK_NEW) & set(forecaster.upstreams["coldharbour"])
    assert not set(WALK_NEW) & set(forecaster.upstreams["kingsmill"])


def test_fresh_walk_gives_model_forecasts_with_no_gap(tmp_path: Path, forecaster: fl.TrainedForecaster) -> None:
    hourly, meta = ingest(tmp_path, FakeEA(T0 - timedelta(minutes=15), hours=24 * 28), T0)
    fc = fl.build_forecast(hourly, meta, T0, forecaster=forecaster)
    check_contract(fc)
    assert fc["stale"] == [] and fc["method"] == "model" and fc["note"] == ""
    X = forecaster.features_at(hourly, "newbotley", T0)
    assert X is not None and not X.isna().any(axis=None)  # shifford ... shipton columns all present
    assert any(c.startswith("shipton_anom_lag") for c in X.columns)


@pytest.mark.parametrize("how", ["old", "missing"])
def test_stale_shifford_sends_botley_and_minns_to_persistence_only(
    tmp_path: Path, forecaster: fl.TrainedForecaster, how: str
) -> None:
    """Shifford 5 h old (or never answering): Botley and Osney (minns) get labelled persistence;
    Abingdon Rd (coldharbour) and Cherwell (kingsmill) keep exactly their model forecast."""
    fresh_h, fresh_m = ingest(tmp_path / "fresh", FakeEA(T0 - timedelta(minutes=15), hours=24 * 28), T0)
    fresh = fl.build_forecast(fresh_h, fresh_m, T0, forecaster=forecaster)

    if how == "old":
        ea = OddEA(T0 - timedelta(minutes=15), {"shifford": FakeEA(T0 - timedelta(hours=5), hours=24 * 28)}, 24 * 28)
    else:
        ea = FakeEA(T0 - timedelta(minutes=15), hours=24 * 28, missing={il.LEVEL_MEASURES["shifford"]})
    hourly, meta = ingest(tmp_path / "stale", ea, T0)
    fc = fl.build_forecast(hourly, meta, T0, forecaster=forecaster)
    check_contract(fc)
    assert fc["stale"] == ["shifford"] and fc["method"] == "model"

    persistence = fl.PersistenceForecaster()
    for target in ("newbotley", "minns"):
        spot = _spot(fc, SPOT_OF[target])
        assert spot["leads"], f"{target}: persistence, not blank"
        deltas = persistence.predict(hourly, target, T0)
        base = persistence.base_level(hourly, target, T0) or spot["levelNow"]
        assert spot["leads"][0]["q"]["50"] == pytest.approx(base + deltas[6]["50"], abs=1e-3)
        assert spot["leads"] != _spot(fresh, SPOT_OF[target])["leads"]
    for name in ("Botley Road / New Botley / Hinksey", "Osney Island / Binsey"):
        assert f"Persistence fallback for {name}: no reading for over 3 hours from Shifford upstream" in fc["note"]
    for target in ("coldharbour", "kingsmill"):
        assert _spot(fc, SPOT_OF[target]) == _spot(fresh, SPOT_OF[target])  # unaffected
    assert "Abingdon" not in fc["note"] and "Cherwell" not in fc["note"]


def test_stale_target_gauge_still_blanks_its_spot(tmp_path: Path, forecaster: fl.TrainedForecaster) -> None:
    """The spot's own gauge stale: no forecast at all (SPEC §10.1), even with the upstreams fresh."""
    ea = OddEA(T0 - timedelta(minutes=15), {"newbotley": FakeEA(T0 - timedelta(hours=5), hours=24 * 28)}, 24 * 28)
    hourly, meta = ingest(tmp_path, ea, T0)
    fc = fl.build_forecast(hourly, meta, T0, forecaster=forecaster)
    assert fc["stale"] == ["newbotley"]
    assert _spot(fc, "botley")["leads"] == [] and _spot(fc, "botley")["arrival"] is None
    assert _spot(fc, "osney")["leads"]


def test_walk_features_at_t_ignore_live_data_after_t(tmp_path: Path, forecaster: fl.TrainedForecaster) -> None:
    """Live rows after the anchor hour (later readings of the new gauges) never change the forecast."""
    hourly, meta = ingest(tmp_path, FakeEA(T0 - timedelta(minutes=15), hours=24 * 28), T0)
    anchor = fl.last_complete_hour(T0)
    later = hourly[hourly["ts_utc"] > anchor - pd.Timedelta(hours=1)].copy()
    later = later[later["gauge"].isin(WALK_NEW)]
    later["ts_utc"] = later["ts_utc"] + pd.Timedelta(hours=3)
    later["level_mean"] = later["level_mean"] + 5.0  # a huge future flood upstream
    bumped = pd.concat([hourly, later], ignore_index=True)
    for target in ("newbotley", "minns"):
        a = forecaster.features_at(hourly, target, T0)
        b = forecaster.features_at(bumped, target, T0)
        pd.testing.assert_frame_equal(a, b)
