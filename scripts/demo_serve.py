"""River Clock offline demo server (issue #70; docs/demo-backup.md). Run it through `make demo`,
which first builds web/dist if it is older than its sources.

One uvicorn process on 127.0.0.1:$DEMO_PORT (default 8080) serves:
  /          the built SPA (web/dist)
  /data/*    the committed JSON (Vite copied web/public/data/ into dist)
  /api/*     FastAPI (api/main.py)

DEMO_LIVE=0 (default): no network at all. /api/live answers 503 at once, so the River tab shows
  "Live data unavailable" with the committed live.json (the offline line in docs/demo.md step 5).
  How: RC_DATA_DIR points at an empty folder and EA fetches are off, so the live endpoint finds no
  processed live data and says so instantly, instead of loading models on the first request or
  serving day-old readings as if they were live.
DEMO_LIVE=1: poll the EA every 15 min in a background thread, as the container does.
DEMO_OPEN=0: don't open a browser.

Runs under the project venv (it needs uvicorn); works on macOS, Linux and Windows.
"""

from __future__ import annotations

import os
import platform
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "web" / "dist"


def answers(url: str, timeout: float = 1.0) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=timeout):
            return True
    except Exception:
        return False


def open_browser(url: str) -> None:
    """``open`` on macOS, ``xdg-open`` on Linux, the default browser on Windows; else nothing."""
    system = platform.system()
    try:
        if system == "Darwin":
            subprocess.run(["open", url], check=False)
        elif system == "Linux":
            subprocess.run(["xdg-open", url], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        elif system == "Windows":
            webbrowser.open(url)
    except OSError:
        pass  # no opener installed: the URL is printed anyway


def open_when_ready(url: str, enabled: bool, wait_s: float = 15.0) -> None:
    deadline = time.monotonic() + wait_s
    while time.monotonic() < deadline:
        if answers(url + "api/health"):
            if enabled:
                open_browser(url)
            return
        time.sleep(0.25)
    print(f"demo: server did not answer {url}api/health within {wait_s:.0f} s; see the output above")


def main() -> None:
    port = int(os.environ.get("DEMO_PORT", "8080"))
    live = os.environ.get("DEMO_LIVE", "0") == "1"
    should_open = os.environ.get("DEMO_OPEN", "1") != "0"
    url = f"http://127.0.0.1:{port}/"

    if not (DIST / "index.html").is_file():
        raise SystemExit("web/dist/index.html missing: run `make demo` (it builds the app first)")

    if answers(url + "api/health"):  # a second `make demo`: just reopen the browser
        print(f"River Clock demo already running at {url}")
        if should_open:
            open_browser(url)
        return

    if live:
        os.environ.update(RIVER_CLOCK_LIVE_FETCH="1", RIVER_CLOCK_LIVE_BACKGROUND="1")
        mode = "LIVE: polls the EA every 15 min (needs network)"
    else:
        offline_data = Path(tempfile.gettempdir()) / "river-clock-demo-offline"
        offline_data.mkdir(exist_ok=True)
        os.environ.update(
            RC_DATA_DIR=str(offline_data), RIVER_CLOCK_LIVE_FETCH="0", RIVER_CLOCK_LIVE_BACKGROUND="0"
        )
        mode = "offline: no network used; River tab shows the saved live.json (DEMO_LIVE=1 for live)"
    os.environ["RIVER_CLOCK_STATIC_DIR"] = str(DIST)

    print()
    print(f"  River Clock demo  ->  {url}")
    print(f"  mode: {mode}")
    print("  check: make preflight (in another terminal)    stop: Ctrl-C")
    print(flush=True)

    threading.Thread(target=open_when_ready, args=(url, should_open), daemon=True).start()

    import uvicorn  # after the env is set: api.main reads it at import

    os.chdir(ROOT)
    sys.path.insert(0, str(ROOT))  # so "api.main" imports when run as scripts/demo_serve.py
    uvicorn.run("api.main:app", host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()
