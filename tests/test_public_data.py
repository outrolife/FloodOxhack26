"""Validate the committed web data (web/public/data/) against the SPEC §9 contracts.

tests/test_fixtures.py checks the hand-made samples; this file runs the same
schemas and semantic rules on whatever the pipeline has actually committed, so a
real file that would break the web app fails `make test`. Files that don't exist
yet are skipped. Reference data (stations, spots, events) comes from
web/public/data/ when present, else from the fixtures.

Rules here are only the generic ones: fixture-specific assertions (exact peak
values, "fixture should include ...") stay in test_fixtures.py.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta
from itertools import pairwise
from pathlib import Path
from typing import Any

import pytest
from test_fixtures import (
    EVENT_META,
    FIXTURES,
    IMPORTANCE,
    LEADS,
    PROOF,
    QUALITY,
    REPLAY,
    SPOT,
    STATION,
    TRAVEL_PAIR,
    ListOf,
    assert_close,
    assert_known,
    assert_non_decreasing,
    assert_prob,
    assert_strictly_increasing,
    assert_unique,
    check,
    check_forecast,
    check_warn_at,
    parse_utc,
)

PUBLIC = Path(__file__).resolve().parent.parent / "web" / "public" / "data"
MAX_PUBLIC_BYTES = 50 * 1024 * 1024  # SPEC §15.8 / CLAUDE.md rule 6


def public(rel: str) -> Any:
    path = PUBLIC / rel
    if not path.is_file():
        pytest.skip(f"web/public/data/{rel} not committed yet")
    return json.loads(path.read_text(encoding="utf-8"))


def reference(rel: str) -> list[dict]:
    """Public file if committed, else the fixture (for cross-file references)."""
    path = PUBLIC / rel if (PUBLIC / rel).is_file() else FIXTURES / rel
    return json.loads(path.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def stations() -> dict[str, dict]:
    return {s["key"]: s for s in reference("stations.json")}


@pytest.fixture(scope="module")
def spots() -> dict[str, dict]:
    return {s["key"]: s for s in reference("spots.json")}


@pytest.fixture(scope="module")
def events() -> dict[str, dict]:
    return {e["id"]: e for e in reference("events.json")}


def is_auto_event(event_id: str) -> bool:
    """Auto-detected events (SPEC §6.1) are named auto-YYYYMMDD and need not be in events.json."""
    return event_id.startswith("auto-")


# ---------------------------------------------------------------------------


def test_public_data_is_small() -> None:
    total = sum(p.stat().st_size for p in PUBLIC.rglob("*") if p.is_file())
    assert total < MAX_PUBLIC_BYTES, f"web/public/data/ is {total / 1e6:.1f} MB; limit 50 MB"


def test_public_files_are_json() -> None:
    for path in PUBLIC.rglob("*.json"):
        try:
            json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:  # pragma: no cover - failure path
            pytest.fail(f"{path.relative_to(PUBLIC)}: invalid JSON ({e})")


def test_stations() -> None:
    data = public("stations.json")
    check(data, ListOf(STATION), "stations")
    assert_unique([s["key"] for s in data], "stations[*].key")
    for s in data:
        p = f"stations[{s['key']}]"
        assert 51.6 < s["lat"] < 52.0 and -1.5 < s["lon"] < -1.1, f"{p}: not near Oxford"
        if s["threshold"] is not None:
            assert s["threshold"] > s["amber"], f"{p}: threshold must be above amber"


def test_spots(stations: dict) -> None:
    data = public("spots.json")
    check(data, ListOf(SPOT), "spots")
    assert_unique([s["key"] for s in data], "spots[*].key")
    assert len(data) == 5, f"SPEC §4.2 has five trouble spots, got {len(data)}"
    for s in data:
        p = f"spots[{s['key']}]"
        assert s["gauge"] in stations, f"{p}.gauge: unknown station {s['gauge']!r}"
        assert s["threshold"] > s["amber"], f"{p}: threshold must be above amber"
        if stations[s["gauge"]]["role"] == "live_only":  # SPEC §4.2
            assert s["mode"] == "timing_only", f"{p}: on live_only gauge but not timing_only"


def test_events(stations: dict) -> None:
    data = public("events.json")
    check(data, ListOf(EVENT_META), "events")
    assert_unique([e["id"] for e in data], "events[*].id")
    for e in data:
        assert parse_utc(e["start"]) < parse_utc(e["end"]), f"events[{e['id']}]: start must be before end"
        assert_known(e["peak"], stations, f"events[{e['id']}].peak")
    assert [e["id"] for e in data if e["headline"]] == ["e2014"], "exactly one headline event (e2014)"


def test_travel_times(stations: dict, events: dict) -> None:
    data = public("travel_times.json")
    check(data, ListOf(TRAVEL_PAIR), "travel_times")
    assert_unique([(t["up"], t["down"]) for t in data], "travel_times[*] (up, down)")
    for t in data:
        p = f"travel_times[{t['up']}->{t['down']}]"
        assert t["up"] in stations and t["down"] in stations, f"{p}: unknown gauge"
        for g in (t["up"], t["down"]):  # SPEC §4.1.1: travel times need history at both ends
            assert stations[g]["role"] != "live_only", f"{p}: {g} is live_only"
        for k in ("tHalf", "tPeak"):
            assert_non_decreasing([t[k]["p10"], t[k]["median"], t[k]["p90"]], f"{p}.{k}")
        used = [e for e in t["events"] if "excluded" not in e]
        assert t["n"] == len(used), f"{p}.n: {t['n']} != {len(used)} non-excluded events"
        for e in t["events"]:
            if not is_auto_event(e["eventId"]):
                assert e["eventId"] in events, f"{p}: unknown event {e['eventId']!r}"
        for e in used:
            for k in ("tHalf", "tPeak"):
                if e[k] is not None:  # values are rounded to 0.1 h, so 0.0 can mean (0, 0.05)
                    assert 0 <= e[k] < 168, f"{p}.{e['eventId']}.{k}: {e[k]} outside (0, 168) h"
        lags = [x["lagH"] for x in t["xcorr"]]
        assert lags, f"{p}.xcorr is empty"
        assert_strictly_increasing(lags, f"{p}.xcorr.lagH")
        assert 0 <= lags[0] and lags[-1] <= 120, f"{p}.xcorr: lags outside 0-120 h"
        assert all(-1 <= x["r"] <= 1 for x in t["xcorr"]), f"{p}.xcorr: r outside [-1, 1]"
        # SPEC §15.3 / §6.3: fewer than 3 events -> cross-correlation-only, lag_main = xcorr peak.
        if t["n"] < 3:
            peak = max(t["xcorr"], key=lambda x: x["r"])["lagH"]
            msg = f"{p}: n < 3, so tHalf.median must be the xcorr peak"
            assert_close(t["tHalf"]["median"], peak, 0.5, msg)


def test_live_forecast(stations: dict, spots: dict) -> None:
    fc = public("live.json")
    check_forecast(fc, stations, spots, "live")


def replay_files() -> list[str]:
    folder = PUBLIC / "replays"
    return sorted(p.name for p in folder.glob("*.json")) if folder.is_dir() else []


@pytest.mark.parametrize("name", replay_files() or ["(none)"])
def test_replay(name: str, stations: dict, spots: dict, events: dict) -> None:
    r = public(f"replays/{name}")
    check(r, REPLAY, f"replay {name}")
    assert f"{r['eventId']}.json" == name, f"{name}: eventId {r['eventId']!r} does not match the file name"
    assert r["eventId"] in events, f"{name}: event {r['eventId']!r} not in events.json"
    start, end = parse_utc(r["start"]), parse_utc(r["end"])
    assert start < end
    assert_known(r["observed"], stations, f"{name}.observed")
    obs: dict[str, dict[datetime, float]] = {}
    for g, series in r["observed"].items():
        ts = [parse_utc(p["t"]) for p in series]
        assert_strictly_increasing(ts, f"{name}.observed[{g}].t")
        assert all((b - a) % timedelta(hours=1) == timedelta(0) for a, b in pairwise(ts)), (
            f"{name}.observed[{g}] not on whole hours"
        )
        obs[g] = {t: p["level"] for t, p in zip(ts, series, strict=True)}
    issued = [parse_utc(f["issuedAt"]) for f in r["forecasts"]]
    assert issued, f"{name}: no forecasts"
    assert_strictly_increasing(issued, f"{name}.forecasts[*].issuedAt")
    for i, fc in enumerate(r["forecasts"]):
        p = f"{name}.forecasts[{i}]"
        check_forecast(fc, stations, spots, p)  # includes: no dataAsOf after issuedAt
        # A forecast issued at t uses the last complete hourly row, labelled t - 1 h: the row labelled t
        # holds readings up to t + 45 min (#93). So levelNow is the observed level at t - 1 h.
        last_row = parse_utc(fc["issuedAt"]) - timedelta(hours=1)
        for sf in fc["spots"]:
            g = spots[sf["spot"]]["gauge"]
            if g in obs and last_row in obs[g]:
                assert_close(
                    sf["levelNow"], obs[g][last_row], 1e-3, f"{p}.{sf['spot']}.levelNow vs obs at t - 1 h"
                )
    for o in r["official"]:
        assert o["spot"] in spots, f"{name}.official: unknown spot {o['spot']!r}"
    for c in r["crossings"]:
        assert c["spot"] in spots, f"{name}.crossings: unknown spot {c['spot']!r}"


def test_proof(spots: dict, events: dict) -> None:
    pr = public("proof.json")
    check(pr, PROOF, "proof")
    assert sorted(s["h"] for s in pr["skillByLead"]) == LEADS
    for s in pr["skillByLead"]:
        assert s["pinballPersistence"] > 0
        assert_close(
            s["skill"], 1 - s["pinballModel"] / s["pinballPersistence"], 0.005, f"proof.skill h={s['h']}"
        )
    for c in pr["coverage"]:
        assert_prob(c["actual"], f"proof.coverage h={c['h']}")
    assert_known(pr["reliability"], spots, "proof.reliability")
    for spot, rows in pr["reliability"].items():
        for row in rows:
            p = f"proof.reliability[{spot}] h={row['h']}"
            for b in row["bins"]:
                assert_prob(b["pPred"], p)
                assert_prob(b["pObs"], p)
            assert_prob(row["brier"], p)
            assert_prob(row["brierPersistence"], p)
    assert_known(pr["tradeoff"], spots, "proof.tradeoff")
    for spot, rows in pr["tradeoff"].items():
        for r in rows:
            counts = (r["hits"], r["misses"], r["falseAlarms"])
            assert min(counts) >= 0, f"proof.tradeoff[{spot}]: negative count"
            if "ci90" in r:
                assert r["ci90"][0] <= r["ci90"][1], f"proof.tradeoff[{spot}]: ci90 low > high"
    for row in pr["perEvent"]:
        p = f"proof.perEvent[{row['eventId']}/{row['spot']}]"
        assert row["eventId"] in events, f"{p}: unknown event"
        assert row["spot"] in spots, f"{p}: unknown spot"
        if not row["crossed"]:
            assert row["arrivalErrH"] is None, f"{p}: arrival error without a crossing"
    if "warnAt" in pr:  # per-spot warn-at levels (#134)
        check_warn_at(pr["warnAt"], spots, events)


def test_quality(stations: dict) -> None:
    q = public("quality.json")
    check(q, QUALITY, "quality")
    assert_known([g["key"] for g in q["gauges"]], stations, "quality.gauges")
    for g in q["gauges"]:
        assert 0 <= g["coveragePct"] <= 100, f"quality.gauges[{g['key']}].coveragePct"
    assert q["sources"], "quality.sources is empty (About/Proof list sources from it)"
    for s in q["sources"]:
        assert s["url"].startswith("https://"), f"quality.sources[{s['name']}]: url must be https"


def test_importance(stations: dict) -> None:
    imp = public("importance.json")
    check(imp, IMPORTANCE, "importance")
    assert_known(imp, stations, "importance")
