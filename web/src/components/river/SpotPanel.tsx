// Spot detail: 7-day sparkline, probability bars, arrival sentence, last
// observation, link to the official EA warning-area page.
import type { Forecast, Spot, Station } from "../../contracts";
import { formatDateTime } from "../../time";
import { LEVEL_STYLE, arrivalSentence, eaAreaUrl, spotLevel } from "../shared/forecast";
import { ProbBars } from "../shared/ProbBars";
import { Sparkline } from "../shared/Sparkline";

type Point = { t: string; level: number };

export function SpotPanel({
  spot,
  station,
  forecast,
  history,
}: {
  spot: Spot;
  station: Station | undefined;
  forecast: Forecast | null;
  /** Last 7 days of hourly levels for the spot's gauge, if available. */
  history: Point[] | undefined;
}) {
  const sf = forecast?.spots.find((s) => s.spot === spot.key);
  const lvl = spotLevel(forecast, spot);
  const asOf = forecast?.dataAsOf[spot.gauge];
  const stale = forecast?.stale.includes(spot.gauge);

  return (
    <div className="card">
      <h2>{spot.name}</h2>
      <p className="sub">
        Gauge: {station?.name ?? spot.gauge} · flood threshold {spot.threshold.toFixed(2)} m · normal top{" "}
        {spot.amber.toFixed(2)} m
      </p>
      <p>
        <span className="chip">
          <span className="dot" style={{ background: LEVEL_STYLE[lvl].colour }} />
          {LEVEL_STYLE[lvl].label}
        </span>
        {stale && <span className="chip" style={{ marginLeft: 6 }}>Gauge data stale</span>}
      </p>

      {sf && (
        <p className="small">
          {stale ? "Last reading" : "Now"} <strong>{sf.levelNow.toFixed(2)} m</strong>:{" "}
          {sf.levelNow >= spot.threshold
            ? `${(sf.levelNow - spot.threshold).toFixed(2)} m above`
            : `${(spot.threshold - sf.levelNow).toFixed(2)} m below`}{" "}
          the flood threshold.
        </p>
      )}

      <h3>Level, last 7 days</h3>
      {history && history.length > 1 ? (
        <Sparkline points={history} amber={spot.amber} width={280} height={60} />
      ) : (
        <p className="small muted">
          7-day history unavailable.
        </p>
      )}

      <h3 style={{ marginTop: "0.8rem" }}>Next 72 hours</h3>
      <ProbBars sf={sf} />
      <p style={{ marginTop: "0.6rem" }}>
        <strong>{arrivalSentence(sf, stale, spot.threshold)}</strong>
      </p>

      <p className="small muted">
        Last observation: {asOf ? formatDateTime(asOf) : "unknown"}
        {forecast && <> · forecast issued {formatDateTime(forecast.issuedAt)}</>}
      </p>
      <p className="small">
        <a href={eaAreaUrl(spot.warningArea)} target="_blank" rel="noreferrer">
          Official EA flood warnings for this area ({spot.warningArea})
        </a>
      </p>
    </div>
  );
}
