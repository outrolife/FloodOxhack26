"""S2: ensemble rainfall context for the next 72 h (SPEC §11 S2). Context only, NOT a model input.

Fetches the Open-Meteo ensemble API (ECMWF IFS 0.25°, control + 50 members = 51) for three catchment
points: the Eynsham and Enslow gauges (config/stations.yaml) and Oxford (the osney spot in
config/spots.yaml). For each member: the hourly rain is averaged over the three points, then summed
into a cumulative total for each hour of the next 72 h. The output gives the 10/50/90% of those member
totals at each hour (``ensemble_rain.json``, contract in SPEC §11 / web/src/contracts.ts).

Notes:
- All times are UTC. Open-Meteo's hourly ``precipitation`` at time T is the rain in the hour ending at
  T, so the cumulative total at +h hours sums the values stamped issuedAt+1h .. issuedAt+h.
- ECMWF IFS 0.25° is a ~25 km grid, so the three points can fall in the same grid cell. We still
  average them as the spec says: the result is a catchment-scale signal, not a street-level one.
- Responses are cached in ``data/raw/open_meteo_ensemble/`` (CLAUDE.md rule 5), one file per UTC hour;
  a rerun within the same hour reuses the cache unless ``--refresh`` is given.
- Data: Open-Meteo.com, CC BY 4.0 (credited in the River panel and on About).

Usage: ``python -m stretch.s2_ensemble_rain [--write-web] [--refresh]`` (or ``make s2``).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import numpy as np
import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
STATIONS_YAML = REPO_ROOT / "config" / "stations.yaml"
SPOTS_YAML = REPO_ROOT / "config" / "spots.yaml"
WEB_OUT = REPO_ROOT / "web" / "public" / "data" / "ensemble_rain.json"

API_URL = "https://ensemble-api.open-meteo.com/v1/ensemble"
MODEL = "ecmwf_ifs025"  # ECMWF IFS ensemble, 51 members
HORIZON_H = 72
MIN_MEMBERS = 10  # refuse to publish a fan from a handful of members
VAR = "precipitation"

# Output point name -> (yaml file, list key, item key)
POINTS: list[tuple[str, Path, str, str]] = [
    ("eynsham", STATIONS_YAML, "gauges", "eynsham"),
    ("enslow", STATIONS_YAML, "gauges", "enslow"),
    ("oxford", SPOTS_YAML, "", "osney"),
]


def data_root() -> Path:
    """Shared data root: ``RC_DATA_DIR`` env var, else ``<repo>/data`` (same rule as pipeline)."""
    env = os.environ.get("RC_DATA_DIR")
    return Path(env).expanduser().resolve() if env else REPO_ROOT / "data"


def load_points() -> list[tuple[str, float, float]]:
    """(name, lat, lon) for the three catchment points, read from config."""
    out = []
    for name, path, list_key, key in POINTS:
        doc = yaml.safe_load(path.read_text(encoding="utf-8"))
        items = doc[list_key] if list_key else doc
        item = next((i for i in items if i.get("key") == key), None)
        if item is None:
            raise KeyError(f"{key} not found in {path.name}")
        out.append((name, float(item["lat"]), float(item["lon"])))
    return out


def floor_hour(t: datetime) -> datetime:
    return t.astimezone(UTC).replace(minute=0, second=0, microsecond=0)


def iso_z(t: datetime) -> str:
    return t.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def fetch(points: list[tuple[str, float, float]], issued: datetime, refresh: bool = False) -> list[dict]:
    """One API call for all points, cached per UTC hour under data/raw/open_meteo_ensemble/."""
    cache = data_root() / "raw" / "open_meteo_ensemble" / f"{issued:%Y%m%dT%H}Z.json"
    if cache.is_file() and not refresh:
        return json.loads(cache.read_text(encoding="utf-8"))
    import requests  # only needed on a cache miss

    params = {
        "latitude": ",".join(f"{lat:.5f}" for _, lat, _ in points),
        "longitude": ",".join(f"{lon:.5f}" for _, _, lon in points),
        "hourly": VAR,
        "models": MODEL,
        "forecast_days": 5,  # covers issuedAt + 72 h from any hour of today
        "timezone": "GMT",
        "timeformat": "iso8601",
    }
    r = requests.get(API_URL, params=params, timeout=60)
    r.raise_for_status()
    body = r.json()
    if isinstance(body, dict):  # a single location comes back as one object
        body = [body]
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(body), encoding="utf-8")
    return body


def member_matrix(loc: dict, issued: datetime, horizon: int = HORIZON_H) -> dict[str, np.ndarray]:
    """Hourly rain (mm) for each member at one location, for the hours ending issued+1 .. issued+horizon.

    Returns {member key: array of length horizon}; missing values are NaN.
    """
    hourly = loc["hourly"]
    times = [datetime.fromisoformat(t).replace(tzinfo=UTC) for t in hourly["time"]]
    index = {t: i for i, t in enumerate(times)}
    want = [issued + timedelta(hours=h) for h in range(1, horizon + 1)]
    missing = [t for t in want if t not in index]
    if missing:
        raise ValueError(f"API response does not cover {iso_z(missing[0])} (needs {horizon} h after issue)")
    rows = [index[t] for t in want]
    out: dict[str, np.ndarray] = {}
    for k, vals in hourly.items():
        if k == VAR or k.startswith(f"{VAR}_member"):
            out[k] = np.array([np.nan if vals[i] is None else float(vals[i]) for i in rows])
    return out


def compute(
    body: list[dict], points: list[str], issued: datetime, horizon: int = HORIZON_H
) -> dict[str, Any]:
    """Build the ensemble_rain.json object from the raw API response (one entry per point)."""
    if len(body) != len(points):
        raise ValueError(f"expected {len(points)} locations in the response, got {len(body)}")
    per_loc = [member_matrix(loc, issued, horizon) for loc in body]
    members = sorted(set.intersection(*(set(m) for m in per_loc)))
    totals = []
    for m in members:
        stack = np.vstack([loc[m] for loc in per_loc])  # points x hours
        if np.isnan(stack).any():
            continue  # drop a member with any gap rather than under-count its rain
        hourly_mean = stack.mean(axis=0)
        totals.append(np.concatenate([[0.0], np.cumsum(np.clip(hourly_mean, 0, None))]))
    if len(totals) < MIN_MEMBERS:
        raise ValueError(f"only {len(totals)} complete ensemble members (need {MIN_MEMBERS})")
    cum = np.vstack(totals)  # members x (horizon + 1)
    q = {p: np.percentile(cum, p, axis=0) for p in (10, 50, 90)}
    # Rounding after the percentile keeps each series non-decreasing and p10 <= p50 <= p90.
    return {
        "issuedAt": iso_z(issued),
        "points": points,
        "hours": list(range(horizon + 1)),
        "cumMm": {f"p{p}": [round(float(v), 1) for v in q[p]] for p in (10, 50, 90)},
    }


def write_json(obj: dict, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, separators=(",", ":")) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--write-web", action="store_true", help="also write web/public/data/ensemble_rain.json")
    ap.add_argument("--refresh", action="store_true", help="ignore this hour's cached API response")
    args = ap.parse_args(argv)

    pts = load_points()
    issued = floor_hour(datetime.now(UTC))
    body = fetch(pts, issued, refresh=args.refresh)
    out = compute(body, [p[0] for p in pts], issued)

    targets = [data_root() / "processed" / "ensemble_rain.json"]
    if args.write_web:
        targets.append(WEB_OUT)
    for t in targets:
        write_json(out, t)
        print(f"wrote {t}")
    c = out["cumMm"]
    p10, p50, p90 = (c[k][-1] for k in ("p10", "p50", "p90"))
    print(f"issuedAt {out['issuedAt']}: 72 h rain p10 {p10} mm, p50 {p50} mm, p90 {p90} mm")
    return 0


if __name__ == "__main__":
    sys.exit(main())
