"""Guards for the river-walk change (#155 review): stale saved models and incomplete inputs never pass
silently, and old-style 3-gauge models keep working in live mode."""

from __future__ import annotations

from datetime import timedelta
from pathlib import Path

import pandas as pd
import pytest

from model import backtest, features, proof, train
from model import forecast_live as fl
from tests.test_features import START, make_hourly
from tests.test_live import FakeEA, _tiny_model
from tests.test_live_hardening import T0, OddEA, ingest

NEAR = ("farmoor", "eynsham", "cassington")
WALK = features.UPSTREAMS["newbotley"]


def _all_lags(lo: int = 1, main: int = 5, hi: int = 9) -> dict[str, dict[str, int]]:
    return {
        f"{up}->{t}": {"lag_lo": lo, "lag_main": main, "lag_hi": hi}
        for t, ups in features.UPSTREAMS.items()
        for up in ups
    }


# ---------------------------------------------------------------------------------------------
# 1. Cached leave-one-out models from before the walk are retrained, current ones reused
# ---------------------------------------------------------------------------------------------


def test_stale_cached_lofo_model_is_retrained(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    old = _tiny_model("newbotley", NEAR)
    old.save(tmp_path / "newbotley")
    assert not train.is_current(old, {})
    fresh = _tiny_model("newbotley")
    assert train.is_current(fresh, {})
    calls: list[str] = []

    def fake_train(hourly, target, **kw):  # noqa: ANN001, ANN202
        calls.append(target)
        return fresh

    monkeypatch.setattr(backtest, "train_gauge", fake_train)
    event = {"start": "2026-09-10", "end": "2026-09-12"}
    out = backtest.lofo_models(pd.DataFrame(), "esynth", event, ["newbotley"], {}, cache_dir=tmp_path)
    assert calls == ["newbotley"] and out["newbotley"].upstreams == list(WALK)
    # The retrained model was cached; a second call reuses it without training.
    out = backtest.lofo_models(pd.DataFrame(), "esynth", event, ["newbotley"], {}, cache_dir=tmp_path)
    assert calls == ["newbotley"] and out["newbotley"].feature_cols == fresh.feature_cols


def test_stale_main_model_is_refused_by_proof(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _tiny_model("newbotley", NEAR).save(tmp_path / "newbotley")
    monkeypatch.setattr(proof, "MODELS_DIR", tmp_path)
    with pytest.raises(SystemExit, match="make train"):
        proof.main_models(pd.DataFrame(), ["newbotley"], {})
    _tiny_model("newbotley").save(tmp_path / "newbotley")
    assert proof.main_models(pd.DataFrame(), ["newbotley"], {})["newbotley"].upstreams == list(WALK)


# ---------------------------------------------------------------------------------------------
# 2. make train refuses v1 data (no walk gauges) or a lags.json without the walk pairs
# ---------------------------------------------------------------------------------------------


def _long_hourly(drop: tuple[str, ...] = ()) -> pd.DataFrame:
    """Synthetic hourly frame with rows before the default validation start (2018-10-01)."""
    h = make_hourly(seed=3, drop_frac=0.0, fmt="final")
    h = h.assign(ts_utc=h["ts_utc"] - (START - pd.Timestamp("2018-01-01", tz="UTC")))
    return h[~h["gauge"].isin(drop)]


def test_walk_input_problems_names_missing_gauges_and_pairs() -> None:
    lags = _all_lags()
    assert train.walk_input_problems(_long_hourly(), ["newbotley", "minns"], lags) == []
    v1 = _long_hourly(drop=("shifford", "hannington", "worsham", "shipton"))
    probs = train.walk_input_problems(v1, ["newbotley"], lags)
    assert len(probs) == 1 and "shifford" in probs[0] and "shipton" in probs[0]
    old_lags = {k: v for k, v in lags.items() if not k.startswith(("shifford", "hannington"))}
    probs = train.walk_input_problems(_long_hourly(), ["minns"], old_lags)
    assert probs == ["minns: lags.json has no pair for ['shifford->minns', 'hannington->minns']"]


def test_train_main_refuses_incomplete_inputs(monkeypatch: pytest.MonkeyPatch) -> None:
    v1 = _long_hourly(drop=("shifford",))
    monkeypatch.setattr(train, "load_hourly", lambda path=None: v1)
    monkeypatch.setattr(train, "load_lags", lambda path=None: _all_lags())
    monkeypatch.setattr(train, "train_gauge", lambda *a, **k: pytest.fail("must not train"))
    with pytest.raises(SystemExit, match="data-hourly-v2"):
        train.main(["--targets", "newbotley", "--no-importance"])


def test_missing_pair_warns(caplog: pytest.LogCaptureFixture) -> None:
    features._WARNED_PAIRS.discard("shipton->newbotley")
    lags = {k: v for k, v in _all_lags().items() if k != "shipton->newbotley"}
    with caplog.at_level("WARNING", logger="model.features"):
        assert features.upstream_lags_h("shipton", "newbotley", lags) == list(features.UPSTREAM_FIXED_LAGS_H)
    assert "shipton->newbotley missing from lags.json" in caplog.text


# ---------------------------------------------------------------------------------------------
# 4. A malformed flow_paths basin falls back as a whole (kingsmill never silently drops out)
# ---------------------------------------------------------------------------------------------


@pytest.mark.parametrize("cherwell", ["[kingsmill]", "{}", "null", "kingsmill"])
def test_malformed_basin_falls_back(tmp_path: Path, cherwell: str) -> None:
    p = tmp_path / "stations.yaml"
    p.write_text(
        f"flow_paths:\n  thames:\n    newbotley: [farmoor]\n  cherwell: {cherwell}\n", encoding="utf-8"
    )
    assert features.load_flow_paths(p) == features.FALLBACK_UPSTREAMS


# ---------------------------------------------------------------------------------------------
# An old-style 3-gauge model still works in live mode, through load_model_forecaster
# ---------------------------------------------------------------------------------------------


def test_old_three_gauge_model_runs_live(tmp_path: Path) -> None:
    d = tmp_path / "models"
    _tiny_model("newbotley", NEAR).save(d / "newbotley")
    fc_old = fl.load_model_forecaster(d)
    assert fc_old is not None and fc_old.upstreams == {"newbotley": list(NEAR)}

    hourly, meta = ingest(tmp_path / "fresh", FakeEA(T0 - timedelta(minutes=15), hours=24 * 28), T0)
    X = fc_old.features_at(hourly, "newbotley", T0)
    assert X is not None and list(X.columns) == fc_old.models["newbotley"].feature_cols
    fc = fl.build_forecast(hourly, meta, T0, forecaster=fc_old)
    botley = next(s for s in fc["spots"] if s["spot"] == "botley")
    assert botley["leads"] and "Botley" not in fc["note"]  # a model forecast, not a fallback

    # A stale Shifford does not touch it: the old model never reads Shifford.
    ea = OddEA(
        T0 - timedelta(minutes=15), {"shifford": FakeEA(T0 - timedelta(hours=5), hours=24 * 28)}, 24 * 28
    )
    hourly, meta = ingest(tmp_path / "stale", ea, T0)
    fc2 = fl.build_forecast(hourly, meta, T0, forecaster=fc_old)
    assert fc2["stale"] == ["shifford"] and "Botley" not in fc2["note"]
    assert next(s for s in fc2["spots"] if s["spot"] == "botley")["leads"] == botley["leads"]
