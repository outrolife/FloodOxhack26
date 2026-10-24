"""Check every JSON fixture in tests/fixtures/ against the SPEC §9 / §11 contracts.

Each contract is written below as a small schema that mirrors web/src/contracts.ts:
a dict of field -> type spec, where a key ending in "?" is optional (as in
TypeScript). Semantic rules that a type can't express (monotone quantiles,
probabilities non-decreasing in h, references between files, ...) are separate
helper functions. To extend: add a schema, a fixture and a test that calls
`check(load(...), SCHEMA)` plus any semantic helpers.

Stdlib + pytest only.
"""

from __future__ import annotations

import json
import math
import re
from datetime import datetime, timedelta
from itertools import pairwise
from pathlib import Path
from typing import Any

import pytest

FIXTURES = Path(__file__).parent / "fixtures"
CONTRACTS_TS = Path(__file__).parent.parent / "web" / "src" / "contracts.ts"

LEADS = [6, 12, 24, 36, 48, 72]
QUANT_KEYS = ["05", "10", "25", "50", "75", "90", "95"]
STALE_AFTER = timedelta(hours=3)  # SPEC §10.1
EPS = 1e-9

# ---------------------------------------------------------------------------
# Type-spec helpers
# ---------------------------------------------------------------------------
# A spec is one of:
#   STR, NUM, INT, BOOL, UTC          primitive (UTC = ISO 8601 string ending in Z)
#   Lit("a", "b")                     one of these literal values
#   Nullable(spec)                    spec or None
#   ListOf(spec)                      list of spec
#   RecordOf(spec)                    dict with string keys and spec values
#   Tuple(spec, spec, ...)            fixed-length list
#   {"field": spec, "opt?": spec}     object with exactly these keys


class Spec:
    pass


class _Prim(Spec):
    def __init__(self, name: str) -> None:
        self.name = name


STR, NUM, INT, BOOL, UTC = (_Prim(n) for n in ("str", "num", "int", "bool", "utc"))


class Lit(Spec):
    def __init__(self, *values: Any) -> None:
        self.values = values


class Nullable(Spec):
    def __init__(self, inner: Any) -> None:
        self.inner = inner


class ListOf(Spec):
    def __init__(self, inner: Any) -> None:
        self.inner = inner


class RecordOf(Spec):
    def __init__(self, inner: Any) -> None:
        self.inner = inner


class Tuple(Spec):
    def __init__(self, *items: Any) -> None:
        self.items = items


UTC_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")


def is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def parse_utc(s: str) -> datetime:
    assert isinstance(s, str) and UTC_RE.match(s), f"not an ISO 8601 UTC time ending in Z: {s!r}"
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def check(value: Any, spec: Any, path: str = "$") -> None:
    """Assert that `value` matches `spec`; error messages carry a JSON path."""
    if isinstance(spec, dict):
        assert isinstance(value, dict), f"{path}: expected object, got {type(value).__name__}"
        required = {k for k in spec if not k.endswith("?")}
        optional = {k[:-1] for k in spec if k.endswith("?")}
        missing = required - value.keys()
        extra = value.keys() - required - optional
        assert not missing, f"{path}: missing keys {sorted(missing)}"
        assert not extra, f"{path}: keys not in the contract {sorted(extra)}"
        for k, sub in spec.items():
            name = k.rstrip("?")
            if name in value:
                check(value[name], sub, f"{path}.{name}")
    elif isinstance(spec, _Prim):
        ok = {
            "str": lambda v: isinstance(v, str),
            "num": is_num,
            "int": lambda v: isinstance(v, int) and not isinstance(v, bool),
            "bool": lambda v: isinstance(v, bool),
            "utc": lambda v: isinstance(v, str) and bool(UTC_RE.match(v)),
        }[spec.name](value)
        assert ok, f"{path}: expected {spec.name}, got {value!r}"
        if spec.name == "utc":
            parse_utc(value)
    elif isinstance(spec, Lit):
        assert value in spec.values, f"{path}: {value!r} not one of {spec.values}"
    elif isinstance(spec, Nullable):
        if value is not None:
            check(value, spec.inner, path)
    elif isinstance(spec, ListOf):
        assert isinstance(value, list), f"{path}: expected list"
        for i, v in enumerate(value):
            check(v, spec.inner, f"{path}[{i}]")
    elif isinstance(spec, RecordOf):
        assert isinstance(value, dict), f"{path}: expected record"
        for k, v in value.items():
            assert isinstance(k, str), f"{path}: non-string key {k!r}"
            check(v, spec.inner, f"{path}[{k!r}]")
    elif isinstance(spec, Tuple):
        assert isinstance(value, list) and len(value) == len(spec.items), (
            f"{path}: expected tuple of {len(spec.items)}"
        )
        for i, (v, s) in enumerate(zip(value, spec.items, strict=True)):
            check(v, s, f"{path}[{i}]")
    else:  # pragma: no cover
        raise TypeError(f"bad spec at {path}: {spec!r}")


# ---------------------------------------------------------------------------
# Schemas: mirror web/src/contracts.ts
# ---------------------------------------------------------------------------

STATION = {
    "key": STR,
    "name": STR,
    "river": STR,
    "role": Lit("upstream", "target"),
    "ref": STR,
    "lat": NUM,
    "lon": NUM,
    "amber": NUM,
    "threshold": Nullable(NUM),
    "record": Nullable(NUM),
}
SPOT = {
    "key": STR,
    "name": STR,
    "gauge": STR,
    "threshold": NUM,
    "amber": NUM,
    "lat": NUM,
    "lon": NUM,
    "warningArea": STR,
    "mode": Lit("probability", "timing_only"),
}
EVENT_META = {"id": STR, "name": STR, "start": UTC, "end": UTC, "peak": RecordOf(NUM), "headline": BOOL}
P10_MED_P90 = {"p10": NUM, "median": NUM, "p90": NUM}
TRAVEL_PAIR = {
    "up": STR,
    "down": STR,
    "n": INT,
    "tHalf": P10_MED_P90,
    "tPeak": P10_MED_P90,
    "events": ListOf(
        {"eventId": STR, "tHalf": Nullable(NUM), "tPeak": Nullable(NUM), "rise": NUM, "excluded?": STR}
    ),
    "xcorr": ListOf({"lagH": NUM, "r": NUM}),
    "slopeHoursPerMetre": Nullable(NUM),
}
SPOT_FORECAST = {
    "spot": STR,
    "levelNow": NUM,
    "leads": ListOf({"h": NUM, "q": {k: NUM for k in QUANT_KEYS}, "pFlood": Nullable(NUM), "pAmber": NUM}),
    "arrival": Nullable({"p10": Nullable(UTC), "p50": Nullable(UTC), "p90": Nullable(UTC)}),
    "mode": Lit("probability", "timing_only"),
}
FORECAST = {
    "issuedAt": UTC,
    "dataAsOf": RecordOf(UTC),
    "stale": ListOf(STR),
    "spots": ListOf(SPOT_FORECAST),
    "method?": Lit("model", "persistence"),
    "note?": STR,
}
REPLAY = {
    "eventId": STR,
    "name": STR,
    "start": UTC,
    "end": UTC,
    "observed": RecordOf(ListOf({"t": UTC, "level": NUM})),
    "forecasts": ListOf(FORECAST),
    "official": ListOf(
        {
            "spot": STR,
            "type": Lit("alert", "warning", "severe"),
            "issuedAt": UTC,
            "precision": Lit("time", "date"),
        }
    ),
    "crossings": ListOf({"spot": STR, "t": UTC}),
}
PROOF = {
    "skillByLead": ListOf({"h": NUM, "pinballModel": NUM, "pinballPersistence": NUM, "skill": NUM}),
    "coverage": ListOf({"h": NUM, "nominal": NUM, "actual": NUM}),
    "reliability": RecordOf(
        ListOf(
            {
                "h": NUM,
                "bins": ListOf({"pPred": NUM, "pObs": NUM, "n": NUM}),
                "brier": NUM,
                "brierPersistence": NUM,
            }
        )
    ),
    "tradeoff": RecordOf(
        ListOf(
            {
                "pStar": NUM,
                "hits": NUM,
                "misses": NUM,
                "falseAlarms": NUM,
                "meanLeadH": Nullable(NUM),
                "meanLeadVsOfficialH": Nullable(NUM),
                "ci90?": Tuple(NUM, NUM),
            }
        )
    ),
    "perEvent": ListOf(
        {
            "eventId": STR,
            "spot": STR,
            "crossed": BOOL,
            "peakObs": NUM,
            "arrivalErrH": Nullable(NUM),
            "leadVsOfficialH": Nullable(NUM),
        }
    ),
    "testPeriodNote": STR,
}
QUALITY = {
    "gauges": ListOf(
        {
            "key": STR,
            "coveragePct": NUM,
            "gapsFilled": NUM,
            "gapsFlagged": NUM,
            "spikesRemoved": NUM,
            "thresholdApi": Nullable(NUM),
            "thresholdConfig": Nullable(NUM),
            "notes": ListOf(STR),
        }
    ),
    "sources": ListOf({"name": STR, "url": STR, "licence": STR, "downloadedAt": UTC, "rows": NUM}),
}
IMPORTANCE = RecordOf(ListOf({"h": NUM, "features": ListOf({"name": STR, "gain": NUM})}))

# Stretch (SPEC §11)
RISK_LAYERS = {
    "layers": ListOf(
        {
            "id": STR,
            "name": STR,
            "type": Lit("wms", "geojson"),
            "url": STR,
            "attribution": STR,
            "legend": ListOf({"label": STR, "colour": STR}),
        }
    )
}
ENSEMBLE_RAIN = {
    "issuedAt": UTC,
    "points": ListOf(STR),
    "hours": ListOf(NUM),
    "cumMm": {"p10": ListOf(NUM), "p50": ListOf(NUM), "p90": ListOf(NUM)},
}
SPREAD_MANIFEST = {
    "bounds": Tuple(Tuple(NUM, NUM), Tuple(NUM, NUM)),
    "runs": NUM,
    "frames": ListOf({"tau": NUM, "issuedAt": UTC, "png": STR}),
    "validation": Nullable({"eventId": STR, "iou": NUM}),
    "caveats": ListOf(STR),
}
SANDBAGS = {
    "issuedAt": UTC,
    "budget": NUM,
    "candidates": ListOf(
        {
            "id": STR,
            "lat": NUM,
            "lon": NUM,
            "score": NUM,
            "pWet48": NUM,
            "medianDepthM": NUM,
            "firstWet": Nullable(UTC),
            "bags": NUM,
            "reasons": ListOf(STR),
            "checks": ListOf(STR),
        }
    ),
    "excluded": ListOf({"id": STR, "reason": STR}),
}

# ---------------------------------------------------------------------------
# Loading and shared reference data
# ---------------------------------------------------------------------------


def load(rel: str) -> Any:
    return json.loads((FIXTURES / rel).read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def stations() -> dict[str, dict]:
    return {s["key"]: s for s in load("stations.json")}


@pytest.fixture(scope="module")
def spots() -> dict[str, dict]:
    return {s["key"]: s for s in load("spots.json")}


@pytest.fixture(scope="module")
def events() -> dict[str, dict]:
    return {e["id"]: e for e in load("events.json")}


# ---------------------------------------------------------------------------
# Semantic helpers
# ---------------------------------------------------------------------------


def assert_prob(p: float, path: str) -> None:
    assert -EPS <= p <= 1 + EPS, f"{path}: probability {p} outside [0, 1]"


def assert_non_decreasing(xs: list[float], path: str) -> None:
    for a, b in pairwise(xs):
        assert b >= a - EPS, f"{path}: not non-decreasing: {xs}"


def assert_strictly_increasing(xs: list, path: str) -> None:
    for a, b in pairwise(xs):
        assert b > a, f"{path}: not strictly increasing at {a!r} -> {b!r}"


def assert_unique(xs: list, path: str) -> None:
    dupes = {x for x in xs if xs.count(x) > 1}
    assert not dupes, f"{path}: duplicates {sorted(dupes)}"


def assert_known(keys, known, path: str) -> None:
    unknown = set(keys) - set(known)
    assert not unknown, f"{path}: unknown keys {sorted(unknown)}"


def assert_close(a: float, b: float, tol: float, path: str) -> None:
    assert abs(a - b) <= tol, f"{path}: {a} != {b} (tol {tol})"


def check_arrival_probability(sf: dict, issued: datetime, path: str) -> None:
    """probability spot: arrival p{x} is set iff some lead reaches x, and falls
    between issue time and the first lead that reaches x (SPEC §7.5 step 5)."""
    hs = [lead["h"] for lead in sf["leads"]]
    ps = [lead["pFlood"] for lead in sf["leads"]]
    for key, x in (("p10", 0.1), ("p50", 0.5), ("p90", 0.9)):
        reached = [h for h, p in zip(hs, ps, strict=True) if p >= x - EPS]
        value = sf["arrival"][key]
        if not reached:
            assert value is None, f"{path}.arrival.{key}: set but no lead reaches {x}"
            continue
        assert value is not None, f"{path}.arrival.{key}: null but pFlood reaches {x} by {reached[0]} h"
        t = parse_utc(value)
        assert issued <= t <= issued + timedelta(hours=reached[0]), (
            f"{path}.arrival.{key}: {value} out of range"
        )


def check_arrival_timing_only(sf: dict, spot: dict, issued: datetime, path: str) -> None:
    """timing_only spot: p50 = when the median forecast reaches amber (set iff it
    does); p10 <= p50 <= p90 wherever set (SPEC §7.5 step 6)."""
    meds = [(lead["h"], lead["q"]["50"]) for lead in sf["leads"]]
    reached = [h for h, v in meds if v >= spot["amber"] - EPS]
    p50 = sf["arrival"]["p50"]
    if reached:
        assert p50 is not None, f"{path}.arrival.p50: null but median reaches amber by {reached[0]} h"
        assert issued <= parse_utc(p50) <= issued + timedelta(hours=reached[0]), (
            f"{path}.arrival.p50 out of range"
        )
    else:
        assert p50 is None, f"{path}.arrival.p50: set but median never reaches amber"
    times = [parse_utc(sf["arrival"][k]) for k in ("p10", "p50", "p90") if sf["arrival"][k] is not None]
    assert times == sorted(times), f"{path}.arrival: p10 <= p50 <= p90 violated"


def check_spot_forecast(sf: dict, spots: dict, issued: datetime, path: str) -> None:
    assert sf["spot"] in spots, f"{path}.spot: unknown spot {sf['spot']!r}"
    spot = spots[sf["spot"]]
    assert sf["mode"] == spot["mode"], f"{path}.mode: {sf['mode']} != spots.json {spot['mode']}"
    if not sf["leads"]:
        assert sf["arrival"] is None, f"{path}: no leads but arrival is set"
        return
    hs = [lead["h"] for lead in sf["leads"]]
    assert hs == LEADS, f"{path}.leads: h must be {LEADS}, got {hs}"
    for i, lead in enumerate(sf["leads"]):
        lp = f"{path}.leads[{i}]"
        assert_non_decreasing([lead["q"][k] for k in QUANT_KEYS], f"{lp}.q")
        assert_prob(lead["pAmber"], f"{lp}.pAmber")
        if spot["mode"] == "timing_only":
            assert lead["pFlood"] is None, f"{lp}.pFlood: must be null for a timing_only spot"
        else:
            assert lead["pFlood"] is not None, f"{lp}.pFlood: null for a probability spot"
            assert_prob(lead["pFlood"], f"{lp}.pFlood")
            # threshold > amber, so flooding is never more likely than reaching amber
            assert lead["pFlood"] <= lead["pAmber"] + EPS, f"{lp}: pFlood > pAmber"
    assert_non_decreasing([lead["pAmber"] for lead in sf["leads"]], f"{path}.leads[*].pAmber")
    assert sf["arrival"] is not None, f"{path}.arrival: null although leads are present"
    if spot["mode"] == "probability":
        assert_non_decreasing([lead["pFlood"] for lead in sf["leads"]], f"{path}.leads[*].pFlood")
        check_arrival_probability(sf, issued, path)
    else:
        check_arrival_timing_only(sf, spot, issued, path)


def check_forecast(fc: dict, stations: dict, spots: dict, path: str) -> None:
    check(fc, FORECAST, path)
    issued = parse_utc(fc["issuedAt"])
    assert_known(fc["dataAsOf"], stations, f"{path}.dataAsOf")
    assert_known(fc["stale"], stations, f"{path}.stale")
    for g, t in fc["dataAsOf"].items():
        assert parse_utc(t) <= issued, f"{path}.dataAsOf[{g}]: reading after issuedAt (future data)"
    assert_unique([sf["spot"] for sf in fc["spots"]], f"{path}.spots")
    for i, sf in enumerate(fc["spots"]):
        sp = f"{path}.spots[{i}]"
        check_spot_forecast(sf, spots, issued, sp)
        if spots[sf["spot"]]["gauge"] in fc["stale"]:
            assert sf["leads"] == [], f"{sp}: gauge is stale, so leads must be []"


# ---------------------------------------------------------------------------
# Tests: core contracts (SPEC §9)
# ---------------------------------------------------------------------------

EXPECTED_FILES = [
    "stations.json",
    "spots.json",
    "events.json",
    "travel_times.json",
    "live.json",
    "replays/e2014.json",
    "proof.json",
    "quality.json",
    "importance.json",
    "stretch/geo/risk_layers.json",
    "stretch/ensemble_rain.json",
    "stretch/spread/e2014/manifest.json",
    "stretch/sandbags.json",
]


@pytest.mark.parametrize("rel", EXPECTED_FILES)
def test_fixture_exists_and_is_json(rel: str) -> None:
    assert (FIXTURES / rel).is_file(), f"missing fixture {rel}"
    load(rel)


def test_fixtures_folder_is_small() -> None:
    total = sum(p.stat().st_size for p in FIXTURES.rglob("*") if p.is_file())
    assert total < 1_000_000, f"fixtures total {total} bytes; keep well under 1 MB"


def test_every_contract_type_is_exported_from_contracts_ts() -> None:
    ts = CONTRACTS_TS.read_text(encoding="utf-8")
    for name in [
        "Station",
        "Spot",
        "EventMeta",
        "TravelPair",
        "QuantKey",
        "SpotForecast",
        "Forecast",
        "Replay",
        "Proof",
        "Quality",
        "Importance",
        "RiskLayers",
        "EnsembleRain",
        "SpreadManifest",
        "Sandbags",
    ]:
        assert re.search(rf"^export type {name}\b", ts, re.M), f"contracts.ts does not export type {name}"


def test_stations(stations: dict) -> None:
    data = load("stations.json")
    check(data, ListOf(STATION), "stations")
    assert_unique([s["key"] for s in data], "stations[*].key")
    for s in data:
        p = f"stations[{s['key']}]"
        assert 51.6 < s["lat"] < 52.0 and -1.5 < s["lon"] < -1.1, f"{p}: not near Oxford"
        if s["threshold"] is not None:
            assert s["threshold"] > s["amber"], f"{p}: threshold must be above amber"
        if s["record"] is not None:
            assert s["record"] > s["amber"], f"{p}: record must be above amber"
    assert "osney" in stations and stations["osney"]["role"] == "target"


def test_spots(spots: dict, stations: dict) -> None:
    data = load("spots.json")
    check(data, ListOf(SPOT), "spots")
    assert_unique([s["key"] for s in data], "spots[*].key")
    for s in data:
        p = f"spots[{s['key']}]"
        assert s["gauge"] in stations, f"{p}.gauge: unknown station {s['gauge']!r}"
        st = stations[s["gauge"]]
        assert s["amber"] == st["amber"], f"{p}.amber differs from its station"
        assert s["threshold"] == st["threshold"], f"{p}.threshold differs from its station"
        assert s["threshold"] > s["amber"], f"{p}: threshold must be above amber"
    assert any(s["mode"] == "timing_only" for s in data), "fixture should include a timing_only spot"


def test_events(events: dict, stations: dict) -> None:
    data = load("events.json")
    check(data, ListOf(EVENT_META), "events")
    assert_unique([e["id"] for e in data], "events[*].id")
    for e in data:
        assert parse_utc(e["start"]) < parse_utc(e["end"]), f"events[{e['id']}]: start must be before end"
        assert_known(e["peak"], stations, f"events[{e['id']}].peak")
    assert [e["id"] for e in data if e["headline"]] == ["e2014"], "exactly one headline event (e2014)"
    assert events["e2014"]["peak"]["osney"] == 3.97
    assert events["e2026"]["peak"]["osney"] == 3.41


def test_travel_times(stations: dict, events: dict) -> None:
    data = load("travel_times.json")
    check(data, ListOf(TRAVEL_PAIR), "travel_times")
    assert_unique([(t["up"], t["down"]) for t in data], "travel_times[*] (up, down)")
    for t in data:
        p = f"travel_times[{t['up']}->{t['down']}]"
        assert t["up"] in stations and t["down"] in stations, f"{p}: unknown gauge"
        assert t["up"] != t["down"], f"{p}: up == down"
        for k in ("tHalf", "tPeak"):
            assert_non_decreasing([t[k]["p10"], t[k]["median"], t[k]["p90"]], f"{p}.{k}")
        used = [e for e in t["events"] if "excluded" not in e]
        assert t["n"] == len(used), f"{p}.n: {t['n']} != {len(used)} non-excluded events"
        for e in t["events"]:
            assert e["eventId"] in events, f"{p}: unknown event {e['eventId']!r}"
            for k in ("tHalf", "tPeak"):
                if e[k] is not None:
                    assert 0 < e[k] < 168, f"{p}.{e['eventId']}.{k}: {e[k]} outside (0, 168) h"
        lags = [x["lagH"] for x in t["xcorr"]]
        assert_strictly_increasing(lags, f"{p}.xcorr.lagH")
        assert 0 <= lags[0] and lags[-1] <= 120, f"{p}.xcorr: lags outside 0-120 h"
        for x in t["xcorr"]:
            assert -1 <= x["r"] <= 1, f"{p}.xcorr: r={x['r']}"


def test_live_forecast(stations: dict, spots: dict) -> None:
    fc = load("live.json")
    check_forecast(fc, stations, spots, "live")
    issued = parse_utc(fc["issuedAt"])
    for g, t in fc["dataAsOf"].items():
        age = issued - parse_utc(t)
        if g in fc["stale"]:
            assert age > STALE_AFTER, f"live.stale lists {g} but its reading is only {age} old"
        else:
            assert age <= STALE_AFTER, f"live.dataAsOf[{g}] is {age} old but not listed in stale"
    # Fixture coverage: clocks go back 2026-10-25 01:00 UTC; times must straddle it (SPEC §16).
    lo, hi = parse_utc("2026-10-25T00:30:00Z"), parse_utc("2026-10-25T02:30:00Z")
    assert any(lo <= parse_utc(t) <= hi for t in fc["dataAsOf"].values()), "no dataAsOf in the DST window"
    assert fc["stale"], "fixture should list one stale gauge"
    modes = {sf["mode"] for sf in fc["spots"] if sf["leads"]}
    assert modes == {"probability", "timing_only"}, "fixture should exercise both modes"


def test_replay_e2014(stations: dict, spots: dict, events: dict) -> None:
    r = load("replays/e2014.json")
    check(r, REPLAY, "replay")
    assert r["eventId"] in events
    start, end = parse_utc(r["start"]), parse_utc(r["end"])
    assert start < end
    assert_known(r["observed"], stations, "replay.observed")
    obs: dict[str, dict[datetime, float]] = {}
    for g, series in r["observed"].items():
        ts = [parse_utc(p["t"]) for p in series]
        assert ts, f"replay.observed[{g}] is empty"
        assert all(b - a == timedelta(hours=1) for a, b in pairwise(ts)), f"replay.observed[{g}] not hourly"
        assert start <= ts[0] and ts[-1] <= end, f"replay.observed[{g}] outside the replay window"
        obs[g] = {t: p["level"] for t, p in zip(ts, series, strict=True)}

    issued = [parse_utc(f["issuedAt"]) for f in r["forecasts"]]
    assert issued, "replay has no forecasts"
    assert_strictly_increasing(issued, "replay.forecasts[*].issuedAt")
    assert start <= issued[0] and issued[-1] <= end
    for i, fc in enumerate(r["forecasts"]):
        p = f"replay.forecasts[{i}]"
        check_forecast(fc, stations, spots, p)
        for sf in fc["spots"]:
            g = spots[sf["spot"]]["gauge"]
            t = parse_utc(fc["issuedAt"])
            if g in obs and t in obs[g]:
                assert_close(sf["levelNow"], obs[g][t], 1e-6, f"{p}.{sf['spot']}.levelNow vs observed")

    for o in r["official"]:
        assert o["spot"] in spots, f"replay.official: unknown spot {o['spot']!r}"
    for c in r["crossings"]:
        assert c["spot"] in spots, f"replay.crossings: unknown spot {c['spot']!r}"
    crossed = {c["spot"]: parse_utc(c["t"]) for c in r["crossings"]}
    # Each crossing agrees with the observed series of its spot's gauge.
    for key, spot in spots.items():
        g = spot["gauge"]
        if g not in obs:
            continue
        above = [t for t, v in sorted(obs[g].items()) if v >= spot["threshold"]]
        if key in crossed:
            assert above and crossed[key] == above[0], (
                f"replay.crossings[{key}]: not the first hour above threshold"
            )
        elif obs[g][min(obs[g])] < spot["threshold"]:  # starts below, so any rise above is a crossing
            assert not above, f"replay: {key} observed above threshold but no crossing listed"
    assert "osney" in crossed, "fixture should include an osney crossing"


def test_proof(spots: dict, events: dict) -> None:
    pr = load("proof.json")
    check(pr, PROOF, "proof")
    assert [s["h"] for s in pr["skillByLead"]] == LEADS
    for s in pr["skillByLead"]:
        assert s["pinballPersistence"] > 0
        assert_close(
            s["skill"], 1 - s["pinballModel"] / s["pinballPersistence"], 0.005, f"proof.skill h={s['h']}"
        )

    cells = [(c["h"], c["nominal"]) for c in pr["coverage"]]
    assert_unique(cells, "proof.coverage (h, nominal)")
    assert set(cells) == {(h, n) for h in LEADS for n in (0.5, 0.8, 0.9)}, (
        "coverage needs every interval x lead"
    )
    for c in pr["coverage"]:
        assert_prob(c["actual"], f"proof.coverage h={c['h']}")

    assert_known(pr["reliability"], spots, "proof.reliability")
    assert "osney" in pr["reliability"]
    for spot, rows in pr["reliability"].items():
        assert_known([r["h"] for r in rows], LEADS, f"proof.reliability[{spot}].h")
        for row in rows:
            p = f"proof.reliability[{spot}] h={row['h']}"
            assert len(row["bins"]) == 10, f"{p}: expected 10 bins"
            for b in row["bins"]:
                assert_prob(b["pPred"], p)
                assert_prob(b["pObs"], p)
                assert b["n"] >= 0
            assert_prob(row["brier"], p)
            assert_prob(row["brierPersistence"], p)

    assert_known(pr["tradeoff"], spots, "proof.tradeoff")
    p_stars = [round(0.1 * i, 1) for i in range(1, 10)]
    for spot, rows in pr["tradeoff"].items():
        p = f"proof.tradeoff[{spot}]"
        assert [r["pStar"] for r in rows] == p_stars, f"{p}: pStar must be 0.1 ... 0.9"
        assert len({r["hits"] + r["misses"] for r in rows}) == 1, f"{p}: hits + misses must be constant"
        for r in rows:
            assert min(r["hits"], r["misses"], r["falseAlarms"]) >= 0
            if "ci90" in r:
                assert r["ci90"][0] <= r["ci90"][1], f"{p}: ci90 low > high"

    for row in pr["perEvent"]:
        p = f"proof.perEvent[{row['eventId']}/{row['spot']}]"
        assert row["eventId"] in events, f"{p}: unknown event"
        assert row["spot"] in spots, f"{p}: unknown spot"
        spot = spots[row["spot"]]
        assert row["crossed"] == (row["peakObs"] >= spot["threshold"]), f"{p}: crossed disagrees with peakObs"
        peak = events[row["eventId"]]["peak"].get(spot["gauge"])
        if peak is not None:
            assert_close(row["peakObs"], peak, 1e-6, f"{p}: peakObs vs events.json")
        if not row["crossed"]:
            assert row["arrivalErrH"] is None, f"{p}: arrival error without a crossing"
    near_miss = [r for r in pr["perEvent"] if r["eventId"] == "e2026" and r["spot"] == "osney"]
    assert near_miss and near_miss[0]["crossed"] is False and near_miss[0]["peakObs"] == 3.41


def test_quality(stations: dict) -> None:
    q = load("quality.json")
    check(q, QUALITY, "quality")
    assert_known([g["key"] for g in q["gauges"]], stations, "quality.gauges")
    for g in q["gauges"]:
        p = f"quality.gauges[{g['key']}]"
        assert 0 <= g["coveragePct"] <= 100, f"{p}.coveragePct"
        assert min(g["gapsFilled"], g["gapsFlagged"], g["spikesRemoved"]) >= 0, f"{p}: negative count"
    for s in q["sources"]:
        assert s["url"].startswith("https://") and s["rows"] >= 0


def test_importance(stations: dict) -> None:
    imp = load("importance.json")
    check(imp, IMPORTANCE, "importance")
    assert_known(imp, stations, "importance")
    for g, rows in imp.items():
        assert_known([r["h"] for r in rows], LEADS, f"importance[{g}].h")
        for r in rows:
            assert all(f["gain"] >= 0 for f in r["features"]), f"importance[{g}] h={r['h']}: negative gain"


# ---------------------------------------------------------------------------
# Tests: stretch contracts (SPEC §11)
# ---------------------------------------------------------------------------


def test_stretch_risk_layers() -> None:
    d = load("stretch/geo/risk_layers.json")
    check(d, RISK_LAYERS, "risk_layers")
    assert_unique([layer["id"] for layer in d["layers"]], "risk_layers.layers[*].id")
    for layer in d["layers"]:
        for item in layer["legend"]:
            assert re.match(r"^#[0-9a-fA-F]{6}$", item["colour"]), (
                f"risk_layers: bad colour {item['colour']!r}"
            )


def test_stretch_ensemble_rain() -> None:
    d = load("stretch/ensemble_rain.json")
    check(d, ENSEMBLE_RAIN, "ensemble_rain")
    assert_strictly_increasing(d["hours"], "ensemble_rain.hours")
    cum = d["cumMm"]
    for k in ("p10", "p50", "p90"):
        assert len(cum[k]) == len(d["hours"]), f"ensemble_rain.cumMm.{k}: length != hours"
        assert_non_decreasing(cum[k], f"ensemble_rain.cumMm.{k} (cumulative)")
    for i in range(len(d["hours"])):
        assert_non_decreasing([cum["p10"][i], cum["p50"][i], cum["p90"][i]], f"ensemble_rain.cumMm[{i}]")


def test_stretch_spread_manifest() -> None:
    d = load("stretch/spread/e2014/manifest.json")
    check(d, SPREAD_MANIFEST, "spread_manifest")
    (lat_s, lon_w), (lat_n, lon_e) = d["bounds"]
    assert lat_s < lat_n and lon_w < lon_e, "spread.bounds must be [[latS, lonW], [latN, lonE]]"
    assert_known([f["tau"] for f in d["frames"]], LEADS, "spread.frames.tau")
    if d["validation"] is not None:
        assert 0 <= d["validation"]["iou"] <= 1


def test_stretch_sandbags() -> None:
    d = load("stretch/sandbags.json")
    check(d, SANDBAGS, "sandbags")
    for c in d["candidates"]:
        assert_prob(c["pWet48"], f"sandbags[{c['id']}].pWet48")
        assert 0 <= c["score"] <= 1 and c["bags"] >= 0 and c["medianDepthM"] <= 0.5
    assert sum(c["bags"] for c in d["candidates"]) <= d["budget"], "sandbags: candidates exceed the budget"
