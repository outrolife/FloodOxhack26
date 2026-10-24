"""Quantiles to flood/amber probabilities and arrival windows (SPEC §7.5).

Issue #8.

Everything here is pure numpy on already-predicted quantiles; nothing reads data or models.

Conventions
-----------
- ``ALPHAS`` is the fixed quantile grid (0.05 ... 0.95); arrays of quantiles have the alpha axis last.
- Quantiles passed in are *level changes* ``q_alpha(h)`` (the model target, SPEC §7.1); levels are
  ``level_now + q_alpha(h)``.
- The CDF interpolates linearly between quantiles. Below q05 it extends the 0.05-0.25 segment's slope,
  above q95 the 0.75-0.95 slope, then clips to [0, 1]. A zero-width tail segment means "no spread",
  so the tail jumps straight to 0 (below) or 1 (above). At tied quantiles F takes the highest
  alpha on the grid.
- Arrival times: p is anchored at lead 0 by the observation itself (1 if level_now is already at or
  above the line, else 0), then interpolated linearly between leads. ``None`` if never reached by the
  last lead.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

import numpy as np
import pandas as pd

ALPHAS: tuple[float, ...] = (0.05, 0.10, 0.25, 0.50, 0.75, 0.90, 0.95)
QUANT_KEYS: tuple[str, ...] = ("05", "10", "25", "50", "75", "90", "95")
HORIZONS_H: tuple[int, ...] = (6, 12, 24, 36, 48, 72)
ARRIVAL_LEVELS: tuple[float, ...] = (0.1, 0.5, 0.9)

_A = np.asarray(ALPHAS)


def sort_quantiles(q: np.ndarray) -> np.ndarray:
    """Sort quantiles along the last axis so they never cross (SPEC §7.3)."""
    return np.sort(np.asarray(q, dtype=float), axis=-1)


def cdf(quantiles: np.ndarray, x: np.ndarray | float) -> np.ndarray:
    """F(x) for each row of ``quantiles`` (shape ``(..., 7)``, values on the ``ALPHAS`` grid).

    ``x`` broadcasts against ``quantiles[..., 0]``. NaN quantiles or NaN x give NaN.
    """
    q = sort_quantiles(quantiles)
    x = np.broadcast_to(np.asarray(x, dtype=float), q.shape[:-1]).astype(float)
    out = np.full(q.shape[:-1], np.nan)

    # Interior segments, in increasing order; a later segment overwrites, so ties take the higher alpha.
    for i in range(len(_A) - 1):
        lo, hi = q[..., i], q[..., i + 1]
        inside = (x >= lo) & (x <= hi)
        width = hi - lo
        with np.errstate(invalid="ignore", divide="ignore"):
            frac = np.where(width > 0, (x - lo) / width, 1.0)
        out = np.where(inside, _A[i] + frac * (_A[i + 1] - _A[i]), out)

    with np.errstate(invalid="ignore", divide="ignore"):
        lo_w = q[..., 2] - q[..., 0]
        below = np.where(lo_w > 0, _A[0] - (q[..., 0] - x) * (_A[2] - _A[0]) / lo_w, 0.0)
        hi_w = q[..., 6] - q[..., 4]
        above = np.where(hi_w > 0, _A[6] + (x - q[..., 6]) * (_A[6] - _A[4]) / hi_w, 1.0)
    out = np.where(x < q[..., 0], below, out)
    out = np.where(x > q[..., 6], above, out)
    out = np.clip(out, 0.0, 1.0)
    bad = np.isnan(x) | np.isnan(q).any(axis=-1)
    return np.where(bad, np.nan, out)


def exceedance(level_now: float, q_delta: np.ndarray, line: float) -> np.ndarray:
    """P(level > line) per lead, made non-decreasing in lead (SPEC §7.5 steps 1-4).

    ``q_delta`` has shape ``(n_leads, 7)`` in lead order. NaN rows stay NaN and don't break the
    running maximum for later leads.
    """
    p = 1.0 - cdf(np.asarray(q_delta, dtype=float) + level_now, line)
    return monotone_in_lead(p)


def monotone_in_lead(p: np.ndarray) -> np.ndarray:
    """``p_h = max(p_h, p_{h-1})`` along the last axis, ignoring NaN."""
    p = np.asarray(p, dtype=float)
    filled = np.where(np.isnan(p), -np.inf, p)
    run = np.maximum.accumulate(filled, axis=-1)
    return np.where(np.isnan(p), np.nan, run)


def first_crossing_h(
    leads: Sequence[float], values: Sequence[float], level: float, v0: float | None = None
) -> float | None:
    """First lead (hours, fractional) at which ``values`` reaches ``level``, interpolating linearly.

    ``v0`` is the value at lead 0 (optional anchor). NaN points are skipped. ``None`` if never reached.
    """
    pts = [(0.0, float(v0))] if v0 is not None and not np.isnan(v0) else []
    pts += [(float(h), float(v)) for h, v in zip(leads, values, strict=True) if not np.isnan(v)]
    if not pts:
        return None
    if pts[0][1] >= level:
        return pts[0][0]
    for (h0, v0_), (h1, v1) in zip(pts[:-1], pts[1:], strict=True):
        if v1 >= level:
            return h0 + (level - v0_) / (v1 - v0_) * (h1 - h0)
    return None


def _iso(ts: pd.Timestamp) -> str:
    return pd.Timestamp(ts).tz_convert("UTC").strftime("%Y-%m-%dT%H:%M:%SZ")


def _at(issued_at: pd.Timestamp, h: float | None) -> str | None:
    if h is None:
        return None
    return _iso(pd.Timestamp(issued_at) + pd.Timedelta(hours=round(h * 60) / 60))


def arrival_window(
    issued_at: pd.Timestamp, leads: Sequence[int], p: Sequence[float], level_now: float, line: float
) -> dict[str, str | None]:
    """Times at which P(level > line) first reaches 0.1, 0.5 and 0.9 (SPEC §7.5 step 5)."""
    p0 = 1.0 if level_now >= line else 0.0
    keys = ("p10", "p50", "p90")
    return {
        k: _at(issued_at, first_crossing_h(leads, p, lv, p0))
        for k, lv in zip(keys, ARRIVAL_LEVELS, strict=True)
    }


def timing_only_arrival(
    issued_at: pd.Timestamp,
    leads: Sequence[int],
    q_delta: np.ndarray,
    level_now: float,
    amber: float,
    upstream_rise: Mapping[str, Any] | None = None,
) -> dict[str, str | None] | None:
    """Arrival for ``timing_only`` spots (SPEC §7.5 step 6).

    ``p50`` = when the median forecast reaches amber (``None`` if not by the last lead). If an upstream
    rise is observed (``upstream_rise = {"t_half": Timestamp, "p10": h, "median": h, "p90": h}`` with
    ``T_half`` travel times), ``p10``/``p90`` are ``t_half + T_half p10/p90`` and ``p50`` falls back to
    ``t_half + median`` when the median forecast does not reach amber. ``None`` if nothing is known.
    """
    median = np.asarray(q_delta, dtype=float)[:, ALPHAS.index(0.50)] + level_now
    p50 = _at(issued_at, first_crossing_h(leads, median, amber, level_now))
    p10 = p90 = None
    if upstream_rise is not None:
        t_half = pd.Timestamp(upstream_rise["t_half"])
        p10 = _at(t_half, float(upstream_rise["p10"]))
        p90 = _at(t_half, float(upstream_rise["p90"]))
        if p50 is None:
            p50 = _at(t_half, float(upstream_rise["median"]))
    if p10 is None and p50 is None and p90 is None:
        return None
    return {"p10": p10, "p50": p50, "p90": p90}


def _r(x: float, nd: int = 3) -> float | None:
    return None if x is None or np.isnan(x) else round(float(x), nd)


def spot_forecast(
    spot: Mapping[str, Any],
    level_now: float,
    q_delta: np.ndarray,
    issued_at: pd.Timestamp,
    leads: Sequence[int] = HORIZONS_H,
    upstream_rise: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """One ``SpotForecast`` (SPEC §9) from the (calibrated, sorted) level-change quantiles.

    ``spot`` needs ``key``, ``threshold``, ``amber`` and optionally ``mode``
    (``probability`` | ``timing_only``, default ``probability``). ``q_delta`` has shape ``(len(leads), 7)``.
    If ``level_now`` is NaN the spot gets ``leads: []`` and ``arrival: None``.
    """
    mode = spot.get("mode", "probability")
    out: dict[str, Any] = {
        "spot": spot["key"],
        "levelNow": _r(level_now),
        "leads": [],
        "arrival": None,
        "mode": mode,
    }
    if level_now is None or np.isnan(level_now):
        return out
    q = sort_quantiles(q_delta)
    p_amber = exceedance(level_now, q, spot["amber"])
    p_flood = exceedance(level_now, q, spot["threshold"]) if mode == "probability" else None
    for i, h in enumerate(leads):
        if np.isnan(q[i]).any():
            continue
        out["leads"].append(
            {
                "h": int(h),
                "q": {k: _r(level_now + q[i, j]) for j, k in enumerate(QUANT_KEYS)},
                "pFlood": None if p_flood is None else _r(p_flood[i], 4),
                "pAmber": _r(p_amber[i], 4),
            }
        )
    if mode == "probability":
        out["arrival"] = arrival_window(issued_at, leads, p_flood, level_now, spot["threshold"])
    else:
        out["arrival"] = timing_only_arrival(issued_at, leads, q, level_now, spot["amber"], upstream_rise)
    return out
