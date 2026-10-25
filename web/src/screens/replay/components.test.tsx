// Replay screen components (#120), rendered to static HTML, on the committed e2014 / e2026 replays.
import { existsSync, readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { EventMeta, Proof, Replay, Spot } from "../../contracts";
import { perEventRow, replayFacts, startIndex } from "./facts";
import { buildScoreboard, scoreboardAt } from "./scoreboard";
import { Scoreboard } from "./ScoreboardCard";
import { EventPicker } from "./EventPicker";
import { clockFor } from "../../ui/clockData";
import { badgeText, headlineText, outcomeOf } from "./story";

const DATA = new URL("../../../public/data/", import.meta.url);
const read = <T,>(f: string): T => JSON.parse(readFileSync(new URL(f, DATA), "utf8")) as T;
const have = ["proof.json", "spots.json", "events.json", "replays/e2014.json", "replays/e2026.json"].every((f) =>
  existsSync(new URL(f, DATA)),
);

describe.skipIf(!have)("Replay screen on the committed data", () => {
  const proof = read<Proof>("proof.json");
  const spots = read<Spot[]>("spots.json");
  const events = read<EventMeta[]>("events.json");
  const botley = spots.find((s) => s.key === "botley")!;
  const e2014 = read<Replay>("replays/e2014.json");
  const e2026 = read<Replay>("replays/e2026.json");
  const row2014 = perEventRow(proof, "e2014", "botley");
  const f2014 = replayFacts(e2014, botley, row2014);
  const end = e2014.forecasts.at(-1)!.issuedAt;

  it("e2014 Botley: opens before FloodClock's call, which comes before the crossing", () => {
    const i = startIndex(e2014, botley, f2014);
    expect(Date.parse(e2014.forecasts[i].issuedAt)).toBeLessThan(Date.parse(f2014.rc50!));
    expect(Date.parse(f2014.rc50!)).toBeLessThan(Date.parse(f2014.crossing!));
    expect(f2014.leadVsOfficialH).toBe(row2014?.leadVsOfficialH ?? null);
  });

  it("the scoreboard starts empty and is complete at the end of the event", () => {
    const rows = buildScoreboard(f2014, botley.threshold, end);
    const start = Date.parse(e2014.forecasts[startIndex(e2014, botley, f2014)].issuedAt);
    const empty = renderToStaticMarkup(<Scoreboard rows={scoreboardAt(rows, start, end)} title="t" />);
    expect(empty).not.toContain("GMT");
    expect((empty.match(/pending/g) ?? []).length).toBe(5);
    const full = renderToStaticMarkup(<Scoreboard rows={scoreboardAt(rows, Date.parse(end), end)} title="t" />);
    expect(full).not.toContain("pending");
    expect(full).toContain("FloodClock: more likely than not");
    expect(full).toContain("EA Flood Warning");
    expect(full).toContain("River crossed flood level");
    expect(full).toMatch(/Predicted \d\.\d\d m–\d\.\d\d m · actual \d\.\d\d m/);
  });

  it("e2026 Botley: stays calm and says its highest chance", () => {
    const f = replayFacts(e2026, botley, perEventRow(proof, "e2026", "botley"));
    const o = outcomeOf(f);
    expect(o.kind).toBe("calm");
    expect(badgeText(o)).toMatch(/^Stayed calm: highest chance \d+%$/);
    expect(headlineText(f, botley.name, botley.threshold, "Jan–Mar 2026")).toMatch(/cm of flood level/);
  });

  it("thumbnails show every event with its badge", () => {
    const html = renderToStaticMarkup(
      <EventPicker
        events={events}
        replays={{ e2014, e2026 }}
        facts={{ e2014: f2014, e2026: replayFacts(e2026, botley, perEventRow(proof, "e2026", "botley")) }}
        spot={botley}
        selected="e2014"
        onSelect={() => undefined}
      />,
    );
    for (const e of events) expect(html).toContain(e.name.match(/\d{4}/)![0]);
    expect(html).toContain(badgeText(outcomeOf(f2014)));
    expect(html).toContain("Loading…"); // events whose replay hasn't loaded yet
  });

  it("clocks: Wolvercote has no forecast; Botley's clock reads the playhead forecast", () => {
    const f = e2014.forecasts[0];
    expect(clockFor(f, spots.find((s) => s.key === "wolvercote")!).state).toBe("noforecast");
    const atCall = e2014.forecasts.find((x) => x.issuedAt === f2014.rc50)!;
    const c = clockFor(atCall, botley);
    expect(c.prob).toBeGreaterThanOrEqual(0.5);
    expect(c.state).toBe("likely");
  });
});
