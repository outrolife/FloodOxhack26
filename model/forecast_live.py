"""Forecast for now from live readings (SPEC §10.1).

Issue #16.

Builds the SPEC §9 ``Forecast`` for the current time from ``<data>/processed/live_hourly.parquet`` and
``live_meta.json`` (written by ``pipeline/ingest_live.py``; ``<data>`` is ``$RC_DATA_DIR`` or
``<repo>/data``).

Method
------
- **Model** (``method: "model"``, issue #79): ``load_model_forecaster`` loads every trained
  ``model.train.GaugeModel`` under ``<data>/models/<gauge>/`` (``GaugeModel.load``; ``models/lofo/`` is
  skipped) into a ``TrainedForecaster``. It forecasts exactly as ``model/backtest.forecasts_at`` does
  for the Time Machine: ``model.features.build_features`` on the live hourly rows up to the anchor hour,
  with the medians and travel-time lags saved in the model, then ``GaugeModel.predict`` (sorted and
  CQR-calibrated, SPEC §7.4), then ``model.probability.spot_forecast`` (SPEC §7.5).
  The anchor hour is the last complete hourly row, ``floor(now) - 1 h``, exactly as a replay forecast
  issued at ``floor(now)`` (#93). If the target gauge has no reading of its own in that hour (missing,
  or only forward-filled), that spot gets labelled persistence instead, never an older row.
  As in the backtest, the level quantiles are the model's ``level_now`` (that hour's mean, the
  quantity it was trained on) plus the predicted changes; ``levelNow`` shows the latest 15-min reading.
  Lead h is labelled ``issuedAt + h`` as before.
- **Data gaps**: a model forecast made with NaN features (an upstream gauge with a gap inside its lag
  windows, or no catchment rain) is kept, but the ``note`` says which spot and inputs, because
  LightGBM does not widen its range for missing inputs. A model that raises falls back to
  persistence for that spot.
- **Persistence (fallback, labelled)**: probabilistic persistence (SPEC §7.6) with the level-change
  quantiles estimated from the last 28 days of live readings at that gauge. Used when no model loads
  (``method: "persistence"`` and a ``note`` saying so; the UI must show it), and per spot when its gauge
  has no trained model or no level in the anchor hour (``method`` stays "model"; the ``note`` names
  those spots).

Stale rule (SPEC §10.1)
-----------------------
A gauge whose latest reading is more than 3 h old (or that returned no data) is listed in ``stale``.
A spot whose own gauge is stale gets ``leads: []`` and ``arrival: null``. A spot whose own gauge is
fresh but one of its model's upstream inputs (its river walk, ``TrainedForecaster.upstreams``) is stale
gets labelled persistence instead (#125, PM condition 2): the ``note`` names the spot and the stale
gauge, and every other spot keeps its model forecast. So a stale Shifford sends Botley and Osney (minns)
to persistence, while Abingdon Road (coldharbour) and Cherwell (kingsmill), which do not read it, are
unaffected.

Live-only gauges (SPEC §4.1.1: godstow, osney, iffley have no downstream-stage history) are shown with
their live level but never forecast: a spot on one (wolvercote -> godstow) is ``timing_only`` with
``leads: []`` and ``arrival: null``. A spot whose threshold is still TBC is ``timing_only``: leads with
quantiles and ``pAmber``, but ``pFlood: null`` and no arrival window.

Probabilities and arrival windows come from the shared ``model/probability.py`` (SPEC §7.5), the same
functions the backtest uses.

``observed`` (SPEC §9, adopted on #38) holds the hourly level of every level gauge over the last 7 days
up to ``issuedAt``, live-only gauges included, so the River strip can draw sparklines. It is the hourly
mean from ``live_hourly.parquet`` (hour-start labels, the current hour partial), rounded to 3 dp; hours
with no reading are left out. Each series is on its own gauge datum: never compare across gauges.

``web/public/data/live.json`` (committed, for the offline demo) is written only with ``--write-web``.
All times are UTC; ISO strings end in ``Z``.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Protocol

import numpy as np
import pandas as pd

from model import probability
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
LEADS_H: tuple[int, ...] = probability.HORIZONS_H  # (6, 12, 24, 36, 48, 72)
ALPHAS: tuple[float, ...] = probability.ALPHAS
QUANT_KEYS: tuple[str, ...] = probability.QUANT_KEYS
MIN_PERSISTENCE_SAMPLES = 48
OBSERVED_WINDOW = timedelta(days=7)  # Forecast.observed: last 7 days, hourly

PERSISTENCE_NOTE = (
    "Persistence fallback: trained models are not available, so this forecast assumes the level stays "
    "roughly where it is, with spread from the last 28 days of level changes at each gauge. "
    "It is a baseline, not the River Clock model."
)
PARTIAL_PERSISTENCE_NOTE = (
    "Persistence fallback for {spots}: no trained model or no current reading for that gauge, so the "
    "forecast there assumes the level stays roughly where it is. The other spots use the River Clock model."
)
STALE_UPSTREAM_NOTE = (
    "Persistence fallback for {spot}: no reading for over 3 hours from {gauges} upstream, which its "
    "model needs, so the forecast there assumes the level stays roughly where it is."
)
GAP_NOTE = (
    "Data gap: the {spot} forecast is missing recent readings from {inputs}, so its range may be too narrow."
)


LIVE_ONLY_GAUGES = ingest_live.LIVE_ONLY_GAUGES  # godstow, osney, iffley: live level only, no forecast


@dataclass(frozen=True)
class Spot:
    key: str
    name: str
    gauge: str
    threshold: float | None  # None = not verified yet (TBC) -> timing_only
    amber: float
    mode: str = "probability"

    @property
    def effective_mode(self) -> str:
        """timing_only if the threshold is unverified or the gauge is live only (SPEC §4.1.1, §4.2)."""
        if self.threshold is None or self.gauge in LIVE_ONLY_GAUGES:
            return "timing_only"
        return self.mode


# SPEC §4.2 after the re-target (PR #30). Used until config/spots.yaml (Story, #10) exists.
# osney/abingdonrd thresholds are TBC (Story verifies on GOV.UK), so they are timing_only for now.
DEFAULT_SPOTS: tuple[Spot, ...] = (
    Spot("osney", "Osney Island / Binsey", "minns", None, 2.13, "timing_only"),
    Spot("botley", "Botley Road / New Botley / Hinksey", "newbotley", 2.76, 2.01),
    Spot("abingdonrd", "Abingdon Road / Grandpont", "coldharbour", None, 2.30, "timing_only"),
    Spot("wolvercote", "Wolvercote / Port Meadow", "godstow", 3.07, 2.57, "timing_only"),
    Spot("cherwell", "Cherwell (Kings Mill)", "kingsmill", 2.60, 2.40),
)


class LiveDataUnavailable(RuntimeError):
    """No live readings at all: the API answers 503 and the app shows "Live data unavailable"."""


class QuantileForecaster(Protocol):
    """What ``build_forecast`` needs: ``PersistenceForecaster`` or ``TrainedForecaster``."""

    upstreams: Mapping[str, list[str]]

    def predict(
        self, hourly: pd.DataFrame, gauge: str, issued_at: datetime
    ) -> dict[int, dict[str, float]] | None:
        """Quantiles of ``level(t + h) - base`` per lead h, keyed by ``QUANT_KEYS``; None if not possible."""
        ...

    def base_level(self, hourly: pd.DataFrame, gauge: str, issued_at: datetime) -> float | None:
        """The level ``base`` the changes are added to; None means the latest reading."""
        ...


# ---------------------------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------------------------


def iso_utc(ts: datetime | pd.Timestamp) -> str:
    return pd.Timestamp(ts).tz_convert("UTC").strftime("%Y-%m-%dT%H:%M:%SZ")


def last_complete_hour(now: datetime | pd.Timestamp) -> pd.Timestamp:
    """Label of the last hourly row that has ended by ``now`` (UTC): ``floor(now) - 1 h``.

    Pure UTC arithmetic, so the repeated local hour when UK clocks go back (01:00-02:00 GMT/BST on
    the last Sunday of October) is two distinct rows, never one doubled or skipped hour.
    """
    return pd.Timestamp(now).tz_convert("UTC").floor("h") - pd.Timedelta(hours=1)


def _utc(now: datetime | None) -> datetime:
    now = now or datetime.now(UTC)
    if now.tzinfo is None:
        raise ValueError("now must be tz-aware")
    return now.astimezone(UTC)


def _threshold(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):  # missing, null or "TBC"
        return None


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
            threshold=_threshold(s.get("threshold")),
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

    def base_level(self, hourly: pd.DataFrame, gauge: str, issued_at: datetime) -> float | None:
        return None  # the changes are added to the latest reading


# ---------------------------------------------------------------------------------------------
# Trained models (issue #79): the backtest's forecast path, at "now"
# ---------------------------------------------------------------------------------------------


class TrainedForecaster:
    """The saved ``model.train.GaugeModel`` per target gauge, used exactly as in the backtest.

    ``model/backtest.forecasts_at`` builds ``features.build_features(hourly, g, m.medians, m.lags)``,
    reads row t and calls ``m.predict`` (CQR-calibrated). This does the same on the live rows up to the
    anchor hour ``floor(now) - 1 h`` (complete hours only, #93), which must hold a real reading.
    """

    def __init__(self, models: Mapping[str, Any]) -> None:
        from model import features

        self.models = dict(models)
        # Each model's own upstream list (the river walk it was trained with), so a spot depends on
        # exactly the gauges its model reads, even if config/stations.yaml has changed since.
        self.upstreams: dict[str, list[str]] = {
            g: list(getattr(m, "upstreams", None) or features.UPSTREAMS[g]) for g, m in self.models.items()
        }

    def features_at(self, hourly: pd.DataFrame, gauge: str, issued_at: datetime) -> pd.DataFrame | None:
        """The one-row feature frame at the anchor hour, or None (no model, or no fresh level there).

        The anchor is exactly ``last_complete_hour(issued_at)``, as in the backtest (#93). If the target
        gauge has no reading of its own in that hour (missing, or only forward-filled across a gap by
        ``clean.fill_short_gaps``), there is no model forecast: the caller falls back to labelled
        persistence. An older row is never used, so a gauge back from a 3 h outage with one reading
        in the current hour cannot get a model forecast from data hours old.
        """
        from model import features, train

        m = self.models.get(gauge)
        if m is None:
            return None
        h = train.normalise_hourly(hourly)
        # Only complete hourly rows, as the backtest (#93): the row labelled floor(now) - 1 h is the
        # last hour that has ended. The current hour is partial (1-3 of its 4 readings): its mean is
        # not what the model was trained on, and its rain total is NaN with < 3 readings, which made
        # rain_sum_6h NaN about half the time.
        anchor = last_complete_hour(issued_at)
        h = h[h["ts_utc"] <= anchor]
        row = h[(h["gauge"] == gauge) & (h["ts_utc"] == anchor) & h["level_mean"].notna()]
        if "filled" in row:
            row = row[~row["filled"].astype(bool)]
        if row.empty:
            log.info("%s: no own reading in the anchor hour %s; no model forecast", gauge, anchor)
            return None
        X = features.build_features(h, gauge, m.medians, m.lags, self.upstreams[gauge])
        X = X.reindex([anchor])
        if X["level_now"].isna().iloc[0]:
            return None
        n_nan = int(X.isna().sum(axis=1).iloc[0])
        if n_nan:
            log.info(
                "%s at %s: %d of %d features NaN (LightGBM handles NaN)", gauge, anchor, n_nan, X.shape[1]
            )
        return X

    def predict(
        self, hourly: pd.DataFrame, gauge: str, issued_at: datetime
    ) -> dict[int, dict[str, float]] | None:
        X = self.features_at(hourly, gauge, issued_at)
        if X is None:
            return None
        q = self.models[gauge].predict(X)  # {h: (1, 7)}, sorted and CQR-calibrated
        return {h: dict(zip(QUANT_KEYS, map(float, q[h][0]), strict=True)) for h in LEADS_H}

    def base_level(self, hourly: pd.DataFrame, gauge: str, issued_at: datetime) -> float | None:
        X = self.features_at(hourly, gauge, issued_at)
        return None if X is None else float(X["level_now"].iloc[0])

    def missing_inputs(self, hourly: pd.DataFrame, gauge: str, issued_at: datetime) -> list[str]:
        """Inputs with NaN features at the anchor row: gauge keys, plus ``"rain"`` for catchment rain.

        LightGBM runs with NaN features but does not widen its quantiles for them (checked on the real
        models: dropping an upstream's last 30 h narrowed newbotley's 6 h 5-95% range), so the
        forecast says so in its ``note``.
        """
        X = self.features_at(hourly, gauge, issued_at)
        if X is None:
            return []
        out: list[str] = []
        for col in X.columns[X.isna().iloc[0].to_numpy()]:
            ups = [u for u in self.upstreams.get(gauge, []) if col.startswith(f"{u}_")]
            src = ups[0] if ups else "rain" if col.startswith("rain_") else gauge
            if src not in out:
                out.append(src)
        return out


def load_model_forecaster(models_dir: Path = MODELS_DIR) -> TrainedForecaster | None:
    """Every trained target model in ``models_dir/<gauge>/`` (``GaugeModel.load``), or None if none load."""
    if not models_dir.is_dir():
        return None
    try:
        from model import features
        from model.train import GaugeModel
    except Exception as exc:  # e.g. lightgbm can't load (libomp missing on macOS)
        log.warning("model code not importable (%s); using persistence", exc)
        return None
    models = {}
    for d in sorted(models_dir.iterdir()):
        if d.name not in features.UPSTREAMS or not (d / "meta.json").exists():
            continue  # lofo/ (backtest models), stray files
        try:
            models[d.name] = GaugeModel.load(d)
        except Exception as exc:
            log.warning("model %s not loadable (%s); that gauge uses persistence", d, exc)
    if not models:
        log.warning("no trained models in %s; using persistence", models_dir)
        return None
    log.info("loaded trained models for %s", sorted(models))
    return TrainedForecaster(models)


# ---------------------------------------------------------------------------------------------
# Forecast
# ---------------------------------------------------------------------------------------------


def _level_now(hourly: pd.DataFrame, meta: Mapping[str, Any], gauge: str) -> float | None:
    if gauge in meta.get("gauges", {}):
        return float(meta["gauges"][gauge]["level"])
    rows = hourly[hourly["gauge"] == gauge].dropna(subset=["level_mean"])
    return float(rows.sort_values("ts_utc")["level_mean"].iloc[-1]) if not rows.empty else None


def observed_series(
    hourly: pd.DataFrame, now: datetime, window: timedelta = OBSERVED_WINDOW
) -> dict[str, list[dict[str, Any]]]:
    """``Forecast.observed``: hourly ``{t, level}`` per level gauge for ``now - window < t <= now``.

    Gauges in alphabetical order, times ascending. No reading after ``now`` (no future data).
    """
    now_ts = pd.Timestamp(_utc(now))
    levels = hourly[hourly["kind"] == "level"] if "kind" in hourly else hourly
    rows = levels[(levels["ts_utc"] > now_ts - window) & (levels["ts_utc"] <= now_ts)]
    rows = rows.dropna(subset=["level_mean"])
    out: dict[str, list[dict[str, Any]]] = {}
    for gauge, g in sorted(rows.groupby("gauge"), key=lambda kv: kv[0]):
        g = g.sort_values("ts_utc")
        out[gauge] = [
            {"t": iso_utc(t), "level": round(float(v), 3)}
            for t, v in zip(g["ts_utc"], g["level_mean"], strict=True)
        ]
    return out


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
    persistence = PersistenceForecaster()
    forecaster = forecaster or persistence

    data_as_of = {g: v["observed_at"] for g, v in sorted(meta.get("gauges", {}).items())}
    if not data_as_of:
        raise LiveDataUnavailable("no live readings for any gauge")
    depends = {s.key: [s.gauge, *forecaster.upstreams.get(s.gauge, [])] for s in spots}
    forecastable = {s.key: s.gauge not in LIVE_ONLY_GAUGES for s in spots}
    all_gauges = sorted({g for gs in depends.values() for g in gs} | set(data_as_of))
    stale = stale_gauges(data_as_of, all_gauges, now)

    out_spots, fallback_spots = [], []
    gaps: list[str] = []  # data-gap sentences for the note
    stale_up_notes: list[str] = []  # spots on persistence because an upstream input is stale
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
            "mode": spot.effective_mode,
        }
        stale_ups = [g for g in depends[spot.key][1:] if g in stale]
        if forecastable[spot.key] and spot.gauge not in stale:
            deltas, missing = None, []
            if stale_ups:  # a stale upstream input: labelled persistence for this spot only
                log.warning("spot %s: upstream %s stale; using persistence", spot.key, stale_ups)
                stale_up_notes.append(
                    STALE_UPSTREAM_NOTE.format(
                        spot=spot.name, gauges=" and ".join(g.capitalize() for g in stale_ups)
                    )
                )
            else:
                try:
                    deltas = forecaster.predict(hourly, spot.gauge, now)
                    base = forecaster.base_level(hourly, spot.gauge, now)
                    missing = (
                        forecaster.missing_inputs(hourly, spot.gauge, now)
                        if deltas is not None and isinstance(forecaster, TrainedForecaster)
                        else []
                    )
                except Exception:  # one broken model or input must not take live mode down
                    log.exception("spot %s: model forecast failed; using persistence", spot.key)
                    deltas, missing = None, []
            if deltas is None:  # no model for this gauge, no level in the anchor hour, or an error
                deltas = persistence.predict(hourly, spot.gauge, now)
                base = persistence.base_level(hourly, spot.gauge, now)
                if forecaster is not persistence and not stale_ups:
                    fallback_spots.append(spot.key)
            if missing:
                names = ", ".join("catchment rain" if m == "rain" else m.capitalize() for m in missing)
                gaps.append(GAP_NOTE.format(spot=spot.name, inputs=names))
                log.warning("spot %s: forecast with missing inputs from %s", spot.key, names)
            q = np.array([[deltas[h][k] for k in QUANT_KEYS] for h in LEADS_H])
            # SPEC §7.5 via the shared functions, exactly as the backtest (monotone p, arrival rules).
            sf = probability.spot_forecast(
                {
                    "key": spot.key,
                    "threshold": spot.threshold,
                    "amber": spot.amber,
                    "mode": spot.effective_mode,
                },
                level_now if base is None else base,
                q,
                pd.Timestamp(now),
                LEADS_H,
            )
            entry["leads"], entry["arrival"] = sf["leads"], sf["arrival"]
        out_spots.append(entry)

    if method == "persistence":
        note = PERSISTENCE_NOTE
    elif fallback_spots:
        note = PARTIAL_PERSISTENCE_NOTE.format(spots=", ".join(fallback_spots))
    else:
        note = ""
    note = " ".join(part for part in [note, *stale_up_notes, *gaps] if part)
    return {
        "issuedAt": iso_utc(now),
        "dataAsOf": data_as_of,
        "stale": stale,
        "spots": out_spots,
        "observed": observed_series(hourly, now),
        "method": method,
        "note": note,
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
    forecaster = load_model_forecaster(MODELS_DIR)
    return build_forecast(hourly, meta, now, forecaster=forecaster, spots=load_spots())


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    parser = argparse.ArgumentParser(description="Forecast for now from live readings (SPEC §10.1).")
    parser.add_argument(
        "--write-web", action="store_true", help=f"also write {WEB_LIVE} (committed demo data)"
    )
    parser.add_argument("--no-fetch", action="store_true", help="use the last processed live data only")
    args = parser.parse_args()
    try:
        forecast = refresh(fetch=not args.no_fetch)
    except LiveDataUnavailable as exc:
        # No live data at all (EA down and nothing cached): keep the existing files, the app shows
        # "Live data unavailable" or the committed snapshot. Exit non-zero, without a traceback.
        log.error("live data unavailable (%s); nothing written", exc)
        raise SystemExit(1) from None
    targets = [OUT_FORECAST, *([WEB_LIVE] if args.write_web else [])]
    text = json.dumps(forecast, indent=2, allow_nan=False) + "\n"  # strict JSON: NaN fails here
    for path in targets:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f"{path.name}.{os.getpid()}.part")
        tmp.write_text(text)
        ingest_live.replace_retry(tmp, path)  # never a half-written live.json for the dev server or API
        log.info("wrote %s (%s, stale: %s)", path, forecast["method"], forecast["stale"] or "none")


if __name__ == "__main__":
    main()
