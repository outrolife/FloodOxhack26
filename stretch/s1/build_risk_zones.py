"""S1 (SPEC §11): offline EA river flood-risk zones (NaFRA2 RoFRS, 4 bands) for the Explore map.

Writes web/public/data/geo/risk-zones.geojson: one MultiPolygon per band ("high", "medium", "low",
"very_low"), clipped to the Oxford bbox, simplified and made NON-OVERLAPPING, so a point lies in at
most one band polygon and that band is its highest band.

Source. The EA publishes NaFRA2 "Risk of Flooding from Rivers and Sea" only as a WMS
(environment.data.gov.uk: WFS and OGC API Features both answer "not supported" for dataset
96ab4342-82c1-4095-87f1-0082e8d84ef1). Oxfordshire County Council republishes the same EA layer
(field `risk_band`, © EA 2025, OGL v3) as a queryable ArcGIS feature layer, which we read here.

The raw responses are cached in data/raw/s1_zones/ (CLAUDE.md rule 5). Re-running is idempotent and
reuses the cache; delete that folder to refetch.
Run: uv run --with shapely --with requests python -m stretch.s1.build_risk_zones
"""

from __future__ import annotations

import json
import math
import os
from datetime import UTC, datetime
from pathlib import Path

import requests
from shapely import difference, unary_union
from shapely.geometry import MultiPolygon, Polygon, box, mapping, shape

REPO_ROOT = Path(__file__).resolve().parents[2]
OUT_PATH = REPO_ROOT / "web" / "public" / "data" / "geo" / "risk-zones.geojson"
RAW_DIR = Path(os.environ.get("RC_DATA_DIR") or REPO_ROOT / "data") / "raw" / "s1_zones"

USER_AGENT = "RiverClock/0.1 (OxHack 2026 flood decision-support prototype)"

# All five Oxford trouble spots, with margin.
WEST, SOUTH, EAST, NORTH = -1.40, 51.68, -1.15, 51.84

LAYER_URL = "https://mymaps2.oxfordshire.gov.uk/server/rest/services/Third_Party/Environment/MapServer/26"
PAGE_SIZE = 100  # larger pages make the server answer 500

SOURCE = (
    "Environment Agency NaFRA2 Risk of Flooding from Rivers and Sea (rofrs_4band, field risk_band), "
    "read from Oxfordshire County Council's ArcGIS mirror of the EA layer "
    f"({LAYER_URL}); the EA itself serves this dataset only as WMS. "
    "Clipped to lon -1.40..-1.15, lat 51.68..51.84, simplified (~4 m), parts and holes under 400 m2 dropped, "
    "bands made non-overlapping (each area keeps its highest band)."
)
ATTRIBUTION = "© Environment Agency copyright and/or database right 2025. Open Government Licence v3.0"

# Source band label -> app RiskBand (web/src/explore/types.ts), highest first.
BANDS = {"high": "high", "medium": "medium", "low": "low", "very low": "very_low"}  # lower-cased
BAND_ORDER = ["high", "medium", "low", "very_low"]

SIMPLIFY_DEG = 0.00005  # Douglas-Peucker tolerance: about 4 m (lon ~3.5 m, lat ~5.6 m at 51.7 N)
GRID_DEG = 0.00001  # 5 decimals (about 1 m); shapely grid_size snaps while keeping polygons valid
MIN_PART_M2 = 400.0  # drop slivers and pin-holes smaller than 20 m x 20 m (keeps the file small)

_M_PER_DEG_LAT = 111_320.0
_M_PER_DEG_LON = _M_PER_DEG_LAT * math.cos(math.radians((SOUTH + NORTH) / 2))


def _fetch_page(offset: int) -> dict:
    """One page of features as GeoJSON in WGS84, cached on disk."""
    cache = RAW_DIR / f"page_{offset:06d}.geojson"
    if cache.exists():
        return json.loads(cache.read_text(encoding="utf-8"))
    params = {
        "where": "1=1",
        "geometry": f"{WEST},{SOUTH},{EAST},{NORTH}",
        "geometryType": "esriGeometryEnvelope",
        "inSR": 4326,
        "spatialRel": "esriSpatialRelIntersects",
        "outFields": "OBJECTID,risk_band",
        "returnGeometry": "true",
        "outSR": 4326,
        # Server-side pre-generalisation of ~1 m (well below our own 3 m simplify) keeps pages small.
        "maxAllowableOffset": 0.00001,
        "orderByFields": "OBJECTID",
        "resultOffset": offset,
        "resultRecordCount": PAGE_SIZE,
        "f": "geojson",
    }
    resp = requests.get(f"{LAYER_URL}/query", params=params, headers={"User-Agent": USER_AGENT}, timeout=180)
    resp.raise_for_status()
    data = resp.json()
    if "features" not in data:
        raise RuntimeError(f"unexpected response at offset {offset}: {str(data)[:300]}")
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(data), encoding="utf-8")
    return data


def fetch_all() -> list[dict]:
    features: list[dict] = []
    offset = 0
    while True:
        page = _fetch_page(offset)["features"]
        features.extend(page)
        print(f"  offset {offset}: {len(page)} features")
        if len(page) < PAGE_SIZE:
            return features
        offset += PAGE_SIZE


def _area_m2(geom) -> float:
    return geom.area * _M_PER_DEG_LAT * _M_PER_DEG_LON


def _polygons(geom) -> list[Polygon]:
    if isinstance(geom, Polygon):
        return [geom]
    if hasattr(geom, "geoms"):
        return [p for g in geom.geoms for p in _polygons(g)]
    return []


def _clean(geom) -> MultiPolygon:
    """Keep polygon parts only, drop slivers and tiny holes, return a MultiPolygon."""
    parts = []
    for p in _polygons(geom):
        if p.is_empty or _area_m2(p) < MIN_PART_M2:
            continue
        holes = [r for r in p.interiors if _area_m2(Polygon(r)) >= MIN_PART_M2]
        parts.append(Polygon(p.exterior, holes))
    return MultiPolygon(parts)


def _round_coords(obj):
    if isinstance(obj, (list, tuple)):
        if obj and isinstance(obj[0], float):
            return [round(v, 5) for v in obj]
        return [_round_coords(o) for o in obj]
    return obj


def build(features: list[dict]) -> dict:
    clip = box(WEST, SOUTH, EAST, NORTH)
    by_band: dict[str, list] = {b: [] for b in BAND_ORDER}
    for f in features:
        label = (f.get("properties") or {}).get("risk_band")
        band = BANDS.get(str(label).strip().lower())
        if band is None or not f.get("geometry"):
            continue
        g = shape(f["geometry"])
        if not g.is_valid:
            g = g.buffer(0)
        # Clip and simplify each polygon first: the source polygons run far beyond Oxford, and
        # unioning them whole is very slow.
        g = g.intersection(clip).simplify(SIMPLIFY_DEG, preserve_topology=True)
        by_band[band].extend(_polygons(g))  # clipping can leave stray lines and points

    out_features = []
    higher = None  # union of all already-placed (higher) bands
    for band in BAND_ORDER:
        if not by_band[band]:
            continue
        print(f"  dissolving {len(by_band[band])} {band} polygons ...", flush=True)
        g = MultiPolygon(_polygons(unary_union(by_band[band], grid_size=GRID_DEG)))
        if higher is not None:
            g = difference(g, higher, grid_size=GRID_DEG)  # the higher band wins where they overlap
        g = _clean(g)
        if g.is_empty:
            continue
        higher = g if higher is None else unary_union([higher, g], grid_size=GRID_DEG)
        geom = mapping(g)
        out_features.append(
            {
                "type": "Feature",
                "properties": {"band": band, "parts": len(g.geoms), "area_km2": round(_area_m2(g) / 1e6, 3)},
                "geometry": {"type": geom["type"], "coordinates": _round_coords(geom["coordinates"])},
            }
        )
    return {
        "type": "FeatureCollection",
        "source": SOURCE,
        "attribution": ATTRIBUTION,
        "fetched": datetime.now(UTC).date().isoformat(),
        "bbox": [WEST, SOUTH, EAST, NORTH],
        "overlap_rule": "non-overlapping: each point lies in at most one band polygon, its highest band",
        "features": out_features,
    }


def band_at(fc: dict, lon: float, lat: float) -> str | None:
    """Highest band whose polygon contains the point (None if outside every zone)."""
    from shapely.geometry import Point

    p = Point(lon, lat)
    hits = [f["properties"]["band"] for f in fc["features"] if shape(f["geometry"]).covers(p)]
    return min(hits, key=BAND_ORDER.index) if hits else None


CHECK_POINTS = {
    "Botley Road by Bulstake Stream": (-1.2795, 51.7535),
    "Osney Island": (-1.2705, 51.7505),
    "Headington": (-1.215, 51.760),
}


def main() -> None:
    print("Fetching EA RoFRS polygons for the Oxford bbox ...")
    feats = fetch_all()
    print(f"  {len(feats)} source features")
    fc = build(feats)
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(fc, separators=(",", ":")), encoding="utf-8")
    size = OUT_PATH.stat().st_size
    print(f"Wrote {OUT_PATH} ({size / 1e6:.2f} MB)")
    for f in fc["features"]:
        print(f"  {f['properties']}")
    for name, (lon, lat) in CHECK_POINTS.items():
        print(f"  point check {name} ({lat}, {lon}): {band_at(fc, lon, lat)}")


if __name__ == "__main__":
    main()
