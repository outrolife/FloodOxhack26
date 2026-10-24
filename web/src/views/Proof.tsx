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
import { useOfficialPrecision } from "../components/proof/useOfficialPrecision";
import { usePeakProbabilities } from "../components/proof/peakProbability";
import { TabHeadline } from "../components/shared/TabHeadline";
import { proofHeadline } from "../lib/headlines";

export default function Proof() {
  const proof = useData<ProofData>("proof.json");
  const travel = useData<TravelTimesFile>("travel_times.json");
  const quality = useData<Quality>("quality.json");
  const importance = useData<Importance>("importance.json");
  const stations = useData<StationsFile>("stations.json");
  const spots = useData<SpotsFile>("spots.json");
  const events = useData<EventsFile>("events.json");
  const precision = useOfficialPrecision(proof.status === "ready" ? proof.data : null);
  const peaks = usePeakProbabilities(proof.status === "ready" ? proof.data : null);
  const dateOnlySpots =new Set([...precision.dateOnly].map((k) => k.slice(k.indexOf(":") + 1)));

  if (stations.status !== "ready" || spots.status !== "ready" || events.status !== "ready") {
    return <Pending states={[stations, spots, events]} />;
  }
  const missing = (label: string) => <div className="card muted">{label} not available yet.</div>;

  return (
    <>
      <FixtureNotice
        sources={[proof, travel, quality, importance].map((s) => (s.status === "ready" ? s.source : undefined))}
      />
      {/* Headline number plus one honest limit first (#103); expert charts folded below. */}
      {proof.status === "ready" && <TabHeadline h={proofHeadline(proof.data, spots.data)} />}
      {proof.status === "ready" ? (
        <>
          <div className="grid-cols">
            <SkillByLead proof={proof.data} />
            <Tradeoff proof={proof.data} spots={spots.data} dateOnlySpots={dateOnlySpots} />
          </div>
          <PerEventTable proof={proof.data} events={events.data} spots={spots.data} dateOnly={precision.dateOnly} peaks={peaks} />
        </>
      ) : (
        missing("Proof metrics (proof.json)")
      )}
      {travel.status === "ready" ? <TravelFinding pairs={travel.data} stations={stations.data} events={events.data} /> : missing("Travel times")}
      <details className="experts">
        <summary>For experts: forecast ranges, honest chances, model inputs and data quality</summary>
        {proof.status === "ready" && (
          <div className="grid-cols">
            <Coverage proof={proof.data} />
            <Reliability proof={proof.data} spots={spots.data} />
          </div>
        )}
        {importance.status === "ready" ? (
          <FeatureImportance importance={importance.data} stations={stations.data} />
        ) : (
          missing("Feature importance")
        )}
        {quality.status === "ready" ? <QualityTables quality={quality.data} stations={stations.data} /> : missing("Data quality report")}
      </details>
    </>
  );
}
