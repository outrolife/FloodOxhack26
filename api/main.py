"""River Clock API (SPEC §10.1).

GET /api/live returns the current Forecast from ``model/forecast_live.py``, recomputed at most every
15 minutes (the EA asks for polling no more often than that). With no live data at all it answers
503 "Live data unavailable", which the web app shows as such. Everything else is static JSON.

Set ``RIVER_CLOCK_LIVE_FETCH=0`` to serve only the last processed live data without polling the EA.

Set ``RIVER_CLOCK_STATIC_DIR`` to a built web app (``web/dist``) to serve it from this same process:
files at ``/`` (so ``/data/*.json`` too), with unknown page paths falling back to ``index.html``.
This is how the single-container deploy works (``deploy/``, issue #18). Unset, the API serves only
``/api/*``, as in development.

Set ``RIVER_CLOCK_LIVE_BACKGROUND=1`` (the container does) to refresh the live forecast in a
background thread every 15 minutes instead of inside a request. A full EA poll can take a minute,
longer than the web app waits for ``/api/live``; with this on, requests only ever read the cache.

Issue #16.
"""

from __future__ import annotations

import logging
import mimetypes
import os
import threading
import time
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.staticfiles import StaticFiles
from starlette.types import Scope

from model import forecast_live

log = logging.getLogger(__name__)

LIVE_TTL = timedelta(minutes=15)


class LiveCache:
    """The last Forecast and when it was computed. Recomputes only when older than ``ttl``."""

    def __init__(self, compute: Callable[[datetime], dict[str, Any]], ttl: timedelta = LIVE_TTL) -> None:
        self.compute = compute
        self.ttl = ttl
        self.computed_at: datetime | None = None
        self.forecast: dict[str, Any] | None = None
        self.background = False  # True once start_background() runs: requests never compute
        self._lock = threading.Lock()

    def get(self, now: datetime | None = None) -> dict[str, Any]:
        now = now or datetime.now(UTC)
        if self.background:
            # The refresher thread keeps the cache current; until its first run there is no data.
            if self.forecast is None:
                raise forecast_live.LiveDataUnavailable("live forecast not computed yet")
            return self.forecast
        with self._lock:
            if (
                self.forecast is not None
                and self.computed_at is not None
                and now - self.computed_at < self.ttl
            ):
                return self.forecast
            try:
                self.forecast = self.compute(now)
                self.computed_at = now
            except Exception as exc:
                if self.forecast is None:
                    raise forecast_live.LiveDataUnavailable(str(exc)) from exc
                # Keep serving the last good forecast; its `stale` list shows how old the data is.
                log.warning("live recompute failed (%s); serving forecast from %s", exc, self.computed_at)
                self.computed_at = now  # don't hammer the EA: retry after another TTL
            return self.forecast

    def refresh(self, now: datetime | None = None) -> None:
        """Recompute outside the lock, then swap: readers keep the old forecast meanwhile."""
        now = now or datetime.now(UTC)
        forecast = self.compute(now)
        with self._lock:
            self.forecast, self.computed_at = forecast, now

    def start_background(self) -> threading.Thread:
        """Refresh now and then every ``ttl`` in a daemon thread. Failures keep the last forecast."""
        self.background = True

        def loop() -> None:
            while True:
                try:
                    self.refresh()
                except Exception as exc:
                    log.warning(
                        "background live refresh failed (%s); keeping forecast from %s", exc, self.computed_at
                    )
                time.sleep(self.ttl.total_seconds())

        thread = threading.Thread(target=loop, name="live-refresh", daemon=True)
        thread.start()
        return thread


def _compute_live(now: datetime) -> dict[str, Any]:
    fetch = os.environ.get("RIVER_CLOCK_LIVE_FETCH", "1") != "0"
    return forecast_live.refresh(now, fetch=fetch)


live_cache = LiveCache(_compute_live)


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    if os.environ.get("RIVER_CLOCK_LIVE_BACKGROUND", "0") == "1":
        live_cache.start_background()
    yield


app = FastAPI(title="River Clock", lifespan=lifespan)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/live")
def live() -> dict[str, Any]:
    try:
        return live_cache.get()
    except forecast_live.LiveDataUnavailable as exc:
        raise HTTPException(status_code=503, detail="Live data unavailable") from exc


# Python doesn't know .geojson, so Starlette would send the offline basemap
# (data/geo/oxford-base.geojson) as application/octet-stream and the web app
# would reject it as "not JSON": no map at all under `make demo` (#118).
mimetypes.add_type("application/geo+json", ".geojson")


class SPAStaticFiles(StaticFiles):
    """Static files with a single-page-app fallback.

    A missing page path (no file extension, e.g. ``/proof``) gets ``index.html`` so the React app can
    route it. Missing files (``/data/x.json``, ``/assets/y.js``) and anything under ``/api/`` stay 404,
    so the web app's fixture fallback and API clients see a real error.
    """

    async def get_response(self, path: str, scope: Scope):  # type: ignore[override]
        try:
            return await super().get_response(path, scope)
        except StarletteHTTPException as exc:
            # Starlette hands us an OS path (os.path.normpath): ``api\nope`` on Windows. Check the
            # URL-style form so ``/api/*`` stays 404 on every OS.
            url_path = path.replace(os.sep, "/")
            last = url_path.rsplit("/", 1)[-1]
            if exc.status_code != 404 or url_path == "api" or url_path.startswith("api/") or "." in last:
                raise
            return await super().get_response("index.html", scope)


def mount_static(target: FastAPI, directory: Path) -> None:
    """Serve the built web app at ``/``. Call after the API routes so ``/api/*`` wins."""
    if not (directory / "index.html").is_file():
        raise RuntimeError(f"RIVER_CLOCK_STATIC_DIR={directory} has no index.html; run `npm run build`")
    target.mount("/", SPAStaticFiles(directory=directory, html=True), name="web")


if static_dir := os.environ.get("RIVER_CLOCK_STATIC_DIR"):
    mount_static(app, Path(static_dir))
