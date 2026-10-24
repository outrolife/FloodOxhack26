"""Map v3 river paths (#152): snapping and downstream ordering on a tiny synthetic network."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "web" / "scripts" / "build_river_paths.py"
_spec = importlib.util.spec_from_file_location("build_river_paths", SCRIPT)
brp = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
_spec.loader.exec_module(brp)


def way(wid: int, nodes: list[int], pts: list[tuple[float, float]], name: str,
        waterway: str = "river") -> dict:
    return {
        "type": "way",
        "id": wid,
        "nodes": nodes,
        "geometry": [{"lon": lon, "lat": lat} for lon, lat in pts],
        "tags": {"waterway": waterway, "name": name},
    }


# A tributary ("River Trib", flowing east) joins a main river ("River Main", flowing south) at node 3.
# An unnamed side channel runs right next to the gauge on the tributary, to test name-based snapping.
# "River Main" lower reach (way 4) starts 20 m away from the confluence node: an OSM gap to bridge.
OSM = {
    "elements": [
        way(1, [1, 2, 3], [(-1.30, 51.80), (-1.30, 51.79), (-1.30, 51.78)], "River Main"),
        way(2, [10, 11, 3], [(-1.33, 51.78), (-1.315, 51.78), (-1.30, 51.78)], "River Trib"),
        way(3, [20, 21], [(-1.32, 51.7801), (-1.31, 51.7801)], ""),
        way(4, [30, 31, 32], [(-1.30, 51.7798), (-1.30, 51.77), (-1.30, 51.76)], "River Main"),
        # A navigation canal straight from the tributary to the bottom must not be used.
        way(5, [10, 32], [(-1.33, 51.78), (-1.30, 51.76)], "Some Canal", "canal"),
    ]
}


def test_snaps_to_own_river_by_name() -> None:
    g = brp.graph_from_osm(OSM)
    # The gauge sits 2 m from the unnamed channel and 9 m from River Trib.
    (vid,) = g.snap_points([((-1.32, 51.78008), "Trib")])
    assert vid is not None and vid < 0
    lon, lat = g.xy[vid]
    assert abs(lat - 51.78) < 1e-6 and abs(lon + 1.32) < 1e-6


def test_path_follows_network_and_is_ordered_downstream() -> None:
    g = brp.graph_from_osm(OSM)
    up, down = g.snap_points([((-1.32, 51.78), "River Trib"), ((-1.3001, 51.765), "Main")])
    path = g.shortest(up, down, allow_reverse=False)
    assert path is not None
    pts = g.path_points(path)
    assert pts[0] == g.xy[up] and pts[-1] == g.xy[down]
    # East along the tributary to the confluence, then south (through the bridged gap), not via the canal.
    assert any(abs(p[0] + 1.30) < 1e-9 and abs(p[1] - 51.78) < 1e-9 for p in pts)
    lats = [p[1] for p in pts]
    assert lats == sorted(lats, reverse=True)
    # Upstream is not reachable from downstream without going against the flow.
    assert g.shortest(down, up, allow_reverse=False) is None


def test_two_gauges_on_one_segment_chain_in_order() -> None:
    g = brp.graph_from_osm(OSM)
    a, b = g.snap_points([((-1.30, 51.775), "Main"), ((-1.30, 51.772), "Main")])
    assert g.shortest(a, b, allow_reverse=False) == [a, b]


def test_build_paths_properties_and_fallback() -> None:
    gauges = {
        "top": {"key": "top", "river": "Main", "role": "upstream", "lat": 51.795, "lon": -1.30},
        "trib": {"key": "trib", "river": "Trib", "role": "live_only", "lat": 51.78, "lon": -1.32},
        "bottom": {"key": "bottom", "river": "Main", "role": "target", "lat": 51.765, "lon": -1.30},
        "far": {"key": "far", "river": "Nowhere", "role": "upstream", "lat": 52.5, "lon": -2.5},
    }
    travel = [
        {"up": "top", "down": "bottom", "n": 6, "tHalf": {"median": 4.5}},
        {"up": "far", "down": "bottom", "n": 1, "tHalf": {"median": 30.0}},
    ]
    fc, unrouted = brp.build_paths(OSM, gauges, {}, travel)
    by = {(f["properties"]["up"], f["properties"]["down"]): f for f in fc["features"]}
    assert set(by) == {("top", "bottom"), ("far", "bottom"), ("trib", "bottom")}  # trib found on the network
    p = by[("top", "bottom")]["properties"]
    assert p["travelH"] == 4.5 and p["n"] == 6 and p["confidence"] == "high" and p["routed"] is True
    assert p["progress"][0] == 0 and p["progress"][-1] == 1
    assert len(p["progress"]) == len(by[("top", "bottom")]["geometry"]["coordinates"])
    assert by[("trib", "bottom")]["properties"]["travelH"] is None
    assert by[("far", "bottom")]["properties"]["routed"] is False and unrouted == ["far->bottom"]
    json.dumps(fc)  # serialisable


def test_line_merge_joins_chains() -> None:
    merged = brp.line_merge([[1, 2, 3], [5, 4, 3], [5, 6]])
    assert merged == [[1, 2, 3, 4, 5, 6]]


def test_committed_files_meet_the_contract() -> None:
    geo = ROOT / "web" / "public" / "data" / "geo"
    paths = json.loads((geo / "river-paths.geojson").read_text())
    rivers = json.loads((geo / "catchment-rivers.geojson").read_text())
    assert (geo / "river-paths.geojson").stat().st_size <= 1_000_000
    assert (geo / "catchment-rivers.geojson").stat().st_size <= 1_500_000
    for f in paths["features"]:
        p = f["properties"]
        assert {"up", "down", "travelH", "n", "confidence"} <= set(p)
        assert p["confidence"] in ("high", "low")
        assert f["geometry"]["type"] == "LineString" and len(f["geometry"]["coordinates"]) >= 2
    for f in rivers["features"]:
        assert f["properties"]["kind"] in ("river", "stream") and f["properties"]["name"]
