"""Travel-time analysis (SPEC §6) on synthetic hydrographs. No network, no files outside tmp_path."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from analysis import travel_times as tt

AMBER = {"farmoor": 1.30, "osney": 3.18}
UPSTREAMS = {"osney": ("farmoor",)}


def hourly_index(start: str, end: str) -> pd.DatetimeIndex:
    return pd.date_range(start, end, freq="h", tz="UTC")


def bump(index: pd.DatetimeIndex, centre: str | pd.Timestamp, amp: float,
         width_h: float = 24.0) -> np.ndarray:
    hours = (index - tt._utc(centre)) / pd.Timedelta(hours=1)
    return amp * np.exp(-0.5 * (np.asarray(hours) / width_h) ** 2)


def long_frame(levels: dict[str, pd.Series]) -> pd.DataFrame:
    """SPEC/§5.2 long format: gauge, ts_utc, kind, level_mean, level_max, rain_mm, flagged."""
    parts = []
    for gauge, s in levels.items():
        parts.append(
            pd.DataFrame(
                {
                    "gauge": gauge,
                    "ts_utc": s.index,
                    "kind": "level",
                    "level_mean": s.to_numpy(),
                    "level_max": s.to_numpy() + 0.01,
                    "rain_mm": np.nan,
                    "flagged": False,
                }
            )
        )
    return pd.concat(parts, ignore_index=True)


def shifted_pair(peaks: list[str], lag_h: float, amps: list[float], seed: int = 0) -> pd.DataFrame:
    """farmoor bumps at ``peaks``; osney the same shape ``lag_h`` later, on a different datum."""
    idx = hourly_index("2010-10-01", "2011-03-31 23:00")
    rng = np.random.default_rng(seed)
    up = 0.8 + rng.normal(0, 0.003, len(idx))
    down = 2.5 + rng.normal(0, 0.003, len(idx))
    for centre, amp in zip(peaks, amps, strict=True):
        up += bump(idx, centre, amp)
        down += bump(idx, tt._utc(centre) + pd.Timedelta(hours=lag_h), 1.0)
    return long_frame({"farmoor": pd.Series(up, idx), "osney": pd.Series(down, idx)})


def run(hourly: pd.DataFrame, named: list[dict] | None = None) -> tt.Outputs:
    return tt.run(hourly, AMBER, named or [], UPSTREAMS)


# ---------------------------------------------------------------------------------------------


def test_shifted_hydrograph_recovers_lag() -> None:
    peaks = ["2010-11-01", "2010-12-10", "2011-01-20", "2011-03-01"]
    out = run(shifted_pair(peaks, lag_h=30, amps=[0.6, 0.8, 1.0, 1.2]))

    (pair,) = out.travel_pairs
    assert pair["n"] == 4
    assert pair["tHalf"]["median"] == pytest.approx(30, abs=1)
    assert pair["tPeak"]["median"] == pytest.approx(30, abs=1)
    for ev in pair["events"]:
        assert "excluded" not in ev
        assert ev["tHalf"] == pytest.approx(30, abs=1)
    # upstream rise is measured on farmoor's own datum
    assert [ev["rise"] for ev in pair["events"]] == pytest.approx([0.6, 0.8, 1.0, 1.2], abs=0.03)
    # travel time does not depend on rise here, so the slope is ~0
    assert pair["slopeHoursPerMetre"] == pytest.approx(0, abs=2)

    (lag,) = out.lags["pairs"]
    assert lag == {"up": "farmoor", "down": "osney", "lag_lo": 30, "lag_main": 30, "lag_hi": 30,
                   "source": "events"}


def test_ambiguous_double_peak_is_excluded() -> None:
    peaks = ["2010-11-01", "2010-12-10", "2011-01-20"]
    hourly = shifted_pair(peaks, lag_h=30, amps=[0.8, 0.8, 0.8])
    # an extra flood with two equal peaks 3 days apart: one merged osney event with no dominant peak
    for gauge, shift_h in (("farmoor", 0), ("osney", 30)):
        rows = hourly["gauge"] == gauge
        idx = pd.DatetimeIndex(hourly.loc[rows, "ts_utc"])
        first = tt._utc("2011-03-01") + pd.Timedelta(hours=shift_h)
        extra = bump(idx, first, 1.0, 12) + bump(idx, first + pd.Timedelta(days=3), 1.0, 12)
        hourly.loc[rows, "level_mean"] += extra
        hourly.loc[rows, "level_max"] += extra

    (pair,) = run(hourly).travel_pairs
    by_id = {ev["eventId"]: ev for ev in pair["events"]}
    assert len(by_id) == 4
    (march,) = [ev for eid, ev in by_id.items() if eid.startswith("auto-201103")]
    assert march["excluded"].startswith("ambiguous")
    assert "prominence" in march["excluded"]
    assert pair["n"] == 3
    assert pair["tHalf"]["median"] == pytest.approx(30, abs=1)


def test_fewer_than_three_events_falls_back_to_xcorr() -> None:
    idx = hourly_index("2010-10-01", "2011-03-31 23:00")
    rng = np.random.default_rng(1)
    up = pd.Series(0.8 + rng.normal(0, 0.02, len(idx)), idx)
    up += bump(idx, "2010-11-15", 3.0) + bump(idx, "2011-02-01", 3.0)
    down = 1.5 + up.shift(20)  # osney = farmoor 20 h later, on its own datum
    hourly = long_frame({"farmoor": up, "osney": down})

    out = run(hourly)
    (pair,) = out.travel_pairs
    assert pair["n"] == 2
    (lag,) = out.lags["pairs"]
    assert lag == {"up": "farmoor", "down": "osney", "lag_lo": 14, "lag_main": 20, "lag_hi": 26,
                   "source": "xcorr"}
    assert pair["tHalf"] == {"p10": 14.0, "median": 20.0, "p90": 26.0}
    best = max(pair["xcorr"], key=lambda p: p["r"])
    assert best["lagH"] == 20 and best["r"] > 0.9
    assert [p["lagH"] for p in pair["xcorr"]] == list(range(121))


def test_out_of_range_travel_time_is_excluded() -> None:
    # osney peaks *before* farmoor: negative travel time, excluded with a reason
    out = run(shifted_pair(["2010-11-01", "2010-12-10", "2011-01-20"], lag_h=-10, amps=[1, 1, 1]))
    (pair,) = out.travel_pairs
    assert pair["n"] == 0
    assert all("outside (0, 168) h" in ev["excluded"] for ev in pair["events"])
    assert all(ev["tHalf"] is None and ev["tPeak"] is None for ev in pair["events"])


def test_lag_across_dst_night_is_in_utc() -> None:
    """SPEC §16: timestamps across 2026-10-25 00:30-02:30 UTC (UK clocks go back) behave like any other."""
    idx = hourly_index("2026-10-10", "2026-11-10")
    up = pd.Series(0.8 + bump(idx, "2026-10-24 12:00", 1.0), idx)
    down = pd.Series(2.5 + bump(idx, "2026-10-25 18:00", 1.0), idx)  # 30 h later, across 01:00 UTC
    event = tt.Event("dst", "osney", pd.Timestamp("2026-10-25", tz="UTC"),
                     pd.Timestamp("2026-10-26 12:00", tz="UTC"), 3.5, "detected")
    res = tt.match_event(up, down, "farmoor", "osney", event)
    assert res.valid
    assert res.t_peak == 30.0
    assert res.t_half == pytest.approx(30, abs=0.1)


def test_named_window_names_the_detected_event() -> None:
    hourly = shifted_pair(["2010-11-01", "2010-12-10", "2011-01-20"], lag_h=30, amps=[1, 1, 1])
    named = [
        {"id": "e2010", "start": "2010-12-01", "end": "2010-12-20"},
        {"id": "quiet", "start": "2011-03-10", "end": "2011-03-20"},  # nothing above amber: kept anyway
    ]
    (pair,) = run(hourly, named).travel_pairs
    ids = [ev["eventId"] for ev in pair["events"]]
    assert ids == ["auto-20101101", "e2010", "auto-20110120", "quiet"]
    assert pair["n"] == 3  # "quiet" has no real peak and is excluded with a reason
    assert pair["events"][3]["excluded"]


# ---------------------------------------------------------------------------------------------
# Contract shape (SPEC §9 TravelPair) and CLI
# ---------------------------------------------------------------------------------------------

QUANT = {"p10", "median", "p90"}


def assert_travel_pair(p: dict) -> None:
    assert set(p) == {"up", "down", "n", "tHalf", "tPeak", "events", "xcorr", "slopeHoursPerMetre"}
    assert isinstance(p["up"], str) and isinstance(p["down"], str)
    assert isinstance(p["n"], int) and not isinstance(p["n"], bool)
    for key in ("tHalf", "tPeak"):
        assert set(p[key]) == QUANT
        assert all(isinstance(v, int | float) for v in p[key].values())
    for ev in p["events"]:
        assert {"eventId", "tHalf", "tPeak", "rise"} <= set(ev) <= {"eventId", "tHalf", "tPeak", "rise",
                                                                    "excluded"}
        assert isinstance(ev["eventId"], str)
        assert ev["tHalf"] is None or isinstance(ev["tHalf"], int | float)
        assert ev["tPeak"] is None or isinstance(ev["tPeak"], int | float)
        assert isinstance(ev["rise"], int | float)
        assert "excluded" not in ev or isinstance(ev["excluded"], str)
    for xc in p["xcorr"]:
        assert set(xc) == {"lagH", "r"}
        assert isinstance(xc["lagH"], int) and isinstance(xc["r"], float)
    assert p["slopeHoursPerMetre"] is None or isinstance(p["slopeHoursPerMetre"], int | float)


def test_cli_writes_valid_contracts_idempotently(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tt, "UPSTREAMS", UPSTREAMS)
    hourly = shifted_pair(["2010-11-01", "2010-12-10", "2011-01-20"], lag_h=30, amps=[0.7, 1.0, 1.3])
    src = tmp_path / "hourly.parquet"
    hourly.to_parquet(src)
    out, lags, detail = tmp_path / "travel_times.json", tmp_path / "lags.json", tmp_path / "detail.json"
    args = ["--hourly", str(src), "--out", str(out), "--lags", str(lags), "--detail", str(detail),
            "--stations", str(tmp_path / "none.yaml"), "--events", str(tmp_path / "none.yaml")]

    tt.main(args)
    first = out.read_bytes(), lags.read_bytes()
    tt.main(args)
    assert (out.read_bytes(), lags.read_bytes()) == first

    pairs = json.loads(out.read_text())
    assert isinstance(pairs, list) and pairs
    for p in pairs:
        assert_travel_pair(p)
    doc = json.loads(lags.read_text())
    assert set(doc) == {"pairs"}
    for entry in doc["pairs"]:
        assert set(entry) == {"up", "down", "lag_lo", "lag_main", "lag_hi", "source"}
        assert all(isinstance(entry[k], int) for k in ("lag_lo", "lag_main", "lag_hi"))
        assert entry["lag_lo"] <= entry["lag_main"] <= entry["lag_hi"]
        assert entry["source"] in {"events", "xcorr"}


def test_fixture_matches_shape_if_present(fixtures_dir: Path) -> None:
    path = fixtures_dir / "travel_times.json"
    if not path.exists():
        pytest.skip("tests/fixtures/travel_times.json not written yet (issue #4)")
    for p in json.loads(path.read_text()):
        assert_travel_pair(p)


def test_pairs_cover_spec_flow_paths() -> None:
    pairs = tt.all_pairs()
    assert pairs[:4] == [("farmoor", "osney"), ("eynsham", "osney"), ("cassington", "osney"),
                         ("godstow", "osney")]
    assert ("osney", "iffley") in pairs and ("godstow", "newbotley") in pairs
    assert ("enslow", "kingsmill") in pairs and ("islip", "kingsmill") in pairs
    assert all(up != down for up, down in pairs)
