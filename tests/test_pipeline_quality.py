"""quality_report builds a SPEC §9 `Quality` object (no network)."""
from __future__ import annotations

import json

import pandas as pd

from pipeline import ea_client, quality_report
from pipeline.stations import load_gauges
from tests.test_fixtures import QUALITY, check


def test_build_report_matches_contract(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("RC_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(ea_client, "fm_station", lambda ref: {
        "stageScale": {"typicalRangeHigh": 2.0}, "downstageScale": {"typicalRangeHigh": 3.175}})
    base = {"kind": "level", "hours": 100, "hours_valid": 90, "gaps_filled": 1, "gaps_flagged": 2,
            "spikes_removed": 0, "level_shifts": [{"ts_utc": "2015-01-01T00:00:00+00:00", "step_m": 0.6,
                                                   "median_change_m": 0.6, "gap_h": 0}],
            "first_valid_ts": "2006-01-01T00:00:00+00:00", "last_ts": "2026-10-24T15:00:00+00:00",
            "source": "hydrology"}
    stats = {"newbotley": dict(base), "osney": dict(base, source="fm_archive", archive_days=["2026-02-18"]),
             "osney_us": dict(base),
             "256230TP": dict(base, kind="rain"),
             "rain_catchment": dict(base, kind="rain", pct_hours_with_gauge={"256230TP": 90.0})}
    t = "2026-10-24T16:00:00+00:00"
    prov = pd.DataFrame([
        {"gauge": "newbotley", "source": "hydrology", "downloaded_at": t, "n_rows": 5},
        {"gauge": "256230TP", "source": "hydrology", "downloaded_at": t, "n_rows": 5},
        {"gauge": "osney", "source": "fm_archive", "downloaded_at": t, "n_rows": 5},
    ])
    q = quality_report.build_report(stats, prov)
    check(q, QUALITY, "quality")
    keys = {g.key for g in load_gauges()[0]}
    assert {g["key"] for g in q["gauges"]} == keys  # Station keys only
    osney = next(g for g in q["gauges"] if g["key"] == "osney")
    assert osney["thresholdApi"] == 3.175  # d/s trace -> downstageScale
    assert any("osney_us" in n for n in osney["notes"])
    assert any("level shift" in n for n in osney["notes"])
    assert len(q["sources"]) == 3
    assert any("daily archive" in s["name"] for s in q["sources"])  # archive fallback was used
    assert not any("Historic Flood Warnings" in s["name"] for s in q["sources"])  # no warnings data

    # Warnings data present: listed with licence and download time, still a valid §9 Quality.
    (tmp_path / "warnings_provenance.json").write_text(json.dumps({
        "name": "EA Historic Flood Warnings (AfA435)", "source_url": "https://example.test/w.zip",
        "licence": "Open Government Licence v3.0", "downloaded_at": "2026-10-24T17:05:27Z",
        "n_rows": 228, "first_ts": "2006-11-20T12:13:20+00:00", "last_ts": "2026-01-16T13:34:01+00:00"}))
    q = quality_report.build_report(stats, prov[prov["source"] != "fm_archive"],
                                    quality_report.warnings_source(tmp_path))
    check(q, QUALITY, "quality")
    assert not any("daily archive" in s["name"] for s in q["sources"])  # archive not used: not listed
    w = next(s for s in q["sources"] if "Historic Flood Warnings" in s["name"])
    assert w == {"name": w["name"], "url": "https://example.test/w.zip",
                 "licence": "Open Government Licence v3.0", "downloadedAt": "2026-10-24T17:05:27Z",
                 "rows": 228}
    assert "2006-11-20 to 2026-01-16" in w["name"]


def test_warnings_source_from_parquet_or_absent(tmp_path) -> None:
    assert quality_report.warnings_source(tmp_path) is None
    pd.DataFrame({"area_code": ["061WAF23Oxford", "061FWF23NwBotley"]}).to_parquet(
        tmp_path / "warnings.parquet")
    w = quality_report.warnings_source(tmp_path)
    assert w is not None and w["rows"] == 2
    assert w["licence"] == "Open Government Licence v3.0"
    assert w["downloadedAt"].endswith("Z")
