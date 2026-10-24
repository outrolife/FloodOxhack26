"""Live mode hardening (#125 audit, before judging): the UK clock change and EA failure modes.

UK clocks go back on Sun 25 Oct 2026 at 02:00 BST = 01:00 UTC, so 01:00-02:00 local happens twice.
Everything in the live path is UTC; these tests pin that down, and check that a slow, failing or odd
EA API degrades to cached, stale-flagged data and a valid SPEC §9 Forecast instead of a crash.

No network: the EA is a fake fetcher, or a fake ``requests`` session behind ``ea_client.http_get``.
"""

from __future__ import annotations

import json
import threading
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
import pytest
import requests

from api import main as api_main
from model import forecast_live as fl
from pipeline import ea_client
from pipeline import ingest_live as il
from tests.test_live import FakeEA, _tiny_model, iso, readings_body

LONDON = ZoneInfo("Europe/London")
CHANGE = datetime(2026, 10, 25, 1, 0, tzinfo=UTC)  # 02:00 BST -> 01:00 GMT
T0 = datetime(2026, 10, 25, 2, 30, tzinfo=UTC)
N_GAUGES = len(il.LEVEL_MEASURES) + len(il.RAIN_MEASURES)


def check_contract(fc: dict) -> None:
    from tests.test_fixtures import FORECAST, check

    check(json.loads(json.dumps(fc, allow_nan=False)), FORECAST)


def ingest(tmp_path: Path, fetch, now: datetime) -> tuple[pd.DataFrame, dict]:  # noqa: ANN001
    return il.ingest_live(
        now,
        cache_dir=tmp_path / "raw",
        out_hourly=tmp_path / "h.parquet",
        out_meta=tmp_path / "m.json",
        fetch=fetch,
    )


@pytest.fixture(scope="module")
def forecaster(tmp_path_factory: pytest.TempPathFactory) -> fl.TrainedForecaster:
    d = tmp_path_factory.mktemp("models")
    _tiny_model().save(d / "newbotley")
    fc = fl.load_model_forecaster(d)
    assert fc is not None
    return fc


# ---------------------------------------------------------------------------------------------
# DST: the repeated local hour 01:00-02:00 on 25 Oct 2026
# ---------------------------------------------------------------------------------------------


def test_readings_across_clock_change_resample_to_unique_utc_hours() -> None:
    """00:00-03:00Z every 15 min: 3 complete UTC hours + 03:00, none doubled, none missing."""
    start = datetime(2026, 10, 25, 0, 0, tzinfo=UTC)
    times = [start + timedelta(minutes=15 * i) for i in range(13)]  # 00:00 .. 03:00
    # As the EA sends them: newest first (``_sorted``), one duplicate, one out of order.
    items = [{"dateTime": iso(t), "value": float(i)} for i, t in enumerate(times)][::-1]
    items.insert(3, dict(items[0]))
    items[5], items[6] = items[6], items[5]
    hourly = il.to_hourly({"newbotley": il.parse_readings({"items": items}, times[-1])})
    ts = list(hourly["ts_utc"])
    assert [t.strftime("%H:%M") for t in ts] == ["00:00", "01:00", "02:00", "03:00"]
    assert all(b - a == pd.Timedelta(hours=1) for a, b in zip(ts, ts[1:], strict=False))
    np.testing.assert_allclose(hourly["level_mean"], [1.5, 5.5, 9.5, 12.0])  # 4 readings per hour
    local = [t.tz_convert(LONDON) for t in ts]
    assert [t.strftime("%H:%M %Z") for t in local] == ["01:00 BST", "01:00 GMT", "02:00 GMT", "03:00 GMT"]


def test_feature_windows_across_clock_change_are_exact_utc_hours() -> None:
    """Lags and changes are k rows = k UTC hours back, through the repeated local hour."""
    from model import features

    start = datetime(2026, 10, 23, 0, 0, tzinfo=UTC)
    times = [start + timedelta(minutes=15 * i) for i in range(4 * 72)]  # to 25 Oct 23:45Z
    level = lambda t: 1.0 + (t - start).total_seconds() / 3600 / 100  # noqa: E731 - 1 cm per hour
    readings = {
        g: il.parse_readings(readings_body(times, [level(t) for t in times]), times[-1])
        for g in ["newbotley", *features.UPSTREAMS["newbotley"]]
    }
    hourly = fl.ingest_live.to_hourly(readings)
    medians = dict.fromkeys(features.UPSTREAMS["newbotley"], 1.0)
    X = features.build_features(hourly, "newbotley", medians, {})
    assert X.index.is_unique and (np.diff(X.index.asi8) == 3600 * 10**9).all()
    for row in ["2026-10-25T00:00Z", "2026-10-25T01:00Z", "2026-10-25T02:00Z", "2026-10-25T03:00Z"]:
        x = X.loc[pd.Timestamp(row)]
        assert x["level_change_1h"] == pytest.approx(0.01)
        assert x["level_change_3h"] == pytest.approx(0.03)
        assert x["level_change_24h"] == pytest.approx(0.24)
        assert x["farmoor_anom_lag6h"] == pytest.approx(x["farmoor_anom_lag0h"] - 0.06)


@pytest.mark.parametrize(
    ("now", "row"),
    [
        (datetime(2026, 10, 25, 0, 59, tzinfo=UTC), "2026-10-24T23:00:00Z"),  # 01:59 BST
        (datetime(2026, 10, 25, 1, 0, tzinfo=UTC), "2026-10-25T00:00:00Z"),  # 01:00 GMT (second time)
        (datetime(2026, 10, 25, 1, 59, tzinfo=UTC), "2026-10-25T00:00:00Z"),  # 01:59 GMT
        (datetime(2026, 10, 25, 2, 0, tzinfo=UTC), "2026-10-25T01:00:00Z"),
        # The same local wall time 01:30 twice: fold=0 is BST (00:30Z), fold=1 is GMT (01:30Z).
        (datetime(2026, 10, 25, 1, 30, tzinfo=LONDON), "2026-10-24T23:00:00Z"),
        (datetime(2026, 10, 25, 1, 30, fold=1, tzinfo=LONDON), "2026-10-25T00:00:00Z"),
    ],
)
def test_last_complete_hour_through_the_repeated_local_hour(now: datetime, row: str) -> None:
    assert fl.last_complete_hour(now) == pd.Timestamp(row)


def test_live_forecast_through_clock_change_uses_complete_utc_hours(
    tmp_path: Path, forecaster: fl.TrainedForecaster
) -> None:
    """Every 15 min from 00:00 to 03:00Z: anchor = floor(now) - 1 h, issuedAt/arrival in Z, valid §9."""
    hourly, meta = ingest(
        tmp_path,
        FakeEA(datetime(2026, 10, 25, 3, 0, tzinfo=UTC), hours=24 * 28),
        datetime(2026, 10, 25, 3, 0, tzinfo=UTC),
    )
    anchors = []
    for i in range(13):
        now = datetime(2026, 10, 25, 0, 0, tzinfo=UTC) + timedelta(minutes=15 * i)
        X = forecaster.features_at(hourly, "newbotley", now)
        anchors.append(X.index[0])
        assert X.index[0] == pd.Timestamp(now).floor("h") - pd.Timedelta(hours=1)
        assert not X.isna().any(axis=None)  # complete hours: no NaN feature (rain_sum_6h included)
        # The same instant given in London time gives the same forecast.
        assert forecaster.predict(hourly, "newbotley", now.astimezone(LONDON)) == forecaster.predict(
            hourly, "newbotley", now
        )
        fc = fl.build_forecast(hourly, meta, now.astimezone(LONDON), forecaster=forecaster)
        assert fc["issuedAt"] == iso(now)
        botley = next(s for s in fc["spots"] if s["spot"] == "botley")
        assert botley["leads"]
        times = [v for v in (botley["arrival"] or {}).values() if v is not None]
        assert all(t.endswith("Z") for t in [*times, *fc["dataAsOf"].values()])
        assert "Data gap" not in fc["note"]
        check_contract(fc)
    hours = sorted(set(anchors))
    assert [t.strftime("%H:%M") for t in hours] == ["23:00", "00:00", "01:00", "02:00"]


def test_partial_current_hour_no_longer_blanks_rain_sum_6h(
    tmp_path: Path, forecaster: fl.TrainedForecaster
) -> None:
    """Regression: at 02:10 with readings to 02:00, the 02:00 hour has 1 rain reading (NaN total)."""
    now = datetime(2026, 10, 25, 2, 10, tzinfo=UTC)
    hourly, _ = ingest(tmp_path, FakeEA(datetime(2026, 10, 25, 2, 0, tzinfo=UTC), hours=24 * 28), now)
    rain = hourly[hourly["gauge"] == il.RAIN_KEY]
    partial = rain[rain["ts_utc"] == pd.Timestamp("2026-10-25T02:00Z")]
    assert partial["rain_mm"].isna().all()  # < 3 of 4 readings: no hourly total (clean.py rule)
    X = forecaster.features_at(hourly, "newbotley", now)
    assert X.index[0] == pd.Timestamp("2026-10-25T01:00Z")
    assert np.isfinite(X["rain_sum_6h"].iloc[0])


# ---------------------------------------------------------------------------------------------
# EA failure modes through the real HTTP path (ea_client.http_get), with a fake requests session
# ---------------------------------------------------------------------------------------------


class FakeSession:
    """Stands in for ``requests.Session``: every GET times out, answers 5xx or refuses to connect."""

    def __init__(self, mode: str) -> None:
        self.mode, self.calls = mode, 0
        self.headers: dict[str, str] = {}
        self._lock = threading.Lock()

    def get(self, url: str, **kwargs: object) -> requests.Response:
        with self._lock:
            self.calls += 1
        if self.mode == "timeout":
            raise requests.Timeout("read timed out")
        if self.mode == "connection":
            raise requests.ConnectionError("connection refused")
        r = requests.Response()
        r.status_code, r.url, r._content = int(self.mode), url, b"<html>Service Unavailable</html>"
        return r


@pytest.fixture
def no_sleep(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    slept: list[float] = []
    monkeypatch.setattr(ea_client.time, "sleep", slept.append)
    return slept


@pytest.mark.parametrize("mode", ["timeout", "connection", "503", "500"])
def test_ea_down_uses_cache_bounded_and_flags_stale(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, no_sleep: list[float], mode: str
) -> None:
    earlier = T0 - timedelta(hours=4)
    ingest(tmp_path, FakeEA(earlier - timedelta(minutes=15)), earlier)  # cache from 4 h ago
    session = FakeSession(mode)
    monkeypatch.setattr(ea_client, "_session", session)

    hourly, meta = ingest(tmp_path, il._http_get_json, T0)  # the real fetcher: http_get with retries

    # Bounded: the breaker stops after BREAKER_FAILURES outages; at most MAX_WORKERS were in flight.
    max_requests = (il.BREAKER_FAILURES + il.MAX_WORKERS - 1) * il.LIVE_RETRIES
    assert il.LIVE_RETRIES <= session.calls <= max_requests < N_GAUGES
    assert sum(s for s in no_sleep if s > 1) <= max_requests * 2.0  # backoff 2 s, once per request
    # Every gauge comes from the cache with its old received_at; nothing is lost.
    assert set(meta["gauges"]) == set(il.LEVEL_MEASURES)
    assert all(g["received_at"] == iso(earlier) for g in meta["gauges"].values())
    fc = fl.build_forecast(hourly, meta, T0)
    assert fc["stale"] == sorted(il.LEVEL_MEASURES)  # 4 h old readings: all stale, none confident
    assert all(s["leads"] == [] and s["arrival"] is None for s in fc["spots"])
    assert [s["spot"] for s in fc["spots"]] == [s.key for s in fl.DEFAULT_SPOTS]  # still listed
    check_contract(fc)


def test_http_get_retries_are_capped_for_live(monkeypatch: pytest.MonkeyPatch, no_sleep: list[float]) -> None:
    session = FakeSession("timeout")
    monkeypatch.setattr(ea_client, "_session", session)
    with pytest.raises(requests.Timeout):
        il._http_get_json(f"{il.BASE_URL}/id/measures/x/readings", {})
    assert session.calls == il.LIVE_RETRIES == 2
    session.calls = 0
    with pytest.raises(requests.Timeout):
        ea_client.http_get("https://example.invalid/x")  # history ingest keeps its 5 attempts
    assert session.calls == ea_client.MAX_RETRIES


def test_breaker_skips_network_once_ea_is_down(tmp_path: Path) -> None:
    calls = {"n": 0}
    lock = threading.Lock()

    def down(url: str, params: dict[str, str]) -> dict:
        with lock:
            calls["n"] += 1
        raise requests.ConnectionError("down")

    out = il.fetch_live_readings(T0, cache_dir=tmp_path, fetch=down)
    assert out == {}  # no cache: nothing, but no exception
    assert calls["n"] <= il.BREAKER_FAILURES + il.MAX_WORKERS - 1


def test_a_few_404s_do_not_trip_the_breaker(tmp_path: Path) -> None:
    fake = FakeEA(T0 - timedelta(minutes=15), hours=2)
    gone = list(il.LEVEL_MEASURES.values())[:4]

    def fetch(url: str, params: dict[str, str]) -> dict:
        if any(m in url for m in gone):
            r = requests.Response()
            r.status_code = 404
            raise requests.HTTPError("404", response=r)
        return fake(url, params)

    out = il.fetch_live_readings(T0, cache_dir=tmp_path, fetch=fetch)
    assert len(out) == N_GAUGES - 4 and fake.calls == N_GAUGES - 4  # every other gauge was asked


def test_one_slow_gauge_does_not_block_the_rest(tmp_path: Path) -> None:
    fake = FakeEA(T0 - timedelta(minutes=15), hours=2)

    def fetch(url: str, params: dict[str, str]) -> dict:
        if il.LEVEL_MEASURES["islip"] in url:
            time.sleep(0.3)
            raise requests.Timeout("slow")
        return fake(url, params)

    out = il.fetch_live_readings(T0, cache_dir=tmp_path, fetch=fetch)
    assert "islip" not in out and len(out) == N_GAUGES - 1


# ---------------------------------------------------------------------------------------------
# Odd bodies: empty items, wrong shapes, junk timestamps, stale or future readings
# ---------------------------------------------------------------------------------------------


class OddEA(FakeEA):
    """FakeEA with a per-measure override: a body (or callable) for the matching measures."""

    def __init__(self, last: datetime, override: dict[str, object], hours: int = 72) -> None:
        super().__init__(last, hours=hours)
        self.override = override

    def __call__(self, url: str, params: dict[str, str]) -> object:
        for key, body in self.override.items():
            if il.LEVEL_MEASURES.get(key, key) in url:
                with self._lock:
                    self.calls += 1
                return body(url, params) if callable(body) else body
        return super().__call__(url, params)


def test_empty_items_keeps_cached_readings_and_marks_stale(tmp_path: Path) -> None:
    earlier = T0 - timedelta(hours=4)
    ingest(tmp_path, FakeEA(earlier - timedelta(minutes=15)), earlier)
    hourly, meta = ingest(tmp_path, OddEA(T0 - timedelta(minutes=15), {"newbotley": {"items": []}}), T0)
    assert meta["gauges"]["newbotley"]["received_at"] == iso(earlier)  # the cached copy, kept
    fc = fl.build_forecast(hourly, meta, T0)
    assert fc["stale"] == ["newbotley"]
    botley = next(s for s in fc["spots"] if s["spot"] == "botley")
    assert botley["leads"] == [] and botley["levelNow"]  # still shown, with its last level
    assert next(s for s in fc["spots"] if s["spot"] == "osney")["leads"]  # others unaffected
    check_contract(fc)
    # The cache file still holds the readings (an empty answer never overwrites them).
    hourly2, meta2 = ingest(tmp_path, OddEA(T0, {"newbotley": {"items": []}}), T0 + timedelta(minutes=20))
    assert "newbotley" in meta2["gauges"]


def test_empty_items_without_cache_is_missing_and_stale(tmp_path: Path) -> None:
    hourly, meta = ingest(tmp_path, OddEA(T0 - timedelta(minutes=15), {"minns": {"items": []}}), T0)
    assert "minns" not in meta["gauges"]
    fc = fl.build_forecast(hourly, meta, T0)
    assert "minns" in fc["stale"]
    assert "osney" not in [s["spot"] for s in fc["spots"]]  # no level ever seen: left out (§9 levelNow)
    check_contract(fc)


@pytest.mark.parametrize(
    "body",
    [
        None,
        [],
        "<html>oops</html>",
        {"items": "nope"},
        {"meta": {}},
        {"items": [{"dateTime": "not a time", "value": 1.0}, {"value": 2.0}, "junk", {"dateTime": None}]},
    ],
)
def test_broken_bodies_degrade_per_gauge(tmp_path: Path, body: object) -> None:
    hourly, meta = ingest(tmp_path, OddEA(T0 - timedelta(minutes=15), {"newbotley": body}), T0)
    assert "newbotley" not in meta["gauges"] and len(meta["gauges"]) == len(il.LEVEL_MEASURES) - 1
    fc = fl.build_forecast(hourly, meta, T0)
    assert "newbotley" in fc["stale"]
    check_contract(fc)


def test_broken_body_falls_back_to_cache(tmp_path: Path) -> None:
    earlier = T0 - timedelta(minutes=30)
    ingest(tmp_path, FakeEA(earlier - timedelta(minutes=15)), earlier)
    _, meta = ingest(tmp_path, OddEA(T0, {"newbotley": "<html>502</html>"}), T0)
    assert meta["gauges"]["newbotley"]["received_at"] == iso(earlier)


def test_value_quirks_order_duplicates_and_future_stamps() -> None:
    t = [T0 - timedelta(minutes=15 * i) for i in range(5)]
    body = {
        "items": [
            {"dateTime": iso(t[1]), "value": [1.0, 3.0]},  # EA quirk: list of duplicate readings
            {"dateTime": iso(t[0]), "value": "2.5"},  # numeric string
            {"dateTime": iso(t[1]), "value": 9.0},  # duplicate timestamp: first item wins
            {"dateTime": iso(t[3]), "value": [None, "x"]},  # nothing usable
            {"dateTime": iso(t[2]), "value": True},  # not a level
            {"dateTime": iso(t[4]), "value": float("nan")},
            {"dateTime": iso(T0 + timedelta(hours=2)), "value": 1.0},  # stamped in the future
            {"dateTime": "2026-10-25T02:15:00", "value": 4.0},  # no Z: read as UTC (as the EA means)
        ]
    }
    df = il.parse_readings(body, T0)
    assert [iso(x) for x in df["observed_at"]] == [iso(t[1]), iso(t[0])]
    assert df["value"].to_list() == [2.0, 2.5]
    assert str(df["observed_at"].dtype) == "datetime64[ns, UTC]"


def test_stale_gauge_through_full_ingest(tmp_path: Path) -> None:
    """The EA answers, but the newbotley readings stop 3.5 h ago (gauge offline): stale, no forecast."""
    old = FakeEA(T0 - timedelta(hours=3, minutes=30))
    hourly, meta = ingest(tmp_path, OddEA(T0 - timedelta(minutes=15), {"newbotley": old}), T0)
    fc = fl.build_forecast(hourly, meta, T0)
    assert fc["stale"] == ["newbotley"] and fc["dataAsOf"]["newbotley"] == "2026-10-24T23:00:00Z"
    assert next(s for s in fc["spots"] if s["spot"] == "botley")["leads"] == []


def test_upstream_stale_blanks_model_spot(tmp_path: Path, forecaster: fl.TrainedForecaster) -> None:
    old = FakeEA(T0 - timedelta(hours=5), hours=24 * 28)
    hourly, meta = ingest(tmp_path, OddEA(T0 - timedelta(minutes=15), {"farmoor": old}, hours=24 * 28), T0)
    fc = fl.build_forecast(hourly, meta, T0, forecaster=forecaster)
    assert "farmoor" in fc["stale"]
    assert next(s for s in fc["spots"] if s["spot"] == "botley")["leads"] == []


# ---------------------------------------------------------------------------------------------
# Data gaps: NaN features are flagged in the note, not silently forecast
# ---------------------------------------------------------------------------------------------


def test_upstream_gap_is_flagged_in_note(tmp_path: Path, forecaster: fl.TrainedForecaster) -> None:
    hourly, meta = ingest(tmp_path, FakeEA(T0 - timedelta(minutes=15), hours=24 * 28), T0)
    fc = fl.build_forecast(hourly, meta, T0, forecaster=forecaster)
    assert "Data gap" not in fc["note"]  # 28 days of every gauge: no NaN input

    # Farmoor is fresh (not stale) but missed 6-30 h ago: its lagged anomalies are NaN.
    gap = (hourly["gauge"] == "farmoor") & hourly["ts_utc"].between(
        pd.Timestamp(T0) - pd.Timedelta(hours=30), pd.Timestamp(T0) - pd.Timedelta(hours=6)
    )
    holed = hourly[~gap]
    assert forecaster.missing_inputs(holed, "newbotley", T0) == ["farmoor"]
    fc = fl.build_forecast(holed, meta, T0, forecaster=forecaster)
    botley = next(s for s in fc["spots"] if s["spot"] == "botley")
    assert botley["leads"] and "farmoor" not in fc["stale"]
    assert (
        "Data gap: the Botley Road / New Botley / Hinksey forecast is missing recent readings from "
        "Farmoor" in fc["note"]
    )
    check_contract(fc)


def test_no_rain_gauges_is_flagged(tmp_path: Path, forecaster: fl.TrainedForecaster) -> None:
    hourly, meta = ingest(tmp_path, FakeEA(T0 - timedelta(minutes=15), hours=24 * 28), T0)
    dry = hourly[hourly["kind"] != "rain"]
    fc = fl.build_forecast(dry, meta, T0, forecaster=forecaster)
    assert "missing recent readings from catchment rain" in fc["note"]


def test_model_error_falls_back_to_persistence_for_that_spot(
    tmp_path: Path, forecaster: fl.TrainedForecaster, monkeypatch: pytest.MonkeyPatch
) -> None:
    hourly, meta = ingest(tmp_path, FakeEA(T0 - timedelta(minutes=15), hours=24 * 28), T0)

    def boom(X: pd.DataFrame, calibrated: bool = True) -> dict:
        raise ValueError("feature mismatch")

    monkeypatch.setattr(forecaster.models["newbotley"], "predict", boom)
    fc = fl.build_forecast(hourly, meta, T0, forecaster=forecaster)
    assert fc["method"] == "model"
    assert next(s for s in fc["spots"] if s["spot"] == "botley")["leads"]  # persistence, labelled
    assert "botley" in fc["note"].split(":")[0]  # "Persistence fallback for ..., botley, ...:"
    check_contract(fc)


# ---------------------------------------------------------------------------------------------
# Whole-run degradation: no data at all, and the API restart
# ---------------------------------------------------------------------------------------------


def test_total_outage_keeps_last_processed_files(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    ingest(tmp_path, FakeEA(T0 - timedelta(hours=5)), T0 - timedelta(hours=5))
    before = json.loads((tmp_path / "m.json").read_text())

    def down(url: str, params: dict[str, str]) -> dict:
        raise requests.ConnectionError

    # EA down and the raw cache gone: every gauge is carried over from the last processed files.
    _, meta = il.ingest_live(
        T0,
        cache_dir=tmp_path / "empty-cache",
        out_hourly=tmp_path / "h.parquet",
        out_meta=tmp_path / "m.json",
        fetch=down,
    )
    assert meta == before and json.loads((tmp_path / "m.json").read_text()) == before  # not blanked

    # With no previous files either: NoLiveReadings, and nothing written.
    with pytest.raises(il.NoLiveReadings):
        il.ingest_live(
            T0,
            cache_dir=tmp_path / "empty-cache",
            out_hourly=tmp_path / "new" / "h.parquet",
            out_meta=tmp_path / "new" / "m.json",
            fetch=down,
        )
    assert not (tmp_path / "new" / "m.json").exists()

    # refresh() then serves those files, all stale, as a valid Forecast.
    monkeypatch.setattr(fl, "LIVE_HOURLY", tmp_path / "h.parquet")
    monkeypatch.setattr(fl, "LIVE_META", tmp_path / "m.json")
    monkeypatch.setattr(fl, "MODELS_DIR", tmp_path / "no-models")
    fc = fl.refresh(T0, fetch=False)
    assert fc["stale"] == sorted(il.LEVEL_MEASURES)
    check_contract(fc)


def test_ingest_cli_exits_cleanly_on_total_outage(monkeypatch: pytest.MonkeyPatch) -> None:
    def no_data(*args: object, **kwargs: object) -> None:
        raise il.NoLiveReadings("no live readings for any level gauge")

    monkeypatch.setattr(il, "ingest_live", no_data)
    monkeypatch.setattr("sys.argv", ["ingest_live"])
    with pytest.raises(SystemExit) as exc:
        il.main()
    assert exc.value.code == 1


def test_cli_without_any_data_exits_cleanly(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(fl, "LIVE_HOURLY", tmp_path / "none.parquet")
    monkeypatch.setattr(fl, "LIVE_META", tmp_path / "none.json")
    monkeypatch.setattr(fl, "OUT_FORECAST", tmp_path / "live_forecast.json")
    monkeypatch.setattr("sys.argv", ["forecast_live", "--no-fetch"])
    with pytest.raises(SystemExit) as exc:
        fl.main()
    assert exc.value.code == 1 and not (tmp_path / "live_forecast.json").exists()


def test_api_serves_warm_forecast_while_first_poll_runs() -> None:
    release = threading.Event()

    def slow_compute(now: datetime) -> dict:
        release.wait(5)
        return {"issuedAt": iso(now), "source": "poll"}

    cache = api_main.LiveCache(
        slow_compute, ttl=timedelta(hours=1), warm=lambda now: {"issuedAt": iso(now), "source": "cached"}
    )
    cache.start_background()
    deadline = time.monotonic() + 5
    while cache.forecast is None and time.monotonic() < deadline:
        time.sleep(0.01)
    assert cache.get()["source"] == "cached"  # served at once, not 503 for the length of a poll
    release.set()
    while cache.get()["source"] != "poll" and time.monotonic() < deadline:
        time.sleep(0.01)
    assert cache.get()["source"] == "poll"


def test_api_without_processed_data_still_starts() -> None:
    def no_data(now: datetime) -> dict:
        raise fl.LiveDataUnavailable("none")

    cache = api_main.LiveCache(no_data, ttl=timedelta(hours=1), warm=no_data)
    cache.start_background()
    time.sleep(0.05)
    with pytest.raises(fl.LiveDataUnavailable):
        cache.get()


# ---------------------------------------------------------------------------------------------
# Review findings on PR #141 (the reviewer's probes, turned into regression tests)
# ---------------------------------------------------------------------------------------------


def _back_after_outage(tmp_path: Path, now: datetime) -> tuple[pd.DataFrame, dict]:
    """newbotley offline 08:45 -> 12:15 (3.5 h), back with one reading at 12:15 (probe_anchor.py)."""
    readings = il.fetch_live_readings(
        now, cache_dir=tmp_path / "raw", fetch=FakeEA(now - timedelta(minutes=5), hours=24 * 28)
    )
    r = readings["newbotley"]
    keep = (r["observed_at"] <= pd.Timestamp("2026-10-25T08:45Z")) | (
        r["observed_at"] == pd.Timestamp("2026-10-25T12:15Z")
    )
    readings["newbotley"] = r[keep].reset_index(drop=True)
    readings = il.clean_readings(readings)
    return il.to_hourly(readings), il.live_meta(readings)


def test_no_model_forecast_from_an_hours_old_anchor(tmp_path: Path, forecaster: fl.TrainedForecaster) -> None:
    """Probe 1: the anchor must be floor(now) - 1 h itself, as in the backtest; never an older row."""
    from model import backtest, train

    now = datetime(2026, 10, 25, 12, 20, tzinfo=UTC)
    hourly, meta = _back_after_outage(tmp_path, now)
    assert meta["gauges"]["newbotley"]["observed_at"] == "2026-10-25T12:15:00Z"  # looks fresh
    assert forecaster.features_at(hourly, "newbotley", now) is None  # was the 08:00 row
    fc = fl.build_forecast(hourly, meta, now, forecaster=forecaster)
    botley = next(s for s in fc["spots"] if s["spot"] == "botley")
    assert "botley" in fc["note"].split(":")[0]  # labelled persistence, not a silent model forecast
    assert botley["levelNow"] == round(meta["gauges"]["newbotley"]["level"], 3)
    # The backtest at floor(now) has no level for that row either, so no model forecast there.
    spot = {"key": "botley", "gauge": "newbotley", "threshold": 2.76, "amber": 2.01, "mode": "probability"}
    rep = backtest.forecasts_at(
        train.normalise_hourly(hourly), forecaster.models, [spot], [pd.Timestamp("2026-10-25T12:00Z")]
    )
    assert rep[0]["spots"][0]["leads"] == []
    check_contract(fc)


def test_forward_filled_anchor_is_not_fresh(tmp_path: Path, forecaster: fl.TrainedForecaster) -> None:
    """The gauge missed the whole anchor hour but has a later reading: that hour is only ffilled."""
    now = datetime(2026, 10, 25, 12, 20, tzinfo=UTC)
    readings = il.fetch_live_readings(
        now, cache_dir=tmp_path / "raw", fetch=FakeEA(now - timedelta(minutes=5), hours=24 * 28)
    )
    r = readings["newbotley"]
    hole = r["observed_at"].between(pd.Timestamp("2026-10-25T11:00Z"), pd.Timestamp("2026-10-25T11:45Z"))
    readings["newbotley"] = r[~hole].reset_index(drop=True)
    hourly = il.to_hourly(il.clean_readings(readings))
    nb = hourly[hourly["gauge"] == "newbotley"].set_index("ts_utc")
    assert nb.loc[pd.Timestamp("2026-10-25T11:00Z"), "filled"]  # clean.py carried 10:00 forward
    assert forecaster.features_at(hourly, "newbotley", now) is None
    # An hour later the anchor (12:00) has real readings again: model forecast as normal.
    assert forecaster.features_at(hourly, "newbotley", now + timedelta(minutes=45)) is not None


def test_cold_start_survives_a_short_503_blip(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, no_sleep: list[float]
) -> None:
    """Probe 2a: empty raw cache, a few-second EA 503 blip at the start of the poll.

    The blip is modelled per request: every gauge's first 2 attempts (~2 s with backoff) get 503,
    the third succeeds. With only LIVE_RETRIES = 2 for a cold gauge, every request failed, the
    breaker opened and the poll ingested almost nothing.
    """
    now = datetime(2026, 10, 25, 9, 0, tzinfo=UTC)
    fake = FakeEA(now - timedelta(minutes=15), hours=48)

    class BlipSession:
        headers: dict[str, str] = {}

        def __init__(self) -> None:
            self.attempts: dict[str, int] = {}
            self._lock = threading.Lock()

        def get(self, url: str, params: dict | None = None, **kwargs: object) -> requests.Response:
            with self._lock:
                self.attempts[url] = self.attempts.get(url, 0) + 1
                blip = self.attempts[url] <= 2
            r = requests.Response()
            r.url = url
            if blip:
                r.status_code, r._content = 503, b"busy"
            else:
                r.status_code, r._content = 200, json.dumps(fake(url, params or {})).encode()
            return r

    monkeypatch.setattr(ea_client, "_session", BlipSession())
    _, meta = ingest(tmp_path, il._http_get_json, now)
    assert set(meta["gauges"]) == set(il.LEVEL_MEASURES)  # was 2 gauges before the fix
    assert meta["rainGaugesUsed"] == sorted(il.RAIN_MEASURES)


def test_a_few_always_failing_measures_do_not_send_healthy_gauges_to_cache(tmp_path: Path) -> None:
    """Probe 2b: 3 lock measures answer 500 every time; the other gauges must still be fetched."""
    bad = {il.LEVEL_MEASURES[g] for g in ("godstow", "osney", "iffley")}
    t = datetime(2026, 10, 25, 9, 0, tzinfo=UTC)
    il.fetch_live_readings(t, cache_dir=tmp_path, fetch=FakeEA(t - timedelta(minutes=15), hours=24))
    for k in range(1, 4):
        now = t + timedelta(minutes=15 * k)
        fake = FakeEA(now - timedelta(minutes=15), hours=24)

        def fetch(url: str, params: dict[str, str], fake: FakeEA = fake) -> dict:
            if any(m in url for m in bad):
                r = requests.Response()
                r.status_code = 500
                raise requests.HTTPError("HTTP 500", response=r)
            return fake(url, params)

        out = il.fetch_live_readings(now, cache_dir=tmp_path, fetch=fetch)
        fresh = {g for g, df in out.items() if df["received_at"].iloc[-1] == pd.Timestamp(now)}
        assert fresh == set(out) - {"godstow", "osney", "iffley"}, k
        assert len(out) == N_GAUGES  # the three failing ones from their cache


def test_breaker_still_opens_when_nothing_succeeds() -> None:
    def down(url: str, params: dict[str, str]) -> dict:
        raise requests.ConnectionError

    breaker = il._Breaker(down)
    for _ in range(il.BREAKER_FAILURES):
        with pytest.raises(requests.ConnectionError):
            breaker.guard("u", {})
    assert breaker.open
    with pytest.raises(il.EAUnavailable):
        breaker.guard("u", {})


def test_poll_deadline_stops_new_requests(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Low finding: a slow-but-answering EA cannot hold a poll (and LiveCache's lock) for minutes."""
    earlier = T0 - timedelta(hours=1)
    il.fetch_live_readings(earlier, cache_dir=tmp_path, fetch=FakeEA(earlier, hours=2))
    monkeypatch.setattr(il, "POLL_DEADLINE_S", 0.15)
    fake = FakeEA(T0, hours=2)

    def slow(url: str, params: dict[str, str]) -> dict:
        time.sleep(0.2)
        return fake(url, params)

    out = il.fetch_live_readings(T0, cache_dir=tmp_path, fetch=slow)
    assert len(out) == N_GAUGES  # nothing lost: the rest came from the cache
    assert 0 < fake.calls <= il.MAX_WORKERS  # only the first wave was asked (5 waves without it)


def test_cold_start_merges_with_previous_processed_files(tmp_path: Path) -> None:
    """Probe 2a, second half: gauges this poll could not get are carried over, never dropped."""
    ingest(tmp_path, FakeEA(T0 - timedelta(hours=1)), T0 - timedelta(hours=1))
    gone = [il.LEVEL_MEASURES["newbotley"], il.LEVEL_MEASURES["islip"], "264254TP"]
    fake = FakeEA(T0 - timedelta(minutes=15))

    def fetch(url: str, params: dict[str, str]) -> dict:
        if any(m in url for m in gone):
            raise requests.ConnectionError("down")
        return fake(url, params)

    hourly, meta = il.ingest_live(
        T0,
        cache_dir=tmp_path / "wiped-cache",
        out_hourly=tmp_path / "h.parquet",
        out_meta=tmp_path / "m.json",
        fetch=fetch,
    )
    assert list(meta["gauges"]) == list(il.LEVEL_MEASURES)
    assert meta["gauges"]["newbotley"]["observed_at"] == iso(T0 - timedelta(hours=1))  # old time kept
    assert meta["gauges"]["farmoor"]["observed_at"] == iso(T0 - timedelta(minutes=15))
    assert "264254TP" in meta["rainGaugesUsed"] and "264254TP" in set(hourly["gauge"])
    assert (hourly["gauge"] == il.RAIN_KEY).any()
    assert not hourly.duplicated(["gauge", "ts_utc"]).any()
    check_contract(fl.build_forecast(hourly, meta, T0))


def test_replace_retry_waits_out_a_windows_lock(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    calls = {"n": 0}
    real = il.os.replace

    def flaky(src: object, dst: object) -> None:
        calls["n"] += 1
        if calls["n"] < 3:
            raise PermissionError("in use")
        real(src, dst)

    monkeypatch.setattr(il.os, "replace", flaky)
    (tmp_path / "a.part").write_text("new")
    il.replace_retry(tmp_path / "a.part", tmp_path / "a.json", wait_s=0)
    assert (tmp_path / "a.json").read_text() == "new" and calls["n"] == 3
