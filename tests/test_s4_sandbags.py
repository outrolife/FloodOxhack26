"""S4 sandbag screening (SPEC §11 S4): synthetic S3 grid plus a few rectangles, no network.

The selection and contract tests are pure Python. The geometry tests need the ``stretch`` extra
(shapely, pyproj, rasterio) and are skipped without it.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import pytest
from test_fixtures import SANDBAGS, check

from stretch.s4 import screen as s4

ISSUED = datetime(2014, 1, 5, tzinfo=UTC)
TAUS = [6, 12, 24, 36, 48, 72]
PUBLIC = Path(__file__).resolve().parent.parent / "web" / "public" / "data" / "spread"

CELL = 5.0
NX, NY = 80, 20  # 400 m x 100 m; x0 = 0, north edge y = 100
P = s4.Params()


# ---------------------------------------------------------------------------
# Synthetic S3 grid: vertical bands of cells, each with its own frequency/depth story
# ---------------------------------------------------------------------------

# zone name -> (x range [m), frequency per tau, median depth (m), first tau with freq >= 0.5)
ZONES: dict[str, tuple[tuple[float, float], list[float], float, float]] = {
    "edge": ((0, 50), [0.0, 0.0, 0.6, 0.6, 0.6, 0.7], 0.2, 24),  # good candidate
    "deep": ((50, 100), [0.6, 0.8, 1.0, 1.0, 1.0, 1.0], 0.8, 6),  # too deep (and early)
    "deep_late": ((100, 150), [0.0, 0.0, 1.0, 1.0, 1.0, 1.0], 0.8, 24),  # too deep only
    "early": ((150, 200), [0.9, 0.9, 0.9, 0.9, 0.9, 0.9], 0.1, 6),  # wet in the first 6 h
    "mid": ((200, 250), [0.0, 0.0, 0.0, 0.3, 0.5, 0.6], 0.4, 48),  # score halved
    "late": ((250, 300), [0.0, 0.0, 0.0, 0.0, 0.0, 0.3], 0.1, np.nan),  # only after 48 h
    "dry": ((300, 400), [0.0] * 6, np.nan, np.nan),
}


def make_cells() -> s4.Cells:
    freq = np.zeros((len(TAUS), NY, NX), dtype=np.float32)
    depth = np.full((len(TAUS), NY, NX), np.nan, dtype=np.float32)
    first = np.full((NY, NX), np.nan, dtype=np.float32)
    xc = (np.arange(NX) + 0.5) * CELL
    for (x0, x1), f, d, ft in ZONES.values():
        cols = (xc >= x0) & (xc < x1)
        for k, fk in enumerate(f):
            freq[k][:, cols] = fk
            if fk > 0:
                depth[k][:, cols] = d
        first[:, cols] = ft
    return s4.Cells(ISSUED, np.array(TAUS), freq, depth, first, x0=0.0, y0=NY * CELL, cell=CELL)


def zone_box(zone: str, w: float = 10.0, h: float = 10.0, dx: float = 0.0):
    from shapely.geometry import box

    (x0, x1), *_ = ZONES[zone]
    cx = (x0 + x1) / 2 + dx
    return box(cx - w / 2, 45, cx + w / 2, 45 + h)


@pytest.fixture
def geo():
    pytest.importorskip("shapely")
    pytest.importorskip("pyproj")


def measures(buildings: list[s4.Building], defences: list | None = None) -> dict[str, s4.Measure]:
    return {m.id: m for m in s4.measure(make_cells(), buildings, defences or [], P)}


# ---------------------------------------------------------------------------
# Geometry: candidates, exposure, exclusions
# ---------------------------------------------------------------------------


def test_candidates_need_frequency_02_by_48h(geo) -> None:
    bs = [s4.Building(z, zone_box(z), {"building": "house"}) for z in ("edge", "mid", "late", "dry")]
    ms = measures(bs)
    assert set(ms) == {"edge", "mid"}  # "late" only reaches 0.3 at 72 h; "dry" never
    assert ms["edge"].p_wet48 == pytest.approx(0.6)
    assert ms["edge"].first_tau_h == 24
    assert ms["mid"].p_wet48 == pytest.approx(0.5)


def test_exposed_length_and_bags(geo) -> None:
    ms = measures([s4.Building("a", zone_box("edge"), {"building": "house"})])
    m = ms["a"]
    assert m.perimeter_m == pytest.approx(40.0)
    assert m.exposed_m == pytest.approx(40.0)  # all four walls in wet cells
    assert s4.bags(m, P) == 400  # 40 m x 10 bags per metre


def test_half_wet_building(geo) -> None:
    # Box from x = -10 to 10: the half of its walls outside the grid is never wet.
    from shapely.geometry import box

    ms = measures([s4.Building("a", box(-10, 45, 10, 55), {"building": "house"})])
    assert 0.4 * 60 < ms["a"].exposed_m < 0.7 * 60


def test_party_walls_are_not_exposed(geo) -> None:
    a = s4.Building("a", zone_box("edge", dx=-5), {"building": "terrace"})
    b = s4.Building("b", zone_box("edge", dx=5), {"building": "terrace"})  # shares a's east wall
    ms = measures([a, b])
    assert ms["a"].exposed_m < 35.0  # one 10 m wall of 40 m is shared
    assert ms["a"].exposed_m > 28.0


def test_outbuildings_and_tiny_footprints_are_not_screened(geo) -> None:
    bs = [
        s4.Building("shed", zone_box("edge", dx=-15), {"building": "shed"}),
        s4.Building("tiny", zone_box("edge", w=3, h=3, dx=15), {"building": "yes"}),
        s4.Building("house", zone_box("edge"), {"building": "house"}),
    ]
    assert set(measures(bs)) == {"house"}


def test_hard_exclusions(geo) -> None:
    from shapely.geometry import LineString

    bs = [
        s4.Building(z, zone_box(z), {"building": "house"})
        for z in ("edge", "deep", "deep_late", "early", "mid")
    ]
    wall_x = (ZONES["mid"][0][0] + ZONES["mid"][0][1]) / 2
    fence = LineString([(wall_x - 20, 58), (wall_x + 20, 58)])  # 3 m north of the "mid" house
    doc = s4.screen(make_cells(), list(measures(bs, [fence]).values()), P)
    why = {e["id"]: e["reason"] for e in doc["excluded"]}
    assert set(why) == {"deep", "deep_late", "early", "mid"}
    assert "Median depth 0.80 m > 0.5 m" in why["deep_late"]
    assert "deployment" not in why["deep_late"]  # first wet at +24 h: plenty of time
    assert "Median depth" in why["deep"] and "deployment" in why["deep"]  # both reasons listed
    assert "deployment" in why["early"] and "Median depth" not in why["early"]
    assert "flood defence" in why["mid"]
    assert [c["id"] for c in doc["candidates"]] == ["edge"]


def test_defence_buffer_is_5m(geo) -> None:
    from shapely.geometry import LineString

    b = s4.Building("a", zone_box("edge"), {"building": "house"})
    near = LineString([(0, 61), (50, 61)])  # 6 m north of the wall (box top at y = 55)
    assert not measures([b], [near])["a"].near_defence
    near = LineString([(0, 59), (50, 59)])
    assert measures([b], [near])["a"].near_defence


def test_parse_overpass(geo) -> None:
    sq = [(51.7500, -1.2800), (51.7500, -1.2798), (51.7502, -1.2798), (51.7502, -1.2800), (51.7500, -1.2800)]
    hole = [(51.75005, -1.27995), (51.75005, -1.27985), (51.75015, -1.27985), (51.75015, -1.27995)]

    def geom(pts):
        return [{"lat": a, "lon": b} for a, b in pts]

    doc = {
        "elements": [
            {"type": "way", "id": 1, "tags": {"building": "house"}, "geometry": geom(sq)},
            {
                "type": "relation",
                "id": 2,
                "tags": {"building": "yes", "type": "multipolygon"},
                "members": [
                    {"type": "way", "role": "outer", "geometry": geom(sq)},
                    {"type": "way", "role": "inner", "geometry": geom([*hole, hole[0]])},
                ],
            },
            {"type": "way", "id": 3, "tags": {"wall": "flood_wall"}, "geometry": geom(sq[:2])},
            {"type": "way", "id": 4, "tags": {"building": "yes"}, "geometry": geom(sq[:2])},  # degenerate
        ]
    }
    buildings, defences = s4.parse_overpass(doc)
    assert [b.id for b in buildings] == ["osm-way-1", "osm-relation-2"]
    assert 250 < buildings[0].geom.area < 350  # ~13.8 m x 22.2 m
    assert buildings[1].geom.area < buildings[0].geom.area  # courtyard removed
    assert buildings[0].geom.centroid.x == pytest.approx(450_500, abs=1500)  # BNG easting near Oxford
    assert len(defences) == 1


def test_load_cells_reads_s3_npz(tmp_path: Path) -> None:
    """The ``cells.npz`` layout alfredo-s3 publishes on #22: (I, T, H, W) arrays plus the grid."""
    c = make_cells()
    river = np.zeros((NY, NX), dtype=bool)
    river[:, 0] = True
    path = tmp_path / "cells.npz"
    np.savez_compressed(
        path,
        issued_at=np.array(["2014-01-04T00:00:00Z", "2014-01-05T00:00:00Z"]),
        tau_h=np.array(TAUS),
        freq=np.stack([c.freq * 0, c.freq]),
        median_depth_m=np.stack([c.depth, c.depth]),
        first_tau_h=np.stack([c.first_tau, c.first_tau]),
        transform=np.array([5.0, 0.0, 449000.0, 0.0, -5.0, 207000.0]),
        crs=np.array("EPSG:27700"),
        river=river,
    )
    assert s4.npz_issues(path) == [datetime(2014, 1, 4, tzinfo=UTC), ISSUED]
    got = s4.load_cells(path, ISSUED)
    assert got.issued_at == ISSUED
    assert list(got.taus) == TAUS
    assert (got.x0, got.y0, got.cell) == (449000, 207000, CELL)
    np.testing.assert_array_equal(got.freq, c.freq)  # the second issue, not the first
    np.testing.assert_array_equal(got.first_tau, c.first_tau)
    assert got.river is not None and got.river[:, 0].all() and got.river.sum() == NY
    row, col, inside = got.index(np.array([449002.0, 448990.0]), np.array([206998.0, 206998.0]))
    assert (row[0], col[0], inside.tolist()) == (0, 0, [True, False])
    with pytest.raises(ValueError, match="no issue"):
        s4.load_cells(path, datetime(2014, 1, 6, tzinfo=UTC))


def test_river_cells_are_not_exposure(geo) -> None:
    cells = make_cells()
    cells.river = np.zeros(cells.shape, dtype=bool)
    b = s4.Building("a", zone_box("edge"), {"building": "house"})  # x 20..30, y 45..55
    full = s4.measure(cells, [b], [], P)[0].exposed_m
    cells.river[:, 6] = True  # x 30..35: the east wall's samples (x = 31) sit on the channel
    part = s4.measure(cells, [b], [], P)[0].exposed_m
    assert full == pytest.approx(40.0) and 25.0 < part < 35.0


# ---------------------------------------------------------------------------
# Pure selection logic and the contract
# ---------------------------------------------------------------------------


def m_(id_: str, p: float, exposed: float, depth: float | None = 0.1, first: float | None = 24) -> s4.Measure:
    return s4.Measure(id_, 51.75, -1.28, 40.0, exposed, p, depth, first, False, "house")


def test_score_halves_between_03_and_05m() -> None:
    assert s4.score(m_("a", 0.8, 1, depth=0.30), P) == pytest.approx(0.8)
    assert s4.score(m_("a", 0.8, 1, depth=0.31), P) == pytest.approx(0.4)
    assert s4.exclusion(m_("a", 0.8, 1, depth=0.5), TAUS, P) is None
    assert s4.exclusion(m_("a", 0.8, 1, depth=0.51), TAUS, P) is not None


def test_first_wet_uses_start_of_lead_interval() -> None:
    assert s4.earliest_arrival_h(6, TAUS) == 0
    assert s4.earliest_arrival_h(12, TAUS) == 6
    assert s4.exclusion(m_("a", 0.8, 1, first=6), TAUS, P) is not None
    assert s4.exclusion(m_("a", 0.8, 1, first=12), TAUS, P) is None
    assert s4.exclusion(m_("a", 0.8, 1, first=None), TAUS, P) is None
    later = s4.Params(deploy_h=8)
    assert s4.exclusion(m_("a", 0.8, 1, first=12), TAUS, later) is not None


def test_bags_round_up() -> None:
    assert s4.bags(m_("a", 1, 2.01), P) == 21
    assert s4.bags(m_("a", 1, 2.0), P) == 20
    assert s4.bags(m_("a", 1, 0.01), P) == 1


def test_greedy_respects_budget_and_skips_what_no_longer_fits() -> None:
    items = [("a", 0.9, 300), ("b", 0.8, 100), ("c", 0.5, 250), ("d", 0.4, 50), ("e", 0.1, 40)]
    # score/bags: b .008, d .008 (tie: higher score first), a .003, e .0025, c .002
    assert s4.greedy(items, 500) == ["b", "d", "a", "e"]  # c (250) no longer fits in the last 10
    assert s4.greedy(items, 99) == ["d", "e"]
    assert s4.greedy(items, 0) == []


def test_screen_top5_by_score_within_budget_and_contract() -> None:
    ms = [
        m_("big", 0.95, 60.0),  # 600 bags: never fits in 500
        m_("p9", 0.9, 10.0),  # 100 bags
        m_("p8", 0.8, 5.0),  # 50
        m_("p7", 0.7, 20.0),  # 200
        m_("p6", 0.6, 1.0),  # 10
        m_("p5", 0.5, 1.0),  # 10
        m_("p4", 0.4, 1.0),  # 10
        m_("deep", 0.99, 1.0, depth=0.7),
        m_("halved", 0.9, 1.0, depth=0.4),  # score 0.45, 10 bags
    ]
    cells = make_cells()
    doc = s4.screen(cells, ms, P)
    check(doc, SANDBAGS, "sandbags")
    assert doc["issuedAt"] == "2014-01-05T00:00:00Z" and doc["budget"] == 500
    ids = [c["id"] for c in doc["candidates"]]
    assert ids == ["p9", "p8", "p7", "p6", "p5"]  # "big" doesn't fit; top 5 by score of the rest
    assert sum(c["bags"] for c in doc["candidates"]) <= 500
    assert [e["id"] for e in doc["excluded"]] == ["deep"]
    c = doc["candidates"][0]
    assert c["firstWet"] == "2014-01-06T00:00:00Z"
    assert c["checks"] == [
        "Door and sill height",
        "Access for delivery",
        "Owner permission",
        "Risk of diverting water to neighbours",
    ]
    assert any("assumption" in r for r in c["reasons"])
    small = s4.screen(cells, ms, s4.Params(budget=120))
    assert sum(c["bags"] for c in small["candidates"]) <= 120


def test_screen_halved_score_reason() -> None:
    doc = s4.screen(make_cells(), [m_("h", 0.9, 1.0, depth=0.4, first=None)], P)
    (c,) = doc["candidates"]
    assert c["score"] == pytest.approx(0.45) and c["medianDepthM"] == 0.4 and c["firstWet"] is None
    assert any("score halved" in r for r in c["reasons"])


@pytest.mark.parametrize("path", sorted(PUBLIC.glob("*/sandbags.json")), ids=lambda p: p.parent.name)
def test_published_sandbags_match_contract(path: Path) -> None:
    doc = json.loads(path.read_text(encoding="utf-8"))
    check(doc, SANDBAGS, "sandbags")
    assert len(doc["candidates"]) <= 5
    assert sum(c["bags"] for c in doc["candidates"]) <= doc["budget"]
    for c in doc["candidates"]:
        assert 51.745 <= c["lat"] <= 51.758 and -1.290 <= c["lon"] <= -1.265
        assert 0 < c["pWet48"] <= 1 and c["medianDepthM"] <= 0.5 and c["bags"] >= 1
        assert len(c["checks"]) == 4
