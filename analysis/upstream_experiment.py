"""Further-upstream EA level gauges as extra features: an experiment, not the shipped model (issue #125 A).

Question: does adding gauges further up the Thames, Windrush, Evenlode, Cherwell and Ray to the SAME
LightGBM quantile model (SPEC §7.3; not a second model, SPEC §1.1) improve 36-72 h skill without
adding false alarms?

What changes, and what does not
-------------------------------
- Only the upstream map. Each new gauge enters exactly as the current upstreams do (SPEC §7.2): its
  anomaly against its own training-period median (never a raw stage compared across gauges), lagged by
  {0, 6, 12, 24, lag_lo, lag_main, lag_hi} h, plus its 3 h and 24 h changes.
- The lags come from the SPEC §6 matching in ``analysis/travel_times.py`` (``run`` with an upstream map
  of the new pairs only). Lags are capped at 21 days (``MAX_WINDOW_H``) by ``features.upstream_lags_h``.
- Splits, params, weights, early stopping, CQR and the persistence baseline are those of
  ``model.train.train_gauge``. Medians use the training cutoff (``fit_medians``).
- ``model/features.py`` is NOT edited. ``extended_upstreams()`` swaps ``features.UPSTREAMS`` for the
  extended map inside a ``with`` block only, so the default everywhere else is unchanged.
- Every new gauge has a Hydrology 15-min ``level-i-900-m-qualified`` series from <= 2006 AND a
  flood-monitoring live measure on the same trace (checked by value match on 20-24 Oct 2026; for the
  locks that is the u/s "Stage" trace, like eynsham). So live mode could use them.

Data (nothing in data/processed/ or data/models/<gauge>/ is overwritten)
-----------------------------------------------------------------------
- raw cache: ``data/raw/exp125/hydrology/<measure>/<year>.csv.gz`` (one request per year, past years
  cached forever, CLAUDE.md rule 5);
- hourly: ``data/processed/exp125_upstream_hourly.parquet``, same long format as hourly.parquet, made
  with ``pipeline.clean.clean_series`` (Suspect/Rejected dropped, hourly mean on hour-start UTC labels,
  gaps <= 2 h filled, spikes removed);
- lags: ``data/processed/exp125_upstream_lags.json`` (+ ``_detail.json``);
- models: ``data/models/exp125/upstream/<gauge>/``; baseline read from ``data/models/exp125/baseline/``;
- results: ``data/processed/exp125_upstream.json``.

Usage
-----
``python -m analysis.upstream_experiment ingest``
``python -m analysis.upstream_experiment travel``
``python -m analysis.upstream_experiment train [--targets ...]`` (one gauge at a time, RC_LGB_THREADS<=3)
``python -m analysis.upstream_experiment evaluate``
"""

from __future__ import annotations

import argparse
import contextlib
import json
import logging
import os
import sys
import time
from collections.abc import Iterator, Mapping, Sequence
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from model import features
from model.train import DATA_DIR, MODELS_DIR, GaugeModel

log = logging.getLogger(__name__)

HYDROLOGY = "https://environment.data.gov.uk/hydrology"
RAW_DIR = DATA_DIR / "raw" / "exp125"
HOURLY_EXT_PATH = DATA_DIR / "processed" / "exp125_upstream_hourly.parquet"
LAGS_EXT_PATH = DATA_DIR / "processed" / "exp125_upstream_lags.json"
DETAIL_EXT_PATH = DATA_DIR / "processed" / "exp125_upstream_lags_detail.json"
UPSTREAM_MODELS_DIR = MODELS_DIR / "exp125" / "upstream"
BASELINE_DIR = Path(os.environ.get("RC_BASELINE_MODELS", MODELS_DIR / "exp125" / "baseline"))
OUT_PATH = DATA_DIR / "processed" / "exp125_upstream.json"
START_YEAR = 2006

# Candidates found by the discovery step (Hydrology /id/stations?observedProperty=waterLevel around
# 51.80N 1.50W, 40 km; raw responses in data/raw/exp125/). ``hydro`` is the Hydrology station GUID;
# the 15-min measure is ``<hydro>-level-i-900-m-qualified``. ``fm`` is the live flood-monitoring
# measure whose values equal the Hydrology series (mean |diff| 0.000 m over 20-24 Oct 2026).
NEW_GAUGES: dict[str, dict[str, str]] = {
    "shifford": {
        "ref": "0904TH",
        "name": "Shifford Lock u/s",
        "river": "Thames",
        "hydro": "b94cc43a-f693-4efa-8749-c4718c7eb2b8",
        "fm": "0904TH-level-stage-i-15_min-mASD",
        "first": "2002-11-02",
    },
    "buscot": {
        "ref": "0898TH",
        "name": "Buscot Lock u/s",
        "river": "Thames",
        "hydro": "4e2f942e-663e-4efc-990e-5bf0c24f7b03",
        "fm": "0898TH-level-stage-i-15_min-mASD",
        "first": "1995-11-12",
    },
    "hannington": {
        "ref": "0569TH",
        "name": "Hannington Bridge",
        "river": "Thames",
        "hydro": "62a5f097-03e7-4dca-91cc-cb3cf6f1c1c7",
        "fm": "0569TH-level-stage-i-15_min-mASD",
        "first": "1995-09-17",
    },
    "worsham": {
        "ref": "1080TH",
        "name": "Worsham",
        "river": "Windrush",
        "hydro": "bed0ef93-6faa-4f98-af56-bfb3fed3ed61",
        "fm": "1080TH-level-stage-i-15_min-mASD",
        "first": "1988-02-03",
    },
    "shipton": {
        "ref": "1238TH",
        "name": "Shipton",
        "river": "Evenlode",
        "hydro": "22eb53c1-ea9b-4094-a813-6d8f9328b8aa",
        "fm": "1238TH-level-stage-i-15_min-mASD",
        "first": "1998-01-01",
    },
    "banbury": {
        "ref": "1420TH",
        "name": "Banbury",
        "river": "Cherwell",
        "hydro": "08a56e86-d214-4288-8726-8de31eb55766",
        "fm": "1420TH-level-stage-i-15_min-mASD",
        "first": "1986-10-01",
    },
    "heyford": {
        "ref": "1453TH",
        "name": "Heyford Bridge",
        "river": "Cherwell",
        "hydro": "e60c6eae-7b77-4d67-986d-66065bae341c",
        "fm": "1453TH-level-stage-i-15_min-mASD",
        "first": "1998-01-01",
    },
    "lowerarncott": {
        "ref": "1483TH",
        "name": "Lower Arncott",
        "river": "Ray",
        "hydro": "2253c9fa-d697-46d6-a9b2-e4368862af85",
        "fm": "1483TH-level-stage-i-15_min-mASD",
        "first": "1998-01-01",
    },
}
THAMES_TARGETS: tuple[str, ...] = ("newbotley", "minns", "coldharbour")
THAMES_NEW: tuple[str, ...] = ("shifford", "buscot", "hannington", "worsham", "shipton")
CHERWELL_NEW: tuple[str, ...] = ("banbury", "heyford", "lowerarncott")
# Gauges actually added to the model, chosen after the travel-time step (24 Oct 2026, §6 matching):
# T_half median to newbotley / kingsmill (n valid events): shifford 17 h (20), hannington 18 h (24),
# worsham 9 h (17), shipton 19 h (17); banbury 37 h (7), lowerarncott 39 h (5). For comparison the
# shipped upstreams: farmoor 5 h, eynsham 1 h, cassington 10 h; enslow 19 h. Not chosen: buscot (u/s
# weir head, muted: n=5, 7 h, shorter than shifford downstream of it) and heyford (34 h, between
# banbury and enslow, so mostly redundant).
CHOSEN: dict[str, tuple[str, ...]] = {
    "thames": ("shifford", "hannington", "worsham", "shipton"),
    "cherwell": ("banbury", "lowerarncott"),
}

TARGETS: tuple[str, ...] = ("newbotley", "minns", "coldharbour", "kingsmill")
TEST_EVENTS: tuple[str, ...] = ("e2024a", "e2024b", "e2026")
P_STAR = 0.5


def new_pairs(chosen: Mapping[str, Sequence[str]] | None = None) -> dict[str, tuple[str, ...]]:
    """Target -> new upstream gauges (only the new ones)."""
    c = CHOSEN if chosen is None else chosen
    out = {t: tuple(c["thames"]) for t in THAMES_TARGETS}
    out["kingsmill"] = tuple(c["cherwell"])
    return out


def extended_map(chosen: Mapping[str, Sequence[str]] | None = None) -> dict[str, tuple[str, ...]]:
    """The shipped UPSTREAMS with the new gauges appended (current gauges first, same order)."""
    add = new_pairs(chosen)
    base = _SHIPPED_UPSTREAMS
    return {t: tuple(base[t]) + tuple(g for g in add.get(t, ()) if g not in base[t]) for t in base}


_SHIPPED_UPSTREAMS: dict[str, tuple[str, ...]] = dict(features.UPSTREAMS)


@contextlib.contextmanager
def extended_upstreams(upstreams: Mapping[str, Sequence[str]]) -> Iterator[None]:
    """Temporarily replace ``model.features.UPSTREAMS`` (restored on exit, even on error)."""
    saved = features.UPSTREAMS
    features.UPSTREAMS = {k: tuple(v) for k, v in upstreams.items()}
    try:
        yield
    finally:
        features.UPSTREAMS = saved


# ---------------------------------------------------------------------------------------------
# Ingest (Hydrology 15-min level, cached under data/raw/exp125/)
# ---------------------------------------------------------------------------------------------


def measure_id(key: str) -> str:
    return f"{NEW_GAUGES[key]['hydro']}-level-i-900-m-qualified"


def fetch_year(measure: str, year: int, today: pd.Timestamp) -> Path:
    """One calendar year of 15-min readings (CSV), cached; the current year refreshes daily."""
    from pipeline import ea_client

    path = RAW_DIR / "hydrology" / measure / f"{year}.csv.gz"
    ttl = ea_client.META_TTL_S if year == today.year else None
    params = {"mineq-date": f"{year}-01-01", "max-date": f"{year + 1}-01-01", "_limit": 100000}
    url = f"{HYDROLOGY}/id/measures/{measure}/readings.csv"
    body = ea_client.cached_get(url, path, params=params, ttl_s=ttl)
    if body.count(b"\n") >= 100000:
        raise RuntimeError(f"{measure} {year}: hit the 100k row limit")
    return path


def ingest_gauge(key: str, start_year: int = START_YEAR) -> Path:
    """Fetch (cached per year) and clean one gauge; write ``data/raw/exp125/hourly/<key>.parquet``.

    Skips a gauge whose interim file already exists, so a restart only redoes unfinished gauges.
    Cleaning is ``pipeline.clean.clean_series`` (the same steps 1-4 as hourly.parquet).
    """
    from pipeline import ea_client
    from pipeline.clean import clean_series
    from pipeline.ingest_history import parse_hydrology_csv

    out = RAW_DIR / "hourly" / f"{key}.parquet"
    if out.exists():
        log.info("%s: already ingested (%s)", key, out)
        return out
    today = pd.Timestamp.now(tz="UTC")
    m = measure_id(key)
    raw = []
    for year in range(start_year, today.year + 1):
        path = fetch_year(m, year, today)
        raw.append(parse_hydrology_csv(ea_client.read_cached(path), key, "level", "hydrology"))
        log.info("%s %d: cached", key, year)
    hourly, st = clean_series(pd.concat(raw, ignore_index=True), "level")
    keys = ("readings_in", "quality_dropped", "hours", "hours_valid", "spikes_removed", "first_valid_ts")
    stats = {k: st.get(k) for k in keys}
    stats["level_shifts"] = len(st.get("level_shifts", []))
    log.info("%s: %s", key, stats)
    out.parent.mkdir(parents=True, exist_ok=True)
    hourly.to_parquet(out, index=False)
    (out.parent / f"{key}.stats.json").write_text(json.dumps(stats, indent=1, default=str), encoding="utf-8")
    return out


def combine(keys: Sequence[str] = tuple(NEW_GAUGES)) -> pd.DataFrame:
    """Concatenate the per-gauge interim files into ``exp125_upstream_hourly.parquet``."""
    frames = [
        pd.read_parquet(RAW_DIR / "hourly" / f"{k}.parquet")
        for k in keys
        if (RAW_DIR / "hourly" / f"{k}.parquet").exists()
    ]
    out = pd.concat(frames, ignore_index=True)
    out["ts_utc"] = pd.to_datetime(out["ts_utc"], utc=True).astype("datetime64[ns, UTC]")
    types = {"gauge": str, "kind": str, "level_mean": float, "level_max": float, "rain_mm": float}
    out = out.astype({**types, "filled": bool, "flagged": bool})
    out = out.sort_values(["gauge", "ts_utc"]).reset_index(drop=True)
    HOURLY_EXT_PATH.parent.mkdir(parents=True, exist_ok=True)
    out.to_parquet(HOURLY_EXT_PATH, index=False)
    log.info("wrote %s: %s", HOURLY_EXT_PATH, sorted(out["gauge"].unique()))
    return out


def load_hourly_ext() -> pd.DataFrame:
    """Shipped hourly.parquet plus the new gauges (normalised the same way as model.train.load_hourly)."""
    from model.train import load_hourly, normalise_hourly

    base = load_hourly()
    new = pd.read_parquet(HOURLY_EXT_PATH)
    new = new[~new["gauge"].isin(base["gauge"].unique())]
    return normalise_hourly(pd.concat([base, new], ignore_index=True))


# ---------------------------------------------------------------------------------------------
# Travel times (SPEC §6, reusing analysis/travel_times.py)
# ---------------------------------------------------------------------------------------------


def travel(hourly: pd.DataFrame | None = None) -> dict[str, Any]:
    """§6 matching from every candidate to its targets; writes exp125 lags + detail."""
    from analysis import travel_times as tt

    hourly = load_hourly_ext() if hourly is None else hourly
    pairs = {t: THAMES_NEW for t in THAMES_TARGETS}
    pairs["kingsmill"] = CHERWELL_NEW
    out = tt.run(hourly, tt.load_amber(), tt.load_named_events(), upstreams=pairs)
    tt.write_json(LAGS_EXT_PATH, out.lags)
    tt.write_json(DETAIL_EXT_PATH, {"pairs": out.travel_pairs, "detail": out.detail})
    for p in out.lags["pairs"]:
        log.info(
            "%s->%s: lo %s main %s hi %s (%s)",
            p["up"],
            p["down"],
            p["lag_lo"],
            p["lag_main"],
            p["lag_hi"],
            p["source"],
        )
    return out.lags


def combined_lags() -> dict[str, dict[str, int]]:
    """Shipped lags.json plus the exp125 pairs (the shipped pairs are never changed)."""
    from model.train import load_lags

    lags = load_lags()
    new = load_lags(LAGS_EXT_PATH)
    for k, v in new.items():
        lags.setdefault(k, v)
    return lags


# ---------------------------------------------------------------------------------------------
# Training
# ---------------------------------------------------------------------------------------------


def train_upstream_gauge(
    hourly: pd.DataFrame, target: str, lags: Mapping[str, Mapping[str, int]], **fit_kwargs: Any
) -> GaugeModel:
    """``model.train.train_gauge`` with the extended upstream map; everything else identical."""
    from model.train import train_gauge

    with extended_upstreams(extended_map()):
        m = train_gauge(hourly, target, lags=lags, **fit_kwargs)
    m.info["upstreams"] = list(extended_map()[target])
    m.info["newUpstreams"] = list(new_pairs()[target])
    return m


def train_checkpointed(
    hourly: pd.DataFrame, target: str, lags: Mapping[str, Mapping[str, int]], out_dir: Path
) -> GaugeModel:
    """Train one lead at a time, saving each to ``out_dir/<target>/parts/h<h>/`` and skipping leads
    already saved, then merge into ``out_dir/<target>/``. A restart loses at most one lead."""
    from model.probability import HORIZONS_H

    parts = out_dir / target / "parts"
    models = {}
    for h in HORIZONS_H:
        d = parts / f"h{h}"
        if (d / "meta.json").exists():
            models[h] = GaugeModel.load(d)
            log.info("%s h=%d: loaded checkpoint", target, h)
            continue
        t0 = time.time()
        models[h] = train_upstream_gauge(hourly, target, lags, horizons=[h])
        models[h].save(d)
        log.info("%s h=%d: trained in %.0f s, cqr=%s", target, h, time.time() - t0, models[h].cqr[h])
    m = models[HORIZONS_H[0]]
    for h, mh in models.items():
        if mh.feature_cols != m.feature_cols:
            raise RuntimeError(f"{target} h={h}: feature columns differ between checkpoints")
        m.boosters[h] = mh.boosters[h]
        m.cqr[h] = mh.cqr[h]
        m.persistence_eps[h] = mh.persistence_eps[h]
        m.info.setdefault("leads", {}).update(mh.info.get("leads", {}))
    m.save(out_dir / target)
    return m


# ---------------------------------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------------------------------


def _p_flood(
    level_now: np.ndarray, q: Mapping[int, np.ndarray], thr: float, leads: Sequence[int]
) -> np.ndarray:
    """Max over leads of P(level > thr): the trigger value (as metrics.spot_probability)."""
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
    models: Mapping[str, GaugeModel],
    hourly: pd.DataFrame,
    spots: Sequence[Mapping[str, Any]],
    rows: Mapping[str, pd.DatetimeIndex],
    period: tuple[pd.Timestamp, pd.Timestamp],
    upstreams: Mapping[str, Sequence[str]],
) -> dict[str, Any]:
    """Pinball skill (pooled and newbotley), 50/80/90 coverage (all / in-event), Brier, outcomes at p*."""
    from model import metrics
    from model.calibrate import event_mask
    from model.probability import HORIZONS_H, exceedance
    from model.train import build_xy

    pooled: dict[str, dict[int, list[np.ndarray]]] = {k: {h: [] for h in HORIZONS_H} for k in "mpye"}
    per_gauge_skill: dict[str, Any] = {}
    brier: dict[str, dict[int, float]] = {}
    outcomes: dict[str, Any] = {}
    with extended_upstreams(upstreams):
        for g, m in models.items():
            X, Y = build_xy(hourly, g, m.medians, m.lags)
            X, Y = X.reindex(rows[g]), Y.reindex(rows[g])
            q = m.predict(X)
            qp = m.persistence(len(X))
            lv = hourly[hourly["gauge"] == g].set_index("ts_utc")
            ev = event_mask(lv["level_max"].reindex(X.index).fillna(X["level_now"]), m.amber).to_numpy()
            ys = {h: Y[f"y_{h}h"].to_numpy(dtype=float) for h in HORIZONS_H}
            for h in HORIZONS_H:
                pooled["m"][h].append(q[h])
                pooled["p"][h].append(qp[h])
                pooled["y"][h].append(ys[h])
                pooled["e"][h].append(ev)
            per_gauge_skill[g] = metrics.skill_by_lead(q, qp, ys)
            level_now = X["level_now"].to_numpy(dtype=float)
            for s in spots:
                if s["gauge"] != g or s.get("mode") != "probability" or s.get("threshold") is None:
                    continue
                thr = float(s["threshold"])
                pm = exceedance(level_now[:, None, None], np.stack([q[h] for h in HORIZONS_H], 1), thr)
                br = {}
                for i, h in enumerate(HORIZONS_H):
                    o = metrics.exceedance_outcome(level_now + ys[h], thr)
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
        evm = cat["e"][h].astype(bool)
        a = metrics.interval_coverage(cat["m"][h], cat["y"][h])
        e = metrics.interval_coverage(cat["m"][h][evm], cat["y"][h][evm])
        cov[h] = {f"all{int(k * 100)}": round(v, 4) for k, v in a.items()}
        cov[h].update({f"event{int(k * 100)}": round(v, 4) for k, v in e.items()})
        cov[h]["nEvent"] = int(np.isfinite(cat["y"][h][evm]).sum())
    return {
        "variant": name,
        "skill": skill,
        "skillByGauge": per_gauge_skill,
        "coverage": cov,
        "brier": brier,
        "outcomesP50": outcomes,
    }


def event_variant(
    name: str,
    models: Mapping[str, GaugeModel],
    hourly: pd.DataFrame,
    spots: Sequence[Mapping[str, Any]],
    event_ids: Sequence[str],
    upstreams: Mapping[str, Sequence[str]],
) -> dict[str, Any]:
    """In-memory replays for the test events; first-trigger lead vs crossing and vs the first EA warning."""
    from model import backtest, official, proof
    from model.metrics import P_STARS, spot_probability

    events = backtest.load_events()
    with extended_upstreams(upstreams):
        replays = {
            eid: proof.consistent_arrivals(
                backtest.build_replay(hourly, models, eid, events[eid], spots), spots
            )
            for eid in event_ids
        }
    warnings = proof.load_warnings()
    ev = proof.event_scores(replays, {e: events[e] for e in event_ids}, spots, hourly, warnings)
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
            row = cmp[np.isclose(cmp["p_star"], P_STAR)].iloc[0]
            trig = row["trigger_at"]
            has_trig = trig is not None and not pd.isna(trig)
            lead_cross = (
                round((cross[0] - trig).total_seconds() / 3600, 1)
                if cross and has_trig and trig < cross[0]
                else None
            )
            first.append(
                {
                    "eventId": eid,
                    "spot": s["key"],
                    "pStar": P_STAR,
                    "firstTrigger": str(trig) if has_trig else None,
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


def importance_new(models: Mapping[str, GaugeModel]) -> dict[str, Any]:
    """Share of gain (mean over alphas) carried by each new gauge's columns, per target and lead."""
    out: dict[str, Any] = {}
    for g, m in models.items():
        new = m.info.get("newUpstreams", [])
        rows = []
        for entry in m.importance():
            by = {up: 0.0 for up in new}
            top = []
            for f in entry["features"]:
                for up in new:
                    if f["name"].startswith(f"{up}_"):
                        by[up] += f["gain"]
                        if len(top) < 3:
                            top.append(f)
            rows.append(
                {
                    "h": entry["h"],
                    "share": {k: round(v, 4) for k, v in by.items()},
                    "totalNew": round(sum(by.values()), 4),
                    "topNew": top,
                }
            )
        out[g] = rows
    return out


def load_models(directory: Path) -> dict[str, GaugeModel]:
    return {g: GaugeModel.load(directory / g) for g in TARGETS if (directory / g / "meta.json").exists()}


def evaluate() -> dict[str, Any]:
    from model import backtest
    from model.train import build_xy

    hourly = load_hourly_ext()
    spots = backtest.load_spots()
    base = load_models(BASELINE_DIR)
    upm = load_models(UPSTREAM_MODELS_DIR)
    targets = [g for g in TARGETS if g in base and g in upm]
    if not targets:
        raise SystemExit(f"need models in both {BASELINE_DIR} and {UPSTREAM_MODELS_DIR}")
    base = {g: base[g] for g in targets}
    upm = {g: upm[g] for g in targets}
    spots_used = [s for s in spots if s["gauge"] in targets or s.get("mode") != "probability"]
    test_start = base[targets[0]].splits.test_start
    end = hourly["ts_utc"].max()
    ext = extended_map()

    rows = {}
    for g in targets:
        X, _ = build_xy(hourly, g, base[g].medians, base[g].lags)
        ok = X["level_now"].notna() & (X.index >= test_start)
        rows[g] = X.index[ok.to_numpy()]
    period = (test_start, end)
    out: dict[str, Any] = {
        "issue": 125,
        "experiment": "A: further-upstream gauges",
        "targets": targets,
        "newUpstreams": {g: list(new_pairs()[g]) for g in targets},
        "testStart": str(test_start),
        "lags": {k: v for k, v in combined_lags().items() if k.split("->")[0] in NEW_GAUGES},
    }
    out["fullTest"] = [
        score_variant("baseline", base, hourly, spots_used, rows, period, _SHIPPED_UPSTREAMS),
        score_variant("upstream", upm, hourly, spots_used, rows, period, ext),
    ]
    ev_ids = [e for e in TEST_EVENTS if e in backtest.load_events()]
    out["events"] = [
        event_variant("baseline", base, hourly, spots_used, ev_ids, _SHIPPED_UPSTREAMS),
        event_variant("upstream", upm, hourly, spots_used, ev_ids, ext),
    ]
    out["importanceNew"] = importance_new(upm)
    out["verdict"] = adoption(out)
    return out


def adoption(res: Mapping[str, Any]) -> dict[str, Any]:
    """The #125 rule: 36-72 h skill up, no extra FA at p*=0.5, Brier no worse, in-event coverage holds."""
    b, u = res["fullTest"]
    sk = {r["h"]: r["skill"] for r in b["skill"]}
    su = {r["h"]: r["skill"] for r in u["skill"]}
    skill_ok = all(su[h] > sk[h] for h in (36, 48, 72))
    fa_b = sum(o["falseAlarms"] for o in b["outcomesP50"].values())
    fa_u = sum(o["falseAlarms"] for o in u["outcomesP50"].values())
    fa_ok = all(
        u["outcomesP50"][s]["falseAlarms"] <= b["outcomesP50"][s]["falseAlarms"] for s in b["outcomesP50"]
    )
    brier_ok = all(
        u["brier"][s][h] <= b["brier"][s][h] + 5e-5 for s in b["brier"] for h in (48, 72)
    )  # 5e-5: the rounding unit of the table
    cov_ok = all(
        u["coverage"][h]["event90"] >= min(b["coverage"][h]["event90"], 0.9) - 0.02 for h in u["coverage"]
    )
    return {
        "skill36to72Improves": skill_ok,
        "noExtraFalseAlarms": fa_ok,
        "falseAlarmsTotal": [fa_b, fa_u],
        "brierNoWorse": brier_ok,
        "inEventCoverageHolds": cov_ok,
        "adopt": bool(skill_ok and fa_ok and brier_ok and cov_ok),
    }


# ---------------------------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------------------------


def report(res: Mapping[str, Any]) -> str:
    lines = [f"exp125 A, test >= {res['testStart'][:10]}, new upstreams {res['newUpstreams']}"]
    for v in res["fullTest"]:
        sk = " ".join(f"{r['h']}h {r['skill']:+.3f}" for r in v["skill"])
        lines.append(f"{v['variant']:9s} pooled skill: {sk}")
        if "newbotley" in v["skillByGauge"]:
            sk = " ".join(f"{r['h']}h {r['skill']:+.3f}" for r in v["skillByGauge"]["newbotley"])
            lines.append(f"{'':9s} newbotley:    {sk}")
        for h, c in v["coverage"].items():
            lines.append(
                f"{'':9s} cov {h}h all {c['all50']:.2f}/{c['all80']:.2f}/{c['all90']:.2f} "
                f"event {c['event50']:.2f}/{c['event80']:.2f}/{c['event90']:.2f} (n={c['nEvent']})"
            )
        for spot, br in v["brier"].items():
            o = v["outcomesP50"][spot]
            lines.append(
                f"{'':9s} {spot}: Brier 48/72 {br[48]:.4f}/{br[72]:.4f}; p*=0.5 hits {o['hits']} "
                f"miss {o['misses']} FA {o['falseAlarms']} lead {o['meanLeadH']}"
            )
    for v in res["events"]:
        lines.append(f"{v['variant']} replays {','.join(v['events'])}:")
        for f in v["firstTrigger"]:
            lines.append(
                f"   {f['eventId']} {f['spot']}: trigger {f['firstTrigger']} "
                f"vs crossing {f['leadVsCrossingH']} vs EA {f['leadVsWarningH']}"
            )
    lines.append(f"verdict: {res['verdict']}")
    return "\n".join(lines)


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    i = sub.add_parser("ingest")
    i.add_argument("--only", nargs="+", default=list(NEW_GAUGES))
    sub.add_parser("combine")
    sub.add_parser("travel")
    t = sub.add_parser("train")
    t.add_argument("--targets", nargs="+", default=list(TARGETS))
    e = sub.add_parser("evaluate")
    e.add_argument("--out", default=str(OUT_PATH))
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    if args.cmd == "ingest":
        for key in args.only:
            ingest_gauge(key)
    elif args.cmd == "combine":
        combine()
    elif args.cmd == "travel":
        travel()
    elif args.cmd == "train":
        hourly, lags = load_hourly_ext(), combined_lags()
        for g in args.targets:
            if (UPSTREAM_MODELS_DIR / g / "meta.json").exists():
                log.info("%s already trained; skipping (delete the folder to retrain)", g)
                continue
            t0 = time.time()
            m = train_checkpointed(hourly, g, lags, UPSTREAM_MODELS_DIR)
            log.info("saved upstream model %s in %.0f s; cqr=%s", g, time.time() - t0, m.cqr)
    else:
        res = evaluate()
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(json.dumps(res, indent=1, default=str), encoding="utf-8")
        print(report(res))
    return 0


if __name__ == "__main__":
    sys.exit(main())
