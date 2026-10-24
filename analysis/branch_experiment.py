"""Branch signals for coldharbour and kingsmill (issue #134 "A-branch", after #125 A): an experiment.

Question: #125 A's raw further-upstream columns (about 9 per gauge) helped newbotley and minns but
overfitted coldharbour and kingsmill at 72 h. Does ONE timed signal per tributary branch
(``model.features.BRANCHES``: +6 columns at coldharbour, +2 at kingsmill) keep A's 24-48 h gains
there without the 72 h loss?

Arms (same LightGBM quantile model, SPEC §7.3 params, splits, weights, early stopping, §7.4 CQR, via
``model.train.train_gauge``; never a second model, SPEC §1.1):

- ``baseline``: the shipped columns (models trained by ``make train`` on data-hourly-v1; the branch
  columns are built but not used by these models).
- ``routed``: baseline + branch signals, each gauge shifted by its own travel time (the PR candidate).
- ``front``: baseline + branch signals aligned to the branch's fastest gauge (lag 0) instead.
- ``araw``: #125 A's raw columns (about 9 per new gauge), retrained here so every arm shares one
  baseline and one data snapshot.
- ``<arm>_s<seed>`` (e.g. ``baseline_s7``, ``ff05_s7``): the same arm with another LightGBM seed, to
  see how much of a difference is seed noise.
- ``ff05``: #125 A's raw columns with ``feature_fraction`` 0.5 (the research note's cheap check of
  the "too many correlated columns" explanation). Not a candidate (it departs from the §7.3 params).

Data: data-hourly-v1 plus the six #125 A gauges ingested by ``analysis/upstream_experiment.py``
(``ingest`` + ``combine``; Hydrology 15-min level from 2006, cleaned by ``pipeline.clean``). Lags:
the shipped lags.json plus the §6 matched pairs for the new gauges (identical to #125 A's).

Result (24 Oct 2026, strict test >= 2021-10-01; full table on issue #134): NOT ADOPTED
-------------------------------------------------------------------------------------
No arm passes the rule (24-72 h skill up, no lead worse by > 0.01, Brier no worse, no extra false
alarms). routed: coldharbour worse at every lead (72 h -0.318 -> -0.365), kingsmill 12 h -0.022.
front: coldharbour 24/48/72 h worse, kingsmill 12 h -0.027, +1 Abingdon Rd false alarm at warn-at 0.2.
ff05: coldharbour 36-72 h better at seed 42 (72 h +0.044) but WORSE at seed 7 (72 h -0.040 vs that
seed's baseline). The same model retrained with seed 7 moves 48/72 h skill by up to 0.04, so most
72 h differences here (and #125 A's 72 h "loss" at these two spots) are within seed noise. Consistent
across seeds: raw new-gauge columns help coldharbour at 36 h (+0.10 to +0.14) and kingsmill at
24-36 h, and give Abingdon Rd an earlier e2024a trigger at warn-at 0.2 (EA lead -8.5 h -> +13.5 to
+22.5 h, one flood), at a cost at 6-12 h and in-event 80 % coverage (0.76 -> 0.68 at 24 h).

Usage (needs analysis/upstream_experiment.py from branch model/exp-upstream, and its data)::

    RC_LGB_THREADS=1 python -m analysis.branch_experiment train --arms routed ff05 front --jobs 4
    python -m analysis.branch_experiment evaluate
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
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
from typing import Any

from model import features
from model.train import MODELS_DIR, GaugeModel

log = logging.getLogger(__name__)

TARGETS: tuple[str, ...] = ("coldharbour", "kingsmill")
ARMS: tuple[str, ...] = ("routed", "ff05", "front", "araw")
OUT_DIR = MODELS_DIR / "exp134b"
OUT_PATH = Path(os.environ.get("RC_DATA_DIR", Path(__file__).resolve().parent.parent / "data"))
OUT_PATH = OUT_PATH / "processed" / "exp134b_branch.json"
WARN_AT = {"abingdonrd": 0.2, "cherwell": 0.3}  # proof.json warnAt (frozen, chosen on validation)


@contextlib.contextmanager
def arm(name: str) -> Iterator[dict[str, Any]]:
    """Set the feature definition for one arm (restored on exit). Yields extra fit kwargs."""
    from analysis import upstream_experiment as ue

    saved = (features.BRANCHES, features.BRANCH_ALIGN, features.UPSTREAMS)
    kw: dict[str, Any] = {}
    name, _, seed = name.partition("_s")  # "<arm>_s<seed>": the same arm with another LightGBM seed
    try:
        if seed:
            kw["params"] = {"seed": int(seed)}
        if name == "baseline":
            features.BRANCHES = {}
        elif name in ("routed", "front"):
            features.BRANCH_ALIGN = name
        elif name in ("araw", "ff05"):
            features.BRANCHES = {}
            features.UPSTREAMS = {k: tuple(v) for k, v in ue.extended_map().items()}
            if name == "ff05":
                kw["params"] = {**kw.get("params", {}), "feature_fraction": 0.5}
        else:
            raise ValueError(name)
        yield kw
    finally:
        features.BRANCHES, features.BRANCH_ALIGN, features.UPSTREAMS = saved


def _train_job(args: tuple[str, str, int]) -> str:
    """One (arm, target, lead), saved to ``exp134b/<arm>/<target>/parts/h<h>/``; skipped if done."""
    from analysis import upstream_experiment as ue
    from model.train import train_gauge

    name, target, h = args
    d = OUT_DIR / name / target / "parts" / f"h{h}"
    if (d / "meta.json").exists():
        return f"{name} {target} h{h}: done before"
    logging.basicConfig(level=logging.WARNING)
    hourly, lags = ue.load_hourly_ext(), ue.combined_lags()
    t0 = time.time()
    with arm(name) as kw:
        m = train_gauge(hourly, target, lags=lags, horizons=[h], **kw)
    m.info["arm"] = name
    m.save(d)
    return f"{name} {target} h{h}: {time.time() - t0:.0f} s, {len(m.feature_cols)} cols"


def merge(name: str, target: str) -> GaugeModel:
    """Merge the per-lead parts into ``exp134b/<arm>/<target>/``."""
    from model.probability import HORIZONS_H

    parts = OUT_DIR / name / target / "parts"
    models = {h: GaugeModel.load(parts / f"h{h}") for h in HORIZONS_H}
    m = models[HORIZONS_H[0]]
    for h, mh in models.items():
        if mh.feature_cols != m.feature_cols:
            raise RuntimeError(f"{name} {target} h={h}: feature columns differ")
        m.boosters[h], m.cqr[h], m.persistence_eps[h] = mh.boosters[h], mh.cqr[h], mh.persistence_eps[h]
        m.info.setdefault("leads", {}).update(mh.info.get("leads", {}))
    m.save(OUT_DIR / name / target)
    return m


def train(arms: Sequence[str], targets: Sequence[str], jobs: int) -> None:
    from model.probability import HORIZONS_H

    work = [(a, t, h) for a in arms for t in targets for h in sorted(HORIZONS_H, reverse=True)]
    with ProcessPoolExecutor(max_workers=jobs) as ex:
        for msg in ex.map(_train_job, work):
            log.info(msg)
    for a in arms:
        for t in targets:
            merge(a, t)


def importance_branch(m: GaugeModel, prefixes: Sequence[str]) -> list[dict[str, Any]]:
    """Share of gain (mean over alphas) carried by columns starting with ``prefixes``, per lead."""
    out = []
    for entry in m.importance():
        share = sum(f["gain"] for f in entry["features"] if f["name"].startswith(tuple(prefixes)))
        top = [f for f in entry["features"] if f["name"].startswith(tuple(prefixes))][:3]
        out.append({"h": entry["h"], "share": round(share, 4), "top": top})
    return out


def evaluate(arms: Sequence[str]) -> dict[str, Any]:
    from analysis import upstream_experiment as ue
    from model import backtest
    from model.train import build_xy

    hourly = ue.load_hourly_ext()
    spots = [s for s in backtest.load_spots() if s["gauge"] in TARGETS]
    base_dir = OUT_DIR / "baseline"
    variants = {"baseline": {t: GaugeModel.load(base_dir / t) for t in TARGETS}}  # make train models
    for a in arms:
        variants[a] = {
            t: GaugeModel.load(OUT_DIR / a / t) for t in TARGETS if (OUT_DIR / a / t / "meta.json").exists()
        }
    test_start = variants["baseline"][TARGETS[0]].splits.test_start
    rows = {}
    for g in TARGETS:
        X, _ = build_xy(hourly, g, variants["baseline"][g].medians, variants["baseline"][g].lags)
        ok = X["level_now"].notna() & (X.index >= test_start)
        rows[g] = X.index[ok.to_numpy()]
    period = (test_start, hourly["ts_utc"].max())
    ev_ids = [e for e in ue.TEST_EVENTS if e in backtest.load_events()]
    out: dict[str, Any] = {"issue": 134, "experiment": "A-branch", "testStart": str(test_start)}
    out["variants"] = {}
    for name, models in variants.items():
        if set(models) != set(TARGETS):
            log.warning("%s: models missing (%s); skipped", name, sorted(models))
            continue
        res: dict[str, Any] = {}
        with arm(name):
            ups = features.UPSTREAMS
            for p_star in sorted({0.5, *WARN_AT.values()}):
                ue.P_STAR = p_star
                res[f"full@{p_star}"] = ue.score_variant(name, models, hourly, spots, rows, period, ups)
                res[f"events@{p_star}"] = ue.event_variant(name, models, hourly, spots, ev_ids, ups)
        prefixes = (
            ["br_"]
            if name.split("_s")[0] in ("routed", "front", "baseline")
            else [f"{g}_" for gs in ue.new_pairs().values() for g in gs]
        )
        res["importance"] = {g: importance_branch(m, prefixes) for g, m in models.items()}
        res["nCols"] = {g: len(m.feature_cols) for g, m in models.items()}
        out["variants"][name] = res
        log.info("scored %s", name)
    return out


def report(res: Mapping[str, Any]) -> str:
    lines = [f"#134 A-branch, test >= {res['testStart'][:10]}"]
    for name, v in res["variants"].items():
        full = v["full@0.5"]
        lines.append(f"== {name} cols {v['nCols']}")
        for g, sk in full["skillByGauge"].items():
            lines.append(f"  {g:12s} skill " + " ".join(f"{r['h']}h {r['skill']:+.3f}" for r in sk))
        for h, c in full["coverage"].items():
            lines.append(
                f"  cov {h}h all90 {c['all90']:.3f} event50/80/90 "
                f"{c['event50']:.2f}/{c['event80']:.2f}/{c['event90']:.2f}"
            )
        for spot, br in full["brier"].items():
            lines.append(f"  {spot} Brier " + " ".join(f"{h}h {b:.5f}" for h, b in br.items()))
        for p_star in sorted({0.5, *WARN_AT.values()}):
            f = v[f"full@{p_star}"]["outcomesP50"]
            for spot, o in f.items():
                if p_star != 0.5 and WARN_AT.get(spot) != p_star:
                    continue
                lines.append(
                    f"  p*={p_star} {spot}: hits {o['hits']} miss {o['misses']} "
                    f"FA {o['falseAlarms']} lead {o['meanLeadH']}"
                )
            for ft in v[f"events@{p_star}"]["firstTrigger"]:
                if p_star != 0.5 and WARN_AT.get(ft["spot"]) != p_star:
                    continue
                lines.append(
                    f"  p*={p_star} {ft['eventId']} {ft['spot']}: "
                    f"vs crossing {ft['leadVsCrossingH']} vs EA {ft['leadVsWarningH']}"
                )
        for g, imp in v["importance"].items():
            lines.append(
                f"  {g} new-input gain share " + " ".join(f"{r['h']}h {r['share']:.2f}" for r in imp)
            )
    return "\n".join(lines)


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("train")
    t.add_argument("--arms", nargs="+", default=list(ARMS))
    t.add_argument("--targets", nargs="+", default=list(TARGETS))
    t.add_argument("--jobs", type=int, default=4)
    e = sub.add_parser("evaluate")
    e.add_argument("--arms", nargs="+", default=list(ARMS))
    e.add_argument("--out", default=str(OUT_PATH))
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    if args.cmd == "train":
        train(args.arms, args.targets, args.jobs)
    else:
        res = evaluate(args.arms)
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(json.dumps(res, indent=1, default=str), encoding="utf-8")
        print(report(res))
    return 0


if __name__ == "__main__":
    sys.exit(main())
