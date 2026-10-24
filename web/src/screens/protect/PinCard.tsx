// One numbered candidate (#121): why it's exposed, bags, deploy-by, the human checks.
import { osmUrl } from "../../components/spread/SandbagList";
import { formatDateTime, formatShort } from "../../time";
import { type Candidate, buildingKind, timing } from "./logic";

export function PinCard({
  c,
  n,
  issuedAt,
  taus,
  active,
  onSelect,
}: {
  c: Candidate;
  n: number;
  issuedAt: string;
  taus: number[];
  active: boolean;
  onSelect: (id: string) => void;
}) {
  const t = timing(c, issuedAt, taus);
  return (
    <li className={`protect-card${active ? " is-active" : ""}`}>
      <button
        type="button"
        className="protect-card-head"
        aria-expanded={active}
        aria-controls={`protect-card-${c.id}`}
        onClick={() => onSelect(c.id)}
      >
        <span className="protect-num" aria-hidden="true">
          {n}
        </span>
        <span className="protect-card-title">
          <strong>{buildingKind(c)}</strong>
          <span className="protect-card-when">
            {t ? <>Water could reach here in ≈ {t.firstWetH} h</> : <>Not wet in half the simulated runs</>}
          </span>
        </span>
        <span className="protect-card-bags">
          <strong>{c.bags}</strong> bags
        </span>
      </button>
      {active && (
        <div id={`protect-card-${c.id}`} className="protect-card-body">
          <dl className="protect-facts">
            <div>
              <dt>Bags in place by</dt>
              <dd>{t ? formatDateTime(t.deployBy) : "No deadline in the next 72 h"}</dd>
            </div>
            <div>
              <dt>Likely wet</dt>
              <dd>
                {t ? (
                  <>
                    between {formatShort(t.earliest)} and {formatShort(t.latest)}
                  </>
                ) : (
                  <>in fewer than half the runs</>
                )}
              </dd>
            </div>
            <div>
              <dt>Chance wet within 48 h</dt>
              <dd>
                {Math.round(c.pWet48 * 100)}% of runs · depth ≈ {c.medianDepthM.toFixed(2)} m
              </dd>
            </div>
          </dl>
          <div className="protect-sub">Why it's on the list</div>
          <ul className="protect-list">
            {c.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <div className="protect-sub">A person must check first</div>
          <ul className="protect-list protect-checks">
            {c.checks.map((k) => (
              <li key={k}>{k}</li>
            ))}
          </ul>
          <p className="small muted">
            Screening score {c.score.toFixed(2)} ·{" "}
            <a href={osmUrl(c.id, c.lat, c.lon)} target="_blank" rel="noreferrer">
              see the building on OpenStreetMap
            </a>
          </p>
        </div>
      )}
    </li>
  );
}
