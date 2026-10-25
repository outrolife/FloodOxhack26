// Replay screen logic (#120): facts, scoreboard, badges, headline, start index, playback.
import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Proof, Replay, Spot } from "../../contracts";
import { PEAK_LEAD_H, peakBandFor, perEventRow, replayFacts, startIndex } from "./facts";
import { buildScoreboard, differenceText, latestRevealed, scoreboardAt } from "./scoreboard";
import { badgeText, eaBadgeText, headlineText, outcomeOf, shortSpotName } from "./story";
import { indexAt, simAdvance } from "./playback";

const H = 3_600_000;
const T0 = Date.parse("2014-01-01T00:00:00Z");
const iso = (h: number) => new Date(T0 + h * H).toISOString().replace(".000Z", "Z");

const SPOT: Spot = {
  key: "botley",
  name: "Botley Road / New Botley / Hinksey",
  gauge: "newbotley",
  threshold: 2.76,
  amber: 2.01,
  lat: 51.75,
  lon: -1.28,
  warningArea: "x",
  mode: "probability",
};

/** A synthetic flood: 50% at h60, EA warning h67, crossing h97, peak 3.00 m at h150. */
function synthetic(opts: { pAt?: (h: number) => number; cross?: boolean; peak?: number } = {}): Replay {
  const pAt = opts.pAt ?? ((h: number) => (h >= 60 ? 0.6 : h >= 40 ? 0.2 : 0));
  const cross = opts.cross ?? true;
  const peak = opts.peak ?? 3.0;
  const levelAt = (h: number) => 2.0 + (peak - 2.0) * Math.max(0, 1 - Math.abs(h - 150) / 60);
  const hours = Array.from({ length: 240 }, (_, h) => h);
  return {
    eventId: "e2014",
    name: "Jan–Feb 2014",
    start: iso(0),
    end: iso(239),
    observed: { newbotley: hours.map((h) => ({ t: iso(h), level: levelAt(h) })) },
    forecasts: hours.map((h) => ({
      issuedAt: iso(h),
      dataAsOf: {},
      stale: [],
      spots: [
        {
          spot: "botley",
          levelNow: cross && h >= 97 ? 2.8 : 2.5,
          leads: [24, 72].map((lead) => ({
            h: lead,
            q: { "05": 2.6, "10": 2.65, "25": 2.7, "50": 2.8, "75": 2.9, "90": 3.0, "95": 3.1 },
            pFlood: pAt(h),
            pAmber: 1,
          })),
          arrival: null,
          mode: "probability" as const,
        },
      ],
    })),
    official: [{ spot: "botley", type: "warning", issuedAt: iso(67), precision: "time" }],
    crossings: cross ? [{ spot: "botley", t: iso(97) }] : [],
  };
}

const row = (over: Partial<Proof["perEvent"][number]> = {}): Proof["perEvent"][number] => ({
  eventId: "e2014",
  spot: "botley",
  crossed: true,
  peakObs: 3.0,
  arrivalErrH: null,
  leadVsOfficialH: 7.0,
  officialIssuedAt: iso(67),
  ...over,
});

describe("replayFacts", () => {
  it("reads the call, the EA, the crossing and the peak from the data", () => {
    const f = replayFacts(synthetic(), SPOT, row());
    expect(f.rc50).toBe(iso(60));
    expect(f.official?.issuedAt).toBe(iso(67));
    expect(f.crossing).toBe(iso(97));
    expect(f.leadBeforeFloodH).toBe(37);
    expect(f.leadVsOfficialH).toBe(7.0);
    expect(f.peakObs).toEqual({ level: 3.0, t: iso(150) });
    // The range for the peak hour is the 72 h lead of the forecast issued 72 h before it.
    expect(f.peakBand).toMatchObject({ lo: 2.6, hi: 3.1, issuedAt: iso(150 - PEAK_LEAD_H), inside: true });
  });

  it("takes the difference vs the EA from proof, not from the times", () => {
    const f = replayFacts(synthetic(), SPOT, row({ leadVsOfficialH: 6.2 }));
    expect(f.leadVsOfficialH).toBe(6.2);
  });

  it("has no EA warning when proof says none was issued", () => {
    const f = replayFacts(synthetic(), SPOT, row({ officialIssuedAt: null, leadVsOfficialH: null }));
    expect(f.official).toBeNull();
  });

  it("finds the highest chance for an event with no flood", () => {
    const r = synthetic({ cross: false, pAt: (h) => (h === 120 ? 0.28 : 0.05), peak: 2.65 });
    const f = replayFacts(r, SPOT, row({ crossed: false, peakObs: 2.65, leadVsOfficialH: null, officialIssuedAt: null }));
    expect(f.crossing).toBeNull();
    expect(f.peakChance).toEqual({ p: 0.28, t: iso(120), index: 120 });
  });

  it("marks a peak outside the predicted range", () => {
    const b = peakBandFor(synthetic().forecasts, "botley", { level: 3.2, t: iso(150) });
    expect(b?.inside).toBe(false);
  });

  it("says there is no forecast for a spot the replay doesn't forecast", () => {
    const f = replayFacts(synthetic(), { key: "wolvercote", gauge: "godstow", threshold: 3.07 }, null);
    expect(f.noForecast).toBe(true);
    expect(badgeText(outcomeOf(f))).toBe("No forecast for this spot");
  });
});

describe("startIndex", () => {
  it("starts a flood 72 h before FloodClock's 50%", () => {
    const r = synthetic();
    const f = replayFacts(r, SPOT, row());
    expect(r.forecasts[startIndex(r, SPOT, f)].issuedAt).toBe(iso(60 - 72 < 0 ? 0 : 60 - 72));
  });

  it("starts an event with no flood at its highest chance", () => {
    const r = synthetic({ cross: false, pAt: (h) => (h === 120 ? 0.28 : 0.05), peak: 2.65 });
    const f = replayFacts(r, SPOT, row({ crossed: false }));
    expect(startIndex(r, SPOT, f)).toBe(120);
  });
});

describe("scoreboard", () => {
  const f = replayFacts(synthetic(), SPOT, row());
  const rows = buildScoreboard(f, SPOT.threshold, iso(239));

  it("has the five rows in order", () => {
    expect(rows.map((r) => r.key)).toEqual(["rc", "ea", "diff", "cross", "peak"]);
  });

  it("fills in as the playhead passes each moment, never before", () => {
    const at = (h: number) => scoreboardAt(rows, T0 + h * H).map((r) => r.revealed);
    expect(at(59)).toEqual([false, false, false, false, false]);
    expect(at(60)).toEqual([true, false, false, false, false]);
    expect(at(67)).toEqual([true, true, true, false, false]);
    // Observed moments show an hour later: a forecast at t uses readings only up to t − 1 h (#93).
    expect(at(97)).toEqual([true, true, true, false, false]);
    expect(at(98)).toEqual([true, true, true, true, false]);
    expect(at(150)).toEqual([true, true, true, true, false]);
    expect(at(151)).toEqual([true, true, true, true, true]);
    expect(latestRevealed(scoreboardAt(rows, T0 + 100 * H))).toBe(3);
    expect(latestRevealed(scoreboardAt(rows, T0))).toBe(-1);
  });

  it("states the times in UK time with the zone", () => {
    expect(rows[0].value).toBe("Fri 3 Jan, 12:00 GMT");
    expect(rows[3].value).toMatch(/GMT$/);
    expect(rows[3].detail).toBe("37 h after FloodClock said more likely than not");
    expect(rows[4].value).toBe("Predicted 2.60 m–3.10 m · actual 3.00 m");
    expect(rows[4].detail).toMatch(/^Inside the wide range \(5–95%\) given 72 h before/);
  });

  it("says the difference honestly, in both directions", () => {
    expect(differenceText(7.06)).toBe("FloodClock 7 h earlier than the EA warning");
    expect(differenceText(-29.14)).toBe("FloodClock 29 h after the EA warning");
    expect(differenceText(0.06)).toBe("About the same time as the EA warning");
    const late = buildScoreboard(replayFacts(synthetic(), SPOT, row({ leadVsOfficialH: -5 })), SPOT.threshold, iso(239));
    expect(late[2]).toMatchObject({ value: "FloodClock 5 h after the EA warning", tone: "bad" });
  });

  it("for a near miss says it stayed below, by how much, and the highest chance", () => {
    const r = synthetic({ cross: false, pAt: (h) => (h === 120 ? 0.28 : 0.05), peak: 2.65 });
    const nf = replayFacts(r, SPOT, row({ crossed: false, peakObs: 2.65, leadVsOfficialH: null, officialIssuedAt: null }));
    const b = buildScoreboard(nf, SPOT.threshold, iso(239));
    expect(b[0].value).toBe("Never: highest chance 28%");
    expect(b[1].value).toBe("None issued");
    expect(b[3].value).toBe("No: it stayed below");
    expect(b[3].detail).toBe("Highest 2.65 m, 11 cm under the flood level");
  });

  it("never uses the EA's words for FloodClock's own outputs", () => {
    for (const r of rows) {
      const ours = `${r.value} ${r.detail ?? ""}`.replace(/EA (Flood )?[Ww]arning/g, "");
      expect(ours).not.toMatch(/Flood (Warning|Alert)/);
    }
  });
});

describe("badge and headline", () => {
  it("a called flood", () => {
    const f = replayFacts(synthetic(), SPOT, row());
    expect(badgeText(outcomeOf(f))).toBe("Called 37 h before the flood");
    expect(headlineText(f, SPOT.name, SPOT.threshold, "Jan–Feb 2014")).toBe(
      "January 2014: FloodClock said Botley Road would likely flood 37 hours before it did.",
    );
  });

  it("a near miss", () => {
    const r = synthetic({ cross: false, pAt: (h) => (h === 120 ? 0.28 : 0.05), peak: 2.65 });
    const f = replayFacts(r, SPOT, row({ crossed: false, peakObs: 2.65 }));
    expect(badgeText(outcomeOf(f))).toBe("Stayed calm: highest chance 28%");
    expect(headlineText(f, SPOT.name, SPOT.threshold, "x")).toBe(
      "January 2014: the river at Botley Road came within 11 cm of flood level, and FloodClock never went above 28%.",
    );
  });

  it("a miss and a false alarm are said plainly", () => {
    const miss = replayFacts(synthetic({ pAt: () => 0.3 }), SPOT, row());
    expect(badgeText(outcomeOf(miss))).toBe("Flooded before FloodClock reached 50%");
    const fa = replayFacts(synthetic({ cross: false, pAt: () => 0.7, peak: 2.7 }), SPOT, row({ crossed: false }));
    expect(badgeText(outcomeOf(fa))).toBe("False alarm: reached 70%, no flood");
  });

  it("the EA line on a thumbnail keeps the sign", () => {
    expect(eaBadgeText(replayFacts(synthetic(), SPOT, row({ leadVsOfficialH: 7.06 })))).toBe("7 h before the EA warning");
    expect(eaBadgeText(replayFacts(synthetic(), SPOT, row({ leadVsOfficialH: -30.14 })))).toBe("30 h after the EA warning");
    expect(eaBadgeText(replayFacts(synthetic(), SPOT, row({ leadVsOfficialH: null, officialIssuedAt: null })))).toBe(
      "No EA warning before it",
    );
  });

  it("short spot names", () => {
    expect(shortSpotName("Botley Road / New Botley / Hinksey")).toBe("Botley Road");
    expect(shortSpotName("Cherwell (Kings Mill)")).toBe("Cherwell (Kings Mill)");
  });
});

describe("playback", () => {
  it("moves 12 simulated hours per 2 s at 1×, 48 h at 4×", () => {
    expect(simAdvance(2000, 1)).toBe(12 * H);
    expect(simAdvance(2000, 4)).toBe(48 * H);
  });

  it("shows the last forecast issued at or before the simulated time", () => {
    const ts = [0, 2, 4, 6].map((h) => h * H);
    expect(indexAt(ts, -1)).toBe(0);
    expect(indexAt(ts, 3 * H)).toBe(1);
    expect(indexAt(ts, 4 * H)).toBe(2);
    expect(indexAt(ts, 99 * H)).toBe(3);
  });
});

// The committed data: invariants only (numbers change at each regen, #94).
const DATA = new URL("../../../public/data/", import.meta.url);
const read = <T,>(f: string): T => JSON.parse(readFileSync(new URL(f, DATA), "utf8")) as T;
const haveData = existsSync(new URL("proof.json", DATA)) && existsSync(new URL("replays/e2014.json", DATA));

describe.skipIf(!haveData)("committed replays", () => {
  const proof = read<Proof>("proof.json");
  const spots = read<Spot[]>("spots.json");
  const ids = ["e2007", "e2012", "e2014", "e2021", "e2024a", "e2024b", "e2026"].filter((id) =>
    existsSync(new URL(`replays/${id}.json`, DATA)),
  );

  it.each(ids)("%s: FloodClock's 50% time agrees with proof's lead vs the EA at every spot", (id) => {
    const replay = read<Replay>(`replays/${id}.json`);
    for (const spot of spots.filter((s) => s.mode === "probability")) {
      const r = perEventRow(proof, id, spot.key);
      if (!r) continue;
      const f = replayFacts(replay, spot, r);
      // Every row and the badge render without throwing, for every event and spot.
      expect(buildScoreboard(f, spot.threshold, replay.forecasts.at(-1)!.issuedAt)).toHaveLength(5);
      expect(badgeText(outcomeOf(f)).length).toBeGreaterThan(0);
      if (r.leadVsOfficialH != null && f.rc50 && r.officialIssuedAt) {
        const fromTimes = (Date.parse(r.officialIssuedAt) - Date.parse(f.rc50)) / H;
        expect(Math.abs(fromTimes - r.leadVsOfficialH)).toBeLessThan(1.5);
      }
      expect(f.crossing != null).toBe(r.crossed);
    }
  });
});
