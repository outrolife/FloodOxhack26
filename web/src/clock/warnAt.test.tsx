// Each spot's warn-at level (proof.warnAt, #142) on the one screen (#118):
// the "River Clock warned" marker, the Scoreboard's lead vs the EA, the
// caption and the proof footer all read it from proof.json.
import { existsSync, readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { EventMeta, Proof, Replay, Spot } from "../contracts";
import { HOUR } from "../time";
import { DEFAULT_WARN_AT, leadVsOfficialAt, replayFactsFor, warnAtFor } from "../screens/replay/facts";
import { proofSummary, replayScore, sharedAreaNote, warnAtCaption } from "./story";
import { ScoreboardView } from "./Scoreboard";

const row = (eventId: string, leadVsOfficialH: number | null) => ({
  eventId,
  period: "test" as const,
  hits: 1,
  misses: 0,
  falseAlarms: 0,
  meanLeadH: 10,
  leadVsOfficialH,
});
const score = { events: ["e2007", "e2021"], hits: 1, misses: 0, falseAlarms: 0, meanLeadH: 1, meanLeadVsOfficialH: 1 };
const warnAt = (pStar: number, rows = [row("e2024b", 3.4)]): NonNullable<Proof["warnAt"]>[string] => ({
  pStar,
  rule: "rule",
  validation: score,
  test: score,
  atDefault: { pStar: 0.5, validation: score, test: score },
  perEvent: rows,
});
const perEvent = (eventId: string, spot: string, h: number | null): Proof["perEvent"][number] => ({
  eventId,
  spot,
  crossed: true,
  peakObs: 1,
  arrivalErrH: null,
  leadVsOfficialH: h,
  officialIssuedAt: null,
});

describe("warnAtFor / leadVsOfficialAt", () => {
  const proof = { warnAt: { cherwell: warnAt(0.3) }, perEvent: [perEvent("e2024b", "cherwell", 2.4), perEvent("e2024b", "botley", -30)] };
  it("uses the spot's pStar, else 50%", () => {
    expect(warnAtFor(proof, "cherwell")).toBe(0.3);
    expect(warnAtFor(proof, "botley")).toBe(DEFAULT_WARN_AT);
    expect(warnAtFor(null, "botley")).toBe(0.5);
    expect(warnAtFor({ warnAt: { x: { ...warnAt(0.3), pStar: Number.NaN } } }, "x")).toBe(0.5);
  });
  it("reads the lead vs the EA at that level, never the 50% one for another level", () => {
    expect(leadVsOfficialAt(proof, "e2024b", "cherwell")).toBe(3.4); // warnAt row, not perEvent's 2.4
    expect(leadVsOfficialAt(proof, "e2012", "cherwell")).toBeNull(); // no row at 30%
    expect(leadVsOfficialAt(proof, "e2024b", "botley")).toBe(-30); // 50%: proof.perEvent
    expect(leadVsOfficialAt(null, "e2024b", "botley")).toBeNull();
  });
  it("never shows a difference no two messages about one flood can have (>= 72 h)", () => {
    const p = { warnAt: { abingdonrd: warnAt(0.2, [row("e2014", 225.06), row("e2012", 34.72)]) }, perEvent: [] };
    expect(leadVsOfficialAt(p, "e2014", "abingdonrd")).toBeNull();
    expect(leadVsOfficialAt(p, "e2012", "abingdonrd")).toBe(34.72);
  });
});

describe("caption and shared warning area", () => {
  const events = [
    { id: "e2007", start: "2007-07-18T00:00:00Z", end: "2007-08-01T00:00:00Z" },
    { id: "e2021", start: "2021-01-20T00:00:00Z", end: "2021-02-20T00:00:00Z" },
  ];
  it("names the level and the years it was chosen on", () => {
    expect(warnAtCaption({ warnAt: { cherwell: warnAt(0.3) } }, "cherwell", events)).toBe(
      "Warns at 30% chance (level chosen on 2007–2021 floods)",
    );
    expect(warnAtCaption({ warnAt: { cherwell: warnAt(0.3) } }, "cherwell", null)).toBe("Warns at 30% chance");
    expect(warnAtCaption({}, "botley", events)).toBe("Warns at 50% chance");
  });
  it("says which EA warning area a spot is measured against when it shares one", () => {
    const spots = [
      { key: "botley", name: "Botley Road / New Botley", warningArea: "A" },
      { key: "abingdonrd", name: "Abingdon Road", warningArea: "A" },
      { key: "osney", name: "Osney", warningArea: "B" },
    ];
    expect(sharedAreaNote(spots[1], spots)).toBe("EA times are for the Botley Road warning area");
    expect(sharedAreaNote(spots[0], spots)).toBeNull();
    expect(sharedAreaNote(spots[2], spots)).toBeNull();
  });
  it("the Scoreboard shows the caption in one small line", () => {
    const html = renderToStaticMarkup(<ScoreboardView lines={[{ text: "A", tone: "good" }]} caption="Warns at 30% chance" />);
    expect(html).toContain('class="ck-score-caption">Warns at 30% chance<');
    expect(renderToStaticMarkup(<ScoreboardView lines={[{ text: "A", tone: "good" }]} />)).not.toContain("ck-score-caption");
  });
});

// ---- On the committed data ----
const DATA = new URL("../../public/data/", import.meta.url);
const read = <J,>(f: string): J => JSON.parse(readFileSync(new URL(f, DATA), "utf8")) as J;
const have = ["proof.json", "spots.json", "events.json"].every((f) => existsSync(new URL(f, DATA)));

describe.skipIf(!have)("warn-at levels on the committed data", () => {
  const proof = read<Proof>("proof.json");
  const spots = read<Spot[]>("spots.json");
  const events = read<EventMeta[]>("events.json");
  const replays = events
    .map((e) => `replays/${e.id}.json`)
    .filter((f) => existsSync(new URL(f, DATA)))
    .map((f) => read<Replay>(f));

  it("the Scoreboard's lead vs the EA is proof.json's number at the spot's level", () => {
    for (const r of replays) {
      for (const spot of spots.filter((s) => s.mode === "probability")) {
        const f = replayFactsFor(r, spot, proof);
        expect(f.pStar).toBe(proof.warnAt?.[spot.key]?.pStar ?? 0.5);
        const want = proof.warnAt?.[spot.key]?.perEvent.find((x) => x.eventId === r.eventId);
        if (want) {
          const h = want.leadVsOfficialH;
          expect(f.leadVsOfficialH).toBe(h != null && Math.abs(h) < 72 ? h : null);
        }
        const end = r.forecasts.at(-1)?.issuedAt ?? r.end;
        const lines = replayScore(f, Infinity, end, null);
        if (f.rc50 && f.official && f.leadVsOfficialH != null) {
          const h = f.leadVsOfficialH;
          expect(lines[1].text).toBe(Math.abs(h) < 0.5 ? "Same time as the EA warning" : `${Math.round(Math.abs(h))} h ${h > 0 ? "before" : "after"} the EA warning`);
          // The "River Clock warned" and "EA warned" markers on the chart are the same hours apart.
          if (f.official.precision === "time") {
            const fromMarkers = (Date.parse(f.official.issuedAt) - Date.parse(f.rc50)) / HOUR;
            expect(Math.abs(fromMarkers - h)).toBeLessThan(0.05);
          }
        }
      }
    }
  });

  it("e2014 Botley and e2024b Cherwell at their levels", () => {
    const say = (id: string, key: string) => {
      const r = replays.find((x) => x.eventId === id);
      const spot = spots.find((s) => s.key === key);
      if (!r || !spot) return null;
      const f = replayFactsFor(r, spot, proof);
      return replayScore(f, Infinity, r.forecasts.at(-1)?.issuedAt ?? r.end, null).map((l) => l.text);
    };
    const botley = say("e2014", "botley");
    const cherwell = say("e2024b", "cherwell");
    console.log("e2014 Botley:", botley?.join(" | "), "·", warnAtCaption(proof, "botley", events));
    console.log("e2024b Cherwell:", cherwell?.join(" | "), "·", warnAtCaption(proof, "cherwell", events));
    if (proof.warnAt?.cherwell && cherwell) {
      const h = proof.warnAt.cherwell.perEvent.find((x) => x.eventId === "e2024b")?.leadVsOfficialH;
      if (h != null) expect(cherwell[1]).toBe(`${Math.round(Math.abs(h))} h ${h > 0 ? "before" : "after"} the EA warning`);
    }
  });

  it("the footer counts FloodClock at each spot's level", () => {
    const s = proofSummary(proof);
    let falseAlarms = 0;
    for (const [spot, rows] of Object.entries(proof.tradeoff)) {
      const p = proof.warnAt?.[spot]?.pStar ?? 0.5;
      falseAlarms += rows.find((x) => Math.abs(x.pStar - p) < 1e-9)!.falseAlarms;
    }
    expect(s.rc.falseAlarms).toBe(falseAlarms);
    if (proof.warnAt) {
      // The warn-at totals agree with the same per-spot sums (validation + test events).
      const fromWarnAt = Object.values(proof.warnAt).reduce((n, w) => n + w.validation.falseAlarms + w.test.falseAlarms, 0);
      expect(s.rc.falseAlarms).toBe(fromWarnAt);
    }
  });
});
