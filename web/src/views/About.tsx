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
            <strong>Forecast a range.</strong> One LightGBM model per gauge, lead time (6 to 72 h)
            and quantile gives the 5th to 95th percentile of future level, calibrated with conformal
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
            <strong>Few floods.</strong> Oxford has had only a handful of big floods since 2007 (one
            of ours, 2026, is a near miss), so every event-level number has wide uncertainty. We
            show 90% bootstrap intervals.
          </li>
          <li>
            <strong>Leave-one-flood-out can see the future.</strong> Time Machine replays use a
            model trained on the other floods, which may include floods that happened{" "}
            <em>after</em> the replayed one (2014 is replayed with a model that saw 2024). Strict
            time-split test results are reported separately on the Proof tab.
          </li>
          <li>
            <strong>Thresholds are proxies.</strong> They are the EA's "property flooding is
            possible" gauge levels, not a flood at your door. At Kings Mill we found no confirmed
            property flooding, only paths, parks and a pub.
          </li>
          <li>
            <strong>Stand-in gauges.</strong> Osney Island uses Minns Estate, about 1.2 km west on a
            side stream. Abingdon Road uses Cold Harbour. Osney Island also floods from groundwater
            and sewers, which a river gauge only partly reflects.
          </li>
          <li>
            <strong>No forecast for Wolvercote.</strong> Its gauge (Godstow Lock downstream) has no
            history, so we show the live level only.
          </li>
          <li>
            <strong>Kings Mill is offline.</strong> The Kings Mill gauge has sent no readings since
            13 Oct 2026. Its history is fine, but in live mode it shows as stale and the Cherwell
            spot has no live forecast.
          </li>
          <li>
            <strong>No future rainfall.</strong> The model reads water already in the river and rain
            that has already fallen. Heavy rain still to come is not in the forecast.
          </li>
          <li>
            <strong>Botley Road closure.</strong> Botley Road was closed for the railway bridge
            works from April 2023 to September 2026, so road closures there in that period are not
            flood evidence. We used none.
          </li>
          <li>River flooding only: no surface-water or groundwater forecasting.</li>
        </ul>
      </section>

      <section className="card">
        <h2>Data and credits</h2>
        <ul>
          <li>
            <a href="https://environment.data.gov.uk/hydrology/doc/reference" target="_blank" rel="noreferrer">
              EA Hydrology API
            </a>
            : 15-minute river level and rainfall history (training, travel times, replays). Open
            Government Licence v3.0. Contains Environment Agency information © Environment Agency
            and database right.
          </li>
          <li>
            <a href="https://environment.data.gov.uk/flood-monitoring/doc/reference" target="_blank" rel="noreferrer">
              EA real-time flood-monitoring API
            </a>
            : live levels and rainfall, station metadata and flood warning areas. Open Government
            Licence v3.0. © Environment Agency.
          </li>
          <li>
            <a href="https://environment.data.gov.uk/flood-monitoring/archive" target="_blank" rel="noreferrer">
              EA flood-monitoring daily archive
            </a>
            : downstream lock levels for Jan–Mar 2026. Open Government Licence v3.0. © Environment
            Agency.
          </li>
          <li>
            <a
              href="https://www.data.gov.uk/dataset/d4fb2591-f4dd-4e7f-9aaf-49af94437b36/historic-flood-warnings2"
              target="_blank"
              rel="noreferrer"
            >
              EA Historic Flood Warnings
            </a>{" "}
            (data.gov.uk): issue times of official alerts and warnings for Oxford. Open Government
            Licence v3.0. © Environment Agency.
          </li>
          <li>
            <a href="https://check-for-flooding.service.gov.uk/" target="_blank" rel="noreferrer">
              GOV.UK Check for flooding
            </a>{" "}
            station pages: "property flooding is possible" thresholds and normal ranges. Open
            Government Licence v3.0. Crown copyright.
          </li>
          <li>
            <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
              OpenStreetMap
            </a>{" "}
            map tiles, and Nominatim and Overpass for placing each spot on the street that floods. ©
            OpenStreetMap contributors. Open Database Licence (ODbL).
          </li>
          <li>
            <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">
              Open-Meteo.com
            </a>{" "}
            ensemble API (ECMWF IFS, 51 runs): the experimental "Rain in the next 72 h" panel on the
            River tab. Context only, not a model input.{" "}
            <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">
              CC BY 4.0
            </a>
            .
          </li>
        </ul>
        <p className="small muted">
          The model uses no weather forecast: its rainfall comes from five EA rain gauges. We checked
          thresholds and event dates against dated local news and residents' pages (listed in the
          README); they are not model inputs. The exact files used, with download dates and row
          counts, are in the data quality table on the Proof tab.
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
