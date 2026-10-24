#!/usr/bin/env python3
"""Build the offline Oxford basemap for the web app (#118).

Writes web/public/data/geo/oxford-base.geojson: OpenStreetMap water areas,
rivers and streams, main and minor roads, railways, parks/meadows and (for
the S3/S4 Osney-Botley area only) building footprints. Each feature carries
``properties.kind`` (water, river, stream, road, minor_road, rail, park,
building), which web/src/ui/BaseMap.tsx styles.

Data © OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright).
Fetched once from the Overpass API and cached in data/raw/osm/ (gitignored).
Standard library only; coordinates are rounded to 5 decimals (~1 m) and lines
simplified with Douglas-Peucker so the file stays small (target < 3 MB).

Usage: python3 web/scripts/build_basemap.py [--refresh]
"""
from __future__ import annotations

import json
import math
import sys
import urllib.parse
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / "data" / "raw" / "osm"
OUT = ROOT / "web" / "public" / "data" / "geo" / "oxford-base.geojson"
OVERPASS = "https://overpass-api.de/api/interpreter"

# Wide view (all five spots and the river approaches): south, west, north, east.
WIDE = (51.712, -1.330, 51.800, -1.215)
# Buildings only around the S3/S4 subarea (stretch/s3/spread.py) plus a margin.
DETAIL = (51.740, -1.297, 51.763, -1.258)

ROAD = {"motorway", "trunk", "primary", "secondary", "tertiary", "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link"}
MINOR = {"residential", "unclassified", "living_street", "service"}
TOL = {"water": 0.00003, "park": 0.00004, "river": 0.00002, "stream": 0.00002, "road": 0.00002, "minor_road": 0.00002, "rail": 0.00003, "building": 0.000008}


def bbox(b: tuple[float, float, float, float]) -> str:
    return f"{b[0]},{b[1]},{b[2]},{b[3]}"


QUERY = f"""
[out:json][timeout:180];
(
  way["natural"="water"]({bbox(WIDE)});
  relation["natural"="water"]({bbox(WIDE)});
  way["waterway"="riverbank"]({bbox(WIDE)});
  relation["waterway"="riverbank"]({bbox(WIDE)});
  way["waterway"~"^(river|canal|stream)$"]({bbox(WIDE)});
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary)(_link)?$"]({bbox(WIDE)});
  way["highway"~"^(residential|unclassified|living_street)$"]({bbox(WIDE)});
  way["railway"="rail"]({bbox(WIDE)});
  way["leisure"="park"]({bbox(WIDE)});
  way["landuse"~"^(meadow|grass|recreation_ground)$"]({bbox(WIDE)});
  relation["landuse"="meadow"]({bbox(WIDE)});
  way["building"]({bbox(DETAIL)});
);
out geom;
"""


def fetch(refresh: bool) -> dict:
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / "oxford_base_overpass.json"
    if path.exists() and not refresh:
        return json.loads(path.read_text())
    data = urllib.parse.urlencode({"data": QUERY}).encode()
    ua = "RiverClock-OxHack26/1.0 (hackathon basemap)"
    req = urllib.request.Request(OVERPASS, data=data, headers={"User-Agent": ua})
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            raw = r.read()
    except urllib.error.URLError:
        # Old system Pythons (LibreSSL) can fail the TLS handshake: fall back to curl.
        import subprocess

        raw = subprocess.run(
            ["curl", "-s", "-m", "300", "-A", ua, "--data-binary", "@-", OVERPASS],
            input=data, capture_output=True, check=True,
        ).stdout
    path.write_bytes(raw)
    return json.loads(raw)


def kind_of(tags: dict) -> str | None:
    if tags.get("building"):
        return "building"
    if tags.get("natural") == "water" or tags.get("waterway") == "riverbank":
        return "water"
    ww = tags.get("waterway")
    if ww in ("river", "canal"):
        return "river"
    if ww == "stream":
        return "stream"
    hw = tags.get("highway")
    if hw in ROAD:
        return "road"
    if hw in MINOR:
        return "minor_road"
    if tags.get("railway") == "rail":
        return "rail"
    if tags.get("leisure") == "park" or tags.get("landuse") in ("meadow", "grass", "recreation_ground"):
        return "park"
    return None


def perp(p, a, b) -> float:
    (x, y), (x1, y1), (x2, y2) = p, a, b
    dx, dy = x2 - x1, y2 - y1
    if dx == 0 and dy == 0:
        return math.hypot(x - x1, y - y1)
    t = max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)))
    return math.hypot(x - (x1 + t * dx), y - (y1 + t * dy))


def simplify(pts: list, tol: float) -> list:
    """Douglas-Peucker, iterative."""
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        best, idx = 0.0, -1
        for k in range(i + 1, j):
            d = perp(pts[k], pts[i], pts[j])
            if d > best:
                best, idx = d, k
        if best > tol and idx > 0:
            keep[idx] = True
            stack += [(i, idx), (idx, j)]
    return [p for p, k in zip(pts, keep) if k]


def coords(geom: list) -> list:
    return [(round(g["lon"], 5), round(g["lat"], 5)) for g in geom]


def join_rings(ways: list[list]) -> list[list]:
    """Join member ways end to end into closed rings (multipolygon outers)."""
    rings, pool = [], [w[:] for w in ways if len(w) >= 2]
    while pool:
        ring = pool.pop(0)
        changed = True
        while ring[0] != ring[-1] and changed:
            changed = False
            for i, w in enumerate(pool):
                if w[0] == ring[-1]:
                    ring += w[1:]
                elif w[-1] == ring[-1]:
                    ring += w[-2::-1]
                elif w[-1] == ring[0]:
                    ring = w[:-1] + ring
                elif w[0] == ring[0]:
                    ring = w[:0:-1] + ring
                else:
                    continue
                pool.pop(i)
                changed = True
                break
        if ring[0] == ring[-1] and len(ring) >= 4:
            rings.append(ring)
    return rings


AREAS = {"water", "park", "building"}


def feature(kind: str, geometry: dict) -> dict:
    return {"type": "Feature", "properties": {"kind": kind}, "geometry": geometry}


def build(osm: dict) -> dict:
    feats: list[dict] = []
    for el in osm.get("elements", []):
        kind = kind_of(el.get("tags", {}))
        if not kind:
            continue
        tol = TOL[kind]
        if el["type"] == "way" and "geometry" in el:
            pts = coords(el["geometry"])
            closed = len(pts) >= 4 and pts[0] == pts[-1]
            if kind in AREAS and closed:
                ring = simplify(pts, tol)
                if len(ring) >= 4:
                    feats.append(feature(kind, {"type": "Polygon", "coordinates": [ring]}))
            elif kind not in AREAS:
                line = simplify(pts, tol)
                if len(line) >= 2:
                    feats.append(feature(kind, {"type": "LineString", "coordinates": line}))
        elif el["type"] == "relation" and kind in AREAS:
            outers = [coords(m["geometry"]) for m in el.get("members", []) if m.get("role") == "outer" and "geometry" in m]
            inners = [coords(m["geometry"]) for m in el.get("members", []) if m.get("role") == "inner" and "geometry" in m]
            for ring in join_rings(outers):
                holes = [simplify(h, tol) for h in join_rings(inners)]
                poly = [simplify(ring, tol)] + [h for h in holes if len(h) >= 4]
                if len(poly[0]) >= 4:
                    feats.append(feature(kind, {"type": "Polygon", "coordinates": poly}))
    order = ["park", "water", "building", "minor_road", "road", "rail", "stream", "river"]
    feats.sort(key=lambda f: order.index(f["properties"]["kind"]))
    return {
        "type": "FeatureCollection",
        "attribution": "© OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright)",
        "bbox": [WIDE[1], WIDE[0], WIDE[3], WIDE[2]],
        "features": feats,
    }


def main() -> None:
    fc = build(fetch("--refresh" in sys.argv))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(fc, separators=(",", ":")))
    counts: dict[str, int] = {}
    for f in fc["features"]:
        counts[f["properties"]["kind"]] = counts.get(f["properties"]["kind"], 0) + 1
    print(f"wrote {OUT.relative_to(ROOT)}: {OUT.stat().st_size / 1e6:.2f} MB, {counts}")


if __name__ == "__main__":
    main()
