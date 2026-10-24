"""Hand-checkable tests for model/metrics.py (SPEC §8.2)."""

from __future__ import annotations

import math

import numpy as np
import pandas as pd
import pytest

from model import metrics as m

T0 = pd.Timestamp("2014-01-01T00:00:00Z")


def hrs(*h: float) -> list[pd.Timestamp]:
    return [T0 + pd.Timedelta(hours=x) for x in h]


def series(values: dict[float, float]) -> pd.Series:
    return pd.Series(list(values.values()), index=pd.DatetimeIndex(hrs(*values.keys())), dtype=float)


# --------------------------------------------------------------------------- pinball, skill, coverage


def test_pinball_single_quantile_by_hand():
    # y = 1, q = 0: under-forecast by 1 -> loss = a * 1
    assert m.pinball_loss(np.array([[0.0]]), np.array([1.0]), alphas=[0.9]) == pytest.approx(0.9)
    # y = 0, q = 1: over-forecast by 1 -> loss = (1 - a) * 1
    assert m.pinball_loss(np.array([[1.0]]), np.array([0.0]), alphas=[0.9]) == pytest.approx(0.1)


def test_pinball_mean_over_alphas_and_rows():
    # all seven quantiles at 0, y = 2: loss per alpha = 2a, mean = 2 * mean(alphas) = 2 * 0.5 = 1.0
    q = np.zeros((1, 7))
    assert m.pinball_loss(q, np.array([2.0])) == pytest.approx(1.0)
    # a perfect row (all quantiles = y) adds 0, so the mean over two rows halves it
    q2 = np.vstack([q, np.full((1, 7), 5.0)])
    assert m.pinball_loss(q2, np.array([2.0, 5.0])) == pytest.approx(0.5)


def test_pinball_skips_nan_rows():
    q = np.array([[0.0] * 7, [np.nan] * 7])
    assert m.pinball_loss(q, np.array([2.0, 3.0])) == pytest.approx(1.0)
    assert math.isnan(m.pinball_loss(q[1:], np.array([3.0])))


def test_skill():
    assert m.skill(0.5, 1.0) == pytest.approx(0.5)
    assert m.skill(2.0, 1.0) == pytest.approx(-1.0)
    assert math.isnan(m.skill(1.0, 0.0))


def test_skill_by_lead_rows():
    y = {6: np.array([2.0])}
    rows = m.skill_by_lead({6: np.full((1, 7), 2.0)}, {6: np.zeros((1, 7))}, y)
    assert rows == [{"h": 6, "pinballModel": 0.0, "pinballPersistence": 1.0, "skill": 1.0}]


def test_interval_coverage_by_hand():
    q = np.array([[-3, -2, -1, 0, 1, 2, 3]] * 4, dtype=float)
    y = np.array([0.5, 1.0, 1.5, 2.5])  # inside 50%: 0.5, 1.0 (bound); 80%: + 1.5; 90%: + 2.5
    cov = m.interval_coverage(q, y)
    assert cov == {0.5: 0.5, 0.8: 0.75, 0.9: 1.0}
    rows = m.coverage_by_lead({12: q}, {12: y})
    assert [(r["h"], r["nominal"], r["actual"]) for r in rows] == [
        (12, 0.5, 0.5),
        (12, 0.8, 0.75),
        (12, 0.9, 1.0),
    ]


# --------------------------------------------------------------------------- Brier and reliability


def test_brier_by_hand():
    assert m.brier_score(np.array([1.0, 0.0]), np.array([1.0, 0.0])) == 0.0
    assert m.brier_score(np.array([0.5, 0.5]), np.array([1.0, 0.0])) == pytest.approx(0.25)
    assert m.brier_score(np.array([0.2, np.nan]), np.array([0.0, 1.0])) == pytest.approx(0.04)


def test_reliability_bins_drop_empty_and_put_one_in_top_bin():
    p = np.array([0.05, 0.05, 0.95, 1.0])
    o = np.array([0.0, 1.0, 1.0, 1.0])
    bins = m.reliability_bins(p, o)
    assert bins == [{"pPred": 0.05, "pObs": 0.5, "n": 2}, {"pPred": 0.975, "pObs": 1.0, "n": 2}]
    assert all(b["n"] > 0 for b in bins)


def test_exceedance_outcome_and_reliability_entry():
    o = m.exceedance_outcome(np.array([2.7, 2.76, 2.9, np.nan]), 2.76)
    assert np.array_equal(o[:3], [0.0, 1.0, 1.0]) and np.isnan(o[3])
    e = m.reliability_entry(24, np.array([0.0, 1.0, 1.0, 0.3]), np.array([0.5, 0.5, 0.5, 0.5]), o)
    assert e["h"] == 24 and e["brier"] == 0.0 and e["brierPersistence"] == 0.25  # NaN row dropped
    assert sum(b["n"] for b in e["bins"]) == 3


def test_max_level_ahead_covers_t_plus_1_to_t_plus_h_only():
    # Hourly levels 0, 1, ..., 9 at T0 + 0 h ... T0 + 9 h, with hour 5 missing.
    lv = series({h: float(h) for h in range(10) if h != 5})
    idx = pd.DatetimeIndex(hrs(0, 3, 4, 8, 9))
    # (t, t + 2]: t=0 -> max(1, 2); t=3 -> max(4, [5 missing]) = 4; t=4 -> max([5], 6) = 6;
    # t=8 -> 9 (hour 10 not observed); t=9 -> nothing observed after it.
    out = m.max_level_ahead(lv, idx, 2)
    assert out[:4].tolist() == [2.0, 4.0, 6.0, 9.0] and np.isnan(out[4])
    # The level at t itself never counts (that is level_now).
    assert m.max_level_ahead(series({0: 5.0, 1: 1.0, 2: 1.0}), pd.DatetimeIndex(hrs(0)), 2)[0] == 1.0


def test_reliability_outcome_is_by_t_plus_h_and_skips_already_flooded():
    """#91: pFlood_h is non-decreasing in h ("over the line by t + h"), so a flood that peaks at
    t + 6 h and has gone down by t + 72 h is an outcome of 1 at 72 h, not 0. Hours already over the
    line are left out, as in the event scores."""
    line = 2.0
    level_now = np.array([1.5, 2.1, 1.5, 1.5])
    at_72 = np.array([1.6, 1.0, 1.6, np.nan])  # all back below the line at t + 72 h (last unobserved)
    peak = np.array([2.5, 2.5, 1.9, 2.5])  # row 0 peaked over the line in between; row 2 never did
    o = m.exceedance_by_outcome(level_now, at_72, peak, line)
    assert o[0] == 1.0 and o[2] == 0.0
    assert np.isnan(o[1]) and np.isnan(o[3])  # already flooded; level at t + h missing
    # The old "at t + h" outcome scored row 0 as 0: a p of 1 looked like an over-confident miss.
    assert m.exceedance_outcome(at_72[:1], line)[0] == 0.0
    e = m.reliability_entry(72, np.array([1.0, 1.0, 0.0, 1.0]), np.array([0.5] * 4), o)
    assert e["brier"] == 0.0 and sum(b["n"] for b in e["bins"]) == 2


# --------------------------------------------------------------------------- triggers, episodes, outcomes


def test_episodes_split_at_24h():
    eps = m.episodes(hrs(0, 1, 2, 25, 50, 73.5))
    # 2 -> 25 is 23 h (same episode); 25 -> 50 is 25 h (new); 50 -> 73.5 is 23.5 h (same)
    assert eps == [(hrs(0)[0], hrs(25)[0]), (hrs(50)[0], hrs(73.5)[0])]
    assert m.episodes(hrs(0, 24)) == [(hrs(0)[0], hrs(0)[0]), (hrs(24)[0], hrs(24)[0])]


def test_trigger_times_threshold_inclusive_and_nan():
    p = series({0: 0.4, 1: 0.5, 2: np.nan, 3: 0.7})
    assert list(m.trigger_times(p, 0.5)) == hrs(1, 3)


def test_hit_lead_is_from_first_trigger_within_72h():
    crossing = hrs(100)
    # trigger at 20 h is 80 h early (outside the window); first in-window trigger is at 40 h -> lead 60 h
    res = m.event_outcomes(hrs(20, 40, 41, 99), crossing)
    assert (res["hits"], res["misses"]) == (1, 0)
    assert res["leads"] == [60.0]
    # 20 h and 40 h are < 24 h apart, so one episode, and it precedes the crossing: no false alarm
    assert res["falseAlarms"] == 0


def test_miss_when_trigger_only_at_or_after_crossing():
    res = m.event_outcomes(hrs(100, 101), hrs(100))
    assert (res["hits"], res["misses"], res["falseAlarms"]) == (0, 1, 0)
    assert res["leads"] == []


def test_false_alarm_episode_far_from_crossing():
    # episode A at 0-2 h, crossing at 200 h (> 72 h after A) -> A is a false alarm; episode B hits
    res = m.event_outcomes(hrs(0, 1, 2, 150, 151), hrs(200))
    assert (res["hits"], res["misses"], res["falseAlarms"]) == (1, 0, 1)
    assert res["leads"] == [50.0]


def test_no_crossing_every_episode_is_false_alarm():
    res = m.event_outcomes(hrs(0, 30, 31), [])
    assert (res["hits"], res["misses"], res["falseAlarms"]) == (0, 0, 2)


def test_crossing_exactly_72h_after_trigger_is_hit():
    res = m.event_outcomes(hrs(0), hrs(72))
    assert (res["hits"], res["falseAlarms"], res["leads"]) == (1, 0, [72.0])


def test_tradeoff_rows_sum_over_events_with_ci():
    p_a = series({0: 0.2, 10: 0.6, 20: 0.9})  # crossing at 30 h
    p_b = series({0: 0.3})  # no crossing
    rows = m.tradeoff_rows(
        {"a": p_a, "b": p_b},
        {"a": hrs(30), "b": []},
        p_stars=[0.1, 0.5, 0.95],
        lead_vs_official=lambda ps: 12.0 if ps == 0.5 else None,
    )
    r01, r05, r95 = rows
    assert (r01["hits"], r01["misses"], r01["falseAlarms"], r01["meanLeadH"]) == (1, 0, 1, 30.0)
    assert (r05["hits"], r05["falseAlarms"], r05["meanLeadH"], r05["meanLeadVsOfficialH"]) == (
        1,
        0,
        20.0,
        12.0,
    )
    assert (r95["hits"], r95["misses"], r95["meanLeadH"]) == (0, 1, None)
    assert "ci90" not in r95
    assert r05["ci90"] == [20.0, 20.0]  # only one event has hits: every finite resample gives 20 h


def test_official_outcome_uses_same_rules():
    off = {"a": hrs(10), "b": hrs(0)}
    out = m.official_outcome(off, {"a": hrs(30), "b": [], "c": hrs(5)})
    assert out == {"hits": 1, "misses": 1, "falseAlarms": 1, "meanLeadH": 20.0}


def test_in_force_times_hold_until_24h_after_last_update():
    grid = hrs(*range(0, 200))
    # Fresh warning at 0 h, Update at 89 h, fresh warning at 150 h (no update), event ends at 160 h.
    t = m.in_force_times([(T0, False), (hrs(89)[0], True), (hrs(150)[0], False)], grid, end=hrs(160)[0])
    assert t[0] == T0 and hrs(113)[0] in t and hrs(114)[0] not in t  # 89 + 24
    assert hrs(149)[0] not in t and t[-1] == hrs(160)[0]  # second warning capped at the event end
    # Only grid times count (hours over the line are not on the grid).
    assert m.in_force_times([(T0, False)], hrs(5, 30)).tolist() == hrs(5)


def test_early_official_warning_in_force_is_a_hit_not_miss_plus_false_alarm():
    """#92, the e2024b Botley case: Flood Warning 85 h before the crossing, Update just before it."""
    grid = hrs(*range(0, 120))
    msgs = [(T0, False), (hrs(84)[0], True)]
    crossing = {"e": hrs(85)}
    old = m.official_outcome({"e": [T0]}, crossing)  # the warning as a single issue time
    assert (old["hits"], old["misses"], old["falseAlarms"]) == (0, 1, 1)
    new = m.official_outcome({"e": m.in_force_times(msgs, grid)}, crossing)
    assert new == {"hits": 1, "misses": 0, "falseAlarms": 0, "meanLeadH": 72.0}  # lead capped at 72 h


def test_default_p_stars_include_decide_presets():
    assert m.P_STARS[:3] == (0.01, 0.02, 0.05)
    assert m.P_STARS[3:] == tuple(round(0.1 * i, 1) for i in range(1, 10))


# --------------------------------------------------------------------------- replay helpers


def _fc(hour: float, p72: float | None, p50_hour: float | None, q50: float = 2.0) -> dict:
    lead = {
        "h": 6,
        "q": {k: q50 + (i - 3) * 0.1 for i, k in enumerate(m.QUANT_KEYS)},
        "pFlood": p72,
        "pAmber": 0.9,
    }
    arrival = (
        None
        if p50_hour is None
        else {"p10": None, "p50": hrs(p50_hour)[0].strftime("%Y-%m-%dT%H:%M:%SZ"), "p90": None}
    )
    return {
        "issuedAt": hrs(hour)[0].strftime("%Y-%m-%dT%H:%M:%SZ"),
        "dataAsOf": {},
        "stale": [],
        "spots": [
            {"spot": "botley", "levelNow": 2.0, "leads": [lead], "arrival": arrival, "mode": "probability"}
        ],
    }


def test_spot_probability_and_arrival_error():
    fcs = [_fc(52, 0.2, 110), _fc(76, 0.6, 95), _fc(77, None, None)]
    p = m.spot_probability(fcs, "botley")
    assert list(p.index) == hrs(52, 76, 77) and p.iloc[1] == 0.6 and np.isnan(p.iloc[2])
    # crossing at 100 h: issued at 76 h (24 h before) said 95 h -> -5 h; at 52 h (48 h) said 110 h -> +10
    assert m.arrival_error_h(fcs, "botley", hrs(100)[0], 24) == -5.0
    assert m.arrival_error_h(fcs, "botley", hrs(100)[0], 48) == 10.0
    assert m.arrival_error_h(fcs, "botley", hrs(101)[0], 24) is None  # forecast at 77 h has no arrival
    assert m.arrival_error_h(fcs, "botley", hrs(200)[0], 24) is None  # no forecast issued then
    assert m.arrival_errors(fcs, "botley", hrs(100)) == {24: [-5.0], 48: [10.0]}


def test_replay_pairs_use_observation_at_t_plus_h_only():
    replay = {
        "observed": {
            "newbotley": [
                {"t": hrs(h)[0].strftime("%Y-%m-%dT%H:%M:%SZ"), "level": 2.0 + h / 100} for h in range(0, 20)
            ]
        },
        "forecasts": [_fc(0, 0.1, None), _fc(1, 0.2, None), _fc(15, 0.3, None)],
    }
    df = m.replay_pairs(replay, "botley", "newbotley", 6)
    assert list(df["obs"].iloc[:2]) == [2.06, 2.07]
    assert np.isnan(df["obs"].iloc[2])  # t + 6 = 21 h is not observed
    assert df["q50"].iloc[0] == pytest.approx(2.0)
    assert m.replay_pairs(replay, "botley", "newbotley", 72).empty


# --------------------------------------------------------------------------- bootstrap


def test_bootstrap_is_deterministic_and_brackets_the_mean():
    groups = [[10.0], [20.0], [30.0], [40.0], [50.0]]
    ci1 = m.bootstrap_ci(groups)
    ci2 = m.bootstrap_ci(groups)
    assert ci1 == ci2
    assert ci1 is not None and 10.0 <= ci1[0] < 30.0 < ci1[1] <= 50.0


def test_bootstrap_undefined_and_constant():
    assert m.bootstrap_ci([[], []]) is None
    assert m.bootstrap_ci([]) is None
    assert m.bootstrap_ci([[5.0], [5.0], []]) == (5.0, 5.0)


def test_pooled_mean_weights_by_hit_not_event():
    assert m.pooled_mean([[10.0, 20.0, 30.0], [60.0]]) == pytest.approx(30.0)


def test_flood_onsets_merge_repeat_crossings():
    # 0 h starts a flood; 3, 20, 80 h each follow the previous crossing by < 72 h (same flood);
    # 200 h is 120 h after 80 h, so a new flood
    assert m.flood_onsets(hrs(20, 0, 3, 80, 200)) == hrs(0, 200)
    assert m.flood_onsets([]) == []


def test_spot_probability_ignores_times_already_above_threshold():
    fcs = [_fc(0, 0.9, None), _fc(1, 0.9, None)]
    fcs[1]["spots"][0]["levelNow"] = 2.8
    p = m.spot_probability(fcs, "botley", threshold=2.76)
    assert p.iloc[0] == 0.9 and np.isnan(p.iloc[1])


def test_arrival_error_uses_latest_forecast_within_tolerance():
    fcs = [_fc(74, 0.6, 96), _fc(75, 0.6, 99)]
    # crossing at 100 h; nothing issued at 76 h, so the 75 h forecast (1 h earlier) is used: 99 - 100
    assert m.arrival_error_h(fcs, "botley", hrs(100)[0], 24) == -1.0
    assert m.arrival_error_h(fcs, "botley", hrs(101)[0], 24) is None  # 77 h: 75 h is 2 h early


# --------------------------------------------------------------------------- warn-at levels (#134)

CUTOFF = pd.Timestamp("2021-10-01T00:00:00Z")  # test period start
T_TEST = pd.Timestamp("2024-01-01T00:00:00Z")


def hourly_p(t0: pd.Timestamp, n: int, p_of_hour) -> pd.Series:
    idx = pd.DatetimeIndex([t0 + pd.Timedelta(hours=h) for h in range(n)])
    return pd.Series([float(p_of_hour(h)) for h in range(n)], index=idx, dtype=float)


def _validation_event(spikes: float = 0.35):
    """Crossing at 200 h, p = 0.6 from 150 h (a hit at every p* <= 0.6). Two short spikes to ``spikes``
    at 20 h and 60 h, more than 72 h before the crossing and 40 h apart: two false alarms at p* below
    the spike, none above it."""
    p = hourly_p(T0, 300, lambda h: 0.6 if 150 <= h < 200 else spikes if h in (20, 60) else 0.0)
    return p, [T0 + pd.Timedelta(hours=200)]


def _test_event(kind: str):
    if kind == "quiet":
        return hourly_p(T_TEST, 300, lambda h: 0.0), []
    if kind == "spiky":  # a false alarm at every p* (would push any rule that saw it up to 0.9)
        return hourly_p(T_TEST, 300, lambda h: 0.95 if h % 50 == 0 else 0.0), []
    # "flood": crossing at 100 h, p = 0.15 from 30 h (rewards a very low p* if it were looked at)
    flood = hourly_p(T_TEST, 300, lambda h: 0.15 if 30 <= h < 100 else 0.0)
    return flood, [T_TEST + pd.Timedelta(hours=100)]


def test_choose_warn_at_lowest_p_with_at_most_one_false_alarm_per_replay():
    p, c = _validation_event()
    # p* 0.1-0.3: both spikes trigger -> 2 false alarms in the replay; 0.4 is the lowest with <= 1
    assert m.choose_warn_at({"v": p}, {"v": c}, CUTOFF) == 0.4
    # without the spikes, nothing stops the lowest grid value
    p0, c0 = _validation_event(spikes=0.0)
    assert m.choose_warn_at({"v": p0}, {"v": c0}, CUTOFF) == 0.1
    # the cap is per replay: one spike in each of two replays is fine at 0.1
    p1 = hourly_p(T0, 300, lambda h: 0.6 if 150 <= h < 200 else 0.35 if h == 20 else 0.0)
    t2 = T0 + pd.Timedelta(days=400)
    p2 = hourly_p(t2, 300, lambda h: 0.6 if 150 <= h < 200 else 0.35 if h == 20 else 0.0)
    crossings = {"a": c, "b": [t2 + pd.Timedelta(hours=200)]}
    assert m.choose_warn_at({"a": p1, "b": p2}, crossings, CUTOFF) == 0.1


def test_choose_warn_at_falls_back_to_default():
    # a false-alarm spike at 0.95 every 50 h: no grid p* has <= 1 false alarm
    p = hourly_p(T0, 300, lambda h: 0.95 if h % 50 == 0 else 0.0)
    assert m.choose_warn_at({"v": p}, {"v": []}, CUTOFF) == m.WARN_AT_DEFAULT
    assert m.choose_warn_at({}, {}, CUTOFF) == m.WARN_AT_DEFAULT


@pytest.mark.parametrize("kind", ["quiet", "spiky", "flood"])
def test_choose_warn_at_ignores_test_period_events(kind: str):
    p, c = _validation_event()
    tp, tc = _test_event(kind)
    chosen = m.choose_warn_at({"v": p, "t": tp}, {"v": c, "t": tc}, CUTOFF)
    assert chosen == m.choose_warn_at({"v": p}, {"v": c}, CUTOFF) == 0.4


def test_before_cuts_a_straddling_event_at_the_cutoff():
    # issue times from 10 h before the cutoff; repeated 0.95 spikes after the cutoff are never seen
    t0 = CUTOFF - pd.Timedelta(hours=10)
    p = hourly_p(t0, 300, lambda h: 0.95 if h >= 10 and h % 50 == 0 else 0.0)
    cross = [CUTOFF + pd.Timedelta(hours=5)]
    p_val, c_val = m.before({"x": p}, {"x": cross}, CUTOFF)
    assert p_val["x"].index.max() < CUTOFF and len(p_val["x"]) == 10
    assert c_val["x"] == []
    assert m.choose_warn_at({"x": p}, {"x": cross}, CUTOFF) == 0.1
    # an event wholly in the test period is dropped
    assert m.before({"t": _test_event("spiky")[0]}, {}, CUTOFF) == ({}, {})


@pytest.mark.parametrize("kind", ["quiet", "spiky", "flood"])
def test_warn_at_entry_reports_test_events_without_using_them(kind: str):
    p, c = _validation_event()
    tp, tc = _test_event(kind)
    lead_vs_ea = {("v", 0.4): 12.0, ("v", 0.5): 2.0, ("t", 0.4): -3.0, ("t", 0.5): -5.0}
    w = m.warn_at_entry(
        {"v": p, "t": tp},
        {"v": c, "t": tc},
        {"v": "validation", "t": "test"},
        CUTOFF,
        lead_vs_official=lambda eid, ps: lead_vs_ea.get((eid, ps)),
    )
    assert w["pStar"] == 0.4 and "2021-10-01" in w["rule"] and ": v)" in w["rule"]
    assert w["validation"] == {
        "events": ["v"],
        "hits": 1,
        "misses": 0,
        "falseAlarms": 0,
        "meanLeadH": 50.0,  # 200 - 150
        "meanLeadVsOfficialH": 12.0,
    }
    assert w["atDefault"]["pStar"] == 0.5
    assert w["atDefault"]["validation"]["meanLeadVsOfficialH"] == 2.0
    assert w["test"]["events"] == ["t"] and w["atDefault"]["test"]["events"] == ["t"]
    assert [(r["eventId"], r["period"]) for r in w["perEvent"]] == [("v", "validation"), ("t", "test")]
    assert w["test"]["falseAlarms"] == {"quiet": 0, "spiky": 6, "flood": 0}[kind]
    if kind == "flood":  # p = 0.15 never reaches 0.4: a miss at the frozen level, as it should be
        assert (w["test"]["hits"], w["test"]["misses"]) == (0, 1)
