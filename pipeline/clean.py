"""Normalise, resample to hourly, fill short gaps and remove spikes; write hourly.parquet (SPEC §5.2).

Steps, per series (one gauge, one measure), exactly as SPEC §5.2:
1. Normalised input ``(gauge, ts_utc, value, quality, source)``; drop values EA flags as
   suspect/rejected/missing; deduplicate on (gauge, ts).
2. Resample to hourly: ``level_mean``, ``level_max``; rain -> hourly sum (an hour needs at least
   3 of its 4 quarter-hour totals, otherwise NaN: a partial sum would under-count rain).
3. Forward-fill gaps <= 2 h (``filled``); longer gaps stay NaN (``flagged``). Rain is never
   forward-filled (repeating a rain total invents rain); its gaps stay NaN.
4. Spikes: an hour-to-hour jump > 0.5 m that falls back at least halfway within 3 h -> NaN, counted,
   ``flagged``. Checked on both the hourly mean and the hourly max. Persistent level shifts (possible
   datum change) are logged for human review, not corrected.
5. Write ``data/processed/hourly.parquet`` (long format, below) and ``provenance.parquet``.

hourly.parquet, one row per (gauge, hour), hours between each series' first and last reading:
    gauge       str   §4.1 key (``osney``), lock head-water ``<key>_us``, rain gauge ref
                      (``256230TP``) or the derived ``rain_catchment``
    ts_utc      datetime64[ns, UTC], hour start
    kind        "level" | "rain"
    level_mean  float m (that gauge's own datum), NaN for rain
    level_max   float m, NaN for rain
    rain_mm     float hourly total, NaN for levels
    filled      bool  value forward-filled across a gap <= 2 h
    flagged     bool  inside a longer gap, or a removed spike (value is NaN)

``rain_catchment`` is the mean of the rain gauges that have a value in that hour; flagged when none do.
Import ``load_hourly()`` to read the file.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from pipeline.stations import RAIN_CATCHMENT, data_root

log = logging.getLogger("pipeline.clean")

BAD_QUALITY = {"suspect", "rejected", "missing", "invalid"}
MAX_FILL_H = 2
SPIKE_JUMP_M = 0.5
SPIKE_REVERT_H = 3
SHIFT_STEP_M = 0.3
SHIFT_WINDOW_H = 7 * 24
RAIN_MIN_READINGS = 3
SOURCE_PRIORITY = {"hydrology": 0, "fm_archive": 1, "fm_live": 2}

HOURLY_COLUMNS = ["gauge", "ts_utc", "kind", "level_mean", "level_max", "rain_mm", "filled", "flagged"]


def processed_dir() -> Path:
    d = data_root() / "processed"
    d.mkdir(parents=True, exist_ok=True)
    return d


def hourly_path() -> Path:
    return data_root() / "processed" / "hourly.parquet"


def load_hourly(path: str | Path | None = None) -> pd.DataFrame:
    """Read ``hourly.parquet`` (format in the module docstring). ``ts_utc`` is tz-aware UTC."""
    df = pd.read_parquet(path or hourly_path())
    df["ts_utc"] = pd.to_datetime(df["ts_utc"], utc=True)
    return df


# --------------------------------------------------------------------------------------------------
# Step 1: quality flags and duplicates
# --------------------------------------------------------------------------------------------------

def to_utc(ts: pd.Series) -> pd.Series:
    """Timestamps -> tz-aware UTC (naive values are taken as UTC, which is what the EA APIs return)."""
    ts = pd.to_datetime(ts)
    if ts.dt.tz is None:
        return ts.dt.tz_localize("UTC")
    return ts.dt.tz_convert("UTC")


def drop_bad_quality(raw: pd.DataFrame) -> tuple[pd.DataFrame, int]:
    """Drop readings EA flags as suspect/rejected/missing, and readings without a value."""
    bad = raw["quality"].astype(str).str.strip().str.lower().isin(BAD_QUALITY) | raw["value"].isna()
    return raw.loc[~bad].copy(), int(bad.sum())


def dedupe(raw: pd.DataFrame) -> tuple[pd.DataFrame, int]:
    """One reading per (gauge, ts_utc); prefer Hydrology over archive over live, then the first seen."""
    df = raw.copy()
    df["_prio"] = df["source"].map(SOURCE_PRIORITY).fillna(9)
    df = df.sort_values(["gauge", "ts_utc", "_prio"], kind="stable")
    out = df.drop_duplicates(["gauge", "ts_utc"], keep="first").drop(columns="_prio")
    return out.reset_index(drop=True), len(df) - len(out)


# --------------------------------------------------------------------------------------------------
# Step 2: hourly resample
# --------------------------------------------------------------------------------------------------

def resample_hourly(raw: pd.DataFrame, kind: str) -> pd.DataFrame:
    """One series' readings -> hourly frame on a complete UTC hour index (first..last hour).

    Columns: level_mean, level_max, rain_mm. Missing hours are NaN rows.
    """
    ts = to_utc(raw["ts_utc"]).dt.floor("h")
    vals = raw["value"].astype(float).to_numpy()
    g = pd.Series(vals, index=ts.to_numpy()).groupby(level=0)
    if kind == "rain":
        total, count = g.sum(), g.count()
        rain = total.where(count >= RAIN_MIN_READINGS)
        out = pd.DataFrame({"level_mean": np.nan, "level_max": np.nan, "rain_mm": rain})
    else:
        out = pd.DataFrame({"level_mean": g.mean(), "level_max": g.max(), "rain_mm": np.nan})
    out.index = pd.DatetimeIndex(out.index, tz="UTC") if out.index.tz is None else out.index
    if out.empty:
        return out
    full = pd.date_range(out.index.min(), out.index.max(), freq="h", tz="UTC")
    out = out.reindex(full)
    out.index.name = "ts_utc"
    return out.astype(float)


# --------------------------------------------------------------------------------------------------
# Step 3: gaps
# --------------------------------------------------------------------------------------------------

def _nan_runs(missing: np.ndarray) -> list[tuple[int, int]]:
    """(start, end_exclusive) of each run of True in a boolean array."""
    runs, start = [], None
    for i, m in enumerate(missing):
        if m and start is None:
            start = i
        elif not m and start is not None:
            runs.append((start, i))
            start = None
    if start is not None:
        runs.append((start, len(missing)))
    return runs


def fill_short_gaps(hourly: pd.DataFrame, kind: str,
                    max_gap_h: int = MAX_FILL_H) -> tuple[pd.DataFrame, int, int]:
    """Forward-fill level gaps of <= ``max_gap_h`` h; flag longer gaps. Returns (frame, n_filled, n_flagged).

    Counts are gap episodes, not hours. Rain gaps are never filled; gaps longer than ``max_gap_h``
    are flagged.
    """
    df = hourly.copy()
    df["filled"] = False
    df["flagged"] = False
    col = "rain_mm" if kind == "rain" else "level_mean"
    missing = df[col].isna().to_numpy()
    n_filled = n_flagged = 0
    filled = np.zeros(len(df), dtype=bool)
    flagged = np.zeros(len(df), dtype=bool)
    for s, e in _nan_runs(missing):
        if (e - s) <= max_gap_h and kind != "rain" and s > 0:
            filled[s:e] = True
            n_filled += 1
        elif (e - s) > max_gap_h:
            flagged[s:e] = True
            n_flagged += 1
    if kind != "rain" and filled.any():
        ff = df[["level_mean", "level_max"]].ffill()
        df.loc[filled, ["level_mean", "level_max"]] = ff.loc[filled].to_numpy()
    df["filled"] = filled
    df["flagged"] = flagged
    return df, n_filled, n_flagged


# --------------------------------------------------------------------------------------------------
# Step 4: spikes and level shifts
# --------------------------------------------------------------------------------------------------

def spike_mask(x: np.ndarray, jump: float = SPIKE_JUMP_M, revert_h: int = SPIKE_REVERT_H) -> np.ndarray:
    """True for hours inside a spike.

    A spike starts at hour i when ``|x[i] - x[i-1]| > jump`` and, within ``revert_h`` hours, the level
    comes back at least halfway to ``x[i-1]``. Hours i .. (return hour - 1) are spike hours.
    """
    n = len(x)
    mask = np.zeros(n, dtype=bool)
    i = 1
    while i < n:
        base, cur = x[i - 1], x[i]
        if np.isnan(base) or np.isnan(cur) or abs(cur - base) <= jump:
            i += 1
            continue
        d = cur - base
        ret = None
        for j in range(i + 1, min(i + revert_h, n - 1) + 1):
            if not np.isnan(x[j]) and abs(x[j] - base) <= 0.5 * abs(d):
                ret = j
                break
        if ret is None:
            i += 1
            continue
        mask[i:ret] = True
        i = ret
    return mask


def remove_spikes(df: pd.DataFrame) -> tuple[pd.DataFrame, int]:
    """NaN out spikes in level_mean / level_max; flag them. Returns (frame, number of spike episodes)."""
    out = df.copy()
    m = spike_mask(out["level_mean"].to_numpy(float)) | spike_mask(out["level_max"].to_numpy(float))
    n_episodes = len(_nan_runs(m))
    if m.any():
        out.loc[m, ["level_mean", "level_max"]] = np.nan
        out.loc[m, "flagged"] = True
        out.loc[m, "filled"] = False
    return out, n_episodes


def detect_level_shifts(level: pd.Series, step: float = SHIFT_STEP_M,
                        window_h: int = SHIFT_WINDOW_H) -> list[dict[str, Any]]:
    """Candidate persistent level shifts (possible datum change), for human review only.

    A candidate is a change of more than ``step`` m between consecutive valid hours (also across a gap)
    where the median of the following week differs from the median of the previous week by more than
    ``step`` m in the same direction, and the single step accounts for >= 80 % of that change (a flood
    rises over many hours, a datum change in one).
    """
    v = level.dropna()
    if len(v) < 3:
        return []
    d = v.diff()
    cand = d[d.abs() > step]
    shifts = []
    win = pd.Timedelta(hours=window_h)
    for ts, dv in cand.items():
        before = v.loc[ts - win: ts - pd.Timedelta(hours=1)]
        after = v.loc[ts: ts + win]
        if len(before) < window_h // 2 or len(after) < window_h // 2:
            continue
        dm = float(after.median() - before.median())
        if abs(dm) > step and np.sign(dm) == np.sign(dv) and abs(dv) >= 0.8 * abs(dm):
            prev_ts = v.index[v.index.get_loc(ts) - 1]
            shifts.append({"ts_utc": ts.isoformat(), "step_m": round(float(dv), 3),
                           "median_change_m": round(dm, 3),
                           "gap_h": int((ts - prev_ts) / pd.Timedelta(hours=1)) - 1})
    return shifts


# --------------------------------------------------------------------------------------------------
# Per series
# --------------------------------------------------------------------------------------------------

def clean_series(raw: pd.DataFrame, kind: str) -> tuple[pd.DataFrame, dict[str, Any]]:
    """Run steps 1–4 on one series' readings. Returns (hourly frame in HOURLY_COLUMNS, stats)."""
    gauge = str(raw["gauge"].iloc[0]) if len(raw) else "?"
    raw = raw.copy()
    raw["ts_utc"] = to_utc(raw["ts_utc"])
    n_in = len(raw)
    good, n_bad = drop_bad_quality(raw)
    good, n_dup = dedupe(good)
    stats: dict[str, Any] = {"gauge": gauge, "kind": kind, "readings_in": n_in, "quality_dropped": n_bad,
                             "duplicates_dropped": n_dup, "gaps_filled": 0, "gaps_flagged": 0,
                             "spikes_removed": 0, "level_shifts": [], "hours": 0, "hours_valid": 0}
    if good.empty:
        return pd.DataFrame(columns=HOURLY_COLUMNS), stats
    hourly = resample_hourly(good, kind)
    hourly, n_filled, n_flagged = fill_short_gaps(hourly, kind)
    n_spikes = 0
    if kind == "level":
        hourly, n_spikes = remove_spikes(hourly)
        stats["level_shifts"] = detect_level_shifts(hourly["level_mean"])
    col = "rain_mm" if kind == "rain" else "level_mean"
    stats.update(gaps_filled=n_filled, gaps_flagged=n_flagged, spikes_removed=n_spikes,
                 hours=len(hourly), hours_valid=int(hourly[col].notna().sum()),
                 first_ts=hourly.index.min().isoformat(), last_ts=hourly.index.max().isoformat(),
                 first_valid_ts=hourly[col].first_valid_index().isoformat()
                 if hourly[col].notna().any() else None)
    out = hourly.reset_index().rename(columns={"index": "ts_utc"})
    out["gauge"] = gauge
    out["kind"] = kind
    return out[HOURLY_COLUMNS], stats


def rain_catchment(rain_hourly: pd.DataFrame) -> tuple[pd.DataFrame, dict[str, Any]]:
    """Catchment rain = mean of the rain gauges with a value in each hour (SPEC §4.1)."""
    wide = rain_hourly.pivot(index="ts_utc", columns="gauge", values="rain_mm").sort_index()
    full = pd.date_range(wide.index.min(), wide.index.max(), freq="h", tz="UTC")
    wide = wide.reindex(full)
    mean = wide.mean(axis=1, skipna=True)
    n_avail = wide.notna().sum(axis=1)
    out = pd.DataFrame({
        "gauge": RAIN_CATCHMENT, "ts_utc": full, "kind": "rain", "level_mean": np.nan, "level_max": np.nan,
        "rain_mm": mean.to_numpy(), "filled": False, "flagged": (n_avail == 0).to_numpy(),
    })
    share = {g: round(float(wide[g].notna().mean()) * 100, 1) for g in wide.columns}
    stats = {"gauge": RAIN_CATCHMENT, "kind": "rain", "gauges_used": sorted(wide.columns.tolist()),
             "pct_hours_with_gauge": share,
             "pct_hours_all_gauges": round(float((n_avail == wide.shape[1]).mean()) * 100, 1),
             "hours": len(out), "hours_valid": int(out["rain_mm"].notna().sum()),
             "gaps_filled": 0, "gaps_flagged": len(_nan_runs((n_avail == 0).to_numpy())),
             "spikes_removed": 0, "level_shifts": [],
             "first_ts": full.min().isoformat(), "last_ts": full.max().isoformat()}
    return out[HOURLY_COLUMNS], stats


# --------------------------------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------------------------------

def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    root = data_root()
    manifest_file = root / "interim" / "ingest_manifest.json"
    if not manifest_file.exists():
        raise SystemExit(f"{manifest_file} not found: run `python -m pipeline.ingest_history` first")
    manifest: dict[str, Any] = json.loads(manifest_file.read_text())

    frames, stats, prov = [], {}, []
    for series, entry in manifest.items():
        path = root / "interim" / "readings" / f"{series}.parquet"
        if "error" in entry or not path.exists():
            log.warning("%s: no readings (%s)", series, entry.get("error", "file missing"))
            continue
        raw = pd.read_parquet(path)
        if raw.empty:
            log.warning("%s: empty", series)
            stats[series] = {"gauge": series, "kind": entry.get("kind", "level"), "hours": 0,
                             "hours_valid": 0, "gaps_filled": 0, "gaps_flagged": 0,
                             "spikes_removed": 0, "level_shifts": []}
            continue
        hourly, st = clean_series(raw, entry.get("kind", "level"))
        st.update({k: entry.get(k) for k in ("source", "qualifier", "first_available", "archive_days")
                   if entry.get(k) is not None})
        frames.append(hourly)
        stats[series] = st
        prov.append({"gauge": series, "source": entry.get("source"), "qualifier": entry.get("qualifier"),
                     "source_url": entry.get("source_url"),
                     "licence": entry.get("licence"), "downloaded_at": entry.get("downloaded_at"),
                     "n_rows": len(raw), "first_ts": raw["ts_utc"].min(), "last_ts": raw["ts_utc"].max()})
        log.info("%s: %d h, %d valid, %d gaps filled, %d flagged, %d spikes, %d shift candidates", series,
                 st["hours"], st["hours_valid"], st["gaps_filled"], st["gaps_flagged"],
                 st["spikes_removed"], len(st["level_shifts"]))

    rain = [f for f in frames if len(f) and f["kind"].iloc[0] == "rain"]
    if rain:
        cat, cst = rain_catchment(pd.concat(rain, ignore_index=True))
        frames.append(cat)
        stats[RAIN_CATCHMENT] = cst
        log.info("rain_catchment from %s", cst["gauges_used"])

    hourly_all = pd.concat(frames, ignore_index=True)
    hourly_all["ts_utc"] = pd.to_datetime(hourly_all["ts_utc"], utc=True).astype("datetime64[ns, UTC]")
    hourly_all = hourly_all.astype({"gauge": str, "kind": str, "level_mean": float, "level_max": float,
                                    "rain_mm": float, "filled": bool, "flagged": bool})
    hourly_all = hourly_all.sort_values(["gauge", "ts_utc"]).reset_index(drop=True)
    assert not hourly_all.duplicated(["gauge", "ts_utc"]).any()
    out = processed_dir()
    hourly_all.to_parquet(out / "hourly.parquet", index=False)
    pv = pd.DataFrame(prov)
    for c in ("first_ts", "last_ts"):
        pv[c] = pd.to_datetime(pv[c], utc=True)
    pv.to_parquet(out / "provenance.parquet", index=False)
    (out / "clean_log.json").write_text(json.dumps(stats, indent=1, default=str))
    log.info("wrote %s (%d rows), provenance.parquet, clean_log.json",
             out / "hourly.parquet", len(hourly_all))


if __name__ == "__main__":
    main()
