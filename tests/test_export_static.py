"""pipeline/export_static.py: stations/spots/events.json match the SPEC §9 shapes (issue #46)."""

from __future__ import annotations

import json
from pathlib import Path

import pandas as pd
import pytest

from pipeline import export_static as ex
from tests.test_fixtures import EVENT_META, SPOT, STATION, ListOf, check

ROOT = Path(__file__).resolve().parent.parent
WEB_DATA = ROOT / "web" / "public" / "data"


def _validate(stations: list[dict], spots: list[dict], events: list[dict]) -> None:
    check(stations, ListOf(STATION), "stations")
    check(spots, ListOf(SPOT), "spots")
    check(events, ListOf(EVENT_META), "events")
    by_key = {s["key"]: s for s in stations}
    assert len(by_key) == len(stations), "duplicate station keys"
    for s in spots:
        st = by_key[s["gauge"]]
        assert s["amber"] == st["amber"] and s["threshold"] == st["threshold"], s["key"]
        if st["role"] == "live_only":
            assert s["mode"] == "timing_only", f"{s['key']} is on a live_only gauge"
    assert [e["id"] for e in events if e["headline"]] == ["e2014"]
    for e in events:
        for g in e["peak"]:
            assert g in by_key, f"{e['id']}: unknown gauge {g}"
            assert by_key[g]["role"] == "target", f"{e['id']}: peak on non-trained gauge {g}"


def _hourly(rows: list[tuple[str, str, float]]) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "gauge": [r[0] for r in rows],
            "ts_utc": pd.to_datetime([r[1] for r in rows], utc=True),
            "kind": "level",
            "level_max": [r[2] for r in rows],
        }
    )


@pytest.mark.parametrize("name", ["stations.json", "spots.json", "events.json"])
def test_committed_files_exist(name: str) -> None:
    assert (WEB_DATA / name).exists(), f"run `python -m pipeline.export_static` to write {name}"


def test_committed_files_match_contract() -> None:
    load = lambda n: json.loads((WEB_DATA / n).read_text(encoding="utf-8"))  # noqa: E731
    _validate(load("stations.json"), load("spots.json"), load("events.json"))


def test_committed_stations_and_spots_match_config() -> None:
    stations = ex.build_stations(ex._yaml(ex.CONFIG / "stations.yaml"))
    spots = ex.build_spots(ex._yaml(ex.CONFIG / "spots.yaml"), stations)
    assert json.loads((WEB_DATA / "stations.json").read_text(encoding="utf-8")) == stations
    assert json.loads((WEB_DATA / "spots.json").read_text(encoding="utf-8")) == spots


def test_export_computes_peaks_and_is_idempotent(tmp_path: Path) -> None:
    hourly = _hourly(
        [
            ("newbotley", "2014-01-05T00:00:00Z", 2.5),
            ("newbotley", "2014-01-09T12:00:00Z", 3.5),  # in the e2014 window: the peak
            ("newbotley", "2015-01-01T00:00:00Z", 9.9),  # outside every window
            ("osney_us", "2014-01-09T12:00:00Z", 0.2),  # lock head-water series: skipped
            ("osney", "2014-01-09T12:00:00Z", 3.97),  # live_only: skipped
            ("farmoor", "2014-01-09T12:00:00Z", 1.9),  # upstream, not trained: skipped
        ]
    )
    files = ex.export(tmp_path, ex.CONFIG, hourly)
    _validate(files["stations.json"], files["spots.json"], files["events.json"])
    e2014 = next(e for e in files["events.json"] if e["id"] == "e2014")
    assert e2014["peak"]["newbotley"] == 3.5  # from hourly, not events.yaml
    assert e2014["peak"]["minns"] == 3.09  # no hourly data: events.yaml value kept
    assert "osney" not in e2014["peak"] and "farmoor" not in e2014["peak"]
    assert e2014["headline"] is True

    before = {p.name: p.read_text(encoding="utf-8") for p in tmp_path.iterdir()}
    for name, obj in files.items():
        assert ex.write_if_changed(tmp_path / name, obj) is False, f"{name} rewritten on a second run"
    assert {p.name: p.read_text(encoding="utf-8") for p in tmp_path.iterdir()} == before


def test_export_without_hourly_uses_config_peaks(tmp_path: Path) -> None:
    files = ex.export(tmp_path, ex.CONFIG, None)
    e2026 = next(e for e in files["events.json"] if e["id"] == "e2026")
    assert e2026["peak"]["minns"] == 2.742  # near miss below the osney spot threshold (2.90)


def test_bad_role_is_rejected() -> None:
    doc = {"gauges": [{"key": "x", "name": "X", "river": "R", "role": "downstream", "ref": "1",
                       "lat": 51.7, "lon": -1.2, "amber": 1.0}]}
    with pytest.raises(ValueError, match="role"):
        ex.build_stations(doc)


def test_catchment_gauges_are_live_only_and_not_duplicated() -> None:
    """#146: catchment_gauges join stations.json after gauges; a key already in gauges is kept once."""
    g = {"name": "X", "river": "R", "ref": "1", "lat": 51.7, "lon": -1.2, "amber": 1.0}
    ring = [{"key": "shifford", "role": "live_only", **g}, {"key": "thrupp", "role": "live_only", **g}]
    doc = {"gauges": [{"key": "shifford", "role": "upstream", **g}], "catchment_gauges": ring}
    out = ex.build_stations(doc)
    assert [(s["key"], s["role"]) for s in out] == [("shifford", "upstream"), ("thrupp", "live_only")]
