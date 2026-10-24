// UK time labels across the clock change (#59). The zone comes from the UTC
// offset, so it reads "BST"/"GMT" in every browser (Chrome's Intl says "GMT+0").
import { describe, expect, it } from "vitest";
import { formatDateTime, formatShort, londonOffsetMinutes, zoneAt, zoneFromOffset } from "./time";

describe("Europe/London zone across Sun 25 Oct 2026, 00:30–02:30 UTC", () => {
  const cases: [string, string, string][] = [
    ["2026-10-25T00:30:00Z", "01:30", "BST"],
    ["2026-10-25T00:59:00Z", "01:59", "BST"],
    ["2026-10-25T01:00:00Z", "01:00", "GMT"],
    ["2026-10-25T01:30:00Z", "01:30", "GMT"],
    ["2026-10-25T02:00:00Z", "02:00", "GMT"],
    ["2026-10-25T02:30:00Z", "02:30", "GMT"],
  ];

  it.each(cases)("%s shows as %s %s", (t, clock, zone) => {
    expect(zoneAt(t)).toBe(zone);
    expect(formatShort(t)).toBe(`Sun ${clock} ${zone}`);
    expect(formatDateTime(t)).toBe(`Sun 25 Oct, ${clock} ${zone}`);
  });

  it("never prints an offset-style zone name", () => {
    for (const [t] of cases) expect(formatDateTime(t)).not.toMatch(/GMT[+-]|UTC/);
  });
});

describe("offset to zone name", () => {
  it("works out the offset from the wall clock", () => {
    expect(londonOffsetMinutes("2026-07-01T12:00:00Z")).toBe(60);
    expect(londonOffsetMinutes("2026-01-01T12:00:00Z")).toBe(0);
  });

  it("maps the two UK offsets to BST and GMT", () => {
    expect(zoneFromOffset(60)).toBe("BST");
    expect(zoneFromOffset(0)).toBe("GMT");
    expect(zoneAt("2026-01-01T12:00:00Z")).toBe("GMT");
    expect(formatDateTime("2014-01-09T18:00:00Z")).toBe("Thu 9 Jan, 18:00 GMT");
  });
});
