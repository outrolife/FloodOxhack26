// River strip: the gauge chain from upstream to Oxford, one branch per river
// system, each link labelled with the median half-rise travel time T½.
import type { Station, TravelPair } from "../../contracts";
import { Sparkline } from "./Sparkline";

type Point = { t: string; level: number };

// Flow paths from SPEC §4.1, upstream first.
const BRANCHES: { title: string; gauges: string[] }[] = [
  { title: "Thames", gauges: ["farmoor", "eynsham", "cassington", "godstow", "osney", "iffley", "newbotley"] },
  { title: "Cherwell", gauges: ["enslow", "islip", "kingsmill"] },
];

function linkLabel(key: string, pairs: TravelPair[], stations: Station[]): string | null {
  // Prefer the pair into the next gauge down; otherwise any pair from this gauge.
  const from = pairs.filter((p) => p.up === key);
  if (from.length === 0) return null;
  const p = from[0];
  const down = stations.find((s) => s.key === p.down)?.name ?? p.down;
  const xc = p.n < 3 ? " (cross-correlation only)" : "";
  return `≈ ${Math.round(p.tHalf.median)} h to ${down}${xc}`;
}

function lastAtOrBefore(points: Point[] | undefined, until?: string): Point | undefined {
  if (!points) return undefined;
  const cut = until ? Date.parse(until) : Infinity;
  let best: Point | undefined;
  for (const p of points) if (Date.parse(p.t) <= cut) best = p;
  return best;
}

export function RiverStrip({
  stations,
  pairs,
  series,
  until,
  levelNow,
}: {
  stations: Station[];
  pairs: TravelPair[];
  /** Hourly levels per gauge (replay observed data, or live history if provided). */
  series?: Record<string, Point[]>;
  /** Time Machine: show levels as at this time and hide anything later. */
  until?: string;
  /** Latest level per gauge when no series is available. */
  levelNow?: Record<string, number>;
}) {
  return (
    <div className="strip">
      {BRANCHES.map((b) => (
        <div className="strip-branch" key={b.title}>
          <h3>{b.title}</h3>
          {b.gauges.map((g, i) => {
            const st = stations.find((s) => s.key === g);
            if (!st) return null;
            const pts = series?.[g];
            const now = lastAtOrBefore(pts, until)?.level ?? levelNow?.[g];
            const label = linkLabel(g, pairs, stations);
            const isLast = i === b.gauges.length - 1;
            const vsAmber = now != null ? now - st.amber : null;
            return (
              <div key={g}>
                <div className={`strip-node ${st.role === "target" ? "target" : ""}`}>
                  <div>
                    <div className="name">{st.name}</div>
                    <div className="meta">
                      {st.river} · {now != null ? `${now.toFixed(2)} m` : "no reading"}
                      {vsAmber != null && (
                        <> · {vsAmber >= 0 ? `${vsAmber.toFixed(2)} m above` : `${(-vsAmber).toFixed(2)} m below`} normal top</>
                      )}
                    </div>
                  </div>
                  <Sparkline points={pts} amber={st.amber} until={until} width={96} height={28} />
                </div>
                {label ? <div className="strip-link">{label}</div> : !isLast && <div className="strip-link" />}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
