"""River Clock API (SPEC §10.1).

GET /api/live returns the current Forecast from ``model/forecast_live.py``, recomputed at most every
15 minutes (the EA asks for polling no more often than that). With no live data at all it answers
503 "Live data unavailable", which the web app shows as such. Everything else is static JSON.

Set ``RIVER_CLOCK_LIVE_FETCH=0`` to serve only the last processed live data without polling the EA.

Issue #16.
"""

from __future__ import annotations

import logging
import os
import threading
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import FastAPI, HTTPException

from model import forecast_live

log = logging.getLogger(__name__)

app = FastAPI(title="River Clock")

LIVE_TTL = timedelta(minutes=15)


class LiveCache:
    """The last Forecast and when it was computed. Recomputes only when older than ``ttl``."""

    def __init__(self, compute: Callable[[datetime], dict[str, Any]], ttl: timedelta = LIVE_TTL) -> None:
        self.compute = compute
        self.ttl = ttl
        self.computed_at: datetime | None = None
        self.forecast: dict[str, Any] | None = None
        self._lock = threading.Lock()

    def get(self, now: datetime | None = None) -> dict[str, Any]:
        now = now or datetime.now(UTC)
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


def _compute_live(now: datetime) -> dict[str, Any]:
    fetch = os.environ.get("RIVER_CLOCK_LIVE_FETCH", "1") != "0"
    return forecast_live.refresh(now, fetch=fetch)


live_cache = LiveCache(_compute_live)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/live")
def live() -> dict[str, Any]:
    try:
        return live_cache.get()
    except forecast_live.LiveDataUnavailable as exc:
        raise HTTPException(status_code=503, detail="Live data unavailable") from exc
