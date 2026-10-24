// The card that opens when a judge clicks a spot clock: the 72 h fan, the
// arrival window as UK clock times, and one plain advice line per audience
// (resident / commuter / council) from the cost–loss presets.
import type { Forecast, Spot, Station } from "../../contracts";
import { formatDateTime } from "../../time";
import { eaAreaUrl } from "../../components/shared/forecast";
import { PRESETS, formatPct, optimalTrigger } from "../../lib/costLoss";
import { SpotClock } from "../../ui/SpotClock";
import { adviceLines, arrivalWindow, kitState, plainGauge, type SpotClockInfo } from "./logic";
import { MiniFan } from "./MiniFan";

const TAG = { act: "Act", wait: "Not yet", none: "No forecast" } as const;

/** "resident 1%, commuter 5%, council 5%", from the cost–loss presets (p* = C / L). */
const TRIGGERS = PRESETS.map((p) => `${p.label.toLowerCase()} ${formatPct(optimalTrigger(p))}`).join(", ");

export function SpotCard({
  spot,
  clock,
  station,
  forecast,
  onClose,
}: {
  spot: Spot;
  clock: SpotClockInfo;
  station: Station | undefined;
  forecast: Forecast | null;
  onClose?: () => void;
}) {
  const sf = forecast?.spots.find((s) => s.spot === spot.key);
  const stale = clock.kind === "stale";
  const asOf = forecast?.dataAsOf[spot.gauge];
  const lines = adviceLines(clock, sf, forecast?.issuedAt);
  const gap = sf ? spot.threshold - sf.levelNow : null;

  return (
    <section className="card now-card" aria-label={`${spot.name}: details`}>
      <div className="now-card-head">
        <SpotClock label={clock.name} prob={clock.p} countdownH={clock.countdownH} state={kitState(clock)} size="sm" />
        <div>
          <h2 className="now-card-title">{spot.name}</h2>
          <p className="now-card-gauge">
            Gauge: {plainGauge(station?.name ?? spot.gauge)}
            {sf && gap != null && (
              <>
                {" "}
                · {stale ? "last reading" : "now"} {sf.levelNow.toFixed(2)} m,{" "}
                {gap > 0 ? `${gap.toFixed(2)} m below` : `${(-gap).toFixed(2)} m above`} flood level
              </>
            )}
          </p>
        </div>
        {onClose && (
          <button className="now-card-close" onClick={onClose} aria-label="Close spot details">
            ×
          </button>
        )}
      </div>

      {sf && sf.leads.length > 0 && forecast && clock.kind !== "stale" && (
        <MiniFan sf={sf} issuedAt={forecast.issuedAt} threshold={spot.threshold} amber={spot.amber} />
      )}

      <p className="now-card-arrival">
        <strong>{arrivalWindow(clock, sf)}</strong>
      </p>

      <ul className="now-advice">
        {lines.map((l) => {
          const kind = l.act == null ? "none" : l.act ? "act" : "wait";
          return (
            <li key={l.id} className={`now-advice-line ${kind}`}>
              <span className={`now-advice-tag ${kind}`}>{TAG[kind]}</span> {l.text}
            </li>
          );
        })}
      </ul>
      {clock.kind === "forecast" && (
        <p className="now-card-note">
          Each audience acts when the chance reaches its cost of acting ÷ the loss it avoids ({TRIGGERS}).
        </p>
      )}

      <p className="now-card-note">
        Last reading {asOf ? formatDateTime(asOf) : "unknown"}
        {forecast && <> · forecast issued {formatDateTime(forecast.issuedAt)}</>} ·{" "}
        <a href={eaAreaUrl(spot.warningArea)} target="_blank" rel="noreferrer">
          official EA flood warnings for this area
        </a>
      </p>
    </section>
  );
}
