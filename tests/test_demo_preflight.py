"""scripts/demo_preflight.py (issue #70): the pure checks, on temp dirs. No network, no server."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import pytest

from scripts import demo_preflight as pf


def write(path: Path, value: object | str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value if isinstance(value, str) else json.dumps(value))
    return path


@pytest.fixture
def dirs(tmp_path: Path) -> tuple[Path, Path]:
    public, fixtures = tmp_path / "public", tmp_path / "fixtures"
    write(fixtures / "proof.json", {})
    write(fixtures / "live.json", {})
    write(fixtures / "replays" / "e2014.json", {})
    public.mkdir()
    return public, fixtures


def test_real_file_ok(dirs: tuple[Path, Path]) -> None:
    public, fixtures = dirs
    write(public / "stations.json", [{"key": "a"}])
    c = pf.check_data_file(public, fixtures, "stations.json", True, list)
    assert c.status == pf.OK and "real data" in c.title


def test_missing_required_file_fails_and_names_fixture(dirs: tuple[Path, Path]) -> None:
    public, fixtures = dirs
    c = pf.check_data_file(public, fixtures, "proof.json", True, dict)
    assert c.status == pf.FAIL
    assert "tests/fixtures/proof.json" in c.detail


def test_missing_optional_file_warns(dirs: tuple[Path, Path]) -> None:
    public, fixtures = dirs
    c = pf.check_data_file(public, fixtures, "live.json", False, dict)
    assert c.status == pf.WARN


def test_invalid_json_fails(dirs: tuple[Path, Path]) -> None:
    public, fixtures = dirs
    write(public / "proof.json", "{not json")
    c = pf.check_data_file(public, fixtures, "proof.json", True, dict)
    assert c.status == pf.FAIL and "invalid JSON" in c.title


def test_wrong_top_level_shape_fails(dirs: tuple[Path, Path]) -> None:
    public, fixtures = dirs
    write(public / "stations.json", {"not": "a list"})
    c = pf.check_data_file(public, fixtures, "stations.json", True, list)
    assert c.status == pf.FAIL and "expected list" in c.title


def test_no_fixture_either(dirs: tuple[Path, Path]) -> None:
    public, fixtures = dirs
    c = pf.check_data_file(public, fixtures, "quality.json", True, dict)
    assert c.status == pf.FAIL and "no fixture" in c.detail


def test_replay_falls_back_to_any_replay_fixture(dirs: tuple[Path, Path]) -> None:
    _, fixtures = dirs
    assert pf.fixture_candidates("replays/e2007.json", fixtures) == ["replays/e2014.json"]
    assert pf.fixture_candidates("live.json", fixtures) == ["live.json"]


def test_event_replays(dirs: tuple[Path, Path]) -> None:
    public, _ = dirs
    events = [{"id": "e2014"}, {"id": "e2026"}]
    write(public / "replays" / "e2014.json", {})
    c = pf.check_event_replays(public, events)
    assert c.status == pf.WARN and "e2026" in c.detail
    write(public / "replays" / "e2026.json", {})
    assert pf.check_event_replays(public, events).status == pf.OK


def test_data_size_limit(dirs: tuple[Path, Path]) -> None:
    public, _ = dirs
    write(public / "big.json", "x" * 2000)
    assert pf.check_data_size(public, limit=10_000).status == pf.OK
    assert pf.check_data_size(public, limit=1_000).status == pf.FAIL


def test_dist_data_must_match_public(tmp_path: Path) -> None:
    public, dist = tmp_path / "public", tmp_path / "dist"
    write(public / "replays" / "e2014.json", {"v": 1})
    write(dist / "data" / "replays" / "e2014.json", {"v": 1})
    assert pf.check_dist_data(dist, public).status == pf.OK
    write(public / "replays" / "e2014.json", {"v": 2})
    c = pf.check_dist_data(dist, public)
    assert c.status == pf.FAIL and "replays/e2014.json" in c.detail


def test_compare_build() -> None:
    stamp = {"sources": "abc12345" * 5, "dirty": [], "builtAt": "2026-10-24T17:00:00Z"}
    same = stamp["sources"]
    assert pf.compare_build(stamp, same, [], dist_mtime=2, src_mtime=1).status == pf.OK
    assert pf.compare_build(stamp, "f" * 40, [], dist_mtime=2, src_mtime=1).status == pf.FAIL
    assert pf.compare_build(stamp, same, [], dist_mtime=1, src_mtime=2).status == pf.FAIL
    assert pf.compare_build(stamp, same, ["web/src/App.tsx"], dist_mtime=2, src_mtime=1).status == pf.WARN
    assert pf.compare_build(None, same, [], dist_mtime=2, src_mtime=1).status == pf.WARN


def test_check_dist_missing(tmp_path: Path) -> None:
    assert pf.check_dist(tmp_path / "dist").status == pf.FAIL


def test_scan_external(tmp_path: Path) -> None:
    dist = tmp_path / "dist"
    write(dist / "index.html", '<script type="module" src="/assets/index.js"></script>')
    write(dist / "assets" / "index.js", 'a="https://{s}.tile.openstreetmap.org/{z}";b="https://www.gov.uk/x"')
    checks = pf.scan_external(dist)
    assert checks[0].status == pf.OK
    assert any(c.title == "map tiles" for c in checks)

    write(dist / "assets" / "index.css", "@import url(https://fonts.googleapis.com/css2?family=Inter);")
    assert pf.scan_external(dist)[0].status == pf.FAIL

    (dist / "assets" / "index.css").unlink()
    write(dist / "assets" / "more.js", 'fetch("https://api.example.com/x")')
    c = pf.scan_external(dist)[0]
    assert c.status == pf.WARN and "api.example.com" in c.detail

    write(dist / "index.html", '<link rel="stylesheet" href="https://cdn.example.com/x.css">')
    assert pf.scan_external(dist)[0].status == pf.FAIL


def test_clock_zone_either_side_of_the_change() -> None:
    before = pf.check_clock(datetime(2026, 10, 25, 0, 30, tzinfo=UTC))[0]
    after = pf.check_clock(datetime(2026, 10, 25, 1, 30, tzinfo=UTC))[0]
    assert before.status == pf.OK and "01:30 BST" in before.detail
    assert after.status == pf.OK and "01:30 GMT" in after.detail


def test_parse_pmset() -> None:
    mains = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining"
    batt = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t41%; discharging; 3:10 remaining"
    assert pf.parse_pmset(mains) == (100, True)
    assert pf.parse_pmset(batt) == (41, False)
    assert pf.parse_pmset("") == (None, None)


def test_disk_check(tmp_path: Path) -> None:
    assert pf.check_disk(tmp_path, min_free_gb=0).status == pf.OK
    assert pf.check_disk(tmp_path, min_free_gb=10**9).status == pf.WARN


def test_check_basemap(tmp_path: Path) -> None:
    tiles, dist = tmp_path / "tiles", tmp_path / "dist"
    assert pf.check_basemap(tiles, dist).status == pf.WARN  # not downloaded: warn, Leaflet map still works
    write(tiles / pf.PMTILES, "PMTiles")
    write(tiles / pf.GLYPHS, "x")
    assert pf.check_basemap(tiles, dist).status == pf.OK  # no build yet
    write(dist / "index.html", '<div id="root"></div>')
    c = pf.check_basemap(tiles, dist)
    assert c.status == pf.WARN and "rebuild" in c.detail  # built before the download
    write(dist / "tiles" / pf.PMTILES, "PMTiles")
    assert pf.check_basemap(tiles, dist).status == pf.OK
