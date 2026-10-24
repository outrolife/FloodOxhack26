"""Event detection and flood-wave travel times between gauge pairs (SPEC §6). Issue #7.

Run ``python -m analysis.travel_times``. It reads ``data/processed/hourly.parquet`` and writes:

* ``web/public/data/travel_times.json``: a list of SPEC §9 ``TravelPair`` objects.
* ``data/processed/lags.json``: ``{"pairs": [{up, down, lag_lo, lag_main, lag_hi, source}]}`` (hours, int),
  read by ``model/features.py``.
* ``data/processed/travel_times_detail.json``: diagnostics (event windows, peak and half-rise times,
  baselines, rise rates, fit quality). Not a contract; for humans.

Method (SPEC §6), in plain words
--------------------------------
1. **Events** (per target gauge): hours where ``level_max`` > amber, runs merged if < 7 days apart, kept if
   the peak is > amber + 0.1 m. Analysis window = 7 days before the start to 3 days after the end.
   Unioned with ``config/events.yaml``: a detected event inside a named window takes that name.
2. **Matching** (per event and gauge pair), on a centred 3 h rolling mean of ``level_mean``:
   peak time = argmax in the window; the peak must dominate (any other ``find_peaks`` peak has
   prominence < 50 % of the main one), otherwise the event is ``ambiguous``. Half-rise time = first time
   the level reaches baseline + 0.5 x (peak - baseline), where baseline = median over the 72 h before
   the rise begins (the lowest point between window start and peak). ``T = t_down - t_up``; an event is
   valid only if 0 < T_half < 168 h and 0 < T_peak < 168 h.
3. **Cross-correlation** of hourly level changes (lags 0-120 h), pooled over every Oct-Mar.
4. **Slope**: least-squares fit of T_half (h) against the upstream rise (m), over valid events.

Pairs with fewer than 3 valid events fall back to the cross-correlation peak lag +/- 6 h, both in
``lags.json`` (``source: "xcorr"``) and in the ``tHalf``/``tPeak`` fields of ``travel_times.json``; their
``n`` (< 3) tells the app the pair is cross-correlation only. Per-event values are always listed.

Levels are never compared across gauges: every quantity is a time, or a rise measured against the same
gauge's own baseline. All times are UTC.
"""
from __future__ import annotations

import argparse
import json
import logging
import math
import os
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from scipy.signal import find_peaks

log = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("RC_DATA_DIR", ROOT / "data"))
HOURLY_PATH = DATA_DIR / "processed" / "hourly.parquet"
LAGS_PATH = DATA_DIR / "processed" / "lags.json"
DETAIL_PATH = DATA_DIR / "processed" / "travel_times_detail.json"
OUT_PATH = ROOT / "web" / "public" / "data" / "travel_times.json"
STATIONS_YAML = ROOT / "config" / "stations.yaml"
EVENTS_YAML = ROOT / "config" / "events.yaml"

H = pd.Timedelta(hours=1)

# FALLBACK, mirroring SPEC §4.1 "Normal top / amber (m)". Used only for gauges that config/stations.yaml
# (issue #2) does not provide. Each value is on that gauge's own datum. Only the targets' values are used.
FALLBACK_AMBER: dict[str, float] = {
    "farmoor": 1.30,
    "eynsham": 2.96,
    "cassington": 0.77,
    "enslow": 1.29,
    "islip": 7.80,
    "newbotley": 2.01,
    "minns": 2.13,
    "coldharbour": 2.30,
    "kingsmill": 2.40,
}

# FALLBACK, mirroring SPEC §4.3. Used only if config/events.yaml (issue #10) is missing.
FALLBACK_EVENTS: list[dict[str, str]] = [
    {"id": "e2007", "start": "2007-07-18", "end": "2007-08-02"},
    {"id": "e2012", "start": "2012-11-20", "end": "2013-01-05"},
    {"id": "e2014", "start": "2013-12-20", "end": "2014-02-20"},
    {"id": "e2024a", "start": "2023-12-28", "end": "2024-01-15"},
    {"id": "e2024b", "start": "2024-11-20", "end": "2024-12-05"},
    {"id": "e2026", "start": "2026-02-18", "end": "2026-03-10"},
]

# Pairs (SPEC §4.1 flow paths, §6.2 as re-targeted in PR #30), keyed by target, in display order: the Thames
# chain into newbotley (primary) first. godstow, osney and iffley are live only (§4.1.1): the Hydrology API
# has no downstream-stage history for them, so they have no pairs.
UPSTREAMS: dict[str, tuple[str, ...]] = {
    "newbotley": ("farmoor", "eynsham", "cassington"),
    "minns": ("farmoor", "eynsham", "cassington"),
    "coldharbour": ("farmoor", "eynsham", "cassington"),
    "kingsmill": ("enslow", "islip"),
}

# Tunables (SPEC §6 unless noted)
MERGE_GAP = pd.Timedelta(days=7)
MIN_EXCEEDANCE_M = 0.1
PAD_BEFORE = pd.Timedelta(days=7)
PAD_AFTER = pd.Timedelta(days=3)
SMOOTH_H = 3
SECOND_PEAK_MAX_RATIO = 0.5
BASELINE_H = 72
T_MAX_H = 168.0
MIN_EVENTS = 3
XCORR_MAX_LAG_H = 120
XCORR_FALLBACK_SPREAD_H = 6
WINTER_MONTHS = (10, 11, 12, 1, 2, 3)
# Not in SPEC: data-quality guards, chosen to be lenient.
INTERP_LIMIT_H = 6  # interpolate gaps up to 6 h inside a window before smoothing
MAX_MISSING_FRAC = 0.2  # exclude an event if > 20 % of a gauge's window is still missing
MIN_XCORR_SAMPLES = 500
DATUM_FALLBACK_QUANTILE = 0.99
MIN_RISE_M = 0.05  # a gauge must rise >= 5 cm above its own baseline to have a timeable peak


# ---------------------------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------------------------


def _read_yaml(path: Path) -> Any:
    if not path.exists():
        return None
    import yaml

    try:
        return yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:  # pragma: no cover - defensive
        log.warning("could not parse %s (%s); using fallback", path, exc)
        return None


def _records(raw: Any, list_keys: Iterable[str]) -> list[dict[str, Any]]:
    """Accept a list of dicts, ``{key: {...}}`` or ``{"stations"/"events": ...}``; return a list of dicts."""
    if isinstance(raw, dict):
        for k in list_keys:
            if k in raw:
                return _records(raw[k], ())
        return [{"key": k, "id": k, **v} for k, v in raw.items() if isinstance(v, dict)]
    if isinstance(raw, list):
        return [r for r in raw if isinstance(r, dict)]
    return []


def load_amber(path: Path = STATIONS_YAML) -> dict[str, float]:
    """Amber (normal-range top) per gauge from ``stations.yaml``, else the SPEC §4.1 fallback."""
    amber = dict(FALLBACK_AMBER)
    found: list[str] = []
    for rec in _records(_read_yaml(path), ("stations", "gauges")):
        key = rec.get("key") or rec.get("id")
        for name in ("amber", "typicalRangeHigh", "typical_range_high", "normal_top"):
            val = rec.get(name)
            if key and isinstance(val, int | float) and not isinstance(val, bool):
                amber[str(key)] = float(val)
                found.append(str(key))
                break
    if found:
        log.info("amber thresholds from %s for: %s", path, ", ".join(sorted(found)))
    else:
        log.warning("%s missing or without thresholds; using SPEC §4.1 FALLBACK_AMBER", path)
    return amber


def load_named_events(path: Path = EVENTS_YAML) -> list[dict[str, Any]]:
    """Named event windows ``[{id, start, end}]`` (UTC) from ``events.yaml``, else the SPEC §4.3 fallback."""
    out: list[dict[str, Any]] = []
    for rec in _records(_read_yaml(path), ("events",)):
        eid = rec.get("id") or rec.get("key")
        start, end = rec.get("start"), rec.get("end")
        if start is None and isinstance(rec.get("window"), list | tuple) and len(rec["window"]) == 2:
            start, end = rec["window"]
        if eid and start is not None and end is not None:
            out.append({"id": str(eid), "start": start, "end": end})
    if not out:
        log.warning("%s missing or empty; using SPEC §4.3 FALLBACK_EVENTS", path)
        out = [dict(e) for e in FALLBACK_EVENTS]
    return normalise_named(out)


def normalise_named(events: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """UTC timestamps for named windows; a date-only end covers that whole day."""
    out = [dict(e) for e in events]
    for e in out:
        e["start"] = _utc(e["start"])
        # an end given as a date covers that whole day
        end = _utc(e["end"])
        e["end"] = end + pd.Timedelta(hours=23) if end == end.normalize() else end
    return out


def _utc(value: Any) -> pd.Timestamp:
    ts = pd.Timestamp(value)
    return ts.tz_localize("UTC") if ts.tzinfo is None else ts.tz_convert("UTC")


def all_pairs(upstreams: Mapping[str, Iterable[str]] = UPSTREAMS) -> list[tuple[str, str]]:
    return [(up, down) for down, ups in upstreams.items() for up in ups]


# ---------------------------------------------------------------------------------------------
# Input
# ---------------------------------------------------------------------------------------------


def level_frames(hourly: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Wide ``level_mean`` and ``level_max`` frames on a complete hourly UTC index (columns = gauges)."""
    lv = hourly[hourly["kind"] == "level"]
    if lv.empty:
        raise ValueError("hourly data has no kind == 'level' rows")
    ts = pd.to_datetime(lv["ts_utc"])
    if ts.dt.tz is None:
        raise ValueError("ts_utc must be timezone-aware UTC")
    lv = lv.assign(ts_utc=ts.dt.tz_convert("UTC"))
    index = pd.date_range(lv["ts_utc"].min(), lv["ts_utc"].max(), freq="h")
    frames = []
    for col in ("level_mean", "level_max"):
        wide = lv.pivot_table(index="ts_utc", columns="gauge", values=col, aggfunc="mean")
        frames.append(wide.reindex(index).astype(float))
    return frames[0], frames[1]


# ---------------------------------------------------------------------------------------------
# 6.1 Event detection
# ---------------------------------------------------------------------------------------------


@dataclass
class Event:
    id: str
    target: str
    start: pd.Timestamp  # first hour above amber (or named window start)
    end: pd.Timestamp
    peak: float | None  # target level_max peak (m, own datum); None for named-only windows
    source: str  # "detected" | "named" | "detected+named"

    @property
    def window(self) -> tuple[pd.Timestamp, pd.Timestamp]:
        return self.start - PAD_BEFORE, self.end + PAD_AFTER


def detect_events(
    level_max: pd.Series, amber: float, margin: float = MIN_EXCEEDANCE_M
) -> list[tuple[pd.Timestamp, pd.Timestamp, float]]:
    """Runs of ``level_max > amber``, merged when < 7 days apart, kept if the peak > amber + 0.1 m."""
    above = (level_max > amber).to_numpy()
    if not above.any():
        return []
    idx = level_max.index
    edges = np.diff(np.concatenate([[0], above.astype(int), [0]]))
    starts, ends = np.flatnonzero(edges == 1), np.flatnonzero(edges == -1) - 1
    runs: list[list[int]] = []
    for s, e in zip(starts, ends, strict=True):
        if runs and idx[s] - idx[runs[-1][1]] < MERGE_GAP:
            runs[-1][1] = e
        else:
            runs.append([s, e])
    out = []
    for s, e in runs:
        peak = float(np.nanmax(level_max.to_numpy()[s : e + 1]))
        if peak > amber + margin:
            out.append((idx[s], idx[e], peak))
    return out


def event_threshold(target: str, level_max: pd.Series, amber: float) -> tuple[float, float, str]:
    """(threshold, margin, source) for event detection at ``target``.

    Normally the configured amber and the SPEC 0.1 m margin. Safety FALLBACK (not in SPEC): if the data
    never reach amber, the series is almost certainly on another datum (as found for the upstream lock
    stage at Osney, issue #2), so events are detected above that series' own 99th percentile instead,
    with no margin. Logged loudly, and recorded in the detail file.
    """
    top = float(level_max.max())
    if top > amber:
        return amber, MIN_EXCEEDANCE_M, "amber"
    p99 = float(level_max.quantile(DATUM_FALLBACK_QUANTILE))
    log.warning(
        "%s never reaches amber %.2f m (data max %.2f m): datum mismatch? detecting events above its own "
        "p%.0f = %.3f m instead",
        target, amber, top, 100 * DATUM_FALLBACK_QUANTILE, p99,
    )
    return p99, 0.0, f"p{100 * DATUM_FALLBACK_QUANTILE:.0f}"


def target_events(
    target: str,
    level_max: pd.Series,
    amber: float,
    named: list[dict[str, Any]],
    margin: float = MIN_EXCEEDANCE_M,
) -> list[Event]:
    """Detected events for one target, unioned with the named windows (SPEC §6.1)."""
    events = [
        Event(f"auto-{s:%Y%m%d}", target, s, e, p, "detected")
        for s, e, p in detect_events(level_max, amber, margin)
    ]
    for ne in named:
        inside = [ev for ev in events if ev.start <= ne["end"] and ev.end >= ne["start"]]
        if inside:
            # the biggest detected event inside the named window carries its name
            best = max(inside, key=lambda ev: ev.peak or -math.inf)
            if best.source == "detected":
                best.id, best.source = ne["id"], "detected+named"
            continue
        sl = level_max.loc[ne["start"] : ne["end"]]
        if sl.notna().sum() == 0:
            continue  # no data for this target in the named window
        peak = float(sl.max())
        events.append(Event(ne["id"], target, ne["start"], ne["end"], peak, "named"))
    return sorted(events, key=lambda ev: ev.start)


# ---------------------------------------------------------------------------------------------
# 6.2 Matching per gauge pair
# ---------------------------------------------------------------------------------------------


@dataclass
class Hydro:
    """Timing features of one gauge's hydrograph inside an event window."""

    t_peak: pd.Timestamp
    t_half: pd.Timestamp
    t_rise: pd.Timestamp
    baseline: float
    peak: float

    @property
    def rise(self) -> float:
        return self.peak - self.baseline

    @property
    def rise_rate(self) -> float:
        """Mean rate of rise, rise start to peak (m/h)."""
        hours = (self.t_peak - self.t_rise) / H
        return self.rise / hours if hours > 0 else math.nan


class Excluded(Exception):  # noqa: N818 - reads well at the call site
    """An event that cannot be used for a pair, with a human-readable reason (and the rise, if known)."""

    def __init__(self, reason: str, rise: float | None = None) -> None:
        super().__init__(reason)
        self.rise = rise


def smooth(series: pd.Series) -> pd.Series:
    """Centred 3 h rolling mean after filling short gaps (analysis only; never a model input)."""
    filled = series.interpolate(limit=INTERP_LIMIT_H, limit_area="inside")
    return filled.rolling(SMOOTH_H, center=True, min_periods=2).mean()


def hydro_features(full: pd.Series, gauge: str, w0: pd.Timestamp, w1: pd.Timestamp) -> Hydro:
    """Peak, half-rise and rise-start times of ``gauge`` inside ``[w0, w1]``; raises ``Excluded``."""
    # smooth with a margin so the 72 h baseline before an early rise start is available
    sm_full = smooth(full.loc[w0 - pd.Timedelta(hours=BASELINE_H + 24) : w1 + pd.Timedelta(hours=24)])
    win = sm_full.loc[w0:w1]
    if win.empty or win.isna().mean() > MAX_MISSING_FRAC:
        pct = 100.0 if win.empty else 100 * win.isna().mean()
        raise Excluded(f"insufficient data at {gauge} ({pct:.0f}% of window missing)")
    x = win.to_numpy()
    i_peak = int(np.nanargmax(x))
    if i_peak == 0 or i_peak == len(x) - 1:
        raise Excluded(f"peak at window edge at {gauge}")

    pre = win.iloc[: i_peak + 1]
    t_rise = pre.idxmin()
    base_slice = sm_full.loc[t_rise - pd.Timedelta(hours=BASELINE_H) : t_rise - H]
    baseline = float(base_slice.median()) if base_slice.notna().any() else math.nan
    if math.isnan(baseline):
        raise Excluded(f"no baseline data at {gauge}")
    peak = float(x[i_peak])
    if peak - baseline < MIN_RISE_M:
        raise Excluded(f"no clear rise at {gauge} ({peak - baseline:.2f} m above baseline)")
    try:
        dominant_peak_check(x, i_peak, gauge)
    except Excluded as exc:
        raise Excluded(str(exc), rise=peak - baseline) from None
    t_half = half_rise_time(win.loc[t_rise : win.index[i_peak]], baseline + 0.5 * (peak - baseline))
    return Hydro(win.index[i_peak], t_half, t_rise, baseline, peak)


def dominant_peak_check(x: np.ndarray, i_peak: int, gauge: str) -> None:
    """Raise ``Excluded('ambiguous ...')`` if a second peak has prominence >= 50 % of the main peak's."""
    filled = pd.Series(x).interpolate(limit_direction="both").to_numpy()
    peaks, props = find_peaks(filled, prominence=0)
    if len(peaks) == 0:
        return
    prom = props["prominences"]
    j_main = int(np.argmax(filled[peaks]))  # the global maximum (find_peaks reports a plateau's middle)
    if filled[peaks[j_main]] < filled[i_peak] - 1e-9:
        raise Excluded(f"peak at window edge at {gauge}")  # the maximum is a plateau running to an edge
    main = prom[j_main]
    others = np.delete(prom, j_main)
    if main > 0 and others.size and others.max() >= SECOND_PEAK_MAX_RATIO * main:
        ratio = others.max() / main
        raise Excluded(
            f"ambiguous: second peak at {gauge} with {ratio:.0%} of the main peak's prominence "
            f"({others.max():.2f} m vs {main:.2f} m)"
        )


def half_rise_time(rising: pd.Series, level: float) -> pd.Timestamp:
    """First time ``rising`` reaches ``level``, linearly interpolated between hours."""
    vals = rising.to_numpy()
    hit = np.flatnonzero(vals >= level)
    i = int(hit[0])
    if i == 0 or not np.isfinite(vals[i - 1]):
        return rising.index[i]
    frac = (level - vals[i - 1]) / (vals[i] - vals[i - 1])
    return rising.index[i - 1] + frac * H


@dataclass
class EventResult:
    event: Event
    t_half: float | None = None
    t_peak: float | None = None
    rise: float = 0.0
    excluded: str | None = None
    detail: dict[str, Any] = field(default_factory=dict)

    @property
    def valid(self) -> bool:
        return self.excluded is None


def match_event(up: pd.Series, down: pd.Series, up_key: str, down_key: str, event: Event) -> EventResult:
    w0, w1 = event.window
    res = EventResult(event)
    try:
        hu = hydro_features(up, up_key, w0, w1)
    except Excluded as exc:
        res.excluded = str(exc)
        res.rise = round(exc.rise, 3) if exc.rise is not None else 0.0
        return res
    res.rise = round(hu.rise, 3)
    try:
        hd = hydro_features(down, down_key, w0, w1)
    except Excluded as exc:
        res.excluded = str(exc)
        return res
    t_half = (hd.t_half - hu.t_half) / H
    t_peak = (hd.t_peak - hu.t_peak) / H
    ok_half, ok_peak = 0 < t_half < T_MAX_H, 0 < t_peak < T_MAX_H
    res.t_half = round(t_half, 1) if ok_half else None
    res.t_peak = round(t_peak, 1) if ok_peak else None
    bad = [f"{name} = {t:.1f} h" for name, t, ok in (("T_half", t_half, ok_half), ("T_peak", t_peak, ok_peak))
           if not ok]
    if bad:
        res.excluded = f"{', '.join(bad)} outside (0, {T_MAX_H:.0f}) h"
    res.detail = {
        "up": _hydro_detail(hu),
        "down": _hydro_detail(hd),
        "riseRateUpMPerH": _round(hu.rise_rate, 4),
        "tHalfRaw": round(t_half, 2),
        "tPeakRaw": round(t_peak, 2),
    }
    return res


def _hydro_detail(h: Hydro) -> dict[str, Any]:
    return {
        "tPeak": h.t_peak.isoformat(),
        "tHalf": h.t_half.isoformat(),
        "tRiseStart": h.t_rise.isoformat(),
        "baseline": round(h.baseline, 3),
        "peak": round(h.peak, 3),
        "rise": round(h.rise, 3),
    }


# ---------------------------------------------------------------------------------------------
# 6.3 Cross-correlation, slope, summaries
# ---------------------------------------------------------------------------------------------


def xcorr_changes(up: pd.Series, down: pd.Series, max_lag: int = XCORR_MAX_LAG_H) -> list[dict[str, float]]:
    """Pearson r between Δup(t) and Δdown(t + lag), lag = 0..max_lag h, over Oct-Mar hours ``t``."""
    both = pd.concat([up, down], axis=1)
    d = both.diff().to_numpy()  # hourly level change; NaN where either hour is missing
    du, dd = d[:, 0], d[:, 1]
    winter = np.isin(both.index.month, WINTER_MONTHS)
    n = len(du)
    out = []
    for lag in range(max_lag + 1):
        if lag >= n:
            break
        x, y = du[: n - lag], dd[lag:]
        m = np.isfinite(x) & np.isfinite(y) & winter[: n - lag]
        if m.sum() < MIN_XCORR_SAMPLES:
            continue
        xs, ys = x[m], y[m]
        if xs.std() == 0 or ys.std() == 0:
            continue
        out.append({"lagH": lag, "r": round(float(np.corrcoef(xs, ys)[0, 1]), 4)})
    return out


def xcorr_peak(xc: list[dict[str, float]]) -> int | None:
    if not xc:
        return None
    return int(max(xc, key=lambda p: p["r"])["lagH"])


def fit_slope(rises: list[float], t_halfs: list[float]) -> tuple[float | None, float | None]:
    """Slope (h per m of upstream rise) and r² of a least-squares line; None if under-determined."""
    if len(rises) < 2 or np.ptp(rises) == 0:
        return None, None
    slope, intercept = np.polyfit(rises, t_halfs, 1)
    pred = slope * np.asarray(rises) + intercept
    ss_res = float(np.sum((np.asarray(t_halfs) - pred) ** 2))
    ss_tot = float(np.sum((np.asarray(t_halfs) - np.mean(t_halfs)) ** 2))
    r2 = 1 - ss_res / ss_tot if ss_tot > 0 else None
    return round(float(slope), 2), (round(r2, 3) if r2 is not None else None)


def quantiles(values: list[float]) -> dict[str, float]:
    p10, med, p90 = np.percentile(values, [10, 50, 90])
    return {"p10": round(float(p10), 1), "median": round(float(med), 1), "p90": round(float(p90), 1)}


def round_half_up(x: float) -> int:
    return int(math.floor(x + 0.5))


def _round(x: float, nd: int) -> float | None:
    return None if x is None or not math.isfinite(x) else round(x, nd)


def analyse_pair(
    up_key: str,
    down_key: str,
    level_mean: pd.DataFrame,
    events: list[Event],
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]] | None:
    """One pair's ``TravelPair`` dict, ``lags.json`` entry and diagnostics; None if no usable data."""
    up, down = level_mean[up_key], level_mean[down_key]
    results = [match_event(up, down, up_key, down_key, ev) for ev in events]
    valid = [r for r in results if r.valid]
    xc = xcorr_changes(up, down)
    xlag = xcorr_peak(xc)
    n = len(valid)

    if n >= MIN_EVENTS:
        t_half = quantiles([r.t_half for r in valid])  # type: ignore[misc]
        t_peak = quantiles([r.t_peak for r in valid])  # type: ignore[misc]
        source = "events"
        lags = {k: round_half_up(t_half[q]) for k, q in (("lag_lo", "p10"), ("lag_main", "median"),
                                                         ("lag_hi", "p90"))}
    elif xlag is not None:
        source = "xcorr"
        lo, hi = max(0, xlag - XCORR_FALLBACK_SPREAD_H), xlag + XCORR_FALLBACK_SPREAD_H
        lags = {"lag_lo": lo, "lag_main": xlag, "lag_hi": hi}
        t_half = {"p10": float(lo), "median": float(xlag), "p90": float(hi)}
        t_peak = dict(t_half)
    else:
        log.warning("%s->%s: %d valid events and no cross-correlation; pair omitted", up_key, down_key, n)
        return None

    slope, r2 = fit_slope([r.rise for r in valid], [r.t_half for r in valid])  # type: ignore[misc]
    pair = {
        "up": up_key,
        "down": down_key,
        "n": n,
        "tHalf": t_half,
        "tPeak": t_peak,
        "events": [_event_json(r) for r in results],
        "xcorr": xc,
        "slopeHoursPerMetre": slope,
    }
    lag_entry = {"up": up_key, "down": down_key, **lags, "source": source}
    detail = {
        "up": up_key,
        "down": down_key,
        "source": source,
        "n": n,
        "xcorrPeakLagH": xlag,
        "xcorrPeakR": max((p["r"] for p in xc), default=None),
        "slopeR2": r2,
        "events": [
            {
                "eventId": r.event.id,
                "eventSource": r.event.source,
                "window": [r.event.window[0].isoformat(), r.event.window[1].isoformat()],
                "excluded": r.excluded,
                **r.detail,
            }
            for r in results
        ],
    }
    return pair, lag_entry, detail


def _event_json(r: EventResult) -> dict[str, Any]:
    out: dict[str, Any] = {"eventId": r.event.id, "tHalf": r.t_half, "tPeak": r.t_peak, "rise": r.rise}
    if r.excluded:
        out["excluded"] = r.excluded
    return out


# ---------------------------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------------------------


@dataclass
class Outputs:
    travel_pairs: list[dict[str, Any]]
    lags: dict[str, list[dict[str, Any]]]
    detail: dict[str, Any]


def run(
    hourly: pd.DataFrame,
    amber: Mapping[str, float] | None = None,
    named_events: list[dict[str, Any]] | None = None,
    upstreams: Mapping[str, Iterable[str]] = UPSTREAMS,
) -> Outputs:
    """Full SPEC §6 analysis on a long-format hourly frame. Pure: reads and writes no files."""
    amber = dict(FALLBACK_AMBER if amber is None else amber)
    named = normalise_named(FALLBACK_EVENTS if named_events is None else named_events)
    level_mean, level_max = level_frames(hourly)
    gauges = set(level_mean.columns)

    events_by_target: dict[str, list[Event]] = {}
    thresholds: dict[str, dict[str, Any]] = {}
    for target in upstreams:
        if target not in gauges:
            log.warning("target %s not in hourly data; its pairs are skipped", target)
            continue
        if target not in amber:
            log.warning("no amber threshold for %s; its pairs are skipped", target)
            continue
        thr, margin, thr_source = event_threshold(target, level_max[target], amber[target])
        thresholds[target] = {"amber": amber[target], "threshold": round(thr, 3), "source": thr_source}
        events_by_target[target] = target_events(target, level_max[target], thr, named, margin)
        log.info("%s: %d events", target, len(events_by_target[target]))

    pairs, lag_entries, details = [], [], []
    for up_key, down_key in all_pairs(upstreams):
        if down_key not in events_by_target:
            continue
        if up_key not in gauges:
            log.warning("upstream %s not in hourly data; pair %s->%s skipped", up_key, up_key, down_key)
            continue
        res = analyse_pair(up_key, down_key, level_mean, events_by_target[down_key])
        if res is None:
            continue
        pair, lag_entry, detail = res
        pairs.append(pair)
        lag_entries.append(lag_entry)
        details.append(detail)
        log.info(
            "%s->%s: n=%d T_half median %.1f h (%s), xcorr peak %s h",
            up_key, down_key, pair["n"], pair["tHalf"]["median"], lag_entry["source"],
            detail["xcorrPeakLagH"],
        )

    detail_doc = {
        "eventThresholds": thresholds,
        "events": {
            t: [
                {"id": e.id, "source": e.source, "start": e.start.isoformat(), "end": e.end.isoformat(),
                 "peak": _round(e.peak, 3) if e.peak is not None else None}
                for e in evs
            ]
            for t, evs in events_by_target.items()
        },
        "pairs": details,
    }
    return Outputs(pairs, {"pairs": lag_entries}, detail_doc)


def write_json(path: Path, obj: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=1, allow_nan=False) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--hourly", type=Path, default=HOURLY_PATH)
    ap.add_argument("--out", type=Path, default=OUT_PATH, help="travel_times.json (SPEC §9)")
    ap.add_argument("--lags", type=Path, default=LAGS_PATH)
    ap.add_argument("--detail", type=Path, default=DETAIL_PATH)
    ap.add_argument("--stations", type=Path, default=STATIONS_YAML)
    ap.add_argument("--events", type=Path, default=EVENTS_YAML)
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    if not args.hourly.exists():
        raise SystemExit(f"{args.hourly} not found: run `make data` first (issue #3)")
    hourly = pd.read_parquet(args.hourly)
    out = run(hourly, load_amber(args.stations), load_named_events(args.events))
    write_json(args.out, out.travel_pairs)
    write_json(args.lags, out.lags)
    write_json(args.detail, out.detail)
    log.info("wrote %d pairs to %s and %s", len(out.travel_pairs), args.out, args.lags)


if __name__ == "__main__":
    main()
