// Spot detail: 7-day sparkline, probability bars, arrival sentence, last
// observation, link to the official EA warning-area page.
import type { Forecast, Spot, Station } from "../../contracts";
import { formatDate, formatDateTime } from "../../time";
import { TERM_TIPS, gaugeName } from "../../lib/plain";
import { LEVEL_STYLE, arrivalSentence, eaAreaUrl, noForecastReason, spotLevel } from "../shared/forecast";
import { LevelGlyph } from "../shared/LevelGlyph";
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
  const stale = forecast?.stale.includes(spot.gauge) ?? false;
  // Grey spots say why (#103): offline gauge, or no long history.
  const why = lvl === "unknown" ? noForecastReason(sf, stale, asOf) : null;

  return (
    <div className="card">
      <h2>{spot.name}</h2>
      <p className="sub">
        Measured at the {gaugeName(station?.name ?? spot.gauge)} gauge ·{" "}
        <span className="term" title={TERM_TIPS.floodLevel}>floods at {spot.threshold.toFixed(2)} m</span> ·{" "}
        <span className="term" title={TERM_TIPS.usualHigh}>usual high {spot.amber.toFixed(2)} m</span>
      </p>
      <p>
        <span className="chip">
          <LevelGlyph level={lvl} />
          {LEVEL_STYLE[lvl].label}
        </span>
        {stale && (
          <span className="chip" style={{ marginLeft: 6 }}>
            Gauge offline since {asOf ? formatDate(asOf) : "unknown"}
          </span>
        )}
      </p>
      {why && <p className="small">{why}</p>}

      {sf && (
        <p className="small">
          {stale ? "Last reading" : "River now"} <strong>{sf.levelNow.toFixed(2)} m</strong>:{" "}
          {sf.levelNow >= spot.threshold
            ? `${(sf.levelNow - spot.threshold).toFixed(2)} m above`
            : `${(spot.threshold - sf.levelNow).toFixed(2)} m below`}{" "}
          flood level.
        </p>
      )}

      <h3>River level, last 7 days <span className="small muted">(dashed line: usual high)</span></h3>
      {history && history.length > 1 ? (
        <Sparkline points={history} amber={spot.amber} width={280} height={60} />
      ) : (
        <p className="small muted">Last 7 days not available.</p>
      )}

      <h3 style={{ marginTop: "0.8rem" }}>Next 3 days</h3>
      <ProbBars sf={sf} issuedAt={forecast?.issuedAt} />
      <p style={{ marginTop: "0.6rem" }}>
        <strong>{arrivalSentence(sf, stale, spot.threshold, asOf)}</strong>
      </p>

      <p className="small muted">
        Last reading: {asOf ? formatDateTime(asOf) : "unknown"}
        {forecast && <> · forecast made {formatDateTime(forecast.issuedAt)}</>}
      </p>
      <p className="small">
        <a href={eaAreaUrl(spot.warningArea)} target="_blank" rel="noreferrer" title={`EA warning area ${spot.warningArea}`}>
          Official Environment Agency warnings for this area
        </a>
      </p>
    </div>
  );
}
