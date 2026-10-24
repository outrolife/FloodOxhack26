// The river walk (#118): the selected spot's upstream path from travel_times.json.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Spot, TravelPair } from "../contracts";
import { riverWalk } from "./flow";

const pair = (up: string, down: string, n = 6, h = 10) => ({ up, down, n, tHalf: { p10: h - 2, median: h, p90: h + 2 } });

describe("riverWalk", () => {
  it("follows every pair into the spot's gauge, and on upstream", () => {
    const w = riverWalk("kingsmill", [pair("enslow", "kingsmill"), pair("islip", "kingsmill", 7, 31), pair("far", "islip"), pair("eynsham", "newbotley")]);
    expect([...w.gauges].sort()).toEqual(["enslow", "far", "islip", "kingsmill"]);
    expect(w.links.map((l) => `${l.up}>${l.down}`).sort()).toEqual(["enslow>kingsmill", "far>islip", "islip>kingsmill"]);
    expect(w.links.find((l) => l.up === "islip")?.tHalfH).toBe(31);
  });
  it("is empty when nothing upstream is measured, and survives loops", () => {
    expect(riverWalk("osney", [pair("eynsham", "newbotley")]).gauges.size).toBe(0);
    const loop = riverWalk("a", [pair("b", "a"), pair("a", "b")]);
    expect([...loop.gauges].sort()).toEqual(["a", "b"]);
  });
});

const DATA = new URL("../../public/data/", import.meta.url);
const have = ["spots.json", "travel_times.json"].every((f) => existsSync(new URL(f, DATA)));

describe.skipIf(!have)("river walks on the committed data", () => {
  const spots = JSON.parse(readFileSync(new URL("spots.json", DATA), "utf8")) as Spot[];
  const pairs = JSON.parse(readFileSync(new URL("travel_times.json", DATA), "utf8")) as TravelPair[];
  it("Botley Road and the Cherwell each have an upstream walk", () => {
    for (const key of ["botley", "cherwell"]) {
      const s = spots.find((x) => x.key === key);
      if (!s) continue;
      const w = riverWalk(s.gauge, pairs);
      expect(w.links.length).toBeGreaterThan(0);
      expect(w.gauges.has(s.gauge)).toBe(true);
    }
  });
});
