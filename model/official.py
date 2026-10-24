"""Compare River Clock triggers with official EA flood warnings (SPEC §8.2 "Versus official warnings").

Pure functions, no I/O: ``model/backtest.py`` loads ``data/processed/warnings.parquet``
(from ``pipeline/ingest_warnings.py``) and its own replay forecasts, then calls these.

Terms
- **trigger series**: for one spot, the forecast flood probability per issue time, i.e. a
  ``pd.Series`` indexed by UTC issue time. We use the max ``pFlood`` over all leads (0-72 h), which
  equals the 72 h value because ``pFlood`` is made non-decreasing in lead (SPEC §7.5 step 4).
- **first trigger** at p*: the first issue time in the event window with ``p >= p*``.
- **first official** at a level: the first EA message in the spot's areas at or above that level
  (alert < warning < severe), issued in the event window.
- **lead gained** = official issue time - our first trigger time, in hours. Positive means we
  were earlier than the EA. With date-only official times, both sides are compared as UK
  calendar dates and the result is whole days x 24, with ``precision = "date"``.

Issue #13.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd

P_STARS: tuple[float, ...] = (0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9)
LEVEL_RANK: dict[str, int] = {"alert": 0, "warning": 1, "severe": 2}
LOCAL_TZ = "Europe/London"

# EA target areas per spot (codes verified in the July 2026 Historic Flood Warnings release).
# Each spot gets its warning area, the alert area that covers it and the 2006-08 legacy reach
# codes, so that e2007 has official messages too. Message type comes from the message, not the
# code (legacy codes carried both "Flood Watch" and warnings).
THAMES_OXFORD_ALERT = "061WAF23Oxford"
THAMES_LEGACY = "061FWF233"  # Thames from Eynsham Lock to Sandford Lock, 2006-08
SPOT_AREAS: dict[str, tuple[str, ...]] = {
    "osney": ("061FWF23BnsyOsny", THAMES_OXFORD_ALERT, THAMES_LEGACY),
    "botley": ("061FWF23NwBotley", THAMES_OXFORD_ALERT, THAMES_LEGACY),
    "abingdonrd": ("061FWF23NwBotley", THAMES_OXFORD_ALERT, THAMES_LEGACY),
    "wolvercote": ("061FWF23Wlvrcote", THAMES_OXFORD_ALERT, THAMES_LEGACY),
    "cherwell": ("061FWF14CherOxfd", "061WAF14LChrwell", "061FWF142", "061WAFW06"),
}


@dataclass(frozen=True)
class OfficialIssue:
    issued_at: pd.Timestamp
    type: str
    precision: str
    area_code: str


# --------------------------------------------------------------------------- helpers


def iso(ts: pd.Timestamp) -> str:
    """ISO 8601 UTC with a trailing Z, to the second (the §9 format)."""
    return _utc(ts).strftime("%Y-%m-%dT%H:%M:%SZ")


def _utc(ts: Any) -> pd.Timestamp:
    t = pd.Timestamp(ts)
    return t.tz_localize("UTC") if t.tzinfo is None else t.tz_convert("UTC")


def spot_areas_from_spots(
    spots: Iterable[Mapping[str, Any]], defaults: Mapping[str, Sequence[str]] = SPOT_AREAS
) -> dict[str, tuple[str, ...]]:
    """Area codes per spot: each spot's ``warningArea`` (spots.json / spots.yaml) first, then defaults."""
    out = {k: tuple(v) for k, v in defaults.items()}
    for spot in spots:
        key = str(spot["key"])
        codes = [str(spot["warningArea"])] if spot.get("warningArea") else []
        codes += [c for c in out.get(key, ()) if c not in codes]
        out[key] = tuple(codes)
    return out


def _window(
    warnings: pd.DataFrame,
    codes: Sequence[str],
    start: Any,
    end: Any,
    include_updates: bool = True,
) -> pd.DataFrame:
    w = warnings[warnings["area_code"].isin(list(codes))]
    w = w[(w["issued_at"] >= _utc(start)) & (w["issued_at"] <= _utc(end))]
    if not include_updates and "message" in w.columns:
        w = w[~w["message"].str.lower().str.startswith("update")]
    return w.sort_values("issued_at", kind="stable")


# --------------------------------------------------------------------------- official side


def first_official(
    warnings: pd.DataFrame,
    spot: str,
    start: Any,
    end: Any,
    level: str = "warning",
    spot_areas: Mapping[str, Sequence[str]] = SPOT_AREAS,
) -> OfficialIssue | None:
    """First official message for ``spot`` at or above ``level``, issued within [start, end]."""
    w = _window(warnings, spot_areas.get(spot, ()), start, end)
    w = w[w["type"].map(LEVEL_RANK).fillna(-1) >= LEVEL_RANK[level]]
    if w.empty:
        return None
    row = w.iloc[0]
    return OfficialIssue(
        issued_at=_utc(row["issued_at"]),
        type=str(row["type"]),
        precision=str(row.get("precision", "time")),
        area_code=str(row["area_code"]),
    )


def replay_official(
    warnings: pd.DataFrame,
    spots: Iterable[str],
    start: Any,
    end: Any,
    spot_areas: Mapping[str, Sequence[str]] = SPOT_AREAS,
    include_updates: bool = False,
) -> list[dict[str, str]]:
    """The ``official`` array of a §9 Replay: every official message per spot in [start, end].

    ``Update ...`` messages are left out by default (they repeat a message already in force).
    One entry per (spot, type, issuedAt), sorted by time then spot.
    """
    rows: list[dict[str, str]] = []
    seen: set[tuple[str, str, str]] = set()
    for spot in spots:
        for _, r in _window(warnings, spot_areas.get(spot, ()), start, end, include_updates).iterrows():
            item = {
                "spot": spot,
                "type": str(r["type"]),
                "issuedAt": iso(r["issued_at"]),
                "precision": str(r.get("precision", "time")),
            }
            key = (item["spot"], item["type"], item["issuedAt"])
            if key not in seen:
                seen.add(key)
                rows.append(item)
    return sorted(rows, key=lambda d: (d["issuedAt"], d["spot"], LEVEL_RANK[d["type"]]))


# --------------------------------------------------------------------------- our side


def trigger_series(forecasts: Iterable[Mapping[str, Any]], spot: str) -> pd.Series:
    """Max ``pFlood`` over leads per issue time for ``spot``, from §9 ``Forecast`` dicts.

    ``timing_only`` spots (``pFlood`` null) give NaN, so they never trigger.
    """
    times: list[pd.Timestamp] = []
    values: list[float] = []
    for fc in forecasts:
        for sf in fc["spots"]:
            if sf["spot"] != spot:
                continue
            ps = [ld["pFlood"] for ld in sf["leads"] if ld.get("pFlood") is not None]
            times.append(_utc(fc["issuedAt"]))
            values.append(max(ps) if ps else np.nan)
    s = pd.Series(values, index=pd.DatetimeIndex(times, name="issued_at"), dtype=float, name=spot)
    return s.sort_index()


def first_trigger(p: pd.Series, p_star: float, start: Any = None, end: Any = None) -> pd.Timestamp | None:
    """First issue time with ``p >= p_star`` (within [start, end] if given)."""
    s = p.sort_index()
    if start is not None:
        s = s[s.index >= _utc(start)]
    if end is not None:
        s = s[s.index <= _utc(end)]
    hit = s[s >= p_star]
    return None if hit.empty else _utc(hit.index[0])


def lead_gained_h(
    official_at: pd.Timestamp | None, trigger_at: pd.Timestamp | None, precision: str = "time"
) -> float | None:
    """Official issue time minus our first trigger time, in hours (positive: we were earlier)."""
    if official_at is None or trigger_at is None:
        return None
    if precision == "date":
        d_off = _utc(official_at).tz_convert(LOCAL_TZ).normalize().tz_localize(None)
        d_trig = _utc(trigger_at).tz_convert(LOCAL_TZ).normalize().tz_localize(None)
        return float((d_off - d_trig).days * 24)
    return round((_utc(official_at) - _utc(trigger_at)).total_seconds() / 3600, 2)


# --------------------------------------------------------------------------- comparison


def compare_event(
    p: pd.Series,
    warnings: pd.DataFrame,
    spot: str,
    event_id: str,
    start: Any,
    end: Any,
    p_stars: Sequence[float] = P_STARS,
    spot_areas: Mapping[str, Sequence[str]] = SPOT_AREAS,
) -> list[dict[str, Any]]:
    """One row per p*: our first trigger and lead gained vs the first EA warning and alert.

    Both our trigger and the official messages are taken from the same window [start, end].
    Times are pandas UTC Timestamps (or None); leads are hours (or None).
    """
    warn = first_official(warnings, spot, start, end, "warning", spot_areas)
    alert = first_official(warnings, spot, start, end, "alert", spot_areas)
    rows = []
    for p_star in p_stars:
        trig = first_trigger(p, p_star, start, end)
        rows.append(
            {
                "event_id": event_id,
                "spot": spot,
                "p_star": float(p_star),
                "trigger_at": trig,
                "warning_at": warn.issued_at if warn else None,
                "warning_type": warn.type if warn else None,
                "warning_precision": warn.precision if warn else None,
                "lead_vs_warning_h": lead_gained_h(
                    warn.issued_at if warn else None, trig, warn.precision if warn else "time"
                ),
                "alert_at": alert.issued_at if alert else None,
                "alert_type": alert.type if alert else None,
                "alert_precision": alert.precision if alert else None,
                "lead_vs_alert_h": lead_gained_h(
                    alert.issued_at if alert else None, trig, alert.precision if alert else "time"
                ),
            }
        )
    return rows


COMPARE_COLUMNS = [
    "event_id",
    "spot",
    "p_star",
    "trigger_at",
    "warning_at",
    "warning_type",
    "warning_precision",
    "lead_vs_warning_h",
    "alert_at",
    "alert_type",
    "alert_precision",
    "lead_vs_alert_h",
]


def compare_events(
    triggers: Mapping[tuple[str, str], pd.Series],
    warnings: pd.DataFrame,
    events: Mapping[str, tuple[Any, Any]],
    p_stars: Sequence[float] = P_STARS,
    spot_areas: Mapping[str, Sequence[str]] = SPOT_AREAS,
) -> pd.DataFrame:
    """``compare_event`` for every (event_id, spot) in ``triggers``; ``events`` maps id -> (start, end)."""
    rows: list[dict[str, Any]] = []
    for (event_id, spot), p in triggers.items():
        start, end = events[event_id]
        rows += compare_event(p, warnings, spot, event_id, start, end, p_stars, spot_areas)
    return pd.DataFrame(rows, columns=COMPARE_COLUMNS)


def mean_lead_vs_official(
    comparison: pd.DataFrame, spot: str, p_star: float, against: str = "warning"
) -> float | None:
    """Mean lead gained over events for one spot and p* (``Proof.tradeoff[].meanLeadVsOfficialH``).

    Only events where both a trigger and an official message exist count; None if there are none.
    """
    col = f"lead_vs_{against}_h"
    sel = comparison[(comparison["spot"] == spot) & np.isclose(comparison["p_star"], p_star)][col]
    sel = pd.to_numeric(sel, errors="coerce").dropna()
    return None if sel.empty else round(float(sel.mean()), 2)


def any_date_precision(comparison: pd.DataFrame) -> bool:
    """True if any compared official time was date-only, so the UI must say so (SPEC §8.2)."""
    cols = ["warning_precision", "alert_precision"]
    return bool(comparison[cols].eq("date").any().any())
