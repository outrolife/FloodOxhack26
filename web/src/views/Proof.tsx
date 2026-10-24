// Proof: does River Clock work? Skill, coverage, reliability, trade-off,
// per-event outcomes, the travel-time finding, importance and data quality.
import type {
  EventsFile,
  Importance,
  Proof as ProofData,
  Quality,
  SpotsFile,
  StationsFile,
  TravelTimesFile,
} from "../contracts";
import { useData } from "../data";
import { FixtureNotice, Pending } from "../components/shared/DataNotice";
import { Coverage, Reliability, SkillByLead, Tradeoff } from "../components/proof/SkillCharts";
import { FeatureImportance, PerEventTable, QualityTables, TravelFinding } from "../components/proof/TravelAndData";

export default function Proof() {
  const proof = useData<ProofData>("proof.json");
  const travel = useData<TravelTimesFile>("travel_times.json");
  const quality = useData<Quality>("quality.json");
  const importance = useData<Importance>("importance.json");
  const stations = useData<StationsFile>("stations.json");
  const spots = useData<SpotsFile>("spots.json");
  const events = useData<EventsFile>("events.json");

  if (stations.status !== "ready" || spots.status !== "ready" || events.status !== "ready") {
    return <Pending states={[stations, spots, events]} />;
  }
  const missing = (label: string) => <div className="card muted">{label} not available yet.</div>;

  return (
    <>
      <FixtureNotice
        sources={[proof, travel, quality, importance].map((s) => (s.status === "ready" ? s.source : undefined))}
      />
      {proof.status === "ready" ? (
        <>
          <div className="grid-cols">
            <SkillByLead proof={proof.data} />
            <Coverage proof={proof.data} />
          </div>
          <div className="grid-cols">
            <Reliability proof={proof.data} spots={spots.data} />
            <Tradeoff proof={proof.data} spots={spots.data} />
          </div>
          <PerEventTable proof={proof.data} events={events.data} spots={spots.data} />
        </>
      ) : (
        missing("Proof metrics (proof.json)")
      )}
      {travel.status === "ready" ? <TravelFinding pairs={travel.data} stations={stations.data} /> : missing("Travel times")}
      {importance.status === "ready" ? (
        <FeatureImportance importance={importance.data} stations={stations.data} />
      ) : (
        missing("Feature importance")
      )}
      {quality.status === "ready" ? <QualityTables quality={quality.data} stations={stations.data} /> : missing("Data quality report")}
    </>
  );
}
