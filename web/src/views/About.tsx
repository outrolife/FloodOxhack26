// About: how it works, limitations, credits, disclaimer (SPEC §10.2, §15.7).
export default function About() {
  return (
    <div className="grid-cols">
      <section className="card">
        <h2>How it works</h2>
        <ol>
          <li>
            <strong>Measure the clock.</strong> From past Oxford floods we measure how long the
            flood wave takes to travel from upstream gauges (Farmoor, Eynsham, Cassington, Enslow,
            Islip) to Oxford: the half-rise travel time <em>T½</em>.
          </li>
          <li>
            <strong>Read the upstream gauges.</strong> Each river gauge is compared only with its
            own history (anomalies), never with another gauge's datum.
          </li>
          <li>
            <strong>Forecast a range.</strong> One LightGBM quantile model per gauge and lead time
            (6 to 72 h) gives the 5th to 95th percentile of future level, calibrated with conformal
            prediction.
          </li>
          <li>
            <strong>Turn it into a probability and a time.</strong> The chance each trouble spot
            passes its flood threshold, and when that chance reaches 10%, 50% and 90%.
          </li>
          <li>
            <strong>Prove it, then decide.</strong> Replays of real floods, skill against a
            "level stays roughly where it is" baseline, comparison with official EA warnings, and
            a cost–loss rule for when acting is worth it.
          </li>
        </ol>
      </section>

      <section className="card">
        <h2>Limitations</h2>
        <ul>
          <li>
            Oxford has had only a handful of big floods since 2007, so every event-level number
            has wide uncertainty (we show 90% bootstrap intervals).
          </li>
          <li>
            Time Machine replays use leave-one-flood-out training: the model for a replayed flood
            may have been trained on floods that happened <em>after</em> it. Strict time-split
            test results are reported separately on the Proof tab.
          </li>
          <li>
            Flood thresholds are the EA's "property flooding possible" gauge levels. They are a
            proxy for when a spot floods, not a guarantee.
          </li>
          <li>
            The model uses no future rainfall: it reads water that is already in the river. Heavy
            rain still to come is not in the forecast.
          </li>
          <li>
            Botley Road was closed for the rail-bridge works from April 2023 to September 2026,
            so road-closure dates in that period aren't flood evidence.
          </li>
          <li>River flooding only: no surface-water or groundwater forecasting.</li>
        </ul>
      </section>

      <section className="card">
        <h2>Data and credits</h2>
        <ul>
          <li>
            Environment Agency Hydrology API and flood-monitoring API: river levels and rainfall.
            Open Government Licence v3.0.
          </li>
          <li>
            Environment Agency Historic Flood Warnings (data.gov.uk). Open Government Licence
            v3.0.
          </li>
          <li>
            Open-Meteo historical weather (fallback rainfall, if used). CC BY 4.0.
          </li>
          <li>
            Map tiles and data © OpenStreetMap contributors. ODbL.
          </li>
        </ul>
        <p className="small muted">
          The exact sources used, with download dates and row counts, are listed in the data
          quality table on the Proof tab.
        </p>
      </section>

      <section className="card">
        <h2>Disclaimer</h2>
        <p>
          River Clock is a decision-support prototype built at OxHack 2026. It is{" "}
          <strong>not an official flood warning</strong> and must not replace one. For official
          warnings and what to do, check{" "}
          <a href="https://www.gov.uk/check-flooding" target="_blank" rel="noreferrer">
            gov.uk/check-flooding
          </a>{" "}
          or call Floodline on 0345 988 1188.
        </p>
        <p className="small muted">
          Times are shown in UK time (Europe/London) with the zone; data is stored in UTC.
        </p>
      </section>
    </div>
  );
}
