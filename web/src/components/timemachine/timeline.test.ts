import { describe, expect, it } from "vitest";
import { formatShort, londonDaysBetween, zoneAt } from "../../time";
import { liveObserved } from "../shared/observed";
import { compareSentence, type Official } from "./timeline";
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
