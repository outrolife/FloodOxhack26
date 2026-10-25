"""Schema checks for web/public/data/geo/risk-zones.geojson (S1 offline EA flood-risk zones).

Built by stretch/s1/build_risk_zones.py. Pure-stdlib checks (no shapely needed): allowed bands,
WGS84 bounds around Oxford, 5-decimal coordinates, attribution, and the 4 MB size budget.
Skipped if the file has not been built yet.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

PATH = Path(__file__).resolve().parents[1] / "web" / "public" / "data" / "geo" / "risk-zones.geojson"
BANDS = {"high", "medium", "low", "very_low"}  # RiskBand in web/src/explore/types.ts
MAX_BYTES = 4_000_000
WEST, SOUTH, EAST, NORTH = -1.40, 51.68, -1.15, 51.84

pytestmark = pytest.mark.skipif(not PATH.exists(), reason="risk-zones.geojson not built")


@pytest.fixture(scope="module")
def fc() -> dict:
    return json.loads(PATH.read_text(encoding="utf-8"))


def _positions(coords):
    if isinstance(coords[0], (int, float)):
        yield coords
    else:
        for c in coords:
            yield from _positions(c)


def test_size_budget() -> None:
    assert PATH.stat().st_size <= MAX_BYTES


def test_top_level(fc: dict) -> None:
    assert fc["type"] == "FeatureCollection"
    assert fc["source"]
    assert "Environment Agency" in fc["attribution"] and "Open Government Licence" in fc["attribution"]
    assert len(fc["fetched"]) == 10 and fc["fetched"][4] == "-"  # ISO date


def test_features(fc: dict) -> None:
    bands = [f["properties"]["band"] for f in fc["features"]]
    assert bands and set(bands) <= BANDS
    assert len(bands) == len(set(bands)), "expected one dissolved feature per band"
    for f in fc["features"]:
        assert f["type"] == "Feature"
        assert f["geometry"]["type"] in {"Polygon", "MultiPolygon"}
        for lon, lat in _positions(f["geometry"]["coordinates"]):
            assert WEST - 1e-4 <= lon <= EAST + 1e-4, lon
            assert SOUTH - 1e-4 <= lat <= NORTH + 1e-4, lat
            assert round(lon, 5) == lon and round(lat, 5) == lat
