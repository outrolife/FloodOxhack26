"""Sandbag inspection screening for the Osney/Botley subarea (SPEC §11 S4, issue #23). EXPERIMENTAL.

Run: ``python -m stretch.s4.screen --event e2014`` (or ``--event live``).

Suggests where a limited stock of sandbags is worth *inspecting* first. It is a screening list for a
human, never an instruction, and the score is not a modelled damage reduction.

Inputs
- S3 per-cell rasters: ``$RC_DATA_DIR/processed/s3/{event}/{issuedAt}.tif``, written by
  ``stretch/s3/spread.py`` on the 5 m EPSG:27700 grid. Bands ``freq_TT`` (ensemble frequency at lead
  TT h), ``median_depth_TT`` (median depth among wet runs, m) and ``first_tau_h`` (earliest lead
  with frequency >= 0.5).
- OpenStreetMap building footprints (ODbL, "© OpenStreetMap contributors"), one cached Overpass
  request, reprojected to EPSG:27700.
- EA Spatial Flood Defences (OGL v3) for the defence check.

Method (SPEC §11 S4)
1. Each footprint's walls are sampled every 1 m along a line 1 m outside the footprint (so the
   samples sit in the cells the walls touch). Samples that fall inside another building are party
   walls and can't be wet. A sample is "wet" if its cell has frequency >= 0.2 at any lead <= 48 h.
   Candidates are buildings with at least one wet sample.
2. Hard exclusions (listed in ``excluded`` with the reason):
   - depth: the median depth at the building is over 0.5 m (sandbags work to about 0.3 m, at most
     ~0.5 m in ideal conditions). "Depth at the building" = for each lead <= 48 h, the median over
     the wet samples of the cell's median depth; then the largest of those.
   - time: the building may be wet before now + the deployment time (default 3 h). S3 gives the
     first wet lead only on its lead grid (6, 12, 24 ... h), so water first seen at the +6 h frame
     may arrive any time in the first 6 h; we use the start of that interval (conservative).
   - defence: a recorded flood-defence asset lies within 5 m of the footprint: an EA Spatial Flood
     Defences line (wall, embankment or engineered high ground; "natural high ground" is ignored) or
     an OSM ``wall=flood_wall`` / ``man_made=dyke|flood_wall``. Such buildings already sit on a
     defence line: inspect the defence, don't bag the building.
3. Exposed length = share of wall samples that are wet x footprint perimeter (m).
   Bags = ceil(exposed length x ``bags_per_metre``); default 10 per metre is an ASSUMPTION
   (about a 3-bag-high, 1 m wide course with overlap), not a measured figure.
4. Score = P(wet by 48 h) x (1 if depth <= 0.3 m else 0.5). P(wet by 48 h) is the highest ensemble
   frequency at any lead <= 48 h over the wet samples (a lower bound on the run-wise "wet at any
   lead" share, which S3 does not store).
5. Greedy selection by score / bags, highest first, skipping any building that no longer fits in
   the bag budget (default 500). The output lists the 5 highest-scoring buildings of that selection
   (the budget decides which buildings are affordable; the list shows the likeliest to get wet).

Not screened at all (neither candidate nor excluded): outbuildings (OSM ``building`` = garage, shed,
roof, hut, ...) and footprints under 20 m², which are not properties.

Output (SPEC §11 contract ``sandbags.json``): ``web/public/data/spread/{event}/sandbags.json``.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import time
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import numpy as np

from stretch.s4 import fetch

ROOT = Path(__file__).resolve().parents[2]
PUBLIC = ROOT / "web" / "public" / "data"
S3_DIR = fetch.DATA_DIR / "processed" / "s3"

CHECKS = [
    "Door and sill height",
    "Access for delivery",
    "Owner permission",
    "Risk of diverting water to neighbours",
]
OUTBUILDINGS = {
    "garage",
    "garages",
    "shed",
    "roof",
    "carport",
    "hut",
    "greenhouse",
    "ruins",
    "construction",
    "container",
    "bunker",
    "toilets",
    "service",
    "transformer_tower",
    "bridge",
    "kiosk",
    "cabin",
    "allotment_house",
    "boathouse",
    "farm_auxiliary",
    "bicycle_shed",
}
DEFENCE_SUBTYPES_IGNORED = {"natural high ground"}


@dataclass
class Params:
    freq_min: float = 0.2  # candidate threshold on ensemble frequency
    horizon_h: int = 48  # leads considered for candidates, pWet and depth
    deploy_h: float = 3.0  # time to get bags in place
    max_depth_m: float = 0.5  # hard exclusion above this
    full_score_depth_m: float = 0.3  # score halved above this
    bags_per_metre: float = 10.0  # ASSUMPTION, see module docstring
    budget: int = 500  # bags
    top_n: int = 5
    ring_offset_m: float = 1.0  # wall samples this far outside the footprint
    sample_step_m: float = 1.0
    defence_buffer_m: float = 5.0
    min_area_m2: float = 20.0


# ---------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------


@dataclass
class Cells:
    """S3 per-cell outputs for one forecast issue time, on a north-up EPSG:27700 grid."""

    issued_at: datetime
    taus: np.ndarray  # (T,) lead hours, increasing
    freq: np.ndarray  # (T, ny, nx) ensemble frequency 0-1
    depth: np.ndarray  # (T, ny, nx) median depth among wet runs (m), NaN where never wet
    first_tau: np.ndarray  # (ny, nx) earliest lead with frequency >= 0.5, NaN if never
    x0: float  # west edge (m)
    y0: float  # north edge (m)
    cell: float  # cell size (m)

    @property
    def shape(self) -> tuple[int, int]:
        return self.first_tau.shape  # type: ignore[return-value]

    @property
    def bounds(self) -> tuple[int, int, int, int]:
        ny, nx = self.shape
        return (int(self.x0), int(self.y0 - ny * self.cell), int(self.x0 + nx * self.cell), int(self.y0))

    def index(self, x: np.ndarray, y: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """(row, col, inside) of the cells holding points (x, y)."""
        col = np.floor((np.asarray(x) - self.x0) / self.cell).astype(int)
        row = np.floor((self.y0 - np.asarray(y)) / self.cell).astype(int)
        ny, nx = self.shape
        inside = (row >= 0) & (row < ny) & (col >= 0) & (col < nx)
        return np.clip(row, 0, ny - 1), np.clip(col, 0, nx - 1), inside


def parse_issue(name: str) -> datetime:
    """``2014-01-05T000000Z`` (S3 file stem) or any ISO 8601 UTC string -> aware datetime."""
    m = re.fullmatch(r"(\d{4}-\d{2}-\d{2})T(\d{2}):?(\d{2}):?(\d{2})Z?", name.strip())
    if not m:
        raise ValueError(f"not an issue time: {name!r}")
    return datetime.fromisoformat(f"{m[1]}T{m[2]}:{m[3]}:{m[4]}").replace(tzinfo=UTC)


def iso_z(t: datetime) -> str:
    return t.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_cells(path: Path) -> Cells:
    """Read an S3 per-issue GeoTIFF (band descriptions ``freq_TT``, ``median_depth_TT``, ``first_tau_h``)."""
    import rasterio

    with rasterio.open(path) as src:
        names = list(src.descriptions)
        t = src.transform
        if abs(t.b) > 1e-9 or abs(t.d) > 1e-9 or abs(t.a + t.e) > 1e-9:
            raise ValueError(f"{path.name}: expected a north-up square grid, got {t}")
        if src.crs is None or src.crs.to_epsg() != 27700:
            raise ValueError(f"{path.name}: expected EPSG:27700, got {src.crs}")
        bands = {n: src.read(i + 1).astype(np.float32) for i, n in enumerate(names) if n}
    taus = sorted(int(n.split("_")[1]) for n in bands if re.fullmatch(r"freq_\d+", n))
    if not taus or "first_tau_h" not in bands:
        raise ValueError(f"{path.name}: missing S3 bands, found {names}")
    return Cells(
        issued_at=parse_issue(path.stem),
        taus=np.array(taus),
        freq=np.stack([bands[f"freq_{t:02d}"] for t in taus]),
        depth=np.stack([bands[f"median_depth_{t:02d}"] for t in taus]),
        first_tau=bands["first_tau_h"],
        x0=float(t.c),
        y0=float(t.f),
        cell=float(t.a),
    )


@dataclass
class Building:
    id: str  # "osm-way-123", "osm-relation-456"
    geom: Any  # shapely (Multi)Polygon, EPSG:27700
    tags: dict[str, str] = field(default_factory=dict)


def _to_bng():
    from pyproj import Transformer

    return Transformer.from_crs(4326, 27700, always_xy=True)


def _ring(coords: list[dict], tr) -> Any:
    from shapely.geometry import LineString

    xs, ys = tr.transform([c["lon"] for c in coords], [c["lat"] for c in coords])
    return LineString(list(zip(xs, ys, strict=True)))


def parse_overpass(doc: dict) -> tuple[list[Building], list[Any]]:
    """Overpass ``out geom`` JSON -> (buildings, OSM defence lines), both in EPSG:27700."""
    from shapely.geometry import Polygon
    from shapely.ops import polygonize, unary_union

    tr = _to_bng()
    buildings: list[Building] = []
    defences: list[Any] = []
    for el in doc.get("elements", []):
        tags = el.get("tags", {}) or {}
        if "building" not in tags:
            if el.get("type") == "way" and len(el.get("geometry", [])) >= 2:
                defences.append(_ring(el["geometry"], tr))
            continue
        geom = None
        if el.get("type") == "way":
            pts = el.get("geometry", [])
            if len(pts) >= 4:
                line = _ring(pts, tr)
                geom = Polygon(line.coords)
        elif el.get("type") == "relation":
            outer = [
                _ring(m["geometry"], tr)
                for m in el.get("members", [])
                if m.get("role") == "outer" and m.get("geometry")
            ]
            inner = [
                _ring(m["geometry"], tr)
                for m in el.get("members", [])
                if m.get("role") == "inner" and m.get("geometry")
            ]
            if outer:
                geom = unary_union(list(polygonize(outer)))
                if inner:
                    geom = geom.difference(unary_union(list(polygonize(inner))))
        if geom is None or geom.is_empty:
            continue
        if not geom.is_valid:
            geom = geom.buffer(0)
        if geom.is_empty or geom.area <= 0:
            continue
        buildings.append(Building(id=f"osm-{el['type']}-{el['id']}", geom=geom, tags=tags))
    return buildings, defences


def load_ea_defences(path: Path) -> list[Any]:
    """EA Spatial Flood Defences lines (EPSG:27700), minus 'natural high ground'."""
    from shapely.geometry import shape

    doc = json.loads(path.read_text(encoding="utf-8"))
    out = []
    for f in doc.get("features", []):
        sub = str((f.get("properties") or {}).get("asset_sub_type") or "").strip().lower()
        if sub in DEFENCE_SUBTYPES_IGNORED or not f.get("geometry"):
            continue
        out.append(shape(f["geometry"]))
    return out


# ---------------------------------------------------------------------------
# Screening
# ---------------------------------------------------------------------------


@dataclass
class Measure:
    """Per-building numbers that the selection works on (no geometry)."""

    id: str
    lat: float
    lon: float
    perimeter_m: float
    exposed_m: float
    p_wet48: float
    depth_m: float | None  # depth at the building, see module docstring
    first_tau_h: float | None  # earliest lead with frequency >= 0.5 at any wall sample
    near_defence: bool
    kind: str  # OSM building tag value
    name: str | None = None


def _wall_samples(geom: Any, p: Params) -> np.ndarray:
    """Points every ``sample_step_m`` along the outline offset ``ring_offset_m`` outside ``geom``."""
    import shapely

    ring = shapely.boundary(shapely.buffer(geom, p.ring_offset_m, join_style="mitre"))
    parts = list(shapely.get_parts(ring))
    out = []
    for part in parts:
        n = max(4, math.ceil(part.length / p.sample_step_m))
        d = (np.arange(n) + 0.5) * part.length / n
        out.append(shapely.get_coordinates(shapely.line_interpolate_point(part, d)))
    return np.vstack(out) if out else np.empty((0, 2))


def measure(
    cells: Cells,
    buildings: Sequence[Building],
    defences: Sequence[Any],
    p: Params,
    include: Sequence[bool] | None = None,
) -> list[Measure]:
    """Wall exposure, P(wet), depth and first-wet lead for every screened building with a wet wall.

    All ``buildings`` count as neighbours (party walls); only those with ``include`` True are screened.
    """
    import shapely
    from pyproj import Transformer
    from shapely.strtree import STRtree

    to_wgs = Transformer.from_crs(27700, 4326, always_xy=True)
    geoms = [b.geom for b in buildings]
    tree = STRtree(geoms)
    dtree = STRtree(list(defences)) if defences else None
    sel = np.asarray(cells.taus) <= p.horizon_h
    if not sel.any():
        raise ValueError(f"no S3 lead <= {p.horizon_h} h")
    pmax = cells.freq[sel].max(axis=0)  # (ny, nx) highest frequency at any lead <= horizon

    out: list[Measure] = []
    for i, b in enumerate(buildings):
        if include is not None and not include[i]:
            continue
        kind = str(b.tags.get("building", "yes"))
        if kind in OUTBUILDINGS or b.geom.area < p.min_area_m2:
            continue
        pts = _wall_samples(b.geom, p)
        if not len(pts):
            continue
        row, col, inside = cells.index(pts[:, 0], pts[:, 1])
        if not inside.any():
            continue
        # Party walls: samples inside a neighbouring footprint can't take water.
        hit_pts, hit_geoms = tree.query(shapely.points(pts), predicate="within")
        blocked = np.zeros(len(pts), dtype=bool)
        blocked[hit_pts[hit_geoms != i]] = True
        ok = inside & ~blocked
        wet = ok & (pmax[row, col] >= p.freq_min)
        if not wet.any():
            continue
        r, c = row[wet], col[wet]
        depths = []
        for k in np.flatnonzero(sel):
            f_k = cells.freq[k, r, c]
            d_k = cells.depth[k, r, c][f_k >= p.freq_min]
            d_k = d_k[np.isfinite(d_k)]
            if len(d_k):
                depths.append(float(np.median(d_k)))
        ft = cells.first_tau[row[ok], col[ok]]
        ft = ft[np.isfinite(ft)]
        near = False
        if dtree is not None:
            near = len(dtree.query(b.geom, predicate="dwithin", distance=p.defence_buffer_m)) > 0
        cx, cy = b.geom.centroid.x, b.geom.centroid.y
        lon, lat = to_wgs.transform(cx, cy)
        perim = float(shapely.length(shapely.boundary(b.geom)))
        out.append(
            Measure(
                id=b.id,
                lat=round(float(lat), 5),
                lon=round(float(lon), 5),
                perimeter_m=perim,
                exposed_m=float(wet.sum()) / len(pts) * perim,
                p_wet48=float(pmax[r, c].max()),
                depth_m=max(depths) if depths else None,
                first_tau_h=float(ft.min()) if len(ft) else None,
                near_defence=near,
                kind=kind,
                name=b.tags.get("name") or b.tags.get("addr:housename"),
            )
        )
    return out


def earliest_arrival_h(first_tau_h: float, taus: Sequence[int]) -> float:
    """Start of the lead interval in which the frequency first reaches 0.5 (0 for the first frame)."""
    earlier = [t for t in taus if t < first_tau_h]
    return float(max(earlier)) if earlier else 0.0


def exclusion(m: Measure, taus: Sequence[int], p: Params) -> str | None:
    """Reason for a hard exclusion (SPEC §11 S4 step 2), or None."""
    reasons = []
    if m.near_defence:
        reasons.append(
            f"Recorded flood defence within {p.defence_buffer_m:g} m (EA Spatial Flood Defences / OSM): "
            "existing defence location, inspect the defence instead"
        )
    if m.depth_m is not None and m.depth_m > p.max_depth_m:
        reasons.append(f"Median depth {m.depth_m:.2f} m > {p.max_depth_m:g} m: sandbags impractical")
    if m.first_tau_h is not None and earliest_arrival_h(m.first_tau_h, taus) < p.deploy_h:
        reasons.append(
            f"First wet before now + {p.deploy_h:g} h deployment time "
            f"(frequency ≥ 0.5 by the +{m.first_tau_h:g} h frame)"
        )
    return "; ".join(reasons) if reasons else None


def score(m: Measure, p: Params) -> float:
    full = m.depth_m is None or m.depth_m <= p.full_score_depth_m
    return m.p_wet48 * (1.0 if full else 0.5)


def bags(m: Measure, p: Params) -> int:
    return max(1, math.ceil(round(m.exposed_m * p.bags_per_metre, 6)))


def greedy(items: Sequence[tuple[str, float, int]], budget: int) -> list[str]:
    """Pick (id, score, bags) items by score / bags, highest first, while they fit in ``budget``.

    An item that no longer fits is skipped and the next one tried. Ties: higher score, then id.
    """
    order = sorted(items, key=lambda x: (-x[1] / x[2], -x[1], x[0]))
    left = budget
    picked = []
    for id_, s, n in order:
        if s > 0 and n <= left:
            picked.append(id_)
            left -= n
    return picked


def reasons_for(m: Measure, p: Params) -> list[str]:
    what = m.kind if m.kind != "yes" else "building"
    out = [
        f"Frequency ≥ {p.freq_min:g} along {m.exposed_m:.0f} m of its {m.perimeter_m:.0f} m walls "
        f"by {p.horizon_h} h (OSM {what}{', ' + m.name if m.name else ''})",
        f"P(wet by {p.horizon_h} h) {m.p_wet48:.2f}",
    ]
    if m.depth_m is None or m.depth_m <= p.full_score_depth_m:
        out.append(f"Median depth {m.depth_m or 0:.2f} m (≤ {p.full_score_depth_m:g} m)")
    else:
        out.append(f"Median depth {m.depth_m:.2f} m (over {p.full_score_depth_m:g} m): score halved")
    if m.first_tau_h is not None:
        out.append(f"Frequency ≥ 0.5 from the +{m.first_tau_h:g} h frame")
    else:
        out.append("Frequency stays below 0.5 in every frame")
    out.append(f"Bags assume {p.bags_per_metre:g} per metre of exposed wall (assumption)")
    return out


def screen(cells: Cells, measures: Sequence[Measure], p: Params) -> dict:
    """Apply exclusions, score, select within the budget; return the SPEC §11 ``sandbags.json`` dict."""
    taus = [int(t) for t in cells.taus]
    excluded: list[dict] = []
    pool: list[Measure] = []
    for m in sorted(measures, key=lambda m: m.id):
        why = exclusion(m, taus, p)
        if why:
            excluded.append({"id": m.id, "reason": why})
        else:
            pool.append(m)
    by_id = {m.id: m for m in pool}
    picked = greedy([(m.id, score(m, p), bags(m, p)) for m in pool], p.budget)
    picked = sorted(picked, key=lambda i: (-score(by_id[i], p), bags(by_id[i], p), i))[: p.top_n]
    candidates = []
    for id_ in picked:
        m = by_id[id_]
        first = cells.issued_at + timedelta(hours=m.first_tau_h) if m.first_tau_h is not None else None
        candidates.append(
            {
                "id": m.id,
                "lat": m.lat,
                "lon": m.lon,
                "score": round(score(m, p), 3),
                "pWet48": round(m.p_wet48, 3),
                "medianDepthM": round(m.depth_m or 0.0, 2),
                "firstWet": iso_z(first) if first else None,
                "bags": bags(m, p),
                "reasons": reasons_for(m, p),
                "checks": list(CHECKS),
            }
        )
    return {
        "issuedAt": iso_z(cells.issued_at),
        "budget": p.budget,
        "candidates": candidates,
        "excluded": excluded,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def available_issues(event: str) -> dict[datetime, Path]:
    d = S3_DIR / event
    out = {}
    for f in sorted(d.glob("*.tif")):
        try:
            out[parse_issue(f.stem)] = f
        except ValueError:
            continue
    return out


def default_issue(event: str, issues: Sequence[datetime], ahead_h: int = 24) -> datetime:
    """Replays: the S3 issue time nearest to ``ahead_h`` before the first Botley crossing. Live: latest."""
    if event != "live":
        src = PUBLIC / "replays" / f"{event}.json"
        if src.exists():
            doc = json.loads(src.read_text(encoding="utf-8"))
            cross = sorted(parse_issue(c["t"]) for c in doc.get("crossings", []) if c.get("spot") == "botley")
            if cross:
                target = cross[0] - timedelta(hours=ahead_h)
                return min(issues, key=lambda t: abs(t - target))
    return max(issues)


def run(
    event: str, issued: str = "auto", p: Params | None = None, out: Path | None = None, refresh: bool = False
) -> dict:
    t0 = time.time()
    p = p or Params()
    issues = available_issues(event)
    if not issues:
        raise SystemExit(
            f"no S3 rasters in {S3_DIR / event}; run `python -m stretch.s3.spread --event {event}` first"
        )
    t_issue = default_issue(event, list(issues)) if issued == "auto" else parse_issue(issued)
    if t_issue not in issues:
        raise SystemExit(f"no S3 raster for {iso_z(t_issue)}; available: {[iso_z(t) for t in issues]}")
    cells = load_cells(issues[t_issue])
    buildings, osm_def = parse_overpass(json.loads(fetch.fetch_osm(refresh).read_text(encoding="utf-8")))
    ea_def = load_ea_defences(fetch.fetch_defences(cells.bounds, refresh))
    # Only buildings whose centroid is inside the S3 subarea bbox.
    from pyproj import Transformer

    to_wgs = Transformer.from_crs(27700, 4326, always_xy=True)

    def in_box(b: Building) -> bool:
        lon, lat = to_wgs.transform(b.geom.centroid.x, b.geom.centroid.y)
        return fetch.LAT_S <= lat <= fetch.LAT_N and fetch.LON_W <= lon <= fetch.LON_E

    boxed = [in_box(b) for b in buildings]
    measures = measure(cells, buildings, [*osm_def, *ea_def], p, include=boxed)
    doc = screen(cells, measures, p)
    out = out or PUBLIC / "spread" / event / "sandbags.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    summary = {
        "event": event,
        "issuedAt": doc["issuedAt"],
        "buildings": sum(boxed),
        "wetWalls": len(measures),
        "excluded": len(doc["excluded"]),
        "candidates": len(doc["candidates"]),
        "bagsUsed": sum(c["bags"] for c in doc["candidates"]),
        "defenceLines": len(osm_def) + len(ea_def),
        "out": str(out.relative_to(ROOT)) if out.is_relative_to(ROOT) else str(out),
        "runtimeS": round(time.time() - t0, 1),
    }
    print(json.dumps(summary, indent=1))
    return doc


def main(argv: Sequence[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--event", default="e2014", help="replay id (e.g. e2014) or 'live'")
    ap.add_argument(
        "--issued",
        default="auto",
        help="S3 issue time (ISO UTC); default: 24 h before the first Botley crossing",
    )
    ap.add_argument("--budget", type=int, default=Params.budget)
    ap.add_argument("--bags-per-metre", type=float, default=Params.bags_per_metre)
    ap.add_argument("--deploy-h", type=float, default=Params.deploy_h)
    ap.add_argument("--out", type=Path, default=None)
    ap.add_argument("--refresh", action="store_true", help="refetch OSM buildings and EA defences")
    a = ap.parse_args(argv)
    p = Params(budget=a.budget, bags_per_metre=a.bags_per_metre, deploy_h=a.deploy_h)
    run(a.event, a.issued, p, a.out, a.refresh)


if __name__ == "__main__":
    main()
