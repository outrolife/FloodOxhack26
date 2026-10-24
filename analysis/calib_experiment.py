"""Regime-conditional ("Mondrian") CQR: an experiment, not part of the shipped model (issue #125 C).

Question: the 50/80/90 % intervals over-cover on the test period overall (90 % -> 0.94-0.97) but are
about right inside floods. SPEC §7.4 fits **one** additive CQR offset Q per (gauge, h, interval) on
validation rows inside events, then applies it to every row, so calm-period intervals are too wide.
Does a separate Q per (gauge, h, interval, **regime**) fix calm periods without losing coverage in
floods, and without moving the event outcomes? **No retraining**: the shipped boosters are reused,
only the calibration step changes.

Regimes (known at t: computed from the feature row X[t] only, which ``model.features`` builds from
rows labelled <= t)
-----------------------------------------------------------------------------------------------
- ``high``: ``level_now > amber - 0.3 m`` (the high-water rule of the sample weights, SPEC §7.3).
- ``rising`` (3-regime variants only): not high, and some upstream gauge rose by >= ``RISE_M`` over the
  last 24 h (``{up}_change_24h``, a within-gauge difference, so no cross-gauge stage comparison), or
  the catchment had >= ``WET_MM`` of rain over the last 72 h (``rain_sum_72h``).
- ``calm``: everything else.

Calibration variants (every Q is fitted on **validation rows only**: issue time and target time in
[2018-10-01, 2021-10-01), the rows ``model.train.fit_gauge`` calibrates on)
----------------------------------------------------------------------------------------------
- ``current``: the shipped Q (SPEC §7.4, validation rows inside events). Recomputed here and checked
  against meta.json.
- ``pooled_all``: one Q from all validation rows (reference).
- ``m2``: Mondrian, 2 regimes (calm+rising / high), each fitted on all validation rows of its regime.
- ``m3``: Mondrian, 3 regimes (calm / rising / high).
- ``m2h``, ``m3h`` (hybrid): the calm regime gets its own Q (all validation calm rows); every other
  regime keeps the shipped in-event Q, so high-water and rising rows are unchanged.
- ``m2e``, ``m3e`` (Mondrian on the SPEC §7.4 rows): a Q per regime, each fitted on the validation rows
  **inside events** of that regime (the shipped calibration rows, split by regime).

A regime with fewer than ``MIN_REGIME_ROWS`` calibration rows falls back to the variant's pooled Q
(``pooled_all`` for m2/m3, ``current`` for the others); ``--min-rows`` changes it (sensitivity).

Scoring reuses the #125 B harness (``analysis.feature_experiment.evaluate_arms``, alfredo-feats) with
one wrapper per variant, so every arm is scored on the same strict test rows (issue times >=
2021-10-01) with the same definitions as proof.json.

Usage
-----
``python -m analysis.calib_experiment cache``  (raw predictions of the shipped models, 1 LightGBM
thread, cached in data/models/exp125/calib/; resumable)
``python -m analysis.calib_experiment evaluate`` (writes data/processed/exp125_calib.json and prints
the tables)
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from model.calibrate import INTERVALS, apply_cqr, calibration_rows, event_mask, fit_cqr
from model.probability import ALPHAS, sort_quantiles
from model.train import DATA_DIR, MODELS_DIR, WEIGHT_MARGIN_M, GaugeModel

log = logging.getLogger(__name__)

TARGETS: tuple[str, ...] = ("newbotley", "kingsmill", "minns", "coldharbour")
CACHE_DIR = MODELS_DIR / "exp125" / "calib"
OUT_PATH = DATA_DIR / "processed" / "exp125_calib.json"
SHIPPED_DIR = MODELS_DIR

MIN_REGIME_ROWS = 200
RISE_M = 0.05  # upstream rise over 24 h that marks a "rising" row
WET_MM = 10.0  # catchment rain over 72 h that marks a "rising" row
CALM, RISING, HIGH = 0, 1, 2
REGIME_NAMES = {CALM: "calm", RISING: "rising", HIGH: "high"}

VARIANTS: tuple[str, ...] = ("current", "pooled_all", "m2", "m3", "m2h", "m3h", "m2e", "m3e")
VARIANT_SCHEME = {"current": 1, "pooled_all": 1, "m2": 2, "m3": 3, "m2h": 2, "m3h": 3, "m2e": 2, "m3e": 3}


# ---------------------------------------------------------------------------------------------
# Regimes (row t only)
# ---------------------------------------------------------------------------------------------


def regimes(X: pd.DataFrame, amber: float, scheme: int) -> np.ndarray:
    """Regime label per row of the feature frame ``X``, from that row's own columns only.

    ``scheme`` 1: all calm (one pooled Q); 2: calm / high; 3: calm / rising / high. Rows with NaN
    ``level_now`` are calm (they are never forecast). The labels depend only on X[t], so they use no
    data after t (``model.features`` builds X[t] from rows labelled <= t).
    """
    lv = X["level_now"].to_numpy(dtype=float)
    with np.errstate(invalid="ignore"):
        high = lv > amber - WEIGHT_MARGIN_M
    out = np.full(len(X), CALM, dtype=int)
    if scheme == 1:
        return out
    if scheme == 3:
        out[rising(X)] = RISING
    out[high] = HIGH
    return out


def rising(X: pd.DataFrame) -> np.ndarray:
    """Some upstream gauge rose >= RISE_M over 24 h, or >= WET_MM of catchment rain in 72 h."""
    up = [c for c in X.columns if c.endswith("_change_24h") and not c.startswith("level_")]
    with np.errstate(invalid="ignore"):
        r = np.zeros(len(X), dtype=bool)
        if up:
            r |= np.nan_to_num(X[up].to_numpy(dtype=float), nan=-np.inf).max(axis=1) >= RISE_M
        if "rain_sum_72h" in X.columns:
            r |= np.nan_to_num(X["rain_sum_72h"].to_numpy(dtype=float), nan=0.0) >= WET_MM
    return r


# ---------------------------------------------------------------------------------------------
# Raw prediction cache (shipped boosters, one thread)
# ---------------------------------------------------------------------------------------------


def row_hashes(X: pd.DataFrame, cols: Sequence[str]) -> np.ndarray:
    """One uint64 per row from its timestamp and feature values (identifies the exact input)."""
    return pd.util.hash_pandas_object(X[list(cols)], index=True).to_numpy(dtype=np.uint64)


def predict_raw_1t(m: GaugeModel, X: pd.DataFrame) -> dict[int, np.ndarray]:
    """``GaugeModel.predict_raw`` with one LightGBM thread (the CPU is shared)."""
    Xf = X[m.feature_cols]
    out = {}
    for h, by_alpha in m.boosters.items():
        q = np.column_stack(
            [
                by_alpha[a].predict(Xf, num_iteration=by_alpha[a].best_iteration or None, num_threads=1)
                for a in ALPHAS
            ]
        )
        out[h] = sort_quantiles(q)
    return out


class RawCache:
    """Raw (uncalibrated, sorted) quantiles per exact feature row, persisted per gauge."""

    def __init__(self, m: GaugeModel, path: Path):
        self.m = m
        self.path = path
        self.hashes = np.zeros(0, dtype=np.uint64)
        self.q: dict[int, np.ndarray] = {h: np.zeros((0, len(ALPHAS))) for h in m.horizons}
        if path.exists():
            z = np.load(path)
            self.hashes = z["hashes"]
            self.q = {h: z[f"q{h}"] for h in m.horizons}
        self._pos = {int(k): i for i, k in enumerate(self.hashes)}

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp.npz")
        np.savez(tmp, hashes=self.hashes, **{f"q{h}": v for h, v in self.q.items()})
        tmp.replace(self.path)

    def predict_raw(self, X: pd.DataFrame, chunk: int = 20000) -> dict[int, np.ndarray]:
        hs = row_hashes(X, self.m.feature_cols)
        miss = np.array([int(k) not in self._pos for k in hs], dtype=bool)
        if miss.any():
            todo = np.flatnonzero(miss)
            # duplicate rows (same hash) only need one prediction
            _, first = np.unique(hs[todo], return_index=True)
            todo = todo[np.sort(first)]
            for s in range(0, len(todo), chunk):
                sel = todo[s : s + chunk]
                t0 = time.time()
                new = predict_raw_1t(self.m, X.iloc[sel])
                base = len(self.hashes)
                self.hashes = np.concatenate([self.hashes, hs[sel]])
                for h in self.q:
                    self.q[h] = np.concatenate([self.q[h], new[h]])
                for j, k in enumerate(hs[sel]):
                    self._pos[int(k)] = base + j
                self.save()
                log.info(
                    "%s: predicted %d rows in %.0f s (cache %d)",
                    self.m.target,
                    len(sel),
                    time.time() - t0,
                    len(self.hashes),
                )
        pos = np.array([self._pos[int(k)] for k in hs], dtype=int)
        return {h: v[pos] for h, v in self.q.items()}


# ---------------------------------------------------------------------------------------------
# Fitting Q (validation rows only)
# ---------------------------------------------------------------------------------------------


def val_rows(
    m: GaugeModel, index: pd.DatetimeIndex, h: int, y: np.ndarray, level_now: np.ndarray
) -> np.ndarray:
    """The validation rows ``model.train.fit_gauge`` calibrates on at lead h (t and t + h in validation)."""
    _, va, _ = m.splits.masks(index, h)
    return va & np.isfinite(y) & np.isfinite(level_now)


def fit_regime_q(
    q_raw: np.ndarray,
    y: np.ndarray,
    reg: np.ndarray,
    val: np.ndarray,
    fallback: Mapping[str, float],
    min_rows: int = MIN_REGIME_ROWS,
    keep_fallback: Sequence[int] = (),
) -> tuple[dict[int, dict[str, float]], dict[int, int]]:
    """Q per regime from validation rows (``val``) of that regime; ``fallback`` if fewer than min_rows.

    Regimes in ``keep_fallback`` always take ``fallback`` (the hybrids keep the shipped Q there).
    Returns ``({regime: {interval: Q}}, {regime: n_validation_rows})``.
    """
    qs: dict[int, dict[str, float]] = {}
    ns: dict[int, int] = {}
    for r in (CALM, RISING, HIGH):
        rows = val & (reg == r)
        ns[r] = int(rows.sum())
        if r in keep_fallback or ns[r] < min_rows:
            qs[r] = dict(fallback)
        else:
            qs[r] = fit_cqr(q_raw[rows], y[rows])
    return qs, ns


def apply_regime_q(q_raw: np.ndarray, reg: np.ndarray, qs: Mapping[int, Mapping[str, float]]) -> np.ndarray:
    """``apply_cqr`` row by row with each row's regime Q."""
    out = np.array(q_raw, dtype=float, copy=True)
    for r, q in qs.items():
        sel = reg == r
        if sel.any():
            out[sel] = apply_cqr(q_raw[sel], q)
    return out


def fit_variants(
    m: GaugeModel,
    X: pd.DataFrame,
    Y: pd.DataFrame,
    raw: Mapping[int, np.ndarray],
    events: pd.Series,
    min_rows: int = MIN_REGIME_ROWS,
) -> dict[str, Any]:
    """Every variant's Q per (h, regime), fitted on validation rows of ``X`` only.

    ``events`` marks event windows on ``X.index`` (as ``model.train.train_gauge`` builds them).
    Returns ``{variant: {h: {regime: {interval: Q}}}}`` plus ``"_n"`` (validation rows per regime) and
    ``"_check"`` (max |recomputed current Q - shipped Q|).
    """
    idx = X.index
    level_now = X["level_now"].to_numpy(dtype=float)
    regs = {s: regimes(X, m.amber, s) for s in (1, 2, 3)}
    out: dict[str, Any] = {v: {} for v in VARIANTS}
    out["_n"] = {}
    check = 0.0
    for h in m.horizons:
        y = Y[f"y_{h}h"].to_numpy(dtype=float)
        val = val_rows(m, idx, h, y, level_now)
        cal = calibration_rows(pd.Series(val, index=idx), events.reindex(idx, fill_value=False)).to_numpy()
        current = fit_cqr(raw[h][cal], y[cal])
        check = max(check, *(abs(current[k] - m.cqr[h][k]) for k in INTERVALS))
        pooled = fit_cqr(raw[h][val], y[val])
        out["current"][h] = {r: dict(m.cqr[h]) for r in (CALM, RISING, HIGH)}
        out["pooled_all"][h] = {r: dict(pooled) for r in (CALM, RISING, HIGH)}
        out["m2"][h], n2 = fit_regime_q(raw[h], y, regs[2], val, pooled, min_rows)
        out["m3"][h], n3 = fit_regime_q(raw[h], y, regs[3], val, pooled, min_rows)
        out["m2h"][h], _ = fit_regime_q(raw[h], y, regs[2], val, m.cqr[h], min_rows, keep_fallback=(HIGH,))
        out["m3h"][h], _ = fit_regime_q(
            raw[h], y, regs[3], val, m.cqr[h], min_rows, keep_fallback=(RISING, HIGH)
        )
        out["m2e"][h], n2e = fit_regime_q(raw[h], y, regs[2], cal, m.cqr[h], min_rows)
        out["m3e"][h], n3e = fit_regime_q(raw[h], y, regs[3], cal, m.cqr[h], min_rows)
        out["_n"][h] = {
            "m2": n2,
            "m3": n3,
            "m2e": n2e,
            "m3e": n3e,
            "nCalCurrent": int(cal.sum()),
            "nVal": int(val.sum()),
        }
    out["_check"] = check
    return out


# ---------------------------------------------------------------------------------------------
# Wrapper for the #125 B harness
# ---------------------------------------------------------------------------------------------


class RegimeCalibrated:
    """A shipped ``GaugeModel`` whose ``predict`` applies a variant's per-regime Q (no retraining)."""

    def __init__(
        self, m: GaugeModel, cache: RawCache, qs: Mapping[int, Mapping[int, Mapping[str, float]]], scheme: int
    ):
        self.m = m
        self.cache = cache
        self.qs = qs
        self.scheme = scheme

    def __getattr__(self, name: str) -> Any:
        return getattr(self.m, name)

    def predict(self, X: pd.DataFrame, calibrated: bool = True) -> dict[int, np.ndarray]:
        raw = self.cache.predict_raw(X)
        if not calibrated:
            return raw
        reg = regimes(X, self.m.amber, self.scheme)
        return {h: apply_regime_q(q, reg, self.qs[h]) for h, q in raw.items()}

    def persistence(self, n: int) -> dict[int, np.ndarray]:
        return self.m.persistence(n)


# ---------------------------------------------------------------------------------------------
# Stages
# ---------------------------------------------------------------------------------------------


def load_shipped(targets: Sequence[str] = TARGETS, directory: Path = SHIPPED_DIR) -> dict[str, GaugeModel]:
    return {g: GaugeModel.load(directory / g) for g in targets}


def gauge_frame(hourly: pd.DataFrame, m: GaugeModel) -> tuple[pd.DataFrame, pd.DataFrame, pd.Series]:
    """X, Y from ``val_start`` on, and the event mask built exactly as ``train_gauge`` does."""
    from model.train import build_xy

    X, Y = build_xy(hourly, m.target, m.medians, m.lags, m.horizons)
    lmax = hourly[hourly["gauge"] == m.target].set_index("ts_utc")["level_max"].reindex(X.index)
    ev = event_mask(lmax.fillna(X["level_now"]), m.amber)
    keep = X.index >= m.splits.val_start
    return X[keep], Y[keep], ev[keep]


def cache_stage(targets: Sequence[str]) -> None:
    from model.train import load_hourly

    hourly = load_hourly()
    for g in targets:
        m = GaugeModel.load(SHIPPED_DIR / g)
        X, _, _ = gauge_frame(hourly, m)
        X = X[np.isfinite(X["level_now"].to_numpy(dtype=float))]
        RawCache(m, CACHE_DIR / f"{g}_raw.npz").predict_raw(X)
        log.info("%s cached (%d rows)", g, len(X))
    (CACHE_DIR / "CACHE_DONE").write_text(",".join(targets), encoding="utf-8")


def tail_check(
    m: GaugeModel, X: pd.DataFrame, q_cal: Mapping[int, np.ndarray], hourly: pd.DataFrame, thr: float
) -> list[dict[str, Any]]:
    """SPEC §7.5 tail extrapolation (report only): rows whose threshold lies beyond the calibrated q95.

    Per lead: n rows, mean predicted P(level > thr at t + h) from the linear tail, observed frequency.
    Rows already over the line are left out. Test rows only.
    """
    from model.probability import cdf

    test = X.index >= m.splits.test_start
    lv = X["level_now"].to_numpy(dtype=float)
    level = hourly[hourly["gauge"] == m.target].set_index("ts_utc")["level_mean"].sort_index()
    rows = []
    for h in m.horizons:
        q = q_cal[h] + lv[:, None]
        obs = level.reindex(X.index + pd.Timedelta(hours=h)).to_numpy(dtype=float)
        sel = test & (lv < thr) & np.isfinite(obs) & np.isfinite(q).all(axis=1) & (q[:, 6] < thr)
        p = 1.0 - cdf(q[sel], thr)
        o = (obs[sel] > thr).astype(float)
        pos = p > 0
        rows.append(
            {
                "h": h,
                "n": int(sel.sum()),
                "meanP": round(float(p.mean()), 5) if sel.any() else None,
                "obsFreq": round(float(o.mean()), 5) if sel.any() else None,
                "nPpos": int(pos.sum()),
                "meanPpos": round(float(p[pos].mean()), 4) if pos.any() else None,
                "obsFreqPpos": round(float(o[pos].mean()), 4) if pos.any() else None,
                "nObsPzero": int(o[~pos].sum()),
            }
        )
    return rows


def evaluate_stage(variants: Sequence[str], min_rows: int, events: bool, out: Path) -> dict[str, Any]:
    from analysis import feature_experiment as fe
    from model import backtest
    from model.train import load_hourly

    hourly = load_hourly()
    models = load_shipped()
    caches = {g: RawCache(m, CACHE_DIR / f"{g}_raw.npz") for g, m in models.items()}
    fits: dict[str, Any] = {}
    tails: dict[str, Any] = {}
    spots = backtest.load_spots()
    for g, m in models.items():
        X, Y, ev = gauge_frame(hourly, m)
        ok = np.isfinite(X["level_now"].to_numpy(dtype=float))
        X, Y, ev = X[ok], Y[ok], ev[ok]
        raw = caches[g].predict_raw(X)
        fits[g] = fit_variants(m, X, Y, raw, ev, min_rows)
        log.info("%s: recomputed current Q matches meta.json to %.2e", g, fits[g]["_check"])
        for s in spots:
            if s["gauge"] == g and s.get("mode") == "probability" and s.get("threshold") is not None:
                tails[s["key"]] = {
                    v: tail_check(
                        m,
                        X,
                        {
                            h: apply_regime_q(raw[h], regimes(X, m.amber, VARIANT_SCHEME[v]), fits[g][v][h])
                            for h in m.horizons
                        },
                        hourly,
                        float(s["threshold"]),
                    )
                    for v in ("current", "m3h")
                }

    def wrapper(v: str):
        def wrap(_hourly: pd.DataFrame, ms: Mapping[str, GaugeModel]) -> dict[str, RegimeCalibrated]:
            return {g: RegimeCalibrated(mm, caches[g], fits[g][v], VARIANT_SCHEME[v]) for g, mm in ms.items()}

        return wrap

    arms = {v: models for v in variants}
    res = fe.evaluate_arms(arms, wrappers={v: wrapper(v) for v in variants}, events=events, hourly=hourly)
    res["issue"] = "125C"
    res["minRegimeRows"] = min_rows
    res["riseM"], res["wetMm"] = RISE_M, WET_MM
    res["qFits"] = {
        g: {
            "check": f["_check"],
            "n": {
                str(h): {
                    k: (v if isinstance(v, int) else {REGIME_NAMES[r]: n for r, n in v.items()})
                    for k, v in d.items()
                }
                for h, d in f["_n"].items()
            },
            "q": {
                v: {
                    str(h): {REGIME_NAMES[r]: {k: round(x, 4) for k, x in q.items()} for r, q in d.items()}
                    for h, d in f[v].items()
                }
                for v in variants
            },
        }
        for g, f in fits.items()
    }
    res["tail"] = tails
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(res, indent=1, default=str), encoding="utf-8")
    return res


def _bri(s: Mapping[str, Any], spot: str, h: int) -> float:
    d = s["brier"][spot]
    return float((d[h] if h in d else d[str(h)])["model"])


def adoption(res: Mapping[str, Any], base: str = "current") -> dict[str, dict[str, Any]]:
    """The #125 adoption rule per variant, against ``base`` (all values at their stored precision).

    skill: min change over leads, pooled and per gauge (no worse anywhere, better somewhere);
    in-event coverage: min over leads/levels of actual - (nominal - 0.02) (absolute reading) and of
    actual - (base - 0.02) (relative reading); false alarms at p* = 0.5; Brier 48/72 h per spot.
    """
    by = {s["arm"]: s for s in res["scores"]}
    ev = {e["arm"]: e for e in res.get("events", [])}
    b = by[base]

    def skills(s: Mapping[str, Any]) -> dict[tuple[str, int], float]:
        out = {("pooled", r["h"]): r["skill"] for r in s["skill"]}
        for g, d in s["perGauge"].items():
            out.update({(g, r["h"]): r["skill"] for r in d["skill"]})
        return out

    def cov(s: Mapping[str, Any]) -> dict[tuple[int, float], float]:
        return {(r["h"], r["nominal"]): r["actual"] for r in s["floodCoverage"]}

    out = {}
    for name, s in by.items():
        if name == base:
            continue
        ds = {k: v - skills(b)[k] for k, v in skills(s).items()}
        worst = min(ds, key=ds.get)
        c, cb = cov(s), cov(b)
        abs_margin = min(v - (k[1] - 0.02) for k, v in c.items())
        rel_margin = min(v - (cb[k] - 0.02) for k, v in c.items())
        fa = {k: o["falseAlarms"] - b["outcomesP50"][k]["falseAlarms"] for k, o in s["outcomesP50"].items()}
        if name in ev and base in ev:
            fa_ev = {
                k: o["falseAlarms"] - ev[base]["tradeoffP50"][k]["falseAlarms"]
                for k, o in ev[name]["tradeoffP50"].items()
            }
        else:
            fa_ev = {}
        brier = {(k, h): _bri(s, k, h) - _bri(b, k, h) for k in s["brier"] for h in (48, 72)}
        r = {
            "skillMinDelta": round(ds[worst], 4),
            "skillWorst": f"{worst[0]} {worst[1]}h",
            "skillMaxDelta": round(max(ds.values()), 4),
            "inEventAbsMargin": round(abs_margin, 4),
            "inEventRelMargin": round(rel_margin, 4),
            "extraFA": max([0, *fa.values(), *fa_ev.values()]),
            "brierMaxDelta": max(brier.values()),
        }
        r["pass"] = {
            "skill": r["skillMinDelta"] >= 0 and r["skillMaxDelta"] > 0,
            "inEventAbs": abs_margin >= -1e-9,
            "inEventRel": rel_margin >= -1e-9,
            "noExtraFA": r["extraFA"] == 0,
            "brier": r["brierMaxDelta"] <= 1e-9,
        }
        out[name] = r
    return out


def load_results(path: Path) -> dict[str, Any]:
    """A results JSON with the Brier lead keys back as ints (as ``evaluate_arms`` returns them)."""
    res = json.loads(path.read_text(encoding="utf-8"))
    for s in res["scores"]:
        s["brier"] = {k: {int(h): v for h, v in d.items()} for k, d in s["brier"].items()}
    return res


def report(res: Mapping[str, Any]) -> str:
    from analysis import feature_experiment as fe

    L = [fe.report(res), "", "### Adoption rule vs current"]
    L.append(
        "| variant | skill min Δ (where) / max Δ | in-event cov margin abs / rel | extra FA "
        "| Brier max Δ | pass |"
    )
    L.append("|---|---|---|---|---|---|")
    for v, r in adoption(res).items():
        ok = ", ".join(k for k, p in r["pass"].items() if not p) or "all"
        L.append(
            f"| {v} | {r['skillMinDelta']:+.4f} ({r['skillWorst']}) / {r['skillMaxDelta']:+.4f} | "
            f"{r['inEventAbsMargin']:+.3f} / {r['inEventRelMargin']:+.3f} | {r['extraFA']} | "
            f"{r['brierMaxDelta']:+.6f} | {'yes' if ok == 'all' else 'fails ' + ok} |"
        )
    L += ["", "### Q per regime at 72 h (90 % interval, m): calm / rising / high"]
    for g, f in res["qFits"].items():
        n = f["n"]["72"]["m3"]
        cells = []
        for v, d in f["q"].items():
            q = d["72"]
            cells.append(f"{v} {q['calm']['05-95']:.3f}/{q['rising']['05-95']:.3f}/{q['high']['05-95']:.3f}")
        L.append(
            f"- {g} (val rows calm/rising/high {n['calm']}/{n['rising']}/{n['high']}): " + "; ".join(cells)
        )
    L += ["", "### Tail check: rows with the threshold beyond q95 (mean p / observed freq, n)"]
    for spot, d in res.get("tail", {}).items():
        for v, rows in d.items():
            L.append(
                f"- {spot} {v}: "
                + "; ".join(
                    f"{r['h']}h {r['meanP']}/{r['obsFreq']} n={r['n']} (p>0: {r['nPpos']}, "
                    f"obs with p=0: {r['nObsPzero']})"
                    for r in rows
                )
            )
    return "\n".join(L)


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("cache")
    c.add_argument("--targets", nargs="+", default=list(TARGETS))
    e = sub.add_parser("evaluate")
    e.add_argument("--variants", nargs="+", default=list(VARIANTS), choices=VARIANTS)
    e.add_argument("--min-rows", type=int, default=MIN_REGIME_ROWS)
    e.add_argument("--no-events", action="store_true")
    e.add_argument("--out", default=str(OUT_PATH))
    r = sub.add_parser("report", help="print the tables from a results JSON")
    r.add_argument("--path", default=str(OUT_PATH))
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    if args.cmd == "cache":
        cache_stage(args.targets)
    elif args.cmd == "report":
        print(report(load_results(Path(args.path))))
    else:
        res = evaluate_stage(args.variants, args.min_rows, not args.no_events, Path(args.out))
        print(report(res))
    return 0


if __name__ == "__main__":
    sys.exit(main())
