"""Gauge and rain-gauge configuration for the data pipeline (SPEC §4.1).

Reads ``config/stations.yaml`` when it exists. Until issue #2 lands that file, a temporary mapping
(``_FALLBACK_GAUGES``, verified by hand against the Hydrology and flood-monitoring APIs on 24 Oct 2026)
fills in. Any field the yaml leaves out is also taken from the fallback, so the yaml can stay minimal.

Lock gauges (``qualifier: downstream``): the §4.1 thresholds are on the *downstream* stage, but the
Hydrology API only archives the *upstream* (head-water) stage for these locks. The pipeline therefore
keeps two series per lock gauge:

- ``<key>``     the §4.1 downstream stage, from the flood-monitoring daily archive (≈ last 12 months) only;
- ``<key>_us``  the upstream head-water stage, full Hydrology history. Different datum: never compare
                it with ``<key>``.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
STATIONS_YAML = REPO_ROOT / "config" / "stations.yaml"

HYDROLOGY = "https://environment.data.gov.uk/hydrology"
FLOOD_MONITORING = "https://environment.data.gov.uk/flood-monitoring"

UPSTREAM_SUFFIX = "_us"
RAIN_CATCHMENT = "rain_catchment"


def data_root() -> Path:
    """Shared data root: ``RC_DATA_DIR`` env var, else ``<repo>/data``."""
    env = os.environ.get("RC_DATA_DIR")
    return Path(env).expanduser().resolve() if env else REPO_ROOT / "data"


@dataclass(frozen=True)
class Gauge:
    key: str
    name: str
    river: str
    role: str  # upstream | target | rain
    ref: str  # flood-monitoring stationReference
    kind: str = "level"  # level | rain
    qualifier: str = "stage"  # stage | downstream (the §4.1 measure)
    hydrology_measure: str | None = None  # Hydrology 15-min measure id (level-i-900 / rainfall-t-900)
    amber: float | None = None  # normal-range top (config)
    threshold: float | None = None  # property flooding possible (config)
    record: float | None = None
    extra: dict[str, Any] = field(default_factory=dict, compare=False)

    @property
    def is_lock_downstream(self) -> bool:
        return self.kind == "level" and self.qualifier == "downstream"

    @property
    def fm_measure(self) -> str:
        """flood-monitoring 15-min measure notation for the §4.1 series."""
        if self.kind == "rain":
            return f"{self.ref}-rainfall-tipping_bucket_raingauge-t-15_min-mm"
        q = "downstage" if self.qualifier == "downstream" else "stage"
        return f"{self.ref}-level-{q}-i-15_min-mASD"


# TEMPORARY: replace with config/stations.yaml (issue #2) once merged. Measure ids verified
# 2026-10-24 via /hydrology/id/stations?stationReference=... and ?RLOIid=...
_FALLBACK_GAUGES: list[dict[str, Any]] = [
    dict(key="farmoor", name="Farmoor", river="Thames", role="upstream", ref="1100TH",
         hydrology_measure="6b80bd1c-6c19-4c26-875d-108bf8ef1a84-level-i-900-m-qualified",
         amber=1.30, threshold=1.75, record=2.01),
    dict(key="eynsham", name="Eynsham Lock d/s", river="Thames", role="upstream", ref="1201TH",
         qualifier="downstream",
         hydrology_measure="dd230984-b45b-4fd6-8ebf-45ca375799f1-level-i-900-m-qualified",
         amber=2.96, threshold=None, record=3.65),
    dict(key="cassington", name="Cassington Weir B", river="Evenlode", role="upstream", ref="1290_w2TH",
         hydrology_measure="8afc6e20-b0bd-4b79-bf65-345dac8cafee_1290_w2TH-level-i-900-m-qualified",
         amber=0.77, threshold=None, record=1.29),
    dict(key="enslow", name="Enslow Weir A", river="Cherwell", role="upstream", ref="1460_w1TH",
         hydrology_measure="dac96a5d-7fde-4066-b8a2-58a085e0c002-level-i-900-m-qualified",
         amber=1.29, threshold=None, record=2.10),
    dict(key="islip", name="Islip", river="Ray", role="upstream", ref="1489TH",
         hydrology_measure="34e23121-3c10-454d-80dc-45d824b9e2cf-level-i-900-m-qualified",
         amber=7.80, threshold=8.85, record=9.33),
    dict(key="godstow", name="Godstow Lock d/s", river="Thames", role="target", ref="1302TH",
         qualifier="downstream",
         hydrology_measure="7500ccb3-dc3b-49fb-ac42-241fd7ab908c-level-i-900-m-qualified",
         amber=2.57, threshold=3.07, record=3.11),
    dict(key="osney", name="Osney Lock d/s", river="Thames", role="target", ref="1303TH",
         qualifier="downstream",
         hydrology_measure="5086b349-e04b-4f8e-b8f1-fa92b21078d0-level-i-900-m-qualified",
         amber=3.18, threshold=3.79, record=3.97),
    dict(key="iffley", name="Iffley Lock d/s", river="Thames", role="target", ref="1501TH",
         qualifier="downstream",
         hydrology_measure="ab070726-7ac8-4037-a352-90552398d491-level-i-900-m-qualified",
         amber=2.72, threshold=3.25, record=3.67),
    dict(key="kingsmill", name="Kings Mill u/s", river="Cherwell", role="target", ref="1491TH",
         hydrology_measure="a2d56f20-689b-4d3f-ab13-5e7c4baf2772-level-i-900-m-qualified",
         amber=2.40, threshold=2.60, record=2.79),
    dict(key="newbotley", name="New Botley", river="Bulstake Stream", role="target", ref="1645TH",
         hydrology_measure="d3ed05d0-98fe-4dfb-9281-8e049743f92d-level-i-900-m-qualified",
         amber=2.01, threshold=2.76, record=3.14),
    # Added by the PM's target decision (SPEC PR #30). Thresholds come from config/stations.yaml (#2);
    # until then quality.json shows the API value only.
    dict(key="minns", name="Minns Estate", river="Seacourt Stream", role="target", ref="1635TH",
         hydrology_measure="745d25c4-7e29-48a9-bfe7-cc14eea17751-level-i-900-m-qualified"),
    dict(key="coldharbour", name="Cold Harbour", river="Hinksey Stream", role="target", ref="1675TH",
         hydrology_measure="a65c175a-bae8-427a-822d-896ed2d53c58-level-i-900-m-qualified"),
]

_FALLBACK_RAIN: list[dict[str, Any]] = [
    dict(key="256230TP", name="Osney", ref="256230TP",
         hydrology_measure="5086b349-e04b-4f8e-b8f1-fa92b21078d0_256230TP-rainfall-t-900-mm-qualified"),
    dict(key="254336TP", name="Eynsham", ref="254336TP",
         hydrology_measure="de8bb5b8-45a5-4282-8028-6268e5af1d30-rainfall-t-900-mm-qualified"),
    dict(key="261021TP", name="Abingdon", ref="261021TP",
         hydrology_measure="fe3efb87-062c-4880-9dc3-7dd8f335a6d1-rainfall-t-900-mm-qualified"),
    dict(key="264254TP", name="Benson", ref="264254TP",
         hydrology_measure="1ad8ff76-625d-4ff1-82bd-9efcc5d41b2f_264254TP-rainfall-t-900-mm-qualified"),
    dict(key="263541TP", name="Wheatley", ref="263541TP",
         hydrology_measure="7eb546a1-8663-4d07-a9cc-e7b5f6e13006-rainfall-t-900-mm-qualified"),
]

# Ingest order (PM, SPEC PR #30): primary target newbotley + Thames upstreams first, then the other
# targets and the Cherwell; the lock gauges (upstream-stage history only) last.
PRIORITY = ["newbotley", "farmoor", "eynsham", "cassington", "minns", "coldharbour", "kingsmill",
            "enslow", "islip", "osney", "godstow", "iffley"]

_GAUGE_FIELDS = {"key", "name", "river", "role", "ref", "kind", "qualifier", "hydrology_measure",
                 "amber", "threshold", "record"}

# Field-name aliases accepted from config/stations.yaml (its schema is owned by issue #2).
_ALIASES = {
    "stationReference": "ref", "station_reference": "ref", "reference": "ref",
    "measure": "hydrology_measure", "hydrology_measure_id": "hydrology_measure",
    "level_measure": "hydrology_measure",
    "hydrology": "hydrology_measure", "measure_id": "hydrology_measure", "rain_measure": "hydrology_measure",
    "normal_top": "amber", "typical_range_high": "amber",
    "property_flooding": "threshold", "flood_threshold": "threshold",
    "record_level": "record", "max_on_record": "record",
}


def _normalise_entry(raw: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k, v in raw.items():
        k2 = _ALIASES.get(k, k)
        if isinstance(v, dict) and k2 == "record":
            v = v.get("value", v.get("level"))
        if k2 == "hydrology_measure" and isinstance(v, str):
            v = v.rstrip("/").rsplit("/", 1)[-1]
        if k2 == "qualifier" and isinstance(v, str):
            v = "downstream" if v.lower().startswith(("down", "d/s", "ds")) else "stage"
        out[k2] = v
    return out


def _yaml_entries(doc: Any, section: str) -> list[dict[str, Any]]:
    """Accept either a list of mappings or a {key: mapping} dict under ``section``."""
    if not isinstance(doc, dict):
        return []
    sec = doc.get(section)
    if isinstance(sec, list):
        return [dict(e) for e in sec if isinstance(e, dict)]
    if isinstance(sec, dict):
        return [{"key": k, **(v or {})} for k, v in sec.items() if isinstance(v, dict) or v is None]
    return []


def _merge(fallback: list[dict[str, Any]], from_yaml: list[dict[str, Any]], kind: str) -> list[Gauge]:
    by_key = {e["key"]: dict(e) for e in fallback}
    for e in from_yaml:
        e = _normalise_entry(e)
        key = str(e.get("key") or e.get("ref"))
        role = "rain" if kind == "rain" else ""
        base = by_key.get(key, {"key": key, "name": key, "river": "", "role": role})
        base.update({k: v for k, v in e.items() if v is not None})
        by_key[key] = base
    gauges = []
    for e in by_key.values():
        known = {k: e[k] for k in _GAUGE_FIELDS if k in e}
        known.setdefault("river", "")
        known.setdefault("role", "rain" if kind == "rain" else "upstream")
        known["kind"] = kind
        known["key"] = str(known["key"])
        known["ref"] = str(known.get("ref") or known["key"])
        extra = {k: v for k, v in e.items() if k not in _GAUGE_FIELDS}
        gauges.append(Gauge(**known, extra=extra))
    return gauges


def load_gauges(path: Path | None = None) -> tuple[list[Gauge], list[Gauge]]:
    """Return ``(level_gauges, rain_gauges)`` from config/stations.yaml, falling back to the built-in map."""
    path = path or STATIONS_YAML
    doc: Any = {}
    if path.exists():
        doc = yaml.safe_load(path.read_text()) or {}
    level_yaml = _yaml_entries(doc, "gauges") or _yaml_entries(doc, "stations")
    rain_yaml = _yaml_entries(doc, "rain_gauges") or _yaml_entries(doc, "rain")
    levels = _merge(_FALLBACK_GAUGES, level_yaml, "level")
    rains = _merge(_FALLBACK_RAIN, rain_yaml, "rain")
    order = {k: i for i, k in enumerate(PRIORITY)}
    levels.sort(key=lambda g: order.get(g.key, len(order)))
    return levels, rains


def series_key(gauge: Gauge, upstream_stage: bool = False) -> str:
    """Key of a series in hourly.parquet: ``<key>`` or ``<key>_us`` for a lock's head-water stage."""
    return f"{gauge.key}{UPSTREAM_SUFFIX}" if upstream_stage else gauge.key
