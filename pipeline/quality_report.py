"""Write web/public/data/quality.json: coverage, gaps, spikes, threshold mismatches (SPEC §5.3).

Shape: SPEC §9 ``Quality``. Inputs: ``data/processed/clean_log.json`` and ``provenance.parquet`` from
pipeline/clean.py, the gauge config, and flood-monitoring station metadata (``stageScale`` /
``downstageScale`` ``typicalRangeHigh``, re-read at every run and cached for a day).

- ``coveragePct``: hours with a valid value / hours from 2006-01-01 to the end of the data.
- ``gapsFilled`` / ``gapsFlagged`` / ``spikesRemoved``: episodes, not hours.
- ``thresholdApi`` vs ``thresholdConfig``: the normal-range top (amber) from the API vs config.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

import pandas as pd

from pipeline import ea_client
from pipeline.stations import RAIN_CATCHMENT, REPO_ROOT, UPSTREAM_SUFFIX, Gauge, data_root, load_gauges

log = logging.getLogger("pipeline.quality_report")

OUT = REPO_ROOT / "web" / "public" / "data" / "quality.json"
STUDY_START = pd.Timestamp("2006-01-01", tz="UTC")
MISMATCH_TOL_M = 0.02
MAX_SHIFT_NOTES = 3

SOURCE_INFO = {
    "hydrology": ("EA Hydrology API (15-min level and rainfall)", "https://environment.data.gov.uk/hydrology/"),
    "fm_archive": ("EA flood-monitoring daily archive (downstream lock stage)",
                   "https://environment.data.gov.uk/flood-monitoring/archive"),
    "fm_meta": ("EA flood-monitoring API (station metadata and thresholds)",
                "https://environment.data.gov.uk/flood-monitoring/"),
}


def _scale(station: dict[str, Any], name: str) -> dict[str, Any] | None:
    s = station.get(name)
    if isinstance(s, str):  # some stations link the scale instead of embedding it
        ref = s.rstrip("/").split("/")[-2]
        doc = ea_client.cached_json(s, ea_client.raw_dir() / "flood_monitoring" / "stations" /
                                    f"{ref}_{name}.json", ttl_s=ea_client.META_TTL_S)
        s = doc.get("items")
    return s if isinstance(s, dict) else None


def api_threshold(g: Gauge, upstream_stage: bool) -> tuple[float | None, str | None]:
    """typicalRangeHigh for the series' stage (downstage for the §4.1 lock series). (value, error)."""
    try:
        st = ea_client.fm_station(g.ref)
    except Exception as e:  # metadata is a nice-to-have; never fail the report on it
        return None, f"flood-monitoring metadata unavailable: {e}"
    name = "downstageScale" if (g.is_lock_downstream and not upstream_stage) else "stageScale"
    sc = _scale(st, name)
    if not sc or sc.get("typicalRangeHigh") is None:
        return None, f"no {name}.typicalRangeHigh in flood-monitoring metadata"
    return float(sc["typicalRangeHigh"]), None


def gauge_entry(series: str, st: dict[str, Any], g: Gauge | None, end: pd.Timestamp) -> dict[str, Any]:
    study_h = max(int((end - STUDY_START) / pd.Timedelta(hours=1)) + 1, 1)
    notes: list[str] = []
    kind = st.get("kind", "level")
    upstream_stage = series.endswith(UPSTREAM_SUFFIX)
    t_api = t_cfg = None
    src = st.get("source")
    if series == RAIN_CATCHMENT:
        notes.append("Mean of available rain gauges per hour: " + ", ".join(
            f"{k} {v}% of hours" for k, v in st.get("pct_hours_with_gauge", {}).items()))
        notes.append(f"All gauges present in {st.get('pct_hours_all_gauges')}% of hours")
    elif kind == "rain":
        notes.append("Rain gauge (Hydrology 15-min totals); hourly sum needs >= 3 of 4 readings")
    elif g is not None:
        if upstream_stage:
            notes.append("UPSTREAM head-water stage of the lock (Hydrology API's only level series here). "
                         "Different datum from the downstream stage: not comparable with §4.1 thresholds")
        elif g.is_lock_downstream:
            days = st.get("archive_days") or []
            notes.append(f"DOWNSTREAM stage (§4.1 measure) from the flood-monitoring daily archive only: "
                         f"{len(days)} days ({days[0] if days else '-'} to {days[-1] if days else '-'}). "
                         f"Hydrology API has no downstream series for this lock")
        else:
            notes.append("Stage (the station's only level series, as in §4.1), Hydrology API")
        t_api, err = api_threshold(g, upstream_stage)
        t_cfg = None if upstream_stage else g.amber
        if err:
            notes.append(err)
        if t_api is not None and t_cfg is not None and abs(t_api - t_cfg) > MISMATCH_TOL_M:
            notes.append(f"Threshold mismatch: API typicalRangeHigh {t_api} m vs config {t_cfg} m")
    if st.get("first_valid_ts"):
        notes.append(f"First data {st['first_valid_ts'][:10]}")
    if src == "hydrology" and st.get("first_available"):
        fa = st["first_available"][:10]
        if fa < "2006-01-01":
            notes.append(f"Hydrology history from {fa}; ingested from 2006")
    if st.get("quality_dropped"):
        notes.append(f"{st['quality_dropped']} readings dropped (EA quality suspect/rejected/missing)")
    shifts = st.get("level_shifts") or []
    if shifts:
        listed = "; ".join(f"{s['ts_utc'][:13]}Z {s['step_m']:+.2f} m" for s in shifts[:MAX_SHIFT_NOTES])
        more = f" (+{len(shifts) - MAX_SHIFT_NOTES} more)" if len(shifts) > MAX_SHIFT_NOTES else ""
        notes.append(f"{len(shifts)} possible persistent level shift(s), review: {listed}{more}")
    return {
        "key": series,
        "coveragePct": round(100.0 * st.get("hours_valid", 0) / study_h, 1),
        "gapsFilled": int(st.get("gaps_filled", 0)),
        "gapsFlagged": int(st.get("gaps_flagged", 0)),
        "spikesRemoved": int(st.get("spikes_removed", 0)),
        "thresholdApi": t_api,
        "thresholdConfig": t_cfg,
        "notes": notes,
    }


def build_report(stats: dict[str, Any], prov: pd.DataFrame) -> dict[str, Any]:
    levels, rains = load_gauges()
    by_key = {g.key: g for g in [*levels, *rains]}
    ends = [pd.Timestamp(s["last_ts"]) for s in stats.values() if s.get("last_ts")]
    end = max(ends) if ends else pd.Timestamp.now(tz="UTC")
    order = [g.key for g in levels]
    def sort_key(k: str) -> tuple[int, str]:
        base = k.removesuffix(UPSTREAM_SUFFIX)
        if base in order:
            return (order.index(base) * 2 + (1 if k.endswith(UPSTREAM_SUFFIX) else 0), k)
        return (1000 if k != RAIN_CATCHMENT else 999, k)
    gauges = []
    for series in sorted(stats, key=sort_key):
        g = by_key.get(series.removesuffix(UPSTREAM_SUFFIX))
        gauges.append(gauge_entry(series, stats[series], g, end))

    sources = []
    for src, grp in prov.groupby("source"):
        name, url = SOURCE_INFO.get(src, (src, ""))
        sources.append({"name": name, "url": url, "licence": ea_client.LICENCE_OGL,
                        "downloadedAt": str(grp["downloaded_at"].dropna().max()),
                        "rows": int(grp["n_rows"].sum())})
    meta_dir = ea_client.raw_dir() / "flood_monitoring" / "stations"
    metas = [ea_client.cache_meta(p).get("downloaded_at") for p in meta_dir.glob("*.json")
             if not p.name.endswith(".meta.json")]
    metas = [m for m in metas if m]
    if metas:
        name, url = SOURCE_INFO["fm_meta"]
        sources.append({"name": name, "url": url, "licence": ea_client.LICENCE_OGL,
                        "downloadedAt": max(metas), "rows": len(metas)})
    return {"gauges": gauges, "sources": sources}


def main(out: Path = OUT) -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    proc = data_root() / "processed"
    stats = json.loads((proc / "clean_log.json").read_text())
    prov = pd.read_parquet(proc / "provenance.parquet")
    report = build_report(stats, prov)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=1) + "\n")
    log.info("wrote %s (%d gauges, %d bytes)", out, len(report["gauges"]), out.stat().st_size)


if __name__ == "__main__":
    main()
