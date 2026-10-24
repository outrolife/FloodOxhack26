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


def test_api_health_and_live_unavailable() -> None:
    from api.main import app

    client = TestClient(app)
    assert client.get("/api/health").json() == {"status": "ok"}
    # No live mode yet: the web app must degrade to "Live data unavailable" (SPEC §10.1)
    assert client.get("/api/live").status_code == 503
