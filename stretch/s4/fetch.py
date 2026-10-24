"""Download and cache the S4 inputs under ``$RC_DATA_DIR/raw/s4/`` (CLAUDE.md rule 5).

- Buildings: OpenStreetMap building footprints for the S3 subarea, one Overpass API request
  (ODbL; "© OpenStreetMap contributors"). The same request also asks for OSM flood walls and dykes
  (``wall=flood_wall``, ``man_made=dyke|flood_wall``); in Oct 2026 there are none in the subarea.
- Defences: EA Spatial Flood Defences (OGL v3), WFS, for the same BNG rectangle as the S3 grid.
  Used to flag buildings that already sit on a recorded defence line (SPEC §11 S4 exclusion 3).

Each file is downloaded once; delete it (or pass ``refresh=True``) to refetch.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import requests

DATA_DIR = Path(os.environ.get("RC_DATA_DIR", Path(__file__).resolve().parents[2] / "data"))
RAW_DIR = DATA_DIR / "raw" / "s4"

# S3 subarea (SPEC §11 S3), WGS84
LAT_S, LON_W, LAT_N, LON_E = 51.745, -1.290, 51.758, -1.265

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
USER_AGENT = "RiverClock-OxHack26/0.1 (hackathon prototype; sandbag screening)"
OSM_ATTRIBUTION = "© OpenStreetMap contributors (ODbL)"

SFD_WFS = (
    "https://environment.data.gov.uk/spatialdata/spatial-flood-defences-including-standardised-attributes/wfs"
)
SFD_TYPE = (
    "dataset-8e5be50f-d465-11e4-ba9a-f0def148f590:Spatial_Flood_Defences_Including_Standardised_Attributes"
)
SFD_ATTRIBUTION = "EA Spatial Flood Defences (OGL v3)"

Bounds = tuple[int, int, int, int]  # (xmin, ymin, xmax, ymax) in EPSG:27700 metres


def overpass_query(s: float = LAT_S, w: float = LON_W, n: float = LAT_N, e: float = LON_E) -> str:
    bb = f"({s},{w},{n},{e})"
    return (
        "[out:json][timeout:90];("
        f'way["building"]{bb};relation["building"]{bb};'
        f'way["wall"="flood_wall"]{bb};way["man_made"~"^(dyke|flood_wall)$"]{bb};'
        ");out geom;"
    )


def fetch_osm(refresh: bool = False) -> Path:
    """Overpass JSON (``out geom``) for the subarea's buildings and OSM flood walls (cached)."""
    path = RAW_DIR / f"osm_buildings_{LAT_S}_{LON_W}_{LAT_N}_{LON_E}.json"
    if refresh or not path.exists():
        r = requests.post(
            OVERPASS_URL, data={"data": overpass_query()}, headers={"User-Agent": USER_AGENT}, timeout=180
        )
        r.raise_for_status()
        doc = r.json()
        if not doc.get("elements"):
            raise RuntimeError("Overpass returned no elements for the S4 subarea")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(doc), encoding="utf-8")
    return path


def fetch_defences(b: Bounds, refresh: bool = False) -> Path:
    """EA Spatial Flood Defences lines intersecting ``b``, GeoJSON in EPSG:27700 (cached)."""
    path = RAW_DIR / f"ea_flood_defences_{'_'.join(str(v) for v in b)}.json"
    if refresh or not path.exists():
        params = {
            "service": "WFS",
            "version": "2.0.0",
            "request": "GetFeature",
            "typeNames": SFD_TYPE,
            "srsName": "EPSG:27700",
            "bbox": f"{b[0]},{b[1]},{b[2]},{b[3]},EPSG:27700",
            "outputFormat": "application/json",
        }
        r = requests.get(SFD_WFS, params=params, headers={"User-Agent": USER_AGENT}, timeout=180)
        r.raise_for_status()
        doc = r.json()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(doc), encoding="utf-8")
    return path
