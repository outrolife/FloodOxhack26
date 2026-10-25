## Inspiration

Living in Oxford, we noticed how heavy rain can leave water building up in streets and low-lying areas. That made us wonder how vulnerable the city is to flooding, and whether people could get a clearer picture of where river levels were heading.

We researched how river flooding develops around Oxford and what public information was available. The Environment Agency publishes readings from river gauges, but those readings can be difficult to interpret if you just want to know: **How likely is flooding near me, and when might it happen?**

We built **Flood Clock** to turn upstream river readings into a more understandable picture of flood risk and timing. It is intended as an informative decision-support tool, not an official warning or a replacement for the Environment Agency.

## What it does

Flood Clock brings together historical and recent readings from Environment Agency river and rain gauges. A gauge is a monitoring station: river gauges measure water level, while rain gauges measure rainfall. Because each river gauge has its own reference point, its level should be interpreted against that gauge's own history and flood threshold, not compared directly with readings from other gauges.

The project uses historical data to train models to forecast river-level changes at different lead times, from 6 to 72 hours. It combines:

- Recent levels and changes at a target gauge
- Upstream levels aligned using estimated travel times
- Rainfall that has already fallen
- The season

It then turns the forecast range into an estimated chance of passing a local flood threshold.

The interactive map shows the river network, gauges, and forecast risk at trouble spots. The timeline lets you explore live readings or replay past events. Those map animations help explain the relationships between gauges; they are not a simulation tracking water through city streets.

The project is designed around five Oxford-area trouble spots. Probability forecasts are available for four modelled locations. Wolvercote can show a live gauge level but does not currently have a forecast, because there is not suitable historical data for its gauge. Some locations also use a nearby gauge as a stand-in, which the app explains.

## How we built it

- **Collected public data:** We used Environment Agency historical river-level and rainfall data, recent readings from the live flood-monitoring service, and historic flood-warning records.
- **Checked the gauges:** We matched the gauges' historical readings to their flood thresholds. This mattered because some lock gauges had historical data only for the upstream side, which stays relatively flat during floods. We changed our target gauges rather than train on misleading readings.
- **Prepared the data:** We checked and cleaned readings, converted them into hourly data, and recorded gaps and data quality.
- **Measured travel times:** We compared the timing of river rises at upstream and downstream gauges during past events. For example, a rise at Enslow reaches Kings Mill in about 18.6 hours on average across six floods, though the timing varies.
- **Trained and tested the model:** We used LightGBM quantile models to forecast a range of future levels, then estimated the chance of crossing each location's threshold. We compared performance with a simple baseline: the river level stays roughly where it is.
- **Built the app:** A React and TypeScript interface presents the data on a map and timeline. It can run offline from saved project data. We also built an experimental sandbag-screening feature using terrain data.

## Challenges we ran into

- **Finding usable data:** The gauges we first expected to use did not have suitable historical readings on the side of the river relevant to their flood thresholds. We had to check the data and retarget the model.
- **Collaboration:** Several people and AI-assisted coding sessions worked in parallel. Shared task tracking and clear data contracts helped us coordinate changes without breaking the app.
- **Optimisation and integration:** Processing historical data, training models, and keeping the app responsive required careful coordination between the data pipeline, model, API, and interface.
- **Designing the interface:** We had to turn complex readings, uncertainty, and event comparisons into a map and timeline people could understand quickly.
- **Model precision:** Oxford has only a small number of major historical flood events. We had to avoid data leakage, compare against a baseline, and be honest about false alarms, uncertainty, and cases where the EA warning came first.

## Accomplishments that we're proud of

- We built a working prototype around a real Oxford flooding problem using public data.
- We created historical replays that show forecasts alongside observed levels, EA warnings, and threshold crossings.
- In our replay evaluation, Flood Clock caught **29 of 30** threshold crossings with **6 false alarms**. EA Flood Warnings, scored under the same project rules, caught **24** with **1 false alarm**. These results show a trade-off, not that Flood Clock replaces or generally outperforms the EA.
- We built an experimental sandbag-screening view for Osney and Botley, estimating where screening suggests sandbags could be prioritised. It is not an instruction system or a verified operational flood model.
- We made the demo work offline, so judges can explore it without relying on a live connection.

## What we learned

We learned how to coordinate development across people and AI coding agents, and how important clear task ownership and shared interfaces are when work happens in parallel.

We also learned to inspect the data before building a model: a gauge reading can look useful but still be the wrong measurement for the question being asked. Along the way, we learned more about Oxford's rivers, flood monitoring, travel-time relationships, and the limits of making forecasts from a small number of past events.

Most importantly, we learned that a forecast needs to show uncertainty and be tested against a simple baseline, not just look convincing on a map.

## What's next for Flood Clock

- **Expand to other places:** Adapt the approach for other towns with connected river gauges, suitable historical records, and locally checked flood thresholds.
- **Improve rainfall and gauge coverage:** Carefully test forecast rainfall as a model input, and work toward better historical data for locations currently represented by nearby gauges. Any new feature would need to be evaluated for accuracy and false alarms before being relied on.
