"""S1 (SPEC §11): official flood-risk map layers for the River tab.

Writes two files into web/public/data/geo/:
  - risk_layers.json: the S1 contract. Two EA WMS layers (RoFRS, RoFSW) plus one GeoJSON layer.
  - recorded_outlines.json: EA Recorded Flood Outlines clipped to the Oxford bbox and simplified,
    so this layer works offline.

Why the split: RoFRS and RoFSW are published only as WMS (no WFS/OGC Features) and their national
downloads are many GB. Recorded Flood Outlines has an OGC API Features endpoint that accepts a bbox.

The raw OGC response is cached in data/raw/ (CLAUDE.md rule 5). Re-running is idempotent.
Run: uv run --with shapely --with requests python -m stretch.s1.build_risk_layers
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import requests
from shapely.geometry import box, mapping, shape
from shapely.ops import unary_union

REPO_ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = REPO_ROOT / "web" / "public" / "data" / "geo"
RAW_DIR = Path(os.environ.get("RC_DATA_DIR") or REPO_ROOT / "data") / "raw"
RAW_RFO = RAW_DIR / "ea_recorded_flood_outlines_oxford.geojson"

USER_AGENT = "RiverClock/0.1 (OxHack 2026 flood decision-support prototype)"

# Oxford bbox (SPEC §11 S1): lat 51.70-51.80, lon -1.33 to -1.20
WEST, SOUTH, EAST, NORTH = -1.33, 51.70, -1.20, 51.80

RFO_ITEMS = (
    "https://environment.data.gov.uk/spatialdata/recorded-flood-outlines/ogc/features/v1/"
    "collections/Recorded_Flood_Outlines/items"
)
SIMPLIFY_DEG = 0.00003  # about 2 m; well below what a zoom-13 to 16 web map can show
COORD_DECIMALS = 5  # about 1 m

# Plain text (the EA's own attribution statement), so any UI can show it without parsing HTML.
ATTRIBUTION = "© Environment Agency copyright and/or database right 2025. Open Government Licence v3.0"

# The WMS layer name travels in the url's `layers` query parameter, so the S1 contract stays as it is.
# Colours are the EA's own map styles (from GetLegendGraphic&format=application/json); the WMS draws
# them, so the legend must match. Bands are the NaFRA2 annual-chance bands.
RISK_LAYERS = {
    "layers": [
        {
            "id": "rofrs",
            "name": "Official river risk",
            "type": "wms",
            "url": "https://environment.data.gov.uk/spatialdata/"
            "nafra2-risk-of-flooding-from-rivers-and-sea/wms?layers=rofrs_4band",
            "attribution": ATTRIBUTION,
            "legend": [
                {"label": "High (3.3% or more a year)", "colour": "#555B9D"},
                {"label": "Medium (1% to 3.3% a year)", "colour": "#9A9FDE"},
                {"label": "Low (0.1% to 1% a year)", "colour": "#C3E0FF"},
                {"label": "Very low (under 0.1% a year)", "colour": "#C8F7FF"},
            ],
        },
        {
            "id": "rofsw",
            "name": "Official surface-water risk",
            "type": "wms",
            "url": "https://environment.data.gov.uk/spatialdata/"
            "nafra2-risk-of-flooding-from-surface-water/wms?layers=rofsw",
            "attribution": ATTRIBUTION,
            "legend": [
                {"label": "High (3.3% or more a year)", "colour": "#555B9D"},
                {"label": "Medium (1% to 3.3% a year)", "colour": "#9A9FDE"},
                {"label": "Low (0.1% to 1% a year)", "colour": "#C3E0FF"},
            ],
        },
        {
            "id": "recorded",
            "name": "Recorded flood outlines",
            "type": "geojson",
            "url": "geo/recorded_outlines.json",
            "attribution": ATTRIBUTION,
            "legend": [{"label": "Recorded flood extent (darker = flooded more often)", "colour": "#D95F02"}],
        },
    ]
}

KEEP_PROPS = ("name", "start_date", "end_date", "flood_src")


def fetch_recorded_outlines() -> dict:
    """All Recorded Flood Outlines intersecting the bbox (paged OGC API Features), cached."""
    if RAW_RFO.exists():
        return json.loads(RAW_RFO.read_text(encoding="utf-8"))
    url: str | None = f"{RFO_ITEMS}?f=application/geo%2Bjson&bbox={WEST},{SOUTH},{EAST},{NORTH}&limit=100"
    feats: list[dict] = []
    while url:
        r = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=120)
        r.raise_for_status()
        page = r.json()
        feats += page.get("features", [])
        nxt = [lk["href"] for lk in page.get("links", []) if lk.get("rel") == "next"]
        url = nxt[0] if nxt and page.get("numberReturned") else None
    fc = {"type": "FeatureCollection", "features": feats}
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    RAW_RFO.write_text(json.dumps(fc), encoding="utf-8")
    return fc


MONTHS = (
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
)


def flood_label(name: str, start: str | None, end: str | None) -> str:
    """'July 2007', or 'November 2013 to February 2014'.

    Older outlines only carry the year in their dates (1 Jan to 12 Dec); their month is in the name,
    e.g. '06AugustSummer1977'.
    """
    if start and end and start[5:] == "01-01" and end[5:] == "12-12":
        month = next((m for m in MONTHS if m in (name or "")), None)
        return f"{month} {start[:4]}" if month else start[:4]
    if not start:
        return name or "Recorded flood"
    first = f"{MONTHS[int(start[5:7]) - 1]} {start[:4]}"
    if not end or end[:7] == start[:7]:
        return first
    return f"{first} to {MONTHS[int(end[5:7]) - 1]} {end[:4]}"


def _round(obj):
    if isinstance(obj, float):
        return round(obj, COORD_DECIMALS)
    if isinstance(obj, (list, tuple)):
        return [_round(x) for x in obj]
    return obj


def clip_and_simplify(fc: dict) -> dict:
    """One feature per recorded flood (rec_grp_id): union its outlines, clip, simplify, round."""
    bbox = box(WEST, SOUTH, EAST, NORTH)
    groups: dict[str, list] = {}
    props: dict[str, dict] = {}
    for f in fc["features"]:
        if not f.get("geometry"):
            continue
        p = f["properties"]
        key = str(p.get("rec_grp_id") or p.get("rec_out_id"))
        groups.setdefault(key, []).append(shape(f["geometry"]).buffer(0))
        props.setdefault(key, {k: p.get(k) for k in KEEP_PROPS})
    out = []
    for key, geoms in groups.items():
        g = unary_union(geoms).intersection(bbox).simplify(SIMPLIFY_DEG, preserve_topology=True)
        if g.is_empty or g.area == 0:
            continue
        p = props[key]
        for k in ("start_date", "end_date"):
            if p.get(k):
                p[k] = str(p[k])[:10]  # dates only; times in the source are all midnight
        p["label"] = flood_label(p.get("name") or "", p.get("start_date"), p.get("end_date"))
        geom = mapping(g)
        out.append(
            {
                "type": "Feature",
                "properties": {"id": key, **p},
                "geometry": {"type": geom["type"], "coordinates": _round(geom["coordinates"])},
            }
        )
    out.sort(key=lambda f: (f["properties"].get("start_date") or "", f["properties"]["id"]))
    return {"type": "FeatureCollection", "features": out}


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    raw = fetch_recorded_outlines()
    fc = clip_and_simplify(raw)
    gj = OUT_DIR / "recorded_outlines.json"
    gj.write_text(json.dumps(fc, separators=(",", ":")), encoding="utf-8")
    (OUT_DIR / "risk_layers.json").write_text(json.dumps(RISK_LAYERS, indent=1) + "\n", encoding="utf-8")
    print(
        f"recorded_outlines.json: {len(raw['features'])} raw -> {len(fc['features'])} floods, "
        f"{gj.stat().st_size / 1e6:.2f} MB"
    )


if __name__ == "__main__":
    main()
