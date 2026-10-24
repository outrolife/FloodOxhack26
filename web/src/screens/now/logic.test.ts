import { describe, expect, it } from "vitest";
import type { Forecast, Spot, SpotForecast, Station, TravelPair } from "../../contracts";
import liveData from "../../../../tests/fixtures/live.json";
import spotsData from "../../../../tests/fixtures/spots.json";
import stationsData from "../../../../tests/fixtures/stations.json";
import travelData from "../../../../tests/fixtures/travel_times.json";
import {
  MAX_PULSE_S,
  MIN_PULSE_S,
  adviceLines,
  arrivalWindow,
  clockState,
  clockStates,
  dataTimestamp,
  formatCountdown,
  headline,
  kitState,
  plainGauge,
  pulseSeconds,
  riverLinks,
  shortSpotName,
  topStats,
  trend,
} from "./logic";

const spots = spotsData as Spot[];
const stations = stationsData as Station[];
const pairs = travelData as TravelPair[];
const live = liveData as Forecast;

const ISSUED = "2026-10-24T18:00:00Z";
const NOW = Date.parse(ISSUED);
const H = 3_600_000;

const botley: Spot = spots.find((s) => s.key === "botley")!;

function sf(spot: string, ps: number[], extra: Partial<SpotForecast> = {}): SpotForecast {
  const q = { "05": 0.7, "10": 0.75, "25": 0.8, "50": 0.85, "75": 0.9, "90": 0.95, "95": 1.0 };
  return {
    spot,
    levelNow: 0.83,
    leads: [6, 12, 24, 36, 48, 72].map((h, i) => ({ h, q, pFlood: ps[i] ?? ps[ps.length - 1], pAmber: 0 })),
    arrival: { p10: null, p50: null, p90: null },
    mode: "probability",
    ...extra,
  };
}

function forecast(spotsF: SpotForecast[], over: Partial<Forecast> = {}): Forecast {
  return { issuedAt: ISSUED, dataAsOf: { newbotley: "2026-10-24T17:30:00Z" }, stale: [], spots: spotsF, ...over };
}

describe("names", () => {
  it("shortens spot and gauge names for labels", () => {
    expect(shortSpotName("Botley Road / New Botley / Hinksey")).toBe("Botley Road");
    expect(shortSpotName("Cherwell (Kings Mill)")).toBe("Cherwell");
    expect(plainGauge("Eynsham Lock u/s")).toBe("Eynsham");
    expect(plainGauge("Cassington Weir B")).toBe("Cassington");
    expect(plainGauge("Kings Mill u/s")).toBe("Kings Mill");
    expect(plainGauge("New Botley")).toBe("New Botley");
  });
});

describe("clock states from live.json", () => {
  it("countdown is hours to the 50% arrival, or a dash", () => {
    expect(formatCountdown(null)).toBe("—");
    expect(formatCountdown(31.4)).toBe("≈ 31 h");
    expect(formatCountdown(0)).toBe("now");
    expect(formatCountdown(54)).toBe("≈ 2 days 6 h");
  });

  it("forecast spot: p is the 72 h chance, countdown from now to arrival.p50", () => {
    const f = forecast([sf("botley", [0.1, 0.2, 0.55, 0.6, 0.7, 0.8], { arrival: { p10: null, p50: new Date(NOW + 20 * H).toISOString(), p90: null } })]);
    const c = clockState(botley, f, NOW + 2 * H);
    expect(c.kind).toBe("forecast");
    expect(c.p).toBe(0.8);
    expect(c.countdownH).toBeCloseTo(18);
    expect(c.countdown).toBe("≈ 18 h");
    expect(c.name).toBe("Botley Road");
  });

  it("the real snapshot: Wolvercote has no forecast, Kings Mill is stale, the rest are forecast", () => {
    const clocks = clockStates(spots, live, Date.parse(live.issuedAt));
    const by = Object.fromEntries(clocks.map((c) => [c.spot, c]));
    expect(by.wolvercote.kind).toBe("noforecast");
    expect(by.wolvercote.countdown).toBe("—");
    expect(by.wolvercote.status).toBe("live gauge only, no forecast");
    expect(by.cherwell.kind).toBe("stale");
    expect(by.cherwell.status).toMatch(/^gauge offline since 13 Oct/);
    for (const k of ["osney", "botley", "abingdonrd"]) expect(by[k].kind).toBe("forecast");
    expect(kitState(by.wolvercote)).toBe("noforecast");
    expect(kitState(by.cherwell)).toBe("stale");
    expect(kitState(by.osney)).toBe("watch"); // 41% within 72 h
    expect(kitState(by.botley)).toBe("calm");
  });

  it("no live data: every clock says so", () => {
    expect(clockStates(spots, null, NOW).every((c) => c.kind === "nodata" && c.p === null)).toBe(true);
  });

  it("level at or above the threshold reads as flooding now", () => {
    const c = clockState(botley, forecast([sf("botley", [0.9], { levelNow: botley.threshold + 0.1 })]), NOW);
    expect(c.kind).toBe("flooding");
    expect(c.countdown).toBe("now");
  });
});

describe("headline", () => {
  it("quiet day with two spots unforecast: does not claim 'anywhere'", () => {
    const quiet = { ...live, spots: live.spots.map((s) => ({ ...s, leads: s.leads.map((l) => ({ ...l, pFlood: l.pFlood == null ? null : 0 })) })) };
    const h = headline(clockStates(spots, quiet, Date.parse(live.issuedAt)));
    expect(h).toBe("Right now: no flooding expected at the 3 Oxford spots we can forecast in the next 3 days.");
  });

  it("the fixture snapshot: the highest chance is named", () => {
    expect(headline(clockStates(spots, live, Date.parse(live.issuedAt)))).toBe(
      "Right now: flooding is possible at Osney Island (41% chance in the next 3 days).",
    );
  });

  it("all spots forecast and quiet: anywhere in Oxford", () => {
    const f = forecast([sf("botley", [0])]);
    expect(headline(clockStates([botley], f, NOW))).toBe("Right now: no flooding expected anywhere in Oxford in the next 3 days.");
  });

  it("arrival coming: names the spot and the hours", () => {
    const f = forecast([sf("botley", [0.6], { arrival: { p10: null, p50: new Date(NOW + 31 * H).toISOString(), p90: null } })]);
    expect(headline(clockStates([botley], f, NOW))).toBe("Right now: flooding is likely at Botley Road in about 31 hours.");
  });

  it("possible and unlikely tiers", () => {
    expect(headline(clockStates([botley], forecast([sf("botley", [0.2])]), NOW))).toBe(
      "Right now: flooding is possible at Botley Road (20% chance in the next 3 days).",
    );
    expect(headline(clockStates([botley], forecast([sf("botley", [0.03])]), NOW))).toBe(
      "Right now: flooding is unlikely in the next 3 days (highest chance 3%, at Botley Road).",
    );
  });

  it("no forecast at all points to gov.uk", () => {
    expect(headline(clockStates(spots, null, NOW))).toMatch(/no River Clock forecast.*gov\.uk\/check-flooding/);
  });
});

describe("advice lines (act when P ≥ C/L)", () => {
  it("quiet: no-one needs to act, chance under 1%", () => {
    const f = forecast([sf("botley", [0])]);
    const lines = adviceLines(clockState(botley, f, NOW), f.spots[0], ISSUED);
    expect(lines.map((l) => l.text)).toEqual([
      "Resident: no need to move your car yet (chance under 1%).",
      "Commuter: no need to change your route yet (chance under 1%).",
      "Council: no need to close roads or put up barriers yet (chance under 1%).",
    ]);
  });

  it("3%: the resident (p* 1%) acts before the first lead past 1%; commuter and council (p* 5%) wait", () => {
    const f = forecast([sf("botley", [0, 0, 0.02, 0.03, 0.03, 0.03])]);
    const [res, com, cou] = adviceLines(clockState(botley, f, NOW), f.spots[0], ISSUED);
    expect(res.act).toBe(true);
    // 24 h after 18:00 UTC on Sat 24 Oct is Sun 25 Oct 18:00 UTC, which is GMT after the clocks go back.
    expect(res.text).toBe("Resident: move your car to higher ground before Sun 18:00 GMT (chance 3% in 3 days; worth it from 1%).");
    expect(com.act).toBe(false);
    expect(com.text).toBe("Commuter: no need to change your route yet (chance 3%; worth acting from 5%).");
    expect(cou.act).toBe(false);
  });

  it("no forecast: a single 'Everyone' line pointing to gov.uk", () => {
    const clocks = clockStates(spots, live, NOW);
    const w = clocks.find((c) => c.spot === "wolvercote")!;
    const lines = adviceLines(w, live.spots.find((s) => s.spot === "wolvercote"), live.issuedAt);
    expect(lines).toHaveLength(1);
    expect(lines[0].act).toBeNull();
    expect(lines[0].text).toContain("gov.uk/check-flooding");
  });
});

describe("arrival window as UK clock times", () => {
  it("shows the 50% time and the 10–90% window with the zone label", () => {
    const a = { p10: "2026-10-24T20:00:00Z", p50: "2026-10-25T03:00:00Z", p90: "2026-10-25T09:00:00Z" };
    const f = forecast([sf("botley", [0.9], { arrival: a })]);
    const txt = arrivalWindow(clockState(botley, f, NOW), f.spots[0]);
    // 20:00 UTC Sat is 21:00 BST; after 01:00 UTC Sun the UK is on GMT.
    expect(txt).toBe("Chance of flooding passes 50% at Sun 03:00 GMT (window Sat 21:00 BST to Sun 09:00 GMT, 10% to 90% chance).");
  });

  it("quiet: no flood expected", () => {
    const f = forecast([sf("botley", [0])]);
    expect(arrivalWindow(clockState(botley, f, NOW), f.spots[0])).toBe("No flood expected in the next 72 hours (chance under 1%).");
  });
});

describe("top strip", () => {
  it("trend from the last 3 h of observed levels", () => {
    const pts = (ls: number[]) => ls.map((level, i) => ({ t: new Date(NOW + i * H).toISOString(), level }));
    expect(trend(pts([1, 1.02, 1.05, 1.08]))).toBe("rising");
    expect(trend(pts([1.08, 1.05, 1.02, 1]))).toBe("falling");
    expect(trend(pts([1, 1, 1.005, 1.004]))).toBe("steady");
    expect(trend(pts([1, 1.1]))).toBeNull();
  });

  it("at most three stats, all from the data", () => {
    const clocks = clockStates(spots, live, Date.parse(live.issuedAt));
    const stats = topStats(clocks, spots, stations, live);
    expect(stats.length).toBeLessThanOrEqual(3);
    const b = live.spots.find((s) => s.spot === "botley")!;
    expect(stats[0].value).toBe(`${(botley.threshold - b.levelNow).toFixed(2)} m`);
    expect(stats[0].label).toBe("below flood level at New Botley");
    expect(stats[0].sub).toMatch(/no flood expected in 72 h$/);
    expect(stats[0].tone).toBe("calm");
    expect(stats[1]).toEqual({ value: "41%", label: "highest chance of flooding in 3 days", sub: "at Osney Island", tone: "watch" });
    expect(stats[2].value).toBe("3 of 5");
    expect(stats[2].sub).toContain("Wolvercote: live gauge only, no forecast");
    expect(stats[2].sub).toContain("Cherwell: gauge offline since 13 Oct");
  });

  it("timestamp ignores stale gauges", () => {
    const t = dataTimestamp(live)!;
    expect(t).toMatch(/^Data as of Sun 25 Oct, 01:00 GMT · forecast issued Sun 25 Oct, 01:15 GMT$/);
  });
});

describe("river strip pulse", () => {
  it("pulse duration is proportional to T½ within a visible range", () => {
    expect(pulseSeconds(10)).toBeCloseTo(2.5);
    expect(pulseSeconds(20)).toBeCloseTo(2 * pulseSeconds(10));
    expect(pulseSeconds(0.6)).toBe(MIN_PULSE_S);
    expect(pulseSeconds(500)).toBe(MAX_PULSE_S);
  });

  it("one link per upstream gauge, to its best-measured Oxford target", () => {
    const chains = riverLinks(stations, pairs);
    expect(chains.map((c) => c.river)).toEqual(["Thames", "Cherwell"]);
    const thames = chains[0].links;
    expect(thames.map((l) => l.up)).toEqual(["farmoor", "eynsham", "cassington"]);
    for (const l of [...thames, ...chains[1].links]) {
      const p = pairs.find((x) => x.up === l.up && x.down === l.down)!;
      expect(l.tHalfH).toBe(p.tHalf.median);
      expect(l.lowConfidence).toBe(p.n < 5);
      expect(l.label).toMatch(/^[A-Za-z ]+ → [A-Za-z ]+ (≈ \d+ h|< 1 h)$/);
    }
    expect(chains[1].links.every((l) => l.down === "kingsmill")).toBe(true);
  });
});
