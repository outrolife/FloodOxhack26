"""Conformalised quantile regression on validation events (SPEC §7.4).

Issue #8.

API (used by ``model/train.py`` and ``model/backtest.py``)
--------------------------------------------------------
- ``conformal_q(scores, a)``: the ⌈(1 − a)(n + 1)⌉-th smallest score (may be negative).
- ``fit_cqr(q_pred, y)``: ``{"05-95": Q, "10-90": Q, "25-75": Q}`` from validation rows.
- ``apply_cqr(q_pred, qs)``: lower bound −= Q, upper bound += Q, median unchanged, re-sorted.
- ``event_mask(level_max, amber)``: hourly bool mask of event windows (SPEC §6.1 rule) used to pick
  the calibration rows.

``python -m model.calibrate`` loads the saved models from ``data/models/<gauge>/``, recomputes the
validation predictions and writes the CQR offsets into each model's ``meta.json``. ``model.train``
already calibrates after training, so this is only needed to recalibrate without retraining.
"""

from __future__ import annotations

import logging
import math
from collections.abc import Mapping

import numpy as np
import pandas as pd

from model.probability import ALPHAS, sort_quantiles

log = logging.getLogger(__name__)

# (lower alpha, upper alpha) -> nominal miscoverage a
INTERVALS: dict[str, tuple[float, float, float]] = {
    "05-95": (0.05, 0.95, 0.10),
    "10-90": (0.10, 0.90, 0.20),
    "25-75": (0.25, 0.75, 0.50),
}
MIN_CAL_ROWS = 30  # fewer event rows than this: fall back to all validation rows (logged)

# Event rule (SPEC §6.1): level_max > amber, merged if gaps < 7 days, peak > amber + 0.1 m,
# window from 7 days before the start to 3 days after the end.
MERGE_GAP_H = 7 * 24
PEAK_MARGIN_M = 0.1
PRE_H = 7 * 24
POST_H = 3 * 24


def conformal_q(scores: np.ndarray, a: float) -> float:
    """The ⌈(1 − a)(n + 1)⌉-th smallest finite score (1-based). May be negative.

    If that rank exceeds n (too few rows), the exact answer is +inf; we return the largest score
    and log it, so intervals stay finite and JSON-serialisable.
    """
    s = np.sort(np.asarray(scores, dtype=float)[np.isfinite(scores)])
    n = len(s)
    if n == 0:
        log.warning("no calibration scores; Q = 0 (no adjustment)")
        return 0.0
    k = math.ceil((1 - a) * (n + 1))
    if k > n:
        log.warning("rank %d > n = %d for a = %.2f; using the largest score", k, n, a)
        k = n
    return float(s[k - 1])


def fit_cqr(q_pred: np.ndarray, y: np.ndarray) -> dict[str, float]:
    """CQR offsets per interval from predicted quantiles ``(n, 7)`` and outcomes ``(n,)``.

    Rows with any NaN are ignored. Score ``E = max(q_lo − y, y − q_hi)``.
    """
    q = np.asarray(q_pred, dtype=float)
    y = np.asarray(y, dtype=float)
    ok = np.isfinite(y) & np.isfinite(q).all(axis=1)
    q, y = q[ok], y[ok]
    out: dict[str, float] = {}
    for key, (lo, hi, a) in INTERVALS.items():
        e = np.maximum(q[:, ALPHAS.index(lo)] - y, y - q[:, ALPHAS.index(hi)])
        out[key] = conformal_q(e, a)
    return out


def apply_cqr(q_pred: np.ndarray, qs: Mapping[str, float]) -> np.ndarray:
    """Widen (or narrow, if Q < 0) each interval by its Q; median unchanged; re-sort per row."""
    q = np.array(q_pred, dtype=float, copy=True)
    for key, (lo, hi, _) in INTERVALS.items():
        if key in qs:
            q[..., ALPHAS.index(lo)] -= qs[key]
            q[..., ALPHAS.index(hi)] += qs[key]
    return sort_quantiles(q)


def event_windows(level_max: pd.Series, amber: float) -> list[tuple[pd.Timestamp, pd.Timestamp]]:
    """Event analysis windows ``(start − 7 d, end + 3 d)`` on an hourly UTC series (SPEC §6.1)."""
    s = level_max.dropna()
    above = s[s > amber]
    if above.empty:
        return []
    ts = above.index
    gaps = (ts[1:] - ts[:-1]) / pd.Timedelta(hours=1)
    breaks = np.flatnonzero(gaps >= MERGE_GAP_H)
    starts = np.r_[0, breaks + 1]
    ends = np.r_[breaks, len(ts) - 1]
    out = []
    for i0, i1 in zip(starts, ends, strict=True):
        if above.iloc[i0 : i1 + 1].max() > amber + PEAK_MARGIN_M:
            out.append((ts[i0] - pd.Timedelta(hours=PRE_H), ts[i1] + pd.Timedelta(hours=POST_H)))
    return out


def event_mask(level_max: pd.Series, amber: float, index: pd.DatetimeIndex | None = None) -> pd.Series:
    """Bool series on ``index`` (default: the series' own index): True inside an event window."""
    idx = level_max.index if index is None else index
    mask = pd.Series(False, index=idx)
    for start, end in event_windows(level_max, amber):
        mask |= (idx >= start) & (idx <= end)
    return mask


def calibration_rows(val_mask: pd.Series, events: pd.Series) -> pd.Series:
    """Validation rows inside events; all validation rows if there are fewer than MIN_CAL_ROWS."""
    rows = val_mask & events
    if int(rows.sum()) < MIN_CAL_ROWS:
        log.warning("only %d validation event rows; calibrating on all validation rows", int(rows.sum()))
        return val_mask
    return rows


def main() -> None:
    from model.train import recalibrate_saved

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    recalibrate_saved()


if __name__ == "__main__":
    main()
