#!/usr/bin/env python3
"""Build the map v3 river layers (#152) from OpenStreetMap waterways.

Writes two files that web/src reads (contract in issue #152):

* web/public/data/geo/catchment-rivers.geojson: the main named waterways of the
  upper Thames catchment above Abingdon (Thames, Windrush, Evenlode, Glyme, Dorn,
  Cherwell, Ray, Swere, Sor Brook and the Oxford streams). One MultiLineString per
  river, ways merged end to end, simplified (Douglas-Peucker, 20 m) and rounded to
  5 dp. Properties: ``name``, ``kind`` (river | stream).
* web/public/data/geo/river-paths.geojson: one LineString per upstream link that
  follows the river network from the up gauge to the down gauge, coordinates
  ordered downstream. Properties: ``up``, ``down``, ``travelH`` (median T_half from
  travel_times.json, or null), ``n`` (events behind it), ``confidence`` ('high' when
  n >= 5, else 'low'), ``routed`` (false = straight-line fallback, OSM gap),
  ``lengthKm`` and ``progress`` (cumulative distance fraction 0..1 per vertex, for
  deck.gl TripsLayer timestamps).

How the paths are found (explainable in one breath): every OSM waterway is a
chain of nodes drawn in the direction of flow (the OSM convention), so the ways
form a directed graph. Each gauge snaps to the nearest point on its own river (by
name, from config/stations.yaml), and Dijkstra finds the shortest downstream route.
Small gaps between ways (< 40 m) are bridged; ways drawn against the flow can be
used at a heavy cost penalty so one bad OSM edit can't break a route.

Pairs: every pair in travel_times.json, every link in the stations.yaml
``flow_paths`` tree, plus any upstream / live_only gauge whose water reaches a
target gauge along the directed network (so new catchment gauges from #146/#125
appear when the script is re-run).

Data (c) OpenStreetMap contributors, ODbL 1.0. One Overpass query, cached in
data/raw/osm/ (gitignored). Standard library plus PyYAML (a project dependency).

Usage: .venv/bin/python web/scripts/build_river_paths.py [--refresh]
   or: uv run --with pyyaml python web/scripts/build_river_paths.py
"""
from __future__ import annotations

import heapq
import json
import math
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / "data" / "raw" / "osm" / "catchment_waterways_overpass.json"
GEO = ROOT / "web" / "public" / "data" / "geo"
OUT_RIVERS = GEO / "catchment-rivers.geojson"
OUT_PATHS = GEO / "river-paths.geojson"
STATIONS = ROOT / "config" / "stations.yaml"
TRAVEL = ROOT / "web" / "public" / "data" / "travel_times.json"
OVERPASS = "https://overpass-api.de/api/interpreter"
ATTRIBUTION = "(c) OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright)"

# south, west, north, east
CATCHMENT = (51.60, -2.05, 52.15, -1.10)
FETCH = (51.58, -2.10, 52.17, -1.05)

SIMPLIFY_RIVERS_M = 20.0
SIMPLIFY_PATHS_M = 15.0
BRIDGE_M = 40.0          # join a dangling way end to another way within this distance
SNAP_NAMED_M = 600.0     # gauge -> its own (named) river
SNAP_ANY_M = 300.0       # gauge -> any waterway, if no named match
UNNAMED_COST = 1.3       # prefer named channels over unnamed side channels
REVERSE_COST = 8.0       # using a way against its drawn direction (OSM error) is expensive
MAX_AUTO_KM = 150.0      # auto-discovered links longer than this are ignored

# (display name, kind, regex on the OSM name). Order = drawing order (streams first).
RIVERS: list[tuple[str, str, str]] = [
    ("Castle Mill Stream", "stream", r"^Castle Mill Stream$"),
    ("Bulstake Stream", "stream", r"^Bulstake Stream$"),
    ("Seacourt Stream", "stream", r"^Seacourt Stream$"),
    ("Hinksey Stream", "stream", r"^Hinksey Stream$"),
    ("Sor Brook", "stream", r"^Sor Brook$"),
    ("River Swere", "stream", r"^River Swere$"),
    ("River Dorn", "stream", r"^River Dorn$"),
    ("River Glyme", "stream", r"^River Glyme$"),
    ("River Ray", "river", r"^(New )?River Ray$"),
    ("River Cherwell", "river", r"^(River )?Cherwell$"),
    ("River Evenlode", "river", r"^River Evenlode$"),
    ("River Windrush", "river", r"^(River )?Windrush\b"),
    ("River Thames", "river", r"^River Thames$"),
]

QUERY = f"""
[out:json][timeout:300];
(
  way["waterway"="river"]({FETCH[0]},{FETCH[1]},{FETCH[2]},{FETCH[3]});
  way["waterway"~"^(stream|canal|drain|ditch)$"]["name"~"Seacourt|Bulstake|Hinksey|Castle Mill|Sor Brook|Swere|Glyme|Dorn|Evenlode|Windrush|Cherwell|Ray|Thames|Mill Stream|Wolvercote|Osney|Botley|Weirs|Shire Lake|Back Stream|Fisher Row|Oxpens|Trill Mill|Duke's Cut"]({FETCH[0]},{FETCH[1]},{FETCH[2]},{FETCH[3]});
);
out geom;
"""


# ----------------------------------------------------------------------------- fetch


def fetch(refresh: bool = False) -> dict:
    if CACHE.exists() and not refresh:
        return json.loads(CACHE.read_text())
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    data = urllib.parse.urlencode({"data": QUERY}).encode()
    ua = "RiverClock-OxHack26/1.0 (hackathon map v3)"
    req = urllib.request.Request(OVERPASS, data=data, headers={"User-Agent": ua})
    try:
        with urllib.request.urlopen(req, timeout=400) as r:
            raw = r.read()
    except urllib.error.URLError:
        # Old system Pythons (LibreSSL) can fail the TLS handshake: fall back to curl.
        raw = subprocess.run(
            ["curl", "-s", "-m", "400", "-A", ua, "--data-binary", "@-", OVERPASS],
            input=data, capture_output=True, check=True,
        ).stdout
    CACHE.write_bytes(raw)
    return json.loads(raw)


# ----------------------------------------------------------------------------- geometry

Pt = tuple[float, float]  # (lon, lat)


def dist_m(a: Pt, b: Pt) -> float:
    """Haversine distance in metres."""
    lon1, lat1, lon2, lat2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * 6371008.8 * math.asin(math.sqrt(h))


def _xy(p: Pt, lat0: float) -> tuple[float, float]:
    """Local equirectangular metres (fine over a catchment)."""
    return (p[0] * 111320.0 * math.cos(math.radians(lat0)), p[1] * 110574.0)


def project_on_segment(p: Pt, a: Pt, b: Pt) -> tuple[float, float, Pt]:
    """Return (distance m, t in 0..1, closest point) from p to segment a-b."""
    lat0 = p[1]
    (x, y), (x1, y1), (x2, y2) = _xy(p, lat0), _xy(a, lat0), _xy(b, lat0)
    dx, dy = x2 - x1, y2 - y1
    L2 = dx * dx + dy * dy
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / L2))
    q = (a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]))
    return math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)), t, q


def simplify(pts: list[Pt], tol_m: float) -> list[Pt]:
    """Douglas-Peucker in local metres, iterative."""
    if len(pts) < 3:
        return pts
    lat0 = pts[0][1]
    xy = [_xy(p, lat0) for p in pts]
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        (x1, y1), (x2, y2) = xy[i], xy[j]
        dx, dy = x2 - x1, y2 - y1
        L2 = dx * dx + dy * dy
        best, idx = 0.0, -1
        for k in range(i + 1, j):
            x, y = xy[k]
            t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / L2))
            d = math.hypot(x - (x1 + t * dx), y - (y1 + t * dy))
            if d > best:
                best, idx = d, k
        if best > tol_m and idx > 0:
            keep[idx] = True
            stack += [(i, idx), (idx, j)]
    return [p for p, k in zip(pts, keep) if k]


def round_line(pts: list[Pt]) -> list[list[float]]:
    out: list[list[float]] = []
    for lon, lat in pts:
        q = [round(lon, 5), round(lat, 5)]
        if not out or out[-1] != q:
            out.append(q)
    return out


def inside(p: Pt, bb: tuple[float, float, float, float]) -> bool:
    return bb[0] <= p[1] <= bb[2] and bb[1] <= p[0] <= bb[3]


# ----------------------------------------------------------------------------- catchment rivers


def line_merge(lines: list[list[int]]) -> list[list[int]]:
    """Join node-id chains that meet end to end where exactly two chains meet."""
    lines = [list(seq) for seq in lines if len(seq) >= 2]
    alive = set(range(len(lines)))
    ends: dict[int, list[int]] = defaultdict(list)
    for i, seq in enumerate(lines):
        ends[seq[0]].append(i)
        ends[seq[-1]].append(i)
    changed = True
    while changed:
        changed = False
        for node in list(ends):
            live = [i for i in ends[node] if i in alive]
            ends[node] = live
            if len(live) != 2 or live[0] == live[1]:
                continue
            a, b = live
            la, lb = lines[a], lines[b]
            if la[-1] != node:
                la = la[::-1]
            if lb[0] != node:
                lb = lb[::-1]
            merged = la + lb[1:]
            lines[a] = merged
            alive.discard(b)
            ends[node] = []
            far = merged[-1]
            ends[far] = [a if i == b else i for i in ends[far]]
            changed = True
    return [lines[i] for i in sorted(alive)]


def build_rivers(osm: dict) -> dict:
    coords: dict[int, Pt] = {}
    groups: dict[str, list[list[int]]] = defaultdict(list)
    pats = [(name, re.compile(rx)) for name, _, rx in RIVERS]
    for el in osm.get("elements", []):
        if el.get("type") != "way" or "geometry" not in el:
            continue
        osm_name = el.get("tags", {}).get("name", "")
        for name, rx in pats:
            if rx.search(osm_name):
                for nid, g in zip(el["nodes"], el["geometry"]):
                    coords[nid] = (g["lon"], g["lat"])
                groups[name].append(el["nodes"])
                break
    feats = []
    for name, kind, _ in RIVERS:
        parts: list[list[list[float]]] = []
        for seq in line_merge(groups.get(name, [])):
            run: list[Pt] = []
            for nid in seq + [None]:  # sentinel flushes the last run
                p = coords.get(nid) if nid is not None else None
                if p is not None and inside(p, CATCHMENT):
                    run.append(p)
                    continue
                if len(run) >= 2:
                    line = round_line(simplify(run, SIMPLIFY_RIVERS_M))
                    if len(line) >= 2:
                        parts.append(line)
                run = []
        if parts:
            feats.append({
                "type": "Feature",
                "properties": {"name": name, "kind": kind},
                "geometry": {"type": "MultiLineString", "coordinates": parts},
            })
    return {
        "type": "FeatureCollection",
        "attribution": ATTRIBUTION,
        "bbox": [CATCHMENT[1], CATCHMENT[0], CATCHMENT[3], CATCHMENT[2]],
        "features": feats,
    }


# ----------------------------------------------------------------------------- routing graph


class RiverGraph:
    """Directed waterway graph. Node ids are OSM node ids; snapped gauges get negative ids."""

    def __init__(self) -> None:
        self.xy: dict[int, Pt] = {}
        self.adj: dict[int, list[tuple[int, float, bool]]] = defaultdict(list)  # (v, cost, reversed)
        self.segments: list[tuple[int, int, str]] = []  # forward segments (u, v, way name)
        self._next_virtual = -1

    def add_edge(self, u: int, v: int, name: str, penalise_reverse: bool = True) -> None:
        d = dist_m(self.xy[u], self.xy[v])
        w = d * (1.0 if name else UNNAMED_COST)
        self.adj[u].append((v, w, False))
        self.adj[v].append((u, w * (REVERSE_COST if penalise_reverse else 1.0), penalise_reverse))

    def add_way(self, node_ids: list[int], pts: list[Pt], name: str) -> None:
        for nid, p in zip(node_ids, pts):
            self.xy[nid] = p
        for u, v in zip(node_ids, node_ids[1:]):
            if u != v:
                self.add_edge(u, v, name)
                self.segments.append((u, v, name))

    def bridge_gaps(self, ways: list[list[int]], tol_m: float = BRIDGE_M) -> int:
        """Connect dangling way ends to the nearest node of another way within tol_m."""
        deg: dict[int, int] = defaultdict(int)
        owner: dict[int, set[int]] = defaultdict(set)
        for wi, seq in enumerate(ways):
            for nid in seq:
                owner[nid].add(wi)
            deg[seq[0]] += 1
            deg[seq[-1]] += 1
        cell = 0.001
        grid: dict[tuple[int, int], list[int]] = defaultdict(list)
        for nid, (lon, lat) in self.xy.items():
            grid[(int(lon // cell), int(lat // cell))].append(nid)
        added = 0
        for wi, seq in enumerate(ways):
            for end in (seq[0], seq[-1]):
                if deg[end] != 1 or len(owner[end]) != 1:
                    continue  # already a junction
                lon, lat = self.xy[end]
                cx, cy = int(lon // cell), int(lat // cell)
                best, best_d = None, tol_m
                for gx in (cx - 1, cx, cx + 1):
                    for gy in (cy - 1, cy, cy + 1):
                        for nid in grid.get((gx, gy), ()):
                            if wi in owner[nid]:
                                continue
                            d = dist_m(self.xy[end], self.xy[nid])
                            if d < best_d:
                                best, best_d = nid, d
                if best is not None:
                    self.add_edge(end, best, "bridge", penalise_reverse=False)
                    added += 1
        return added

    def snap_points(self, points: list[tuple[Pt, str]]) -> list[int | None]:
        """Snap each (point, river name) to the nearest segment of that river (else any river).

        Inserts a virtual node on the segment and returns its id (None if nothing is close).
        Several points on one segment are chained in order along it.
        """
        hits: dict[int, list[tuple[float, int]]] = defaultdict(list)  # segment -> [(t, point index)]
        snapped: dict[int, Pt] = {}
        for i, (p, river) in enumerate(points):
            key = river.lower().replace(" stream", "").replace("river ", "").strip()
            rx = re.compile(rf"\b{re.escape(key)}\b", re.I) if key else None
            best_named = (SNAP_NAMED_M, -1, 0.0, p)
            best_any = (SNAP_ANY_M, -1, 0.0, p)
            for si, (u, v, name) in enumerate(self.segments):
                a, b = self.xy[u], self.xy[v]
                if abs(a[1] - p[1]) > 0.01 and abs(b[1] - p[1]) > 0.01:
                    continue  # cheap prefilter (~1 km in latitude)
                d, t, q = project_on_segment(p, a, b)
                if rx and name and rx.search(name) and d < best_named[0]:
                    best_named = (d, si, t, q)
                if d < best_any[0]:
                    best_any = (d, si, t, q)
            best = best_named if best_named[1] >= 0 else best_any
            if best[1] >= 0:
                hits[best[1]].append((best[2], i))
                snapped[i] = best[3]
        ids: list[int | None] = [None] * len(points)
        for si, items in hits.items():
            u, v, name = self.segments[si]
            chain = [u]
            for _, i in sorted(items):
                vid = self._next_virtual
                self._next_virtual -= 1
                self.xy[vid] = snapped[i]
                ids[i] = vid
                chain.append(vid)
            chain.append(v)
            for a, b in zip(chain, chain[1:]):
                self.add_edge(a, b, name)
        return ids

    def shortest(self, src: int, dst: int, allow_reverse: bool = True) -> list[int] | None:
        """Dijkstra from src to dst. Returns the node list (src first) or None."""
        best = {src: 0.0}
        prev: dict[int, int] = {}
        heap = [(0.0, src)]
        while heap:
            c, u = heapq.heappop(heap)
            if u == dst:
                path = [u]
                while path[-1] != src:
                    path.append(prev[path[-1]])
                return path[::-1]
            if c > best.get(u, math.inf):
                continue
            for v, w, rev in self.adj.get(u, ()):
                if rev and not allow_reverse:
                    continue
                nc = c + w
                if nc < best.get(v, math.inf):
                    best[v] = nc
                    prev[v] = u
                    heapq.heappush(heap, (nc, v))
        return None

    def path_points(self, path: list[int]) -> list[Pt]:
        return [self.xy[n] for n in path]


def graph_from_osm(osm: dict) -> RiverGraph:
    g = RiverGraph()
    ways: list[list[int]] = []
    for el in osm.get("elements", []):
        if el.get("type") != "way" or "geometry" not in el:
            continue
        tags = el.get("tags", {})
        name = tags.get("name", "")
        if tags.get("waterway") == "canal" and "River" not in name:
            continue  # navigation canals (Oxford Canal, Duke's Cut) would short-circuit rivers
        pts = [(p["lon"], p["lat"]) for p in el["geometry"]]
        g.add_way(el["nodes"], pts, name)
        ways.append(el["nodes"])
    g.bridge_gaps(ways)
    return g


# ----------------------------------------------------------------------------- paths


def progress(pts: list[list[float]]) -> tuple[list[float], float]:
    """Cumulative distance fraction per vertex (0..1) and total length in km."""
    cum = [0.0]
    for a, b in zip(pts, pts[1:]):
        cum.append(cum[-1] + dist_m((a[0], a[1]), (b[0], b[1])))
    total = cum[-1] or 1.0
    return [round(c / total, 4) for c in cum], round(cum[-1] / 1000, 2)


def load_gauges() -> tuple[dict[str, dict], dict]:
    import yaml  # project dependency; imported here so the tests need only the stdlib

    cfg = yaml.safe_load(STATIONS.read_text())
    return {g["key"]: g for g in cfg["gauges"]}, cfg.get("flow_paths") or {}


def wanted_pairs(gauges: dict[str, dict], flow_paths: dict, travel: list[dict]) -> dict[tuple[str, str], dict]:
    pairs: dict[tuple[str, str], dict] = {}
    for t in travel:
        med = (t.get("tHalf") or {}).get("median")
        pairs[(t["up"], t["down"])] = {"travelH": med, "n": int(t.get("n") or 0), "source": "travel_times"}
    for tree in flow_paths.values():
        for down, ups in (tree or {}).items():
            for up in ups or []:
                pairs.setdefault((up, down), {"travelH": None, "n": 0, "source": "flow_paths"})
    return pairs


def route(g: RiverGraph, a: int | None, b: int | None, allow_reverse: bool) -> list[int] | None:
    if a is None or b is None:
        return None
    return g.shortest(a, b, allow_reverse=allow_reverse)


def build_paths(osm: dict, gauges: dict[str, dict], flow_paths: dict, travel: list[dict]) -> tuple[dict, list[str]]:
    g = graph_from_osm(osm)
    keys = list(gauges)
    snap = dict(zip(keys, g.snap_points([((gauges[k]["lon"], gauges[k]["lat"]), gauges[k].get("river", "")) for k in keys])))
    pairs = wanted_pairs(gauges, flow_paths, travel)

    # Auto-discover: upstream / live_only gauges whose water reaches a target gauge.
    targets = [k for k, v in gauges.items() if v.get("role") == "target"]
    for up, gu in gauges.items():
        if gu.get("role") not in ("upstream", "live_only"):
            continue
        for down in targets:
            if (up, down) in pairs or up == down:
                continue
            path = route(g, snap[up], snap[down], allow_reverse=False)
            if path and sum(dist_m(g.xy[x], g.xy[y]) for x, y in zip(path, path[1:])) <= MAX_AUTO_KM * 1000:
                pairs[(up, down)] = {"travelH": None, "n": 0, "source": "network"}

    feats, unrouted = [], []
    for (up, down), meta in sorted(pairs.items()):
        if up not in gauges or down not in gauges:
            continue
        path = route(g, snap[up], snap[down], allow_reverse=False) or route(g, snap[up], snap[down], allow_reverse=True)
        if path:
            line = round_line(simplify(g.path_points(path), SIMPLIFY_PATHS_M))
            routed = len(line) >= 2
        if not path or not routed:
            line = round_line([(gauges[up]["lon"], gauges[up]["lat"]), (gauges[down]["lon"], gauges[down]["lat"])])
            routed = False
            unrouted.append(f"{up}->{down}")
        frac, km = progress(line)
        feats.append({
            "type": "Feature",
            "properties": {
                "up": up,
                "down": down,
                "travelH": meta["travelH"],
                "n": meta["n"],
                "confidence": "high" if meta["n"] >= 5 else "low",
                "routed": routed,
                "lengthKm": km,
                "progress": frac,
            },
            "geometry": {"type": "LineString", "coordinates": line},
        })
    fc = {"type": "FeatureCollection", "attribution": ATTRIBUTION, "features": feats}
    return fc, unrouted


def main() -> None:
    osm = fetch("--refresh" in sys.argv)
    GEO.mkdir(parents=True, exist_ok=True)
    rivers = build_rivers(osm)
    OUT_RIVERS.write_text(json.dumps(rivers, separators=(",", ":")))
    print(f"wrote {OUT_RIVERS.relative_to(ROOT)}: {OUT_RIVERS.stat().st_size / 1e6:.2f} MB, "
          f"{len(rivers['features'])} rivers")

    gauges, flow_paths = load_gauges()
    travel = json.loads(TRAVEL.read_text()) if TRAVEL.exists() else []
    paths, unrouted = build_paths(osm, gauges, flow_paths, travel)
    OUT_PATHS.write_text(json.dumps(paths, separators=(",", ":")))
    print(f"wrote {OUT_PATHS.relative_to(ROOT)}: {OUT_PATHS.stat().st_size / 1e6:.3f} MB, "
          f"{len(paths['features'])} paths, {len(unrouted)} straight-line fallbacks {unrouted}")
    for f in paths["features"]:
        p = f["properties"]
        print(f"  {p['up']:>12} -> {p['down']:<12} {p['lengthKm']:6.1f} km  travelH={p['travelH']}  "
              f"n={p['n']}  routed={p['routed']}")


if __name__ == "__main__":
    main()
