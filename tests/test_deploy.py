"""Single-container deploy (issue #18): the API also serves the built web app when
RIVER_CLOCK_STATIC_DIR is set, and can refresh live data in the background.
No network; the "build" is a temp dir and the live compute is a fake.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api import main as api_main
from model import forecast_live as fl

ROOT = Path(__file__).resolve().parent.parent
INDEX = "<!doctype html><title>River Clock</title><div id=root></div>"


@pytest.fixture
def dist(tmp_path: Path) -> Path:
    (tmp_path / "index.html").write_text(INDEX)
    (tmp_path / "assets").mkdir()
    (tmp_path / "assets" / "app.js").write_text("console.log('hi')")
    (tmp_path / "data").mkdir()
    (tmp_path / "data" / "stations.json").write_text(json.dumps([{"id": "osney"}]))
    return tmp_path


@pytest.fixture
def client(dist: Path) -> TestClient:
    # A fresh app with the real /api routes, so mounting doesn't leak into other tests.
    app = FastAPI()
    app.router.routes.extend(r for r in api_main.app.routes if getattr(r, "path", "").startswith("/api"))
    api_main.mount_static(app, dist)
    return TestClient(app)


def test_serves_index_and_assets(client: TestClient) -> None:
    r = client.get("/")
    assert r.status_code == 200 and "River Clock" in r.text
    assert client.get("/assets/app.js").text == "console.log('hi')"


def test_serves_data_json(client: TestClient) -> None:
    r = client.get("/data/stations.json")
    assert r.status_code == 200
    assert "json" in r.headers["content-type"]
    assert r.json() == [{"id": "osney"}]


def test_spa_fallback_for_page_paths(client: TestClient) -> None:
    for path in ("/proof", "/time-machine/e2014"):
        r = client.get(path)
        assert r.status_code == 200 and "River Clock" in r.text, path


def test_missing_files_and_api_stay_404(client: TestClient) -> None:
    # A missing data file must 404 (not index.html) so web/src/data.ts falls back to fixtures.
    assert client.get("/data/missing.json").status_code == 404
    assert client.get("/assets/missing.js").status_code == 404
    assert client.get("/api/nope").status_code == 404


def test_api_routes_win_over_static(client: TestClient) -> None:
    assert client.get("/api/health").json() == {"status": "ok"}


def test_mount_needs_a_build(tmp_path: Path) -> None:
    with pytest.raises(RuntimeError, match="index.html"):
        api_main.mount_static(FastAPI(), tmp_path)


# ---------------------------------------------------------------------------------------------
# Background live refresh (RIVER_CLOCK_LIVE_BACKGROUND=1 in the container)
# ---------------------------------------------------------------------------------------------

T0 = datetime(2026, 10, 25, 2, 30, tzinfo=UTC)


def test_background_mode_never_computes_in_a_request() -> None:
    calls: list[datetime] = []

    def compute(now: datetime) -> dict:
        calls.append(now)
        return {"issuedAt": now.isoformat()}

    cache = api_main.LiveCache(compute)
    cache.background = True
    with pytest.raises(fl.LiveDataUnavailable):
        cache.get(T0)  # not refreshed yet: 503, not a minute-long EA poll
    cache.refresh(T0)
    # Long past the TTL, a request still gets the cached forecast; only the thread recomputes.
    assert cache.get(T0 + timedelta(hours=2)) == {"issuedAt": T0.isoformat()}
    assert calls == [T0]


def test_start_background_refreshes_and_survives_failures() -> None:
    ran = threading.Event()
    attempts = 0

    def compute(now: datetime) -> dict:
        nonlocal attempts
        attempts += 1
        ran.set()
        return {"ok": True}

    cache = api_main.LiveCache(compute, ttl=timedelta(milliseconds=10))
    thread = cache.start_background()
    assert ran.wait(2) and thread.daemon
    assert cache.get() == {"ok": True}

    def boom(now: datetime) -> dict:
        raise ConnectionError("EA down")

    cache.compute = boom
    time.sleep(0.05)  # several failed refreshes
    assert thread.is_alive() and cache.get() == {"ok": True}
    cache.ttl = timedelta(hours=1)  # park the daemon thread for the rest of the test run


def test_env_var_mounts_on_import(dist: Path) -> None:
    # Import api.main in a fresh interpreter with the setting, as uvicorn does in the container.
    code = (
        "from fastapi.testclient import TestClient; from api.main import app; c = TestClient(app); "
        "assert c.get('/api/health').json() == {'status': 'ok'}; "
        "assert 'River Clock' in c.get('/decide').text; print('ok')"
    )
    env = {**os.environ, "RIVER_CLOCK_STATIC_DIR": str(dist), "RIVER_CLOCK_LIVE_FETCH": "0"}
    out = subprocess.run([sys.executable, "-c", code], cwd=ROOT, env=env, capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    assert out.stdout.strip() == "ok"
