"""S2 ensemble rain (SPEC §11): computation on a canned Open-Meteo response, no network."""
from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import numpy as np
import pytest
from test_fixtures import ENSEMBLE_RAIN, assert_non_decreasing, assert_strictly_increasing, check

from stretch import s2_ensemble_rain as s2

ISSUED = datetime(2026, 10, 24, 18, tzinfo=UTC)
PUBLIC = Path(__file__).resolve().parent.parent / "web" / "public" / "data" / "ensemble_rain.json"


def canned(n_members: int = 51, hours: int = 96, start: datetime | None = None) -> list[dict]:
    """Three locations; member m rains m * 0.01 mm every hour at point 0, twice that at 1, 0 at 2."""
    start = start or ISSUED - timedelta(hours=18)
    times = [(start + timedelta(hours=h)).strftime("%Y-%m-%dT%H:%M") for h in range(hours)]
    out = []
    for p, scale in enumerate([1.0, 2.0, 0.0]):
        hourly: dict[str, list] = {"time": times}
        for m in range(n_members):
            key = "precipitation" if m == 0 else f"precipitation_member{m:02d}"
            hourly[key] = [round(m * 0.01 * scale, 4)] * hours
        out.append({"latitude": 51.75, "longitude": -1.25 - p, "hourly": hourly})
    return out


def test_points_come_from_config() -> None:
    pts = s2.load_points()
    assert [p[0] for p in pts] == ["eynsham", "enslow", "oxford"]
    for _, lat, lon in pts:
        assert 51.6 < lat < 52.0 and -1.5 < lon < -1.1


def test_compute_matches_contract_and_maths() -> None:
    d = s2.compute(canned(), ["eynsham", "enslow", "oxford"], ISSUED)
    check(d, ENSEMBLE_RAIN, "ensemble_rain")
    assert d["issuedAt"] == "2026-10-24T18:00:00Z"
    assert d["hours"] == list(range(73))
    # Member m: catchment mean = m * 0.01 * (1 + 2 + 0) / 3 = m * 0.01 mm/h, so 72 h total = 0.72 m.
    totals = np.arange(51) * 0.72
    for p in (10, 50, 90):
        series = d["cumMm"][f"p{p}"]
        assert series[0] == 0.0
        assert series[-1] == pytest.approx(round(float(np.percentile(totals, p)), 1))
        assert_non_decreasing(series, f"p{p}")
    assert d["cumMm"]["p50"][-1] == pytest.approx(18.0)  # median member is 25 -> 25 * 0.72
    assert d["cumMm"]["p50"][24] == pytest.approx(6.0)  # 25 * 0.01 * 24


def test_window_starts_after_issue_hour() -> None:
    """Rain stamped at issuedAt fell in the hour *before* it, so it must not count."""
    body = canned()
    for loc in body:
        i = loc["hourly"]["time"].index("2026-10-24T18:00")
        for k, v in loc["hourly"].items():
            if k != "time":
                v[i] = 500.0
    d = s2.compute(body, ["a", "b", "c"], ISSUED)
    assert d["cumMm"]["p90"][-1] < 100


def test_short_response_is_rejected() -> None:
    with pytest.raises(ValueError, match="does not cover"):
        s2.compute(canned(hours=60), ["a", "b", "c"], ISSUED)


def test_members_with_gaps_are_dropped_and_too_few_rejected() -> None:
    body = canned(n_members=12)
    body[1]["hourly"]["precipitation_member05"][30] = None
    body[2]["hourly"]["precipitation_member06"][30] = None
    body[0]["hourly"]["precipitation_member07"][30] = None
    with pytest.raises(ValueError, match="only 9 complete"):
        s2.compute(body, ["a", "b", "c"], ISSUED)


def test_fetch_uses_cache_without_network(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RC_DATA_DIR", str(tmp_path))
    cache = tmp_path / "raw" / "open_meteo_ensemble" / "20261024T18Z.json"
    cache.parent.mkdir(parents=True)
    cache.write_text(json.dumps(canned()), encoding="utf-8")

    def no_network(*_a: object, **_k: object) -> None:
        raise AssertionError("network used despite cache")

    monkeypatch.setattr("requests.get", no_network)
    body = s2.fetch(s2.load_points(), ISSUED)
    assert len(body) == 3


def test_committed_web_file_matches_contract() -> None:
    if not PUBLIC.is_file():
        pytest.skip("web/public/data/ensemble_rain.json not committed")
    d = json.loads(PUBLIC.read_text(encoding="utf-8"))
    check(d, ENSEMBLE_RAIN, "ensemble_rain")
    assert d["points"] == ["eynsham", "enslow", "oxford"]
    assert_strictly_increasing(d["hours"], "hours")
    assert d["hours"][0] == 0 and d["hours"][-1] == 72
    cum = d["cumMm"]
    for k in ("p10", "p50", "p90"):
        assert len(cum[k]) == len(d["hours"])
        assert_non_decreasing(cum[k], k)
        assert all(v >= 0 for v in cum[k])
    for i in range(len(d["hours"])):
        assert_non_decreasing([cum["p10"][i], cum["p50"][i], cum["p90"][i]], f"cumMm[{i}]")
