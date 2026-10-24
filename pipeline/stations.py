"""Gauge and rain-gauge configuration for the data pipeline (SPEC §4.1, §4.1.1).

Reads ``config/stations.yaml`` (issue #2; schema documented in that file). A built-in copy of the
essentials (``_FALLBACK_GAUGES``) is used only if the yaml is missing, and fills fields the yaml leaves out.

``trace`` is the flood-monitoring trace the gauge key stands for: ``single`` (one-trace station),
``u/s`` or ``d/s`` (lock upstream / downstream stage). ``history_ok`` says whether the Hydrology
15-min series is that same trace.

For the live-only locks (osney, godstow, iffley: ``trace: d/s``, ``history_ok: false``) the Hydrology
API only archives the *upstream* stage. The pipeline keeps two series per such gauge:

- ``<key>``     the d/s stage (the gauge's §4.1 trace), from the flood-monitoring daily archive only
                (from 2025-10-29);
- ``<key>_us``  the u/s head-water stage, full Hydrology history, context only. Different datum and
                a different trace: never compare it with ``<key>`` or with the §4.1 thresholds.
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
    role: str  # upstream | target | live_only | rain
    ref: str  # flood-monitoring stationReference
    kind: str = "level"  # level | rain
    trace: str = "single"  # single | u/s | d/s: the trace the key stands for
    history_ok: bool = True  # the Hydrology series is that same trace
    hydrology_measure: str | None = None  # Hydrology 15-min measure id
    fm_measure: str | None = None  # flood-monitoring 15-min measure for ``trace``
    amber: float | None = None  # typicalRangeHigh of ``trace`` (config)
    threshold: float | None = None  # property flooding possible (config)
    record: float | None = None
    extra: dict[str, Any] = field(default_factory=dict, compare=False)

    @property
    def needs_archive(self) -> bool:
        """True when the key's trace has no Hydrology history (lock d/s): use the daily archive."""
        return self.kind == "level" and not self.history_ok

    @property
    def fm_level_measure(self) -> str:
        """flood-monitoring 15-min measure notation for the key's trace."""
        if self.fm_measure:
            return self.fm_measure
        if self.kind == "rain":
            return f"{self.ref}-rainfall-tipping_bucket_raingauge-t-15_min-mm"
        q = "downstage" if self.trace == "d/s" else "stage"
        return f"{self.ref}-level-{q}-i-15_min-mASD"


# Used only when config/stations.yaml is missing. Mirrors the yaml verified in #2 (2026-10-24).
_FALLBACK_GAUGES: list[dict[str, Any]] = [
    dict(key="newbotley", name="New Botley", river="Bulstake Stream", role="target", ref="1645TH",
         hydrology_measure="d3ed05d0-98fe-4dfb-9281-8e049743f92d-level-i-900-m-qualified",
         amber=2.01, threshold=2.76, record=3.141),
    dict(key="farmoor", name="Farmoor", river="Thames", role="upstream", ref="1100TH",
         hydrology_measure="6b80bd1c-6c19-4c26-875d-108bf8ef1a84-level-i-900-m-qualified",
         amber=1.30, threshold=1.75, record=2.006),
    dict(key="eynsham", name="Eynsham Lock u/s", river="Thames", role="upstream", ref="1201TH", trace="u/s",
         hydrology_measure="dd230984-b45b-4fd6-8ebf-45ca375799f1-level-i-900-m-qualified",
         amber=0.37, threshold=None, record=1.187),
    dict(key="cassington", name="Cassington Weir B", river="Evenlode", role="upstream", ref="1290_w2TH",
         hydrology_measure="8afc6e20-b0bd-4b79-bf65-345dac8cafee_1290_w2TH-level-i-900-m-qualified",
         amber=0.77, threshold=None, record=1.292),
    dict(key="minns", name="Minns Estate", river="Seacourt Stream", role="target", ref="1635TH",
         hydrology_measure="745d25c4-7e29-48a9-bfe7-cc14eea17751-level-i-900-m-qualified",
         amber=2.13, threshold=2.90, record=3.117),
    dict(key="coldharbour", name="Cold Harbour", river="Hinksey Stream", role="target", ref="1675TH",
         hydrology_measure="a65c175a-bae8-427a-822d-896ed2d53c58-level-i-900-m-qualified",
         amber=2.30, threshold=2.44, record=2.738),
    dict(key="kingsmill", name="Kings Mill u/s", river="Cherwell", role="target", ref="1491TH", trace="u/s",
         hydrology_measure="a2d56f20-689b-4d3f-ab13-5e7c4baf2772-level-i-900-m-qualified",
         amber=2.40, threshold=2.60, record=2.785),
    dict(key="enslow", name="Enslow Weir A", river="Cherwell", role="upstream", ref="1460_w1TH",
         hydrology_measure="dac96a5d-7fde-4066-b8a2-58a085e0c002-level-i-900-m-qualified",
         amber=1.29, threshold=None, record=2.103),
    dict(key="islip", name="Islip", river="Ray", role="upstream", ref="1489TH",
         hydrology_measure="34e23121-3c10-454d-80dc-45d824b9e2cf-level-i-900-m-qualified",
         amber=7.80, threshold=8.85, record=9.327),
    dict(key="osney", name="Osney Lock d/s", river="Thames", role="live_only", ref="1303TH",
         trace="d/s", history_ok=False,
         hydrology_measure="5086b349-e04b-4f8e-b8f1-fa92b21078d0-level-i-900-m-qualified",
         amber=3.175, threshold=3.79, record=3.97),
    dict(key="godstow", name="Godstow Lock d/s", river="Thames", role="live_only", ref="1302TH",
         trace="d/s", history_ok=False,
         hydrology_measure="7500ccb3-dc3b-49fb-ac42-241fd7ab908c-level-i-900-m-qualified",
         amber=2.57, threshold=3.07, record=3.111),
    dict(key="iffley", name="Iffley Lock d/s", river="Thames", role="live_only", ref="1501TH",
         trace="d/s", history_ok=False,
         hydrology_measure="ab070726-7ac8-4037-a352-90552398d491-level-i-900-m-qualified",
         amber=2.72, threshold=3.25, record=3.665),
]

_FALLBACK_RAIN: list[dict[str, Any]] = [
    dict(ref="256230TP", name="Osney Lock",
         hydrology_measure="5086b349-e04b-4f8e-b8f1-fa92b21078d0_256230TP-rainfall-t-900-mm-qualified"),
    dict(ref="254336TP", name="Eynsham",
         hydrology_measure="de8bb5b8-45a5-4282-8028-6268e5af1d30-rainfall-t-900-mm-qualified"),
    dict(ref="261021TP", name="Abingdon",
         hydrology_measure="fe3efb87-062c-4880-9dc3-7dd8f335a6d1-rainfall-t-900-mm-qualified"),
    dict(ref="264254TP", name="Benson",
         hydrology_measure="1ad8ff76-625d-4ff1-82bd-9efcc5d41b2f_264254TP-rainfall-t-900-mm-qualified"),
    dict(ref="263541TP", name="Wheatley",
         hydrology_measure="7eb546a1-8663-4d07-a9cc-e7b5f6e13006-rainfall-t-900-mm-qualified"),
]

# Ingest order (PM, SPEC §4.1.1): primary target newbotley + Thames upstreams first, then the other
# targets and the Cherwell; the live-only locks (u/s history only) last.
PRIORITY = ["newbotley", "farmoor", "eynsham", "cassington", "minns", "coldharbour", "kingsmill",
            "enslow", "islip", "osney", "godstow", "iffley"]

_FIELDS = {"key", "name", "river", "role", "ref", "trace", "history_ok", "hydrology_measure", "fm_measure",
           "amber", "threshold", "record"}


def _normalise_entry(raw: dict[str, Any]) -> dict[str, Any]:
    """Map a stations.yaml entry onto Gauge fields (``hydrology: {level_measure, qualifier}`` etc.)."""
    e = dict(raw)
    hyd = e.pop("hydrology", None)
    if isinstance(hyd, dict):
        e.setdefault("hydrology_measure", hyd.get("level_measure") or hyd.get("measure"))
        e["hydrology_qualifier"] = hyd.get("qualifier")
    elif isinstance(hyd, str):
        e.setdefault("hydrology_measure", hyd)
    m = e.get("hydrology_measure")
    if isinstance(m, str):
        e["hydrology_measure"] = m.rstrip("/").rsplit("/", 1)[-1]
    if "key" not in e and "ref" in e:
        e["key"] = e["ref"]
    if e.get("trace") is not None:
        e["trace"] = str(e["trace"])
    return e


def _yaml_entries(doc: Any, section: str) -> list[dict[str, Any]]:
    if not isinstance(doc, dict):
        return []
    sec = doc.get(section)
    if isinstance(sec, list):
        return [dict(x) for x in sec if isinstance(x, dict)]
    if isinstance(sec, dict):
        return [{"key": k, **(v or {})} for k, v in sec.items() if isinstance(v, dict) or v is None]
    return []


def _merge(fallback: list[dict[str, Any]], from_yaml: list[dict[str, Any]], kind: str) -> list[Gauge]:
    by_key: dict[str, dict[str, Any]] = {}
    for e in fallback:
        e = _normalise_entry(e)
        by_key[str(e["key"])] = e
    for e in from_yaml:
        e = _normalise_entry(e)
        key = str(e["key"])
        base = by_key.get(key, {"key": key})
        base.update({k: v for k, v in e.items() if v is not None or k in ("threshold", "amber", "record")})
        by_key[key] = base
    out = []
    for e in by_key.values():
        known = {k: e[k] for k in _FIELDS if k in e}
        known["key"] = str(known["key"])
        known["ref"] = str(known.get("ref") or known["key"])
        known.setdefault("name", known["key"])
        known.setdefault("river", "")
        known.setdefault("role", "rain" if kind == "rain" else "upstream")
        known["history_ok"] = bool(known.get("history_ok", True))
        extra = {k: v for k, v in e.items() if k not in _FIELDS}
        out.append(Gauge(**known, kind=kind, extra=extra))
    return out


def load_gauges(path: Path | None = None) -> tuple[list[Gauge], list[Gauge]]:
    """Return ``(level_gauges, rain_gauges)`` from config/stations.yaml (fallback: built-in copy)."""
    path = path or STATIONS_YAML
    doc: Any = yaml.safe_load(path.read_text()) if path.exists() else {}
    levels = _merge(_FALLBACK_GAUGES, _yaml_entries(doc, "gauges"), "level")
    rains = _merge(_FALLBACK_RAIN, _yaml_entries(doc, "rain_gauges"), "rain")
    order = {k: i for i, k in enumerate(PRIORITY)}
    levels.sort(key=lambda g: order.get(g.key, len(order)))
    return levels, rains


def hydrology_series_key(g: Gauge) -> str:
    """Key of a gauge's Hydrology series in hourly.parquet: ``<key>``, or ``<key>_us`` for a lock whose
    Hydrology series is the u/s trace while the key stands for d/s."""
    return f"{g.key}{UPSTREAM_SUFFIX}" if g.needs_archive else g.key


def hydrology_trace(g: Gauge) -> str:
    """Trace of the Hydrology series: the key's trace, or u/s for the live-only locks."""
    return str(g.extra.get("hydrology_qualifier") or ("u/s" if g.needs_archive else g.trace))
