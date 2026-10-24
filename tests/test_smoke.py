"""Every module in the SPEC §2 layout imports, and the API answers."""

from __future__ import annotations

import importlib

import pytest
from fastapi.testclient import TestClient

MODULES = [
    "pipeline.ea_client",
    "pipeline.ingest_history",
    "pipeline.ingest_warnings",
    "pipeline.ingest_live",
    "pipeline.clean",
    "pipeline.quality_report",
    "analysis.travel_times",
    "model.features",
    "model.train",
    "model.calibrate",
    "model.probability",
    "model.backtest",
    "model.forecast_live",
    "api.main",
]


@pytest.mark.parametrize("name", MODULES)
def test_module_imports(name: str) -> None:
    importlib.import_module(name)


def test_api_health_and_live_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    from api import main
    from model.forecast_live import LiveDataUnavailable

    def no_data(now: object) -> dict:
        raise LiveDataUnavailable("no live readings")

    monkeypatch.setattr(main, "live_cache", main.LiveCache(no_data))
    client = TestClient(main.app)
    assert client.get("/api/health").json() == {"status": "ok"}
    # No live data: the web app must degrade to "Live data unavailable" (SPEC §10.1)
    resp = client.get("/api/live")
    assert resp.status_code == 503
    assert resp.json()["detail"] == "Live data unavailable"
