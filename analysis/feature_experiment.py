"""Derived features from data we already hold: an experiment, not part of the shipped model (issue #125 B).

Question: do extra features built from the gauges and rain we already use (no new data source) lift the
36-72 h skill of the same LightGBM quantile model (SPEC §7.3, §7.4; not a second model, SPEC §1.1)
without adding false alarms?

Arms (same harness, same splits, params, weights, medians, lags and CQR as ``model.train.train_gauge``):

- ``baseline``: today's features (``model.features.build_features``), retrained from this branch's code.
  Shared with experiment A (``analysis/upstream_experiment.py``, alfredo-upstream): it waits for
  ``data/models/exp125/baseline/DONE``.
- ``features``: baseline columns plus the candidates below (``extra_features``).

Candidate features (all strictly known at t: row t uses only rows labelled <= t)
------------------------------------------------------------------------------
Per upstream gauge ``up`` (anomaly = level minus its own training-period median, never raw stage):

- ``{up}_anom_max_{24,48,72}h``: trailing max of the anomaly.
- ``{up}_anom_rise_main``: anom(t) - anom(t - lag_main), the rise over that pair's travel time
  (lag_main from lags.json, at least 1 h).
- ``{up}_hours_since_peak_72h``: hours since the anomaly's max within the last 72 h (0 = rising now).

Catchment rain (``rain_catchment``):

- ``rain_max_{6,24}h``: max hourly intensity in the window.
- ``rain_api_21d``: antecedent precipitation index, sum_j k^(j/24) r(t-j) for j < 21 days, k = 0.9/day.

Target gauge (one model per gauge, own datum):

- ``level_max_72h``: trailing 72 h max level. ``level_accel_6h``: (l(t)-l(t-6)) - (l(t-6)-l(t-12)).

Windows follow model/features.py: complete hourly index, nothing longer than 21 days (MAX_WINDOW_H),
rolling stats NaN when < 90 % of the window is present, differences NaN when an end is missing.
The groundwater option (EA borehole anomaly) was not pursued: see the issue #125 comment.

Usage
-----
``python -m analysis.feature_experiment train --arm baseline [--targets ...]`` (writes DONE when all 4 exist)
``python -m analysis.feature_experiment train --arm features [--targets ...] [--drop GROUP]``
``python -m analysis.feature_experiment evaluate [--arms baseline features]``
(writes data/processed/exp125_features.json and prints the tables). Train one gauge at a time with
RC_LGB_THREADS <= 3. Reusable by experiment A: ``evaluate_arms({"baseline": models, "A": models})``
with any objects that have ``GaugeModel``'s ``predict``/``persistence``/attributes (see ``WithExtra``).
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import subprocess
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

EXP_DIR = MODELS_DIR / "exp125"
ARM_DIRS = {"baseline": EXP_DIR / "baseline", "features": EXP_DIR / "features"}
OUT_PATH = DATA_DIR / "processed" / "exp125_features.json"
TARGETS: tuple[str, ...] = ("newbotley", "kingsmill", "minns", "coldharbour")
TEST_EVENTS: tuple[str, ...] = ("e2024a", "e2024b", "e2026")
P_STAR = 0.5

UP_MAX_H: tuple[int, ...] = (24, 48, 72)
PEAK_WINDOW_H = 72
RAIN_MAX_H: tuple[int, ...] = (6, 24)
API_K_PER_DAY = 0.9
API_WINDOW_H = F.MAX_WINDOW_H  # 21 days
LEVEL_MAX_H = 72

GROUPS: tuple[str, ...] = ("upstream", "rain", "target")


# ---------------------------------------------------------------------------------------------
# Features (known at t)
# ---------------------------------------------------------------------------------------------


def _min_periods(hours: int) -> int:
    return math.ceil(F.MIN_COVERAGE * hours)


def _rolling_max(s: pd.Series, hours: int) -> pd.Series:
    return s.rolling(window=hours, min_periods=_min_periods(hours)).max()


def hours_since_peak(s: pd.Series, hours: int = PEAK_WINDOW_H) -> pd.Series:
    """Hours since the max of ``s`` within the trailing ``hours`` rows (0 = the max is at t).

    Ties go to the most recent hour. NaN below the coverage rule or when s(t)'s window is empty.
    """
    v = s.to_numpy(dtype=float)
    n = len(v)
    out = np.full(n, np.nan)
    if n >= hours:
        win = np.lib.stride_tricks.sliding_window_view(v, hours)  # row i covers v[i .. i+hours-1]
        ok = np.isfinite(win).sum(axis=1) >= _min_periods(hours)
        rev = np.where(np.isfinite(win), win, -np.inf)[:, ::-1]  # position 0 = time t
        age = np.argmax(rev, axis=1).astype(float)  # first max in reversed order = most recent max
        age[~ok] = np.nan
        out[hours - 1 :] = age
    return pd.Series(out, index=s.index)


def antecedent_precip_index(
    rain: pd.Series, k_per_day: float = API_K_PER_DAY, window_h: int = API_WINDOW_H
) -> pd.Series:
    """API(t) = sum_{j=0}^{window-1} k^(j/24) * rain(t - j); NaN below the coverage rule.

    Missing hours count as 0 inside an otherwise covered window (like the rolling sums' tolerance).
    """
    r = rain.to_numpy(dtype=float)
    present = np.isfinite(r)
    kernel = k_per_day ** (np.arange(window_h) / 24.0)
    conv = np.convolve(np.where(present, r, 0.0), kernel)[: len(r)]
    cover = pd.Series(present.astype(float), index=rain.index).rolling(window_h, min_periods=1).sum()
    out = pd.Series(conv, index=rain.index)
    out[(cover < _min_periods(window_h)).to_numpy()] = np.nan
    return out


def extra_columns(target: str, lags: F.LagsArg = None, drop: Sequence[str] = ()) -> list[str]:
    """Candidate column names, in order, for ``target`` (groups in ``drop`` left out)."""
    if target not in F.UPSTREAMS:
        raise ValueError(f"unknown target {target!r}")
    cols: list[str] = []
    if "upstream" not in drop:
        for up in F.UPSTREAMS[target]:
            cols += [f"{up}_anom_max_{k}h" for k in UP_MAX_H]
            cols += [f"{up}_anom_rise_main", f"{up}_hours_since_peak_{PEAK_WINDOW_H}h"]
    if "rain" not in drop:
        cols += [f"rain_max_{k}h" for k in RAIN_MAX_H] + ["rain_api_21d"]
    if "target" not in drop:
        cols += [f"level_max_{LEVEL_MAX_H}h", "level_accel_6h"]
    return cols


def column_group(col: str) -> str:
    if col.startswith("rain_"):
        return "rain"
    if col.startswith("level_"):
        return "target"
    return "upstream"


def lag_main_h(up: str, target: str, lags: F.LagsArg) -> int:
    lag = F._normalise_lags(lags).get(f"{up}->{target}", {}).get("lag_main", 6)
    return int(min(max(lag, 1), F.MAX_WINDOW_H))


def extra_features(
    hourly: pd.DataFrame,
    target: str,
    medians: Mapping[str, float],
    lags: F.LagsArg = None,
    drop: Sequence[str] = (),
) -> pd.DataFrame:
    """Candidate feature frame on the same complete hourly UTC index as ``build_features``.

    Row t uses only rows labelled <= t (trailing windows and backward shifts only).
    """
    levels = F.pivot_hourly(F._level_rows(hourly), "level_mean")
    if target not in levels.columns:
        raise ValueError(f"no level data for target gauge {target!r}")
    rain = F.catchment_rain(hourly)
    start, end = levels.index.min(), levels.index.max()
    if not rain.empty:
        start, end = min(start, rain.index.min()), max(end, rain.index.max())
    index = pd.date_range(start, end, freq="h", tz="UTC", name="ts_utc")
    levels = levels.reindex(index)
    rain = rain.reindex(index)
    feats: dict[str, pd.Series] = {}
    for up in F.UPSTREAMS[target]:
        up_level = levels[up] if up in levels.columns else pd.Series(np.nan, index=index)
        anom = up_level - medians[up]
        for k in UP_MAX_H:
            feats[f"{up}_anom_max_{k}h"] = _rolling_max(anom, k)
        feats[f"{up}_anom_rise_main"] = anom - anom.shift(lag_main_h(up, target, lags))
        feats[f"{up}_hours_since_peak_{PEAK_WINDOW_H}h"] = hours_since_peak(anom, PEAK_WINDOW_H)
    for k in RAIN_MAX_H:
        feats[f"rain_max_{k}h"] = _rolling_max(rain, k)
    feats["rain_api_21d"] = antecedent_precip_index(rain)
    level = levels[target]
    feats[f"level_max_{LEVEL_MAX_H}h"] = _rolling_max(level, LEVEL_MAX_H)
    feats["level_accel_6h"] = (level - level.shift(6)) - (level.shift(6) - level.shift(12))
    out = pd.DataFrame(feats, index=index)
    return out[extra_columns(target, lags, drop)].astype(float)


def build_variant_xy(
    hourly: pd.DataFrame,
    target: str,
    medians: Mapping[str, float],
    lags: F.LagsArg,
    drop: Sequence[str] = (),
) -> tuple[pd.DataFrame, pd.DataFrame]:
    from model.train import build_xy

    X, Y = build_xy(hourly, target, medians, lags)
    return X.join(extra_features(hourly, target, medians, lags, drop)), Y


# ---------------------------------------------------------------------------------------------
# Model wrapper: same GaugeModel, extra columns joined at predict time
# ---------------------------------------------------------------------------------------------


class WithExtra:
    """A GaugeModel whose extra columns are joined by issue time inside ``predict``.

    ``model.backtest.forecasts_at`` and ``model.proof.test_period_scores`` build the baseline columns
    themselves and call ``predict``; ``extra`` is a frame on the full hourly index (computed from the
    same hourly data; known at t by construction and by the leakage test). ``extra=None`` = baseline.
    Everything else (``medians``, ``splits``, ``persistence``, ``amber`` ...) is the wrapped model's.
    """

    def __init__(self, model: GaugeModel, extra: pd.DataFrame | None = None) -> None:
        self.m = model
        self.extra = extra

    def __getattr__(self, name: str) -> Any:
        return getattr(self.m, name)

    def predict(self, X: pd.DataFrame, calibrated: bool = True) -> dict[int, np.ndarray]:
        if self.extra is not None:
            X = X.drop(columns=[c for c in self.extra.columns if c in X.columns]).join(
                self.extra.reindex(X.index)
            )
        return self.m.predict(X, calibrated)


def wrap_arm(hourly: pd.DataFrame, models: Mapping[str, GaugeModel]) -> dict[str, WithExtra]:
    """Wrap saved models; those trained with extra columns get them precomputed from ``hourly``."""
    out = {}
    for g, m in models.items():
        info = m.info.get("extraFeatures")
        extra = None
        if info:
            extra = extra_features(hourly, g, m.medians, m.lags, info.get("drop", []))
            missing = [c for c in m.feature_cols if c not in extra.columns and c in info["columns"]]
            if missing:
                raise ValueError(f"{g}: saved extra columns {missing} not rebuilt")
        out[g] = WithExtra(m, extra)
    return out


# ---------------------------------------------------------------------------------------------
# Training
# ---------------------------------------------------------------------------------------------


def prepare_arm(
    hourly: pd.DataFrame, target: str, lags: Any, arm: str, drop: Sequence[str] = ()
) -> tuple[pd.DataFrame, pd.DataFrame, dict[str, Any]]:
    """X, Y and the ``fit_gauge`` keywords, exactly as ``model.train.train_gauge`` prepares them.

    ``arm == "features"`` joins the candidate columns; ``"baseline"`` is today's columns only.
    """
    from model.calibrate import event_mask
    from model.train import build_xy, choose_splits, fit_medians, gauge_lines

    lines = gauge_lines(target)
    lv = hourly[hourly["gauge"] == target]
    if lv.empty:
        raise ValueError(f"no rows for target gauge {target!r}")
    ts = lv.loc[lv["level_mean"].notna(), "ts_utc"]
    splits = choose_splits(ts.min(), ts.max())
    medians = fit_medians(hourly, target, splits.val_start)
    if arm == "baseline":
        X, Y = build_xy(hourly, target, medians, lags)
    else:
        X, Y = build_variant_xy(hourly, target, medians, lags, drop)
    lmax = lv.set_index("ts_utc")["level_max"].reindex(X.index)
    events = event_mask(lmax.fillna(X["level_now"]), lines["amber"])
    kw = {
        "target": target,
        "amber": lines["amber"],
        "threshold": lines["threshold"],
        "splits": splits,
        "medians": medians,
        "lags": lags,
        "events": events,
    }
    return X, Y, kw


def _mark_extra(m: GaugeModel, target: str, lags: Any, arm: str, drop: Sequence[str]) -> GaugeModel:
    if arm != "baseline":
        m.info["extraFeatures"] = {"columns": extra_columns(target, lags, drop), "drop": list(drop)}
    return m


def train_arm_gauge(
    hourly: pd.DataFrame, target: str, lags: Any, arm: str, drop: Sequence[str] = (), **fit_kwargs: Any
) -> GaugeModel:
    """``model.train.train_gauge`` with (``arm == "features"``) the candidate columns added."""
    from model.train import fit_gauge

    X, Y, kw = prepare_arm(hourly, target, lags, arm, drop)
    return _mark_extra(fit_gauge(X, Y, **kw, **fit_kwargs), target, lags, arm, drop)


def merge_parts(parts: Sequence[GaugeModel]) -> GaugeModel:
    """One GaugeModel from single-lead fits (leads are fitted independently in ``fit_gauge``)."""
    m = parts[0]
    leads: dict[str, Any] = {}
    for p in parts[1:]:
        m.boosters.update(p.boosters)
        m.cqr.update(p.cqr)
        m.persistence_eps.update(p.persistence_eps)
    for p in parts:
        leads.update(p.info.get("leads", {}))
    m.boosters = dict(sorted(m.boosters.items()))
    m.info["leads"] = dict(sorted(leads.items(), key=lambda kv: int(kv[0])))
    return m


def train_checkpointed(
    hourly: pd.DataFrame,
    target: str,
    lags: Any,
    arm: str,
    out_dir: Path,
    drop: Sequence[str] = (),
    horizons: Sequence[int] | None = None,
    **fit_kwargs: Any,
) -> GaugeModel:
    """Train one gauge lead by lead, saving each lead to ``out_dir/<g>/_parts/h<h>`` as it finishes.

    Leads already saved are loaded, not retrained, so a killed run resumes where it stopped. When all
    leads exist they are merged and saved to ``out_dir/<g>`` (meta.json last, so its presence means done).
    """
    from model.probability import HORIZONS_H
    from model.train import fit_gauge

    horizons = list(horizons or HORIZONS_H)
    parts_dir = out_dir / target / "_parts"
    X = Y = kw = None
    parts = []
    for h in horizons:
        d = parts_dir / f"h{h}"
        if (d / "meta.json").exists():
            log.info("%s %s h=%d: loading saved part", arm, target, h)
            parts.append(GaugeModel.load(d))
            continue
        if X is None:
            X, Y, kw = prepare_arm(hourly, target, lags, arm, drop)
        t0 = time.time()
        p = fit_gauge(X, Y, **kw, horizons=(h,), **fit_kwargs)
        p.save(d)
        log.info("%s %s h=%d: fitted and saved in %.0f s", arm, target, h, time.time() - t0)
        parts.append(p)
    m = _mark_extra(merge_parts(parts), target, lags, arm, drop)
    m.info["exp125"] = {"arm": arm, "drop": list(drop), "commit": _git_sha(), "checkpointed": True}
    m.info["trainedAt"] = pd.Timestamp.now(tz="UTC").strftime("%Y-%m-%dT%H:%M:%SZ")
    m.save(out_dir / target)
    return m


def _git_sha() -> str:
    try:
        return subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    except Exception:  # noqa: BLE001
        return "unknown"


def write_done(directory: Path, targets: Sequence[str] = TARGETS) -> Path | None:
    """Marker for experiment A: written once every target's model is saved in ``directory``."""
    if not all((directory / g / "meta.json").exists() for g in targets):
        return None
    cols = {
        g: json.loads((directory / g / "meta.json").read_text(encoding="utf-8"))["featureCols"]
        for g in targets
    }
    done = {
        "commit": _git_sha(),
        "writtenAt": pd.Timestamp.now(tz="UTC").strftime("%Y-%m-%dT%H:%M:%SZ"),
        "targets": list(targets),
        "featureCols": cols,
        "note": "model.train.train_gauge (SPEC §7.3 params, splits, weights; §7.4 CQR), issue #125",
    }
    path = directory / "DONE"
    path.write_text(json.dumps(done, indent=1), encoding="utf-8")
    return path


# ---------------------------------------------------------------------------------------------
# Evaluation (reusable: experiment A passes its own models / wrapper)
# ---------------------------------------------------------------------------------------------

Wrapper = Callable[[pd.DataFrame, Mapping[str, GaugeModel]], Mapping[str, Any]]


def load_models(directory: Path, targets: Sequence[str] = TARGETS) -> dict[str, GaugeModel]:
    return {g: GaugeModel.load(directory / g) for g in targets if (directory / g / "meta.json").exists()}


def p_flood(
    level_now: np.ndarray, q: Mapping[int, np.ndarray], thr: float, leads: Sequence[int]
) -> np.ndarray:
    """Max over leads of P(level > thr), as metrics.spot_probability; NaN if already over the line."""
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


def score_arm(
    name: str, models: Mapping[str, Any], hourly: pd.DataFrame, spots: Sequence[Mapping[str, Any]]
) -> dict[str, Any]:
    """Test-period scores (issue times >= the models' test_start), on the same rows as proof.json.

    Rows and definitions follow ``model.proof.test_period_scores`` exactly (pooled skill and coverage,
    in-flood coverage with ``event_mask(level_now)``, Brier "over the line by t + h" leaving out rows
    already over it), plus per-gauge skill/coverage, unrounded Brier and whole-period event outcomes at
    p* = 0.5 (hourly issues, flood onsets 72 h apart, false-alarm episodes split by 24 h gaps).
    """
    from model import metrics
    from model.calibrate import event_mask
    from model.probability import HORIZONS_H, exceedance
    from model.train import build_xy

    pooled: dict[str, dict[int, list[np.ndarray]]] = {k: {h: [] for h in HORIZONS_H} for k in "mpyf"}
    per_gauge: dict[str, Any] = {}
    brier: dict[str, Any] = {}
    outcomes: dict[str, Any] = {}
    for g, m in models.items():
        X, Y = build_xy(hourly, g, m.medians, m.lags, HORIZONS_H)
        in_flood = event_mask(X["level_now"], m.amber).to_numpy()
        test = X.index >= m.splits.test_start
        X, Y, in_flood = X[test], Y[test], in_flood[test]
        level_now = X["level_now"].to_numpy(dtype=float)
        ok = np.isfinite(level_now)
        X, Y, level_now, in_flood = X[ok], Y[ok], level_now[ok], in_flood[ok]
        t0 = time.time()
        q = m.predict(X)
        qp = m.persistence(len(X))
        log.info("%s %s: %d test rows predicted in %.0f s", name, g, len(X), time.time() - t0)
        ys = {h: Y[f"y_{h}h"].to_numpy(dtype=float) for h in HORIZONS_H}
        for h in HORIZONS_H:
            pooled["m"][h].append(q[h])
            pooled["p"][h].append(qp[h])
            pooled["y"][h].append(ys[h])
            pooled["f"][h].append(in_flood)
        per_gauge[g] = {
            "nRows": int(len(X)),
            "skill": metrics.skill_by_lead(q, qp, ys),
            "coverage": metrics.coverage_by_lead(q, ys),
            "floodCoverage": metrics.coverage_by_lead(
                {h: q[h][in_flood] for h in HORIZONS_H}, {h: ys[h][in_flood] for h in HORIZONS_H}
            ),
        }
        level = hourly[hourly["gauge"] == g].set_index("ts_utc")["level_mean"].sort_index()
        for s in spots:
            if s["gauge"] != g or s.get("mode") != "probability" or s.get("threshold") is None:
                continue
            thr = float(s["threshold"])
            pm = exceedance(level_now[:, None, None], np.stack([q[h] for h in HORIZONS_H], 1), thr)
            pp = exceedance(level_now[:, None, None], np.stack([qp[h] for h in HORIZONS_H], 1), thr)
            br = {}
            for i, h in enumerate(HORIZONS_H):
                ahead = metrics.max_level_ahead(level, X.index, h)
                o = metrics.exceedance_by_outcome(level_now, level_now + ys[h], ahead, thr)
                okb = np.isfinite(pm[:, i]) & np.isfinite(pp[:, i]) & np.isfinite(o)
                br[h] = {
                    "model": round(metrics.brier_score(pm[okb, i], o[okb]), 6),
                    "persistence": round(metrics.brier_score(pp[okb, i], o[okb]), 6),
                }
            brier[s["key"]] = br
            p = pd.Series(p_flood(level_now, q, thr, HORIZONS_H), index=X.index)
            lv = level[(level.index >= X.index.min()) & (level.index <= X.index.max())]
            cross = metrics.flood_onsets(_crossings(lv, thr))
            res = metrics.event_outcomes(metrics.trigger_times(p, P_STAR), cross)
            fa = []
            for a, b in res["falseAlarmEpisodes"]:
                win = level[(level.index >= a) & (level.index <= b + pd.Timedelta(hours=72))]
                fa.append({"start": str(a), "end": str(b), "peakObs": round(float(win.max()), 3)})
            outcomes[s["key"]] = {
                "hits": res["hits"],
                "misses": res["misses"],
                "falseAlarms": res["falseAlarms"],
                "meanLeadH": metrics.mean_or_none(res["leads"]),
                "crossings": [{"t": str(c["t"]), "leadH": c["leadH"]} for c in res["crossings"]],
                "falseAlarmEpisodes": fa,
                "threshold": thr,
            }
    cat = {k: {h: np.concatenate(v[h]) for h in HORIZONS_H} for k, v in pooled.items()}
    fl = {h: cat["f"][h].astype(bool) for h in HORIZONS_H}
    return {
        "arm": name,
        "skill": metrics.skill_by_lead(cat["m"], cat["p"], cat["y"]),
        "coverage": metrics.coverage_by_lead(cat["m"], cat["y"]),
        "floodCoverage": metrics.coverage_by_lead(
            {h: cat["m"][h][fl[h]] for h in HORIZONS_H}, {h: cat["y"][h][fl[h]] for h in HORIZONS_H}
        ),
        "perGauge": per_gauge,
        "brier": brier,
        "outcomesP50": outcomes,
    }


def event_arm(
    name: str,
    models: Mapping[str, Any],
    hourly: pd.DataFrame,
    spots: Sequence[Mapping[str, Any]],
    event_ids: Sequence[str] = TEST_EVENTS,
) -> dict[str, Any]:
    """In-memory replays (as ``make backtest`` builds them) and first-trigger leads per event and spot.

    Test-period events use the time-split models (as proof.json does: no leave-one-out needed).
    ``hourly`` should already be rounded to the mm, as ``model.proof._replay_job`` does.
    """
    from model import backtest, official, proof
    from model.metrics import P_STARS, spot_probability

    events = backtest.load_events()
    replays = {
        eid: proof.consistent_arrivals(backtest.build_replay(hourly, models, eid, events[eid], spots), spots)
        for eid in event_ids
    }
    warnings = proof.load_warnings()
    ev = proof.event_scores(replays, {e: events[e] for e in event_ids}, spots, hourly, warnings)
    areas = official.spot_areas_from_spots([s for s in spots if s.get("warningArea")])
    first = []
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
            row = cmp[np.isclose(cmp["p_star"], P_STAR)].iloc[0]
            trig = row["trigger_at"]
            has_trig = trig is not None and not pd.isna(trig)
            first.append(
                {
                    "eventId": eid,
                    "spot": s["key"],
                    "firstTrigger": str(trig) if has_trig else None,
                    "firstCrossing": str(cross[0]) if cross else None,
                    "leadVsCrossingH": round((cross[0] - trig).total_seconds() / 3600, 1)
                    if cross and has_trig and trig < cross[0]
                    else None,
                    "warningAt": None
                    if row["warning_at"] is None or pd.isna(row["warning_at"])
                    else str(row["warning_at"]),
                    "leadVsWarningH": None
                    if pd.isna(row["lead_vs_warning_h"])
                    else float(row["lead_vs_warning_h"]),
                    "peakP": None if p.dropna().empty else round(float(p.max()), 3),
                }
            )
    p50 = {k: next(x for x in v if np.isclose(x["pStar"], P_STAR)) for k, v in ev["tradeoff"].items()}
    return {"arm": name, "events": list(event_ids), "tradeoffP50": p50, "firstTrigger": first}


def importance_summary(models: Mapping[str, Any], leads: Sequence[int] = (36, 48, 72)) -> dict[str, Any]:
    """Gain share of the extra columns (per gauge, by group and the top 8 columns), mean over ``leads``."""
    out = {}
    for g, m in models.items():
        base = m.m if isinstance(m, WithExtra) else m
        extra = set(base.info.get("extraFeatures", {}).get("columns", []))
        if not extra:
            continue
        imp = {d["h"]: {f["name"]: f["gain"] for f in d["features"]} for d in base.importance()}
        mean = {c: float(np.mean([imp[h].get(c, 0.0) for h in leads])) for c in base.feature_cols}
        groups = {grp: 0.0 for grp in GROUPS}
        for c in extra:
            groups[column_group(c)] += mean[c]
        ranked = sorted(mean.items(), key=lambda kv: -kv[1])
        out[g] = {
            "leads": list(leads),
            "extraShare": round(sum(groups.values()), 4),
            "byGroup": {k: round(v, 4) for k, v in groups.items()},
            "topExtra": [(c, round(v, 4)) for c, v in ranked if c in extra][:8],
            "rankOfTopExtra": next((i + 1 for i, (c, _) in enumerate(ranked) if c in extra), None),
            "top5": [(c, round(v, 4)) for c, v in ranked[:5]],
        }
    return out


def evaluate_arms(
    arms: Mapping[str, Mapping[str, GaugeModel]],
    wrappers: Mapping[str, Wrapper] | None = None,
    events: bool = True,
    hourly: pd.DataFrame | None = None,
) -> dict[str, Any]:
    """Score several arms on the strict test period with one harness.

    ``arms``: name -> {gauge: GaugeModel}. ``wrappers``: name -> f(hourly, models) returning objects
    with ``predict``/``persistence`` and the GaugeModel attributes (default ``wrap_arm``, which joins
    this module's extra columns when a model was trained with them). Experiment A can pass its own.
    """
    from model import backtest
    from model.train import load_hourly

    hourly = load_hourly() if hourly is None else hourly
    spots = backtest.load_spots()
    wrappers = dict(wrappers or {})
    out: dict[str, Any] = {"issue": 125, "scores": [], "events": [], "importance": {}}
    first = next(iter(next(iter(arms.values())).values()))
    out["testStart"] = str(first.splits.test_start)
    out["dataEnd"] = str(hourly["ts_utc"].max())
    for name, models in arms.items():
        wrap = wrappers.get(name, wrap_arm)
        wrapped = wrap(hourly, models)
        out["scores"].append(score_arm(name, wrapped, hourly, spots))
        out["importance"][name] = importance_summary(wrapped)
    if events:
        hr = hourly.copy()
        hr["level_mean"] = hr["level_mean"].round(3)  # as model.proof._replay_job
        for name, models in arms.items():
            wrapped = wrappers.get(name, wrap_arm)(hr, models)
            out["events"].append(event_arm(name, wrapped, hr, spots))
    return out


def evaluate_cli(arm_args: Sequence[str], events: bool = True) -> dict[str, Any]:
    arms = {}
    for a in arm_args:
        path = ARM_DIRS.get(a, Path(a))
        arms[a if a in ARM_DIRS else path.name] = load_models(path)
    return evaluate_arms(arms, events=events)


# ---------------------------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------------------------


def _skill_row(rows: Sequence[Mapping[str, Any]]) -> str:
    return " | ".join(f"{r['skill']:+.3f}" for r in rows)


def _cov(rows: Sequence[Mapping[str, Any]], nominal: float, h: int) -> float:
    return next(r["actual"] for r in rows if r["h"] == h and np.isclose(r["nominal"], nominal))


def report(res: Mapping[str, Any]) -> str:
    """Markdown tables in the issue #100 format."""
    from model.probability import HORIZONS_H

    L = [f"Test period: issue times >= {res['testStart'][:10]} to {res['dataEnd'][:10]}.", ""]
    L += [
        "### Pinball skill vs persistence",
        "| arm | rows | " + " | ".join(f"{h}h" for h in HORIZONS_H) + " |",
    ]
    L.append("|---|---|" + "---|" * len(HORIZONS_H))
    for s in res["scores"]:
        L.append(f"| {s['arm']} | pooled | {_skill_row(s['skill'])} |")
    for s in res["scores"]:
        L.append(f"| {s['arm']} | newbotley | {_skill_row(s['perGauge']['newbotley']['skill'])} |")
    for g in TARGETS[1:]:
        for s in res["scores"]:
            if g in s["perGauge"]:
                L.append(f"| {s['arm']} | {g} | {_skill_row(s['perGauge'][g]['skill'])} |")
    L += [
        "",
        "### Coverage 50/80/90 %, overall / in-flood (pooled)",
        "| arm | 24h | 48h | 72h |",
        "|---|---|---|---|",
    ]
    for s in res["scores"]:
        cells = []
        for h in (24, 48, 72):
            a = "/".join(f"{_cov(s['coverage'], n, h):.2f}" for n in (0.5, 0.8, 0.9))
            f = "/".join(f"{_cov(s['floodCoverage'], n, h):.2f}" for n in (0.5, 0.8, 0.9))
            cells.append(f"{a} · {f}")
        L.append(f"| {s['arm']} | " + " | ".join(cells) + " |")
    L += [
        "",
        "### Brier 48 h / 72 h (model; persistence in brackets)",
        "| spot | " + " | ".join(s["arm"] for s in res["scores"]) + " |",
    ]
    L.append("|---|" + "---|" * len(res["scores"]))
    for spot in res["scores"][0]["brier"]:
        cells = []
        for s in res["scores"]:
            b = s["brier"][spot]
            cells.append(f"{b[48]['model']:.4f} / {b[72]['model']:.4f}")
        p = res["scores"][0]["brier"][spot]
        L.append(
            f"| {spot} ({p[48]['persistence']:.4f}/{p[72]['persistence']:.4f}) | " + " | ".join(cells) + " |"
        )
    L += [
        "",
        "### Event outcomes at p* = 0.5, whole test period (hourly issues)",
        "| spot | " + " | ".join(s["arm"] for s in res["scores"]) + " |",
    ]
    L.append("|---|" + "---|" * len(res["scores"]))
    for spot in res["scores"][0]["outcomesP50"]:
        cells = []
        for s in res["scores"]:
            o = s["outcomesP50"][spot]
            fa = ", ".join(f"{e['start'][:10]} pk {e['peakObs']}" for e in o["falseAlarmEpisodes"])
            cells.append(
                f"{o['hits']} hit / {o['misses']} miss / {o['falseAlarms']} FA, lead {o['meanLeadH']}"
                + (f" (FA: {fa})" if fa else "")
            )
        L.append(f"| {spot} | " + " | ".join(cells) + " |")
    if res.get("events"):
        L += [
            "",
            "### First trigger (p* = 0.5): lead vs crossing / vs first EA warning",
            "| event / spot | " + " | ".join(e["arm"] for e in res["events"]) + " |",
        ]
        L.append("|---|" + "---|" * len(res["events"]))
        keys = [(f["eventId"], f["spot"]) for f in res["events"][0]["firstTrigger"]]
        for eid, spot in keys:
            cells = []
            for e in res["events"]:
                f = next(x for x in e["firstTrigger"] if x["eventId"] == eid and x["spot"] == spot)
                if f["firstTrigger"] is None:
                    cells.append(f"no trigger (peak p {f['peakP']})")
                else:
                    lc = (
                        f"{f['leadVsCrossingH']} h"
                        if f["leadVsCrossingH"] is not None
                        else ("no crossing" if not f["firstCrossing"] else "after crossing")
                    )
                    lw = f"{f['leadVsWarningH']:+.1f} h" if f["leadVsWarningH"] is not None else "n/a"
                    cells.append(f"{lc} / {lw}")
            L.append(f"| {eid} {spot} | " + " | ".join(cells) + " |")
    for arm, imp in res.get("importance", {}).items():
        if not imp:
            continue
        L += ["", f"### Gain share of the new features ({arm}, mean over 36/48/72 h)"]
        for g, d in imp.items():
            grp = ", ".join(f"{k} {v:.1%}" for k, v in d["byGroup"].items())
            top = ", ".join(f"{c} {v:.1%}" for c, v in d["topExtra"][:4])
            L.append(
                f"- {g}: {d['extraShare']:.1%} ({grp}); top: {top}; best new rank #{d['rankOfTopExtra']}"
            )
    return "\n".join(L)


# ---------------------------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------------------------


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("train")
    t.add_argument("--arm", choices=sorted(ARM_DIRS), required=True)
    t.add_argument("--targets", nargs="+", default=list(TARGETS))
    t.add_argument("--drop", nargs="*", default=[], choices=GROUPS, help="ablation: leave out groups")
    t.add_argument("--out-dir", default=None, help="default data/models/exp125/<arm>")
    t.add_argument("--force", action="store_true", help="re-merge gauges already saved (parts are reused)")
    e = sub.add_parser("evaluate")
    e.add_argument("--arms", nargs="+", default=["baseline", "features"], help="arm names or model dirs")
    e.add_argument("--out", default=str(OUT_PATH))
    e.add_argument("--no-events", action="store_true", help="skip the event replays")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    if args.cmd == "train":
        from model.train import load_hourly, load_lags

        out_dir = Path(args.out_dir) if args.out_dir else ARM_DIRS[args.arm]
        hourly, lags = load_hourly(), load_lags()
        for g in args.targets:
            if (out_dir / g / "meta.json").exists() and not args.force:
                log.info("skip %s (already saved in %s)", g, out_dir / g)
                continue
            t0 = time.time()
            m = train_checkpointed(hourly, g, lags, args.arm, out_dir, args.drop)
            log.info("saved %s %s in %.0f s; cqr=%s", args.arm, g, time.time() - t0, m.cqr)
        if args.arm == "baseline" and args.out_dir is None:
            log.info("DONE marker: %s", write_done(out_dir))
    else:
        res = evaluate_cli(args.arms, events=not args.no_events)
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(json.dumps(res, indent=1, default=str), encoding="utf-8")
        print(report(res))
    return 0


if __name__ == "__main__":
    sys.exit(main())
