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
   ``pipeline.ea_client.http_get`` (2 attempts, 20 s timeout, backoff on network errors, 429 and 5xx).
   When the EA is slow or down, a per-poll circuit breaker stops calling it after 3 failures and the
   cached copies are used, so a poll never hangs for minutes; those gauges then go stale downstream.
2. Keeps ``observed_at`` (the reading's own time) and ``received_at`` (when we downloaded it).
3. Cleans the readings (``clean_readings``): drops values the EA flags as suspect/rejected/missing and
   values outside the gauge's plausible band (below), so one junk reading such as the -52.477 m at
   Osney d/s on 2026-10-22 06:45Z (#80) never reaches the hourly means, ``live_meta.json`` or the model.
4. Resamples with the shared ``pipeline/clean.py`` steps, exactly as for history (SPEC §5.2): hourly
   mean/max, rain sum (>= 3 of 4 quarter-hours), forward-fill level gaps <= 2 h, flag longer gaps,
   NaN out spikes (> 0.5 m jump that falls back at least halfway within 3 h). Same long hourly union
   schema as ``hourly.parquet``:
   ``gauge`` (config key for level gauges, EA ref such as ``256230TP`` for rain gauges, plus derived
   ``rain_catchment`` = mean of the available rain gauges per hour), ``ts_utc`` (UTC hour start),
   ``kind`` ("level" | "rain"), ``level_mean``, ``level_max`` (NaN for rain), ``rain_mm`` (NaN for
   level), ``filled``, ``flagged``. Writes ``<data>/processed/live_hourly.parquet``.
5. Writes ``<data>/processed/live_meta.json``: per gauge the latest ``observed_at``, ``received_at``,
   level and the EA measure used, and the rain gauges used. ``model/forecast_live.py`` uses it for
   ``dataAsOf`` and the stale rule.

``<data>`` is ``$RC_DATA_DIR`` if set, else ``<repo>/data``.

Placeholders
------------
- ``_cached_get_json`` keeps its own small cache file format (it stores ``received_at`` in the file and
  falls back to the cached copy when the EA is down, which ``ea_client.cached_get`` does not do);
  the HTTP itself is ``ea_client.http_get``.
- Gauge -> measure ids are from SPEC §4.1, with bracketed RLOI ids resolved against the API on
  2026-10-24. Move to ``config/stations.yaml`` once it exists.

Plausible band (physically impossible readings, #80)
-----------------------------------------------------
A level reading is kept only if ``amber - 4 m <= value <= record + 2 m``, with ``amber`` (top of the
normal range) and ``record`` (highest level on record) from ``config/stations.yaml`` for that gauge's
trace. No gauge in the history moves more than about 1.5 m below its top of normal range, and a new
record 2 m above the old one would be far beyond anything seen, so a real flood is never dropped. The
spike rule alone is not enough: it works on hourly means, where one -52 m reading becomes a -11 m hour
that still distorts the hours around it, and it cannot catch a junk value in the latest hour.
Rain readings below 0 mm are dropped. Gauges without amber in the config are not range-checked.

All times are UTC.
"""

from __future__ import annotations

import argparse
import functools
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

from pipeline import clean, ea_client, stations

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
HTTP_TIMEOUT_S = 20
# A slow or dead EA must not hold a poll for minutes (#125 hardening): each request gets 2 attempts
# (20 s timeout each, 2 s backoff), and after BREAKER_FAILURES network failures in one poll the
# remaining gauges skip the network and use their cached copies. Worst case ~45 s per poll.
LIVE_RETRIES = 2
BREAKER_FAILURES = 3
FUTURE_TOLERANCE = timedelta(minutes=15)  # readings stamped later than received_at + this are dropped
RAIN_KEY = clean.RAIN_CATCHMENT  # "rain_catchment"
PLAUSIBLE_BELOW_AMBER_M = 4.0  # plausible band: amber - 4 m ...
PLAUSIBLE_ABOVE_RECORD_M = 2.0  # ... to record + 2 m (module docstring)

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
    return ea_client.http_get(url, params=params, timeout=HTTP_TIMEOUT_S, retries=LIVE_RETRIES).json()


class EAUnavailable(ConnectionError):
    """The circuit breaker is open for this poll: the EA is treated as down, so no request is made."""


def _counts_as_outage(exc: Exception) -> bool:
    """Network errors, timeouts, 429/5xx and broken bodies count; a 4xx for one measure does not."""
    status = getattr(getattr(exc, "response", None), "status_code", None)
    return not (status is not None and 400 <= status < 500 and status != 429)


class _Breaker:
    """Counts EA outages within one poll; once ``limit`` is reached, ``guard`` stops calling the EA."""

    def __init__(self, fetch: Fetcher, limit: int = BREAKER_FAILURES) -> None:
        self.fetch, self.limit, self.failures = fetch, limit, 0
        self._lock = threading.Lock()

    @property
    def open(self) -> bool:
        return self.failures >= self.limit

    def guard(self, url: str, params: dict[str, str]) -> Any:
        if self.open:
            raise EAUnavailable(f"EA treated as down after {self.failures} failures this poll")
        try:
            return self.fetch(url, params)
        except Exception as exc:
            if _counts_as_outage(exc):
                with self._lock:
                    self.failures += 1
            raise


def _check_body(body: Any) -> Any:
    """A readings body must be a JSON object with an ``items`` list; anything else is a failed fetch."""
    if not isinstance(body, dict) or not isinstance(body.get("items"), list):
        raise ValueError(f"unexpected EA response shape: {type(body).__name__}")
    return body


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
    survives copies. If the fetch fails (network error, timeout, 5xx, a body that is not
    ``{"items": [...]}``) and a cached copy exists, the old copy is used and logged; its old
    ``received_at`` and old readings then make the gauge stale downstream, never silently fresh. An
    empty ``items`` when the cached copy has readings also keeps the cached copy (and the cache file),
    so the gauge stays listed with its last known level and is marked stale instead of vanishing.
    """
    path = cache_path(url, params, cache_dir)
    cached = None
    if path.exists():
        try:
            cached = json.loads(path.read_text())
            received_at = datetime.fromisoformat(cached["received_at"])
        except (ValueError, KeyError, TypeError) as exc:  # truncated or foreign file: ignore it
            log.warning("ignoring unreadable cache file %s (%s)", path.name, exc)
            cached = None
    if cached is not None:
        if (now - received_at).total_seconds() < ttl_s:
            return cached["body"], received_at
    try:
        body = _check_body(fetch(url, params))
    except Exception:
        if cached is None:
            raise
        log.warning("fetch failed for %s; using cached copy from %s", url, cached["received_at"])
        return cached["body"], received_at
    if not body["items"] and cached is not None and (cached.get("body") or {}).get("items"):
        log.warning("EA returned no readings for %s; keeping cached copy from %s", url, cached["received_at"])
        return cached["body"], received_at
    path.parent.mkdir(parents=True, exist_ok=True)
    # Write then rename, so a reader (another thread, the API refresher) never sees a half-written file.
    tmp = path.with_name(f"{path.name}.{os.getpid()}.{threading.get_ident()}.part")
    tmp.write_text(json.dumps({"url": url, "params": params, "received_at": now.isoformat(), "body": body}))
    tmp.replace(path)
    return body, now


# ---------------------------------------------------------------------------------------------
# Readings
# ---------------------------------------------------------------------------------------------


def _num(value: Any) -> float:
    if isinstance(value, bool):
        return np.nan
    if isinstance(value, int | float):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return np.nan
    return np.nan


def _to_float(value: Any) -> float:
    """EA values are usually numbers, occasionally a list (duplicate readings), a numeric string or junk."""
    if isinstance(value, list):
        nums = [x for x in map(_num, value) if np.isfinite(x)]
        return float(np.mean(nums)) if nums else np.nan
    x = _num(value)
    return x if np.isfinite(x) else np.nan


def parse_readings(body: Any, received_at: datetime) -> pd.DataFrame:
    """API body -> ``observed_at`` (UTC), ``value``, ``quality``, ``received_at``; sorted, deduplicated.

    Rows without a value or with an unparseable ``dateTime`` are dropped, as are readings stamped more
    than ``FUTURE_TOLERANCE`` after ``received_at`` (a gauge clock error would otherwise look fresh for
    ever). Out-of-order items are sorted; a repeated timestamp keeps its first item. ``quality`` is the
    EA quality flag if the reading has one (the flood-monitoring readings usually don't), else "".
    """
    items = body.get("items", []) if isinstance(body, dict) else []
    items = [i for i in items if isinstance(i, dict)] if isinstance(items, list) else []
    received = pd.Timestamp(received_at).tz_convert("UTC")
    df = pd.DataFrame(
        {
            "observed_at": pd.to_datetime(
                [i.get("dateTime") if isinstance(i.get("dateTime"), str) else None for i in items],
                utc=True,
                errors="coerce",
                format="ISO8601",
            ),
            "value": [_to_float(i.get("value")) for i in items],
            "quality": [str(i.get("quality") or "") for i in items],
        }
    )
    df = df.dropna(subset=["observed_at", "value"])
    future = df["observed_at"] > received + FUTURE_TOLERANCE
    if future.any():
        log.warning("dropped %d reading(s) stamped after they were received", int(future.sum()))
        df = df[~future]
    df = df.drop_duplicates("observed_at").sort_values("observed_at").reset_index(drop=True)
    df["observed_at"] = df["observed_at"].astype("datetime64[ns, UTC]")
    df["received_at"] = received
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
    request fails with no cached copy is logged and left out; the others are unaffected. After
    ``BREAKER_FAILURES`` outages (timeouts, network errors, 5xx) in this poll, the gauges not yet
    requested use their cached copies without calling the EA (``_Breaker``).
    """
    now = (now or datetime.now(UTC)).astimezone(UTC)
    since = (now - timedelta(days=LIVE_DAYS)).strftime("%Y-%m-%dT%H:%M:%SZ")
    params = {"since": since, "_sorted": "", "_limit": "10000"}
    breaker = _Breaker(fetch)

    def get(measure: str) -> tuple[Any, datetime]:
        url = f"{BASE_URL}/id/measures/{measure}/readings"
        return _cached_get_json(url, params, now=now, cache_dir=cache_dir, ttl_s=ttl_s, fetch=breaker.guard)

    jobs = list({**LEVEL_MEASURES, **RAIN_MEASURES}.items())
    with ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="ea-live") as pool:
        futures = [(key, pool.submit(get, measure)) for key, measure in jobs]
    out: dict[str, pd.DataFrame] = {}
    for key, future in futures:  # job order, not completion order
        try:
            body, received_at = future.result()
            out[key] = parse_readings(body, received_at)
        except Exception as exc:  # one dead gauge or one broken body must not stop live mode
            log.warning("no live data for %s: %s", key, exc)
    if breaker.open:
        log.warning("EA unreachable this poll (%d failures): cached readings used", breaker.failures)
    return out


# ---------------------------------------------------------------------------------------------
# Cleaning and hourly resampling (the shared pipeline/clean.py steps, SPEC §5.2)
# ---------------------------------------------------------------------------------------------


@functools.lru_cache(maxsize=1)
def plausible_bands() -> dict[str, tuple[float, float]]:
    """``{gauge: (low, high)}`` from config/stations.yaml: ``(amber - 4 m, record + 2 m)``."""
    levels, _ = stations.load_gauges()
    out = {}
    for g in levels:
        if g.key in LEVEL_MEASURES and g.amber is not None:
            top = max(g.amber, g.record if g.record is not None else g.amber)
            out[g.key] = (g.amber - PLAUSIBLE_BELOW_AMBER_M, top + PLAUSIBLE_ABOVE_RECORD_M)
    return out


def clean_readings(
    readings: dict[str, pd.DataFrame], bands: dict[str, tuple[float, float]] | None = None
) -> dict[str, pd.DataFrame]:
    """Drop EA-flagged readings and physically impossible values (module docstring), per gauge."""
    bands = plausible_bands() if bands is None else bands
    out = {}
    for g, r in readings.items():
        quality = r["quality"] if "quality" in r else pd.Series("", index=r.index)
        bad = quality.astype(str).str.strip().str.lower().isin(clean.BAD_QUALITY)
        if g in RAIN_MEASURES:
            bad |= r["value"] < 0
        elif g in bands:
            low, high = bands[g]
            bad |= (r["value"] < low) | (r["value"] > high)
        if bad.any():
            dropped = r.loc[bad, ["observed_at", "value"]]
            log.warning(
                "%s: dropped %d flagged or implausible reading(s), e.g. %s = %s",
                g,
                int(bad.sum()),
                dropped["observed_at"].iloc[0].strftime("%Y-%m-%dT%H:%M:%SZ"),
                dropped["value"].iloc[0],
            )
        out[g] = r.loc[~bad].reset_index(drop=True)
    return out


def _hourly_one(gauge: str, readings: pd.DataFrame, kind: str) -> pd.DataFrame:
    """One gauge's readings -> ``clean.clean_series`` (quality drop, hourly, gaps, spikes)."""
    raw = pd.DataFrame(
        {
            "gauge": gauge,
            "ts_utc": readings["observed_at"],
            "value": readings["value"].astype(float),
            "quality": readings["quality"] if "quality" in readings else "",
            "source": "fm_live",
        }
    )
    hourly, st = clean.clean_series(raw, kind)
    if st["spikes_removed"]:
        log.warning("%s: removed %d spike(s) from the live readings", gauge, st["spikes_removed"])
    return hourly


def to_hourly(readings: dict[str, pd.DataFrame]) -> pd.DataFrame:
    """Readings per gauge -> long hourly frame in the hourly.parquet union schema, plus ``rain_catchment``.

    Uses the same ``pipeline/clean.py`` functions as the history (SPEC §5.2), so live features are built
    from data cleaned the same way as the training data.
    """
    parts = [_hourly_one(g, r, "level") for g, r in readings.items() if not r.empty and g in LEVEL_MEASURES]
    rain_parts = [
        _hourly_one(g, r, "rain") for g, r in readings.items() if not r.empty and g in RAIN_MEASURES
    ]
    rain_parts = [p for p in rain_parts if not p.empty]
    if rain_parts:
        catchment, _ = clean.rain_catchment(pd.concat(rain_parts, ignore_index=True))
        parts += [*rain_parts, catchment]  # catchment = mean of available gauges per hour (SPEC §4.1)
    parts = [p for p in parts if not p.empty]
    if not parts:
        return pd.DataFrame(columns=HOURLY_COLUMNS)
    out = pd.concat(parts, ignore_index=True)[HOURLY_COLUMNS]
    out[["filled", "flagged"]] = out[["filled", "flagged"]].astype(bool)
    out[["level_mean", "level_max", "rain_mm"]] = out[["level_mean", "level_max", "rain_mm"]].astype(float)
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
    """Fetch (cached), clean, resample and write ``live_hourly.parquet`` and ``live_meta.json``."""
    readings = fetch_live_readings(now, cache_dir=cache_dir, fetch=fetch, max_workers=max_workers)
    readings = clean_readings(readings)  # before live_meta too: a junk latest reading is not levelNow
    hourly = to_hourly(readings)
    meta = live_meta(readings)
    if not meta["gauges"]:
        # Nothing at all (EA down and no cache): keep the last processed files rather than blank them.
        raise RuntimeError("no live readings for any level gauge; processed live files left as they were")
    out_hourly.parent.mkdir(parents=True, exist_ok=True)
    # Write then rename: the API's refresher may read these while `make live` writes them.
    tmp_hourly = out_hourly.with_name(f"{out_hourly.name}.{os.getpid()}.part")
    hourly.to_parquet(tmp_hourly, index=False)
    tmp_meta = out_meta.with_name(f"{out_meta.name}.{os.getpid()}.part")
    tmp_meta.write_text(json.dumps(meta, indent=2))
    tmp_hourly.replace(out_hourly)
    tmp_meta.replace(out_meta)
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
