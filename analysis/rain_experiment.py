"""Rain-forecast features by perfect prognosis: an experiment, not part of the shipped model (issue #100).

Question: does adding *forecast* catchment rain over the next 0-24, 24-48 and 48-72 h to the same
LightGBM quantile model (SPEC §7.3; not a second model, SPEC §1.1) give earlier warnings at 36-72 h?

!! PERFECT PROGNOSIS: READ THIS BEFORE USING ANYTHING HERE !!
-----------------------------------------------------------
The three ``rain_next_*`` features are, by construction, about the FUTURE relative to the issue time t.

- **Training** (and the "upper bound" score) fills them with the OBSERVED catchment rain
  (``rain_catchment`` in hourly.parquet) in those future windows. That is perfect prognosis: the model
  learns "how does the river respond to rain that will fall", from rain that did fall. It is allowed
  ONLY for fitting, and for a score that is labelled "perfect rainfall forecast: upper bound".
- **Honest evaluation and live use** must fill them with a rain FORECAST issued at or before t, never
  observed rain after t. Here: the Open-Meteo Previous Runs archive (``previous-runs-api``), where
  ``precipitation_previous_dayN`` is "the value predicted N x 24 h before valid time". It starts in
  about January 2024, so the honest test only covers 2024-01-22 onwards (e2024b and e2026, not e2024a).
- ``observed_future_rain`` marks its frame ``attrs["uses_future_observations"] = True``; the honest
  builder ``forecast_future_rain`` marks it False and never reads observed rain at all.

Honest construction (``forecast_future_rain``)
----------------------------------------------
An hourly row labelled t (hour start) is complete, and the forecast is issued, at wall clock
``tau = t + 1 h`` (the convention in model/features.py). The k-th future hour is the one labelled
``t + k`` (rain in [t+k, t+k+1), stamped ``t+k+1`` by Open-Meteo, whose hourly precipitation is the rain
in the hour *ending* at the stamp). Its value comes from ``previous_day_d`` with
``d = ceil((k + 6) / 24)``. That run was issued at least ``24 d`` h before the end of the hour, so at
least 6 h before tau: a buffer for the time a run takes to appear. This is conservative (an operational
system would use a slightly fresher run), so the honest score slightly understates what is possible.

Catchment rain = mean over three points (Eynsham, Enslow, Oxford; the same points as S2) of the grid
precipitation. The training feature is the mean of the EA tipping-bucket gauges instead. That
mismatch is inherent in perfect prognosis and is part of what the honest score measures.

Usage
-----
``python -m analysis.rain_experiment fetch`` (cache the archive under data/raw/open_meteo_previous_runs/)
``python -m analysis.rain_experiment train [--targets ...]`` (one gauge at a time, RC_LGB_THREADS<=3)
``python -m analysis.rain_experiment evaluate`` (writes data/processed/rain_experiment.json)
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import os
import sys
import time
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from model.train import DATA_DIR, MODELS_DIR, GaugeModel

log = logging.getLogger(__name__)

API_URL = "https://previous-runs-api.open-meteo.com/v1/forecast"
FC_MODELS: tuple[str, ...] = ("ecmwf_ifs025", "ecmwf_ifs04", "gfs_seamless", "icon_seamless")
PRIMARY = "ecmwf"  # ecmwf_ifs025 where present, else ecmwf_ifs04 (same model, two grids)
MAX_DAY = 4  # previous_day1..4 (k up to 72 with the 6 h buffer needs day 4)
AVAIL_BUFFER_H = 6  # a run counts as available 6 h after its issue time
ARCHIVE_START = pd.Timestamp("2024-01-22", tz="UTC")  # first full day with previous_day1..3 (probed)
FETCH_START = "2024-01-01"
RAW_DIR = DATA_DIR / "raw" / "open_meteo_previous_runs"
RAIN_MODELS_DIR = MODELS_DIR / "rain"
BASELINE_DIR = Path(os.environ.get("RC_BASELINE_MODELS", MODELS_DIR / "baseline"))
OUT_PATH = DATA_DIR / "processed" / "rain_experiment.json"
RAIN_KEY = "rain_catchment"
MIN_COVERAGE = 0.9

# (feature name, first future hour k, last future hour k), k = 1 is the hour labelled t + 1.
WINDOWS: tuple[tuple[str, int, int], ...] = (
    ("rain_next_0_24h", 1, 24),
    ("rain_next_24_48h", 25, 48),
    ("rain_next_48_72h", 49, 72),
)
RAIN_FEATURES: tuple[str, ...] = tuple(w[0] for w in WINDOWS)
TARGETS: tuple[str, ...] = ("newbotley", "minns", "coldharbour", "kingsmill")
TEST_EVENTS: tuple[str, ...] = ("e2024a", "e2024b", "e2026")
P_STAR = 0.5


def day_offset(k: int, buffer_h: int = AVAIL_BUFFER_H) -> int:
    """``previous_day`` offset for the k-th future hour: the run was issued >= buffer_h before tau."""
    return math.ceil((k + buffer_h) / 24)


# ---------------------------------------------------------------------------------------------
# Fetch (cached, CLAUDE.md rule 5)
# ---------------------------------------------------------------------------------------------


def _points() -> list[tuple[str, float, float]]:
    from stretch.s2_ensemble_rain import load_points

    return load_points()


def fetch_chunk(model: str, start: str, end: str, refresh: bool = False) -> list[dict[str, Any]]:
    """One API call for the three points and one date range, cached as JSON."""
    path = RAW_DIR / f"{model}_{start}_{end}.json"
    if path.is_file() and not refresh:
        return json.loads(path.read_text(encoding="utf-8"))
    import requests

    pts = _points()
    hourly = ",".join(f"precipitation_previous_day{d}" for d in range(1, MAX_DAY + 1))
    params = {
        "latitude": ",".join(f"{lat:.5f}" for _, lat, _ in pts),
        "longitude": ",".join(f"{lon:.5f}" for _, _, lon in pts),
        "hourly": hourly,
        "models": model,
        "start_date": start,
        "end_date": end,
        "timezone": "GMT",
    }
    r = requests.get(API_URL, params=params, timeout=120)
    r.raise_for_status()
    body = r.json()
    body = body if isinstance(body, list) else [body]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(body), encoding="utf-8")
    time.sleep(1.0)  # be polite
    return body


def _chunks(end: pd.Timestamp) -> list[tuple[str, str]]:
    out = []
    y0 = pd.Timestamp(FETCH_START).year
    for y in range(y0, end.year + 1):
        a = max(pd.Timestamp(f"{y}-01-01"), pd.Timestamp(FETCH_START))
        b = min(pd.Timestamp(f"{y}-12-31"), end.tz_localize(None).normalize())
        out.append((a.strftime("%Y-%m-%d"), b.strftime("%Y-%m-%d")))
    return out


def fetch_all(end: pd.Timestamp, models: Sequence[str] = FC_MODELS, refresh: bool = False) -> None:
    for m in models:
        for a, b in _chunks(end):
            body = fetch_chunk(m, a, b, refresh)
            n = sum(v is not None for v in body[0]["hourly"]["precipitation_previous_day1"])
            log.info("%s %s..%s: %d hourly day1 values at point 1", m, a, b, n)


def load_archive(model: str) -> pd.DataFrame:
    """Catchment-mean forecast rain per hour: index = our hour label (stamp - 1 h), columns d1..d4.

    An hour is NaN for offset d unless all three points have a value (no under-counting).
    """
    frames = []
    for path in sorted(RAW_DIR.glob(f"{model}_*.json")):
        body = json.loads(path.read_text(encoding="utf-8"))
        per_point = []
        for loc in body:
            h = loc["hourly"]
            idx = pd.DatetimeIndex(pd.to_datetime(h["time"])).tz_localize("UTC") - pd.Timedelta(hours=1)
            cols = {f"d{d}": h[f"precipitation_previous_day{d}"] for d in range(1, MAX_DAY + 1)}
            per_point.append(pd.DataFrame(cols, index=idx, dtype=float))
        stack = np.stack([p.to_numpy() for p in per_point])  # points x hours x days
        with np.errstate(invalid="ignore"):
            mean = np.where(np.isnan(stack).any(axis=0), np.nan, stack.mean(axis=0))
        frames.append(
            pd.DataFrame(np.clip(mean, 0, None), index=per_point[0].index, columns=per_point[0].columns)
        )
    if not frames:
        raise FileNotFoundError(f"no cached archive for {model} in {RAW_DIR}; run `fetch` first")
    out = pd.concat(frames).sort_index()
    out = out[~out.index.duplicated(keep="last")]
    out.index.name = "ts_utc"
    return out


def load_forecast_archive(name: str = PRIMARY) -> pd.DataFrame:
    """``ecmwf``: IFS 0.25 deg where present, else IFS 0.4 deg (per hour and offset); else one model."""
    if name != "ecmwf":
        return load_archive(name)
    a = load_archive("ecmwf_ifs025")
    b = load_archive("ecmwf_ifs04")
    idx = a.index.union(b.index)
    return a.reindex(idx).combine_first(b.reindex(idx))


# ---------------------------------------------------------------------------------------------
# Features
# ---------------------------------------------------------------------------------------------


def _full_index(index: pd.DatetimeIndex) -> pd.DatetimeIndex:
    return pd.date_range(index.min(), index.max(), freq="h", tz="UTC", name="ts_utc")


def _forward_sum(per_k: Mapping[int, pd.Series], k0: int, k1: int) -> pd.Series:
    """Sum over k = k0..k1 of per_k[k] (already aligned to row t); NaN below MIN_COVERAGE."""
    mat = np.column_stack([per_k[k].to_numpy(dtype=float) for k in range(k0, k1 + 1)])
    n_ok = np.isfinite(mat).sum(axis=1)
    total = np.nansum(mat, axis=1) * (k1 - k0 + 1) / np.maximum(n_ok, 1)  # scale up small gaps
    total[n_ok < math.ceil(MIN_COVERAGE * (k1 - k0 + 1))] = np.nan
    return pd.Series(total, index=next(iter(per_k.values())).index)


def observed_future_rain(rain: pd.Series, index: pd.DatetimeIndex | None = None) -> pd.DataFrame:
    """PERFECT PROGNOSIS, TRAINING / UPPER BOUND ONLY: observed catchment rain in the next windows.

    Row t holds the OBSERVED rain summed over the hours labelled t+k0 .. t+k1. This looks into the
    future on purpose. Never use it at inference except for a score labelled as an upper bound.
    """
    s = rain.sort_index()
    idx = _full_index(s.index) if index is None else index
    s = s.reindex(_full_index(s.index.union(idx)))
    per_k = {k: s.shift(-k).reindex(idx) for k in range(1, WINDOWS[-1][2] + 1)}
    out = pd.DataFrame({name: _forward_sum(per_k, k0, k1) for name, k0, k1 in WINDOWS}, index=idx)
    out.attrs["uses_future_observations"] = True
    out.attrs["label"] = "perfect rainfall forecast (observed future rain): training / upper bound only"
    return out


def forecast_future_rain(
    archive: pd.DataFrame, index: pd.DatetimeIndex | None = None, buffer_h: int = AVAIL_BUFFER_H
) -> pd.DataFrame:
    """HONEST: forecast rain in the next windows, from runs issued >= ``buffer_h`` before tau = t + 1 h.

    ``archive`` is ``load_forecast_archive()``: index = hour label, columns d1..d4. The k-th future hour
    of row t is the hour labelled t + k, read from column ``d{day_offset(k)}``. No observed rain is used.
    """
    a = archive.sort_index()
    idx = _full_index(a.index) if index is None else index
    a = a.reindex(_full_index(a.index.union(idx)))
    per_k = {}
    for k in range(1, WINDOWS[-1][2] + 1):
        d = day_offset(k, buffer_h)
        if f"d{d}" not in a.columns:
            raise ValueError(f"archive needs previous_day{d} for k={k}")
        per_k[k] = a[f"d{d}"].shift(-k).reindex(idx)
    out = pd.DataFrame({name: _forward_sum(per_k, k0, k1) for name, k0, k1 in WINDOWS}, index=idx)
    out.attrs["uses_future_observations"] = False
    out.attrs["label"] = f"archived forecast, issued >= {buffer_h} h before the forecast time"
    return out


def issue_time_upper_bound(label: pd.Timestamp, d: int) -> pd.Timestamp:
    """Latest possible issue time of the archive value at hour ``label`` with offset ``d``.

    The hour ends at ``label + 1 h``; previous_day d was predicted >= 24 d h before that.
    """
    return label + pd.Timedelta(hours=1) - pd.Timedelta(hours=24 * d)


# ---------------------------------------------------------------------------------------------
# Model wrapper: same GaugeModel, extra columns joined at predict time
# ---------------------------------------------------------------------------------------------


class WithRain:
    """Wraps a GaugeModel trained with rain features so ``model.backtest.forecasts_at`` works as is.

    ``rain`` is a feature frame on the hourly index (observed future for the upper bound, archived
    forecast for the honest score); it is joined to X by issue time inside ``predict``.
    """

    def __init__(self, model: GaugeModel, rain: pd.DataFrame) -> None:
        self.m = model
        self.rain = rain
        self.target, self.medians, self.lags = model.target, model.medians, model.lags

    def predict(self, X: pd.DataFrame, calibrated: bool = True) -> dict[int, np.ndarray]:
        Xr = X.drop(columns=[c for c in RAIN_FEATURES if c in X.columns]).join(self.rain.reindex(X.index))
        return self.m.predict(Xr, calibrated)


# ---------------------------------------------------------------------------------------------
# Training (perfect prognosis)
# ---------------------------------------------------------------------------------------------


def train_rain_gauge(hourly: pd.DataFrame, target: str, lags: Any, **fit_kwargs: Any) -> GaugeModel:
    """``model.train.train_gauge`` with the observed-future rain columns added (perfect prognosis).

    Same splits, medians, weights, early stopping and CQR calibration as the shipped model; the only
    change is three extra feature columns. Validation/calibration also use observed future rain (as in
    any perfect-prognosis fit); the test period is never touched here.
    """
    from model.calibrate import event_mask
    from model.train import build_xy, choose_splits, fit_gauge, fit_medians, gauge_lines

    lines = gauge_lines(target)
    lv = hourly[hourly["gauge"] == target]
    ts = lv.loc[lv["level_mean"].notna(), "ts_utc"]
    splits = choose_splits(ts.min(), ts.max())
    medians = fit_medians(hourly, target, splits.val_start)
    X, Y = build_xy(hourly, target, medians, lags)
    rain = hourly[hourly["gauge"] == RAIN_KEY].set_index("ts_utc")["rain_mm"]
    X = X.join(observed_future_rain(rain, X.index))
    lmax = lv.set_index("ts_utc")["level_max"].reindex(X.index)
    events = event_mask(lmax.fillna(X["level_now"]), lines["amber"])
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
        **fit_kwargs,
    )
    m.info["rainFeatures"] = {
        "columns": list(RAIN_FEATURES),
        "training": "perfect prognosis: observed rain_catchment in the future windows",
    }
    return m


# ---------------------------------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------------------------------


def _quantiles(model: Any, X: pd.DataFrame) -> dict[int, np.ndarray]:
    return model.predict(X)


def _p_flood(
    level_now: np.ndarray, q: Mapping[int, np.ndarray], thr: float, leads: Sequence[int]
) -> np.ndarray:
    """Max over leads of the non-decreasing P(level > thr): the trigger value (metrics.spot_probability)."""
    from model.probability import exceedance

    qm = np.stack([q[h] for h in leads], axis=1)
    p = exceedance(level_now[:, None, None], qm, thr)
    pmax = np.nanmax(np.where(np.isnan(p), -np.inf, p), axis=1)
    pmax = np.where(np.isfinite(pmax), pmax, np.nan)
    return np.where(level_now >= thr, np.nan, np.round(pmax, 3))


def _crossings(level: pd.Series, thr: float) -> list[pd.Timestamp]:
    lv = level.dropna()
    above = lv >= thr
    up = above & ~above.shift(1, fill_value=True)
    return list(lv.index[up.to_numpy()])


def score_variant(
    name: str,
    models: Mapping[str, Any],
    hourly: pd.DataFrame,
    spots: Sequence[Mapping[str, Any]],
    rows: Mapping[str, pd.DatetimeIndex],
    period: tuple[pd.Timestamp, pd.Timestamp],
) -> dict[str, Any]:
    """Pinball skill, coverage (all / in-event), Brier per spot, and whole-period event outcomes."""
    from model import metrics
    from model.calibrate import event_mask
    from model.probability import HORIZONS_H
    from model.train import build_xy

    pooled = {k: {h: [] for h in HORIZONS_H} for k in ("m", "p", "y", "ev")}
    brier: dict[str, dict[int, float]] = {}
    outcomes: dict[str, Any] = {}
    for g, m in models.items():
        X, Y = build_xy(hourly, g, m.medians, m.lags)
        X, Y = X.reindex(rows[g]), Y.reindex(rows[g])
        q = _quantiles(m, X)
        base = m.m if isinstance(m, WithRain) else m
        qp = base.persistence(len(X))
        lv = hourly[hourly["gauge"] == g].set_index("ts_utc")
        ev = event_mask(lv["level_max"].reindex(X.index).fillna(X["level_now"]), base.amber).to_numpy()
        for h in HORIZONS_H:
            pooled["m"][h].append(q[h])
            pooled["p"][h].append(qp[h])
            pooled["y"][h].append(Y[f"y_{h}h"].to_numpy(dtype=float))
            pooled["ev"][h].append(ev)
        level_now = X["level_now"].to_numpy(dtype=float)
        for s in spots:
            if s["gauge"] != g or s.get("mode") != "probability" or s.get("threshold") is None:
                continue
            thr = float(s["threshold"])
            br = {}
            from model.probability import exceedance

            pm = exceedance(level_now[:, None, None], np.stack([q[h] for h in HORIZONS_H], 1), thr)
            for i, h in enumerate(HORIZONS_H):
                o = metrics.exceedance_outcome(level_now + Y[f"y_{h}h"].to_numpy(dtype=float), thr)
                br[h] = round(metrics.brier_score(pm[:, i], o), 5)
            brier[s["key"]] = br
            p = pd.Series(_p_flood(level_now, q, thr, HORIZONS_H), index=X.index)
            level = lv["level_mean"]
            level = level[(level.index >= period[0]) & (level.index <= period[1])]
            cross = metrics.flood_onsets(_crossings(level, thr))
            res = metrics.event_outcomes(metrics.trigger_times(p, P_STAR), cross)
            outcomes[s["key"]] = {
                "hits": res["hits"],
                "misses": res["misses"],
                "falseAlarms": res["falseAlarms"],
                "meanLeadH": metrics.mean_or_none(res["leads"]),
                "crossings": [{"t": str(c["t"]), "leadH": c["leadH"]} for c in res["crossings"]],
            }
    cat = {k: {h: np.concatenate(v[h]) for h in HORIZONS_H} for k, v in pooled.items()}
    skill = metrics.skill_by_lead(cat["m"], cat["p"], cat["y"])
    cov = {}
    for h in HORIZONS_H:
        evm = cat["ev"][h].astype(bool)
        cov[h] = {
            "all90": round(metrics.interval_coverage(cat["m"][h], cat["y"][h])[0.9], 4),
            "event90": round(metrics.interval_coverage(cat["m"][h][evm], cat["y"][h][evm])[0.9], 4),
        }
    return {"variant": name, "skill": skill, "coverage": cov, "brier": brier, "outcomesP50": outcomes}


def event_variant(
    name: str,
    models: Mapping[str, Any],
    hourly: pd.DataFrame,
    spots: Sequence[Mapping[str, Any]],
    event_ids: Sequence[str],
) -> dict[str, Any]:
    """Replays (in memory) for the test-period events and the proof.json event scores for them."""
    from model import backtest, official, proof
    from model.metrics import P_STARS, spot_probability

    events = backtest.load_events()
    replays = {}
    for eid in event_ids:
        replays[eid] = proof.consistent_arrivals(
            backtest.build_replay(hourly, models, eid, events[eid], spots), spots
        )
    warnings = proof.load_warnings()
    ev = proof.event_scores(replays, {e: events[e] for e in event_ids}, spots, hourly, warnings)
    # First-trigger lead vs crossing and vs the first EA warning, per event and spot, at several p*.
    first = []
    areas = official.spot_areas_from_spots([s for s in spots if s.get("warningArea")])
    for eid, r in replays.items():
        win = backtest.event_window(events[eid])
        for s in spots:
            if s.get("mode") != "probability" or s.get("threshold") is None:
                continue
            p = spot_probability(r["forecasts"], s["key"], s["threshold"])
            cross = proof._crossing_times(r, s["key"])
            cmp = official.compare_events(
                {(eid, s["key"]): p}, warnings, {eid: win}, P_STARS, areas, {(eid, s["key"]): cross}
            )
            for p_star in (0.1, 0.3, 0.5):
                row = cmp[np.isclose(cmp["p_star"], p_star)].iloc[0]
                trig = row["trigger_at"]
                lead_cross = (
                    round((cross[0] - trig).total_seconds() / 3600, 1)
                    if cross and trig is not None and not pd.isna(trig) and trig < cross[0]
                    else None
                )
                first.append(
                    {
                        "eventId": eid,
                        "spot": s["key"],
                        "pStar": p_star,
                        "firstTrigger": None if trig is None or pd.isna(trig) else str(trig),
                        "firstCrossing": str(cross[0]) if cross else None,
                        "leadVsCrossingH": lead_cross,
                        "warningAt": None
                        if row["warning_at"] is None or pd.isna(row["warning_at"])
                        else str(row["warning_at"]),
                        "leadVsWarningH": None
                        if pd.isna(row["lead_vs_warning_h"])
                        else float(row["lead_vs_warning_h"]),
                    }
                )
    p50 = {k: next(x for x in v if x["pStar"] == P_STAR) for k, v in ev["tradeoff"].items()}
    return {"variant": name, "events": list(event_ids), "tradeoffP50": p50, "firstTrigger": first}


def load_models(directory: Path) -> dict[str, GaugeModel]:
    return {g: GaugeModel.load(directory / g) for g in TARGETS if (directory / g / "meta.json").exists()}


def evaluate(fc_name: str = PRIMARY, buffer_h: int = AVAIL_BUFFER_H) -> dict[str, Any]:
    from model import backtest
    from model.train import build_xy, load_hourly

    hourly = load_hourly()
    spots = backtest.load_spots()
    base = load_models(BASELINE_DIR)
    rainm = load_models(RAIN_MODELS_DIR)
    targets = [g for g in TARGETS if g in base and g in rainm]
    base = {g: base[g] for g in targets}
    rain_obs = hourly[hourly["gauge"] == RAIN_KEY].set_index("ts_utc")["rain_mm"]
    archive = load_forecast_archive(fc_name)
    test_start = base[targets[0]].splits.test_start
    end = hourly["ts_utc"].max()

    obs_f = observed_future_rain(rain_obs)
    fc_f = forecast_future_rain(archive, buffer_h=buffer_h)
    ub = {g: WithRain(rainm[g], obs_f) for g in targets}
    hon = {g: WithRain(rainm[g], fc_f) for g in targets}

    # Rows: a test row is scored when the target's level_now is finite. The honest window additionally
    # needs the honest features (all three) to be finite, and every variant is scored on those rows.
    full_rows, hon_rows = {}, {}
    fc_ok = fc_f.notna().all(axis=1)
    for g in targets:
        X, _ = build_xy(hourly, g, base[g].medians, base[g].lags)
        ok = X["level_now"].notna() & (X.index >= test_start)
        full_rows[g] = X.index[ok.to_numpy()]
        okh = ok & fc_ok.reindex(X.index, fill_value=False) & (X.index >= ARCHIVE_START)
        hon_rows[g] = X.index[okh.to_numpy()]
    hon_period = (ARCHIVE_START, end)
    full_period = (test_start, end)
    log.info("honest rows: %s", {g: len(v) for g, v in hon_rows.items()})

    out: dict[str, Any] = {
        "issue": 100,
        "forecastSource": f"Open-Meteo Previous Runs API, {fc_name}, previous_day1..{MAX_DAY}",
        "availabilityBufferH": buffer_h,
        "honestWindow": [str(ARCHIVE_START), str(end)],
        "testStart": str(test_start),
        "diagnostics": rain_diagnostics(obs_f, fc_f, ARCHIVE_START),
    }
    out["fullTest"] = [
        score_variant("current", base, hourly, spots, full_rows, full_period),
        score_variant("upperBound", ub, hourly, spots, full_rows, full_period),
    ]
    out["honestWindow2024"] = [
        score_variant("current", base, hourly, spots, hon_rows, hon_period),
        score_variant("honest", hon, hourly, spots, hon_rows, hon_period),
        score_variant("upperBound", ub, hourly, spots, hon_rows, hon_period),
    ]
    out["events"] = [
        event_variant("current", base, hourly, spots, TEST_EVENTS),
        event_variant("upperBound", ub, hourly, spots, TEST_EVENTS),
        event_variant("current", base, hourly, spots, ("e2024b", "e2026")),
        event_variant("honest", hon, hourly, spots, ("e2024b", "e2026")),
        event_variant("upperBound", ub, hourly, spots, ("e2024b", "e2026")),
    ]
    return out


def rain_diagnostics(obs: pd.DataFrame, fc: pd.DataFrame, start: pd.Timestamp) -> dict[str, Any]:
    """How the archived forecast windows compare with the observed (gauge) windows, 2024+."""
    out = {}
    for c in RAIN_FEATURES:
        a = pd.concat([obs[c], fc[c]], axis=1, keys=["obs", "fc"]).dropna()
        a = a[a.index >= start]
        wet = a["obs"] >= 10
        out[c] = {
            "n": int(len(a)),
            "meanObs": round(float(a["obs"].mean()), 2),
            "meanFc": round(float(a["fc"].mean()), 2),
            "corr": round(float(a["obs"].corr(a["fc"])), 3),
            "corrWhenObs>=10mm": round(float(a.loc[wet, "obs"].corr(a.loc[wet, "fc"])), 3)
            if wet.sum() > 2
            else None,
            "medianFcOverObsWhenObs>=10mm": round(float((a.loc[wet, "fc"] / a.loc[wet, "obs"]).median()), 3)
            if wet.any()
            else None,
        }
    return out


# ---------------------------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------------------------


def report(res: Mapping[str, Any]) -> str:
    lines = [f"forecast: {res['forecastSource']}; honest window {res['honestWindow'][0][:10]} -> now"]
    for block in ("fullTest", "honestWindow2024"):
        lines.append(f"\n## {block}")
        for v in res[block]:
            sk = " ".join(f"{r['h']}h {r['skill']:+.3f}" for r in v["skill"])
            cv = " ".join(f"{h}h {c['all90']:.2f}/{c['event90']:.2f}" for h, c in v["coverage"].items())
            lines.append(f"{v['variant']:11s} skill: {sk}")
            lines.append(f"{'':11s} cov90 all/event: {cv}")
            for spot, br in v["brier"].items():
                o = v["outcomesP50"][spot]
                lines.append(
                    f"{'':11s} {spot}: Brier 24/48/72 {br[24]:.4f}/{br[48]:.4f}/{br[72]:.4f}; "
                    f"p*=0.5 hits {o['hits']} miss {o['misses']} FA {o['falseAlarms']} lead {o['meanLeadH']}"
                )
    lines.append("\n## events (replays)")
    for v in res["events"]:
        lines.append(f"{v['variant']} on {','.join(v['events'])}:")
        for spot, r in v["tradeoffP50"].items():
            lines.append(
                f"   {spot}: hits {r['hits']} miss {r['misses']} FA {r['falseAlarms']} lead {r['meanLeadH']} "
                f"vsEA {r['meanLeadVsOfficialH']}"
            )
        for f in v["firstTrigger"]:
            if f["pStar"] == P_STAR:
                lines.append(
                    f"   {f['eventId']} {f['spot']}: first trigger {f['firstTrigger']} lead vs crossing "
                    f"{f['leadVsCrossingH']} vs EA {f['leadVsWarningH']}"
                )
    return "\n".join(lines)


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("fetch")
    f.add_argument("--refresh", action="store_true")
    t = sub.add_parser("train")
    t.add_argument("--targets", nargs="+", default=list(TARGETS))
    e = sub.add_parser("evaluate")
    e.add_argument("--forecast", default=PRIMARY)
    e.add_argument("--buffer-h", type=int, default=AVAIL_BUFFER_H)
    e.add_argument("--out", default=str(OUT_PATH))
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    if args.cmd == "fetch":
        fetch_all(pd.Timestamp.now(tz="UTC") - pd.Timedelta(days=1), refresh=args.refresh)
    elif args.cmd == "train":
        from model.train import load_hourly, load_lags

        hourly, lags = load_hourly(), load_lags()
        for g in args.targets:
            t0 = time.time()
            m = train_rain_gauge(hourly, g, lags)
            m.save(RAIN_MODELS_DIR / g)
            log.info("saved rain model %s in %.0f s; cqr=%s", g, time.time() - t0, m.cqr)
    else:
        res = evaluate(args.forecast, args.buffer_h)
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(json.dumps(res, indent=1, default=str), encoding="utf-8")
        print(report(res))
    return 0


if __name__ == "__main__":
    sys.exit(main())
