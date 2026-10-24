"""Assemble ``web/public/data/proof.json`` and the replays for every spot and event (SPEC §8, issue #11).

``python -m model.proof [--events e2007 ...] [--targets newbotley ...] [--rebuild] [--jobs 4]
                        [--n-estimators 2000]``

``make backtest`` runs ``--rebuild --jobs 4``: on a clean clone, after ``make train``, that regenerates
every committed replay and ``proof.json`` (#81). ``make train`` writes ``importance.json``.

1. **Main models** (time split: train <= 2018-09-30, validation to 2021-09-30, test >= 2021-10-01) are
   loaded from ``$RC_DATA_DIR/models/<gauge>/`` or trained there (``model.train``).
2. **Test-period scores** (``skillByLead``, ``coverage``, ``reliability``) use those models on test rows
   only, which no model has seen. They pool the four trained gauges: pinball losses are in metres of
   level *change* per gauge, so pooling compares errors, never stage values across gauges.
3. **Replays**: one ``Replay`` per event with leave-one-flood-out models (``model.backtest.lofo_models``).
   Shortcut: if the event window +- 7 days lies wholly in the test period, the leave-one-out model is
   the main model (training and calibration never touch test rows), so the main model is reused.
   An existing ``replays/<event>.json`` is reused unless ``--rebuild``. Forecasts are issued hourly,
   except for the events in ``REPLAY_EVERY_H`` (file size).
4. **Event scores** (``tradeoff``, ``perEvent``) from the replays with ``model.metrics``; lead vs the
   official EA warnings with ``model.official``.

No look-ahead: replay forecasts come from ``model.backtest.forecasts_at`` (data <= issue time only);
every metric pairs a forecast with observations after its issue time.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import time
from collections.abc import Mapping, Sequence
from concurrent.futures import ProcessPoolExecutor
from typing import Any

import numpy as np
import pandas as pd

from model import backtest, metrics, official
from model.calibrate import event_mask
from model.probability import HORIZONS_H, arrival_window, exceedance
from model.train import (
    DEFAULT_SPLITS,
    MODELS_DIR,
    WEB_DATA,
    GaugeModel,
    build_xy,
    is_current,
    load_hourly,
    load_lags,
    train_gauge,
)

log = logging.getLogger(__name__)

TARGETS: tuple[str, ...] = ("newbotley", "minns", "coldharbour", "kingsmill")
REPLAY_DIR = WEB_DATA / "replays"
PROOF_PATH = WEB_DATA / "proof.json"
PER_EVENT_P_STAR = 0.5  # perEvent.leadVsOfficialH is a single number; we report it at p* = 0.5
ARRIVAL_OFFSET_H = 24  # perEvent.arrivalErrH: forecast issued 24 h before the (first) crossing
# #38 adds Proof.officialOutcome and perEvent.officialIssuedAt. Written only once the contract has them.
CONTRACTS_TS = WEB_DATA.parent.parent / "src" / "contracts.ts"
# Hours between replay issue times; 1 (SPEC §8.1) unless listed. e2014 is the 2-month headline event:
# hourly it would be 6.6 MB, every 2 h it is 3.3 MB, and the Time Machine plays it smoothly (#39).
REPLAY_EVERY_H: dict[str, int] = {"e2014": 2}

TEST_PERIOD_NOTE = (
    "Skill, interval coverage and reliability are scored on the strict time-split test period (issue "
    "times from {test_start}), which no model saw in training or calibration; they pool the trained "
    "gauges {gauges}. Coverage pools quiet and flood rows; inside flood windows the 90% interval covers"
    " {flood90} and the 80% interval {flood80} across leads. Reliability and Brier scores ask whether "
    "the level reached the line at some time in (t, t + h], which is what the flood probability for "
    "lead h means (it never falls with lead), and leave out hours when the river was already over the "
    "line, as the event scores do. Hits, misses, false alarms, lead times and arrival errors come from "
    "the event replays: each event is forecast by models retrained without that event (+- 7 days), so "
    "those models may have learned from floods that happened after the replayed one. Events in the test"
    " period ({test_events}) use the time-split models directly. Repeat crossings within 72 h count as "
    "one flood. An EA Flood Warning counts as in force from its issue time until 24 h after its last "
    "Update, and is scored on the same hours and rules as our trigger. Lead versus the EA compares "
    "first messages within the same flood. Arrival error uses the forecast issued 24 h before the first"
    " crossing and is blank when that forecast did not reach 50%. Abingdon Rd shares the EA warning "
    "area 061FWF23NwBotley with Botley, so its lead versus the EA is measured against the Botley "
    "warning, while its own gauge crosses later. Each spot's warn-at level (warnAt) was chosen on the "
    "validation flood replays only (issue times before {test_start}: {val_events}) by one fixed rule, "
    "then frozen and scored on the test events. Few events, so intervals are wide."
)


# --------------------------------------------------------------------------- models


def main_models(
    hourly: pd.DataFrame, targets: Sequence[str], lags: Any, **fit_kwargs: Any
) -> dict[str, GaugeModel]:
    """Time-split models per gauge: loaded from ``data/models/<gauge>`` or trained and saved there."""
    out = {}
    for g in targets:
        d = MODELS_DIR / g
        if (d / "meta.json").exists():
            m = GaugeModel.load(d)
            if not is_current(m, lags):
                raise SystemExit(
                    f"{d} does not match the current config (upstream gauges or lags, #125): "
                    "run `make train` first"
                )
            out[g] = m
            continue
        log.info("training main model %s", g)
        m = train_gauge(hourly, g, lags=lags, **fit_kwargs)
        m.save(d)
        out[g] = m
    return out


def event_period(
    event: Mapping[str, Any], test_start: pd.Timestamp = DEFAULT_SPLITS.test_start
) -> str | None:
    """"validation" if the event window ends before the test period, "test" if it starts in it.

    Used to choose the per-spot warn-at levels (#134) on validation floods only. An event straddling
    ``test_start`` would be neither (none does); ``metrics.choose_warn_at`` also cuts at ``test_start``.
    """
    start, end = backtest.event_window(event)
    if end < test_start:
        return "validation"
    if start >= test_start:
        return "test"
    return None


def in_test_period(event: Mapping[str, Any], test_start: pd.Timestamp = DEFAULT_SPLITS.test_start) -> bool:
    """True if the leave-one-out exclusion window (event +- 7 days) lies wholly in the test period."""
    start, _ = backtest.event_window(event)
    return start - backtest.LOFO_MARGIN >= test_start


# --------------------------------------------------------------------------- replays


def consistent_arrivals(replay: dict[str, Any], spots: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """Recompute each probability spot's arrival from the values the replay shows (SPEC §7.5 step 5).

    ``model.probability.arrival_window`` is applied to the rounded ``pFlood`` and ``levelNow`` written to
    the file, so a p of 0.09996 shown as 0.1 gives an arrival time (the app and the validator read the
    rounded values). At or above the threshold every arrival time is ``issuedAt`` (#67).
    """
    thr = {s["key"]: s["threshold"] for s in spots if s.get("mode") == "probability" and s.get("threshold")}
    for fc in replay["forecasts"]:
        issued = pd.Timestamp(fc["issuedAt"])
        for sf in fc["spots"]:
            t = thr.get(sf["spot"])
            if t is None or not sf["leads"] or sf["levelNow"] is None:
                continue
            leads = [ld["h"] for ld in sf["leads"]]
            ps = [ld["pFlood"] for ld in sf["leads"]]
            sf["arrival"] = arrival_window(issued, leads, ps, sf["levelNow"], t)
    return replay


def _replay_job(args: tuple[str, dict[str, Any], list[str], dict[str, Any], bool]) -> str:
    """Build and write one replay (runs in a worker process)."""
    event_id, event, targets, fit_kwargs, use_main = args
    logging.basicConfig(level=logging.INFO, format=f"%(levelname)s [{event_id}] %(name)s: %(message)s")
    t0 = time.time()
    hourly = load_hourly()
    lags = load_lags()
    # Models train on the same (unrounded) levels as ``make train`` and ``model.backtest --train-only``,
    # so the leave-one-out cache doesn't depend on which command filled it (#81).
    if use_main:
        models = main_models(hourly, targets, lags, **fit_kwargs)
    else:
        models = backtest.lofo_models(hourly, event_id, event, targets, lags, **fit_kwargs)
    # Forecast from levels to the mm, as the replay shows them: otherwise a level of 2.4398 m is shown
    # as 2.440 (at the 2.44 m threshold) while its arrival was computed as "below the line" (SPEC §7.5
    # step 5). Gauges read to the mm, so this changes forecasts by < 0.5 mm.
    hourly["level_mean"] = hourly["level_mean"].round(3)
    spots = backtest.load_spots()
    every_h = REPLAY_EVERY_H.get(event_id, 1)
    replay = consistent_arrivals(
        backtest.build_replay(hourly, models, event_id, event, spots, every_h=every_h), spots
    )
    path = backtest.write_json(replay, REPLAY_DIR / f"{event_id}.json")
    log.info("wrote %s (%.1f MB) in %.0f s", path, path.stat().st_size / 1e6, time.time() - t0)
    return str(path)


def _set_lgb_threads(threads: str) -> None:
    os.environ["RC_LGB_THREADS"] = threads


def ensure_replays(
    events: Mapping[str, Mapping[str, Any]],
    targets: Sequence[str],
    rebuild: bool,
    jobs: int,
    fit_kwargs: Mapping[str, Any],
) -> dict[str, dict[str, Any]]:
    """Every event's replay, built (in parallel processes) where missing or when ``rebuild``."""
    todo = [eid for eid in events if rebuild or not (REPLAY_DIR / f"{eid}.json").exists()]
    if todo:
        log.info("building replays for %s with %d worker(s)", todo, jobs)
        args = [
            (eid, dict(events[eid]), list(targets), dict(fit_kwargs), in_test_period(events[eid]))
            for eid in todo
        ]
        if jobs > 1:
            # Share the cores between the workers' LightGBM fits (an explicit RC_LGB_THREADS wins).
            threads = os.environ.get("RC_LGB_THREADS") or str(max(1, (os.cpu_count() or jobs) // jobs))
            with ProcessPoolExecutor(
                max_workers=jobs, initializer=_set_lgb_threads, initargs=(threads,)
            ) as ex:
                list(ex.map(_replay_job, args))
        else:
            for a in args:
                _replay_job(a)
    return {eid: json.loads((REPLAY_DIR / f"{eid}.json").read_text(encoding="utf-8")) for eid in events}


# --------------------------------------------------------------------------- test-period scores


def test_period_scores(
    hourly: pd.DataFrame, models: Mapping[str, GaugeModel], spots: Sequence[Mapping[str, Any]]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, list[dict[str, Any]]], list[dict[str, Any]]]:
    """``skillByLead``, ``coverage`` and ``reliability`` on the test period (rows the models never saw).

    The 4th value is interval coverage on the test rows inside flood windows only (the windows the
    intervals are calibrated on, SPEC §7.4); it is reported in ``testPeriodNote`` (#85).
    """
    pooled_model: dict[int, list[np.ndarray]] = {h: [] for h in HORIZONS_H}
    pooled_pers: dict[int, list[np.ndarray]] = {h: [] for h in HORIZONS_H}
    pooled_y: dict[int, list[np.ndarray]] = {h: [] for h in HORIZONS_H}
    flood_rows: list[np.ndarray] = []
    reliability: dict[str, list[dict[str, Any]]] = {}
    for g, m in models.items():
        X, Y = build_xy(hourly, g, m.medians, m.lags, HORIZONS_H, m.upstreams)
        in_flood = event_mask(X["level_now"], m.amber).to_numpy()
        test = X.index >= m.splits.test_start
        X, Y, in_flood = X[test], Y[test], in_flood[test]
        level_now = X["level_now"].to_numpy(dtype=float)
        ok_now = np.isfinite(level_now)
        X, Y, level_now = X[ok_now], Y[ok_now], level_now[ok_now]
        flood_rows.append(in_flood[ok_now])
        q_model = m.predict(X)
        q_pers = m.persistence(len(X))
        log.info("%s: %d test rows from %s", g, len(X), m.splits.test_start.date())
        for h in HORIZONS_H:
            pooled_model[h].append(q_model[h])
            pooled_pers[h].append(q_pers[h])
            pooled_y[h].append(Y[f"y_{h}h"].to_numpy(dtype=float))
        level = hourly[hourly["gauge"] == g].set_index("ts_utc")["level_mean"]
        ahead = {h: metrics.max_level_ahead(level, X.index, h) for h in HORIZONS_H}
        for s in spots:
            if s["gauge"] != g or s.get("mode") != "probability" or s.get("threshold") is None:
                continue
            thr = float(s["threshold"])
            # P(level > threshold) per lead, non-decreasing in lead (as shown in the app, SPEC §7.5)
            qm = np.stack([q_model[h] for h in HORIZONS_H], axis=1)  # (n, leads, 7)
            qp = np.stack([q_pers[h] for h in HORIZONS_H], axis=1)
            pm = exceedance(level_now[:, None, None], qm, thr)
            pp = exceedance(level_now[:, None, None], qp, thr)
            rows = []
            for i, h in enumerate(HORIZONS_H):
                # "Over the line by t + h", as pFlood_h means; hours already over the line are left out (#91)
                at_h = level_now + Y[f"y_{h}h"].to_numpy(dtype=float)
                o = metrics.exceedance_by_outcome(level_now, at_h, ahead[h], thr)
                rows.append(metrics.reliability_entry(h, pm[:, i], pp[:, i], o))
            reliability[s["key"]] = rows
    cat = {
        k: {h: np.concatenate(v[h]) for h in HORIZONS_H}
        for k, v in {"m": pooled_model, "p": pooled_pers, "y": pooled_y}.items()
    }
    skill = metrics.skill_by_lead(cat["m"], cat["p"], cat["y"])
    coverage = metrics.coverage_by_lead(cat["m"], cat["y"])
    fl = np.concatenate(flood_rows)
    flood_coverage = metrics.coverage_by_lead(
        {h: q[fl] for h, q in cat["m"].items()}, {h: y[fl] for h, y in cat["y"].items()}
    )
    return skill, coverage, reliability, flood_coverage


def coverage_range(rows: Sequence[Mapping[str, Any]], nominal: float) -> str:
    """'0.86-0.91': lowest to highest actual coverage over leads for one nominal level."""
    vals = [r["actual"] for r in rows if np.isclose(r["nominal"], nominal) and np.isfinite(r["actual"])]
    return f"{min(vals):.2f}–{max(vals):.2f}" if vals else "n/a"


# --------------------------------------------------------------------------- event scores


def _crossing_times(replay: Mapping[str, Any], spot: str) -> list[pd.Timestamp]:
    """Flood onsets for ``spot``: repeat crossings within 72 h of the previous one are the same flood."""
    return metrics.flood_onsets(pd.Timestamp(c["t"]) for c in replay["crossings"] if c["spot"] == spot)


OFFICIAL_LEVELS: tuple[str, ...] = ("warning", "severe")


def official_messages(
    warnings: pd.DataFrame | None,
    replay: Mapping[str, Any],
    spot: str,
    codes: Sequence[str],
    window: tuple[pd.Timestamp, pd.Timestamp],
) -> list[tuple[pd.Timestamp, bool]]:
    """``(issued_at, is_update)`` of the EA Flood Warnings (and Severe) for ``spot`` in the event window.

    Updates come from ``warnings.parquet`` (the replay's ``official`` list leaves them out); without it,
    the replay's messages are used, with no updates.
    """
    if warnings is None:
        return [
            (pd.Timestamp(o["issuedAt"]), False)
            for o in replay["official"]
            if o["spot"] == spot and o["type"] in OFFICIAL_LEVELS
        ]
    start, end = window
    w = warnings[
        warnings["area_code"].isin(list(codes))
        & warnings["type"].isin(OFFICIAL_LEVELS)
        & (warnings["issued_at"] >= start)
        & (warnings["issued_at"] <= end)
    ]
    is_update = w["message"].fillna("").str.lower().str.startswith("update")
    return sorted({(pd.Timestamp(t), bool(u)) for t, u in zip(w["issued_at"], is_update, strict=True)})


def official_triggers(
    messages: Sequence[tuple[pd.Timestamp, bool]],
    replay: Mapping[str, Any],
    spot: str,
    threshold: float,
    end: pd.Timestamp,
) -> pd.DatetimeIndex:
    """Times at which the official warning counts as a trigger (#92).

    The grid is the replay's issue times plus each warning's own issue time (a warning at 20:43 before
    a 21:00 crossing is a hit, as it was before). As for our trigger, times when the river is already
    at or above the line (the latest replay ``levelNow`` at or before t) are left out: the flood is
    here. Unlike ours, hours with stale gauge data still count, because the EA's warning doesn't
    depend on our data.
    """
    level = pd.Series(
        {
            pd.Timestamp(fc["issuedAt"]): sf["levelNow"]
            for fc in replay["forecasts"]
            for sf in fc["spots"]
            if sf["spot"] == spot
        },
        dtype=float,
    ).sort_index()
    fresh = pd.DatetimeIndex([t for t, is_update in messages if not is_update])
    grid = level.index.union(fresh)
    now = level.reindex(grid, method="ffill") if len(level) else pd.Series(np.nan, index=grid)
    below = grid[~(now.to_numpy(dtype=float) >= threshold)]  # unknown level counts as below
    return metrics.in_force_times(messages, below, end=end)


def peak_observed(hourly: pd.DataFrame, gauge: str, event: Mapping[str, Any]) -> float | None:
    """Highest hourly ``level_mean`` in the event window (the quantity crossings use)."""
    start, end = backtest.event_window(event)
    lv = hourly[(hourly["gauge"] == gauge) & (hourly["ts_utc"] >= start) & (hourly["ts_utc"] <= end)]
    v = lv["level_mean"].max()
    return None if pd.isna(v) else round(float(v), 3)


def load_warnings() -> pd.DataFrame | None:
    if not backtest.WARNINGS_PATH.exists():
        log.warning("%s missing: no comparison with official warnings", backtest.WARNINGS_PATH)
        return None
    return pd.read_parquet(backtest.WARNINGS_PATH)


def event_scores(
    replays: Mapping[str, Mapping[str, Any]],
    events: Mapping[str, Mapping[str, Any]],
    spots: Sequence[Mapping[str, Any]],
    hourly: pd.DataFrame,
    warnings: pd.DataFrame | None,
) -> dict[str, Any]:
    """``tradeoff``, ``perEvent`` and (#38) ``officialOutcome`` from the replays."""
    prob_spots = [s for s in spots if s.get("mode") == "probability" and s.get("threshold") is not None]
    p_series = {
        (eid, s["key"]): metrics.spot_probability(r["forecasts"], s["key"], s["threshold"])
        for eid, r in replays.items()
        for s in prob_spots
    }
    windows = {eid: backtest.event_window(events[eid]) for eid in replays}
    areas = official.spot_areas_from_spots([s for s in spots if s.get("warningArea")])
    # Flood onsets per event and spot: lead vs official is paired within the first flood (#90, #92).
    onsets = {(eid, s["key"]): _crossing_times(r, s["key"]) for eid, r in replays.items() for s in prob_spots}
    comparison = None
    if warnings is not None:
        comparison = official.compare_events(
            p_series, warnings, windows, metrics.P_STARS, areas, onsets=onsets
        )

    periods = {eid: event_period(events[eid]) for eid in replays}
    periods = {eid: per for eid, per in periods.items() if per is not None}

    def event_vs_official(eid: str, p_star: float, key: str) -> float | None:
        """Lead vs the first EA Flood Warning for one event, spot and p* (first flood only, as perEvent)."""
        if comparison is None:
            return None
        sel = comparison[
            (comparison["event_id"] == eid)
            & (comparison["spot"] == key)
            & np.isclose(comparison["p_star"], p_star)
        ]["lead_vs_warning_h"]
        sel = pd.to_numeric(sel, errors="coerce").dropna()
        return None if sel.empty else float(sel.iloc[0])

    tradeoff: dict[str, list[dict[str, Any]]] = {}
    warn_at: dict[str, dict[str, Any]] = {}
    official_outcome: dict[str, dict[str, Any]] = {}
    per_event: list[dict[str, Any]] = []
    arrival: dict[int, list[float]] = {h: [] for h in metrics.ARRIVAL_OFFSETS_H}
    for s in prob_spots:
        key = s["key"]
        p_by_event = {eid: p_series[(eid, key)] for eid in replays}
        cross_by_event = {eid: _crossing_times(r, key) for eid, r in replays.items()}

        def vs_official(p_star: float, key: str = key) -> float | None:
            if comparison is None:
                return None
            return official.mean_lead_vs_official(comparison, key, p_star)

        tradeoff[key] = metrics.tradeoff_rows(p_by_event, cross_by_event, lead_vs_official=vs_official)
        warn_at[key] = metrics.warn_at_entry(
            p_by_event,
            cross_by_event,
            periods,
            DEFAULT_SPLITS.test_start,
            lead_vs_official=lambda eid, p_star, key=key: event_vs_official(eid, p_star, key),
        )
        official_outcome[key] = metrics.official_outcome(
            {
                eid: official_triggers(
                    official_messages(warnings, r, key, areas.get(key, ()), windows[eid]),
                    r,
                    key,
                    float(s["threshold"]),
                    windows[eid][1],
                )
                for eid, r in replays.items()
            },
            cross_by_event,
        )
        for eid, r in replays.items():
            peak = peak_observed(hourly, s["gauge"], events[eid])
            if peak is None:
                continue
            cross = cross_by_event[eid]
            for h, errs in metrics.arrival_errors(r["forecasts"], key, cross).items():
                arrival[h] += errs
            lead = issued = None
            if comparison is not None:
                sel = comparison[
                    (comparison["event_id"] == eid)
                    & (comparison["spot"] == key)
                    & np.isclose(comparison["p_star"], PER_EVENT_P_STAR)
                ]
                if not sel.empty:
                    v = sel["lead_vs_warning_h"].iloc[0]
                    lead = None if v is None or pd.isna(v) else round(float(v), 2)
                    w = sel["warning_at"].iloc[0]
                    issued = None if w is None or pd.isna(w) else official.iso(w)
            per_event.append(
                {
                    "eventId": eid,
                    "spot": key,
                    "crossed": bool(cross),
                    "peakObs": peak,
                    "arrivalErrH": metrics.arrival_error_h(r["forecasts"], key, cross[0], ARRIVAL_OFFSET_H)
                    if cross
                    else None,
                    "leadVsOfficialH": lead,
                    "officialIssuedAt": issued,
                }
            )
    return {
        "tradeoff": tradeoff,
        "perEvent": per_event,
        "officialOutcome": official_outcome,
        "warnAt": warn_at,
        "arrivalErrors": arrival,
    }


# --------------------------------------------------------------------------- assemble


def contract_has_38() -> bool:
    """True once contracts.ts has the #38 additions (officialOutcome, perEvent.officialIssuedAt)."""
    return CONTRACTS_TS.exists() and "officialOutcome" in CONTRACTS_TS.read_text(encoding="utf-8")


def assemble(
    skill: list[dict[str, Any]],
    coverage: list[dict[str, Any]],
    reliability: dict[str, list[dict[str, Any]]],
    ev: Mapping[str, Any],
    note: str,
    with_38: bool,
) -> dict[str, Any]:
    """The §9 ``Proof`` dict (plus the #38 fields when ``with_38``)."""
    per_event = [dict(r) for r in ev["perEvent"]]
    if not with_38:
        for r in per_event:
            r.pop("officialIssuedAt", None)
    proof: dict[str, Any] = {
        "skillByLead": skill,
        "coverage": coverage,
        "reliability": reliability,
        "tradeoff": ev["tradeoff"],
        "perEvent": per_event,
        "testPeriodNote": note,
    }
    if with_38:
        proof["officialOutcome"] = ev["officialOutcome"]
    if ev.get("warnAt"):  # per-spot warn-at levels chosen on validation floods (#134)
        proof["warnAt"] = ev["warnAt"]
    return proof


def summary(proof: Mapping[str, Any], ev: Mapping[str, Any]) -> str:
    """Headline numbers for the log (and the PR)."""
    lines = ["skill by lead: " + ", ".join(f"{r['h']}h {r['skill']:+.2f}" for r in proof["skillByLead"])]
    cov = {(c["h"], c["nominal"]): c["actual"] for c in proof["coverage"]}
    lines.append(
        "coverage (50/80/90): "
        + "; ".join(f"{h}h {cov[(h, 0.5)]:.2f}/{cov[(h, 0.8)]:.2f}/{cov[(h, 0.9)]:.2f}" for h in HORIZONS_H)
    )
    for spot, rows in proof["tradeoff"].items():
        r = next(x for x in rows if x["pStar"] == 0.5)
        lines.append(
            f"{spot} p*=0.5: hits {r['hits']} misses {r['misses']} FA {r['falseAlarms']} "
            f"lead {r['meanLeadH']} vsOfficial {r['meanLeadVsOfficialH']} ci90 {r.get('ci90')}"
        )
    for spot, o in ev["officialOutcome"].items():
        lines.append(f"{spot} official: {o}")
    for spot, w in ev.get("warnAt", {}).items():
        for period in ("validation", "test"):
            a, d = w[period], w["atDefault"][period]
            lines.append(
                f"{spot} warn-at p*={w['pStar']} {period}: hits {a['hits']} misses {a['misses']} FA "
                f"{a['falseAlarms']} lead {a['meanLeadH']} vsEA {a['meanLeadVsOfficialH']} | p*=0.5: hits "
                f"{d['hits']} misses {d['misses']} FA {d['falseAlarms']} lead {d['meanLeadH']} "
                f"vsEA {d['meanLeadVsOfficialH']}"
            )
    for r in proof["perEvent"]:
        lines.append(
            f"{r['eventId']} {r['spot']}: crossed={r['crossed']} peak={r['peakObs']} "
            f"arrErr={r['arrivalErrH']} vsOfficial={r['leadVsOfficialH']}"
        )
    for h, errs in ev["arrivalErrors"].items():
        if errs:
            lines.append(
                f"arrival error {h}h before: n={len(errs)} median {np.median(errs):+.1f} h, "
                f"mean |err| {np.mean(np.abs(errs)):.1f} h"
            )
    return "\n".join(lines)


def main(argv: Sequence[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="Write proof.json and all replays (SPEC §8)")
    ap.add_argument("--events", nargs="+", help="default: every event in config/events.yaml")
    ap.add_argument("--targets", nargs="+", default=list(TARGETS))
    ap.add_argument("--rebuild", action="store_true", help="rebuild replays that already exist")
    ap.add_argument("--jobs", type=int, default=1, help="events built in parallel processes")
    ap.add_argument("--n-estimators", type=int, help="fewer boosting rounds (faster, recorded in the log)")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    t0 = time.time()
    fit_kwargs: dict[str, Any] = {}
    if args.n_estimators:
        fit_kwargs["n_estimators"] = args.n_estimators
    all_events = backtest.load_events()
    events = {e: all_events[e] for e in (args.events or all_events)}
    spots = backtest.load_spots()
    hourly = load_hourly()
    lags = load_lags()
    models = main_models(hourly, args.targets, lags, **fit_kwargs)
    skill, coverage, reliability, flood_coverage = test_period_scores(hourly, models, spots)
    log.info("test-period scores done (%.0f s)", time.time() - t0)
    replays = ensure_replays(events, args.targets, args.rebuild, args.jobs, fit_kwargs)
    ev = event_scores(replays, events, spots, hourly, load_warnings())
    test_start = DEFAULT_SPLITS.test_start
    note = TEST_PERIOD_NOTE.format(
        flood90=coverage_range(flood_coverage, 0.9),
        flood80=coverage_range(flood_coverage, 0.8),
        test_start=test_start.strftime("%Y-%m-%d"),
        gauges=", ".join(args.targets),
        test_events=", ".join(e for e in events if in_test_period(events[e])) or "none",
        val_events=", ".join(e for e in events if event_period(events[e]) == "validation") or "none",
    )
    proof = assemble(skill, coverage, reliability, ev, note, contract_has_38())
    path = backtest.write_json(proof, PROOF_PATH)
    log.info("wrote %s in %.0f s\n%s", path, time.time() - t0, summary(proof, ev))


if __name__ == "__main__":
    main()
