// One-screen components (#135): wording rules on synthetic facts, and the
// Scoreboard / footer on the committed data (every number read at runtime).
import { existsSync, readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { EventMeta, Forecast, Proof, Replay, Spot } from "../contracts";
import { HOUR } from "../time";
import { perEventRow, replayFacts, startIndex, type ReplayFacts } from "../screens/replay/facts";
import { EVENT_CHOICES } from "./choices";
import {
  MARKER_LABEL,
  chanceAt,
  eaDifference,
  firstCrossing,
  nowMarkers,
  nowScore,
  proofSummary,
  proofText,
  replayMarkers,
  replayScore,
  storyEnd,
} from "./story";
import { ScoreboardView } from "./Scoreboard";
import { ProofFooterView } from "./ProofFooter";
import { NowTimeline, ReplayTimeline } from "./Timeline";

const T = (s: string) => Date.parse(s);
const facts = (over: Partial<ReplayFacts>): ReplayFacts => ({
  eventId: "x",
  spot: "botley",
  crossing: null,
  rc50: null,
  rc50AlreadyOn: false,
  leadBeforeFloodH: null,
  official: null,
  leadVsOfficialH: null,
  peakChance: null,
  peakObs: null,
  peakBand: null,
  crossed: false,
  noForecast: false,
  ...over,
});

describe("EVENT_CHOICES", () => {
  it("puts Now and the four headline floods first, the rest under more, Botley by default", () => {
    expect(EVENT_CHOICES.filter((c) => !c.more).map((c) => c.id)).toEqual(["now", "e2014", "e2024a", "e2024b", "e2026"]);
    expect(EVENT_CHOICES.every((c) => !/\s/.test(c.label) && c.defaultSpot === "botley")).toBe(true);
  });
});

describe("replayScore", () => {
  const flood = facts({
    crossing: "2014-01-05T12:00:00Z",
    crossed: true,
    rc50: "2014-01-04T05:00:00Z",
    leadBeforeFloodH: 31,
    official: { spot: "botley", type: "warning", issuedAt: "2014-01-04T12:00:00Z", precision: "time" },
    leadVsOfficialH: 7,
    peakChance: { p: 0.93, t: "2014-01-05T00:00:00Z", index: 10 },
  });
  const end = "2014-01-20T00:00:00Z";

  it("tells nothing before it happens, then the whole story", () => {
    const before = replayScore(flood, T("2014-01-03T00:00:00Z"), end, 0.2);
    expect(before.map((l) => l.text)).toEqual(["Chance of flooding within 3 days: 20%", "EA: no warning yet"]);
    const called = replayScore(flood, T("2014-01-04T06:00:00Z"), end, 0.6);
    expect(called[0].text).toMatch(/more likely than not/);
    expect(called[1].text).toBe("EA: no warning yet");
    const both = replayScore(flood, T("2014-01-04T12:00:00Z"), end, 0.7);
    expect(both[1].text).toBe("7 h before the EA warning");
    expect(both[0].text).not.toMatch(/before the flood/); // the flood isn't seen yet
    // The crossing is seen 1 h after it happens (#93).
    expect(replayScore(flood, T("2014-01-05T12:30:00Z"), end, 0.9)[0].text).not.toMatch(/31 h/);
    const after = replayScore(flood, Infinity, end, null);
    expect(after.map((l) => l.text)).toEqual(["River Clock warned 31 h before the flood", "7 h before the EA warning"]);
    expect(after[0].tone).toBe("good");
  });

  it("shows a later River Clock honestly", () => {
    expect(eaDifference(-5.9)).toEqual({ text: "6 h after the EA warning", tone: "bad" });
    expect(eaDifference(0.2).text).toBe("Same time as the EA warning");
    const late = replayScore({ ...flood, leadVsOfficialH: -30.1 }, Infinity, end, null);
    expect(late[1].text).toBe("30 h after the EA warning");
  });

  it("calm, false alarm and missed floods", () => {
    const calm = facts({ peakChance: { p: 0.28, t: "2014-01-04T00:00:00Z", index: 3 } });
    expect(replayScore(calm, Infinity, end, null).map((l) => l.text)).toEqual(["Stayed calm: highest chance 28%", "No EA warning either"]);
    expect(replayScore(calm, T("2014-01-05T00:00:00Z"), end, 0.1)[0].text).toBe("Chance of flooding within 3 days: 10%");
    const fa = facts({ rc50: "2014-01-04T00:00:00Z", peakChance: { p: 0.62, t: "2014-01-04T03:00:00Z", index: 3 } });
    expect(replayScore(fa, Infinity, end, null)[0]).toEqual({ text: "False alarm: reached 62%, no flood", tone: "bad" });
    const missed = facts({ crossing: "2014-01-05T12:00:00Z", crossed: true });
    expect(replayScore(missed, Infinity, end, null).map((l) => l.text)).toEqual([
      "Flooded before River Clock reached 50%",
      "No EA warning before the flood",
    ]);
  });

  it("markers appear as the playhead passes them", () => {
    expect(replayMarkers(flood, T("2014-01-04T00:00:00Z"))).toEqual([]);
    expect(replayMarkers(flood, T("2014-01-04T12:00:00Z")).map((m) => m.label)).toEqual([MARKER_LABEL.rc, MARKER_LABEL.ea]);
    expect(replayMarkers(flood, T("2014-01-05T12:00:00Z")).map((m) => m.label)).not.toContain(MARKER_LABEL.flood);
    expect(replayMarkers(flood, T("2014-01-05T13:00:00Z")).map((m) => m.label)).toContain(MARKER_LABEL.flood);
  });

  it("playback stops 12 h after the story is complete, never past the end", () => {
    expect(storyEnd(flood, end)).toBe(T("2014-01-05T12:00:00Z") + 13 * HOUR);
    expect(storyEnd(facts({}), end)).toBe(T(end));
  });
});

describe("nowScore", () => {
  const spot = { key: "botley", gauge: "newbotley", threshold: 1.4 };
  const lead = (h: number, p: number) => ({ h, q: { "05": 0, "10": 0, "25": 0, "50": 0, "75": 0, "90": 0, "95": 0 }, pFlood: p, pAmber: 0 });
  const live = (levelNow: number, ps: number[]): Forecast => ({
    issuedAt: "2026-10-24T18:00:00Z",
    dataAsOf: {},
    stale: [],
    spots: [{ spot: "botley", levelNow, leads: [6, 12, 24, 36, 48, 72].map((h, i) => lead(h, ps[i])), arrival: null, mode: "probability" }],
    observed: { newbotley: [{ t: "2026-10-24T10:00:00Z", level: levelNow }] },
  });
  it("says no flood, a chance with its time, or above flood level", () => {
    expect(nowScore(live(0.83, [0, 0, 0, 0, 0, 0]), spot).map((l) => l.text)).toEqual([
      "No flood expected in the next 3 days",
      "River 57 cm below flood level",
    ]);
    const p = nowScore(live(1.2, [0, 0.05, 0.2, 0.32, 0.32, 0.32]), spot)[0].text;
    expect(p).toMatch(/^32% chance of flooding by Mon 06:00 GMT$/); // 18:00 UTC Sat + 36 h, after the clocks go back
    expect(nowScore(live(1.5, [1, 1, 1, 1, 1, 1]), spot)[0].text).toBe("Above flood level now");
    expect(nowScore({ ...live(1, [0, 0, 0, 0, 0, 0]), stale: ["newbotley"] }, spot)[0].text).toBe("No forecast here right now");
  });
  it("marks River Clock's call and a recent flood", () => {
    expect(nowMarkers(live(1.2, [0.1, 0.2, 0.5, 0.6, 0.6, 0.6]), spot).map((m) => m.label)).toEqual([MARKER_LABEL.rc]);
    expect(nowMarkers(live(1.5, [1, 1, 1, 1, 1, 1]), spot).map((m) => m.label)).toEqual([MARKER_LABEL.flood]);
    expect(firstCrossing([{ t: "2026-01-01T00:00:00Z", level: 2 }], 1.4, T("2025-12-31T00:00:00Z"))).toBeNull();
  });
});

describe("views", () => {
  it("Scoreboard shows at most two lines, outcome in words and a shape", () => {
    const html = renderToStaticMarkup(
      <ScoreboardView
        lines={[
          { text: "A", tone: "good" },
          { text: "B", tone: "bad" },
          { text: "C", tone: "neutral" },
        ]}
      />,
    );
    expect(html.match(/<p /g)).toHaveLength(2);
    expect(html).toContain("✓");
    expect(html).toContain("In River Clock&#x27;s favour");
    expect(html).not.toContain(">C<");
  });
  it("the footer has the Show the working action", () => {
    const html = renderToStaticMarkup(<ProofFooterView summary={null} />);
    expect(html).toContain("Show the working");
  });
});

// ---- On the committed data ----
const DATA = new URL("../../public/data/", import.meta.url);
const read = <J,>(f: string): J => JSON.parse(readFileSync(new URL(f, DATA), "utf8")) as J;
const have = ["proof.json", "spots.json", "events.json", "live.json", "replays/e2014.json"].every((f) => existsSync(new URL(f, DATA)));

describe.skipIf(!have)("on the committed data", () => {
  const proof = read<Proof>("proof.json");
  const spots = read<Spot[]>("spots.json");
  const botley = spots.find((s) => s.key === "botley")!;

  it("every EVENT_CHOICE is a real event", () => {
    const ids = read<EventMeta[]>("events.json").map((e) => e.id);
    for (const c of EVENT_CHOICES) if (c.id !== "now") expect(ids).toContain(c.id);
  });

  it("e2014 Botley: warned before the flood, EA difference from proof.perEvent with its sign", () => {
    const r = read<Replay>("replays/e2014.json");
    const row = perEventRow(proof, "e2014", "botley");
    const f = replayFacts(r, botley, row);
    const end = r.forecasts.at(-1)!.issuedAt;
    const final = replayScore(f, Infinity, end, null);
    expect(final[0].text).toBe(`River Clock warned ${Math.round(f.leadBeforeFloodH!)} h before the flood`);
    const h = row!.leadVsOfficialH!;
    expect(final[1].text).toBe(`${Math.round(Math.abs(h))} h ${h > 0 ? "before" : "after"} the EA warning`);
    // At the start of the story nothing is given away.
    const t0 = Date.parse(r.forecasts[startIndex(r, botley, f)].issuedAt);
    const first = replayScore(f, t0, end, chanceAt(r.forecasts, "botley", t0));
    expect(first[0].text).toMatch(/^Chance of flooding within 3 days/);
    expect(replayMarkers(f, t0)).toEqual([]);
    console.log("e2014 Botley scoreboard:", final.map((l) => l.text).join(" | "));
  });

  it("Now: one or two lines from live.json", () => {
    const live = read<Forecast>("live.json");
    const lines = nowScore(live, botley);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(2);
    console.log("Now Botley scoreboard:", lines.map((l) => l.text).join(" | "));
  });

  it("the proof footer is summed from proof.json", () => {
    const s = proofSummary(proof);
    let hits = 0;
    let misses = 0;
    for (const rows of Object.values(proof.tradeoff)) {
      const r = rows.find((x) => x.pStar === 0.5)!;
      hits += r.hits;
      misses += r.misses;
    }
    expect(s.rc.hits).toBe(hits);
    expect(s.floods).toBe(hits + misses);
    expect(s.compared).toBe(proof.perEvent.filter((r) => r.crossed && r.leadVsOfficialH != null).length);
    expect(s.earlier).toBeLessThanOrEqual(s.compared);
    const text = proofText(s);
    expect(text.main).toMatch(/^Across \d+ past floods: River Clock caught \d+ \(\d+ false alarms?\) · the official warning caught \d+/);
    const html = renderToStaticMarkup(<ProofFooterView summary={s} />);
    expect(html).toContain(`Across ${s.floods} past floods`);
    console.log("Footer:", text.main, "·", text.earlier);
  });
});

describe.skipIf(!have)("Timeline renders on the committed data", () => {
  const spots = read<Spot[]>("spots.json");
  const proof = read<Proof>("proof.json");
  const botley = spots.find((s) => s.key === "botley")!;
  it("e2014: play button, scrubber at the story start, the chart key", () => {
    const r = read<Replay>("replays/e2014.json");
    const f = replayFacts(r, botley, perEventRow(proof, "e2014", "botley"));
    const html = renderToStaticMarkup(<ReplayTimeline replay={r} spot={botley} facts={f} />);
    expect(html).toContain("Pause"); // a flood autoplays
    expect(html).toContain(`value="${startIndex(r, botley, f)}"`);
    expect(html).toContain("likely range");
    expect(renderToStaticMarkup(<ReplayTimeline replay={r} spot={botley} facts={f} playing={false} />)).toContain("Play");
  });
  it("Now: no playback controls", () => {
    const html = renderToStaticMarkup(<NowTimeline live={read<Forecast>("live.json")} spot={botley} />);
    expect(html).not.toContain("Play");
    expect(html).toContain("Forecast ");
  });
});
