import { describe, expect, it } from "vitest";
import { formatShort, londonDaysBetween, zoneAt } from "../../time";
import { liveObserved } from "../shared/observed";
import { compareSentence, focusWindow, type Official } from "./timeline";
import { countAtOrBefore } from "../shared/series";
import { arrivalSentence } from "../shared/forecast";
import type { Forecast } from "../../contracts";

const all = () => true;

describe("compareSentence", () => {
  const warning: Official = { spot: "osney", type: "warning", issuedAt: "2014-01-06T16:00:00Z", precision: "time" };

  it("says how many hours earlier River Clock was", () => {
    expect(compareSentence("2014-01-05T06:00:00Z", warning, "warning", all)).toBe(
      "River Clock reached 50% 34 h earlier than the official Flood Warning.",
    );
  });

  it("says later when the EA was first", () => {
    expect(compareSentence("2014-01-06T20:00:00Z", warning, "warning", all)).toMatch(/4 h later than/);
  });

  it("compares date-only official times in whole UK days", () => {
    const dateOnly: Official = { ...warning, issuedAt: "2014-01-06T00:00:00Z", precision: "date" };
    expect(compareSentence("2014-01-05T06:00:00Z", dateOnly, "warning", all)).toMatch(/24 h earlier .*whole days/);
  });

  it("stays hidden until both times are revealed", () => {
    const upTo = (t: string) => (x: string) => Date.parse(x) <= Date.parse(t);
    expect(compareSentence("2014-01-05T06:00:00Z", warning, "warning", upTo("2014-01-06T00:00:00Z"))).toBeNull();
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

  it("shows 7 days before the forecast time and 84 h after", () => {
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
    expect(arrivalSentence(sf, false, 2.76)).toBe("Already above the flood threshold (2.86 m vs 2.76 m).");
  });
  it("keeps the arrival window below the threshold", () => {
    expect(arrivalSentence({ ...sf, levelNow: 2.5 }, false, 2.76)).toMatch(/^90% chance of flooding by /);
  });
});
