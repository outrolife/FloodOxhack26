import { describe, expect, it } from "vitest";
import { featureLabel, travelEventLabel } from "./TravelAndData";

const EVENTS = [{ id: "e2014", name: "Jan–Feb 2014" }];
const STATIONS = [
  { key: "eynsham", name: "Eynsham Lock u/s" },
  { key: "farmoor", name: "Farmoor" },
];

describe("travelEventLabel", () => {
  it("uses the named flood when the id is in events.json", () => {
    expect(travelEventLabel("e2014", EVENTS)).toBe("Jan–Feb 2014");
  });
  it("labels pipeline ids as auto-detected rises, with their date", () => {
    expect(travelEventLabel("auto-20061126", EVENTS)).toBe("auto-detected rise, 26 Nov 2006");
    expect(travelEventLabel("auto-x", EVENTS)).toBe("auto-detected rise");
  });
  it("passes unknown ids through", () => {
    expect(travelEventLabel("e2099", EVENTS)).toBe("e2099");
  });
});

describe("featureLabel", () => {
  it("names upstream gauges and describes the feature", () => {
    expect(featureLabel("eynsham_change_3h", STATIONS)).toBe("Eynsham Lock u/s: change over 3 h");
    expect(featureLabel("farmoor_anom_lag12h", STATIONS)).toBe("Farmoor: anomaly 12 h ago");
    expect(featureLabel("farmoor_anom_lag0h", STATIONS)).toBe("Farmoor: anomaly now");
  });
  it("describes the target gauge, rainfall and season", () => {
    expect(featureLabel("level_now")).toBe("This gauge: level now");
    expect(featureLabel("level_mean_21d")).toBe("This gauge: 21-day mean level");
    expect(featureLabel("rain_sum_24h")).toBe("Rainfall, last 24 h");
    expect(featureLabel("rain_sum_21d")).toBe("Rainfall, last 21 days");
    expect(featureLabel("doy_cos")).toBe("Season (day-of-year cosine)");
  });
  it("passes unknown names through", () => {
    expect(featureLabel("mystery_feature", STATIONS)).toBe("mystery_feature");
  });
});
