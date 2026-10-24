// About: how it works, limitations, credits, disclaimer (SPEC §10.2, §15.7).
import HowItWorks from "../components/about/HowItWorks";
import Glossary from "../components/about/Glossary";
import { TabHeadline } from "../components/shared/TabHeadline";
import { ABOUT_HEADLINE } from "../lib/headlines";

export default function About() {
  return (
    <>
    <TabHeadline h={ABOUT_HEADLINE} />
    <div className="grid-cols">
      <HowItWorks />

      <section className="card">
        <h2>How it works</h2>
        <ol>
          <li>
            <strong>Measure the clock.</strong> From past Oxford floods we measure how long the
            flood wave takes to travel from upstream gauges (Farmoor, Eynsham, Cassington, Enslow,
            Islip) to Oxford: how long the middle of a flood rise takes to get from one gauge to the
            next (the travel time, <em>T½</em>).
          </li>
          <li>
            <strong>Read the upstream gauges.</strong> We compare each gauge only with its own usual
            level, because every gauge measures from a different zero.
          </li>
          <li>
            <strong>Forecast a range.</strong> A machine-learning model (LightGBM, a standard
            decision-tree method) predicts a <em>range</em> for the river level 6 hours to 3 days
            ahead, from a low guess to a high guess. We then adjust those ranges on past floods
            (<span className="term" title="Conformal prediction: a standard method that widens or narrows forecast ranges, using results on held-out data, so they hold the truth as often as they claim.">conformal calibration</span>)
            so that a 90% range really holds the real level about 9 times in 10.
          </li>
          <li>
            <strong>Turn it into a chance and a time.</strong> The chance each spot reaches its
            flood level, and when that chance reaches 1 in 10, 1 in 2 and 9 in 10.
          </li>
          <li>
            <strong>Prove it, then decide.</strong> Replays of real floods, scoring against the
            simple guess "the river stays where it is", comparison with the official Environment
            Agency warnings, and a rule for when acting is worth the cost.
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
            <strong>Replays may have learned from later floods.</strong> Each Time Machine replay
            uses a model trained without that flood, but it may have seen floods that came{" "}
            <em>after</em> it (2014 is replayed with a model that saw 2024). Our main scores use a
            separate test on forecasts from 2021 on that no model trained on (Proof tab).
          </li>
          <li>
            <strong>Flood levels are approximate.</strong> They are the EA's "property flooding is
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
      <Glossary />
    </div>
    </>
  );
}
