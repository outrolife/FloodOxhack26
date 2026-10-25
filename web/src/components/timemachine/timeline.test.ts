import { describe, expect, it } from "vitest";
import { formatShort, londonDaysBetween, zoneAt } from "../../time";
import { liveObserved } from "../shared/observed";
import { existsSync, readFileSync } from "node:fs";
import { focusWindow, matchTier, runUpIndex, tierSentence, type Official, type ReplayTimeline } from "./timeline";
import { countAtOrBefore } from "../shared/series";
import { arrivalSentence } from "../shared/forecast";
import type { Forecast, Replay } from "../../contracts";

const all = () => true;
const upTo = (t: string) => (x: string) => Date.parse(x) <= Date.parse(t);

// Synthetic replay: hourly forecasts for "botley" (threshold 2.76) with a
// given flood probability per hour; level below the line until the crossing.
const q = { "05": 2, "10": 2, "25": 2, "50": 2, "75": 2, "90": 2, "95": 2 };
function synth(
  probs: [string, number][],
  official: Official[],
  crossings: string[],
): ReplayTimeline {
  return {
    forecasts: probs.map(([t, p]) => ({
      issuedAt: t,
      dataAsOf: {},
      stale: [],
      spots: [{ spot: "botley", levelNow: crossings.some((c) => Date.parse(c) <= Date.parse(t)) ? 2.9 : 2.5, mode: "probability", arrival: null, leads: [{ h: 72, q, pFlood: p, pAmber: p }] }],
    })),
    official,
    crossings: crossings.map((t) => ({ spot: "botley", t })),
  };
}
const off = (type: Official["type"], issuedAt: string, precision: Official["precision"] = "time"): Official => ({ spot: "botley", type, issuedAt, precision });

describe("matchTier / tierSentence (#82)", () => {
  const probs: [string, number][] = [
    ["2013-12-25T00:00:00Z", 0.2], // early rise: 10% but far before the flood
    ["2014-01-01T00:00:00Z", 0.05],
    ["2014-01-04T00:00:00Z", 0.15],
    ["2014-01-04T12:00:00Z", 0.6],
    ["2014-01-06T00:00:00Z", 0.9],
  ];
  const crossing = "2014-01-06T01:00:00Z";

  it("ignores an alert for an earlier rise and matches tiers within 72 h of the crossing", () => {
    const r = synth(probs, [off("alert", "2013-12-23T19:27:00Z"), off("warning", "2014-01-04T19:00:00Z")], [crossing]);
    const alert = matchTier(r, "botley", 2.76, "alert");
    expect(alert.official).toBeNull();
    expect(alert.rc).toBe("2014-01-04T00:00:00Z"); // first >= 10% inside [c - 72 h, c)
    expect(tierSentence(alert, all, crossing)).toBe(
      "River Clock reached 10% 49 hours before the river reached flood level; no new EA Flood Alert was issued in those 72 hours.",
    );
    const warn = matchTier(r, "botley", 2.76, "warning");
    expect(tierSentence(warn, all, crossing)).toBe("River Clock reached 50% 7 hours earlier than the EA Flood Warning.");
  });

  it("compares the alert with River Clock's first 10%, not its 50%", () => {
    const r = synth(probs, [off("alert", "2014-01-05T00:00:00Z")], [crossing]);
    expect(tierSentence(matchTier(r, "botley", 2.76, "alert"), all, crossing)).toBe(
      "River Clock reached 10% 24 hours earlier than the EA Flood Alert.",
    );
  });

  it("says 'already at 10% or more' when River Clock was on before the 72 h window opened", () => {
    const r = synth(
      [
        ["2014-01-02T00:00:00Z", 0.2],
        ["2014-01-03T01:00:00Z", 0.3], // window opens here (crossing - 72 h)
        ["2014-01-05T00:00:00Z", 0.6],
      ],
      [off("alert", "2014-01-04T01:00:00Z")],
      [crossing],
    );
    const m = matchTier(r, "botley", 2.76, "alert");
    expect(m.alreadyOn).toBe(true);
    expect(tierSentence(m, all, crossing)).toBe(
      "River Clock was already at 10% or more 72 hours before the river reached flood level, at least 24 hours before the EA Flood Alert.",
    );
  });

  it("reports a warning issued after the crossing as late", () => {
    const r = synth(probs, [off("warning", "2014-01-06T05:00:00Z")], [crossing]);
    const m = matchTier(r, "botley", 2.76, "warning");
    expect(m.official).toBeNull();
    expect(tierSentence(m, all, crossing)).toBe(
      "River Clock reached 50% 37 hours before the river reached flood level; the EA Flood Warning came 4 hours after the river reached flood level.",
    );
  });

  it("compares date-only official times in whole UK days", () => {
    const r = synth(probs, [off("warning", "2014-01-05T00:00:00Z", "date")], [crossing]);
    expect(tierSentence(matchTier(r, "botley", 2.76, "warning"), all, crossing)).toMatch(/24 hours earlier .*known only to the day/);
  });

  it("with no crossing, pairs River Clock's first trigger with an official within 72 h", () => {
    const end = "2014-01-06T00:00:00Z";
    const r = synth(probs, [off("alert", "2013-12-26T00:00:00Z")], []);
    expect(tierSentence(matchTier(r, "botley", 2.76, "alert"), all, end)).toBe(
      "River Clock reached 10% 24 hours earlier than the EA Flood Alert, and the river stayed below flood level.",
    );
  });

  it("stays hidden until both markers are revealed, then gives the head start without the outcome (#103)", () => {
    const r = synth(probs, [off("warning", "2014-01-04T19:00:00Z")], [crossing]);
    const m = matchTier(r, "botley", 2.76, "warning");
    expect(tierSentence(m, upTo("2014-01-04T15:00:00Z"), crossing)).toBeNull();
    const soFar = tierSentence(m, upTo("2014-01-05T00:00:00Z"), crossing)!;
    expect(soFar).toBe("So far: River Clock reached 50% 7 hours earlier than the EA Flood Warning. Keep playing to see what the river did.");
    expect(soFar).not.toMatch(/cross|flooded|stayed below/);
  });

  it("starts 'just before the flood' 72 hours before River Clock's 50% (#103)", () => {
    const fc = Array.from({ length: 200 }, (_, i) => ({ issuedAt: new Date(Date.parse("2013-12-20T00:00:00Z") + i * 3_600_000 * 2).toISOString() }));
    const idx = runUpIndex(fc, { rc: "2014-01-04T12:00:00Z", crossing }, { rc: null });
    expect(fc[idx!].issuedAt).toBe("2014-01-01T12:00:00.000Z");
    expect(runUpIndex(fc, { rc: null, crossing: null }, { rc: null })).toBeNull();
    expect(runUpIndex(fc, { rc: null, crossing: null }, { rc: "2013-12-21T00:00:00Z" })).toBe(0);
  });
});

// The committed replays (SPEC §8.1), when present: the demo's own numbers.
function loadReplay(id: string): Replay | null {
  const path = new URL(`../../../public/data/replays/${id}.json`, import.meta.url);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Replay) : null;
}
const e2014 = loadReplay("e2014");
const e2026 = loadReplay("e2026");

describe.skipIf(!e2014)("e2014 replay, Botley (#82)", () => {
  it("matches the Flood Warning to the 6 Jan flood, about 9 hours after River Clock's 50% (proof +9.06 h)", () => {
    const m = matchTier(e2014!, "botley", 2.76, "warning");
    expect(m.crossing).toBe("2014-01-06T01:00:00Z");
    expect(m.official?.issuedAt).toBe("2014-01-04T19:03:30Z");
    expect(tierSentence(m, all, e2014!.forecasts.at(-1)!.issuedAt)).toBe(
      "River Clock reached 50% 9 hours earlier than the EA Flood Warning.",
    );
  });
  it("opens 'just before the flood' 3 days before the 50% call, 1 Jan 2014 10:00 GMT (#103, #162)", () => {
    const warn = matchTier(e2014!, "botley", 2.76, "warning");
    const alert = matchTier(e2014!, "botley", 2.76, "alert");
    const idx = runUpIndex(e2014!.forecasts, warn, alert)!;
    expect(e2014!.forecasts[idx].issuedAt).toBe("2014-01-01T10:00:00Z");
  });
  it("no longer sets the Christmas Flood Alert against the January flood", () => {
    const m = matchTier(e2014!, "botley", 2.76, "alert");
    expect(m.official).toBeNull();
    expect(tierSentence(m, all, e2014!.forecasts.at(-1)!.issuedAt)).not.toMatch(/later than/);
  });
});

describe.skipIf(!e2026)("e2026 replay, near miss (#82)", () => {
  it("has no warning and no 50% for Botley, so says nothing about warnings", () => {
    const m = matchTier(e2026!, "botley", 2.76, "warning");
    expect(m.crossing).toBeNull();
    expect(m.official).toBeNull();
    expect(tierSentence(m, all, e2026!.forecasts.at(-1)!.issuedAt)).toBeNull();
  });
  it("does not pair the mid-January alert with River Clock's 10% three weeks later", () => {
    const end = e2026!.forecasts.at(-1)!.issuedAt;
    const m = matchTier(e2026!, "botley", 2.76, "alert");
    expect(m.official).toBeNull();
    expect(tierSentence(m, all, end)).toMatch(/^River Clock reached 10% on .*2026.* and the river stayed below flood level; no EA Flood Alert was issued within 72 hours of that\.$/);
    expect(tierSentence(m, upTo(m.rc!), end)).toBeNull(); // "stayed below" only once the event is over
  });
});

describe("UK time across the clock change (Sun 25 Oct 2026)", () => {
  it("labels BST before 01:00 UTC and GMT after", () => {
    expect(zoneAt("2026-10-25T00:30:00Z")).toBe("BST");
    expect(zoneAt("2026-10-25T01:30:00Z")).toBe("GMT");
    // 00:30 UTC is 01:30 BST; 01:30 UTC is 01:30 GMT: same wall clock, different zone.
    expect(formatShort("2026-10-25T00:30:00Z")).toContain("01:30");
    expect(formatShort("2026-10-25T01:30:00Z")).toContain("01:30");
  });

  it("counts UK calendar days, not UTC days", () => {
    // 23:30 UTC on 24 Oct is already 25 Oct in BST.
    expect(londonDaysBetween("2026-10-24T23:30:00Z", "2026-10-25T02:30:00Z")).toBe(0);
    expect(londonDaysBetween("2026-10-24T12:00:00Z", "2026-10-25T12:00:00Z")).toBe(1);
  });
});

describe("liveObserved", () => {
  const base: Forecast = { issuedAt: "2026-10-25T01:00:00Z", dataAsOf: {}, stale: [], spots: [] };

  it("returns null when the forecast has no observed history", () => {
    expect(liveObserved(base)).toBeNull();
    expect(liveObserved(null)).toBeNull();
  });

  it("keeps the last 7 days of valid points and drops junk", () => {
    const f = {
      ...base,
      observed: {
        osney: [
          { t: "2026-10-10T00:00:00Z", level: 1 }, // older than 7 days
          { t: "2026-10-24T00:00:00Z", level: 2 },
          { t: "2026-10-25T00:00:00Z", level: 3 },
          { t: "bad", level: 4 },
          { t: "2026-10-24T12:00:00Z", level: "x" },
        ],
        farmoor: "not a list",
      },
    } as unknown as Forecast;
    expect(liveObserved(f)).toEqual({
      osney: [
        { t: "2026-10-24T00:00:00Z", level: 2 },
        { t: "2026-10-25T00:00:00Z", level: 3 },
      ],
    });
  });
});

describe("focusWindow", () => {
  const H = 3_600_000;
  const event: [number, number] = [0, 60 * 24 * H]; // a 60-day event

  it("shows 7 days before the forecast time and 84 hours after", () => {
    expect(focusWindow(20 * 24 * H, event)).toEqual([13 * 24 * H, 20 * 24 * H + 84 * H]);
  });
  it("stays inside the event at both ends", () => {
    expect(focusWindow(H, event)).toEqual([0, (7 * 24 + 84) * H]);
    expect(focusWindow(60 * 24 * H, event)).toEqual([60 * 24 * H - (7 * 24 + 84) * H, 60 * 24 * H]);
  });
  it("shows a short event whole", () => {
    expect(focusWindow(5 * H, [0, 100 * H])).toEqual([0, 100 * H]);
  });
});

describe("countAtOrBefore", () => {
  const pts = ["2014-01-01T00:00:00Z", "2014-01-01T01:00:00Z", "2014-01-01T02:00:00Z"].map((t, i) => ({ t, level: i }));
  it("counts points at or before a time", () => {
    expect(countAtOrBefore(pts, Date.parse("2013-12-31T00:00:00Z"))).toBe(0);
    expect(countAtOrBefore(pts, Date.parse("2014-01-01T01:00:00Z"))).toBe(2);
    expect(countAtOrBefore(pts, Infinity)).toBe(3);
  });
});

describe("arrivalSentence", () => {
  const q = { "05": 3, "10": 3, "25": 3, "50": 3, "75": 3, "90": 3, "95": 3 };
  const t = "2014-01-06T12:00:00Z";
  const sf = {
    spot: "botley",
    levelNow: 2.86,
    mode: "probability" as const,
    leads: [{ h: 6, q, pFlood: 1, pAmber: 1 }],
    arrival: { p10: t, p50: t, p90: t },
  };
  it("says the spot is already flooding instead of 'by <now>'", () => {
    expect(arrivalSentence(sf, false, 2.76)).toBe("Already above flood level (2.86 m; floods at 2.76 m).");
  });
  it("keeps the arrival window below the threshold", () => {
    expect(arrivalSentence({ ...sf, levelNow: 2.5 }, false, 2.76)).toMatch(/^Flooding very likely by .* \(9 in 10\)\.$/);
  });
});
