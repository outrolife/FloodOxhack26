// Render tests for the Now screen (node, no browser): the headline, the stats,
// the river pulse and the spot card all come from the data files.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Forecast, Spot, Station, TravelPair } from "../../contracts";
import liveData from "../../../../tests/fixtures/live.json";
import spotsData from "../../../../tests/fixtures/spots.json";
import stationsData from "../../../../tests/fixtures/stations.json";
import travelData from "../../../../tests/fixtures/travel_times.json";
import { NowView, stepSpot, type MapSlot } from "./NowView";
import { RiverPulse } from "./RiverPulse";
import { riverLinks } from "./logic";

const spots = spotsData as Spot[];
const stations = stationsData as Station[];
const pairs = travelData as TravelPair[];
const live = liveData as Forecast;
const now = Date.parse(live.issuedAt);

const map: MapSlot = ({ clocks }) => (
  <div id="map">
    {clocks.map((c) => (
      <span key={c.spot}>{c.spot}:{c.kind}</span>
    ))}
  </div>
);

const render = (over: Partial<Parameters<typeof NowView>[0]> = {}) =>
  renderToStaticMarkup(
    <NowView spots={spots} stations={stations} pairs={pairs} forecast={live} origin="api" now={now} map={map} {...over} />,
  );

describe("Now screen", () => {
  it("leads with the generated headline, the data timestamp and three stats", () => {
    const html = render();
    expect(html).toContain("Right now: flooding is possible at Osney Island (41% chance in the next 3 days).");
    expect(html).toContain("Data as of Sun 25 Oct, 01:00 GMT");
    expect((html.match(/class="ui-stat /g) ?? []).length).toBe(3);
    expect(html).toContain("highest chance of flooding in 3 days");
  });

  it("passes every spot's clock state to the map, including no-forecast and stale", () => {
    const html = render();
    expect(html).toContain("wolvercote:noforecast");
    expect(html).toContain("cherwell:stale");
    expect(html).toContain("osney:forecast");
  });

  it("opens on the Botley card with one advice line per audience", () => {
    const html = render();
    expect(html).toContain("Botley Road / New Botley / Hinksey");
    expect(html).toContain("Resident: no need to move your car yet (chance under 1%).");
    expect(html).toContain("Commuter:");
    expect(html).toContain("Council:");
    expect(html).toContain("resident 1%, commuter 5%, council 5%");
    expect(html).toContain("No flood expected in the next 72 hours");
  });

  it("a watch-level spot: resident acts, with a deadline in UK time", () => {
    const html = render({ initialSelected: "osney" });
    expect(html).toMatch(/Resident: move your car to higher ground before \w{3} \d\d:\d\d (GMT|BST)/);
    expect(html).toContain("Chance of flooding passes 10% at");
  });

  it("a stale spot says so and points to gov.uk", () => {
    const html = render({ initialSelected: "cherwell" });
    expect(html).toContain("gauge offline since 13 Oct");
    expect(html).toContain("gov.uk/check-flooding");
  });

  it("without live data: says so, and never claims a forecast", () => {
    const html = render({ forecast: null, origin: "none" });
    expect(html).toContain("Live data unavailable.");
    expect(html).toContain("no River Clock forecast is available");
    expect(html).not.toContain("ui-stat ");
  });

  it("never uses the official warning vocabulary for our outputs", () => {
    for (const sel of ["botley", "osney", "cherwell", "wolvercote"]) {
      const html = render({ initialSelected: sel }).replace(/official EA flood warnings for this area/g, "");
      expect(html).not.toMatch(/Flood (Warning|Alert)/);
    }
  });
});

describe("river pulse", () => {
  it("labels each link 'A → B ≈ N h', pulses at a speed set by T½, greys low-n links", () => {
    const chains = riverLinks(stations, pairs);
    const html = renderToStaticMarkup(<RiverPulse chains={chains} />);
    for (const l of chains.flatMap((c) => c.links)) {
      expect(html).toContain(`${l.upName} → ${l.downName}`);
      expect(html).toContain(`animation-duration:${l.seconds}s`);
    }
    const low = chains.flatMap((c) => c.links).filter((l) => l.lowConfidence).length;
    expect((html.match(/class="now-link low"/g) ?? []).length).toBe(low);
    expect((html.match(/low confidence<\/span>/g) ?? []).length).toBe(low);
  });
});

describe("Now presenter keys", () => {
  it("←/→ step through the spots in map order, wrapping round", () => {
    const keys = ["a", "b", "c"];
    expect(stepSpot(keys, "a", 1)).toBe("b");
    expect(stepSpot(keys, "c", 1)).toBe("a");
    expect(stepSpot(keys, "a", -1)).toBe("c");
    expect(stepSpot(keys, null, 1)).toBe("a");
    expect(stepSpot(keys, null, -1)).toBe("c");
    expect(stepSpot([], "a", 1)).toBeNull();
  });
  it("says what the keys do", () => {
    expect(render()).toContain("tour the spots");
  });
});
