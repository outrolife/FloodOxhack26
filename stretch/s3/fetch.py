"""Download and cache the S3 inputs under ``$RC_DATA_DIR/raw/s3/`` (CLAUDE.md rule 5).

All three sources are EA open data (OGL v3), fetched for the padded subarea only:

- DTM: EA LIDAR Composite DTM 2022, 1 m (dataset 13787b9a-26a4-4775-8523-806d13af58fc), via the
  Defra Data Services Platform WCS 2.0.1 ``GetCoverage``, which returns a float32 GeoTIFF in
  EPSG:27700 for any BNG rectangle. This is the same product as the 5 km survey-download tiles
  (SPEC §18), so no tile mosaicking is needed.
- River cells: EA Statutory Main River Map (WFS). Covers the Thames, Bulstake, Seacourt and
  Hinksey streams in the subarea.
- Validation: EA Recorded Flood Outlines (WFS), filtered to the Winter 2013/2014 outlines.

Each file is downloaded once; delete it to refetch.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import requests

DATA_DIR = Path(os.environ.get("RC_DATA_DIR", Path(__file__).resolve().parents[2] / "data"))
RAW_DIR = DATA_DIR / "raw" / "s3"

DTM_WCS = "https://environment.data.gov.uk/spatialdata/lidar-composite-digital-terrain-model-dtm-1m-2022/wcs"
DTM_COVERAGE = "13787b9a-26a4-4775-8523-806d13af58fc__Lidar_Composite_Elevation_DTM_1m"
DTM_SOURCE = "EA LIDAR Composite DTM 2022 1 m (OGL v3), via the Defra DSP WCS, resampled to 5 m"

MAIN_RIVER_WFS = "https://environment.data.gov.uk/spatialdata/statutory-main-river-map/wfs"
MAIN_RIVER_TYPE = "dataset-25dde009-ba7d-40de-8380-c5c3bb32ccdc:Statutory_Main_River_Map"

RFO_WFS = "https://environment.data.gov.uk/spatialdata/recorded-flood-outlines/wfs"
RFO_TYPE = "dataset-8c75e700-d465-11e4-8b5b-f0def148f590:Recorded_Flood_Outlines"

Bounds = tuple[int, int, int, int]  # (xmin, ymin, xmax, ymax) in EPSG:27700 metres


def _tag(b: Bounds) -> str:
    return "_".join(str(v) for v in b)


def _get(url: str, params: dict[str, str] | list[tuple[str, str]], timeout: int = 300) -> bytes:
    r = requests.get(url, params=params, timeout=timeout)
    r.raise_for_status()
    return r.content


def fetch_dtm(b: Bounds) -> Path:
    """1 m DTM GeoTIFF for the BNG rectangle ``b`` (cached)."""
    path = RAW_DIR / f"dtm1m_{_tag(b)}.tif"
    if not path.exists():
        params = [
            ("service", "WCS"),
            ("version", "2.0.1"),
            ("request", "GetCoverage"),
            ("coverageId", DTM_COVERAGE),
            ("format", "image/tiff"),
            ("subset", f"E({b[0]},{b[2]})"),
            ("subset", f"N({b[1]},{b[3]})"),
        ]
        data = _get(DTM_WCS, params)
        if not data.startswith((b"II*\x00", b"MM\x00*")):
            raise RuntimeError(f"DTM WCS did not return a TIFF: {data[:200]!r}")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    return path


def _wfs_geojson(url: str, type_name: str, b: Bounds) -> dict:
    params = {
        "service": "WFS",
        "version": "2.0.0",
        "request": "GetFeature",
        "typeNames": type_name,
        "srsName": "EPSG:27700",
        "bbox": f"{b[0]},{b[1]},{b[2]},{b[3]},EPSG:27700",
        "outputFormat": "application/json",
    }
    return json.loads(_get(url, params))


def fetch_rivers(b: Bounds) -> Path:
    """EA Main River centrelines intersecting ``b``, GeoJSON in EPSG:27700 (cached)."""
    path = RAW_DIR / f"main_rivers_{_tag(b)}.json"
    if not path.exists():
        gj = _wfs_geojson(MAIN_RIVER_WFS, MAIN_RIVER_TYPE, b)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(gj), encoding="utf-8")
    return path


def fetch_recorded_2014(b: Bounds) -> Path:
    """Recorded Flood Outlines named 'Winter 2013/2014' intersecting ``b`` (cached, EPSG:27700)."""
    path = RAW_DIR / f"rfo_winter2014_{_tag(b)}.json"
    if not path.exists():
        gj = _wfs_geojson(RFO_WFS, RFO_TYPE, b)
        keep = [
            f
            for f in gj.get("features", [])
            if str(f.get("properties", {}).get("start_date", "")).startswith("2013")
            and str(f.get("properties", {}).get("end_date", "")).startswith("2014")
        ]
        gj["features"] = keep
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(gj), encoding="utf-8")
    return path
