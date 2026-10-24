"""pipeline/clean.py on small synthetic frames (no network)."""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from pipeline import clean


def readings(values, start="2014-01-01T00:00Z", freq="15min", gauge="osney", quality="Good",
             source="hydrology") -> pd.DataFrame:
    ts = pd.date_range(start, periods=len(values), freq=freq, tz="UTC")
    return pd.DataFrame({"gauge": gauge, "ts_utc": ts, "value": np.asarray(values, float),
                         "quality": quality, "source": source, "kind": "level"})


def hourly_levels(values, start="2014-01-01T00:00Z") -> pd.DataFrame:
    """Hourly readings (one per hour) so the hourly mean equals the value."""
    return readings(values, start=start, freq="h")


# ---- step 1 ---------------------------------------------------------------------------------------

def test_quality_flag_drop() -> None:
    raw = readings([1.0, 9.9, 1.1, 8.8, 1.2, np.nan])
    raw["quality"] = ["Good", "Suspect", "Unchecked", "Rejected", "Estimated", "Missing"]
    good, n = clean.drop_bad_quality(raw)
    assert n == 3
    assert good["value"].tolist() == [1.0, 1.1, 1.2]


def test_dedupe_keeps_one_per_gauge_ts_preferring_hydrology() -> None:
    a = readings([1.0, 2.0], source="fm_archive")
    b = readings([1.5], source="hydrology")
    out, n = clean.dedupe(pd.concat([a, b, a.iloc[[1]]]))
    assert n == 2
    assert len(out) == 2
    assert out.loc[0, "value"] == 1.5 and out.loc[0, "source"] == "hydrology"


# ---- step 2 ---------------------------------------------------------------------------------------

def test_hourly_mean_max_and_rain_sum() -> None:
    lv = clean.resample_hourly(readings([1.0, 2.0, 3.0, 2.0, 5.0]), "level")
    assert lv["level_mean"].tolist() == [2.0, 5.0]
    assert lv["level_max"].tolist() == [3.0, 5.0]
    rain = readings([0.2, 0.4, 0.0, 0.2, 1.0, 1.0], gauge="256230TP")
    rh = clean.resample_hourly(rain, "rain")
    assert rh["rain_mm"].iloc[0] == pytest.approx(0.8)
    assert np.isnan(rh["rain_mm"].iloc[1])  # only 2 of 4 quarter-hours: not a trustworthy total
    assert rh["level_mean"].isna().all()


def test_clock_change_one_row_per_utc_hour() -> None:
    """UK clocks go back 02:00 BST -> 01:00 GMT on 25 Oct 2026 (01:00 UTC). Storage stays UTC."""
    ts = pd.date_range("2026-10-25T00:30Z", "2026-10-25T02:30Z", freq="15min", tz="UTC")
    raw = pd.DataFrame({"gauge": "osney", "ts_utc": ts, "value": np.arange(len(ts), dtype=float),
                        "quality": "Good", "source": "hydrology"})
    out = clean.resample_hourly(raw, "level")
    expected = pd.DatetimeIndex(["2026-10-25T00:00Z", "2026-10-25T01:00Z", "2026-10-25T02:00Z"])
    assert list(out.index) == list(expected)
    assert str(out.index.tz) == "UTC"
    assert not out.index.duplicated().any()

    # The same instants given in Europe/London local time (01:xx occurs twice) map to the same rows.
    local = raw.assign(ts_utc=raw["ts_utc"].dt.tz_convert("Europe/London"))
    out_local = clean.resample_hourly(local, "level")
    pd.testing.assert_frame_equal(out, out_local)

    hourly, _ = clean.clean_series(raw, "level")
    assert len(hourly) == 3
    assert hourly["ts_utc"].is_unique


# ---- step 3 ---------------------------------------------------------------------------------------

def test_gap_fill_up_to_2h_and_flag_longer() -> None:
    vals = [1.0, np.nan, np.nan, 1.3, np.nan, np.nan, np.nan, 1.6, 1.7]
    h = clean.resample_hourly(hourly_levels(vals).dropna(), "level")
    out, n_filled, n_flagged = clean.fill_short_gaps(h, "level")
    assert (n_filled, n_flagged) == (1, 1)
    assert out["level_mean"].iloc[1:3].tolist() == [1.0, 1.0]
    assert out["filled"].tolist() == [False, True, True, False, False, False, False, False, False]
    assert out["flagged"].tolist() == [False, False, False, False, True, True, True, False, False]
    assert out["level_mean"].iloc[4:7].isna().all()


def test_rain_is_never_forward_filled() -> None:
    h = pd.DataFrame({"level_mean": np.nan, "level_max": np.nan, "rain_mm": [1.0, np.nan, 2.0]},
                     index=pd.date_range("2020-01-01", periods=3, freq="h", tz="UTC"))
    out, n_filled, _ = clean.fill_short_gaps(h, "rain")
    assert n_filled == 0 and np.isnan(out["rain_mm"].iloc[1])


# ---- step 4 ---------------------------------------------------------------------------------------

def test_spike_removed_and_counted() -> None:
    vals = [2.0, 2.01, 2.9, 2.95, 2.02, 2.03, 2.04]
    h = clean.resample_hourly(hourly_levels(vals), "level")
    h, *_ = clean.fill_short_gaps(h, "level")
    out, n = clean.remove_spikes(h)
    assert n == 1
    assert out["level_mean"].iloc[2:4].isna().all()
    assert out["flagged"].tolist() == [False, False, True, True, False, False, False]
    assert out["level_mean"].iloc[4] == pytest.approx(2.02)


def test_real_rise_is_not_a_spike() -> None:
    """A big rise that stays up (a flood, or a step) is not removed."""
    vals = [2.0, 2.6, 3.2, 3.3, 3.35, 3.4, 3.3]
    h = clean.resample_hourly(hourly_levels(vals), "level")
    h, *_ = clean.fill_short_gaps(h, "level")
    out, n = clean.remove_spikes(h)
    assert n == 0 and out["level_mean"].notna().all()


def test_single_sample_spike_in_hourly_max() -> None:
    """A one-reading spike barely moves the hourly mean but is caught on the hourly max."""
    vals = [2.0] * 4 + [2.0, 2.0, 2.0, 4.0] + [2.0] * 8
    h = clean.resample_hourly(readings(vals), "level")
    h, *_ = clean.fill_short_gaps(h, "level")
    out, n = clean.remove_spikes(h)
    assert n == 1
    assert np.isnan(out["level_max"].iloc[1]) and out["flagged"].iloc[1]


def test_level_shift_logged_not_corrected() -> None:
    idx = pd.date_range("2015-01-01", periods=24 * 20, freq="h", tz="UTC")
    rng = np.random.default_rng(0)
    level = pd.Series(1.0 + rng.normal(0, 0.01, len(idx)), index=idx)
    level.iloc[24 * 10:] += 0.6  # datum change: instantaneous and permanent
    shifts = clean.detect_level_shifts(level)
    assert len(shifts) == 1
    assert shifts[0]["ts_utc"] == idx[24 * 10].isoformat()
    assert shifts[0]["step_m"] == pytest.approx(0.6, abs=0.05)
    raw = readings(level.to_numpy(), start="2015-01-01T00:00Z", freq="h")
    hourly, stats = clean.clean_series(raw, "level")
    assert len(stats["level_shifts"]) == 1
    assert hourly["level_mean"].iloc[-1] > 1.5  # not corrected


def test_gradual_flood_rise_is_not_a_level_shift() -> None:
    idx = pd.date_range("2015-01-01", periods=24 * 20, freq="h", tz="UTC")
    level = pd.Series(1.0, index=idx)
    level.iloc[24 * 10:24 * 10 + 48] = np.linspace(1.0, 2.0, 48)
    level.iloc[24 * 10 + 48:] = 2.0
    assert clean.detect_level_shifts(level) == []


# ---- end to end -----------------------------------------------------------------------------------

def test_clean_series_schema_and_catchment() -> None:
    lv, _ = clean.clean_series(readings([1.0] * 8), "level")
    assert list(lv.columns) == clean.HOURLY_COLUMNS
    assert str(lv["ts_utc"].dt.tz) == "UTC"
    r1 = readings([0.25] * 8, gauge="256230TP").assign(kind="rain")
    r2 = readings([0.5] * 4, gauge="254336TP").assign(kind="rain")
    h1, _ = clean.clean_series(r1, "rain")
    h2, _ = clean.clean_series(r2, "rain")
    cat, st = clean.rain_catchment(pd.concat([h1, h2]))
    assert cat["rain_mm"].tolist() == [pytest.approx(1.5), pytest.approx(1.0)]
    assert st["gauges_used"] == ["254336TP", "256230TP"]
    assert (cat["gauge"] == "rain_catchment").all() and (cat["kind"] == "rain").all()


def test_load_hourly_roundtrip(tmp_path) -> None:
    lv, _ = clean.clean_series(readings([1.0] * 8), "level")
    p = tmp_path / "hourly.parquet"
    lv.to_parquet(p, index=False)
    back = clean.load_hourly(p)
    assert str(back["ts_utc"].dt.tz) == "UTC"
    assert len(back) == 2
