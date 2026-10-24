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
