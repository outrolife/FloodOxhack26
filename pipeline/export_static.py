"""Export the static SPEC §9 files the web app reads: stations.json, spots.json, events.json.

Writes ``web/public/data/{stations,spots,events}.json`` from ``config/*.yaml`` (issue #46):

* ``stations.json``: one ``Station`` per gauge in ``config/stations.yaml`` (``gauges:``, then the
  display-only ``catchment_gauges:`` of #146), with exactly
  the §9 fields ``key, name, river, role, ref, lat, lon, amber, threshold, record``.
  ``role`` is ``upstream | target | live_only`` (SPEC §4.1.1).
* ``spots.json``: one ``Spot`` per entry in ``config/spots.yaml`` (§9 fields only).
* ``events.json``: one ``EventMeta`` per entry in ``config/events.yaml``. ``peak`` is recomputed from
  ``hourly.parquet`` as the max ``level_max`` inside the event window for each **trained** gauge
  (``role: target``). Lock head-water series (``*_us``), live-only gauges and rain are skipped.
  If hourly.parquet is missing, or a gauge has no data in a window, the peak from events.yaml is
  kept (and logged). ``headline`` is true for e2014 (the headline replay, SPEC §4.3) and for any
  event events.yaml marks as headline.

Idempotent: the output depends only on the inputs, and files are rewritten only when their content
changes. Run: ``python -m pipeline.export_static`` (``--no-peaks`` skips the parquet).
"""

from __future__ import annotations

import argparse
import json
import logging
from pathlib import Path
from typing import Any

import pandas as pd
import yaml

from pipeline.stations import REPO_ROOT, UPSTREAM_SUFFIX

log = logging.getLogger("pipeline.export_static")

CONFIG = REPO_ROOT / "config"
OUT_DIR = REPO_ROOT / "web" / "public" / "data"
HEADLINE_EVENT = "e2014"
PEAK_ROLES = {"target"}  # trained gauges (SPEC §4.1.1)

STATION_FIELDS = ["key", "name", "river", "role", "ref", "lat", "lon", "amber", "threshold", "record"]
SPOT_FIELDS = ["key", "name", "gauge", "threshold", "amber", "lat", "lon", "warningArea", "mode"]
STATION_ROLES = {"upstream", "target", "live_only"}
SPOT_MODES = {"probability", "timing_only"}


# --------------------------------------------------------------------------------------------------
# Readers
# --------------------------------------------------------------------------------------------------

def _yaml(path: Path) -> Any:
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def _num(v: Any, what: str) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise ValueError(f"{what}: expected a number, got {v!r}")
    return float(v)


def _num_or_none(v: Any, what: str) -> float | None:
    return None if v is None else _num(v, what)


def _utc(v: Any, what: str) -> str:
    """Any timestamp -> ISO 8601 UTC with a trailing Z (seconds precision)."""
    ts = pd.Timestamp(v)
    ts = ts.tz_localize("UTC") if ts.tzinfo is None else ts.tz_convert("UTC")
    if pd.isna(ts):
        raise ValueError(f"{what}: bad timestamp {v!r}")
    return ts.strftime("%Y-%m-%dT%H:%M:%SZ")


def build_stations(doc: dict[str, Any]) -> list[dict[str, Any]]:
    """``gauges:`` then the display-only ``catchment_gauges:`` (#146, role live_only) not already in it."""
    out = []
    core = {str(g["key"]) for g in doc["gauges"]}
    ring = [g for g in doc.get("catchment_gauges") or [] if str(g["key"]) not in core]
    for g in [*doc["gauges"], *ring]:
        key = str(g["key"])
        role = str(g["role"])
        if role not in STATION_ROLES:
            raise ValueError(f"stations.yaml {key}: role {role!r} not in {sorted(STATION_ROLES)}")
        out.append(
            {
                "key": key,
                "name": str(g["name"]),
                "river": str(g["river"]),
                "role": role,
                "ref": str(g["ref"]),
                "lat": _num(g["lat"], f"{key}.lat"),
                "lon": _num(g["lon"], f"{key}.lon"),
                "amber": _num(g["amber"], f"{key}.amber"),
                "threshold": _num_or_none(g.get("threshold"), f"{key}.threshold"),
                "record": _num_or_none(g.get("record"), f"{key}.record"),
            }
        )
    return out


def build_spots(doc: list[dict[str, Any]], stations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_key = {s["key"]: s for s in stations}
    out = []
    for s in doc:
        key = str(s["key"])
        gauge = str(s["gauge"])
        mode = str(s.get("mode", "probability"))
        if gauge not in by_key:
            raise ValueError(f"spots.yaml {key}: unknown gauge {gauge!r}")
        if mode not in SPOT_MODES:
            raise ValueError(f"spots.yaml {key}: mode {mode!r} not in {sorted(SPOT_MODES)}")
        if s.get("threshold") is None:
            raise ValueError(f"spots.yaml {key}: threshold is required (use mode timing_only if unverified)")
        out.append(
            {
                "key": key,
                "name": str(s["name"]),
                "gauge": gauge,
                "threshold": _num(s["threshold"], f"{key}.threshold"),
                "amber": _num(s["amber"], f"{key}.amber"),
                "lat": _num(s["lat"], f"{key}.lat"),
                "lon": _num(s["lon"], f"{key}.lon"),
                "warningArea": str(s["warningArea"]),
                "mode": mode,
            }
        )
    return out


def peak_gauges(stations: list[dict[str, Any]]) -> list[str]:
    """Gauges that get an event peak: trained targets, never *_us or live-only series."""
    return [
        s["key"]
        for s in stations
        if s["role"] in PEAK_ROLES and not s["key"].endswith(UPSTREAM_SUFFIX)
    ]


def compute_peaks(
    hourly: pd.DataFrame | None, gauges: list[str], start: str, end: str
) -> dict[str, float]:
    """Max hourly ``level_max`` per gauge within [start, end] (UTC). Gauges with no data are omitted."""
    if hourly is None or hourly.empty:
        return {}
    t0, t1 = pd.Timestamp(start), pd.Timestamp(end)
    sel = hourly[
        hourly["gauge"].isin(gauges)
        & (hourly["kind"] == "level")
        & (hourly["ts_utc"] >= t0)
        & (hourly["ts_utc"] <= t1)
    ]
    peaks = sel.groupby("gauge", observed=True)["level_max"].max().dropna()
    return {str(g): round(float(v), 3) for g, v in peaks.items()}


def build_events(
    doc: list[dict[str, Any]], stations: list[dict[str, Any]], hourly: pd.DataFrame | None
) -> list[dict[str, Any]]:
    gauges = peak_gauges(stations)
    out = []
    for e in doc:
        eid = str(e["id"])
        start, end = _utc(e["start"], f"{eid}.start"), _utc(e["end"], f"{eid}.end")
        if pd.Timestamp(start) >= pd.Timestamp(end):
            raise ValueError(f"events.yaml {eid}: start must be before end")
        config_peak = {str(k): float(v) for k, v in (e.get("peak") or {}).items()}
        computed = compute_peaks(hourly, gauges, start, end)
        peak: dict[str, float] = {}
        for g in gauges:  # station order, so the output is stable
            if g in computed:
                peak[g] = computed[g]
                if g in config_peak and abs(config_peak[g] - computed[g]) > 0.02:
                    log.warning("%s %s: hourly peak %.3f differs from events.yaml %.3f",
                                eid, g, computed[g], config_peak[g])
            elif g in config_peak:
                peak[g] = round(config_peak[g], 3)
                if hourly is not None:
                    log.info("%s %s: no hourly data in window; keeping events.yaml peak", eid, g)
        out.append(
            {
                "id": eid,
                "name": str(e["name"]),
                "start": start,
                "end": end,
                "peak": peak,
                "headline": eid == HEADLINE_EVENT or bool(e.get("headline", False)),
            }
        )
    return out


# --------------------------------------------------------------------------------------------------
# Writing
# --------------------------------------------------------------------------------------------------

def write_if_changed(path: Path, obj: Any) -> bool:
    """Write pretty JSON; return True if the file changed."""
    text = json.dumps(obj, indent=1, ensure_ascii=False, allow_nan=False) + "\n"
    if path.exists() and path.read_text(encoding="utf-8") == text:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")
    return True


def load_hourly_or_none(path: Path | None) -> pd.DataFrame | None:
    from pipeline.clean import hourly_path, load_hourly

    p = path or hourly_path()
    if not Path(p).exists():
        log.warning("%s not found: event peaks come from config/events.yaml", p)
        return None
    df = load_hourly(p)
    return df[["gauge", "ts_utc", "kind", "level_max"]]


def export(
    out_dir: Path = OUT_DIR, config_dir: Path = CONFIG, hourly: pd.DataFrame | None = None
) -> dict[str, list[dict[str, Any]]]:
    stations = build_stations(_yaml(config_dir / "stations.yaml"))
    spots = build_spots(_yaml(config_dir / "spots.yaml"), stations)
    events = build_events(_yaml(config_dir / "events.yaml"), stations, hourly)
    files = {"stations.json": stations, "spots.json": spots, "events.json": events}
    for name, obj in files.items():
        changed = write_if_changed(out_dir / name, obj)
        log.info("%s %s (%d entries)", "wrote" if changed else "unchanged", out_dir / name, len(obj))
    return files


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    ap.add_argument("--out-dir", type=Path, default=OUT_DIR)
    ap.add_argument("--config-dir", type=Path, default=CONFIG)
    ap.add_argument("--hourly", type=Path, default=None, help="hourly.parquet (default: data root)")
    ap.add_argument("--no-peaks", action="store_true", help="keep events.yaml peaks; skip hourly.parquet")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    hourly = None if args.no_peaks else load_hourly_or_none(args.hourly)
    export(args.out_dir, args.config_dir, hourly)


if __name__ == "__main__":
    main()
