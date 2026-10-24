"""Ingest parsing, config loading and the cached client, without the network."""
from __future__ import annotations

from datetime import date

import pytest

from pipeline import ea_client, ingest_history, stations

HYD_CSV = b'''"measure","dateTime","date","value","completeness","quality","qcode"
"http://x/measures/abc-level-i-900-m-qualified","2014-01-09T06:45:00","2014-01-09","3.97","","Good",""
"http://x/measures/abc-level-i-900-m-qualified","2014-01-09T07:00:00","2014-01-09","","","Missing",""
'''

ARCHIVE_CSV = b"""dateTime,measure,value
2026-02-20T00:00:00Z,http://environment.data.gov.uk/flood-monitoring/id/measures/1303TH-level-downstage-i-15_min-mASD,3.41
2026-02-20T00:00:00Z,http://environment.data.gov.uk/flood-monitoring/id/measures/1303TH-level-stage-i-15_min-mASD,0.10
2026-02-20T00:15:00Z,http://environment.data.gov.uk/flood-monitoring/id/measures/1303TH-level-downstage-i-15_min-mASD,3.40|3.41
"""


def test_parse_hydrology_csv_is_utc() -> None:
    df = ingest_history.parse_hydrology_csv(HYD_CSV, "osney_us", "level", "hydrology")
    assert list(df.columns) == ingest_history.COLUMNS
    assert str(df["ts_utc"].dt.tz) == "UTC"
    assert df["ts_utc"].iloc[0].isoformat() == "2014-01-09T06:45:00+00:00"
    assert df["quality"].tolist() == ["Good", "Missing"]


def test_parse_archive_csv_keeps_only_the_measure() -> None:
    df = ingest_history.parse_archive_csv(ARCHIVE_CSV, "1303TH-level-downstage-i-15_min-mASD",
                                          "osney", "level", "fm_archive")
    assert df["value"].tolist() == [3.41, 3.40]
    assert (df["gauge"] == "osney").all()


def test_archive_days_event_windows_clipped_to_archive() -> None:
    windows = {"e2014": (date(2013, 12, 20), date(2014, 2, 20)),
               "e2026": (date(2026, 2, 18), date(2026, 3, 10))}
    days = ingest_history.archive_days(windows, today=date(2026, 10, 24), all_days=False)
    assert days[0] == date(2026, 2, 18) and days[-1] == date(2026, 3, 10) and len(days) == 21


def test_fallback_gauges_and_lock_series_keys() -> None:
    levels, rains = stations.load_gauges(path=stations.REPO_ROOT / "does-not-exist.yaml")
    keys = [g.key for g in levels]
    assert keys[0] == "newbotley" and len(keys) == 12
    assert {"minns", "coldharbour"} <= set(keys)
    osney = next(g for g in levels if g.key == "osney")
    assert osney.is_lock_downstream
    assert osney.fm_measure == "1303TH-level-downstage-i-15_min-mASD"
    assert stations.series_key(osney, upstream_stage=True) == "osney_us"
    assert {g.key for g in rains} == {"256230TP", "254336TP", "261021TP", "264254TP", "263541TP"}


def test_stations_yaml_overrides_fallback(tmp_path) -> None:
    p = tmp_path / "stations.yaml"
    p.write_text("""
gauges:
  - key: osney
    ref: 1303TH
    amber: 3.175
    hydrology_measure: http://environment.data.gov.uk/hydrology/id/measures/new-level-i-900-m-qualified
    qualifier: downstream
rain_gauges:
  256230TP: {name: Osney}
""")
    levels, rains = stations.load_gauges(path=p)
    osney = next(g for g in levels if g.key == "osney")
    assert osney.amber == 3.175
    assert osney.hydrology_measure == "new-level-i-900-m-qualified"
    assert osney.threshold == 3.79  # untouched fields come from the fallback
    assert len(rains) == 5


def test_cached_get_never_redownloads(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("RC_DATA_DIR", str(tmp_path))
    calls = []

    class Resp:
        content = b"hello"
        url = "http://example/x"

    def fake_get(url, params=None, stream=False, timeout=0):
        calls.append(url)
        return Resp()

    monkeypatch.setattr(ea_client, "http_get", fake_get)
    path = ea_client.raw_dir() / "t" / "x.csv.gz"
    assert ea_client.cached_get("http://example/x", path) == b"hello"
    assert ea_client.cached_get("http://example/x", path) == b"hello"
    assert len(calls) == 1
    assert path.read_bytes() != b"hello"  # stored gzipped
    assert ea_client.cache_meta(path)["url"] == "http://example/x"


def test_http_get_retries_then_raises(monkeypatch) -> None:
    import requests

    attempts = []

    class S:
        def get(self, *a, **k):
            attempts.append(1)
            raise requests.ConnectionError("down")

    monkeypatch.setattr(ea_client, "_http", lambda: S())
    monkeypatch.setattr(ea_client.time, "sleep", lambda s: None)
    with pytest.raises(requests.ConnectionError):
        ea_client.http_get("http://example/x")
    assert len(attempts) == ea_client.MAX_RETRIES
