"""Fetch the last 28 days of readings for all gauges from flood-monitoring (SPEC §5.1).

Issue #16.

What it does
------------
1. For every river gauge and rain gauge, GET
   ``/id/measures/{measure}/readings?since=<now - 28 d>&_sorted&_limit=10000`` from the EA
   flood-monitoring API. (The per-measure endpoint returns the same readings as
   ``/id/stations/{ref}/readings`` filtered to the one measure we use, e.g. the *downstream* stage at a
   lock gauge.) Every response is cached under ``<data>/raw/live/`` and reused for 15 minutes, so the EA
   is polled at most every 15 minutes (CLAUDE.md rule 5). The requests run in a small thread pool
   (``MAX_WORKERS = 4`` at once, polite to the EA); results are collected in a fixed gauge order, so
   the output does not depend on which request finishes first. HTTP goes through
   ``pipeline.ea_client.http_get`` (retries with backoff on network errors, 429 and 5xx).
2. Keeps ``observed_at`` (the reading's own time) and ``received_at`` (when we downloaded it).
3. Resamples to the same long hourly union schema as ``hourly.parquet``:
   ``gauge`` (config key for level gauges, EA ref such as ``256230TP`` for rain gauges, plus derived
   ``rain_catchment`` = mean of the available rain gauges per hour), ``ts_utc`` (UTC hour start),
   ``kind`` ("level" | "rain"), ``level_mean``, ``level_max`` (NaN for rain), ``rain_mm`` (NaN for
   level), ``filled``, ``flagged``. Writes ``<data>/processed/live_hourly.parquet``.
4. Writes ``<data>/processed/live_meta.json``: per gauge the latest ``observed_at``, ``received_at``,
   level and the EA measure used, and the rain gauges used. ``model/forecast_live.py`` uses it for
   ``dataAsOf`` and the stale rule.

``<data>`` is ``$RC_DATA_DIR`` if set, else ``<repo>/data``.

Placeholders
------------
- ``_cached_get_json`` keeps its own small cache file format (it stores ``received_at`` in the file and
  falls back to the cached copy when the EA is down, which ``ea_client.cached_get`` does not do);
  the HTTP itself is ``ea_client.http_get``.
- ``to_hourly`` is a minimal version of the ``pipeline/clean.py`` steps (hourly mean/max, rain sum,
  forward-fill gaps <= 2 h, flag longer gaps). It does NOT remove spikes yet. Replace it with the
  shared cleaning function from ``pipeline/clean.py`` once #3 merges, so live and history match.
- Gauge -> measure ids are from SPEC §4.1, with bracketed RLOI ids resolved against the API on
  2026-10-24. Move to ``config/stations.yaml`` once it exists.

All times are UTC.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import threading
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from pipeline import ea_client

log = logging.getLogger(__name__)

BASE_URL = "https://environment.data.gov.uk/flood-monitoring"
REPO_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = Path(os.environ.get("RC_DATA_DIR") or REPO_ROOT / "data")  # team-wide data root
RAW_DIR = DATA_DIR / "raw" / "live"
OUT_HOURLY = DATA_DIR / "processed" / "live_hourly.parquet"
OUT_META = DATA_DIR / "processed" / "live_meta.json"

LIVE_DAYS = 28
CACHE_TTL_S = 15 * 60  # poll EA at most every 15 minutes
MAX_WORKERS = 4  # concurrent EA requests per poll (bounded, polite)
HTTP_TIMEOUT_S = 30
MAX_FFILL_H = 2  # SPEC §5.2 step 3
RAIN_KEY = "rain_catchment"

# Gauge key -> flood-monitoring measure id, following SPEC §4.1 / §4.1.1 (PM decision, PR #30):
# - live-only main-channel locks godstow, osney, iffley: the downstream stage (d/s), shown in the River
#   strip only; there is no d/s history, so they are not forecast;
# - eynsham: the upstream stage, to match the Hydrology history its features are trained on;
# - trained targets newbotley, minns, coldharbour (single trace) and kingsmill (u/s = "stage").
# The measure used is recorded in live_meta.json so live and history can be checked against each other.
# Bracketed RLOI ids resolved via /id/stations?RLOIid=: 7054 -> 1290_w2TH, 7064 -> 1460_w1TH,
# 9082 -> 1489TH, 7072 -> 1501TH, 7075 -> 1645TH.
LEVEL_MEASURES: dict[str, str] = {
    "farmoor": "1100TH-level-stage-i-15_min-mASD",
    "eynsham": "1201TH-level-stage-i-15_min-mASD",
    "cassington": "1290_w2TH-level-stage-i-15_min-mASD",
    "enslow": "1460_w1TH-level-stage-i-15_min-mASD",
    "islip": "1489TH-level-stage-i-15_min-mASD",
    "godstow": "1302TH-level-downstage-i-15_min-mASD",
    "osney": "1303TH-level-downstage-i-15_min-mASD",
    "iffley": "1501TH-level-downstage-i-15_min-mASD",
    "kingsmill": "1491TH-level-stage-i-15_min-mASD",
    "newbotley": "1645TH-level-stage-i-15_min-mASD",
    "minns": "1635TH-level-stage-i-15_min-mASD",
    "coldharbour": "1675TH-level-stage-i-15_min-mASD",
}
# Main-channel locks with live data only (SPEC §4.1.1): shown, never forecast.
LIVE_ONLY_GAUGES: frozenset[str] = frozenset({"godstow", "osney", "iffley"})
# Rain gauges are keyed by their EA station ref, as in hourly.parquet.
RAIN_MEASURES: dict[str, str] = {
    ref: f"{ref}-rainfall-tipping_bucket_raingauge-t-15_min-mm"
    for ref in ("256230TP", "254336TP", "261021TP", "264254TP", "263541TP")
}

HOURLY_COLUMNS = ["gauge", "ts_utc", "kind", "level_mean", "level_max", "rain_mm", "filled", "flagged"]

Fetcher = Callable[[str, dict[str, str]], Any]


# ---------------------------------------------------------------------------------------------
# HTTP with a 15-minute file cache
# ---------------------------------------------------------------------------------------------


def _http_get_json(url: str, params: dict[str, str]) -> Any:
    """GET JSON via ``ea_client.http_get``: retries with exponential backoff on network errors, 429, 5xx."""
    return ea_client.http_get(url, params=params, timeout=HTTP_TIMEOUT_S).json()


def cache_path(url: str, params: dict[str, str], cache_dir: Path = RAW_DIR) -> Path:
    """Cache file for one request. The key ignores ``since`` so a moving window reuses one file."""
    stable = {k: v for k, v in params.items() if k != "since"}
    key = hashlib.sha1(json.dumps([url, sorted(stable.items())]).encode()).hexdigest()[:16]
    return cache_dir / f"{url.rstrip('/').rsplit('/', 2)[-2]}_{key}.json"


def _cached_get_json(
    url: str,
    params: dict[str, str],
    *,
    now: datetime,
    cache_dir: Path = RAW_DIR,
    ttl_s: int = CACHE_TTL_S,
    fetch: Fetcher = _http_get_json,
) -> tuple[Any, datetime]:
    """Return ``(json, received_at)``: from cache if it is younger than ``ttl_s``, else fetched.

    The cache file stores ``received_at`` itself (not the file mtime), so the TTL is testable and
    survives copies. If the fetch fails and a cached copy exists, the old copy is used and logged.
    """
    path = cache_path(url, params, cache_dir)
    cached = json.loads(path.read_text()) if path.exists() else None
    if cached is not None:
        received_at = datetime.fromisoformat(cached["received_at"])
        if (now - received_at).total_seconds() < ttl_s:
            return cached["body"], received_at
    try:
        body = fetch(url, params)
    except Exception:
        if cached is None:
            raise
        log.warning("fetch failed for %s; using cached copy from %s", url, cached["received_at"])
        return cached["body"], datetime.fromisoformat(cached["received_at"])
    path.parent.mkdir(parents=True, exist_ok=True)
    # Write then rename, so a reader (another thread, the API refresher) never sees a half-written file.
    tmp = path.with_name(f"{path.name}.{os.getpid()}.{threading.get_ident()}.part")
    tmp.write_text(json.dumps({"url": url, "params": params, "received_at": now.isoformat(), "body": body}))
    tmp.replace(path)
    return body, now


# ---------------------------------------------------------------------------------------------
# Readings
# ---------------------------------------------------------------------------------------------


def _to_float(value: Any) -> float:
    """EA values are usually numbers, occasionally a list (duplicate readings) or junk."""
    if isinstance(value, list):
        nums = [v for v in value if isinstance(v, int | float)]
        return float(np.mean(nums)) if nums else np.nan
    return float(value) if isinstance(value, int | float) else np.nan


def parse_readings(body: Any, received_at: datetime) -> pd.DataFrame:
    """API body -> ``observed_at`` (UTC), ``value``, ``received_at``; sorted, deduplicated, no NaN."""
    items = (body or {}).get("items", [])
    df = pd.DataFrame(
        {
            "observed_at": pd.to_datetime([i.get("dateTime") for i in items], utc=True),
            "value": [_to_float(i.get("value")) for i in items],
        }
    )
    df = df.dropna().drop_duplicates("observed_at").sort_values("observed_at").reset_index(drop=True)
    df["received_at"] = pd.Timestamp(received_at).tz_convert("UTC")
    return df


def fetch_live_readings(
    now: datetime | None = None,
    *,
    cache_dir: Path = RAW_DIR,
    fetch: Fetcher = _http_get_json,
    ttl_s: int = CACHE_TTL_S,
    max_workers: int = MAX_WORKERS,
) -> dict[str, pd.DataFrame]:
    """Last ``LIVE_DAYS`` of readings per gauge key (level gauges, then rain gauges by EA ref).

    Requests run concurrently, at most ``max_workers`` at a time. The result is in the fixed order of
    ``LEVEL_MEASURES`` then ``RAIN_MEASURES`` whatever order the requests finish in. A gauge whose
    request fails with no cached copy is logged and left out; the others are unaffected.
    """
    now = (now or datetime.now(UTC)).astimezone(UTC)
    since = (now - timedelta(days=LIVE_DAYS)).strftime("%Y-%m-%dT%H:%M:%SZ")
    params = {"since": since, "_sorted": "", "_limit": "10000"}

    def get(measure: str) -> tuple[Any, datetime]:
        url = f"{BASE_URL}/id/measures/{measure}/readings"
        return _cached_get_json(url, params, now=now, cache_dir=cache_dir, ttl_s=ttl_s, fetch=fetch)

    jobs = list({**LEVEL_MEASURES, **RAIN_MEASURES}.items())
    with ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="ea-live") as pool:
        futures = [(key, pool.submit(get, measure)) for key, measure in jobs]
    out: dict[str, pd.DataFrame] = {}
    for key, future in futures:  # job order, not completion order
        try:
            body, received_at = future.result()
        except Exception as exc:  # one dead gauge must not stop live mode
            log.warning("no live data for %s: %s", key, exc)
            continue
        out[key] = parse_readings(body, received_at)
    return out


# ---------------------------------------------------------------------------------------------
# Hourly (PLACEHOLDER: minimal clean.py steps; swap for the shared clean.py function from #3)
# ---------------------------------------------------------------------------------------------


def _hourly_one(gauge: str, readings: pd.DataFrame, is_rain: bool) -> pd.DataFrame:
    """One gauge's readings -> complete hourly rows (label = hour start, UTC)."""
    s = readings.set_index("observed_at")["value"]
    hours = s.index.floor("h")
    grouped = s.groupby(hours)
    full = pd.date_range(hours.min(), hours.max(), freq="h", tz="UTC")
    if is_rain:
        rain = grouped.sum().reindex(full)
        df = pd.DataFrame({"rain_mm": rain, "level_mean": np.nan, "level_max": np.nan}, index=full)
        missing = rain.isna()
    else:
        mean, mx = grouped.mean().reindex(full), grouped.max().reindex(full)
        missing = mean.isna()
        df = pd.DataFrame(
            {
                "level_mean": mean.ffill(limit=MAX_FFILL_H),
                "level_max": mx.ffill(limit=MAX_FFILL_H),
                "rain_mm": np.nan,
            },
            index=full,
        )
    value_col = "rain_mm" if is_rain else "level_mean"
    df["filled"] = missing & df[value_col].notna()
    df["flagged"] = df[value_col].isna()
    df["gauge"] = gauge
    df["kind"] = "rain" if is_rain else "level"
    return df.rename_axis("ts_utc").reset_index()


def to_hourly(readings: dict[str, pd.DataFrame]) -> pd.DataFrame:
    """Readings per gauge -> long hourly frame in the hourly.parquet union schema, plus ``rain_catchment``."""
    parts = [_hourly_one(g, r, False) for g, r in readings.items() if not r.empty and g in LEVEL_MEASURES]
    rain_parts = [_hourly_one(g, r, True) for g, r in readings.items() if not r.empty and g in RAIN_MEASURES]
    if rain_parts:
        wide = pd.concat(rain_parts).pivot(index="ts_utc", columns="gauge", values="rain_mm")
        catchment = wide.mean(axis=1, skipna=True)  # mean of available gauges per hour (SPEC §4.1)
        parts += rain_parts
        parts.append(
            pd.DataFrame(
                {
                    "gauge": RAIN_KEY,
                    "kind": "rain",
                    "ts_utc": catchment.index,
                    "level_mean": np.nan,
                    "level_max": np.nan,
                    "rain_mm": catchment.to_numpy(),
                    "filled": False,
                    "flagged": catchment.isna().to_numpy(),
                }
            )
        )
    if not parts:
        return pd.DataFrame(columns=HOURLY_COLUMNS)
    out = pd.concat(parts, ignore_index=True)[HOURLY_COLUMNS]
    out[["filled", "flagged"]] = out[["filled", "flagged"]].astype(bool)
    out["ts_utc"] = pd.to_datetime(out["ts_utc"], utc=True).astype("datetime64[ns, UTC]")
    return out.sort_values(["gauge", "ts_utc"]).reset_index(drop=True)


def live_meta(readings: dict[str, pd.DataFrame]) -> dict[str, Any]:
    """Latest observed_at / received_at per level gauge, and the rain gauges used (ISO 8601 UTC)."""
    iso = lambda ts: pd.Timestamp(ts).tz_convert("UTC").strftime("%Y-%m-%dT%H:%M:%SZ")  # noqa: E731
    gauges = {
        g: {
            "observed_at": iso(r["observed_at"].iloc[-1]),
            "received_at": iso(r["received_at"].iloc[-1]),
            "level": float(r["value"].iloc[-1]),
            "measure": LEVEL_MEASURES[g],
        }
        for g, r in readings.items()
        if g in LEVEL_MEASURES and not r.empty
    }
    rain_used = sorted(g for g, r in readings.items() if g in RAIN_MEASURES and not r.empty)
    return {"gauges": gauges, "rainGaugesUsed": rain_used}


def ingest_live(
    now: datetime | None = None,
    *,
    cache_dir: Path = RAW_DIR,
    out_hourly: Path = OUT_HOURLY,
    out_meta: Path = OUT_META,
    fetch: Fetcher = _http_get_json,
    max_workers: int = MAX_WORKERS,
) -> tuple[pd.DataFrame, dict[str, Any]]:
    """Fetch (cached), resample and write ``live_hourly.parquet`` and ``live_meta.json``."""
    readings = fetch_live_readings(now, cache_dir=cache_dir, fetch=fetch, max_workers=max_workers)
    hourly = to_hourly(readings)
    meta = live_meta(readings)
    out_hourly.parent.mkdir(parents=True, exist_ok=True)
    hourly.to_parquet(out_hourly, index=False)
    out_meta.write_text(json.dumps(meta, indent=2))
    log.info(
        "live: %d gauges, %d hourly rows, rain gauges %s",
        len(meta["gauges"]),
        len(hourly),
        meta["rainGaugesUsed"],
    )
    return hourly, meta


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    argparse.ArgumentParser(description=__doc__.splitlines()[0]).parse_args()
    ingest_live()


if __name__ == "__main__":
    main()
