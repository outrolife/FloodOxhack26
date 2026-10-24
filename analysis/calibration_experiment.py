"""Calibration experiment (issue #85): why are the intervals too wide, and why is 72 h overconfident?

``python -m analysis.calibration_experiment [--threads 4]``

Uses the saved time-split models in ``$RC_DATA_DIR/models/<gauge>/`` (and the cached leave-one-out
models in ``models/lofo/<event>/`` for the replay events before the test period). Nothing is retrained:
every variant only changes the calibration step (SPEC §7.4) or the quantile-to-probability step (§7.5),
and each one is fitted on **validation rows only** (2018-10-01 to 2021-09-30). Test rows (>= 2021-10-01)
are only scored.

Variants of the quantile calibration (CQR, ``model.calibrate.fit_cqr`` / ``apply_cqr``):

- ``event`` (current, SPEC §7.4): one Q per (gauge, h, interval) from validation rows inside events.
- ``all``: the same, from all validation rows.
- ``regime``: two Qs per (gauge, h, interval), one from validation rows with ``level_now`` above
  ``amber - 0.3 m`` (the same "high water" rule as the sample weights, known at issue time) and one from
  the others; each forecast uses the Q of its own regime.
- ``hybrid``: two Qs as in ``regime``, but the high-water Q is the current one (validation rows inside
  events, SPEC §7.4) and the low-water Q comes from validation rows below ``amber - 0.3 m``.
- ``raw``: no CQR.

Variants of the probability step, applied on top of a quantile variant:

- ``linear`` (current, §7.5): linear tails beyond q05 / q95, clipped.
- ``isotonic``: per (gauge, h), an isotonic map p -> observed frequency fitted on validation rows.

Outputs a Markdown report on stdout and ``$RC_DATA_DIR/calib_exp/results.json``.
"""

from __future__ import annotations

import argparse
import json
import logging
import pickle
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd

from model import backtest, metrics
from model.calibrate import MIN_CAL_ROWS, apply_cqr, calibration_rows, event_mask, fit_cqr
from model.probability import ALPHAS, HORIZONS_H, cdf, monotone_in_lead, sort_quantiles
from model.train import DATA_DIR, MODELS_DIR, GaugeModel, build_xy, load_hourly, load_lags, sample_weights

log = logging.getLogger(__name__)

TARGETS: tuple[str, ...] = ("newbotley", "minns", "coldharbour", "kingsmill")
OUT_DIR = DATA_DIR / "calib_exp"
QUANT_VARIANTS: tuple[str, ...] = ("event", "all", "regime", "hybrid", "raw")
PROB_VARIANTS: tuple[str, ...] = ("linear", "isotonic")
P_STAR = 0.5


# --------------------------------------------------------------------------- frames


@dataclass
class Frame:
    """Raw (uncalibrated) predictions and outcomes for one model on the rows we need."""

    gauge: str
    amber: float
    index: pd.DatetimeIndex
    level_now: np.ndarray
    y: dict[int, np.ndarray]
    raw: dict[int, np.ndarray]
    event: np.ndarray  # inside a detected event window (uses the whole record: diagnostics only)
    val: dict[int, np.ndarray]  # validation rows (target time in validation too), not excluded
    test: np.ndarray
    future_max: dict[int, np.ndarray]  # max level over (t, t + h]: "flooded at any time by h"


def predict_raw(m: GaugeModel, X: pd.DataFrame, threads: int) -> dict[int, np.ndarray]:
    Xf = X[m.feature_cols]
    out = {}
    for h, by_alpha in m.boosters.items():
        cols = [
            by_alpha[a].predict(Xf, num_iteration=by_alpha[a].best_iteration or None, num_threads=threads)
            for a in ALPHAS
        ]
        out[h] = sort_quantiles(np.column_stack(cols))
    return out


def build_frame(
    hourly: pd.DataFrame,
    m: GaugeModel,
    rows: pd.Series | None,
    threads: int,
    exclude: np.ndarray | None = None,
) -> Frame:
    """``rows``: bool mask on the feature index of rows to keep (default: validation and test)."""
    X, Y = build_xy(hourly, m.target, m.medians, m.lags, HORIZONS_H)
    lv = hourly[hourly["gauge"] == m.target].set_index("ts_utc")
    lmax = lv["level_max"].reindex(X.index)
    ev = event_mask(lmax.fillna(X["level_now"]), m.amber).to_numpy()
    level = lv["level_mean"].reindex(X.index)
    fut = {h: level[::-1].rolling(h, min_periods=1).max()[::-1].shift(-1).to_numpy() for h in HORIZONS_H}
    keep = np.asarray(X.index >= m.splits.val_start) if rows is None else rows.to_numpy().copy()
    keep &= np.isfinite(X["level_now"].to_numpy())
    excl = np.zeros(len(X), dtype=bool) if exclude is None else exclude
    val = {}
    for h in HORIZONS_H:
        _, va, _ = m.splits.masks(X.index, h)
        val[h] = (va & ~excl)[keep]
    Xk = X[keep]
    return Frame(
        gauge=m.target,
        amber=m.amber,
        index=Xk.index,
        level_now=Xk["level_now"].to_numpy(dtype=float),
        y={h: Y[f"y_{h}h"].to_numpy(dtype=float)[keep] for h in HORIZONS_H},
        raw=predict_raw(m, Xk, threads),
        event=ev[keep],
        val=val,
        test=np.asarray(Xk.index >= m.splits.test_start),
        future_max={h: fut[h][keep] for h in HORIZONS_H},
    )


# --------------------------------------------------------------------------- calibrators


def high_regime(level_now: np.ndarray, amber: float) -> np.ndarray:
    """High-water regime, known at issue time: the sample-weight rule of SPEC §7.3."""
    return sample_weights(level_now, amber) > 1.0


def fit_quant(fr: Frame, variant: str) -> dict[int, Any]:
    """Per lead: the CQR offsets of one variant, from validation rows only."""
    out: dict[int, Any] = {}
    for h in HORIZONS_H:
        va = fr.val[h] & np.isfinite(fr.y[h])
        q, y = fr.raw[h], fr.y[h]
        if variant == "event":
            idx = pd.RangeIndex(len(va))
            cal = calibration_rows(pd.Series(va, index=idx), pd.Series(fr.event, index=idx)).to_numpy()
            out[h] = fit_cqr(q[cal], y[cal])
        elif variant == "all":
            out[h] = fit_cqr(q[va], y[va])
        elif variant == "regime":
            hi = high_regime(fr.level_now, fr.amber)
            both = fit_cqr(q[va], y[va])
            out[h] = {
                r: (fit_cqr(q[va & m], y[va & m]) if (va & m).sum() >= MIN_CAL_ROWS else both)
                for r, m in (("high", hi), ("low", ~hi))
            }
        elif variant == "hybrid":
            idx = pd.RangeIndex(len(va))
            cal = calibration_rows(pd.Series(va, index=idx), pd.Series(fr.event, index=idx)).to_numpy()
            lo = va & ~high_regime(fr.level_now, fr.amber)
            out[h] = {"high": fit_cqr(q[cal], y[cal]), "low": fit_cqr(q[lo], y[lo])}
        elif variant == "raw":
            out[h] = {}
        else:
            raise ValueError(variant)
    return out


def apply_quant(q: np.ndarray, level_now: np.ndarray, amber: float, qs: Any, variant: str) -> np.ndarray:
    if variant not in ("regime", "hybrid"):
        return apply_cqr(q, qs)
    hi = high_regime(level_now, amber)
    out = np.empty_like(q)
    out[hi] = apply_cqr(q[hi], qs["high"])
    out[~hi] = apply_cqr(q[~hi], qs["low"])
    return out


def calibrated(fr: Frame, variant: str, qs: Mapping[int, Any]) -> dict[int, np.ndarray]:
    return {h: apply_quant(fr.raw[h], fr.level_now, fr.amber, qs[h], variant) for h in HORIZONS_H}


def p_exceed(fr: Frame, q: Mapping[int, np.ndarray], line: float, mono: bool = True) -> np.ndarray:
    """(n, leads) P(level(t + h) > line), like ``model.probability.exceedance``."""
    qm = np.stack([q[h] for h in HORIZONS_H], axis=1) + fr.level_now[:, None, None]
    p = 1.0 - cdf(qm, line)
    return monotone_in_lead(p) if mono else p


def pav(x: np.ndarray, y: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Isotonic (non-decreasing) regression by pool-adjacent-violators; returns knots (x, fitted y)."""
    order = np.argsort(x, kind="mergesort")
    xs, ys = x[order], y[order].astype(float)
    vals: list[float] = []
    wts: list[float] = []
    xs_hi: list[float] = []
    for xi, yi in zip(xs, ys, strict=True):
        vals.append(yi)
        wts.append(1.0)
        xs_hi.append(xi)
        while len(vals) > 1 and vals[-2] > vals[-1]:
            w = wts[-2] + wts[-1]
            v = (vals[-2] * wts[-2] + vals[-1] * wts[-1]) / w
            vals[-2:] = [v]
            wts[-2:] = [w]
            xs_hi[-2:] = [xs_hi[-1]]
    return np.asarray(xs_hi), np.asarray(vals)


def fit_isotonic(p_val: np.ndarray, o_val: np.ndarray) -> list[tuple[np.ndarray, np.ndarray]]:
    out = []
    for i in range(p_val.shape[1]):
        ok = np.isfinite(p_val[:, i]) & np.isfinite(o_val[:, i])
        x = np.r_[0.0, p_val[ok, i], 1.0]
        y = np.r_[0.0, o_val[ok, i], 1.0]  # anchor the ends so the map stays on [0, 1]
        out.append(pav(x, y))
    return out


def apply_isotonic(p: np.ndarray, maps: Sequence[tuple[np.ndarray, np.ndarray]]) -> np.ndarray:
    out = np.full_like(p, np.nan)
    for i, (kx, ky) in enumerate(maps):
        ok = np.isfinite(p[:, i])
        out[ok, i] = np.interp(p[ok, i], kx, ky)
    return monotone_in_lead(out)


# --------------------------------------------------------------------------- scores


def quantile_scores(frames: Mapping[str, Frame], qcal: Mapping[str, Mapping[int, np.ndarray]], models):
    """Coverage and pinball skill on test rows: pooled, per gauge, and split by in/out of event."""
    res: dict[str, Any] = {"pooled": {}, "gauge": {}, "inEvent": {}, "outEvent": {}, "highRegime": {}}
    for h in HORIZONS_H:
        pools: dict[str, list] = {k: [] for k in ("m", "p", "y", "ev", "hi")}
        for g, fr in frames.items():
            t = fr.test & np.isfinite(fr.y[h])
            qm, y = qcal[g][h][t], fr.y[h][t]
            qp = np.tile(np.asarray(models[g].persistence_eps[h]), (len(y), 1))
            pools["m"].append(qm)
            pools["p"].append(qp)
            pools["y"].append(y)
            pools["ev"].append(fr.event[t])
            pools["hi"].append(high_regime(fr.level_now[t], fr.amber))
            res["gauge"].setdefault(g, {})[h] = _qscore(qm, qp, y)
        m, p, y = (np.concatenate(pools[k]) for k in ("m", "p", "y"))
        ev, hi = np.concatenate(pools["ev"]), np.concatenate(pools["hi"])
        res["pooled"][h] = _qscore(m, p, y)
        res["inEvent"][h] = _qscore(m[ev], p[ev], y[ev])
        res["outEvent"][h] = _qscore(m[~ev], p[~ev], y[~ev])
        res["highRegime"][h] = _qscore(m[hi], p[hi], y[hi])
    return res


def _qscore(qm: np.ndarray, qp: np.ndarray, y: np.ndarray) -> dict[str, float]:
    cov = metrics.interval_coverage(qm, y)
    pm, pp = metrics.pinball_loss(qm, y), metrics.pinball_loss(qp, y)
    bias = float(np.nanmedian(y - qm[:, ALPHAS.index(0.5)])) if len(y) else float("nan")
    width90 = float(np.nanmean(qm[:, 6] - qm[:, 0])) if len(y) else float("nan")
    return {
        "n": int(len(y)),
        "c50": cov[0.5],
        "c80": cov[0.8],
        "c90": cov[0.9],
        "skill": metrics.skill(pm, pp),
        "medBias": bias,
        "w90": width90,
    }


def prob_scores(fr: Frame, p: np.ndarray, p_pers: np.ndarray, line: float, rows: np.ndarray) -> dict:
    """Brier, BSS and the top reliability bin per lead, against level at t + h and 'any time by t + h'."""
    out = {}
    for i, h in enumerate(HORIZONS_H):
        lvl = fr.level_now + fr.y[h]
        o = metrics.exceedance_outcome(lvl, line)
        o_any = np.where(np.isfinite(fr.future_max[h]), (fr.future_max[h] >= line).astype(float), np.nan)
        ok = rows & np.isfinite(o) & np.isfinite(p[:, i]) & np.isfinite(p_pers[:, i])
        b, bp = metrics.brier_score(p[ok, i], o[ok]), metrics.brier_score(p_pers[ok, i], o[ok])
        okA = rows & np.isfinite(o_any) & np.isfinite(p[:, i]) & np.isfinite(p_pers[:, i])
        ba, bpa = metrics.brier_score(p[okA, i], o_any[okA]), metrics.brier_score(p_pers[okA, i], o_any[okA])
        top = p[ok, i] >= 0.9
        ok2 = ok & np.isfinite(o_any)
        out[h] = {
            "brier": b,
            "brierPers": bp,
            "bss": metrics.skill(b, bp),
            "bssAny": metrics.skill(ba, bpa),
            "topN": int(top.sum()),
            "topPred": float(p[ok, i][top].mean()) if top.any() else None,
            "topObs": float(o[ok][top].mean()) if top.any() else None,
            "topObsAny": float(o_any[ok2][p[ok2, i] >= 0.9].mean()) if (p[ok2, i] >= 0.9).any() else None,
            "nPos": int(o[ok].sum()),
        }
    return out


# --------------------------------------------------------------------------- event outcomes


def event_p_series(fr: Frame, p: np.ndarray, line: float, times: pd.DatetimeIndex, stale: np.ndarray):
    """Trigger series as ``metrics.spot_probability``: max over leads; NaN at/above the line or stale."""
    s = pd.Series(np.nanmax(np.where(np.isfinite(p), p, -np.inf), axis=1), index=fr.index)
    s[~np.isfinite(s)] = np.nan
    s[np.round(fr.level_now, 3) >= line] = np.nan
    s[stale] = np.nan
    return s.reindex(times)


def stale_mask(hourly: pd.DataFrame, gauge: str, index: pd.DatetimeIndex) -> np.ndarray:
    lv = hourly[(hourly["gauge"] == gauge) & hourly["level_mean"].notna()].set_index("ts_utc").sort_index()
    last = pd.Series(lv.index, index=lv.index).reindex(lv.index.union(index)).ffill().reindex(index)
    gap = np.asarray(index - pd.DatetimeIndex(last))
    return (gap > pd.Timedelta(hours=backtest.STALE_H)) | last.isna().to_numpy()


# --------------------------------------------------------------------------- driver


def load_model_set(event_id: str | None) -> dict[str, GaugeModel]:
    base = MODELS_DIR if event_id is None else MODELS_DIR / "lofo" / event_id
    return {g: GaugeModel.load(base / g) for g in TARGETS}


def cached(name: str, fn):
    path = OUT_DIR / f"{name}.pkl"
    if path.exists():
        return pickle.loads(path.read_bytes())
    obj = fn()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(pickle.dumps(obj))
    return obj


def variant_probs(fr: Frame, qs_fit: Mapping[str, Any], qv: str, pv: str, line: float, iso_maps):
    q = calibrated(fr, qv, qs_fit[qv])
    p = p_exceed(fr, q, line)
    if pv == "isotonic":
        p = apply_isotonic(p, iso_maps[qv])
    return q, p


def iso_fit(fr: Frame, qs_fit: Mapping[str, Any], line: float) -> dict[str, Any]:
    """Isotonic maps per quantile variant, from validation rows (outcome at t + h)."""
    maps = {}
    for qv in QUANT_VARIANTS:
        p = p_exceed(fr, calibrated(fr, qv, qs_fit[qv]), line)
        o = np.column_stack([metrics.exceedance_outcome(fr.level_now + fr.y[h], line) for h in HORIZONS_H])
        va = np.column_stack([fr.val[h] for h in HORIZONS_H])
        o = np.where(va, o, np.nan)
        maps[qv] = fit_isotonic(p, o)
    return maps


def run(threads: int) -> dict[str, Any]:
    t0 = time.time()
    hourly = load_hourly()
    lags = load_lags()  # noqa: F841 (models carry their own lags)
    spots = [s for s in backtest.load_spots() if s.get("mode") == "probability" and s.get("threshold")]
    spot_of = {s["gauge"]: s for s in spots}
    models = load_model_set(None)
    frames = cached(
        "frames_main", lambda: {g: build_frame(hourly, m, None, threads) for g, m in models.items()}
    )
    log.info("main frames ready (%.0f s)", time.time() - t0)
    fits = {g: {v: fit_quant(fr, v) for v in QUANT_VARIANTS} for g, fr in frames.items()}
    isos = {g: iso_fit(fr, fits[g], float(spot_of[g]["threshold"])) for g, fr in frames.items()}

    results: dict[str, Any] = {"quant": {}, "prob": {}, "events": {}, "diag": {}}
    for qv in QUANT_VARIANTS:
        qcal = {g: calibrated(fr, qv, fits[g][qv]) for g, fr in frames.items()}
        results["quant"][qv] = quantile_scores(frames, qcal, models)
        for pv in PROB_VARIANTS:
            key = f"{qv}+{pv}"
            results["prob"][key] = {}
            for g, fr in frames.items():
                s = spot_of[g]
                line = float(s["threshold"])
                _, p = variant_probs(fr, fits[g], qv, pv, line, isos[g])
                qp = {
                    h: np.tile(np.asarray(models[g].persistence_eps[h]), (len(fr.index), 1))
                    for h in HORIZONS_H
                }
                pp = p_exceed(fr, qp, line)
                results["prob"][key][s["key"]] = prob_scores(fr, p, pp, line, fr.test)
                if pv == "linear":
                    p_nomono = p_exceed(fr, calibrated(fr, qv, fits[g][qv]), line, mono=False)
                    pp_nomono = p_exceed(fr, qp, line, mono=False)
                    results["diag"].setdefault(qv, {})[s["key"]] = {
                        "noMonotone": prob_scores(fr, p_nomono, pp_nomono, line, fr.test),
                        "aboveNow": prob_scores(fr, p, pp, line, fr.test & (fr.level_now >= line)),
                        "belowNow": prob_scores(fr, p, pp, line, fr.test & (fr.level_now < line)),
                    }
    results["cqr"] = {g: {qv: fits[g][qv] for qv in ("event", "all", "regime", "hybrid")} for g in fits}

    # Event outcomes at p* = 0.5 on the replay events, with the same models as proof.py.
    hourly_r = hourly.copy()
    hourly_r["level_mean"] = hourly_r["level_mean"].round(3)
    events = backtest.load_events()
    from model.proof import in_test_period

    p_by: dict[str, dict[str, dict[str, pd.Series]]] = {}
    cross_by: dict[str, dict[str, list]] = {}
    for eid, ev in events.items():
        start, end = backtest.event_window(ev)
        times = pd.date_range(start, end, freq="h", tz="UTC")
        lofo = not in_test_period(ev)
        ms = load_model_set(eid) if lofo else models
        cross = backtest.crossings(hourly_r, spots, start, end)
        for s in spots:
            cross_by.setdefault(s["key"], {})[eid] = metrics.flood_onsets(
                pd.Timestamp(c["t"]) for c in cross if c["spot"] == s["key"]
            )
        for g, m in ms.items():
            s = spot_of[g]
            line = float(s["threshold"])
            if lofo:
                excl_w = [(pd.Timestamp(a), pd.Timestamp(b)) for a, b in m.excluded]

                def mk(m=m, excl_w=excl_w, start=start, end=end):
                    X, _ = build_xy(hourly_r, m.target, m.medians, m.lags, HORIZONS_H)
                    from model.train import windows_mask

                    excl = windows_mask(X.index, excl_w)
                    rows = pd.Series(
                        (X.index >= m.splits.val_start) & (X.index < m.splits.test_start), index=X.index
                    )
                    win = pd.Series((X.index >= start) & (X.index <= end), index=X.index)
                    return build_frame(hourly_r, m, rows | win, threads, exclude=excl)

                fr = cached(f"frames_{eid}_{g}", mk)
                fit_g = {v: fit_quant(fr, v) for v in QUANT_VARIANTS}
                iso_g = iso_fit(fr, fit_g, line)
            else:

                def mk2(m=m, start=start, end=end):
                    X, _ = build_xy(hourly_r, m.target, m.medians, m.lags, HORIZONS_H)
                    win = pd.Series((X.index >= start) & (X.index <= end), index=X.index)
                    return build_frame(hourly_r, m, win, threads)

                fr = cached(f"frames_{eid}_{g}", mk2)
                fit_g, iso_g = fits[g], isos[g]  # main model: calibrated on its own validation rows
            stale = stale_mask(hourly_r, g, fr.index)
            for qv in QUANT_VARIANTS:
                for pv in PROB_VARIANTS:
                    q = calibrated(fr, qv, fit_g[qv])
                    p = p_exceed(fr, q, line)
                    if pv == "isotonic":
                        p = apply_isotonic(p, iso_g[qv])
                    p_by.setdefault(f"{qv}+{pv}", {}).setdefault(s["key"], {})[eid] = event_p_series(
                        fr, p, line, times, stale
                    )
        log.info("event %s done (%.0f s)", eid, time.time() - t0)
    for key, by_spot in p_by.items():
        results["events"][key] = {}
        for spot, pe in by_spot.items():
            rows = metrics.tradeoff_rows(pe, cross_by[spot], p_stars=(0.1, 0.5, 0.9), n_boot=50)
            results["events"][key][spot] = {r["pStar"]: r for r in rows}
    return results


def _f(x: Any, nd: int = 3) -> str:
    return "-" if x is None or (isinstance(x, float) and not np.isfinite(x)) else f"{x:.{nd}f}"


def report(res: Mapping[str, Any]) -> str:
    L: list[str] = []
    qv_all = list(res["quant"])
    L.append("### Interval coverage on test rows, pooled (50 / 80 / 90 %) and pinball skill\n")
    L.append("| variant | " + " | ".join(f"{h} h" for h in HORIZONS_H) + " |")
    L.append("|---|" + "---|" * len(HORIZONS_H))
    for qv in qv_all:
        r = res["quant"][qv]["pooled"]
        L.append(
            f"| {qv} | "
            + " | ".join(
                f"{r[h]['c50']:.2f}/{r[h]['c80']:.2f}/{r[h]['c90']:.2f} sk {r[h]['skill']:+.3f}"
                for h in HORIZONS_H
            )
            + " |"
        )
    for part in ("inEvent", "outEvent", "highRegime"):
        L.append(f"\n**{part}** (n at 24 h = {res['quant']['event'][part][24]['n']})\n")
        L.append("| variant | " + " | ".join(f"{h} h" for h in HORIZONS_H) + " |")
        L.append("|---|" + "---|" * len(HORIZONS_H))
        for qv in qv_all:
            r = res["quant"][qv][part]
            L.append(
                f"| {qv} | "
                + " | ".join(
                    f"{r[h]['c50']:.2f}/{r[h]['c80']:.2f}/{r[h]['c90']:.2f} sk {r[h]['skill']:+.3f}"
                    for h in HORIZONS_H
                )
                + " |"
            )
    L.append(
        "\n### Per gauge, 24 h and 72 h: coverage 50/80/90, skill, median bias (m), mean 90% width (m)\n"
    )
    L.append("| gauge | variant | 24 h | 72 h |")
    L.append("|---|---|---|---|")
    for g in res["quant"]["event"]["gauge"]:
        for qv in qv_all:
            r = res["quant"][qv]["gauge"][g]
            cells = [
                f"{r[h]['c50']:.2f}/{r[h]['c80']:.2f}/{r[h]['c90']:.2f} sk {r[h]['skill']:+.3f} "
                f"bias {r[h]['medBias']:+.3f} w {r[h]['w90']:.3f}"
                for h in (24, 72)
            ]
            L.append(f"| {g} | {qv} | {cells[0]} | {cells[1]} |")
    L.append("\n### Brier skill vs persistence per spot (test rows), by lead\n")
    L.append("| variant | spot | " + " | ".join(f"{h} h" for h in HORIZONS_H) + " |")
    L.append("|---|---|" + "---|" * len(HORIZONS_H))
    for key, by_spot in res["prob"].items():
        for spot, r in by_spot.items():
            L.append(f"| {key} | {spot} | " + " | ".join(f"{_f(r[h]['bss'], 3)}" for h in HORIZONS_H) + " |")
    L.append("\n### Brier skill vs persistence, outcome = at/above the line at any time in (t, t+h]\n")
    L.append("| variant | spot | " + " | ".join(f"{h} h" for h in HORIZONS_H) + " |")
    L.append("|---|---|" + "---|" * len(HORIZONS_H))
    for key, by_spot in res["prob"].items():
        for spot, r in by_spot.items():
            L.append(
                f"| {key} | {spot} | " + " | ".join(f"{_f(r[h]['bssAny'], 3)}" for h in HORIZONS_H) + " |"
            )
    L.append("\n### Brier skill (outcome at t+h), rows below the line at issue time only\n")
    L.append("| variant | spot | " + " | ".join(f"{h} h" for h in HORIZONS_H) + " |")
    L.append("|---|---|" + "---|" * len(HORIZONS_H))
    for qv, by_spot in res["diag"].items():
        for spot, d in by_spot.items():
            r = d["belowNow"]
            L.append(f"| {qv} | {spot} | " + " | ".join(f"{_f(r[h]['bss'], 3)}" for h in HORIZONS_H) + " |")
    L.append(
        "\n### Top reliability bin (p >= 0.9) at 72 h: n, mean p, observed at t+72h, "
        "observed any time by t+72h\n"
    )
    L.append("| variant | spot | n | pPred | pObs(t+h) | pObs(by t+h) |")
    L.append("|---|---|---|---|---|---|")
    for key, by_spot in res["prob"].items():
        for spot, r in by_spot.items():
            x = r[72]
            L.append(
                f"| {key} | {spot} | {x['topN']} | {_f(x['topPred'])} | {_f(x['topObs'])} | "
                f"{_f(x['topObsAny'])} |"
            )
    L.append("\n### Diagnosis of 72 h overconfidence (current quantiles)\n")
    L.append("| spot | rows | n(p>=0.9) | pPred | pObs(t+72h) | pObs(by t+72h) |")
    L.append("|---|---|---|---|---|---|")
    for spot, d in res["diag"]["event"].items():
        for name in ("aboveNow", "belowNow", "noMonotone"):
            x = d[name][72]
            L.append(
                f"| {spot} | {name} | {x['topN']} | {_f(x['topPred'])} | {_f(x['topObs'])} | "
                f"{_f(x['topObsAny'])} |"
            )
    L.append(
        "\n### Event outcomes (replays as in proof.py), p* = 0.5 (and 0.1 / 0.9): "
        "hits / misses / false alarms, mean lead h\n"
    )
    L.append("| variant | " + " | ".join(next(iter(res["events"].values())).keys()) + " |")
    L.append("|---|" + "---|" * len(next(iter(res["events"].values()))))
    for key, by_spot in res["events"].items():
        cells = []
        for rows in by_spot.values():
            r = rows[0.5]
            lo, hi = rows[0.1], rows[0.9]
            cells.append(
                f"{r['hits']}/{r['misses']}/{r['falseAlarms']} lead {_f(r['meanLeadH'], 1)} "
                f"(0.1: {lo['hits']}/{lo['misses']}/{lo['falseAlarms']}; "
                f"0.9: {hi['hits']}/{hi['misses']}/{hi['falseAlarms']})"
            )
        L.append(f"| {key} | " + " | ".join(cells) + " |")
    return "\n".join(L)


def _jsonable(o: Any) -> Any:
    if isinstance(o, dict):
        return {str(k): _jsonable(v) for k, v in o.items()}
    if isinstance(o, list | tuple):
        return [_jsonable(v) for v in o]
    if isinstance(o, float | np.floating):
        return None if not np.isfinite(o) else round(float(o), 5)
    if isinstance(o, np.integer):
        return int(o)
    return o


def main(argv: Sequence[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="Calibration experiment (#85)")
    ap.add_argument("--threads", type=int, default=4)
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    res = run(args.threads)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "results.json").write_text(json.dumps(_jsonable(res), indent=1), encoding="utf-8")
    print(report(res))


if __name__ == "__main__":
    main()
