// The one-screen proof footer (#135): one line from proof.json, every number
// summed at runtime, plus "Show the working", which asks the shell to open its
// drawer through the rc:working window event.
import type { Proof } from "../contracts";
import { useData } from "../data";
import { proofSummary, proofText, type ProofSummary } from "./story";
import "./clock.css";

/** Window event the shell listens for to open the "Show the working" drawer. */
export const WORKING_EVENT = "rc:working";

export const openWorking = (): void => {
  window.dispatchEvent(new CustomEvent(WORKING_EVENT));
};

export function ProofFooter() {
  const proof = useData<Proof>("proof.json");
  return <ProofFooterView summary={proof.status === "ready" ? proofSummary(proof.data) : null} />;
}

export function ProofFooterView({ summary }: { summary: ProofSummary | null }) {
  const text = summary ? proofText(summary) : null;
  return (
    <div className="ck-proof">
      {text && (
        <span className="ck-proof-text">
          {text.main}
          {text.earlier && <> · {text.earlier}</>}
        </span>
      )}
      <button type="button" className="ck-working-link" onClick={openWorking}>
        Info
      </button>
    </div>
  );
}
