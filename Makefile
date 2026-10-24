# River Clock. Targets from SPEC §2. Run `make setup` once (needs uv: brew install uv).
# Windows: run make from Git Bash (recipes use sh); get make with `winget install ezwinports.make`.
VENV := .venv
ifeq ($(OS),Windows_NT)
BIN := $(VENV)/Scripts
EXE := .exe
else
BIN := $(VENV)/bin
EXE :=
endif
PY   := $(BIN)/python$(EXE)

# Data root: RC_DATA_DIR env var, else ./data (same rule as pipeline/stations.py)
DATA_DIR     := $(if $(RC_DATA_DIR),$(RC_DATA_DIR),data)
DATA_RELEASE ?= data-hourly-v1

.PHONY: setup data fetch-data travel train backtest live live-web api web test lint mirror

setup: $(VENV)/.installed

$(VENV)/.installed: pyproject.toml
	@command -v uv >/dev/null || { echo "uv not found: brew install uv"; exit 1; }
	uv venv --python 3.11 --allow-existing $(VENV)
	uv pip install --python $(PY) -r pyproject.toml --extra dev
	@$(PY) -c "import lightgbm" 2>/dev/null || echo "WARNING: lightgbm can't load. On macOS run: brew install libomp"
	@touch $@

# Ingest history + warnings, clean, quality report (SPEC §5); export stations/spots/events.json (§9)
data: setup
	$(PY) -m pipeline.ingest_history
	$(PY) -m pipeline.ingest_warnings
	$(PY) -m pipeline.clean
	$(PY) -m pipeline.quality_report
	$(PY) -m pipeline.export_static

# Skip the long download: fetch the cleaned hourly.parquet, provenance.parquet, clean_log.json and
# warnings.parquet (+ warnings_provenance.json) from GitHub release assets (not in git). Override
# the tag with `make fetch-data DATA_RELEASE=data-hourly-v2`. If the release has no warnings.parquet,
# build it with pipeline.ingest_warnings (about 15 s, one ZIP download, cached in data/raw/).
fetch-data:
	@command -v gh >/dev/null || { echo "gh not found: brew install gh"; exit 1; }
	mkdir -p $(DATA_DIR)/processed
	gh release download $(DATA_RELEASE) -D $(DATA_DIR)/processed --clobber
	@test -f $(DATA_DIR)/processed/warnings.parquet || { \
	  echo "$(DATA_RELEASE) has no warnings.parquet: running pipeline.ingest_warnings"; \
	  $(MAKE) setup && RC_DATA_DIR=$(DATA_DIR) $(PY) -m pipeline.ingest_warnings; }

# Travel-time finding (SPEC §6)
travel: setup
	$(PY) -m analysis.travel_times

# Train + calibrate the four target gauges (SPEC §4.1.1, §7.3–7.4); writes importance.json
TARGETS := newbotley minns coldharbour kingsmill
train: setup
	$(PY) -m model.train --targets $(TARGETS)
	$(PY) -m model.calibrate

# Leave-one-flood-out replays for every event + proof metrics (SPEC §8): rebuilds
# web/public/data/replays/*.json and proof.json from the `make train` models (#81)
backtest: setup
	$(PY) -m model.proof --rebuild --jobs 4 --targets $(TARGETS)

# Live readings + forecast for now (SPEC §5.1, §10.1)
live: setup
	$(PY) -m pipeline.ingest_live
	$(PY) -m model.forecast_live

# Refresh the committed offline snapshot web/public/data/live.json (needs network; one EA poll,
# cached 15 min) and check it against SPEC §9. Commit the result via a PR (docs/demo-backup.md).
live-web: setup
	$(PY) -m model.forecast_live --write-web
	$(PY) -m pytest -q tests/test_public_data.py -k live

api: setup
	$(BIN)/uvicorn$(EXE) api.main:app --reload --port 8000

web:
	@test -f web/package.json || { echo "web app not scaffolded yet (issue #5)"; exit 1; }
	cd web && npm install && npm run dev

test: setup
	$(PY) -m pytest

lint: setup
	$(BIN)/ruff$(EXE) check .

# Single-container deploy (issue #18; deploy/README.md)
.PHONY: serve docker

# Production-style run without Docker: build the web app, then serve it and the API from one process on :8000
serve: setup
	cd web && npm ci && npm run build
	RIVER_CLOCK_STATIC_DIR=web/dist $(BIN)/uvicorn$(EXE) api.main:app --port 8000

docker:
	docker build -f deploy/Dockerfile -t river-clock .

# Optional Tiger Data mirror of hourly + live readings (SPEC §2, P2; docs/tiger-data.md). Needs
# TIGER_DATABASE_URL and the extra: uv pip install --python .venv/bin/python -r pyproject.toml --extra mirror
# (.venv/Scripts/python.exe on Windows)
mirror: setup
	$(PY) -m pipeline.mirror_tiger --hourly --live

# ---- Offline demo kit (issue #70; docs/demo-backup.md) -----------------------------------------
.PHONY: demo preflight

DEMO_PORT ?= 8080
DEMO_LIVE ?= 0
DEMO_OPEN ?= 1
# The preflight runs on the system Python (stdlib only, 3.9+), so it works before `make setup`.
SYS_PY := $(if $(filter Windows_NT,$(OS)),python,python3)
# Everything the web build reads: dist is rebuilt only when one of these is newer than it.
WEB_SOURCES := $(shell find web/src web/public tests/fixtures -type f 2>/dev/null) \
  web/index.html web/package.json web/package-lock.json web/vite.config.ts web/tsconfig.json

# npm ci only when the lockfile changed (needs network the first time, never after).
web/node_modules/.package-lock.json: web/package-lock.json
	cd web && npm ci --no-audit --no-fund

# Build, then stamp dist with the commit it was built from (make preflight checks it against HEAD).
web/dist/index.html: $(WEB_SOURCES) web/node_modules/.package-lock.json
	cd web && npm run build
	$(SYS_PY) scripts/demo_preflight.py --stamp

# The presenter's command: built SPA + /data + /api from one process on 127.0.0.1:$(DEMO_PORT), and
# the browser opens. Offline by default; DEMO_LIVE=1 polls the EA; DEMO_OPEN=0 skips the browser.
demo: setup web/dist/index.html
	@DEMO_PORT=$(DEMO_PORT) DEMO_LIVE=$(DEMO_LIVE) DEMO_OPEN=$(DEMO_OPEN) $(PY) scripts/demo_serve.py

# Pre-judging checklist; run it while `make demo` is up (docs/demo-backup.md).
preflight:
	@$(SYS_PY) scripts/demo_preflight.py --port $(DEMO_PORT)

# ---- Stretch (SPEC §11; only after the core gate in §13) ----------------------------------------
.PHONY: s2

# S2: Open-Meteo ensemble rain for the next 72 h, context only (not a model input). Writes
# web/public/data/ensemble_rain.json; the River tab hides the panel when it is over 24 h old.
s2: setup
	$(PY) -m stretch.s2_ensemble_rain --write-web
