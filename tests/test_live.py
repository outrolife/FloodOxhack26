"""Live mode (issue #16): 15-min cache, hourly resampling, stale rule, Forecast shape, /api/live.

No network: every EA call goes through a fake fetcher.
"""

from __future__ import annotations

import json
import threading
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from api import main as api_main
from model import forecast_live as fl
from pipeline import ingest_live as il

T0 = datetime(2026, 10, 25, 2, 30, tzinfo=UTC)  # just after the UK clocks go back (01:00 UTC)


def iso(ts: datetime) -> str:
    return ts.strftime("%Y-%m-%dT%H:%M:%SZ")


def readings_body(times: list[datetime], values: list[float]) -> dict:
    return {"items": [{"dateTime": iso(t), "value": v} for t, v in zip(times, values, strict=True)]}


class FakeEA:
    """Answers every measure with 15-min readings ending at `last`; counts calls."""

    def __init__(self, last: datetime, hours: int = 72, missing: set[str] | None = None) -> None:
        self.last, self.hours, self.missing, self.calls = last, hours, missing or set(), 0
        self._lock = threading.Lock()  # the poll calls this from several threads

    def __call__(self, url: str, params: dict[str, str]) -> dict:
        with self._lock:
            self.calls += 1
        measure = url.rsplit("/", 2)[-2]
        if any(m in measure for m in self.missing):
            raise ConnectionError("gauge offline")
        n = self.hours * 4
        times = [self.last - timedelta(minutes=15 * i) for i in range(n)][::-1]
        if "rainfall" in measure:
            return readings_body(times, [0.2] * n)
        rng = np.random.default_rng(len(measure))
        # Islip's datum: normal range ~6-8 m; Oxford Botanical Gardens (#146 ring): ~4.8-6.2 m
        base = 7.0 if measure.startswith("1489TH") else 5.0 if measure.startswith("1490TH") else 2.0
        return readings_body(times, list(base + np.cumsum(rng.normal(0, 0.002, n))))


# ---------------------------------------------------------------------------------------------
# 15-minute cache
# ---------------------------------------------------------------------------------------------


def test_cache_ttl_is_15_minutes(tmp_path: Path) -> None:
    fake = FakeEA(T0)
    url = f"{il.BASE_URL}/id/measures/{il.LEVEL_MEASURES['osney']}/readings"

    def get(now: datetime) -> datetime:
        params = {"since": iso(now - timedelta(days=28)), "_sorted": "", "_limit": "10000"}
        return il._cached_get_json(url, params, now=now, cache_dir=tmp_path, fetch=fake)[1]

    assert get(T0) == T0 and fake.calls == 1
    assert get(T0 + timedelta(minutes=14, seconds=59)) == T0 and fake.calls == 1  # cached (since moved)
    assert get(T0 + timedelta(minutes=15)) == T0 + timedelta(minutes=15) and fake.calls == 2


def test_cache_used_when_fetch_fails(tmp_path: Path) -> None:
    url = f"{il.BASE_URL}/id/measures/x/readings"
    il._cached_get_json(url, {}, now=T0, cache_dir=tmp_path, fetch=FakeEA(T0))

    def down(url: str, params: dict[str, str]) -> dict:
        raise ConnectionError

    body, received = il._cached_get_json(url, {}, now=T0 + timedelta(hours=1), cache_dir=tmp_path, fetch=down)
    assert received == T0 and body["items"]
    with pytest.raises(ConnectionError):
        il._cached_get_json(url, {}, now=T0, cache_dir=tmp_path / "empty", fetch=down)


# ---------------------------------------------------------------------------------------------
# Concurrent polling
# ---------------------------------------------------------------------------------------------

ALL_KEYS = [*il.LEVEL_MEASURES, *il.RAIN_MEASURES]


def test_poll_concurrency_is_bounded(tmp_path: Path) -> None:
    fake = FakeEA(T0, hours=2)
    lock, state = threading.Lock(), {"active": 0, "peak": 0}

    def slow(url: str, params: dict[str, str]) -> dict:
        with lock:
            state["active"] += 1
            state["peak"] = max(state["peak"], state["active"])
        time.sleep(0.05)
        with lock:
            state["active"] -= 1
        return fake(url, params)

    out = il.fetch_live_readings(T0, cache_dir=tmp_path, fetch=slow)
    assert len(out) == len(ALL_KEYS) and fake.calls == len(ALL_KEYS)
    assert 1 < state["peak"] <= il.MAX_WORKERS == 4  # concurrent, but never more than 4 at once
    # Every response is cached: a second poll within 15 minutes makes no request.
    il.fetch_live_readings(T0 + timedelta(minutes=10), cache_dir=tmp_path, fetch=slow)
    assert fake.calls == len(ALL_KEYS)


def test_poll_order_is_deterministic(tmp_path: Path) -> None:
    fake = FakeEA(T0, hours=2)
    order = {
        il.BASE_URL + f"/id/measures/{m}/readings": i
        for i, m in enumerate([*il.LEVEL_MEASURES.values(), *il.RAIN_MEASURES.values()])
    }

    def reversed_finish(url: str, params: dict[str, str]) -> dict:
        time.sleep(0.002 * (len(order) - order[url]))  # later gauges finish first
        return fake(url, params)

    out = il.fetch_live_readings(T0, cache_dir=tmp_path, fetch=reversed_finish)
    assert list(out) == ALL_KEYS
    meta = il.live_meta(out)
    assert list(meta["gauges"]) == list(il.LEVEL_MEASURES)
    assert all(meta["gauges"][g]["received_at"] == iso(T0) for g in meta["gauges"])


def test_one_failing_gauge_does_not_fail_poll(tmp_path: Path) -> None:
    fake = FakeEA(T0 - timedelta(minutes=15), missing={"1489TH", "264254TP"})  # islip + one rain gauge
    hourly, meta = _live(tmp_path, fake, T0)
    assert set(meta["gauges"]) == set(il.LEVEL_MEASURES) - {"islip"}
    assert meta["rainGaugesUsed"] == sorted(set(il.RAIN_MEASURES) - {"264254TP"})
    assert "islip" not in set(hourly["gauge"])
    fc = fl.build_forecast(hourly, meta, T0)
    assert "islip" not in fc["dataAsOf"] and "islip" not in fc["observed"]
    assert [s["spot"] for s in fc["spots"]] == [s.key for s in fl.DEFAULT_SPOTS]


# ---------------------------------------------------------------------------------------------
# Hourly resampling across the clock change
# ---------------------------------------------------------------------------------------------


def test_hourly_one_row_per_utc_hour_across_clock_change() -> None:
    times = [
        datetime(2026, 10, 25, 0, 30, tzinfo=UTC) + timedelta(minutes=15 * i) for i in range(9)
    ]  # to 02:30
    readings = {"osney": il.parse_readings(readings_body(times, [float(i) for i in range(9)]), T0)}
    hourly = il.to_hourly(readings)
    assert list(hourly.columns) == [
        "gauge",
        "ts_utc",
        "kind",
        "level_mean",
        "level_max",
        "rain_mm",
        "filled",
        "flagged",
    ]
    assert set(hourly["kind"]) == {"level"} and hourly["filled"].dtype == bool
    assert str(hourly["ts_utc"].dtype) == "datetime64[ns, UTC]"
    assert [t.hour for t in hourly["ts_utc"]] == [0, 1, 2]
    assert hourly["ts_utc"].is_unique
    np.testing.assert_allclose(
        hourly["level_mean"], [0.5, 3.5, 7.0]
    )  # 00:30,00:45 | 01:00-01:45 | 02:00-02:30
    np.testing.assert_allclose(hourly["level_max"], [1.0, 5.0, 8.0])
    # Local Europe/London times of those hours: 01:xx BST twice-ambiguous hour is two distinct UTC rows.
    local = hourly["ts_utc"].dt.tz_convert("Europe/London")
    assert list(local.dt.hour) == [1, 1, 2]


def test_short_gaps_filled_long_gaps_flagged() -> None:
    base = datetime(2026, 10, 20, tzinfo=UTC)
    hours = [0, 1, 4, 5, 9]  # gap of 2 h (2, 3) is filled; gap of 3 h (6, 7, 8) -> 6, 7 filled, 8 NaN
    times = [base + timedelta(hours=h) for h in hours]
    hourly = il.to_hourly({"osney": il.parse_readings(readings_body(times, [1.0, 2.0, 3.0, 4.0, 5.0]), T0)})
    h = hourly.set_index(hourly["ts_utc"].dt.hour)
    assert h.loc[3, "level_mean"] == 2.0 and h.loc[3, "filled"] and not h.loc[3, "flagged"]
    assert np.isnan(h.loc[8, "level_mean"]) and h.loc[8, "flagged"]
    assert len(hourly) == 10


def test_rain_catchment_is_mean_of_available_gauges() -> None:
    base = datetime(2026, 10, 20, tzinfo=UTC)
    t = [base + timedelta(minutes=15 * i) for i in range(8)]  # two hours
    a, b = list(il.RAIN_MEASURES)[:2]
    readings = {
        a: il.parse_readings(readings_body(t, [0.5] * 8), T0),  # 2.0 mm per hour
        b: il.parse_readings(readings_body(t[:4], [1.0] * 4), T0),  # 4.0 mm in hour 1 only
    }
    hourly = il.to_hourly(readings)
    rain = hourly[hourly["gauge"] == il.RAIN_KEY]["rain_mm"].to_list()
    assert rain == [3.0, 2.0]
    assert set(hourly["gauge"]) == {il.RAIN_KEY, a, b} and a == "256230TP"  # rain keyed by EA ref
    assert set(hourly["kind"]) == {"rain"} and hourly["level_mean"].isna().all()
    assert hourly[hourly["gauge"] == b]["rain_mm"].to_list()[0] == 4.0


def test_parse_readings_handles_lists_and_junk() -> None:
    t = [T0 - timedelta(minutes=15 * i) for i in range(3)]
    body = {
        "items": [
            {"dateTime": iso(t[0]), "value": [1.0, 3.0]},
            {"dateTime": iso(t[1]), "value": "x"},
            {"dateTime": iso(t[2]), "value": 4.0},
        ]
    }
    df = il.parse_readings(body, T0)
    assert df["value"].to_list() == [4.0, 2.0]
    assert df["observed_at"].is_monotonic_increasing


# ---------------------------------------------------------------------------------------------
# Stale rule and Forecast
# ---------------------------------------------------------------------------------------------


def test_stale_after_three_hours_across_clock_change() -> None:
    as_of = {
        "osney": "2026-10-24T23:29:00Z",  # 3 h 01 min before 02:30 UTC -> stale
        "godstow": "2026-10-24T23:31:00Z",  # 2 h 59 min -> fresh (wall clock in London shows 3 h 59 min)
    }
    assert fl.stale_gauges(as_of, ["osney", "godstow", "iffley"], T0) == ["iffley", "osney"]


def _live(tmp_path: Path, fake: FakeEA, now: datetime) -> tuple[pd.DataFrame, dict]:
    return il.ingest_live(
        now,
        cache_dir=tmp_path / "raw",
        out_hourly=tmp_path / "h.parquet",
        out_meta=tmp_path / "m.json",
        fetch=fake,
    )


def test_forecast_contract_and_persistence_label(tmp_path: Path) -> None:
    hourly, meta = _live(tmp_path, FakeEA(T0 - timedelta(minutes=15)), T0)
    fc = fl.build_forecast(hourly, meta, T0)
    assert set(fc) == {"issuedAt", "dataAsOf", "stale", "spots", "observed", "method", "note"}
    assert fc["issuedAt"] == "2026-10-25T02:30:00Z"
    assert fc["method"] == "persistence" and "Persistence" in fc["note"]
    assert fc["stale"] == []
    assert all(v.endswith("Z") for v in fc["dataAsOf"].values())
    assert meta["gauges"]["osney"]["measure"] == "1303TH-level-downstage-i-15_min-mASD"  # live-only d/s
    assert meta["gauges"]["eynsham"]["measure"] == "1201TH-level-stage-i-15_min-mASD"  # u/s, as history
    assert set(meta["gauges"]) == set(il.LEVEL_MEASURES)  # rain gauges are not in dataAsOf
    assert [s["spot"] for s in fc["spots"]] == [s.key for s in fl.DEFAULT_SPOTS]
    for s in fc["spots"]:
        assert set(s) == {"spot", "levelNow", "leads", "arrival", "mode"}
        for lead in s["leads"]:
            assert list(lead["q"]) == list(fl.QUANT_KEYS)
            assert list(lead["q"].values()) == sorted(lead["q"].values())
    json.dumps(fc, allow_nan=False)  # valid JSON, no NaN

    spots = {s["spot"]: s for s in fc["spots"]}
    for key in ("botley", "cherwell"):  # verified thresholds -> full probability forecast
        s = spots[key]
        assert s["mode"] == "probability"
        assert [lead["h"] for lead in s["leads"]] == list(fl.LEADS_H)
        p = [lead["pFlood"] for lead in s["leads"]]
        assert p == sorted(p) and all(0 <= x <= 1 for x in p)
        assert set(s["arrival"]) == {"p10", "p50", "p90"}
    for key in ("osney", "abingdonrd"):  # minns / coldharbour, threshold TBC -> timing_only
        s = spots[key]
        assert s["mode"] == "timing_only" and s["arrival"] is None
        assert s["leads"] and all(lead["pFlood"] is None for lead in s["leads"])
    # wolvercote -> godstow is live only: level shown, no forecast.
    assert spots["wolvercote"]["mode"] == "timing_only"
    assert spots["wolvercote"]["leads"] == [] and spots["wolvercote"]["arrival"] is None
    assert spots["wolvercote"]["levelNow"] == round(meta["gauges"]["godstow"]["level"], 3)


def test_spot_gauge_mapping() -> None:
    mapping = {s.key: s.gauge for s in fl.DEFAULT_SPOTS}
    assert mapping == {
        "osney": "minns",
        "botley": "newbotley",
        "abingdonrd": "coldharbour",
        "wolvercote": "godstow",
        "cherwell": "kingsmill",
    }
    # the main-channel locks plus the display-only catchment ring (#146)
    assert fl.LIVE_ONLY_GAUGES == {"godstow", "osney", "iffley", *il.CATCHMENT_MEASURES}
    assert fl.LIVE_ONLY_GAUGES <= set(il.LEVEL_MEASURES)  # still ingested for the River strip
    assert not fl.LIVE_ONLY_GAUGES & set(mapping.values()) - {"godstow"}  # no forecast spot is live-only


def test_catchment_ring_is_display_only() -> None:
    """#146: the catchment gauges are live-ingested, live-only, after the core gauges, never trained."""
    from pipeline import stations

    ring = stations.load_catchment_gauges()
    assert len(ring) >= 6 and {"shifford", "worsham", "lowerarncott"} <= set(il.CATCHMENT_MEASURES)
    core = {g.key for g in stations.load_gauges()[0]}
    assert not core & set(il.CATCHMENT_MEASURES), "a catchment gauge leaked into load_gauges (history/model)"
    keys = list(il.LEVEL_MEASURES)
    assert keys[-len(il.CATCHMENT_MEASURES):] == list(il.CATCHMENT_MEASURES)  # core first
    for g in ring:
        assert g.role == "live_only" and g.amber is not None
        assert il.LEVEL_MEASURES[g.key] == g.fm_level_measure
        assert g.fm_level_measure.startswith(f"{g.ref}-level-") and g.fm_level_measure.endswith("-mASD")


def test_load_spots_tbc_threshold(tmp_path: Path) -> None:
    path = tmp_path / "spots.yaml"
    path.write_text(
        "spots:\n  - {key: osney, gauge: minns, threshold: TBC, amber: 2.13}\n"
        "  - {key: botley, gauge: newbotley, threshold: 2.76, amber: 2.01}\n"
    )
    spots = fl.load_spots(path)
    assert spots[0].threshold is None and spots[0].effective_mode == "timing_only"
    assert spots[1].threshold == 2.76 and spots[1].effective_mode == "probability"


def test_stale_gauge_blanks_dependent_spot(tmp_path: Path) -> None:
    hourly, meta = _live(tmp_path, FakeEA(T0 - timedelta(minutes=15)), T0)
    meta["gauges"]["newbotley"]["observed_at"] = "2026-10-24T22:00:00Z"
    meta["gauges"]["kingsmill"]["observed_at"] = "2026-10-13T14:45:00Z"  # real outage since 13 Oct
    fc = fl.build_forecast(hourly, meta, T0)
    assert fc["stale"] == ["kingsmill", "newbotley"]
    spots = {s["spot"]: s for s in fc["spots"]}
    for key in ("botley", "cherwell"):
        assert spots[key]["leads"] == [] and spots[key]["arrival"] is None
    assert spots["osney"]["leads"]  # minns is fresh


def test_missing_gauge_is_stale(tmp_path: Path) -> None:
    hourly, meta = _live(tmp_path, FakeEA(T0 - timedelta(minutes=15)), T0)
    del meta["gauges"]["kingsmill"]
    fc = fl.build_forecast(hourly, meta, T0)
    assert "kingsmill" in fc["stale"]
    cherwell = next(s for s in fc["spots"] if s["spot"] == "cherwell")
    assert cherwell["leads"] == []  # still listed: levelNow from the hourly fallback


def test_model_upstreams_count_as_dependencies(tmp_path: Path) -> None:
    hourly, meta = _live(tmp_path, FakeEA(T0 - timedelta(minutes=15)), T0)
    meta["gauges"]["farmoor"]["observed_at"] = "2026-10-24T20:00:00Z"

    class Model(fl.PersistenceForecaster):
        upstreams = {"newbotley": ["farmoor", "eynsham", "cassington"], "kingsmill": ["enslow", "islip"]}

    fc = fl.build_forecast(hourly, meta, T0, forecaster=Model())
    spots = {s["spot"]: s for s in fc["spots"]}
    assert fc["method"] == "model" and fc["note"] == ""
    assert spots["botley"]["leads"] == [] and spots["cherwell"]["leads"]


def test_no_live_data_raises() -> None:
    with pytest.raises(fl.LiveDataUnavailable):
        fl.build_forecast(pd.DataFrame(columns=["gauge", "ts_utc", "level_mean"]), {"gauges": {}}, T0)


def test_no_models_means_persistence(tmp_path: Path) -> None:
    assert fl.load_model_forecaster(tmp_path / "missing") is None
    (tmp_path / "models").mkdir()
    assert fl.load_model_forecaster(tmp_path / "models") is None


def test_persistence_uses_shared_probability(tmp_path: Path) -> None:
    """Spot probabilities come from model/probability.py (SPEC §7.5), as in the backtest."""
    from model import probability

    hourly, meta = _live(tmp_path, FakeEA(T0 - timedelta(minutes=15), hours=24 * 7), T0)
    fc = fl.build_forecast(hourly, meta, T0)
    botley = next(s for s in fc["spots"] if s["spot"] == "botley")
    deltas = fl.PersistenceForecaster().predict(hourly, "newbotley", T0)
    q = np.array([[deltas[h][k] for k in fl.QUANT_KEYS] for h in fl.LEADS_H])
    spot = {"key": "botley", "threshold": 2.76, "amber": 2.01, "mode": "probability"}
    level = meta["gauges"]["newbotley"]["level"]
    expected = probability.spot_forecast(spot, level, q, pd.Timestamp(T0), fl.LEADS_H)
    assert botley["leads"] == expected["leads"] and botley["arrival"] == expected["arrival"]


# ---------------------------------------------------------------------------------------------
# Trained models (#79): a tiny fake model directory, no network
# ---------------------------------------------------------------------------------------------


def _tiny_model(target: str = "newbotley"):  # noqa: ANN202 - GaugeModel (lightgbm import kept local)
    """A real GaugeModel with few trees, fitted on random features of the live column set (lags {})."""
    from model import features, train

    cols = features.feature_columns(target, {})
    idx = pd.date_range("2015-01-01", periods=1200, freq="h", tz="UTC")
    rng = np.random.default_rng(0)
    X = pd.DataFrame(rng.normal(0, 0.3, (len(idx), len(cols))), index=idx, columns=cols)
    X["level_now"] += 1.5
    Y = pd.DataFrame(
        {
            f"y_{h}h": 0.05 * h / 6 * X[f"{features.UPSTREAMS[target][0]}_anom_lag0h"]
            + rng.normal(0, 0.05, len(idx))
            for h in fl.LEADS_H
        },
        index=idx,
    )
    return train.fit_gauge(
        X,
        Y,
        target=target,
        amber=2.01,
        threshold=2.76,
        splits=train.Splits(idx[700], idx[1000]),
        medians=dict.fromkeys(features.UPSTREAMS[target], 1.0),
        lags={},
        params={"min_data_in_leaf": 20},
        n_estimators=8,
        early_stopping_rounds=3,
    )


@pytest.fixture(scope="module")
def models_dir(tmp_path_factory: pytest.TempPathFactory) -> Path:
    d = tmp_path_factory.mktemp("models")
    m = _tiny_model()
    m.save(d / "newbotley")
    m.save(d / "lofo" / "e2014" / "newbotley")  # backtest cache: must be skipped
    (d / "notes.txt").write_text("not a model")
    return d


def test_load_trained_models(models_dir: Path) -> None:
    fc = fl.load_model_forecaster(models_dir)
    assert isinstance(fc, fl.TrainedForecaster)
    assert list(fc.models) == ["newbotley"]  # lofo/ and stray files skipped
    assert fc.upstreams == {"newbotley": ["farmoor", "eynsham", "cassington"]}


def test_model_forecast_is_the_backtest_forecast(models_dir: Path, tmp_path: Path) -> None:
    """Live = model/backtest.forecasts_at at the anchor hour: same features, lags, medians, CQR."""
    from model import backtest, train

    hourly, meta = _live(tmp_path, FakeEA(T0 - timedelta(minutes=15), hours=24 * 28), T0)
    forecaster = fl.load_model_forecaster(models_dir)
    fc = fl.build_forecast(hourly, meta, T0, forecaster=forecaster)
    assert fc["method"] == "model"
    # Only newbotley has a model here: the other forecast spots fall back to persistence, and say so.
    assert "Persistence fallback for osney, abingdonrd, cherwell" in fc["note"]
    botley = next(s for s in fc["spots"] if s["spot"] == "botley")
    assert botley["levelNow"] == round(meta["gauges"]["newbotley"]["level"], 3)  # latest 15-min reading
    assert [lead["h"] for lead in botley["leads"]] == list(fl.LEADS_H)

    # Live at 02:30 uses the last complete hour, 01:00 (01:00-01:45), not the partial 02:00 hour (#93).
    anchor = pd.Timestamp("2026-10-25T01:00:00Z")
    assert fl.last_complete_hour(T0) == anchor
    spot = {"key": "botley", "gauge": "newbotley", "threshold": 2.76, "amber": 2.01, "mode": "probability"}
    # A replay forecast issued at t uses the row labelled t - 1 h (#93): the replay issued at floor(now).
    issued = anchor + pd.Timedelta(hours=1)
    replay = backtest.forecasts_at(train.normalise_hourly(hourly), forecaster.models, [spot], [issued])
    assert replay[0]["spots"][0]["leads"] == botley["leads"]

    # And the quantiles really are the model's: different from persistence.
    pers = fl.build_forecast(hourly, meta, T0)
    assert next(s for s in pers["spots"] if s["spot"] == "botley")["leads"] != botley["leads"]
    check_contract(fc)


def check_contract(fc: dict) -> None:
    from tests.test_fixtures import FORECAST, check

    check(json.loads(json.dumps(fc, allow_nan=False)), FORECAST)


def test_model_forecast_ignores_rows_after_now(models_dir: Path, tmp_path: Path) -> None:
    hourly, meta = _live(tmp_path, FakeEA(T0 - timedelta(minutes=15), hours=24 * 28), T0)
    forecaster = fl.load_model_forecaster(models_dir)
    future = hourly.copy()
    extra = future[future["ts_utc"] == future["ts_utc"].max()].copy()
    extra["ts_utc"] += pd.Timedelta(hours=3)
    extra["level_mean"] += 5.0
    future = pd.concat([future, extra], ignore_index=True)
    a = forecaster.predict(hourly, "newbotley", T0)
    assert a is not None and a == forecaster.predict(future, "newbotley", T0)


def test_model_without_reading_falls_back_per_spot(models_dir: Path, tmp_path: Path) -> None:
    hourly, meta = _live(tmp_path, FakeEA(T0 - timedelta(minutes=15)), T0)
    forecaster = fl.load_model_forecaster(models_dir)
    no_nb = hourly[hourly["gauge"] != "newbotley"]
    assert forecaster.predict(no_nb, "newbotley", T0) is None
    assert forecaster.predict(hourly, "kingsmill", T0) is None  # no model for that gauge


def test_refresh_uses_trained_models(
    models_dir: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    hourly, meta = _live(tmp_path, FakeEA(T0 - timedelta(minutes=15), hours=24 * 28), T0)
    monkeypatch.setattr(fl, "LIVE_HOURLY", tmp_path / "h.parquet")
    monkeypatch.setattr(fl, "LIVE_META", tmp_path / "m.json")
    monkeypatch.setattr(fl, "MODELS_DIR", models_dir)
    assert fl.refresh(T0, fetch=False)["method"] == "model"
    monkeypatch.setattr(fl, "MODELS_DIR", tmp_path / "no-models")
    assert fl.refresh(T0, fetch=False)["method"] == "persistence"


# ---------------------------------------------------------------------------------------------
# Cleaning live readings (#80)
# ---------------------------------------------------------------------------------------------

JUNK_AT = datetime(2026, 10, 22, 6, 45, tzinfo=UTC)  # the real Osney d/s junk reading


class JunkEA(FakeEA):
    """FakeEA plus the -52.477 m reading at Osney d/s (2026-10-22T06:45Z) from issue #80."""

    def __call__(self, url: str, params: dict[str, str]) -> dict:
        body = super().__call__(url, params)
        if il.LEVEL_MEASURES["osney"] in url:
            for item in body["items"]:
                if item["dateTime"] == iso(JUNK_AT):
                    item["value"] = -52.477
        return body


def test_minus_52_m_junk_reading_is_dropped(tmp_path: Path) -> None:
    hourly, meta = _live(tmp_path, JunkEA(T0 - timedelta(minutes=15), hours=24 * 7), T0)
    osney = hourly[hourly["gauge"] == "osney"].set_index("ts_utc")
    assert osney["level_mean"].min() > 1.5  # was -11.475 before #80
    # The 06:00 hour is the mean of its three good readings, not NaN and not dragged down.
    hour = osney.loc[pd.Timestamp("2026-10-22T06:00:00Z")]
    raw = il.parse_readings(
        FakeEA(T0 - timedelta(minutes=15), hours=24 * 7)(
            f"{il.BASE_URL}/id/measures/{il.LEVEL_MEASURES['osney']}/readings", {}
        ),
        T0,
    )
    good = raw[(raw["observed_at"] >= "2026-10-22T06:00Z") & (raw["observed_at"] < "2026-10-22T06:45Z")]
    assert hour["level_mean"] == pytest.approx(good["value"].mean())
    fc = fl.build_forecast(hourly, meta, T0)
    assert min(p["level"] for p in fc["observed"]["osney"]) > 1.5


def test_spike_rule_catches_junk_even_without_the_band() -> None:
    """The shared clean.py spike rule (SPEC §5.2 step 4) NaNs the -11 m hour on its own."""
    body = JunkEA(T0 - timedelta(minutes=15), hours=24 * 7)(
        f"{il.BASE_URL}/id/measures/{il.LEVEL_MEASURES['osney']}/readings", {}
    )
    hourly = il.to_hourly({"osney": il.parse_readings(body, T0)})  # no clean_readings
    row = hourly[hourly["ts_utc"] == pd.Timestamp("2026-10-22T06:00:00Z")].iloc[0]
    assert np.isnan(row["level_mean"]) and row["flagged"]
    assert hourly["level_mean"].min() > 1.5


def test_plausible_band_from_stations_yaml() -> None:
    bands = il.plausible_bands()
    assert set(bands) == set(il.LEVEL_MEASURES)
    low, high = bands["osney"]  # amber 3.175, record 3.97
    assert low == pytest.approx(3.175 - 4.0) and high == pytest.approx(3.97 + 2.0)
    assert bands["islip"][0] > 2.0  # Islip's datum: normal levels ~6-8 m, so 2 m there is junk


def test_clean_readings_drops_flagged_implausible_and_negative_rain() -> None:
    t = [T0 - timedelta(minutes=15 * i) for i in range(4)][::-1]
    level = il.parse_readings(
        {
            "items": [
                {"dateTime": iso(t[0]), "value": 2.2},
                {"dateTime": iso(t[1]), "value": 2.3, "quality": "Suspect"},
                {"dateTime": iso(t[2]), "value": 99.0},
                {"dateTime": iso(t[3]), "value": -52.477},  # junk as the latest reading
            ]
        },
        T0,
    )
    rain_ref = next(iter(il.RAIN_MEASURES))
    rain = il.parse_readings(readings_body(t, [0.2, -1.0, 0.0, 0.4]), T0)
    out = il.clean_readings({"osney": level, rain_ref: rain})
    assert out["osney"]["value"].to_list() == [2.2]
    assert out[rain_ref]["value"].to_list() == [0.2, 0.0, 0.4]
    meta = il.live_meta(out)  # levelNow / dataAsOf come from the last *good* reading
    assert meta["gauges"]["osney"]["level"] == 2.2 and meta["gauges"]["osney"]["observed_at"] == iso(t[0])


# ---------------------------------------------------------------------------------------------
# /api/live
# ---------------------------------------------------------------------------------------------


def test_api_recomputes_at_most_every_15_minutes() -> None:
    calls: list[datetime] = []

    def compute(now: datetime) -> dict:
        calls.append(now)
        return {"issuedAt": iso(now)}

    cache = api_main.LiveCache(compute)
    assert cache.get(T0)["issuedAt"] == iso(T0)
    assert cache.get(T0 + timedelta(minutes=14))["issuedAt"] == iso(T0)
    assert cache.get(T0 + timedelta(minutes=15))["issuedAt"] == iso(T0 + timedelta(minutes=15))
    assert len(calls) == 2


def test_api_serves_last_forecast_when_recompute_fails() -> None:
    state = {"fail": False}

    def compute(now: datetime) -> dict:
        if state["fail"]:
            raise ConnectionError
        return {"issuedAt": iso(now)}

    cache = api_main.LiveCache(compute)
    cache.get(T0)
    state["fail"] = True
    assert cache.get(T0 + timedelta(hours=1))["issuedAt"] == iso(T0)


def test_api_live_503_and_200(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    client = TestClient(api_main.app)

    def no_data(now: datetime) -> dict:
        raise fl.LiveDataUnavailable("none")

    monkeypatch.setattr(api_main, "live_cache", api_main.LiveCache(no_data))
    resp = client.get("/api/live")
    assert resp.status_code == 503 and resp.json()["detail"] == "Live data unavailable"

    now = datetime.now(UTC)
    hourly, meta = _live(tmp_path, FakeEA(now - timedelta(minutes=10)), now)
    monkeypatch.setattr(
        api_main, "live_cache", api_main.LiveCache(lambda n: fl.build_forecast(hourly, meta, n))
    )
    resp = client.get("/api/live")
    assert resp.status_code == 200 and resp.json()["method"] == "persistence"


def test_refresh_without_processed_files_is_unavailable(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(fl, "LIVE_HOURLY", tmp_path / "none.parquet")
    monkeypatch.setattr(fl, "LIVE_META", tmp_path / "none.json")
    with pytest.raises(fl.LiveDataUnavailable):
        fl.refresh(T0, fetch=False)


def test_forecast_matches_contract_schema(tmp_path: Path) -> None:
    """build_forecast output passes the same SPEC §9 schema check as tests/fixtures/live.json."""
    from tests.test_fixtures import FORECAST, check

    assert "observed?" in FORECAST  # #38 contract (PR #54)
    hourly, meta = _live(tmp_path, FakeEA(T0 - timedelta(minutes=15)), T0)
    check(json.loads(json.dumps(fl.build_forecast(hourly, meta, T0))), FORECAST)


# ---------------------------------------------------------------------------------------------
# Forecast.observed (#38)
# ---------------------------------------------------------------------------------------------


def test_observed_last_7_days_hourly_every_level_gauge(tmp_path: Path) -> None:
    hourly, meta = _live(tmp_path, FakeEA(T0 - timedelta(minutes=15), hours=24 * 28), T0)
    fc = fl.build_forecast(hourly, meta, T0)
    obs = fc["observed"]
    assert list(obs) == sorted(il.LEVEL_MEASURES)  # every level gauge, rain gauges excluded
    assert fl.LIVE_ONLY_GAUGES <= set(obs)  # osney, godstow, iffley have sparklines too
    issued = pd.Timestamp(T0)
    for g, series in obs.items():
        ts = [pd.Timestamp(p["t"]) for p in series]
        assert len(ts) == 7 * 24, g  # 02:00 today back to 03:00 seven days ago
        assert all(b - a == pd.Timedelta(hours=1) for a, b in zip(ts, ts[1:], strict=False))
        assert ts[-1] <= issued and ts[0] > issued - pd.Timedelta(days=7)
        assert ts[-1] <= pd.Timestamp(fc["dataAsOf"][g])  # never past the gauge's latest reading
        assert all(p["t"].endswith("Z") and round(p["level"], 3) == p["level"] for p in series)
    # Matches the hourly mean it came from.
    row = hourly[(hourly["gauge"] == "osney") & (hourly["ts_utc"] == pd.Timestamp(obs["osney"][-1]["t"]))]
    assert obs["osney"][-1]["level"] == round(float(row["level_mean"].iloc[0]), 3)


def test_observed_has_no_future_data(tmp_path: Path) -> None:
    later = T0 + timedelta(hours=5)
    hourly, meta = _live(tmp_path, FakeEA(later), later)  # readings run 5 h past T0
    obs = fl.observed_series(hourly, T0)
    assert all(pd.Timestamp(p["t"]) <= pd.Timestamp(T0) for series in obs.values() for p in series)
    assert obs["osney"][-1]["t"] == "2026-10-25T02:00:00Z"


def test_live_json_stays_small(tmp_path: Path) -> None:
    hourly, meta = _live(tmp_path, FakeEA(T0 - timedelta(minutes=15), hours=24 * 28), T0)
    text = json.dumps(fl.build_forecast(hourly, meta, T0), indent=2) + "\n"
    assert len(text.encode()) < 500_000
