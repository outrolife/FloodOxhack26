"""Train one LightGBM quantile model per (gauge, lead, alpha) (SPEC §7.3), calibrate (§7.4), and fit the
probabilistic-persistence baseline (§7.6).

Issue #8.

Pipeline
--------
``python -m model.train [--targets newbotley ...]`` reads ``$RC_DATA_DIR/processed/hourly.parquet`` and
``lags.json``, trains every lead and alpha, calibrates on validation events, and writes:

- ``$RC_DATA_DIR/models/<gauge>/meta.json`` plus one LightGBM text model per (h, alpha), and
- ``web/public/data/importance.json`` (SPEC §9 ``Importance``).

Library API (used by ``model/backtest.py`` and ``model/forecast_live.py``)
---------------------------------------------------------------------
- ``load_hourly(path=None)`` / ``normalise_hourly(df)``: the hourly frame in the shape
  ``model.features`` expects (adds the ``rain_catchment`` series if the file only has rain gauges).
- ``load_lags(path=None)``: lags.json in either the agreed ``{"pairs": [...]}`` shape (#7) or the
  ``{"up->down": {...}}`` shape, returned as the latter (what ``model.features`` reads).
- ``build_xy(hourly, target, medians, lags)``: the narrow adapter onto ``model.features``.
- ``train_gauge(hourly, target, ...) -> GaugeModel``: features, split, fit, calibrate, persistence.
- ``fit_gauge(X, Y, ...) -> GaugeModel``: the same on a ready feature/target frame (used by tests).
- ``GaugeModel.predict(X) -> {h: (n, 7) array}`` of sorted, calibrated level-change quantiles on the
  ``probability.ALPHAS`` grid; ``GaugeModel.persistence(n) -> {h: (n, 7)}``; ``save`` / ``load``.
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import os
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import lightgbm as lgb
import numpy as np
import pandas as pd

from model.calibrate import apply_cqr, calibration_rows, event_mask, fit_cqr
from model.probability import ALPHAS, HORIZONS_H, QUANT_KEYS, sort_quantiles

log = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("RC_DATA_DIR", ROOT / "data"))
MODELS_DIR = DATA_DIR / "models"
HOURLY_PATH = DATA_DIR / "processed" / "hourly.parquet"
LAGS_PATH = DATA_DIR / "processed" / "lags.json"
WEB_DATA = ROOT / "web" / "public" / "data"
RAIN_KEY = "rain_catchment"

# SPEC §7.3, exactly. n_estimators -> num_boost_round, early_stopping_rounds -> callback.
LGB_PARAMS: dict[str, Any] = {
    "objective": "quantile",
    "num_leaves": 31,
    "learning_rate": 0.05,
    "min_data_in_leaf": 50,
    "feature_fraction": 0.8,
    "bagging_fraction": 0.8,
    "bagging_freq": 1,
    "seed": 42,
    "verbose": -1,
}
N_ESTIMATORS = 2000
EARLY_STOPPING_ROUNDS = 100

HIGH_WEIGHT = 5.0  # sample weight where level_now > amber - WEIGHT_MARGIN_M
WEIGHT_MARGIN_M = 0.3

# Fallback gauge lines for the trained targets (SPEC §4.1, §4.1.1), used only if config/stations.yaml
# is missing or unreadable. osney, godstow and iffley are live only: no history, not trained.
GAUGE_LINES: dict[str, dict[str, float]] = {
    "newbotley": {"amber": 2.01, "threshold": 2.76},
    "kingsmill": {"amber": 2.40, "threshold": 2.60},
    "minns": {"amber": 2.13, "threshold": 2.90},
    "coldharbour": {"amber": 2.30, "threshold": 2.44},
}
DEFAULT_TARGETS: tuple[str, ...] = ("newbotley",)


# ---------------------------------------------------------------------------------------------
# Config and inputs
# ---------------------------------------------------------------------------------------------


def gauge_lines(gauge: str) -> dict[str, float]:
    """``{"amber", "threshold"}`` for a target gauge: config/stations.yaml if usable, else SPEC values."""
    path = ROOT / "config" / "stations.yaml"
    if path.exists():
        try:
            import yaml

            raw = yaml.safe_load(path.read_text(encoding="utf-8"))
            items = raw.get("gauges", raw) if isinstance(raw, dict) else raw
            if isinstance(items, dict):
                items = [{"key": k, **v} for k, v in items.items() if isinstance(v, dict)]
            for st in items or []:
                if isinstance(st, dict) and st.get("key") == gauge and st.get("amber") is not None:
                    thr = st.get("threshold", GAUGE_LINES.get(gauge, {}).get("threshold"))
                    return {
                        "amber": float(st["amber"]),
                        "threshold": float(thr) if thr is not None else math.nan,
                    }
        except Exception as exc:  # config is owned elsewhere; never fail training on it
            log.warning("could not read %s (%s); using SPEC thresholds", path, exc)
    return dict(GAUGE_LINES[gauge])


def normalise_hourly(df: pd.DataFrame) -> pd.DataFrame:
    """Hourly frame as ``model.features`` expects it.

    Accepts the #3 long format with or without a ``kind`` column. If there is no ``rain_catchment``
    gauge, it is added as the per-hour mean of the available rain gauges (rows with ``kind == "rain"``,
    or with ``rain_mm`` set and ``level_mean`` NaN).
    """
    out = df.copy()
    ts = pd.to_datetime(out["ts_utc"])
    out["ts_utc"] = ts.dt.tz_localize("UTC") if ts.dt.tz is None else ts.dt.tz_convert("UTC")
    for col in ("level_mean", "level_max", "rain_mm"):
        if col not in out.columns:
            out[col] = np.nan
    if (out["gauge"] == RAIN_KEY).any():
        return out
    if "kind" in out.columns:
        is_rain = out["kind"] == "rain"
    else:
        is_rain = out["rain_mm"].notna() & out["level_mean"].isna()
    rain = out[is_rain]
    if rain.empty:
        log.warning("no rain gauges in hourly data; rain features will be NaN")
        return out[~is_rain]
    log.info("catchment rain = mean of %s", sorted(rain["gauge"].unique()))
    catch = rain.groupby("ts_utc", as_index=False)["rain_mm"].mean()
    catch["gauge"] = RAIN_KEY
    catch["level_mean"] = np.nan
    catch["level_max"] = np.nan
    if "kind" in out.columns:
        catch["kind"] = "rain"
    return pd.concat([out[~is_rain], catch], ignore_index=True)


def load_hourly(path: Path | str | None = None) -> pd.DataFrame:
    return normalise_hourly(pd.read_parquet(path or HOURLY_PATH))


def load_lags(path: Path | str | None = None) -> dict[str, dict[str, int]]:
    """lags.json as ``{"up->down": {"lag_lo", "lag_main", "lag_hi"}}``; ``{}`` if missing (logged)."""
    path = Path(path or LAGS_PATH)
    if not path.exists():
        log.warning("%s not found; features use their fallback lags", path)
        return {}
    raw = json.loads(path.read_text(encoding="utf-8"))
    keys = ("lag_lo", "lag_main", "lag_hi")
    if isinstance(raw, dict) and "pairs" in raw:
        return {f"{p['up']}->{p['down']}": {k: int(round(p[k])) for k in keys} for p in raw["pairs"]}
    return {pair: {k: int(round(v[k])) for k in keys} for pair, v in raw.items()}


def build_xy(
    hourly: pd.DataFrame,
    target: str,
    medians: Mapping[str, float],
    lags: Mapping[str, Mapping[str, int]] | None,
    horizons: Sequence[int] = HORIZONS_H,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Adapter onto ``model.features`` (#6): features X and targets Y (``y_{h}h``) on one hourly index."""
    from model import features

    X = features.build_features(hourly, target, medians, lags)
    Y = features.build_targets(hourly, target, horizons).reindex(X.index)
    return X, Y


def fit_medians(hourly: pd.DataFrame, target: str, cutoff: pd.Timestamp) -> dict[str, float]:
    """Upstream gauges' long-term medians from data before ``cutoff`` only (no leakage)."""
    from model import features

    return features.compute_gauge_medians(
        hourly, cutoff - pd.Timedelta(hours=1), gauges=features.UPSTREAMS[target]
    )


# ---------------------------------------------------------------------------------------------
# Splits, weights, baseline
# ---------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Splits:
    """Train = [start, val_start), validation = [val_start, test_start), test = [test_start, end)."""

    val_start: pd.Timestamp
    test_start: pd.Timestamp

    def masks(self, index: pd.DatetimeIndex, h: int = 0) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Row masks. A row joins a split only if its target time t + h is in the same split."""
        t_end = index + pd.Timedelta(hours=h)
        train = t_end < self.val_start
        val = (index >= self.val_start) & (t_end < self.test_start)
        test = index >= self.test_start
        return np.asarray(train), np.asarray(val), np.asarray(test)

    def to_json(self) -> dict[str, str]:
        return {"valStart": _iso(self.val_start), "testStart": _iso(self.test_start)}


DEFAULT_SPLITS = Splits(pd.Timestamp("2018-10-01", tz="UTC"), pd.Timestamp("2021-10-01", tz="UTC"))


def choose_splits(first: pd.Timestamp, last: pd.Timestamp) -> Splits:
    """SPEC §7.3 splits; if history starts after 2007, ~60/20/20 by winter seasons (Oct-Sep years)."""
    if first <= pd.Timestamp("2007-12-31 23:00", tz="UTC"):
        return DEFAULT_SPLITS
    y0 = first.year if first.month < 10 else first.year + 1  # first full season starts Oct y0-1 or y0
    y1 = last.year if last.month >= 10 else last.year - 1  # last season starts Oct y1
    starts = list(range(y0 - (1 if first.month < 10 else 0), y1 + 1))
    n = len(starts)
    if n < 3:
        raise ValueError(f"need >= 3 winter seasons of history for splits, have {n}")
    n_train = max(1, round(0.6 * n))
    n_val = max(1, round(0.2 * n))
    if n_train + n_val >= n:
        n_train = n - 2
        n_val = 1
    val_start = pd.Timestamp(f"{starts[n_train]}-10-01", tz="UTC")
    test_start = pd.Timestamp(f"{starts[n_train + n_val]}-10-01", tz="UTC")
    log.info("history starts %s: shifted splits val >= %s, test >= %s", first, val_start, test_start)
    return Splits(val_start, test_start)


def sample_weights(level_now: np.ndarray | pd.Series, amber: float) -> np.ndarray:
    """5 where ``level_now > amber − 0.3 m``, else 1 (SPEC §7.3)."""
    lv = np.asarray(level_now, dtype=float)
    return np.where(lv > amber - WEIGHT_MARGIN_M, HIGH_WEIGHT, 1.0)


def weighted_quantiles(
    values: np.ndarray, weights: np.ndarray, alphas: Sequence[float] = ALPHAS
) -> np.ndarray:
    """Weighted empirical quantiles (midpoint rule). NaN values are dropped."""
    v = np.asarray(values, dtype=float)
    w = np.asarray(weights, dtype=float)
    ok = np.isfinite(v) & (w > 0)
    v, w = v[ok], w[ok]
    if len(v) == 0:
        return np.full(len(alphas), np.nan)
    order = np.argsort(v)
    v, w = v[order], w[order]
    cw = (np.cumsum(w) - 0.5 * w) / w.sum()
    return np.interp(alphas, cw, v)


def pinball(q: np.ndarray, y: np.ndarray, alphas: Sequence[float] = ALPHAS) -> float:
    """Mean pinball loss over alphas and rows (rows with NaN dropped)."""
    q = np.asarray(q, dtype=float)
    y = np.asarray(y, dtype=float)
    ok = np.isfinite(y) & np.isfinite(q).all(axis=1)
    d = y[ok, None] - q[ok]
    a = np.asarray(alphas)[None, :]
    return float(np.mean(np.maximum(a * d, (a - 1) * d))) if ok.any() else math.nan


# ---------------------------------------------------------------------------------------------
# Model container
# ---------------------------------------------------------------------------------------------


def _iso(ts: pd.Timestamp) -> str:
    return pd.Timestamp(ts).tz_convert("UTC").strftime("%Y-%m-%dT%H:%M:%SZ")


@dataclass
class GaugeModel:
    target: str
    amber: float
    threshold: float
    feature_cols: list[str]
    medians: dict[str, float]
    lags: dict[str, dict[str, int]]
    splits: Splits
    boosters: dict[int, dict[float, lgb.Booster]] = field(default_factory=dict)
    cqr: dict[int, dict[str, float]] = field(default_factory=dict)
    persistence_eps: dict[int, list[float]] = field(default_factory=dict)
    excluded: list[tuple[str, str]] = field(default_factory=list)
    info: dict[str, Any] = field(default_factory=dict)

    @property
    def horizons(self) -> list[int]:
        return sorted(self.boosters)

    def predict_raw(self, X: pd.DataFrame) -> dict[int, np.ndarray]:
        """Sorted, uncalibrated level-change quantiles ``{h: (n, 7)}``."""
        return {h: _predict_one(by_alpha, X, self.feature_cols) for h, by_alpha in self.boosters.items()}

    def predict(self, X: pd.DataFrame, calibrated: bool = True) -> dict[int, np.ndarray]:
        """Sorted (and CQR-calibrated) level-change quantiles ``{h: (n, 7)}`` on the ALPHAS grid."""
        raw = self.predict_raw(X)
        if not calibrated:
            return raw
        return {h: apply_cqr(q, self.cqr.get(h, {})) for h, q in raw.items()}

    def persistence(self, n: int) -> dict[int, np.ndarray]:
        """Probabilistic-persistence level-change quantiles ``{h: (n, 7)}`` (SPEC §7.6)."""
        return {h: np.tile(np.asarray(eps, dtype=float), (n, 1)) for h, eps in self.persistence_eps.items()}

    def importance(self) -> list[dict[str, Any]]:
        """Per lead: features by mean gain over the alpha models, normalised to sum to 1."""
        out = []
        for h in self.horizons:
            gains = np.mean([b.feature_importance("gain") for b in self.boosters[h].values()], axis=0)
            total = gains.sum() or 1.0
            feats = sorted(zip(self.feature_cols, gains / total, strict=True), key=lambda x: -x[1])
            out.append({"h": h, "features": [{"name": n, "gain": round(float(g), 5)} for n, g in feats]})
        return out

    def save(self, directory: Path | str) -> Path:
        d = Path(directory)
        d.mkdir(parents=True, exist_ok=True)
        for h, by_alpha in self.boosters.items():
            for a, booster in by_alpha.items():
                booster.save_model(str(d / f"h{h}_q{QUANT_KEYS[ALPHAS.index(a)]}.txt"))
        meta = {
            "target": self.target,
            "amber": self.amber,
            "threshold": self.threshold,
            "featureCols": self.feature_cols,
            "medians": self.medians,
            "lags": self.lags,
            "splits": self.splits.to_json(),
            "horizons": self.horizons,
            "cqr": {str(h): v for h, v in self.cqr.items()},
            "persistenceEps": {str(h): v for h, v in self.persistence_eps.items()},
            "excluded": self.excluded,
            "info": self.info,
        }
        (d / "meta.json").write_text(json.dumps(meta, indent=1, allow_nan=True), encoding="utf-8")
        return d

    @classmethod
    def load(cls, directory: Path | str) -> GaugeModel:
        d = Path(directory)
        meta = json.loads((d / "meta.json").read_text(encoding="utf-8"))
        boosters = {
            int(h): {
                a: lgb.Booster(model_file=str(d / f"h{h}_q{k}.txt"))
                for a, k in zip(ALPHAS, QUANT_KEYS, strict=True)
            }
            for h in meta["horizons"]
        }
        sp = meta["splits"]
        return cls(
            target=meta["target"],
            amber=meta["amber"],
            threshold=meta["threshold"],
            feature_cols=meta["featureCols"],
            medians=meta["medians"],
            lags=meta["lags"],
            splits=Splits(pd.Timestamp(sp["valStart"]), pd.Timestamp(sp["testStart"])),
            boosters=boosters,
            cqr={int(h): v for h, v in meta["cqr"].items()},
            persistence_eps={int(h): v for h, v in meta["persistenceEps"].items()},
            excluded=[tuple(x) for x in meta.get("excluded", [])],
            info=meta.get("info", {}),
        )


# ---------------------------------------------------------------------------------------------
# Fitting
# ---------------------------------------------------------------------------------------------


def fit_quantile_boosters(
    X_tr: pd.DataFrame,
    y_tr: np.ndarray,
    w_tr: np.ndarray,
    X_va: pd.DataFrame,
    y_va: np.ndarray,
    w_va: np.ndarray,
    params: Mapping[str, Any] | None = None,
    n_estimators: int = N_ESTIMATORS,
    early_stopping_rounds: int = EARLY_STOPPING_ROUNDS,
) -> dict[float, lgb.Booster]:
    """One LightGBM quantile booster per alpha, early-stopped on the (weighted) validation rows."""
    base = {**LGB_PARAMS, **(params or {})}
    dtrain = lgb.Dataset(X_tr, y_tr, weight=w_tr, free_raw_data=False)
    dval = lgb.Dataset(X_va, y_va, weight=w_va, reference=dtrain, free_raw_data=False)
    out = {}
    for a in ALPHAS:
        booster = lgb.train(
            {**base, "alpha": a},
            dtrain,
            num_boost_round=n_estimators,
            valid_sets=[dval],
            callbacks=[lgb.early_stopping(early_stopping_rounds, verbose=False)],
        )
        out[a] = booster
    return out


def fit_gauge(
    X: pd.DataFrame,
    Y: pd.DataFrame,
    *,
    target: str,
    amber: float,
    threshold: float,
    splits: Splits,
    medians: Mapping[str, float] | None = None,
    lags: Mapping[str, Mapping[str, int]] | None = None,
    events: pd.Series | None = None,
    exclude: np.ndarray | pd.Series | None = None,
    excluded: Iterable[tuple[str, str]] = (),
    horizons: Sequence[int] = HORIZONS_H,
    params: Mapping[str, Any] | None = None,
    n_estimators: int = N_ESTIMATORS,
    early_stopping_rounds: int = EARLY_STOPPING_ROUNDS,
) -> GaugeModel:
    """Fit all leads and alphas on a ready frame, calibrate on validation events, fit persistence.

    ``X`` must contain ``level_now``; ``Y`` has columns ``y_{h}h``. ``events`` is a bool series on
    ``X.index`` marking event windows (default: from ``level_now`` with the SPEC §6.1 rule).
    ``exclude`` marks rows dropped from training and calibration (leave-one-flood-out).
    """
    idx = X.index
    level_now = X["level_now"].to_numpy(dtype=float)
    weights = sample_weights(level_now, amber)
    ev = (events if events is not None else event_mask(X["level_now"], amber)).reindex(idx, fill_value=False)
    keep = np.ones(len(idx), dtype=bool) if exclude is None else ~np.asarray(exclude, dtype=bool)
    model = GaugeModel(
        target=target,
        amber=amber,
        threshold=threshold,
        feature_cols=list(X.columns),
        medians=dict(medians or {}),
        lags={k: dict(v) for k, v in (lags or {}).items()},
        splits=splits,
        excluded=list(excluded),
    )
    stats: dict[str, Any] = {}
    for h in horizons:
        y = Y[f"y_{h}h"].to_numpy(dtype=float)
        tr, va, _ = splits.masks(idx, h)
        ok = keep & np.isfinite(y) & np.isfinite(level_now)
        tr, va = tr & ok, va & ok
        if tr.sum() == 0 or va.sum() == 0:
            raise ValueError(f"{target} h={h}: empty train ({tr.sum()}) or validation ({va.sum()}) split")
        log.info("%s h=%d: %d train rows, %d validation rows", target, h, tr.sum(), va.sum())
        boosters = fit_quantile_boosters(
            X[tr],
            y[tr],
            weights[tr],
            X[va],
            y[va],
            weights[va],
            params=params,
            n_estimators=n_estimators,
            early_stopping_rounds=early_stopping_rounds,
        )
        model.boosters[h] = boosters
        model.persistence_eps[h] = [float(v) for v in weighted_quantiles(y[tr], weights[tr])]
        # Calibration on validation rows inside events (CQR, SPEC §7.4).
        cal = calibration_rows(pd.Series(va, index=idx), ev & pd.Series(keep, index=idx)).to_numpy()
        q_val = _predict_one(boosters, X[cal], model.feature_cols)
        model.cqr[h] = fit_cqr(q_val, y[cal])
        stats[str(h)] = {
            "nTrain": int(tr.sum()),
            "nVal": int(va.sum()),
            "nCal": int(cal.sum()),
            "bestIteration": {QUANT_KEYS[i]: int(boosters[a].best_iteration) for i, a in enumerate(ALPHAS)},
        }
    model.info = {"trainedAt": _iso(pd.Timestamp.now(tz="UTC")), "leads": stats}
    return model


def _predict_one(by_alpha: Mapping[float, lgb.Booster], X: pd.DataFrame, cols: Sequence[str]) -> np.ndarray:
    Xf = X[list(cols)]
    q = np.column_stack(
        [by_alpha[a].predict(Xf, num_iteration=by_alpha[a].best_iteration or None) for a in ALPHAS]
    )
    return sort_quantiles(q)


def windows_mask(index: pd.DatetimeIndex, windows: Iterable[tuple[pd.Timestamp, pd.Timestamp]]) -> np.ndarray:
    m = np.zeros(len(index), dtype=bool)
    for start, end in windows:
        m |= np.asarray((index >= start) & (index <= end))
    return m


def train_gauge(
    hourly: pd.DataFrame,
    target: str,
    *,
    lags: Mapping[str, Mapping[str, int]] | None = None,
    exclude_windows: Sequence[tuple[pd.Timestamp, pd.Timestamp]] = (),
    splits: Splits | None = None,
    **fit_kwargs: Any,
) -> GaugeModel:
    """Build features from ``hourly`` (normalised) and fit everything for one target gauge.

    ``exclude_windows`` are dropped from training and calibration (leave-one-flood-out passes the
    event window ± 7 days). Medians come from the training split only.
    """
    lines = gauge_lines(target)
    lv = hourly[hourly["gauge"] == target]
    if lv.empty:
        raise ValueError(f"no rows for target gauge {target!r}")
    ts = lv.loc[lv["level_mean"].notna(), "ts_utc"]
    splits = splits or choose_splits(ts.min(), ts.max())
    medians = fit_medians(hourly, target, splits.val_start)
    X, Y = build_xy(hourly, target, medians, lags, fit_kwargs.get("horizons", HORIZONS_H))
    lmax = lv.set_index("ts_utc")["level_max"].reindex(X.index)
    events = event_mask(lmax.fillna(X["level_now"]), lines["amber"])
    excl = windows_mask(X.index, exclude_windows)
    return fit_gauge(
        X,
        Y,
        target=target,
        amber=lines["amber"],
        threshold=lines["threshold"],
        splits=splits,
        medians=medians,
        lags=lags,
        events=events,
        exclude=excl,
        excluded=[(_iso(a), _iso(b)) for a, b in exclude_windows],
        **fit_kwargs,
    )


def recalibrate_saved(models_dir: Path | None = None) -> None:
    """Recompute CQR offsets for every saved gauge model from the current hourly data."""
    models_dir = models_dir or MODELS_DIR
    hourly = load_hourly()
    for d in sorted(p for p in models_dir.iterdir() if (p / "meta.json").exists()):
        m = GaugeModel.load(d)
        X, Y = build_xy(hourly, m.target, m.medians, m.lags, m.horizons)
        lv = hourly[hourly["gauge"] == m.target].set_index("ts_utc")["level_max"].reindex(X.index)
        ev = event_mask(lv.fillna(X["level_now"]), m.amber)
        raw = m.predict_raw(X)
        for h in m.horizons:
            y = Y[f"y_{h}h"].to_numpy(dtype=float)
            _, va, _ = m.splits.masks(X.index, h)
            cal = calibration_rows(pd.Series(va & np.isfinite(y), index=X.index), ev).to_numpy()
            m.cqr[h] = fit_cqr(raw[h][cal], y[cal])
        m.save(d)
        log.info("recalibrated %s: %s", m.target, m.cqr)


def write_importance(models: Iterable[GaugeModel], path: Path | None = None) -> Path:
    """Merge these gauges into ``importance.json`` (SPEC §9), keeping other gauges already there."""
    path = path or WEB_DATA / "importance.json"
    data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    for m in models:
        data[m.target] = m.importance()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=1), encoding="utf-8")
    return path


def main(argv: Sequence[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--targets", nargs="+", default=list(DEFAULT_TARGETS))
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    hourly = load_hourly()
    lags = load_lags()
    models = []
    for target in args.targets:
        m = train_gauge(hourly, target, lags=lags)
        m.save(MODELS_DIR / target)
        log.info("saved %s to %s; cqr=%s", target, MODELS_DIR / target, m.cqr)
        models.append(m)
    log.info("wrote %s", write_importance(models))


if __name__ == "__main__":
    main()
