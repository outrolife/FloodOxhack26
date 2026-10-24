// Gauge icons and cards on the flow map (#118 browser feedback).
import { describe, expect, it } from "vitest";
import { chainLinks } from "./flow";
import { gaugeCard, gaugeIconSvg, gaugeLook, lookFor, metres, sparkPath } from "./gauges";

const H = 3_600_000;
const t0 = Date.parse("2026-10-24T12:00:00Z");
const series = (levels: number[]) => levels.map((level, i) => ({ t: new Date(t0 + (i - levels.length + 1) * H).toISOString(), level }));
const station = { name: "Islip", river: "Ray", amber: 1.0, threshold: 2.0 };

describe("gauge look", () => {
  it("is calm, above the usual high or high, each with its own fill", () => {
    expect(gaugeLook(station, 0.6)).toBe("calm");
    expect(gaugeLook(station, 1.4)).toBe("above");
    expect(gaugeLook(station, 1.9)).toBe("high");
    expect(gaugeLook(station, null)).toBe("none");
    expect(lookFor(4)).toBe("high");
    const fills = (["calm", "above", "high"] as const).map((l) => /height="([\d.]+)" rx="1.4"/.exec(gaugeIconSvg(l))![1]);
    expect(Number(fills[0])).toBeLessThan(Number(fills[1]));
    expect(Number(fills[1])).toBeLessThan(Number(fills[2]));
    expect(gaugeIconSvg("none")).toContain("stroke-dasharray");
  });
});

describe("gauge card", () => {
  it("says where the level is on its own gauge, the trend, the last reading and where the water goes", () => {
    const c = gaugeCard(station, series([0.5, 0.52, 0.55, 0.58, 0.6]), t0, 0, { name: "Kings Mill", hours: 30.6 });
    expect(c.title).toBe("Islip");
    expect(c.vsUsual).toBe("0.4 m below its usual high");
    expect(c.vsFlood).toBe("1.4 m below flood level");
    expect(c.trend).toBe("Rising 8 cm in the last 3 h"); // 0.60 now vs 0.52 three hours before
    expect(c.last).toMatch(/^Last reading Sat 24 Oct, 13:00 BST$/);
    expect(c.flow).toBe("Water here reaches Kings Mill in about 31 h");
    expect(c.spark).toHaveLength(5);
  });
  it("never shows a reading before it is known (replay lag) and copes with no data", () => {
    const c = gaugeCard(station, series([0.5, 0.9]), t0, 1);
    expect(c.vsUsual).toBe("0.5 m below its usual high"); // the 0.9 reading is not known yet
    const none = gaugeCard(station, undefined, t0);
    expect(none.vsUsual).toBeNull();
    expect(none.last).toBe("No reading");
    expect(none.spark).toEqual([]);
    expect(gaugeCard({ ...station, threshold: null }, series([2.5]), t0).vsFlood).toBeNull();
  });
  it("formats distances on one gauge", () => {
    expect(metres(0.06)).toBe("6 cm");
    expect(metres(-0.44)).toBe("0.4 m");
  });
  it("draws a sparkline, empty for under two points", () => {
    expect(sparkPath(series([1]), 100, 30).d).toBe("");
    const s = sparkPath(series([0.5, 1.5]), 100, 30, 1);
    expect(s.d.startsWith("M0.0 ")).toBe(true);
    expect(s.usualY).not.toBeNull();
  });
});

describe("chain links include catchment gauges", () => {
  it("links a live_only gauge with a travel time, never a target", () => {
    const stations = [
      { key: "far", role: "live_only" as const },
      { key: "islip", role: "upstream" as const },
      { key: "kingsmill", role: "target" as const },
    ];
    const pair = (up: string, down: string, n: number) => ({ up, down, n, tHalf: { median: 10, p10: 5, p90: 15 } }) as never;
    const links = chainLinks(stations, [pair("far", "kingsmill", 6), pair("islip", "kingsmill", 7), pair("kingsmill", "far", 9)]);
    expect(links.map((l) => l.up).sort()).toEqual(["far", "islip"]);
  });
});
