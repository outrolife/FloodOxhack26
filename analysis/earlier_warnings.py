"""Earlier warnings: new predictors for the same LightGBM quantile model (issue #134). An experiment only.

Question: can extra inputs make River Clock warn consistently earlier than the EA, without more false
alarms? Same model, splits, params, weights, medians, lags and CQR as ``model.train.train_gauge``
(SPEC §7.3/§7.4; not a second model, SPEC §1.1). Nothing in ``model/`` changes unless a variant passes
the adoption rule; the shipped proof.json is never regenerated here.

Variants (arms)
---------------
- ``baseline``: the shipped models (time split for the test period, leave-one-flood-out for replays).
- ``sm_now`` (BACKTEST ONLY): ERA5-Land soil moisture at t (catchment mean of Eynsham, Enslow, Oxford;
  layers 0-7, 7-28, 28-100 cm), plus its 7-day change. ERA5-Land reaches Open-Meteo about 5-6 days
  late, so live mode cannot have the value at t from this source. It is an analysis of the state at t
  (forced by ERA5 up to t), so the backtest has no future leakage, but it is not a live-honest input.
- ``sm_lag7d`` (LIVE-HONEST): the same soil moisture, but the value at t - 7 days (and its change over
  the 7 days before that). That value is always published by the time t arrives (ERA5-Land latency is
  about 5.5-6 days; probed 24 Oct 2026: last value 18 Oct 23:00 UTC), so live mode reads exactly the
  same source and the backtest is what live would see. Rain since then is already a feature
  (``rain_sum_168h``).
- ``coinc``: Thames/Cherwell coincidence for the Oxford gauges. Thames targets also see the Cherwell
  gauges (enslow, islip) and Kings Mill also sees the Thames gauges (eynsham, cassington): anomaly vs
  their own training-period median at lags {0, 6, 12, 24} h, the 24 h change, and the product of the
  two rivers' positive anomalies (both high at once). Per-gauge anomalies only (CLAUDE.md rule 2).
- ``rain_noise``: rain forecast features (``analysis/rain_experiment.py``, #100) trained on observed
  future rain PLUS noise drawn from the archived ECMWF error, so the model trusts a forecast as much as
  it deserves. The error is estimated per lead window on 2024-01-22 -> 2024-09-30 only; the honest
  evaluation is 2024-10-01 onwards (``RAIN_EVAL_START``), so nothing is tuned on the test events.
  ``rain_mos`` (no retrain): the #100 perfect-prognosis model fed forecasts shrunk towards the
  conditional mean of observed rain (a linear MOS fitted on the same tuning window).

Leakage rule: every extra feature at row t uses only data labelled <= t (for ``sm_lag7d`` <= t - 7 d);
``tests/test_earlier_warnings.py`` perturbs everything after t and checks row t is unchanged.

Usage
-----
``python -m analysis.earlier_warnings fetch``                           (soil moisture cache, data/raw/)
``python -m analysis.earlier_warnings train --arm sm_lag7d [--targets ...] [--lofo]``
``python -m analysis.earlier_warnings evaluate --arms baseline sm_lag7d ... [--events]``
Train one gauge at a time with RC_LGB_THREADS <= 4 (shared machine).
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import sys
import time
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from model import features as F
from model.train import DATA_DIR, MODELS_DIR, GaugeModel

log = logging.getLogger(__name__)

ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
SM_MODEL = "era5_land"
SM_LAYERS: tuple[str, ...] = ("0_to_7cm", "7_to_28cm", "28_to_100cm")
SM_RAW_DIR = DATA_DIR / "raw" / "open_meteo_era5_land"
SM_START_YEAR = 2005  # one spare year before the hourly record (2006) for the 7-day changes and lag
SM_CHANGE_H = 168
SM_LIVE_LAG_H = 168  # ERA5-Land latency ~5.5-6 days, so t - 7 d is always published live
# Live-honest substitute for soil moisture at t: ECMWF IFS HRES analysis (Open-Meteo `ecmwf_ifs`), live
# from api.open-meteo.com and archived from 2017 by the historical-forecast API. It is quantile-mapped
# onto ERA5-Land per layer using 2017-01-01 .. 2021-09-30 only (before the test period) and read at
# t - 12 h (a run is published ~6-8 h after its base time).
IFS_MODEL = "ecmwf_ifs"
IFS_URL = "https://historical-forecast-api.open-meteo.com/v1/forecast"
IFS_RAW_DIR = DATA_DIR / "raw" / "open_meteo_ifs_soil"
IFS_START_YEAR = 2017
IFS_MAP_WINDOW = (pd.Timestamp("2017-01-01", tz="UTC"), pd.Timestamp("2021-09-30 23:00", tz="UTC"))
IFS_AVAIL_LAG_H = 12

COINC_LAGS_H: tuple[int, ...] = (0, 6, 12, 24)
CROSS_UPSTREAMS: dict[str, tuple[str, ...]] = {
    "newbotley": ("enslow", "islip"),
    "minns": ("enslow", "islip"),
    "coldharbour": ("enslow", "islip"),
    "kingsmill": ("eynsham", "cassington"),
}

EXP_DIR = MODELS_DIR / "exp134"
BASELINE_DIR = MODELS_DIR / "baseline"
BASELINE_LOFO_DIR = MODELS_DIR / "lofo_baseline"
RAIN_PP_DIR = MODELS_DIR / "rain"  # #100 perfect-prognosis models (copied from model/rain-features)
OUT_PATH = DATA_DIR / "processed" / "exp134.json"
TARGETS: tuple[str, ...] = ("newbotley", "minns", "coldharbour", "kingsmill")
P_STAR = 0.5
RAIN_FIT = (pd.Timestamp("2024-01-22", tz="UTC"), pd.Timestamp("2024-09-30 23:00", tz="UTC"))
RAIN_EVAL_START = pd.Timestamp("2024-10-01", tz="UTC")
NOISE_BINS_MM: tuple[float, ...] = (0.0, 0.5, 2.0, 5.0, 10.0, 20.0, np.inf)
RATIO_FROM_MM = 2.0
NOISE_BLOCK_H = 12  # one error draw per 12 h block, so successive rows see a coherent forecast error
SEED = 42
RAIN_ARMS: tuple[str, ...] = ("rain_noise", "rain_mos", "rain_noise_sm")


# ---------------------------------------------------------------------------------------------
# Soil moisture: fetch (cached, CLAUDE.md rule 5) and load
# ---------------------------------------------------------------------------------------------


def _points() -> list[tuple[str, float, float]]:
    from stretch.s2_ensemble_rain import load_points

    return load_points()


def fetch_soil_year(year: int, end: pd.Timestamp, refresh: bool = False, source: str = "era5") -> Path:
    """One archive call per year for the three points; past years are cached forever.

    ``source="era5"``: ERA5-Land reanalysis (archive API). ``source="ifs"``: the ECMWF IFS HRES analysis
    as archived by Open-Meteo's historical-forecast API (the first hours of each run, i.e. what the live
    forecast API returns as "current" soil moisture), from 2017.
    """
    a = f"{year}-01-01"
    b = min(pd.Timestamp(f"{year}-12-31"), end.tz_localize(None).normalize()).strftime("%Y-%m-%d")
    model, url, raw = (SM_MODEL, ARCHIVE_URL, SM_RAW_DIR) if source == "era5" else (IFS_MODEL, IFS_URL, IFS_RAW_DIR)
    path = raw / f"{model}_{a}_{b}.json"
    if path.is_file() and not refresh:
        return path
    import requests

    pts = _points()
    params = {
        "latitude": ",".join(f"{lat:.5f}" for _, lat, _ in pts),
        "longitude": ",".join(f"{lon:.5f}" for _, _, lon in pts),
        "hourly": ",".join(f"soil_moisture_{x}" for x in SM_LAYERS),
        "models": model,
        "start_date": a,
        "end_date": b,
        "timezone": "GMT",
    }
    for attempt in range(4):
        r = requests.get(url, params=params, timeout=180)
        if r.status_code == 429:
            time.sleep(30 * (attempt + 1))
            continue
        r.raise_for_status()
        break
    body = r.json()
    body = body if isinstance(body, list) else [body]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(body), encoding="utf-8")
    time.sleep(2.0)  # be polite
    return path


def fetch_soil(end: pd.Timestamp | None = None, refresh: bool = False) -> None:
    end = end or pd.Timestamp.now(tz="UTC")
    for y in range(SM_START_YEAR, end.year + 1):
        # The current year is refetched (it grows); earlier years only if missing.
        p = fetch_soil_year(y, end, refresh=refresh or y == end.year)
        log.info("soil moisture %d: %s", y, p.name)
    for y in range(IFS_START_YEAR, end.year + 1):
        p = fetch_soil_year(y, end, refresh=refresh or y == end.year, source="ifs")
        log.info("IFS soil moisture %d: %s", y, p.name)


def load_soil(raw_dir: Path = SM_RAW_DIR, source: str = "era5") -> pd.DataFrame:
    """Catchment-mean soil moisture (m3/m3) per hour; columns = SM_LAYERS; index = UTC instant.

    Open-Meteo's hourly soil moisture is the state at the stamp. We label it with the stamp itself, so
    the row labelled t (complete at wall clock t + 1 h) uses the state at t: conservative. An hour is NaN
    unless all three points have a value.
    """
    frames = []
    model = SM_MODEL if source == "era5" else IFS_MODEL
    raw_dir = raw_dir if source == "era5" else IFS_RAW_DIR
    for path in sorted(raw_dir.glob(f"{model}_*.json")):
        body = json.loads(path.read_text(encoding="utf-8"))
        stack = []
        idx = None
        for loc in body:
            h = loc["hourly"]
            idx = pd.DatetimeIndex(pd.to_datetime(h["time"])).tz_localize("UTC")
            stack.append(np.column_stack([np.asarray(h[f"soil_moisture_{x}"], dtype=float) for x in SM_LAYERS]))
        arr = np.stack(stack)  # points x hours x layers
        with np.errstate(invalid="ignore"):
            mean = np.where(np.isnan(arr).any(axis=0), np.nan, arr.mean(axis=0))
        frames.append(pd.DataFrame(mean, index=idx, columns=list(SM_LAYERS)))
    if not frames:
        raise FileNotFoundError(f"no soil moisture cache in {raw_dir}; run `fetch` first")
    out = pd.concat(frames).sort_index()
    out = out[~out.index.duplicated(keep="last")]
    out.index.name = "ts_utc"
    return out


# ---------------------------------------------------------------------------------------------
# Feature builders (row t uses only data labelled <= t; tests/test_earlier_warnings.py)
# ---------------------------------------------------------------------------------------------


def _full(index: pd.DatetimeIndex) -> pd.DatetimeIndex:
    return pd.date_range(index.min(), index.max(), freq="h", tz="UTC", name="ts_utc")


def soil_columns(lag_h: int) -> list[str]:
    tag = "now" if lag_h == 0 else f"lag{lag_h // 24}d"
    return [f"sm_{x}_{tag}" for x in SM_LAYERS] + [f"sm_{x}_{tag}_chg7d" for x in SM_LAYERS]


def soil_features(sm: pd.DataFrame, index: pd.DatetimeIndex, lag_h: int = 0) -> pd.DataFrame:
    """Soil moisture at t - lag_h and its change over the 7 days before that, on ``index``.

    Uses only soil moisture stamped <= t - lag_h (a shift on a complete hourly index; missing hours stay
    NaN, never shifted).
    """
    s = sm.sort_index()
    full = _full(s.index.union(index))
    s = s.reindex(full)
    cols = soil_columns(lag_h)
    n = len(SM_LAYERS)
    out = {}
    for i, x in enumerate(SM_LAYERS):
        v = s[x].shift(lag_h)
        out[cols[i]] = v
        out[cols[n + i]] = v - v.shift(SM_CHANGE_H)
    return pd.DataFrame(out, index=full)[cols].reindex(index)


def quantile_map(src: pd.DataFrame, ref: pd.DataFrame, window: tuple[pd.Timestamp, pd.Timestamp]) -> pd.DataFrame:
    """Map each column of ``src`` onto ``ref``'s distribution (empirical quantiles fitted on ``window``).

    A fixed monotone transform per column (fitted on past data only), applied pointwise: the value at t
    depends only on ``src`` at t.
    """
    qs = np.linspace(0, 1, 201)
    out = {}
    for c in src.columns:
        s = src[c][(src.index >= window[0]) & (src.index <= window[1])].dropna()
        r = ref[c][(ref.index >= window[0]) & (ref.index <= window[1])].dropna()
        xs, ys = np.quantile(s, qs), np.quantile(r, qs)
        xs = np.maximum.accumulate(xs + np.arange(len(xs)) * 1e-9)
        out[c] = pd.Series(np.interp(src[c].to_numpy(), xs, ys), index=src.index).where(src[c].notna())
    return pd.DataFrame(out, index=src.index)


def ifs_soil_as_now(ifs: pd.DataFrame, era5: pd.DataFrame, index: pd.DatetimeIndex) -> pd.DataFrame:
    """LIVE-HONEST stand-in for the ``sm_now`` columns: mapped IFS analysis at t - IFS_AVAIL_LAG_H."""
    mapped = quantile_map(ifs, era5, IFS_MAP_WINDOW)
    f = soil_features(mapped, index, IFS_AVAIL_LAG_H)
    f.columns = soil_columns(0)
    return f


def coinc_columns(target: str) -> list[str]:
    cols = []
    for up in CROSS_UPSTREAMS[target]:
        cols += [f"x_{up}_anom_lag{k}h" for k in COINC_LAGS_H] + [f"x_{up}_change_24h"]
    cols += ["coinc_pos_product", "coinc_pos_product_lag12h"]
    return cols


def coinc_features(
    hourly: pd.DataFrame, target: str, medians: Mapping[str, float], index: pd.DatetimeIndex
) -> pd.DataFrame:
    """The other river's upstream anomalies and a both-high product, on ``index`` (row t <= t only).

    ``medians`` holds each gauge's training-period median (``compute_gauge_medians`` with the training
    cutoff), for the cross gauges and for the target's own upstream gauges. The product multiplies the
    positive parts of the mean own-river and mean other-river anomaly at lag 0 (and 12 h).
    """
    own = F.UPSTREAMS[target]
    cross = CROSS_UPSTREAMS[target]
    levels = F.pivot_hourly(F._level_rows(hourly), "level_mean")
    full = _full(levels.index.union(index))
    levels = levels.reindex(full)

    def anom(g: str) -> pd.Series:
        lv = levels[g] if g in levels.columns else pd.Series(np.nan, index=full)
        return lv - medians[g]

    out: dict[str, pd.Series] = {}
    for up in cross:
        a = anom(up)
        for k in COINC_LAGS_H:
            out[f"x_{up}_anom_lag{k}h"] = a.shift(k)
        lv = levels[up] if up in levels.columns else pd.Series(np.nan, index=full)
        out[f"x_{up}_change_24h"] = lv - lv.shift(24)
    own_a = pd.concat([anom(g) for g in own], axis=1).mean(axis=1, skipna=False).clip(lower=0)
    cross_a = pd.concat([anom(g) for g in cross], axis=1).mean(axis=1, skipna=False).clip(lower=0)
    prod = own_a * cross_a
    out["coinc_pos_product"] = prod
    out["coinc_pos_product_lag12h"] = prod.shift(12)
    return pd.DataFrame(out, index=full)[coinc_columns(target)].reindex(index)


# ---------------------------------------------------------------------------------------------
# Rain forecast noise (experiment 2)
# ---------------------------------------------------------------------------------------------


def fit_rain_error(obs: pd.DataFrame, fc: pd.DataFrame, window: tuple[pd.Timestamp, pd.Timestamp]) -> dict:
    """Empirical forecast-minus-observed errors per lead window and observed-rain bin, on ``window``.

    ``obs`` and ``fc`` are the ``observed_future_rain`` / ``forecast_future_rain`` frames (columns =
    RAIN_FEATURES). Only rows whose issue time t is inside ``window`` are used. Returns
    ``{feature: {"edges": [...], "residuals": [array per bin], "mos": (a, b)}}``; ``mos`` is the least-
    squares line obs ~ a + b * fc (for ``rain_mos``).
    """
    from analysis.rain_experiment import RAIN_FEATURES

    out: dict[str, Any] = {}
    for c in RAIN_FEATURES:
        a = pd.concat([obs[c], fc[c]], axis=1, keys=["obs", "fc"]).dropna()
        a = a[(a.index >= window[0]) & (a.index <= window[1])]
        bins = np.digitize(a["obs"].to_numpy(), NOISE_BINS_MM[1:-1])
        res = []
        for b in range(len(NOISE_BINS_MM) - 1):
            sel = bins == b
            if NOISE_BINS_MM[b] >= RATIO_FROM_MM:  # wet: the error scales with the rain, keep fc / obs
                r = (a["fc"] / a["obs"]).to_numpy()[sel]
            else:  # (nearly) dry: additive error, fc - obs
                r = (a["fc"] - a["obs"]).to_numpy()[sel]
            if len(r) < 20 and res:  # too few heavy-rain cases: borrow the bin below
                r = res[-1]
            res.append(np.sort(r))
        b_, a_ = np.polyfit(a["fc"].to_numpy(), a["obs"].to_numpy(), 1)
        out[c] = {"edges": list(NOISE_BINS_MM), "residuals": res, "mos": (float(a_), float(b_)), "n": len(a)}
    return out


def noisy_future_rain(obs: pd.DataFrame, err: Mapping[str, Any], seed: int = SEED) -> pd.DataFrame:
    """TRAINING ONLY: observed future rain + an error drawn from the archived forecast's error.

    For each lead window, an error quantile u is drawn per NOISE_BLOCK_H block (all rows in a block share
    it), then the error at quantile u of the row's observed-rain bin is applied: a ratio fc / obs for
    bins from RATIO_FROM_MM up (so the heavy-rain under-forecast is reproduced: shrink + noise), an
    additive fc - obs below; values are clipped at 0. Fixed seed. Like ``observed_future_rain``
    this uses observed rain after t, so it is for fitting only.
    """
    rng = np.random.default_rng(seed)
    blocks = ((obs.index - obs.index[0]) // pd.Timedelta(hours=NOISE_BLOCK_H)).to_numpy()
    nb = int(blocks.max()) + 1
    out = {}
    for c in obs.columns:
        e = err[c]
        u = rng.random(nb)[blocks]
        x = obs[c].to_numpy(dtype=float)
        bins = np.digitize(np.nan_to_num(x), np.asarray(e["edges"][1:-1]))
        y = x.copy()
        for b, r in enumerate(e["residuals"]):
            m = bins == b
            if m.any() and len(r):
                d = np.quantile(r, u[m])
                y[m] = x[m] * d if e["edges"][b] >= RATIO_FROM_MM else x[m] + d
        out[c] = np.clip(y, 0, None)
    df = pd.DataFrame(out, index=obs.index)
    df.attrs["uses_future_observations"] = True
    return df


def mos_future_rain(fc: pd.DataFrame, err: Mapping[str, Any]) -> pd.DataFrame:
    """HONEST: archived forecast mapped to E[observed | forecast] with the tuning-window line."""
    out = {}
    for c in fc.columns:
        a, b = err[c]["mos"]
        out[c] = (a + b * fc[c]).clip(lower=0)
    df = pd.DataFrame(out, index=fc.index)
    df.attrs["uses_future_observations"] = False
    return df


# ---------------------------------------------------------------------------------------------
# Model wrapper and training
# ---------------------------------------------------------------------------------------------


class WithExtra:
    """A GaugeModel trained with extra columns; joins them by issue-row time inside ``predict``.

    Works with ``model.backtest.forecasts_at`` (it builds the base features at row t - 1 h and calls
    ``predict``) and with ``analysis.rain_experiment.score_variant``.
    """

    def __init__(self, model: GaugeModel, extra: pd.DataFrame) -> None:
        self.m = model
        self.extra = extra
        self.target, self.medians, self.lags = model.target, model.medians, model.lags
        self.amber, self.threshold, self.splits = model.amber, model.threshold, model.splits

    def persistence(self, n: int) -> dict[int, np.ndarray]:
        return self.m.persistence(n)

    def predict(self, X: pd.DataFrame, calibrated: bool = True) -> dict[int, np.ndarray]:
        Xr = X.drop(columns=[c for c in self.extra.columns if c in X.columns]).join(self.extra.reindex(X.index))
        return self.m.predict(Xr, calibrated)


def train_with_extra(
    hourly: pd.DataFrame,
    target: str,
    lags: Any,
    extra_fn: Callable[[pd.DataFrame, str, Mapping[str, float], pd.DatetimeIndex], pd.DataFrame],
    exclude_windows: Sequence[tuple[pd.Timestamp, pd.Timestamp]] = (),
    **fit_kwargs: Any,
) -> GaugeModel:
    """``model.train.train_gauge`` plus the columns from ``extra_fn(hourly, target, medians, index)``."""
    from model.calibrate import event_mask
    from model.train import _iso, build_xy, choose_splits, fit_gauge, fit_medians, gauge_lines, windows_mask

    lines = gauge_lines(target)
    lv = hourly[hourly["gauge"] == target]
    ts = lv.loc[lv["level_mean"].notna(), "ts_utc"]
    splits = choose_splits(ts.min(), ts.max())
    medians = fit_medians(hourly, target, splits.val_start)
    X, Y = build_xy(hourly, target, medians, lags)
    extra = extra_fn(hourly, target, medians, X.index)
    X = X.join(extra)
    lmax = lv.set_index("ts_utc")["level_max"].reindex(X.index)
    events = event_mask(lmax.fillna(X["level_now"]), lines["amber"])
    excl = windows_mask(X.index, exclude_windows)
    m = fit_gauge(
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
    m.info["extraFeatures"] = list(extra.columns)
    return m


def cross_medians(hourly: pd.DataFrame, target: str, val_start: pd.Timestamp) -> dict[str, float]:
    """Training-period medians for the target's own and cross-river gauges (no leakage)."""
    gauges = list(F.UPSTREAMS[target]) + list(CROSS_UPSTREAMS[target])
    return F.compute_gauge_medians(hourly, val_start - pd.Timedelta(hours=1), gauges=gauges)


class Arm:
    """How one variant builds its extra columns (for training, and the honest columns for inference)."""

    def __init__(self, name: str) -> None:
        self.name = name
        self._sm: pd.DataFrame | None = None
        self._rain: dict[str, Any] = {}

    def soil(self) -> pd.DataFrame:
        if self._sm is None:
            self._sm = load_soil()
        return self._sm

    def train_extra(self, hourly: pd.DataFrame, target: str, medians: Mapping[str, float], index: pd.DatetimeIndex):
        return self.extra(hourly, target, index, training=True)

    def extra(self, hourly: pd.DataFrame, target: str, index: pd.DatetimeIndex, training: bool = False) -> pd.DataFrame:
        if self.name == "sm_now" or (self.name == "sm_ifs" and training):
            return soil_features(self.soil(), index, 0)
        if self.name == "sm_ifs":  # the sm_now models, fed the live-available IFS analysis
            if "ifs" not in self._rain:
                self._rain["ifs"] = load_soil(source="ifs")
            return ifs_soil_as_now(self._rain["ifs"], self.soil(), index)
        if self.name == "sm_lag7d":
            return soil_features(self.soil(), index, SM_LIVE_LAG_H)
        if self.name == "coinc":
            from model.train import DEFAULT_SPLITS

            med = cross_medians(hourly, target, DEFAULT_SPLITS.val_start)
            return coinc_features(hourly, target, med, index)
        if self.name == "rain_noise_sm":  # PM order (#134): noise-aware rain together with soil moisture
            sm = soil_features(self.soil(), index, SM_LIVE_LAG_H)
            return Arm("rain_noise").extra(hourly, target, index, training).join(sm)
        if self.name in ("rain_noise", "rain_mos"):
            from analysis import rain_experiment as RE

            rain_obs = hourly[hourly["gauge"] == RE.RAIN_KEY].set_index("ts_utc")["rain_mm"]
            if "obs" not in self._rain:
                self._rain["obs"] = RE.observed_future_rain(rain_obs)
                self._rain["fc"] = RE.forecast_future_rain(RE.load_forecast_archive())
                self._rain["err"] = fit_rain_error(self._rain["obs"], self._rain["fc"], RAIN_FIT)
            if training:
                return noisy_future_rain(self._rain["obs"], self._rain["err"]).reindex(index)
            if self.name == "rain_mos":
                return mos_future_rain(self._rain["fc"], self._rain["err"]).reindex(index)
            return self._rain["fc"].reindex(index)
        raise ValueError(f"unknown arm {self.name}")


# ---------------------------------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------------------------------


def arm_dir(arm: str, event_id: str | None = None) -> Path:
    if arm == "baseline":
        return BASELINE_DIR if event_id is None else BASELINE_LOFO_DIR / event_id
    if arm == "rain_mos":
        return RAIN_PP_DIR if event_id is None else EXP_DIR / "rain_pp_lofo" / event_id
    if arm == "sm_ifs":
        arm = "sm_now"
    return EXP_DIR / arm if event_id is None else EXP_DIR / f"{arm}_lofo" / event_id


def load_arm(arm: str, hourly: pd.DataFrame, event_id: str | None = None, a: Arm | None = None) -> dict[str, Any]:
    d = arm_dir(arm, event_id)
    models = {g: GaugeModel.load(d / g) for g in TARGETS if (d / g / "meta.json").exists()}
    if arm == "baseline":
        return models
    a = a or Arm(arm)
    out = {}
    for g, m in models.items():
        X = F.build_features(hourly, g, m.medians, m.lags)
        out[g] = WithExtra(m, a.extra(hourly, g, X.index))
    return out


def event_block(
    name: str, per_event_models: Mapping[str, Mapping[str, Any]], hourly: pd.DataFrame, spots: Sequence[Any]
) -> dict[str, Any]:
    """Replays for the given events (models per event) and the proof.json event scores (all floods)."""
    from model import backtest, proof

    events = backtest.load_events()
    hr = hourly.copy()
    hr["level_mean"] = hr["level_mean"].round(3)  # as model.proof._replay_job
    replays = {}
    for eid, models in per_event_models.items():
        every = proof.REPLAY_EVERY_H.get(eid, 1)
        replays[eid] = proof.consistent_arrivals(
            backtest.build_replay(hr, models, eid, events[eid], spots, every_h=every), spots
        )
    ev = proof.event_scores(replays, {e: events[e] for e in replays}, spots, hourly, proof.load_warnings())
    p50 = {k: next(x for x in v if np.isclose(x["pStar"], P_STAR)) for k, v in ev["tradeoff"].items()}
    per = [
        {k: r[k] for k in ("eventId", "spot", "crossed", "leadVsOfficialH")}
        for r in ev["perEvent"]
        if r["crossed"]
    ]
    return {"variant": name, "events": list(replays), "tradeoffP50": p50, "officialOutcome": ev["officialOutcome"],
            "perEvent": per}


def models_per_event(arm: str, hourly: pd.DataFrame, event_ids: Sequence[str]) -> dict[str, Any]:
    from model import backtest, proof

    events = backtest.load_events()
    a = Arm(arm)
    main = load_arm(arm, hourly, None, a)
    out = {}
    for eid in event_ids:
        if proof.in_test_period(events[eid]):
            out[eid] = main
        else:
            out[eid] = load_arm(arm, hourly, eid, a)
            if len(out[eid]) < len(TARGETS):
                raise FileNotFoundError(f"{arm}: leave-one-out models for {eid} missing; train with --lofo")
    return out


def evaluate(arms: Sequence[str], with_events: bool, rain_window: bool) -> dict[str, Any]:
    from analysis.rain_experiment import score_variant
    from model import backtest
    from model.train import build_xy, load_hourly

    hourly = load_hourly()
    spots = backtest.load_spots()
    base = load_arm("baseline", hourly)
    test_start = base[TARGETS[0]].splits.test_start
    end = hourly["ts_utc"].max()
    rows_full, rows_rain = {}, {}
    for g in TARGETS:
        X, _ = build_xy(hourly, g, base[g].medians, base[g].lags)
        ok = X["level_now"].notna()
        rows_full[g] = X.index[(ok & (X.index >= test_start)).to_numpy()]
        rows_rain[g] = X.index[(ok & (X.index >= RAIN_EVAL_START)).to_numpy()]
    out: dict[str, Any] = {"issue": 134, "testStart": str(test_start), "rainEvalStart": str(RAIN_EVAL_START),
                           "testPeriod": [], "rainWindow": [], "events": [], "testEvents": []}
    for arm in arms:
        t0 = time.time()
        models = load_arm(arm, hourly)
        if arm not in RAIN_ARMS:
            out["testPeriod"].append(score_variant(arm, models, hourly, spots, rows_full, (test_start, end)))
        if rain_window:
            out["rainWindow"].append(score_variant(arm, models, hourly, spots, rows_rain, (RAIN_EVAL_START, end)))
        test_ev = ("e2024b", "e2026") if arm in RAIN_ARMS else ("e2024a", "e2024b", "e2026")
        out["testEvents"].append(event_block(arm, {e: models for e in test_ev}, hourly, spots))
        if with_events and arm not in RAIN_ARMS:
            try:
                pem = models_per_event(arm, hourly, list(backtest.load_events()))
                out["events"].append(event_block(arm, pem, hourly, spots))
            except FileNotFoundError as e:
                log.warning("%s", e)
        log.info("evaluated %s in %.0f s", arm, time.time() - t0)
    return out


def report(res: Mapping[str, Any]) -> str:
    lines = []
    for block in ("testPeriod", "rainWindow"):
        if not res.get(block):
            continue
        lines.append(f"\n## {block}")
        for v in res[block]:
            sk = " ".join(f"{r['h']}h {r['skill']:+.3f}" for r in v["skill"])
            cv = " ".join(f"{h}h {c['event90']:.2f}" for h, c in v["coverage"].items())
            lines.append(f"{v['variant']:11s} skill: {sk}")
            lines.append(f"{'':11s} cov90 in-event: {cv}")
            for spot, br in v["brier"].items():
                o = v["outcomesP50"][spot]
                lines.append(
                    f"{'':11s} {spot}: Brier 24/48/72 {br[24]:.4f}/{br[48]:.4f}/{br[72]:.4f}; "
                    f"p*=0.5 hits {o['hits']} miss {o['misses']} FA {o['falseAlarms']} lead {o['meanLeadH']}"
                )
    for block in ("testEvents", "events"):
        lines.append(f"\n## {block} (replays, p* = 0.5)")
        for v in res.get(block, []):
            lines.append(f"{v['variant']} on {','.join(v['events'])}:")
            for spot, r in v["tradeoffP50"].items():
                oo = v["officialOutcome"].get(spot, {})
                lines.append(
                    f"   {spot}: hits {r['hits']} miss {r['misses']} FA {r['falseAlarms']} lead {r['meanLeadH']} "
                    f"vsEA {r['meanLeadVsOfficialH']} | EA hits {oo.get('hits')} FA {oo.get('falseAlarms')}"
                )
            for p in v["perEvent"]:
                lines.append(f"      {p['eventId']} {p['spot']}: vsEA {p['leadVsOfficialH']}")
    return "\n".join(lines)


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("fetch")
    f.add_argument("--refresh", action="store_true")
    t = sub.add_parser("train")
    t.add_argument("--arm", required=True, choices=["sm_now", "sm_lag7d", "coinc", "rain_noise", "rain_noise_sm"])
    t.add_argument("--targets", nargs="+", default=list(TARGETS))
    t.add_argument("--lofo", action="store_true", help="leave-one-flood-out models for the pre-test events")
    t.add_argument("--events", nargs="+", default=None)
    e = sub.add_parser("evaluate")
    e.add_argument("--arms", nargs="+", default=["baseline"])
    e.add_argument("--events", action="store_true", help="all-event replays (needs LOFO models)")
    e.add_argument("--rain-window", action="store_true")
    e.add_argument("--out", default=str(OUT_PATH))
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    if args.cmd == "fetch":
        fetch_soil(refresh=args.refresh)
        sm = load_soil()
        log.info("soil moisture %s .. %s, %d rows, NaN %s", sm.index.min(), sm.index.max(), len(sm),
                 sm.isna().sum().to_dict())
        return 0
    if args.cmd == "train":
        from model import backtest, proof
        from model.train import load_hourly, load_lags

        hourly, lags = load_hourly(), load_lags()
        arm = Arm(args.arm)
        if not args.lofo:
            jobs = [(None, ())]
        else:
            events = backtest.load_events()
            ids = args.events or [e for e in events if not proof.in_test_period(events[e])]
            jobs = []
            for eid in ids:
                s, en = backtest.event_window(events[eid])
                jobs.append((eid, [(s - backtest.LOFO_MARGIN, en + backtest.LOFO_MARGIN)]))
        for eid, excl in jobs:
            for g in args.targets:
                d = arm_dir(args.arm, eid) / g
                if (d / "meta.json").exists():
                    log.info("skip %s (exists)", d)
                    continue
                t0 = time.time()
                m = train_with_extra(hourly, g, lags, arm.train_extra, exclude_windows=excl)
                m.save(d)
                log.info("saved %s in %.0f s", d, time.time() - t0)
        return 0
    res = evaluate(args.arms, args.events, args.rain_window)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(res, indent=1, default=str), encoding="utf-8")
    print(report(res))
    return 0


if __name__ == "__main__":
    sys.exit(main())
