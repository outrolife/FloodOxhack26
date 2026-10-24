"""Forecast for now from live readings (SPEC §10.1).

Issue #16.

Builds the SPEC §9 ``Forecast`` for the current time from ``<data>/processed/live_hourly.parquet`` and
``live_meta.json`` (written by ``pipeline/ingest_live.py``; ``<data>`` is ``$RC_DATA_DIR`` or
``<repo>/data``).

Method
------
- **Model** (when trained models exist): ``model.train.load_forecaster(models_dir)`` must return an
  object with ``predict(hourly, gauge, issued_at) -> {h: {QuantKey: level change}}`` and a ``upstreams``
  mapping ``{target gauge: [upstream gauges]}``. That hook belongs to #8; until it exists (or
  ``data/models/`` is empty) this module falls back to:
- **Persistence (fallback, labelled)**: probabilistic persistence (SPEC §7.6) with the level-change
  quantiles estimated from the last 28 days of live readings at that gauge. The Forecast then carries
  ``method: "persistence"`` and a ``note`` saying so; the UI must show it.

Stale rule (SPEC §10.1)
-----------------------
A gauge whose latest reading is more than 3 h old (or that returned no data) is listed in ``stale``,
and every spot that depends on it gets ``leads: []`` and ``arrival: null``. A spot depends on its own
gauge; with the model it also depends on that gauge's upstream inputs.

Probabilities follow SPEC §7.5 steps 2-5 (``exceedance_probability``, ``arrival_window``). They are a
local copy until ``model/probability.py`` (#8) lands; then swap these for the shared functions.

``web/public/data/live.json`` (committed, for the offline demo) is written only with ``--write-web``.
All times are UTC; ISO strings end in ``Z``.
"""

from __future__ import annotations

import argparse
import importlib
import json
import logging
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Protocol

import numpy as np
import pandas as pd

from pipeline import ingest_live

log = logging.getLogger(__name__)

REPO_ROOT = ingest_live.REPO_ROOT
DATA_DIR = ingest_live.DATA_DIR  # $RC_DATA_DIR or <repo>/data
MODELS_DIR = DATA_DIR / "models"
LIVE_HOURLY = ingest_live.OUT_HOURLY
LIVE_META = ingest_live.OUT_META
OUT_FORECAST = DATA_DIR / "processed" / "live_forecast.json"
WEB_LIVE = REPO_ROOT / "web" / "public" / "data" / "live.json"
SPOTS_YAML = REPO_ROOT / "config" / "spots.yaml"

STALE_AFTER = timedelta(hours=3)
LEADS_H: tuple[int, ...] = (6, 12, 24, 36, 48, 72)
ALPHAS: tuple[float, ...] = (0.05, 0.10, 0.25, 0.50, 0.75, 0.90, 0.95)
QUANT_KEYS: tuple[str, ...] = ("05", "10", "25", "50", "75", "90", "95")
MIN_PERSISTENCE_SAMPLES = 48

PERSISTENCE_NOTE = (
    "Persistence fallback: trained models are not available, so this forecast assumes the level stays "
    "roughly where it is, with spread from the last 28 days of level changes at each gauge. "
    "It is a baseline, not the River Clock model."
)


@dataclass(frozen=True)
class Spot:
    key: str
    name: str
    gauge: str
    threshold: float
    amber: float
    mode: str = "probability"


# SPEC §4.2 (threshold) and §4.1 (amber = gauge normal-range top). Used until config/spots.yaml exists.
DEFAULT_SPOTS: tuple[Spot, ...] = (
    Spot("osney", "Osney Island / Binsey", "osney", 3.79, 3.18),
    Spot("botley", "Botley Road / New Botley / Hinksey", "newbotley", 2.76, 2.01),
    Spot("abingdonrd", "Abingdon Road / Grandpont", "iffley", 3.25, 2.72),
    Spot("wolvercote", "Wolvercote / Port Meadow", "godstow", 3.07, 2.57),
    Spot("cherwell", "Cherwell (Kings Mill)", "kingsmill", 2.60, 2.40),
)


class LiveDataUnavailable(RuntimeError):
    """No live readings at all: the API answers 503 and the app shows "Live data unavailable"."""


class QuantileForecaster(Protocol):
    """Interface the trained models (#8) must provide via ``model.train.load_forecaster``."""

    upstreams: Mapping[str, list[str]]

    def predict(self, hourly: pd.DataFrame, gauge: str, issued_at: datetime) -> dict[int, dict[str, float]]:
        """Quantiles of ``level(t + h) - level(t)`` per lead h, keyed by ``QUANT_KEYS``."""
        ...


# ---------------------------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------------------------


def iso_utc(ts: datetime | pd.Timestamp) -> str:
    return pd.Timestamp(ts).tz_convert("UTC").strftime("%Y-%m-%dT%H:%M:%SZ")


def _utc(now: datetime | None) -> datetime:
    now = now or datetime.now(UTC)
    if now.tzinfo is None:
        raise ValueError("now must be tz-aware")
    return now.astimezone(UTC)


def load_spots(path: Path = SPOTS_YAML) -> list[Spot]:
    """Spots from ``config/spots.yaml`` (list under ``spots:``) if present, else ``DEFAULT_SPOTS``."""
    if not path.exists():
        return list(DEFAULT_SPOTS)
    import yaml

    raw = yaml.safe_load(path.read_text()) or {}
    items = raw.get("spots", raw) if isinstance(raw, dict) else raw
    if isinstance(items, dict):  # {key: {...}}
        items = [{"key": k, **v} for k, v in items.items()]
    return [
        Spot(
            key=s["key"],
            name=s.get("name", s["key"]),
            gauge=s["gauge"],
            threshold=float(s["threshold"]),
            amber=float(s["amber"]),
            mode=s.get("mode", "probability"),
        )
        for s in items
    ]


def stale_gauges(data_as_of: Mapping[str, str], gauges: list[str], now: datetime) -> list[str]:
    """Gauges with no reading, or whose latest reading is more than 3 h before ``now``."""
    now = _utc(now)
    out = []
    for g in gauges:
        seen = data_as_of.get(g)
        if seen is None or now - pd.Timestamp(seen).to_pydatetime() > STALE_AFTER:
            out.append(g)
    return sorted(out)


# ---------------------------------------------------------------------------------------------
# Persistence fallback (SPEC §7.6, estimated from the live window)
# ---------------------------------------------------------------------------------------------


class PersistenceForecaster:
    """``level(t + h) = level(t) + eps``; eps quantiles = empirical quantiles of past h-hour changes."""

    upstreams: Mapping[str, list[str]] = {}

    def predict(self, hourly: pd.DataFrame, gauge: str, issued_at: datetime) -> dict[int, dict[str, float]]:
        rows = hourly[(hourly["gauge"] == gauge) & (hourly["ts_utc"] <= pd.Timestamp(issued_at))]
        level = rows.set_index("ts_utc")["level_mean"].sort_index()
        if not level.empty:
            level = level.reindex(pd.date_range(level.index.min(), level.index.max(), freq="h", tz="UTC"))
        out: dict[int, dict[str, float]] = {}
        for h in LEADS_H:
            changes = (level.shift(-h) - level).dropna()
            if len(changes) >= MIN_PERSISTENCE_SAMPLES:
                qs = np.quantile(changes.to_numpy(), ALPHAS)
            else:
                qs = np.zeros(len(ALPHAS))  # too little history: pure persistence
            out[h] = dict(zip(QUANT_KEYS, (float(q) for q in qs), strict=True))
        return out


def load_model_forecaster(models_dir: Path = MODELS_DIR) -> QuantileForecaster | None:
    """Trained models via ``model.train.load_forecaster(models_dir)``, or None if not available yet."""
    if not models_dir.exists() or not any(models_dir.iterdir()):
        return None
    try:
        loader = importlib.import_module("model.train").load_forecaster
        return loader(models_dir)
    except (AttributeError, NotImplementedError, FileNotFoundError) as exc:
        log.warning("models in %s not loadable yet (%s); using persistence", models_dir, exc)
        return None


# ---------------------------------------------------------------------------------------------
# Probability and timing (SPEC §7.5 steps 2-5; local copy until model/probability.py lands)
# ---------------------------------------------------------------------------------------------


def exceedance_probability(levels: Mapping[str, float], threshold: float) -> float:
    """P(level > threshold) from level quantiles: piecewise-linear CDF, linear tails, clipped."""
    q = np.sort([levels[k] for k in QUANT_KEYS])
    a = np.array(ALPHAS)
    if q[-1] == q[0]:  # no spread
        return 0.0 if threshold >= q[0] else 1.0
    if threshold < q[0]:
        slope = (a[2] - a[0]) / (q[2] - q[0]) if q[2] > q[0] else np.inf
        cdf = a[0] - (q[0] - threshold) * slope
    elif threshold > q[-1]:
        slope = (a[-1] - a[-3]) / (q[-1] - q[-3]) if q[-1] > q[-3] else np.inf
        cdf = a[-1] + (threshold - q[-1]) * slope
    else:
        cdf = float(np.interp(threshold, q, a))
    return float(1.0 - np.clip(cdf, 0.0, 1.0))


def arrival_window(
    level_now: float, threshold: float, p_by_lead: Mapping[int, float], issued_at: datetime
) -> dict:
    """First times p reaches 0.1 / 0.5 / 0.9, interpolated between leads (h = 0 is the observation)."""
    hs = [0, *sorted(p_by_lead)]
    ps = [1.0 if level_now >= threshold else 0.0, *(p_by_lead[h] for h in sorted(p_by_lead))]
    out: dict[str, str | None] = {}
    for name, target in (("p10", 0.1), ("p50", 0.5), ("p90", 0.9)):
        hit: float | None = None
        if ps[0] >= target:
            hit = 0.0
        else:
            for i in range(1, len(hs)):
                h0, p0, h1, p1 = hs[i - 1], ps[i - 1], hs[i], ps[i]
                if p1 >= target > p0:
                    hit = h0 + (target - p0) / (p1 - p0) * (h1 - h0)
                    break
        out[name] = iso_utc(issued_at + timedelta(hours=hit)) if hit is not None else None
    return out


# ---------------------------------------------------------------------------------------------
# Forecast
# ---------------------------------------------------------------------------------------------


def _level_now(hourly: pd.DataFrame, meta: Mapping[str, Any], gauge: str) -> float | None:
    if gauge in meta.get("gauges", {}):
        return float(meta["gauges"][gauge]["level"])
    rows = hourly[hourly["gauge"] == gauge].dropna(subset=["level_mean"])
    return float(rows.sort_values("ts_utc")["level_mean"].iloc[-1]) if not rows.empty else None


def build_forecast(
    hourly: pd.DataFrame,
    meta: Mapping[str, Any],
    now: datetime | None = None,
    *,
    forecaster: QuantileForecaster | None = None,
    spots: list[Spot] | None = None,
) -> dict[str, Any]:
    """The SPEC §9 ``Forecast`` for ``now`` (plus ``method`` and ``note``). Pure: no I/O."""
    now = _utc(now).replace(second=0, microsecond=0)
    spots = spots if spots is not None else list(DEFAULT_SPOTS)
    method = "model" if forecaster is not None else "persistence"
    forecaster = forecaster or PersistenceForecaster()

    data_as_of = {g: v["observed_at"] for g, v in sorted(meta.get("gauges", {}).items())}
    if not data_as_of:
        raise LiveDataUnavailable("no live readings for any gauge")
    depends = {s.key: [s.gauge, *forecaster.upstreams.get(s.gauge, [])] for s in spots}
    all_gauges = sorted({g for gs in depends.values() for g in gs} | set(data_as_of))
    stale = stale_gauges(data_as_of, all_gauges, now)

    out_spots = []
    for spot in spots:
        level_now = _level_now(hourly, meta, spot.gauge)
        if level_now is None:
            log.warning("spot %s: no reading at %s; left out", spot.key, spot.gauge)
            continue
        entry: dict[str, Any] = {
            "spot": spot.key,
            "levelNow": round(level_now, 3),
            "leads": [],
            "arrival": None,
            "mode": spot.mode,
        }
        if not any(g in stale for g in depends[spot.key]):
            deltas = forecaster.predict(hourly, spot.gauge, now)
            p_flood_run, p_amber_run, p_flood = 0.0, 0.0, {}
            for h in LEADS_H:
                levels = dict(
                    zip(QUANT_KEYS, sorted(level_now + deltas[h][k] for k in QUANT_KEYS), strict=True)
                )
                # SPEC §7.5 step 4: probabilities never decrease with lead time.
                p_flood_run = max(p_flood_run, exceedance_probability(levels, spot.threshold))
                p_amber_run = max(p_amber_run, exceedance_probability(levels, spot.amber))
                p_flood[h] = p_flood_run
                entry["leads"].append(
                    {
                        "h": h,
                        "q": {k: round(v, 3) for k, v in levels.items()},
                        "pFlood": round(p_flood_run, 3) if spot.mode == "probability" else None,
                        "pAmber": round(p_amber_run, 3),
                    }
                )
            if spot.mode == "probability":
                entry["arrival"] = arrival_window(level_now, spot.threshold, p_flood, now)
        out_spots.append(entry)

    return {
        "issuedAt": iso_utc(now),
        "dataAsOf": data_as_of,
        "stale": stale,
        "spots": out_spots,
        "method": method,
        "note": PERSISTENCE_NOTE if method == "persistence" else "",
    }


def refresh(now: datetime | None = None, *, fetch: bool = True) -> dict[str, Any]:
    """Ingest (cached, at most one EA poll per 15 min) if ``fetch``, then build the Forecast.

    Raises ``LiveDataUnavailable`` if there are no live readings at all.
    """
    now = _utc(now)
    if fetch:
        try:
            ingest_live.ingest_live(now)
        except Exception as exc:  # network down: fall back to the last processed files
            log.warning("live ingest failed (%s); using last processed live data", exc)
    if not LIVE_HOURLY.exists() or not LIVE_META.exists():
        raise LiveDataUnavailable("no processed live data")
    hourly = pd.read_parquet(LIVE_HOURLY)
    meta = json.loads(LIVE_META.read_text())
    return build_forecast(hourly, meta, now, forecaster=load_model_forecaster(), spots=load_spots())


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    parser = argparse.ArgumentParser(description="Forecast for now from live readings (SPEC §10.1).")
    parser.add_argument(
        "--write-web", action="store_true", help=f"also write {WEB_LIVE} (committed demo data)"
    )
    parser.add_argument("--no-fetch", action="store_true", help="use the last processed live data only")
    args = parser.parse_args()
    forecast = refresh(fetch=not args.no_fetch)
    targets = [OUT_FORECAST, *([WEB_LIVE] if args.write_web else [])]
    for path in targets:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(forecast, indent=2) + "\n")
        log.info("wrote %s (%s, stale: %s)", path, forecast["method"], forecast["stale"] or "none")


if __name__ == "__main__":
    main()
