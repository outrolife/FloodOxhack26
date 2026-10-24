"""Thin, cached wrappers around the EA Hydrology and flood-monitoring APIs (SPEC §5.1).

Responses are cached under data/raw/ and never re-downloaded; retries with backoff;
live endpoints are polled at most every 15 minutes.

Caching rules:
- Closed historic chunks (e.g. a past year of Hydrology readings) are cached forever.
- Anything that can still change (the current year, station metadata, live readings) is cached with a
  TTL: 15 min for live readings (EA polling guidance), 1 day for metadata and the open year chunk.
- Each cache file has a ``.meta.json`` sidecar with the source URL and download time (for provenance).
"""
from __future__ import annotations

import gzip
import io
import json
import logging
import time
from collections.abc import Iterable
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

import requests

from pipeline.stations import FLOOD_MONITORING, HYDROLOGY, data_root

log = logging.getLogger(__name__)

LICENCE_OGL = "Open Government Licence v3.0"
USER_AGENT = "RiverClock/0.1 (OxHack 2026 flood decision-support prototype)"
LIVE_TTL_S = 15 * 60
META_TTL_S = 24 * 3600
POLITE_DELAY_S = 0.3
MAX_RETRIES = 5

_session: requests.Session | None = None


def raw_dir() -> Path:
    d = data_root() / "raw"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _http() -> requests.Session:
    global _session
    if _session is None:
        _session = requests.Session()
        _session.headers["User-Agent"] = USER_AGENT
    return _session


def _meta_path(path: Path) -> Path:
    return path.with_name(path.name + ".meta.json")


def cache_meta(path: Path) -> dict[str, Any]:
    """Sidecar metadata (``url``, ``downloaded_at``) for a cached file; empty if unknown."""
    mp = _meta_path(path)
    if mp.exists():
        return json.loads(mp.read_text())
    return {}


def _is_fresh(path: Path, ttl_s: float | None) -> bool:
    if not path.exists():
        return False
    if ttl_s is None:
        return True
    return (time.time() - path.stat().st_mtime) < ttl_s


def _write_atomic(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".part")
    if path.suffix == ".gz":
        payload = gzip.compress(payload, compresslevel=6)
    tmp.write_bytes(payload)
    tmp.replace(path)


def read_cached(path: Path) -> bytes:
    data = path.read_bytes()
    return gzip.decompress(data) if path.suffix == ".gz" else data


def http_get(url: str, params: dict[str, Any] | None = None, stream: bool = False,
             timeout: float = 120, retries: int = MAX_RETRIES) -> requests.Response:
    """GET with up to ``retries`` attempts and exponential backoff on network errors, 429 and 5xx.

    4xx other than 429 is raised at once. Live mode passes a small ``retries`` so a slow or dead EA
    cannot hold a poll for minutes (pipeline/ingest_live.py).
    """
    delay = 2.0
    for attempt in range(1, retries + 1):
        try:
            time.sleep(POLITE_DELAY_S)
            r = _http().get(url, params=params, stream=stream, timeout=timeout)
            if r.status_code == 429 or r.status_code >= 500:
                raise requests.HTTPError(f"HTTP {r.status_code}", response=r)
            r.raise_for_status()
            return r
        except (requests.ConnectionError, requests.Timeout, requests.HTTPError) as e:
            status = getattr(getattr(e, "response", None), "status_code", None)
            if status is not None and 400 <= status < 500 and status != 429:
                raise
            if attempt == retries:
                raise
            log.warning("GET %s failed (%s); retry %d in %.0fs", url, e, attempt, delay)
            time.sleep(delay)
            delay *= 2
    raise RuntimeError("unreachable")


def cached_get(url: str, cache_path: Path, params: dict[str, Any] | None = None,
               ttl_s: float | None = None) -> bytes:
    """Return the body of ``url``, from ``cache_path`` if present (and fresh when ``ttl_s`` is set)."""
    if _is_fresh(cache_path, ttl_s):
        return read_cached(cache_path)
    r = http_get(url, params=params)
    body = r.content
    _write_atomic(cache_path, body)
    _meta_path(cache_path).write_text(json.dumps({
        "url": r.url, "downloaded_at": datetime.now(UTC).isoformat(timespec="seconds"),
    }))
    return body


def cached_json(url: str, cache_path: Path, params: dict[str, Any] | None = None,
                ttl_s: float | None = None) -> Any:
    return json.loads(cached_get(url, cache_path, params=params, ttl_s=ttl_s))


# --------------------------------------------------------------------------------------------------
# Hydrology API (full history)
# --------------------------------------------------------------------------------------------------

def hydrology_measure_url(measure_id: str) -> str:
    return f"{HYDROLOGY}/id/measures/{measure_id}"


def hydrology_year_csv(measure_id: str, year: int, today: date | None = None) -> Path | None:
    """Cache one calendar year of readings (CSV) for a Hydrology measure; return the cache path.

    One year of 15-min data is ~35k rows, well under the API's 100k row limit, so one request per
    year needs no paging. Past years are cached forever; the current year refreshes daily.
    Returns None for a year after ``today``.
    """
    today = today or datetime.now(UTC).date()
    if year > today.year:
        return None
    path = raw_dir() / "hydrology" / measure_id / f"{year}.csv.gz"
    ttl = META_TTL_S if year == today.year else None
    params = {"mineq-date": f"{year}-01-01", "max-date": f"{year + 1}-01-01", "_limit": 100000}
    body = cached_get(f"{hydrology_measure_url(measure_id)}/readings.csv", path, params=params, ttl_s=ttl)
    n_lines = body.count(b"\n")
    if n_lines >= 100000:
        raise RuntimeError(f"{measure_id} {year}: hit the 100k row limit; split the request")
    return path


def hydrology_first_reading(measure_id: str) -> datetime | None:
    """Timestamp (UTC) of the first reading of a Hydrology measure (cached)."""
    path = raw_dir() / "hydrology" / measure_id / "first.json"
    doc = cached_json(f"{hydrology_measure_url(measure_id)}/readings", path, params={"_limit": 1})
    items = doc.get("items", [])
    if not items:
        return None
    return datetime.fromisoformat(items[0]["dateTime"].replace("Z", "")).replace(tzinfo=UTC)


# --------------------------------------------------------------------------------------------------
# flood-monitoring API (metadata, live, daily archive)
# --------------------------------------------------------------------------------------------------

def fm_station(ref: str) -> dict[str, Any]:
    """flood-monitoring station record (``items``), refreshed daily."""
    path = raw_dir() / "flood_monitoring" / "stations" / f"{ref}.json"
    doc = cached_json(f"{FLOOD_MONITORING}/id/stations/{ref}", path, ttl_s=META_TTL_S)
    items = doc.get("items", {})
    return items[0] if isinstance(items, list) and items else items


def fm_measure_readings(measure: str, since: datetime) -> list[dict[str, Any]]:
    """Live readings for a flood-monitoring measure since ``since`` (UTC). Cached for 15 min."""
    path = raw_dir() / "flood_monitoring" / "live" / f"{measure}.json"
    params = {"since": since.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"), "_sorted": "", "_limit": 10000}
    doc = cached_json(f"{FLOOD_MONITORING}/id/measures/{measure}/readings", path, params=params,
                      ttl_s=LIVE_TTL_S)
    return doc.get("items", [])


def fm_archive_url(day: date) -> str:
    return f"{FLOOD_MONITORING}/archive/readings-{day.isoformat()}.csv"


def fm_archive_day(day: date, station_refs: Iterable[str]) -> Path | None:
    """Download one daily archive CSV (~60 MB, all England) and cache only the rows for our stations.

    The cache keeps the filtered rows plus the list of refs used; if a later call asks for a ref
    that wasn't filtered for, the day is downloaded again. Returns None if the day isn't archived (404).
    """
    refs = sorted(set(station_refs))
    path = raw_dir() / "fm_archive" / f"readings-{day.isoformat()}.csv.gz"
    meta = cache_meta(path)
    if path.exists() and set(refs) <= set(meta.get("refs", [])):
        return path
    if meta.get("missing") and set(refs) <= set(meta.get("refs", [])):
        return None
    url = fm_archive_url(day)
    try:
        r = http_get(url, stream=True, timeout=300)
    except requests.HTTPError as e:
        if getattr(e.response, "status_code", None) == 404:
            # Remember a 404 only for old days; a recent day may simply not be archived yet.
            if (datetime.now(UTC).date() - day).days > 7:
                path.parent.mkdir(parents=True, exist_ok=True)
                _meta_path(path).write_text(json.dumps({"url": url, "missing": True, "refs": refs}))
            return None
        raise
    needles = [f"/measures/{ref}-".encode() for ref in refs]
    out = io.BytesIO()
    header = True
    for line in r.iter_lines():
        if header:
            out.write(line + b"\n")
            header = False
            continue
        if any(n in line for n in needles):
            out.write(line + b"\n")
    _write_atomic(path, out.getvalue())
    _meta_path(path).write_text(json.dumps({
        "url": url, "downloaded_at": datetime.now(UTC).isoformat(timespec="seconds"), "refs": refs,
    }))
    return path
