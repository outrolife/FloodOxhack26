"""model/proof.py: event scores from synthetic replays, and the written proof.json against §9."""

from __future__ import annotations

import json
from pathlib import Path

import pandas as pd
import pytest

from model import proof
from tests.test_fixtures import PROOF, REPLAY, check

T0 = pd.Timestamp("2014-01-01T00:00:00Z")
SPOT = {
    "key": "botley",
    "gauge": "g",
    "threshold": 2.0,
    "amber": 1.5,
    "mode": "probability",
    "warningArea": "AREA1",
}
WEB = Path(__file__).resolve().parent.parent / "web" / "public" / "data"


def iso(h: float) -> str:
    return (T0 + pd.Timedelta(hours=h)).strftime("%Y-%m-%dT%H:%M:%SZ")


def forecast(h: int, p: float, p50_at: float | None) -> dict:
    q = {k: 1.0 + i * 0.1 for i, k in enumerate(("05", "10", "25", "50", "75", "90", "95"))}
    arrival = {"p10": None, "p50": iso(p50_at) if p50_at is not None else None, "p90": None}
    return {
        "issuedAt": iso(h),
        "dataAsOf": {"g": iso(h)},
        "stale": [],
        "spots": [
            {
                "spot": "botley",
                "levelNow": 1.0,
                "leads": [{"h": 72, "q": q, "pFlood": p, "pAmber": p}],
                "arrival": arrival,
                "mode": "probability",
            }
        ],
    }


def replay(
    eid: str,
    start_h: int,
    p_of_hour,
    crossings: list[float],
    official: list[float],
    p50_of_hour=lambda h: None,
) -> dict:
    hours = range(start_h, start_h + 100)
    return {
        "eventId": eid,
        "name": eid,
        "start": iso(start_h),
        "end": iso(start_h + 99),
        "observed": {"g": [{"t": iso(h), "level": 1.0} for h in hours]},
        "forecasts": [forecast(h, p_of_hour(h), p50_of_hour(h)) for h in hours],
        "official": [
            {"spot": "botley", "type": "warning", "issuedAt": iso(h), "precision": "time"} for h in official
        ],
        "crossings": [{"spot": "botley", "t": iso(h)} for h in crossings],
    }


@pytest.fixture(scope="module")
def scored() -> dict:
    # e1: p = 0.6 from 40 h, crossing at 80 h, EA warning at 70 h; the forecast issued at 56 h
    # (24 h before) puts the 50% arrival at 82 h. e2 (starts at 1000 h): p = 0.6 for 3 h, no crossing.
    r1 = replay("e1", 0, lambda h: 0.6 if h >= 40 else 0.0, [80], [70], lambda h: 82 if h == 56 else None)
    r2 = replay("e2", 1000, lambda h: 0.6 if 1010 <= h <= 1012 else 0.0, [], [])
    events = {"e1": {"start": iso(0), "end": iso(99)}, "e2": {"start": iso(1000), "end": iso(1099)}}
    hourly = pd.DataFrame(
        {
            "gauge": "g",
            "ts_utc": [T0 + pd.Timedelta(hours=h) for h in (10, 80, 1050)],
            "level_mean": [1.0, 2.3, 1.8],
        }
    )
    warnings = pd.DataFrame(
        {
            "area_code": ["AREA1"],
            "type": ["warning"],
            "precision": ["time"],
            "issued_at": [T0 + pd.Timedelta(hours=70)],
            "message": ["Flood Warning"],
        }
    )
    return proof.event_scores({"e1": r1, "e2": r2}, events, [SPOT], hourly, warnings)


def test_tradeoff_at_half(scored: dict) -> None:
    row = next(r for r in scored["tradeoff"]["botley"] if r["pStar"] == 0.5)
    # hit with lead 80 - 40 = 40 h; e2 episode is a false alarm; we were 70 - 40 = 30 h ahead of the EA
    assert (row["hits"], row["misses"], row["falseAlarms"]) == (1, 0, 1)
    assert row["meanLeadH"] == 40.0 and row["meanLeadVsOfficialH"] == 30.0
    above = next(r for r in scored["tradeoff"]["botley"] if r["pStar"] == 0.7)
    assert (above["hits"], above["misses"], above["falseAlarms"], above["meanLeadH"]) == (0, 1, 0, None)


def test_per_event_and_official_outcome(scored: dict) -> None:
    rows = {r["eventId"]: r for r in scored["perEvent"]}
    assert rows["e1"] == {
        "eventId": "e1",
        "spot": "botley",
        "crossed": True,
        "peakObs": 2.3,
        "arrivalErrH": 2.0,
        "leadVsOfficialH": 30.0,
        "officialIssuedAt": iso(70),
    }
    assert rows["e2"]["crossed"] is False and rows["e2"]["arrivalErrH"] is None
    assert rows["e2"]["leadVsOfficialH"] is None and rows["e2"]["officialIssuedAt"] is None
    assert scored["officialOutcome"]["botley"] == {
        "hits": 1,
        "misses": 0,
        "falseAlarms": 0,
        "meanLeadH": 10.0,
    }


def _warnings(*rows: tuple[float, str]) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "area_code": ["AREA1"] * len(rows),
            "type": ["warning"] * len(rows),
            "precision": ["time"] * len(rows),
            "issued_at": [T0 + pd.Timedelta(hours=h) for h, _ in rows],
            "message": [m for _, m in rows],
        }
    )


def test_official_outcome_holds_warning_until_updates() -> None:
    """#92: a Flood Warning 85 h before the crossing, updated 1 h before it, is a hit (it was in force)."""
    r = replay("e1", 0, lambda h: 0.0, [90], [5])
    events = {"e1": {"start": iso(0), "end": iso(99)}}
    hourly = pd.DataFrame({"gauge": "g", "ts_utc": [T0 + pd.Timedelta(hours=90)], "level_mean": [2.3]})
    w = _warnings((5, "Flood Warning"), (89, "Update Flood Warning"))
    out = proof.event_scores({"e1": r}, events, [SPOT], hourly, w)
    assert out["officialOutcome"]["botley"] == {"hits": 1, "misses": 0, "falseAlarms": 0, "meanLeadH": 72.0}


def test_lead_vs_official_paired_within_first_flood() -> None:
    """#90/#92: floods at 10 h and 90 h; the EA warned for the first, we only triggered for the second.
    Without onsets the lead was 5 - 80 = -75 h (our second-flood trigger vs their first-flood warning)."""
    r = replay("e1", 0, lambda h: 0.6 if h >= 80 else 0.0, [10, 90], [5])
    events = {"e1": {"start": iso(0), "end": iso(99)}}
    hourly = pd.DataFrame({"gauge": "g", "ts_utc": [T0 + pd.Timedelta(hours=10)], "level_mean": [2.3]})
    out = proof.event_scores({"e1": r}, events, [SPOT], hourly, _warnings((5, "Flood Warning")))
    row = next(x for x in out["tradeoff"]["botley"] if x["pStar"] == 0.5)
    assert row["meanLeadVsOfficialH"] is None
    assert out["perEvent"][0]["leadVsOfficialH"] is None


def test_assemble_matches_contract(scored: dict) -> None:
    skill = [
        {"h": h, "pinballModel": 0.01, "pinballPersistence": 0.02, "skill": 0.5} for h in proof.HORIZONS_H
    ]
    out = proof.assemble(skill, [], {}, scored, "note", with_38=False)
    check(out, PROOF, "proof")
    with_38 = proof.assemble(skill, [], {}, scored, "note", with_38=True)
    assert "officialOutcome" in with_38 and "officialIssuedAt" in with_38["perEvent"][0]


def test_in_test_period() -> None:
    assert proof.in_test_period({"start": "2024-11-20", "end": "2024-12-05"})
    assert not proof.in_test_period({"start": "2021-01-20", "end": "2021-02-20"})
    assert not proof.in_test_period({"start": "2021-10-03", "end": "2021-10-20"})  # -7 days is before


# --------------------------------------------------------------------------- generated files (if present)


@pytest.mark.skipif(not (WEB / "proof.json").exists(), reason="proof.json not generated")
def test_generated_proof_matches_contract() -> None:
    pr = json.loads((WEB / "proof.json").read_text(encoding="utf-8"))
    check(pr, PROOF, "proof")
    for s in pr["skillByLead"]:
        assert abs(s["skill"] - (1 - s["pinballModel"] / s["pinballPersistence"])) < 0.005
    assert {(c["h"], c["nominal"]) for c in pr["coverage"]} == {
        (h, n) for h in proof.HORIZONS_H for n in (0.5, 0.8, 0.9)
    }
    for spot, rows in pr["tradeoff"].items():
        assert len({r["hits"] + r["misses"] for r in rows}) == 1, spot
        assert [r["pStar"] for r in rows] == sorted(r["pStar"] for r in rows)
    for rows in pr["reliability"].values():
        for row in rows:
            assert all(b["n"] > 0 and 0 <= b["pObs"] <= 1 and 0 <= b["pPred"] <= 1 for b in row["bins"])
    for r in pr["perEvent"]:
        if not r["crossed"]:
            assert r["arrivalErrH"] is None


@pytest.mark.parametrize("path", sorted((WEB / "replays").glob("*.json")), ids=lambda p: p.stem)
def test_generated_replays_match_contract(path: Path) -> None:
    r = json.loads(path.read_text(encoding="utf-8"))
    check(r, REPLAY, "replay")
    issued = [f["issuedAt"] for f in r["forecasts"]]
    assert issued == sorted(issued) and len(set(issued)) == len(issued)


def test_consistent_arrivals() -> None:
    r = replay("e1", 0, lambda h: 0.6, [], [])
    r["forecasts"][0]["spots"][0]["levelNow"] = 2.0  # at the 2.0 m threshold
    r["forecasts"][1]["spots"][0]["leads"][0]["pFlood"] = 0.1  # shown as exactly 0.1 at 72 h
    out = proof.consistent_arrivals(r, [SPOT])
    assert out["forecasts"][0]["spots"][0]["arrival"] == {"p10": iso(0), "p50": iso(0), "p90": iso(0)}
    # below the line: p reaches 0.1 exactly at the 72 h lead, interpolated from p = 0 at issue time
    assert out["forecasts"][1]["spots"][0]["arrival"] == {"p10": iso(73), "p50": None, "p90": None}
