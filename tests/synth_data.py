"""Synthetic hourly data for model tests: rain drives upstream gauges, which drive osney with a lag.

Long format like data/processed/hourly.parquet (#3): rain as individual rain gauges with ``kind``.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

UPSTREAM = {"farmoor": 30, "eynsham": 24, "cassington": 20, "godstow": 8}  # lag to osney (h)
BASE = {"farmoor": 0.9, "eynsham": 2.5, "cassington": 0.5, "godstow": 2.0, "osney": 2.6}


def _response(rain: np.ndarray, tau: float, gain: float) -> np.ndarray:
    k = np.exp(-np.arange(0, int(10 * tau)) / tau)
    return gain * np.convolve(rain, k)[: len(rain)] / k.sum()


def make_hourly(start: str = "2010-10-01", years: float = 4.0, seed: int = 0) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    ts = pd.date_range(start, periods=int(years * 365.25 * 24), freq="h", tz="UTC")
    n = len(ts)
    doy = ts.day_of_year.to_numpy()
    wet = 0.5 + 0.5 * np.cos(2 * np.pi * (doy - 15) / 365.25)  # wetter in winter
    storms = rng.random(n) < 0.004 * wet
    rain = np.zeros(n)
    for i in np.flatnonzero(storms):
        rain[i : i + 24] += rng.gamma(2.0, 1.5)
    rows = []
    for j, ref in enumerate(["256230TP", "254336TP"]):
        r = np.clip(rain * rng.uniform(0.8, 1.2, n), 0, None)
        if j == 1:
            r[rng.random(n) < 0.05] = np.nan
        rows.append(pd.DataFrame({"gauge": ref, "ts_utc": ts, "kind": "rain", "rain_mm": r}))
    levels: dict[str, np.ndarray] = {}
    for g in UPSTREAM:
        levels[g] = BASE[g] + _response(rain, tau=60, gain=0.4) + rng.normal(0, 0.01, n)
    osney = np.full(n, BASE["osney"])
    for g, lag in UPSTREAM.items():
        up = levels[g] - BASE[g]
        osney[lag:] += 0.3 * up[:-lag]
    levels["osney"] = osney + rng.normal(0, 0.01, n)
    for g, lv in levels.items():
        lv = lv.copy()
        lv[rng.random(n) < 0.01] = np.nan
        rows.append(pd.DataFrame({"gauge": g, "ts_utc": ts, "kind": "level", "level_mean": lv, "level_max": lv + 0.01}))
    df = pd.concat(rows, ignore_index=True)
    df["flagged"] = False
    return df
