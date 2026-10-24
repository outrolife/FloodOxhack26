# River Clock: one container that serves the built web app and the API (issue #18).
#
#   docker build -f deploy/Dockerfile -t river-clock .        # from the repo root
#   docker run -p 8000:8000 -v river-clock-data:/data river-clock
#
# Stage 1 builds web/dist with Node. Stage 2 is Python 3.11 slim running uvicorn on :8000:
#   /          built SPA (unknown page paths fall back to index.html)
#   /data/*    the committed JSON in web/public/data/ (Vite copies it into dist/)
#   /api/*     FastAPI (api/main.py); /api/live polls the EA at most every 15 min
# Live data and the EA response cache go to /data (a volume). If live fails, the app still runs
# offline from the committed JSON and the fixtures bundled into the build.

# ---- Stage 1: web build ------------------------------------------------------------------------
FROM node:24-slim AS web
WORKDIR /src
# Install deps first so this layer is cached until package*.json change.
COPY web/package.json web/package-lock.json web/
RUN cd web && npm ci --no-audit --no-fund
# src/data.ts bundles tests/fixtures/ as the offline fallback, so the build needs them too.
COPY tests/fixtures tests/fixtures
COPY web web
RUN cd web && npm run build

# ---- Stage 2: runtime --------------------------------------------------------------------------
FROM python:3.11-slim AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
# libgomp1: OpenMP runtime that LightGBM needs on Linux.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Runtime deps straight from pyproject.toml [project.dependencies] (no dev/stretch extras).
COPY pyproject.toml .
RUN python -c "import tomllib; print('\n'.join(tomllib.load(open('pyproject.toml', 'rb'))['project']['dependencies']))" \
        > /tmp/requirements.txt \
    && pip install -r /tmp/requirements.txt \
    && rm /tmp/requirements.txt

COPY config config
COPY pipeline pipeline
COPY analysis analysis
COPY model model
COPY api api
COPY --from=web /src/web/dist web/dist

RUN useradd --create-home --uid 1000 app \
    && mkdir -p /data \
    && chown app:app /data
USER app

ENV RC_DATA_DIR=/data \
    RIVER_CLOCK_STATIC_DIR=/app/web/dist \
    RIVER_CLOCK_LIVE_FETCH=1
VOLUME ["/data"]
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4)"

# One worker: the 15-min live cache lives in process memory.
CMD ["uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
