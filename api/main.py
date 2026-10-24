"""River Clock API (SPEC §10.1).

GET /api/live returns the current Forecast (cached <= 15 min). Until live mode exists
it answers 503, which the web app shows as "Live data unavailable".

Issue #16. See SPEC.md for the full specification.
"""
from __future__ import annotations

from fastapi import FastAPI, HTTPException

app = FastAPI(title="River Clock")


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/live")
def live() -> dict:
    raise HTTPException(status_code=503, detail="Live data unavailable")
