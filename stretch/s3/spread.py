"""Experimental flood-spread ensemble for the Osney/Botley subarea (SPEC §11 S3, issue #22).

Run: ``python -m stretch.s3.spread --event e2014`` (or ``--event live``).

Method (SPEC §11 S3), for each forecast issue time and lead tau in {6, 12, 24, 36, 48, 72} h:

1. N = 200 runs. Run k draws a New Botley level from that forecast's quantile distribution at tau
   (inverse of the SPEC §7.5 CDF) and converts it to a water-surface elevation:
   WSE (mAOD) = stage + 54.00 m (gauge 1645TH ``stageScale.datum``, verified on #22).
2. Run k uses its own copy of the 5 m DTM plus smoothed noise (sigma 0.15 m, Gaussian radius
   25 m) for LiDAR error.
3. Wet = cells below the WSE that are 4-connected (``scipy.ndimage.label``) to a river cell.
4. Per cell: ensemble frequency (share of runs wet), median depth among wet runs, and the earliest
   tau at which the frequency reaches 0.5.

Speed-up (same answer): wet(WSE) only grows as the WSE rises, so for each run we compute once the
lowest level, on a 1 cm grid, at which each cell becomes wet ("spill level"). A run is then wet
wherever ``spill <= its WSE``, so every issue time and lead costs one comparison instead of
200 fills. Sampled WSEs are rounded down to the 1 cm grid (well inside the 0.15 m DTM noise).
``wet_mask`` is the plain per-run fill; the tests check both agree.

Draws are stratified (u = (rank + 0.5) / N over a seeded permutation) and paired with the same
noise fields for every frame, so frames change smoothly with time and runs are reproducible.

Outputs (SPEC §11 contract): transparent PNGs, north-up in EPSG:4326 for a Leaflet imageOverlay,
under ``web/public/data/spread/{event}/``, plus ``manifest.json``. PNGs are named by content hash,
so identical frames (often empty ones) share a file. Per-cell rasters (frequency, median depth,
first tau) for every exported issue time go to ``$RC_DATA_DIR/processed/s3/{event}/cells.npz``
for S4 (keys in ``save_cells``).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import time
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from scipy import ndimage

from model.probability import ALPHAS, HORIZONS_H, QUANT_KEYS
from stretch.s3 import fetch
from stretch.s3.png import RGBA, encode_indexed_png

ROOT = Path(__file__).resolve().parents[2]
PUBLIC = ROOT / "web" / "public" / "data"

# Subarea (SPEC §11 S3) in WGS84 and the overlay grid.
LAT_S, LON_W, LAT_N, LON_E = 51.745, -1.290, 51.758, -1.265
BOUNDS_WGS84 = [[LAT_S, LON_W], [LAT_N, LON_E]]
CELL_M = 5.0
PAD_M = 100.0  # model grid margin beyond the bbox, so channels entering the box stay connected

GAUGE = "newbotley"
SPOT = "botley"
DATUM_MAOD = 54.00  # newbotley 1645TH stageScale.datum (EA flood-monitoring API), verified on #22
DATUM_TOL_M = 0.05

N_RUNS = 200
NOISE_SIGMA_M = 0.15
NOISE_RADIUS_M = 25.0  # used as the Gaussian filter's standard deviation
LEVEL_STEP_M = 0.01
SEED = 42
TAUS: tuple[int, ...] = HORIZONS_H

# Frequency classes for the PNG (agreed with the S3 UI, PR #95): [lower bound, RGBA].
# Below 0.10 is transparent; #c6dbef, #6baed6, #2171b5, #08306b.
CLASSES: list[tuple[float, RGBA]] = [
    (0.10, (0xC6, 0xDB, 0xEF, 255)),
    (0.25, (0x6B, 0xAE, 0xD6, 255)),
    (0.50, (0x21, 0x71, 0xB5, 255)),
    (0.75, (0x08, 0x30, 0x6B, 255)),
]
PALETTE: list[RGBA] = [(0, 0, 0, 0)] + [c for _, c in CLASSES]

CAVEATS_BASE = [
    "Experimental. A simple terrain fill: ignores channel flow, walls, drains, pumps and defences. "
    "Ensemble frequency, not a verified flood probability.",
    f"One flat water level for the whole area, from the New Botley gauge (1645TH) plus its stage "
    f"datum {DATUM_MAOD:.2f} mAOD (EA station metadata, about ±{DATUM_TOL_M:.2f} m); it ignores the "
    "river's slope and the drop at Osney Lock, so it overstates water east of the lock.",
    f"Terrain: {fetch.DTM_SOURCE}. River cells: EA Statutory Main River Map (OGL v3).",
    f"{N_RUNS} runs per frame: forecast level drawn from the River Clock quantiles; terrain "
    f"perturbed by ±{NOISE_SIGMA_M:.2f} m smoothed noise for LiDAR error.",
    "Shading: share of runs in which a cell is wet. Palest 10-25%, then 25-50%, 50-75%, darkest 75% or more.",
]


# ---------------------------------------------------------------------------
# Sampling (SPEC §7.5 inverse CDF)
# ---------------------------------------------------------------------------


def inverse_cdf(q: Sequence[float], u: np.ndarray) -> np.ndarray:
    """Level x with F(x) = u, for the SPEC §7.5 CDF on quantiles ``q`` (7 values on ``ALPHAS``).

    Linear between quantiles; below q05 the 0.05-0.25 slope, above q95 the 0.75-0.95 slope. Because
    F is clipped to [0, 1], u in (0, 1) always maps inside its support.
    """
    qs = np.sort(np.asarray(q, dtype=float))
    a = np.asarray(ALPHAS)
    u = np.asarray(u, dtype=float)
    x = np.interp(u, a, qs)
    lo_slope = (qs[2] - qs[0]) / (a[2] - a[0])  # metres per unit probability
    hi_slope = (qs[6] - qs[4]) / (a[6] - a[4])
    x = np.where(u < a[0], qs[0] - (a[0] - u) * lo_slope, x)
    x = np.where(u > a[-1], qs[6] + (u - a[-1]) * hi_slope, x)
    return x


def stratified_uniforms(n: int, seed: int = SEED) -> np.ndarray:
    """n uniforms, one in each 1/n stratum, in a seeded random order (paired with noise field k)."""
    rng = np.random.default_rng(seed)
    return (rng.permutation(n) + 0.5) / n


# ---------------------------------------------------------------------------
# Terrain fill
# ---------------------------------------------------------------------------

_FOUR = ndimage.generate_binary_structure(2, 1)  # 4-connectivity


def wet_mask(dtm: np.ndarray, wse: float, river: np.ndarray) -> np.ndarray:
    """Cells below ``wse`` that are 4-connected to a river cell (river cells count as wet)."""
    below = (dtm < wse) | river
    lab, _ = ndimage.label(below, structure=_FOUR)
    ids = np.unique(lab[river])
    ids = ids[ids > 0]
    return np.isin(lab, ids)


def spill_index(dtm: np.ndarray, river: np.ndarray, levels: np.ndarray) -> np.ndarray:
    """Per cell, the first index j with the cell wet at ``levels[j]`` (``len(levels)`` if never).

    ``levels`` must be increasing. Equivalent to ``wet_mask`` at every level, stored compactly.
    """
    out = np.full(dtm.shape, len(levels), dtype=np.int16)
    for j, lev in enumerate(levels):
        if j and (out <= j - 1).all():
            break
        wet = wet_mask(dtm, float(lev), river)
        out[(out == len(levels)) & wet] = j
    return out


def noise_field(
    shape: tuple[int, int], rng: np.random.Generator, sigma_m: float, radius_cells: float
) -> np.ndarray:
    """Spatially smoothed Gaussian noise with standard deviation ``sigma_m``."""
    f = ndimage.gaussian_filter(rng.standard_normal(shape), radius_cells, mode="reflect")
    return (f / f.std() * sigma_m).astype(np.float32)


@dataclass
class Ensemble:
    """Per-run spill levels for N perturbed DTMs on one grid."""

    dtm: np.ndarray  # (ny, nx) base DTM, mAOD
    noise: np.ndarray  # (N, ny, nx) float32 perturbations
    river: np.ndarray  # (ny, nx) bool
    levels: np.ndarray  # (L,) WSE grid, mAOD
    spill: np.ndarray  # (N, ny, nx) int16 indices into levels
    u: np.ndarray  # (N,) stratified uniforms paired with the noise fields

    @property
    def runs(self) -> int:
        return len(self.u)

    def level_index(self, wse: np.ndarray) -> np.ndarray:
        """Round WSEs down to the level grid, capped at the top (spill levels stop there)."""
        j = np.floor((np.asarray(wse) - self.levels[0]) / LEVEL_STEP_M + 1e-6).astype(int)
        if (j < 0).any():
            raise ValueError("WSE below the ensemble's level grid; build it with a lower wse_min")
        return np.minimum(j, len(self.levels) - 1)

    def wet(self, wse: np.ndarray) -> np.ndarray:
        """(N, ny, nx) wet masks for one WSE per run."""
        j = self.level_index(wse)
        return self.spill <= j[:, None, None]

    def frequency(self, wse: np.ndarray) -> np.ndarray:
        return self.wet(wse).mean(axis=0)

    def median_depth(self, wse: np.ndarray) -> np.ndarray:
        """Median depth (m) among wet runs; NaN where never wet."""
        wet = self.wet(wse)
        depth = np.asarray(wse, dtype=np.float32)[:, None, None] - (
            self.dtm.astype(np.float32)[None] + self.noise
        )
        depth = np.where(wet, np.maximum(depth, 0.0), np.nan)
        with np.errstate(all="ignore"):
            import warnings

            with warnings.catch_warnings():
                warnings.simplefilter("ignore", RuntimeWarning)
                return np.nanmedian(depth, axis=0)


def build_ensemble(
    dtm: np.ndarray,
    river: np.ndarray,
    wse_min: float,
    wse_max: float,
    n_runs: int = N_RUNS,
    sigma_m: float = NOISE_SIGMA_M,
    radius_cells: float = NOISE_RADIUS_M / CELL_M,
    seed: int = SEED,
    log: bool = False,
) -> Ensemble:
    """Draw the N noise fields and compute each run's spill levels for WSEs in [wse_min, wse_max].

    Cells already wet at ``wse_min`` get index 0, so the grid only needs to start there.
    """
    rng = np.random.default_rng(seed + 1)
    noise = np.stack([noise_field(dtm.shape, rng, sigma_m, radius_cells) for _ in range(n_runs)])
    lo = math.floor(wse_min / LEVEL_STEP_M) * LEVEL_STEP_M
    hi = math.ceil(wse_max / LEVEL_STEP_M) * LEVEL_STEP_M
    levels = np.round(np.arange(lo, hi + LEVEL_STEP_M / 2, LEVEL_STEP_M), 4)
    spill = np.empty((n_runs, *dtm.shape), dtype=np.int16)
    t0 = time.time()
    for k in range(n_runs):
        spill[k] = spill_index(dtm + noise[k], river, levels)
        if log and (k + 1) % 20 == 0:
            print(f"  spill levels: {k + 1}/{n_runs} runs ({time.time() - t0:.0f} s)", flush=True)
    return Ensemble(
        dtm=dtm, noise=noise, river=river, levels=levels, spill=spill, u=stratified_uniforms(n_runs, seed)
    )


# ---------------------------------------------------------------------------
# Grid, inputs and reprojection
# ---------------------------------------------------------------------------


@dataclass
class Grid:
    """The 5 m model grid in EPSG:27700 (north-up, row 0 = north)."""

    xmin: float
    ymax: float
    nx: int
    ny: int

    @property
    def transform(self) -> Any:
        from rasterio.transform import from_origin

        return from_origin(self.xmin, self.ymax, CELL_M, CELL_M)

    @property
    def bounds(self) -> fetch.Bounds:
        return (
            int(self.xmin),
            int(self.ymax - self.ny * CELL_M),
            int(self.xmin + self.nx * CELL_M),
            int(self.ymax),
        )


def bbox_bng() -> tuple[float, float, float, float]:
    """The WGS84 bbox's extent in EPSG:27700 (densified edges)."""
    from pyproj import Transformer

    t = Transformer.from_crs(4326, 27700, always_xy=True)
    lons = np.r_[
        np.linspace(LON_W, LON_E, 50), np.full(50, LON_E), np.linspace(LON_E, LON_W, 50), np.full(50, LON_W)
    ]
    lats = np.r_[
        np.full(50, LAT_S), np.linspace(LAT_S, LAT_N, 50), np.full(50, LAT_N), np.linspace(LAT_N, LAT_S, 50)
    ]
    x, y = t.transform(lons, lats)
    return float(np.min(x)), float(np.min(y)), float(np.max(x)), float(np.max(y))


def model_grid() -> Grid:
    x0, y0, x1, y1 = bbox_bng()
    xmin = math.floor((x0 - PAD_M) / 100) * 100
    ymin = math.floor((y0 - PAD_M) / 100) * 100
    xmax = math.ceil((x1 + PAD_M) / 100) * 100
    ymax = math.ceil((y1 + PAD_M) / 100) * 100
    return Grid(xmin=xmin, ymax=ymax, nx=int((xmax - xmin) / CELL_M), ny=int((ymax - ymin) / CELL_M))


def load_dtm(grid: Grid) -> np.ndarray:
    """1 m DTM -> 5 m by block mean (the WCS grid is aligned to whole metres)."""
    import rasterio

    with rasterio.open(fetch.fetch_dtm(grid.bounds)) as src:
        a = src.read(1).astype(np.float64)
        nodata = src.nodata
        assert abs(src.transform.c - grid.xmin) < 1e-6 and abs(src.transform.f - grid.ymax) < 1e-6
    if nodata is not None:
        a[a == nodata] = np.nan
    a[a < -100] = np.nan
    f = int(CELL_M)
    a = a[: grid.ny * f, : grid.nx * f].reshape(grid.ny, f, grid.nx, f)
    with np.errstate(all="ignore"):
        import warnings

        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            out = np.nanmean(a, axis=(1, 3))
    if np.isnan(out).any():  # voids (rare in the composite): fill with the nearest valid cell
        idx = ndimage.distance_transform_edt(np.isnan(out), return_distances=False, return_indices=True)
        out = out[tuple(idx)]
    return out


def river_cells(grid: Grid) -> np.ndarray:
    import geopandas as gpd
    from rasterio.features import rasterize

    g = gpd.read_file(fetch.fetch_rivers(grid.bounds))
    if g.crs is None or g.crs.to_epsg() != 27700:
        g = g.set_crs(27700, allow_override=True) if g.crs is None else g.to_crs(27700)
    r = rasterize(
        [(geom, 1) for geom in g.geometry if geom is not None and not geom.is_empty],
        out_shape=(grid.ny, grid.nx),
        transform=grid.transform,
        all_touched=True,
        dtype="uint8",
    )
    return r.astype(bool)


@dataclass
class Overlay:
    """North-up EPSG:4326 grid exactly covering ``BOUNDS_WGS84`` at about 5 m."""

    width: int
    height: int

    @property
    def transform(self) -> Any:
        from rasterio.transform import from_bounds

        return from_bounds(LON_W, LAT_S, LON_E, LAT_N, self.width, self.height)


def overlay_grid() -> Overlay:
    mid = math.radians((LAT_S + LAT_N) / 2)
    w = round((LON_E - LON_W) * 111_320 * math.cos(mid) / CELL_M)
    h = round((LAT_N - LAT_S) * 111_200 / CELL_M)
    return Overlay(width=w, height=h)


def to_wgs84(a: np.ndarray, grid: Grid, ov: Overlay, nodata: float = 0) -> np.ndarray:
    """Nearest-neighbour reprojection of a model-grid array onto the overlay grid."""
    from rasterio.warp import Resampling, reproject

    dst = np.full((ov.height, ov.width), nodata, dtype=a.dtype)
    reproject(
        source=a,
        destination=dst,
        src_transform=grid.transform,
        src_crs="EPSG:27700",
        dst_transform=ov.transform,
        dst_crs="EPSG:4326",
        resampling=Resampling.nearest,
        src_nodata=None,
        dst_nodata=nodata,
    )
    return dst


def in_bbox_mask(grid: Grid) -> np.ndarray:
    """Model-grid cells whose centre lies inside the WGS84 bbox."""
    from pyproj import Transformer

    t = Transformer.from_crs(27700, 4326, always_xy=True)
    xs = grid.xmin + (np.arange(grid.nx) + 0.5) * CELL_M
    ys = grid.ymax - (np.arange(grid.ny) + 0.5) * CELL_M
    X, Y = np.meshgrid(xs, ys)
    lon, lat = t.transform(X, Y)
    return (lon >= LON_W) & (lon <= LON_E) & (lat >= LAT_S) & (lat <= LAT_N)


def classify(freq: np.ndarray) -> np.ndarray:
    idx = np.zeros(freq.shape, dtype=np.uint8)
    for i, (lo, _) in enumerate(CLASSES, start=1):
        idx[freq >= lo - 1e-9] = i
    return idx


# ---------------------------------------------------------------------------
# Forecast inputs
# ---------------------------------------------------------------------------


@dataclass
class Issue:
    issued_at: str
    q: dict[int, list[float]]  # tau -> 7 level quantiles (gauge datum, m)


def forecast_issues(forecasts: list[dict]) -> list[Issue]:
    out = []
    for f in forecasts:
        spot = next((s for s in f.get("spots", []) if s.get("spot") == SPOT), None)
        if spot is None:
            continue
        q = {}
        for lead in spot.get("leads", []):
            vals = [lead.get("q", {}).get(k) for k in QUANT_KEYS]
            if lead.get("h") in TAUS and all(isinstance(v, int | float) for v in vals):
                q[int(lead["h"])] = [float(v) for v in vals]
        if q:
            out.append(Issue(issued_at=f["issuedAt"], q=q))
    return out


def sampled_wse(issue: Issue, tau: int, u: np.ndarray) -> np.ndarray:
    return inverse_cdf(issue.q[tau], u) + DATUM_MAOD


def _ts(s: str) -> pd.Timestamp:
    return pd.Timestamp(s).tz_convert("UTC") if pd.Timestamp(s).tzinfo else pd.Timestamp(s, tz="UTC")


def _iso(t: pd.Timestamp) -> str:
    return t.tz_convert("UTC").strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def recorded_mask(grid: Grid, path: Path, fluvial_only: bool = True) -> np.ndarray:
    import geopandas as gpd
    from rasterio.features import rasterize

    g = gpd.read_file(path)
    if g.crs is None:
        g = g.set_crs(27700)
    g = g.to_crs(27700)
    if fluvial_only and "flood_src" in g:
        g = g[g["flood_src"].astype(str).str.lower() == "main river"]
    if g.empty:
        raise RuntimeError(f"no recorded outline in {path}")
    r = rasterize(
        [(geom, 1) for geom in g.geometry],
        out_shape=(grid.ny, grid.nx),
        transform=grid.transform,
        dtype="uint8",
    )
    return r.astype(bool)


def iou(a: np.ndarray, b: np.ndarray, within: np.ndarray) -> float:
    a, b = a & within, b & within
    union = (a | b).sum()
    return float((a & b).sum() / union) if union else 0.0


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def _write_png(
    out_dir: Path, rel_dir: str, tau: int, idx: np.ndarray, cache: dict[str, str]
) -> tuple[str, int]:
    """Write a frame named by lead and content hash; identical images share one file."""
    data = encode_indexed_png(idx, PALETTE)
    h = hashlib.sha1(data).hexdigest()[:10]
    if h not in cache:
        name = f"tau{tau:02d}_{h}.png"
        (out_dir / name).write_bytes(data)
        cache[h] = f"{rel_dir}/{name}"
    return cache[h], len(data)


def save_cells(
    path: Path,
    grid: Grid,
    river: np.ndarray,
    dtm: np.ndarray,
    within: np.ndarray,
    issued_at: list[str],
    freq: np.ndarray,
    depth: np.ndarray,
    first_tau: np.ndarray,
) -> None:
    """Per-cell outputs for S4 (#23), on the 5 m EPSG:27700 model grid (row 0 = north).

    Keys: ``issued_at`` (I,) str; ``tau_h`` (T,); ``freq`` (I, T, H, W) share of runs wet;
    ``median_depth_m`` (I, T, H, W), NaN where never wet; ``first_tau_h`` (I, H, W), earliest tau
    with freq >= 0.5, NaN if none; ``transform`` (6,) affine a, b, c, d, e, f (x = a*col + b*row + c,
    y = d*col + e*row + f, at cell corners); ``crs`` "EPSG:27700"; ``cell_m``; ``river`` (H, W)
    seed cells; ``dtm_maod`` (H, W) unperturbed 5 m DTM; ``in_bbox`` (H, W) cell centre inside the
    WGS84 bbox; ``runs``; ``seed``; ``datum_maod``.
    """
    t = grid.transform
    path.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        path,
        issued_at=np.array(issued_at),
        tau_h=np.array(TAUS),
        freq=freq.astype(np.float32),
        median_depth_m=depth.astype(np.float32),
        first_tau_h=first_tau.astype(np.float32),
        transform=np.array([t.a, t.b, t.c, t.d, t.e, t.f]),
        crs=np.array("EPSG:27700"),
        cell_m=np.array(CELL_M),
        river=river,
        dtm_maod=dtm.astype(np.float32),
        in_bbox=within,
        runs=np.array(N_RUNS),
        seed=np.array(SEED),
        datum_maod=np.array(DATUM_MAOD),
    )


def select_issues(issues: list[Issue], every_h: int, keep: Sequence[str]) -> list[Issue]:
    """Issue times on an ``every_h`` grid (UTC hours divisible by it) plus the named ones."""
    keep_set = set(keep)
    return [i for i in issues if _ts(i.issued_at).hour % every_h == 0 or i.issued_at in keep_set]


def nearest_issue(issues: list[Issue], t: pd.Timestamp) -> Issue:
    return min(issues, key=lambda i: abs(_ts(i.issued_at) - t))


def run(event: str, every_h: int = 0, n_runs: int = N_RUNS, seed: int = SEED) -> dict:
    t_start = time.time()
    src = PUBLIC / ("live.json" if event == "live" else f"replays/{event}.json")
    if not src.exists():
        raise SystemExit(f"{src} not found; nothing to do for {event!r}")
    doc = json.loads(src.read_text(encoding="utf-8"))
    forecasts = [doc] if event == "live" else doc["forecasts"]
    issues = forecast_issues(forecasts)
    if not issues:
        raise SystemExit(f"no {SPOT!r} forecasts in {src}")

    # Demo-relevant issue times (replays only): 72/48/24/12 h before the first botley crossing,
    # and 24 h / 6 h before the observed gauge peak (the 6 h one is the validation frame).
    key: dict[str, str] = {}
    peak_t: pd.Timestamp | None = None
    peak_level: float | None = None
    if event != "live":
        cross = sorted(_ts(c["t"]) for c in doc.get("crossings", []) if c["spot"] == SPOT)
        for ahead in (72, 48, 24, 12) if cross else ():
            key[f"crossing-{ahead}h"] = nearest_issue(issues, cross[0] - pd.Timedelta(hours=ahead)).issued_at
        obs = doc.get("observed", {}).get(GAUGE, [])
        if obs:
            pk = max(obs, key=lambda r: r["level"])
            peak_t, peak_level = _ts(pk["t"]), float(pk["level"])
            key["peak-6h"] = nearest_issue(issues, peak_t - pd.Timedelta(hours=6)).issued_at
            key["peak-24h"] = nearest_issue(issues, peak_t - pd.Timedelta(hours=24)).issued_at
    if event == "live":
        chosen = issues
    elif every_h > 0:
        chosen = select_issues(issues, every_h, list(key.values()))
    else:
        chosen = [i for i in issues if i.issued_at in set(key.values())]

    grid = model_grid()
    print(
        f"[s3] {event}: {len(chosen)} issue times x {len(TAUS)} leads; "
        f"grid {grid.nx}x{grid.ny} @ {CELL_M:g} m"
    )
    dtm = load_dtm(grid)
    river = river_cells(grid)
    u = stratified_uniforms(n_runs, seed)
    wses = [sampled_wse(i, t, u) for i in chosen for t in TAUS if t in i.q]
    wse_min, wse_max = min(float(w.min()) for w in wses), max(float(w.max()) for w in wses)
    if peak_level is not None:
        wse_max = max(wse_max, peak_level + DATUM_MAOD)
    ens = build_ensemble(dtm, river, wse_min, wse_max, n_runs=n_runs, seed=seed, log=True)
    t_ens = time.time() - t_start
    print(f"[s3] ensemble ready in {t_ens:.0f} s ({len(ens.levels)} levels)")

    rel_dir = f"spread/{event}"
    out_dir = PUBLIC / rel_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob("*.png"):
        old.unlink()
    ov = overlay_grid()
    cache: dict[str, str] = {}
    frames = []
    proc_dir = fetch.DATA_DIR / "processed" / "s3" / event
    within = in_bbox_mask(grid)
    max_ha = 0.0
    cell_freq: list[np.ndarray] = []
    cell_depth: list[np.ndarray] = []
    cell_first: list[np.ndarray] = []
    for issue in chosen:
        freqs: dict[int, np.ndarray] = {}
        for tau in TAUS:
            if tau not in issue.q:
                continue
            wse = sampled_wse(issue, tau, ens.u)
            freq = ens.frequency(wse)
            freqs[tau] = freq
            max_ha = max(max_ha, float(((freq >= 0.5) & within & ~river).sum()) * CELL_M**2 / 1e4)
            # River centreline cells are seeds of the fill, not results: leave them unpainted.
            cls = np.where(river, 0, classify(freq)).astype(np.uint8)
            png, _ = _write_png(out_dir, rel_dir, tau, to_wgs84(cls, grid, ov), cache)
            frames.append({"tau": tau, "issuedAt": issue.issued_at, "png": png})
        cell_freq.append(np.stack([freqs.get(t, np.full(river.shape, np.nan)) for t in TAUS]))
        cell_depth.append(
            np.stack(
                [
                    ens.median_depth(sampled_wse(issue, t, ens.u))
                    if t in freqs
                    else np.full(river.shape, np.nan)
                    for t in TAUS
                ]
            )
        )
        ft = np.full(river.shape, np.nan)
        for t in sorted(freqs, reverse=True):
            ft[freqs[t] >= 0.5] = t
        cell_first.append(ft)
    cells_path = proc_dir / "cells.npz"
    save_cells(
        cells_path,
        grid,
        river,
        dtm,
        within,
        [i.issued_at for i in chosen],
        np.stack(cell_freq),
        np.stack(cell_depth),
        np.stack(cell_first),
    )
    print(f"[s3] per-cell outputs: {cells_path}")

    # Validation (replays): frequency >= 0.5 at the peak vs the Winter 2013/2014 outline.
    validation = None
    diag: dict[str, Any] = {}
    if event == "e2014" and peak_t is not None:
        rec = recorded_mask(grid, fetch.fetch_recorded_2014(grid.bounds), fluvial_only=True)
        rec_all = recorded_mask(grid, fetch.fetch_recorded_2014(grid.bounds), fluvial_only=False)
        by_issue = {i.issued_at: i for i in issues}
        for label, tau in (("peak-6h", 6), ("peak-24h", 24)):
            i = by_issue[key[label]]
            ext = ens.frequency(sampled_wse(i, tau, ens.u)) >= 0.5
            diag[f"iou_{label}"] = round(iou(ext, rec, within), 3)
            diag[f"iou_{label}_all_outlines"] = round(iou(ext, rec_all, within), 3)
            diag[f"wet_share_{label}"] = round(float((ext & within).sum() / within.sum()), 3)
        obs_ext = ens.frequency(np.full(ens.runs, peak_level + DATUM_MAOD)) >= 0.5
        diag["iou_observed_peak_level"] = round(iou(obs_ext, rec, within), 3)
        diag["recorded_share"] = round(float((rec & within).sum() / within.sum()), 3)
        diag["peak"] = {"t": _iso(peak_t), "level": peak_level, "wseMaod": round(peak_level + DATUM_MAOD, 3)}
        validation = {"eventId": event, "iou": diag["iou_peak-6h"]}

    caveats = list(CAVEATS_BASE)
    box_ha = float(within.sum()) * CELL_M**2 / 1e4
    caveats.append(
        f"Largest extent wet in at least half the runs, over these frames: {max_ha:.0f} ha of the "
        f"{box_ha:.0f} ha box, not counting the mapped river centrelines."
    )
    if validation:
        caveats.append(
            f"Check against the EA Recorded Flood Outline for winter 2013/14 "
            f"at the {diag['peak']['t'][:10]} peak "
            f"(forecast issued 6 h ahead, 50% ensemble extent): IoU {validation['iou']:.2f} inside the box."
        )
    manifest = {
        "bounds": BOUNDS_WGS84,
        "runs": n_runs,
        "frames": frames,
        "validation": validation,
        "caveats": caveats,
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=1) + "\n", encoding="utf-8")
    size = sum(p.stat().st_size for p in out_dir.iterdir() if p.is_file())
    summary = {
        "event": event,
        "issueTimes": len(chosen),
        "frames": len(frames),
        "pngFiles": len(cache),
        "bytes": size,
        "runtimeS": round(time.time() - t_start, 1),
        "ensembleS": round(t_ens, 1),
        "keyIssues": key,
        **diag,
    }
    print(json.dumps(summary, indent=1))
    return summary


def main(argv: Sequence[str] | None = None) -> None:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--event", default="e2014", help="replay id (e.g. e2014) or 'live'")
    p.add_argument(
        "--every",
        type=int,
        default=0,
        help="also add every issue time on an N-hour UTC grid (replays; default 0 = demo issue times only)",
    )
    p.add_argument("--runs", type=int, default=N_RUNS)
    p.add_argument("--seed", type=int, default=SEED)
    a = p.parse_args(argv)
    run(a.event, every_h=a.every, n_runs=a.runs, seed=a.seed)


if __name__ == "__main__":
    main()
