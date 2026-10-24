# River Clock. Targets from SPEC §2. Run `make setup` once (needs uv: brew install uv).
VENV := .venv
PY   := $(VENV)/bin/python

# Data root: RC_DATA_DIR env var, else ./data (same rule as pipeline/stations.py)
DATA_DIR     := $(if $(RC_DATA_DIR),$(RC_DATA_DIR),data)
DATA_RELEASE ?= data-hourly-v1

.PHONY: setup data fetch-data travel train backtest live api web test lint

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

# Skip the long download: fetch the cleaned hourly.parquet + provenance.parquet from a GitHub
# release asset (not in git). Override the tag with `make fetch-data DATA_RELEASE=data-hourly-v2`.
fetch-data:
	@command -v gh >/dev/null || { echo "gh not found: brew install gh"; exit 1; }
	mkdir -p $(DATA_DIR)/processed
	gh release download $(DATA_RELEASE) -D $(DATA_DIR)/processed --clobber

# Travel-time finding (SPEC §6)
travel: setup
	$(PY) -m analysis.travel_times

# Train + calibrate (SPEC §7.3–7.4)
train: setup
	$(PY) -m model.train
	$(PY) -m model.calibrate

# Replays + proof metrics; writes web/public/data/*.json (SPEC §8)
backtest: setup
	$(PY) -m model.backtest

# Live readings + forecast for now (SPEC §5.1, §10.1)
live: setup
	$(PY) -m pipeline.ingest_live
	$(PY) -m model.forecast_live

api: setup
	$(VENV)/bin/uvicorn api.main:app --reload --port 8000

web:
	@test -f web/package.json || { echo "web app not scaffolded yet (issue #5)"; exit 1; }
	cd web && npm install && npm run dev

test: setup
	$(PY) -m pytest

lint: setup
	$(VENV)/bin/ruff check .

# Single-container deploy (issue #18; deploy/README.md)
.PHONY: serve docker

# Production-style run without Docker: build the web app, then serve it and the API from one process on :8000
serve: setup
	cd web && npm ci && npm run build
	RIVER_CLOCK_STATIC_DIR=web/dist $(VENV)/bin/uvicorn api.main:app --port 8000

docker:
	docker build -f deploy/Dockerfile -t river-clock .
