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
    assert keys[0] == "newbotley" and len(keys) == 18
    assert {"minns", "coldharbour"} <= set(keys)
    osney = next(g for g in levels if g.key == "osney")
    assert osney.needs_archive
    assert osney.fm_level_measure == "1303TH-level-downstage-i-15_min-mASD"
    assert stations.hydrology_series_key(osney) == "osney_us"
    assert stations.hydrology_trace(osney) == "u/s"
    eynsham = next(g for g in levels if g.key == "eynsham")
    assert not eynsham.needs_archive and stations.hydrology_series_key(eynsham) == "eynsham"
    assert {g.key for g in rains} == {"256230TP", "254336TP", "261021TP", "264254TP", "263541TP"}


def test_stations_yaml_schema(tmp_path) -> None:
    """The config/stations.yaml schema from #2: nested hydrology block, trace, history_ok, rain by ref."""
    p = tmp_path / "stations.yaml"
    p.write_text("""
gauges:
  - key: osney
    ref: 1303TH
    amber: 3.175
    trace: d/s
    fm_measure: 1303TH-level-downstage-i-15_min-mASD
    hydrology:
      level_measure: new-level-i-900-m-qualified
      qualifier: u/s
    history_ok: false
  - key: newgauge
    name: New
    river: X
    role: upstream
    ref: 9999TH
    trace: single
    hydrology: {level_measure: abc-level-i-900-m-qualified, qualifier: single}
    history_ok: true
rain_gauges:
  - ref: 256230TP
    name: Osney Lock
    hydrology_measure: r-rainfall-t-900-mm-qualified
""")
    levels, rains = stations.load_gauges(path=p)
    osney = next(g for g in levels if g.key == "osney")
    assert osney.amber == 3.175 and osney.needs_archive
    assert osney.hydrology_measure == "new-level-i-900-m-qualified"
    assert osney.threshold == 3.79  # untouched fields come from the fallback
    new = next(g for g in levels if g.key == "newgauge")
    assert new.hydrology_measure == "abc-level-i-900-m-qualified" and not new.needs_archive
    assert len(rains) == 5
    assert next(r for r in rains if r.key == "256230TP").hydrology_measure == "r-rainfall-t-900-mm-qualified"


def test_repo_stations_yaml_loads() -> None:
    if not stations.STATIONS_YAML.exists():
        pytest.skip("config/stations.yaml not present")
    levels, rains = stations.load_gauges()
    by = {g.key: g for g in levels}
    assert by["newbotley"].role == "target" and not by["newbotley"].needs_archive
    assert all(by[k].needs_archive for k in ("osney", "godstow", "iffley"))
    assert all(g.hydrology_measure and g.hydrology_measure.endswith("-m-qualified") for g in levels)
    assert all(r.hydrology_measure for r in rains)


NEW_125 = {"shifford": "upstream", "hannington": "upstream", "worsham": "upstream", "shipton": "upstream",
           "banbury": "live_only", "lowerarncott": "live_only"}


def test_further_upstream_gauges_125() -> None:
    """#125 A: the six further-upstream gauges have Hydrology history on their live trace."""
    levels, _ = stations.load_gauges()
    by = {g.key: g for g in levels}
    fallback, _ = stations.load_gauges(path=stations.REPO_ROOT / "does-not-exist.yaml")
    fb = {g.key: g for g in fallback}
    for key, role in NEW_125.items():
        g = by[key]
        assert g.role == role and g.history_ok and not g.needs_archive
        assert stations.hydrology_series_key(g) == key
        assert g.hydrology_measure == fb[key].hydrology_measure  # fallback copy stays in sync
        assert (g.amber, g.threshold, g.record) == (fb[key].amber, fb[key].threshold, fb[key].record)
        assert g.fm_level_measure.startswith(g.ref + "-level-stage-")  # "Stage", the Hydrology trace


def test_live_measures_match_stations_yaml() -> None:
    """ingest_live polls the same flood-monitoring measure stations.yaml names for each gauge."""
    from pipeline import ingest_live

    levels, _ = stations.load_gauges()
    by = {g.key: g for g in [*levels, *stations.load_catchment_gauges()]}  # + the #146 display-only ring
    assert set(ingest_live.LEVEL_MEASURES) == set(by)
    for key, measure in ingest_live.LEVEL_MEASURES.items():
        assert by[key].fm_level_measure == measure, key


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
