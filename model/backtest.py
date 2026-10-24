"""Leave-one-flood-out replays (SPEC §8.1); proof metrics (§8.2) are issue #11.

Issue #8.

``python -m model.backtest [--event e2014] [--targets newbotley] [--retrain] [--train-only] [--every-h N]``:

1. Leave-one-flood-out: train every target model with the event window ± 7 days removed from training
   and calibration (cached under ``$RC_DATA_DIR/models/lofo/<event>/<gauge>/``; ``--retrain`` refits).
2. Issue a forecast every hour across the event window for every spot (SPEC §7.5).
3. Write ``web/public/data/replays/<event>.json`` (SPEC §9 ``Replay``).

No look-ahead: an hourly row labelled L (hour start) holds the readings from L to L + 45 min, so it is
complete only at L + 1 h (#93). A forecast issued at t therefore uses rows labelled <= t - 1 h: features
(``model.features``), ``level_now``, ``dataAsOf`` and ``stale`` all come from those rows, i.e. only from
readings taken before t. ``tests/test_backtest.py`` checks that a forecast computed from
``hourly[ts_utc < t]`` is identical to the one from the full record, that perturbing every row from t on
(including the one labelled t) changes nothing, and the 09:45 case from #93 on 15-min readings.

Conventions: the model forecasts ``level_mean`` of the row labelled (t - 1 h) + h, the hour ending at
t + h; the replay shows it as lead h from ``issuedAt = t``. ``dataAsOf`` is the label (hour start) of the
latest row used. Crossings use ``level_mean`` and hour-start labels (the quantity the model forecasts).
"""

from __future__ import annotations

import argparse
import json
import logging
import math
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from model.probability import HORIZONS_H, spot_forecast
from model.train import (
    DATA_DIR,
    DEFAULT_TARGETS,
    MODELS_DIR,
    ROOT,
    WEB_DATA,
    GaugeModel,
    gauge_lines,
    is_current,
    load_hourly,
    load_lags,
    train_gauge,
)

log = logging.getLogger(__name__)

STALE_H = 3  # SPEC §10.1: a gauge whose latest reading is > 3 h old is stale
ROW_LAG = pd.Timedelta(hours=1)  # a forecast issued at t uses hourly rows labelled <= t - 1 h (#93)
LOFO_MARGIN = pd.Timedelta(days=7)
WARNINGS_PATH = DATA_DIR / "processed" / "warnings.parquet"

# SPEC §4.3 (fallback until config/events.yaml exists).
EVENTS: dict[str, dict[str, Any]] = {
    "e2007": {"name": "July 2007", "start": "2007-07-18", "end": "2007-08-02"},
    "e2012": {"name": "Nov–Dec 2012", "start": "2012-11-20", "end": "2013-01-05"},
    "e2014": {"name": "Jan–Feb 2014", "start": "2013-12-20", "end": "2014-02-20"},
    "e2024a": {"name": "Jan 2024 (Storm Henk)", "start": "2023-12-28", "end": "2024-01-15"},
    "e2024b": {"name": "Nov 2024 (Storm Bert)", "start": "2024-11-20", "end": "2024-12-05"},
    "e2026": {"name": "Feb–Mar 2026", "start": "2026-02-18", "end": "2026-03-10"},
}

# SPEC §4.2 after the re-target (PR #30); fallback only, config/spots.yaml overrides.
# A threshold of None (unverified) makes the spot timing_only.
# wolvercote is on godstow, which is live only: timing_only, no forecast.
SPOTS: list[dict[str, Any]] = [
    {
        "key": "osney",
        "name": "Osney Island / Binsey",
        "gauge": "minns",
        "threshold": None,
        "warningArea": "061FWF23BnsyOsny",
    },
    {
        "key": "botley",
        "name": "Botley Road / New Botley / Hinksey",
        "gauge": "newbotley",
        "threshold": 2.76,
        "warningArea": "061FWF23NwBotley",
    },
    {
        "key": "abingdonrd",
        "name": "Abingdon Road / Grandpont",
        "gauge": "coldharbour",
        "threshold": None,
        "warningArea": "061FWF23NwBotley",
    },
    {
        "key": "wolvercote",
        "name": "Wolvercote / Port Meadow",
        "gauge": "godstow",
        "threshold": 3.07,
        "warningArea": "061FWF23Wlvrcote",
        "mode": "timing_only",
    },
    {
        "key": "cherwell",
        "name": "Cherwell (Kings Mill)",
        "gauge": "kingsmill",
        "threshold": 2.60,
        "warningArea": None,
    },
]
LIVE_ONLY = {"osney", "godstow", "iffley"}


# ---------------------------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------------------------


def _read_yaml(name: str) -> Any:
    path = ROOT / "config" / name
    if not path.exists():
        return None
    try:
        import yaml

        return yaml.safe_load(path.read_text(encoding="utf-8"))
    except Exception as exc:  # owned by Story; never fail the backtest on it
        log.warning("could not read %s (%s); using SPEC values", path, exc)
        return None


def _items(raw: Any, key: str) -> list[dict[str, Any]]:
    if isinstance(raw, dict):
        raw = raw.get(key, raw)
    if isinstance(raw, dict):
        return [{"key": k, "id": k, **v} for k, v in raw.items() if isinstance(v, dict)]
    return [x for x in raw or [] if isinstance(x, dict)]


def load_events() -> dict[str, dict[str, Any]]:
    events = {k: dict(v) for k, v in EVENTS.items()}
    for ev in _items(_read_yaml("events.yaml"), "events"):
        eid = ev.get("id") or ev.get("key")
        if eid and ev.get("start") and ev.get("end"):
            events[eid] = {**events.get(eid, {}), **{k: ev[k] for k in ("name", "start", "end") if k in ev}}
    return events


def load_spots() -> list[dict[str, Any]]:
    """Spots with ``amber``, ``threshold`` and ``mode`` resolved (SPEC §4.2)."""
    by_key = {s["key"]: dict(s) for s in SPOTS}
    for s in _items(_read_yaml("spots.yaml"), "spots"):
        if s.get("key") in by_key:
            by_key[s["key"]].update({k: v for k, v in s.items() if v is not None})
    out = []
    for s in by_key.values():
        gauge = s["gauge"]
        if s.get("amber") is None:
            s["amber"] = gauge_lines(gauge)["amber"] if gauge not in LIVE_ONLY else None
            if s["amber"] is None and gauge == "godstow":
                s["amber"] = 2.57
        thr = s.get("threshold")
        if thr is None or (isinstance(thr, float) and math.isnan(thr)):
            s["threshold"] = None
            s["mode"] = "timing_only"
        if gauge in LIVE_ONLY:
            s["mode"] = "timing_only"
        s.setdefault("mode", "probability")
        out.append(s)
    return out


def _utc(x: Any) -> pd.Timestamp:
    t = pd.Timestamp(x)
    return t.tz_localize("UTC") if t.tzinfo is None else t.tz_convert("UTC")


def _iso(ts: pd.Timestamp) -> str:
    return _utc(ts).strftime("%Y-%m-%dT%H:%M:%SZ")


def event_window(event: Mapping[str, Any]) -> tuple[pd.Timestamp, pd.Timestamp]:
    """Event [start, end] in UTC; a date-only end means the end of that day."""
    start = _utc(event["start"])
    end = _utc(event["end"])
    if end == end.normalize() and len(str(event["end"])) <= 10:
        end = end + pd.Timedelta(hours=23)
    return start, end


# ---------------------------------------------------------------------------------------------
# Forecasts (no look-ahead)
# ---------------------------------------------------------------------------------------------


def _levels_wide(hourly: pd.DataFrame, gauges: Iterable[str]) -> pd.DataFrame:
    lv = hourly[hourly["gauge"].isin(list(gauges)) & hourly["level_mean"].notna()]
    return lv.pivot_table(index="ts_utc", columns="gauge", values="level_mean", aggfunc="first")


def _last_obs(wide: pd.DataFrame, times: pd.DatetimeIndex) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Per gauge and issue time: last observed level and its time, using rows <= t only."""
    obs_t = pd.DataFrame({g: wide.index.where(wide[g].notna()) for g in wide.columns}, index=wide.index)
    obs_t = obs_t.ffill()
    vals = wide.ffill()
    full = wide.index.union(times)
    return vals.reindex(full).ffill().reindex(times), obs_t.reindex(full).ffill().reindex(times)


def forecasts_at(
    hourly: pd.DataFrame,
    models: Mapping[str, GaugeModel],
    spots: Sequence[Mapping[str, Any]],
    issue_times: Sequence[pd.Timestamp] | pd.DatetimeIndex,
    leads: Sequence[int] = HORIZONS_H,
) -> list[dict[str, Any]]:
    """One SPEC §9 ``Forecast`` per issue time t, using only rows of ``hourly`` with ``ts_utc <= t - 1 h``.

    The row labelled t - 1 h is the last whole hour before t (its readings end at t - 15 min), so no
    reading at or after t is used (#93). ``models`` maps target gauge -> trained model. Spots on gauges
    without a model get ``leads: []`` (timing_only); spots whose gauge has never been observed by t are
    left out.
    """
    from model import features

    times = pd.DatetimeIndex([_utc(t) for t in issue_times])
    rows = times - ROW_LAG  # the last complete hourly row at each issue time
    used = {g for m in models.values() for g in [m.target, *m.medians]} | {s["gauge"] for s in spots}
    wide = _levels_wide(hourly, sorted(used))
    last_val, last_t = _last_obs(wide, rows)

    preds: dict[str, dict[int, np.ndarray]] = {}
    lnow: dict[str, np.ndarray] = {}
    for g, m in models.items():
        X = features.build_features(hourly, g, m.medians, m.lags, m.upstreams).reindex(rows)
        preds[g] = m.predict(X)
        lnow[g] = X["level_now"].to_numpy(dtype=float)

    out = []
    for i, t in enumerate(times):
        as_of = {g: _iso(last_t.iloc[i][g]) for g in last_t.columns if pd.notna(last_t.iloc[i][g])}
        # Age of the latest row, measured from the last complete row (same rule as before #93).
        row = rows[i]
        stale = sorted(
            g for g in used if g not in as_of or (row - pd.Timestamp(as_of[g])) > pd.Timedelta(hours=STALE_H)
        )
        spot_out = []
        for s in spots:
            g = s["gauge"]
            if g not in as_of:
                continue
            level_obs = float(last_val.iloc[i][g])
            if g in models and g not in stale and not np.isnan(lnow[g][i]):
                q = np.stack([preds[g][h][i] for h in leads])
                sf = spot_forecast(s, float(lnow[g][i]), q, t, leads)
            else:
                sf = {
                    "spot": s["key"],
                    "levelNow": round(level_obs, 3),
                    "leads": [],
                    "arrival": None,
                    "mode": "timing_only" if g not in models else s.get("mode", "probability"),
                }
            spot_out.append(sf)
        out.append({"issuedAt": _iso(t), "dataAsOf": as_of, "stale": stale, "spots": spot_out})
    return out


def crossings(
    hourly: pd.DataFrame, spots: Sequence[Mapping[str, Any]], start: Any, end: Any
) -> list[dict[str, str]]:
    """Observed up-crossings of each spot's threshold (``level_mean``) within [start, end]."""
    out = []
    for s in spots:
        if s.get("threshold") is None:
            continue
        lv = hourly[(hourly["gauge"] == s["gauge"])].set_index("ts_utc")["level_mean"].sort_index()
        lv = lv[(lv.index >= _utc(start) - pd.Timedelta(hours=1)) & (lv.index <= _utc(end))].dropna()
        above = lv >= s["threshold"]
        up = above & ~above.shift(1, fill_value=False)
        if len(lv) and lv.index[0] < _utc(start):
            up.iloc[0] = False
        out += [{"spot": s["key"], "t": _iso(t)} for t in lv.index[up.to_numpy()] if t >= _utc(start)]
    return sorted(out, key=lambda d: (d["t"], d["spot"]))


def observed(
    hourly: pd.DataFrame, gauges: Iterable[str], start: Any, end: Any
) -> dict[str, list[dict[str, Any]]]:
    lv = hourly[hourly["gauge"].isin(list(gauges)) & hourly["level_mean"].notna()]
    lv = lv[(lv["ts_utc"] >= _utc(start)) & (lv["ts_utc"] <= _utc(end))].sort_values("ts_utc")
    return {
        g: [
            {"t": _iso(t), "level": round(float(v), 3)}
            for t, v in zip(d["ts_utc"], d["level_mean"], strict=True)
        ]
        for g, d in lv.groupby("gauge")
    }


def official_entries(spots: Sequence[Mapping[str, Any]], start: Any, end: Any) -> list[dict[str, str]]:
    """Official EA messages per spot in the window (``model/official.py``, #13); [] if unavailable."""
    if not WARNINGS_PATH.exists():
        log.warning("%s not found; replay has no official warnings", WARNINGS_PATH)
        return []
    from model import official

    warnings = pd.read_parquet(WARNINGS_PATH)
    areas = official.spot_areas_from_spots([s for s in spots if s.get("warningArea")])
    return official.replay_official(warnings, [s["key"] for s in spots], start, end, spot_areas=areas)


def build_replay(
    hourly: pd.DataFrame,
    models: Mapping[str, GaugeModel],
    event_id: str,
    event: Mapping[str, Any],
    spots: Sequence[Mapping[str, Any]],
    every_h: int = 1,
) -> dict[str, Any]:
    """SPEC §9 ``Replay`` for one event (models must already exclude the event: leave-one-flood-out).

    ``every_h`` thins the issue times (1 = hourly, SPEC §8.1); observed levels stay hourly.
    """
    start, end = event_window(event)
    times = pd.date_range(start, end, freq=f"{every_h}h", tz="UTC")
    fc = forecasts_at(hourly, models, spots, times)
    gauges = {s["gauge"] for s in spots} | {g for m in models.values() for g in m.medians}
    return {
        "eventId": event_id,
        "name": event.get("name", event_id),
        "start": _iso(start),
        "end": _iso(end),
        "observed": observed(hourly, sorted(gauges), start, end),
        "forecasts": fc,
        "official": official_entries(spots, start, end),
        "crossings": crossings(hourly, spots, start, end),
    }


# ---------------------------------------------------------------------------------------------
# Leave-one-flood-out
# ---------------------------------------------------------------------------------------------


def lofo_models(
    hourly: pd.DataFrame,
    event_id: str,
    event: Mapping[str, Any],
    targets: Sequence[str],
    lags: Mapping[str, Mapping[str, int]] | None,
    retrain: bool = False,
    cache_dir: Path | None = None,
    **fit_kwargs: Any,
) -> dict[str, GaugeModel]:
    """Models trained without the event window ± 7 days, cached per event and gauge."""
    start, end = event_window(event)
    window = (start - LOFO_MARGIN, end + LOFO_MARGIN)
    cache_dir = cache_dir or MODELS_DIR / "lofo" / event_id
    out = {}
    for g in targets:
        d = cache_dir / g
        if not retrain and (d / "meta.json").exists():
            m = GaugeModel.load(d)
            if is_current(m, lags):
                out[g] = m
                log.info("loaded cached leave-one-out model %s", d)
                continue
            # e.g. trained before the river walk (#125): other upstream gauges or lags than the config.
            log.warning("cached leave-one-out model %s does not match the current config; retraining", d)
        m = train_gauge(hourly, g, lags=lags, exclude_windows=[window], **fit_kwargs)
        m.save(d)
        out[g] = m
    return out


def write_json(obj: Any, path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, separators=(",", ":"), allow_nan=False), encoding="utf-8")
    return path


def main(argv: Sequence[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="Leave-one-flood-out replay (SPEC §8.1)")
    ap.add_argument("--event", default="e2014")
    ap.add_argument("--targets", nargs="+", default=list(DEFAULT_TARGETS))
    ap.add_argument("--retrain", action="store_true")
    ap.add_argument("--train-only", action="store_true", help="fit/cache the leave-one-out models and stop")
    ap.add_argument("--every-h", type=int, default=1, help="issue a forecast every N hours (file size)")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    events = load_events()
    event = events[args.event]
    hourly = load_hourly()
    models = lofo_models(hourly, args.event, event, args.targets, load_lags(), retrain=args.retrain)
    if args.train_only:
        return
    replay = build_replay(hourly, models, args.event, event, load_spots(), every_h=args.every_h)
    path = write_json(replay, WEB_DATA / "replays" / f"{args.event}.json")
    log.info("wrote %s (%d forecasts, %.1f MB)", path, len(replay["forecasts"]), path.stat().st_size / 1e6)


if __name__ == "__main__":
    main()
