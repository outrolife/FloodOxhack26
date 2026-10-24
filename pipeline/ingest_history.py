"""Download all available 15-min level and rain history from the EA Hydrology API (SPEC §5.1).

Output (one file per series) in ``data/interim/readings/<series>.parquet``, normalised to SPEC §5.2
step 1: ``gauge, ts_utc, value, quality, source, kind``. Plus ``data/interim/ingest_manifest.json``
with the source URLs and download times, used for provenance.

Sources per series:
- Level gauges and rain gauges: Hydrology API 15-min measure, one cached request per calendar year,
  from 2006 (or the gauge's first reading) to now.
- Live-only lock gauges whose key is the d/s stage (osney, godstow, iffley; ``history_ok: false``):
  the Hydrology API only has the u/s head-water stage, stored as ``<key>_us`` (context only). The d/s
  series ``<key>`` comes from the SPEC fallback, the flood-monitoring daily archive CSVs, for the §4.3
  event windows (the archive starts 2025-10-29). ``--archive-all`` fetches every archived day instead
  (~60 MB download per day, a few KB cached).

Hydrology and archive timestamps are UTC (EA data are in GMT throughout).

Usage: ``python -m pipeline.ingest_history [--only osney,farmoor] [--archive-all] [--start 2006]``
"""
from __future__ import annotations

import argparse
import io
import json
import logging
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

import pandas as pd
import yaml

from pipeline import ea_client
from pipeline.stations import REPO_ROOT, Gauge, data_root, hydrology_series_key, hydrology_trace, load_gauges

log = logging.getLogger("pipeline.ingest_history")

START_YEAR = 2006
# Earliest archived day seen on 24 Oct 2026 (archive keeps ~12 months); days before it are skipped.
ARCHIVE_PROBE_START = date(2025, 10, 1)

# SPEC §4.3 fallback if config/events.yaml (Story lead) isn't there yet. UTC dates, inclusive.
_FALLBACK_EVENTS = {
    "e2007": ("2007-07-18", "2007-08-02"),
    "e2012": ("2012-11-20", "2013-01-05"),
    "e2014": ("2013-12-20", "2014-02-20"),
    "e2024a": ("2023-12-28", "2024-01-15"),
    "e2024b": ("2024-11-20", "2024-12-05"),
    "e2026": ("2026-02-18", "2026-03-10"),
}

COLUMNS = ["gauge", "ts_utc", "value", "quality", "source", "kind"]


def interim_dir() -> Path:
    d = data_root() / "interim" / "readings"
    d.mkdir(parents=True, exist_ok=True)
    return d


def manifest_path() -> Path:
    return data_root() / "interim" / "ingest_manifest.json"


def load_event_windows(path: Path | None = None) -> dict[str, tuple[date, date]]:
    """Event windows from config/events.yaml (any of start/end or window keys), else SPEC §4.3."""
    path = path or REPO_ROOT / "config" / "events.yaml"
    windows: dict[str, tuple[str, str]] = dict(_FALLBACK_EVENTS)
    if path.exists():
        doc = yaml.safe_load(path.read_text()) or {}
        entries = doc.get("events", doc) if isinstance(doc, dict) else doc
        if isinstance(entries, dict):
            entries = [{"id": k, **(v or {})} for k, v in entries.items() if isinstance(v, dict)]
        for e in entries or []:
            if not isinstance(e, dict) or "id" not in e:
                continue
            start, end = e.get("start"), e.get("end")
            if (start is None or end is None) and isinstance(e.get("window"), list | tuple):
                start, end = e["window"][0], e["window"][-1]
            if start is not None and end is not None:
                windows[str(e["id"])] = (str(start)[:10], str(end)[:10])
    return {k: (date.fromisoformat(s), date.fromisoformat(e)) for k, (s, e) in windows.items()}


def parse_hydrology_csv(body: bytes, gauge: str, kind: str, source: str) -> pd.DataFrame:
    """Hydrology readings CSV -> normalised frame (UTC)."""
    df = pd.read_csv(io.BytesIO(body), usecols=["dateTime", "value", "quality"],
                     dtype={"quality": "string"})
    if df.empty:
        return pd.DataFrame(columns=COLUMNS)
    out = pd.DataFrame({
        "gauge": gauge,
        "ts_utc": pd.to_datetime(df["dateTime"], utc=True),
        "value": pd.to_numeric(df["value"], errors="coerce"),
        "quality": df["quality"].fillna("Unknown").astype(str),
        "source": source,
        "kind": kind,
    })
    return out[COLUMNS]


def parse_archive_csv(body: bytes, measure: str, gauge: str, kind: str, source: str) -> pd.DataFrame:
    """Filtered flood-monitoring archive CSV -> rows of one measure, normalised. No quality flags in it."""
    df = pd.read_csv(io.BytesIO(body), dtype=str)
    df = df[df["measure"].str.endswith("/" + measure)]
    if df.empty:
        return pd.DataFrame(columns=COLUMNS)
    out = pd.DataFrame({
        "gauge": gauge,
        "ts_utc": pd.to_datetime(df["dateTime"], utc=True),
        # some archive rows hold "a|b" when two values were reported; keep the first
        "value": pd.to_numeric(df["value"].str.split("|").str[0], errors="coerce"),
        "quality": "Unchecked",
        "source": source,
        "kind": kind,
    })
    return out[COLUMNS]


def ingest_hydrology(g: Gauge, series: str, start_year: int, today: date) -> dict[str, Any]:
    """Download all years for one Hydrology measure; write the series parquet; return manifest entry."""
    assert g.hydrology_measure, f"{g.key}: no Hydrology measure configured"
    first = ea_client.hydrology_first_reading(g.hydrology_measure)
    if first is None:
        log.warning("%s: Hydrology measure %s has no readings", series, g.hydrology_measure)
        return {"series": series, "source": "hydrology", "error": "no readings"}
    y0 = max(start_year, first.year)
    frames, downloaded = [], []
    url = ea_client.hydrology_measure_url(g.hydrology_measure)
    for year in range(y0, today.year + 1):
        path = ea_client.hydrology_year_csv(g.hydrology_measure, year, today=today)
        if path is None:
            continue
        frames.append(parse_hydrology_csv(ea_client.read_cached(path), series, g.kind, "hydrology"))
        downloaded.append(ea_client.cache_meta(path).get("downloaded_at"))
    df = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame(columns=COLUMNS)
    df.to_parquet(interim_dir() / f"{series}.parquet", index=False)
    log.info("%s: %d readings %s -> %s (Hydrology)", series, len(df),
             df["ts_utc"].min() if len(df) else None, df["ts_utc"].max() if len(df) else None)
    return {
        "series": series, "gauge": g.key, "kind": g.kind, "source": "hydrology",
        "source_url": url, "licence": ea_client.LICENCE_OGL,
        "downloaded_at": max((d for d in downloaded if d), default=None),
        "qualifier": hydrology_trace(g) if g.kind == "level" else None,
        "first_available": first.isoformat(),
    }


def archive_days(windows: dict[str, tuple[date, date]], today: date, all_days: bool) -> list[date]:
    last = today - timedelta(days=1)
    if all_days:
        n = (last - ARCHIVE_PROBE_START).days + 1
        return [ARCHIVE_PROBE_START + timedelta(days=i) for i in range(n)]
    days: set[date] = set()
    for start, end in windows.values():
        d = max(start, ARCHIVE_PROBE_START)
        while d <= min(end, last):
            days.add(d)
            d += timedelta(days=1)
    return sorted(days)


def ingest_archive(gauges: list[Gauge], days: list[date], all_refs: list[str]) -> list[dict[str, Any]]:
    """Downstream stage for lock gauges from the daily archive (SPEC §5.1 fallback)."""
    frames: dict[str, list[pd.DataFrame]] = {g.key: [] for g in gauges}
    got_days: list[str] = []
    for i, day in enumerate(days):
        path = ea_client.fm_archive_day(day, all_refs)
        if path is None:
            continue
        got_days.append(day.isoformat())
        body = ea_client.read_cached(path)
        for g in gauges:
            frames[g.key].append(parse_archive_csv(body, g.fm_level_measure, g.key, g.kind, "fm_archive"))
        if (i + 1) % 10 == 0:
            log.info("archive: %d/%d days", i + 1, len(days))
    entries = []
    for g in gauges:
        df = pd.concat(frames[g.key], ignore_index=True) if frames[g.key] else pd.DataFrame(columns=COLUMNS)
        df.to_parquet(interim_dir() / f"{g.key}.parquet", index=False)
        log.info("%s: %d readings from %d archive days (downstream stage)", g.key, len(df), len(got_days))
        entries.append({
            "series": g.key, "gauge": g.key, "kind": g.kind, "source": "fm_archive",
            "source_url": f"{ea_client.FLOOD_MONITORING}/archive/readings-{{date}}.csv "
                          f"(measure {g.fm_level_measure})",
            "licence": ea_client.LICENCE_OGL,
            "downloaded_at": datetime.now(UTC).isoformat(timespec="seconds"),
            "qualifier": g.trace, "archive_days": got_days,
        })
    return entries


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--only", help="comma-separated gauge keys (default: all)")
    ap.add_argument("--start", type=int, default=START_YEAR, help="first year (default 2006)")
    ap.add_argument("--archive-all", action="store_true",
                    help="fetch every archived day for lock downstream stages, not just event windows")
    ap.add_argument("--no-archive", action="store_true", help="skip the daily-archive fallback")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    today = datetime.now(UTC).date()
    levels, rains = load_gauges()
    only = set(args.only.split(",")) if args.only else None
    if only:
        levels = [g for g in levels if g.key in only]
        rains = [g for g in rains if g.key in only or "rain" in only]

    manifest: dict[str, Any] = {}
    if manifest_path().exists():
        manifest = json.loads(manifest_path().read_text())

    for g in [*levels, *rains]:
        series = hydrology_series_key(g) if g.kind == "level" else g.key
        manifest[series] = ingest_hydrology(g, series, args.start, today)

    # Drop series a config change made stale (e.g. eynsham switched from d/s to its u/s series).
    all_levels, all_rains = load_gauges()
    expected = {hydrology_series_key(g) for g in all_levels} | {g.key for g in all_rains}
    expected |= {g.key for g in all_levels if g.needs_archive}
    for stale in sorted(set(manifest) - expected):
        log.info("dropping stale series %s from the manifest", stale)
        manifest.pop(stale)
        (interim_dir() / f"{stale}.parquet").unlink(missing_ok=True)

    locks = [g for g in levels if g.needs_archive]
    if locks and not args.no_archive:
        days = archive_days(load_event_windows(), today, args.archive_all)
        all_refs = [g.ref for g in all_levels]
        log.info("archive fallback for %s: %d candidate days", [g.key for g in locks], len(days))
        for entry in ingest_archive(locks, days, all_refs):
            manifest[entry["series"]] = entry

    manifest_path().parent.mkdir(parents=True, exist_ok=True)
    manifest_path().write_text(json.dumps(manifest, indent=1, default=str))
    log.info("wrote %s (%d series)", manifest_path(), len(manifest))


if __name__ == "__main__":
    main()
