// "How good is it?" screen (#123, route #/trust): should you trust River Clock?
// Three big tiles from proof.json, then the old Proof content under "Show the working".
import { Suspense, lazy } from "react";
import type { Proof, SpotsFile } from "../contracts";
import { useData } from "../data";
import { FixtureNotice, Pending } from "../components/shared/DataNotice";
import { TrustView } from "./trust/TrustView";
import { WhatsNext } from "./trust/WhatsNext";

// Lazy, like the shell does, so the old Proof charts stay in their own chunk.
const ProofView = lazy(() => import("../views/Proof"));

export default function Trust() {
  const proof = useData<Proof>("proof.json");
  const spots = useData<SpotsFile>("spots.json");
  if (proof.status !== "ready" || spots.status !== "ready") return <Pending states={[proof, spots]} />;
  return (
    <>
      <FixtureNotice sources={[proof.source, spots.source]} />
      <TrustView
        proof={proof.data}
        spots={spots.data}
        working={
          <>
            <WhatsNext />
            <Suspense fallback={<p className="muted">Loading the full scores…</p>}>
              <ProofView />
            </Suspense>
          </>
        }
      />
    </>
  );
}
