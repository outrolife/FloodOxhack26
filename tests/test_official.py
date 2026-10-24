"""model/official.py on synthetic warnings and trigger series (no network)."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from model import official as of

T = pd.Timestamp


def _warnings(rows: list[tuple[str, str, str, str] | tuple[str, str, str, str, str]]) -> pd.DataFrame:
    recs = []
    for r in rows:
        code, typ, at, message = r[:4]
        precision = r[4] if len(r) > 4 else "time"
        recs.append(
            {
                "area_code": code,
                "type": typ,
                "issued_at": T(at),
                "precision": precision,
                "area_name": "",
                "message": message,
            }
        )
    df = pd.DataFrame(recs)
    df["issued_at"] = df["issued_at"].astype("datetime64[ns, UTC]")
    return df


WARN = _warnings(
    [
        ("061WAF23Oxford", "alert", "2014-01-03T10:00:00Z", "Flood Alert"),
        ("061FWF23BnsyOsny", "warning", "2014-01-06T12:00:00Z", "Flood Warning"),
        ("061FWF23BnsyOsny", "warning", "2014-01-07T09:00:00Z", "Update Flood Warning"),
        ("061FWF23NwBotley", "warning", "2014-01-04T19:00:00Z", "Flood Warning"),
        ("061FWF14CherOxfd", "warning", "2014-01-05T06:00:00Z", "Flood Warning"),
        # Outside the event window
        ("061FWF23BnsyOsny", "warning", "2015-01-01T00:00:00Z", "Flood Warning"),
        # Not an Oxford code
        ("113WACT2a", "alert", "2014-01-02T00:00:00Z", "Flood Alert"),
    ]
)
START, END = T("2013-12-20T00:00:00Z"), T("2014-02-20T00:00:00Z")


def _p(values: list[float], start: str = "2014-01-02T00:00:00Z") -> pd.Series:
    idx = pd.date_range(start, periods=len(values), freq="12h", tz="UTC")
    return pd.Series(values, index=idx, dtype=float)


def test_first_official_levels() -> None:
    w = of.first_official(WARN, "osney", START, END, "warning")
    assert w is not None and w.issued_at == T("2014-01-06T12:00:00Z") and w.type == "warning"
    a = of.first_official(WARN, "osney", START, END, "alert")
    assert a is not None and a.issued_at == T("2014-01-03T10:00:00Z") and a.area_code == "061WAF23Oxford"
    assert of.first_official(WARN, "osney", START, END, "severe") is None
    assert of.first_official(WARN, "wolvercote", START, END, "warning") is None


def test_severe_counts_as_warning() -> None:
    w = _warnings(
        [
            ("061FWF233", "alert", "2007-07-20T18:31:25Z", "Flood Watch"),
            ("061FWF233", "severe", "2007-07-21T20:16:39Z", "Severe Flood Warning"),
        ]
    )
    got = of.first_official(w, "osney", "2007-07-18", "2007-08-02", "warning")
    assert got is not None and got.type == "severe" and got.issued_at == T("2007-07-21T20:16:39Z")


def test_first_trigger() -> None:
    p = _p([0.0, 0.05, 0.2, 0.35, 0.8, 0.95])
    assert of.first_trigger(p, 0.1) == T("2014-01-03T00:00:00Z")
    assert of.first_trigger(p, 0.5) == T("2014-01-04T00:00:00Z")
    assert of.first_trigger(p, 0.99) is None
    assert of.first_trigger(p, 0.1, start="2014-01-03T12:00:00Z") == T("2014-01-03T12:00:00Z")
    assert of.first_trigger(pd.Series([np.nan, np.nan], index=p.index[:2]), 0.1) is None


def test_lead_gained() -> None:
    assert of.lead_gained_h(T("2014-01-06T12:00Z"), T("2014-01-04T00:00Z")) == 60.0
    assert of.lead_gained_h(T("2014-01-03T10:00Z"), T("2014-01-04T00:00Z")) == -14.0
    assert of.lead_gained_h(None, T("2014-01-04T00:00Z")) is None
    assert of.lead_gained_h(T("2014-01-06T12:00Z"), None) is None
    # Date precision: compare UK calendar dates, whole days in hours.
    # 2007-07-20T23:30Z is 21 Jul in BST; trigger on 20 Jul -> one day.
    assert of.lead_gained_h(T("2007-07-20T23:30Z"), T("2007-07-20T08:00Z"), "date") == 24.0


def test_compare_event_rows() -> None:
    p = _p([0.0, 0.05, 0.2, 0.35, 0.8, 0.95])
    rows = of.compare_event(p, WARN, "osney", "e2014", START, END, p_stars=(0.1, 0.5, 0.99))
    assert [r["p_star"] for r in rows] == [0.1, 0.5, 0.99]
    r1, r5, r99 = rows
    assert r1["trigger_at"] == T("2014-01-03T00:00:00Z")
    assert r1["lead_vs_warning_h"] == pytest.approx(84.0)  # 06 Jan 12:00 - 03 Jan 00:00
    assert r1["lead_vs_alert_h"] == pytest.approx(10.0)  # 03 Jan 10:00 - 03 Jan 00:00
    assert r5["lead_vs_warning_h"] == pytest.approx(60.0)
    assert r99["trigger_at"] is None and r99["lead_vs_warning_h"] is None
    assert r1["warning_precision"] == "time"


def test_compare_events_and_mean() -> None:
    triggers = {
        ("e2014", "osney"): _p([0.0, 0.2, 0.6]),
        ("e2014", "botley"): _p([0.6, 0.7, 0.8]),
        ("e2014", "wolvercote"): _p([0.6, 0.7, 0.8]),  # no official warning: excluded from mean
    }
    df = of.compare_events(triggers, WARN, {"e2014": (START, END)}, p_stars=(0.5,))
    assert list(df.columns) == of.COMPARE_COLUMNS
    assert len(df) == 3
    # osney: 06 Jan 12:00 - 03 Jan 00:00 = 84 h
    assert of.mean_lead_vs_official(df, "osney", 0.5) == pytest.approx(84.0)
    # botley: 04 Jan 19:00 - 02 Jan 00:00 = 67 h
    assert of.mean_lead_vs_official(df, "botley", 0.5) == pytest.approx(67.0)
    assert of.mean_lead_vs_official(df, "wolvercote", 0.5) is None
    assert not of.any_date_precision(df)


def test_replay_official_contract() -> None:
    out = of.replay_official(WARN, ["osney", "wolvercote", "cherwell"], START, END)
    assert out == [
        {"spot": "osney", "type": "alert", "issuedAt": "2014-01-03T10:00:00Z", "precision": "time"},
        {"spot": "wolvercote", "type": "alert", "issuedAt": "2014-01-03T10:00:00Z", "precision": "time"},
        {"spot": "cherwell", "type": "warning", "issuedAt": "2014-01-05T06:00:00Z", "precision": "time"},
        {"spot": "osney", "type": "warning", "issuedAt": "2014-01-06T12:00:00Z", "precision": "time"},
    ]
    for item in out:
        assert set(item) == {"spot", "type", "issuedAt", "precision"}
        assert item["type"] in {"alert", "warning", "severe"}
    with_updates = of.replay_official(WARN, ["osney"], START, END, include_updates=True)
    assert len(with_updates) == 3


def test_trigger_series_from_forecasts() -> None:
    def fc(at: str, p_osney: list[float | None], p_cher: list[float | None]) -> dict:
        def leads(ps: list[float | None]) -> list[dict]:
            return [
                {"h": h, "q": {}, "pFlood": p, "pAmber": 0.0} for h, p in zip((1, 24, 72), ps, strict=True)
            ]

        return {
            "issuedAt": at,
            "dataAsOf": {},
            "stale": [],
            "spots": [
                {
                    "spot": "osney",
                    "levelNow": 3.0,
                    "leads": leads(p_osney),
                    "arrival": None,
                    "mode": "probability",
                },
                {
                    "spot": "cherwell",
                    "levelNow": 2.0,
                    "leads": leads(p_cher),
                    "arrival": None,
                    "mode": "timing_only",
                },
            ],
        }

    forecasts = [
        fc("2014-01-05T01:00:00Z", [0.1, 0.3, 0.4], [None] * 3),
        fc("2014-01-05T00:00:00Z", [0.0, 0.1, 0.2], [None] * 3),
    ]
    s = of.trigger_series(forecasts, "osney")
    assert list(s.index) == [T("2014-01-05T00:00:00Z"), T("2014-01-05T01:00:00Z")]
    assert list(s) == [0.2, 0.4]
    c = of.trigger_series(forecasts, "cherwell")
    assert c.isna().all() and of.first_trigger(c, 0.1) is None


def test_spot_areas_from_spots() -> None:
    areas = of.spot_areas_from_spots(
        [
            {"key": "cherwell", "warningArea": "061FWF14CherOxfd"},
            {"key": "newspot", "warningArea": "061FWF99Test"},
        ]
    )
    assert areas["cherwell"][0] == "061FWF14CherOxfd"
    assert len(areas["cherwell"]) == len(set(areas["cherwell"]))
    assert areas["newspot"] == ("061FWF99Test",)
    assert areas["osney"] == of.SPOT_AREAS["osney"]
    assert set(of.SPOT_AREAS) == {"osney", "botley", "abingdonrd", "wolvercote", "cherwell"}
