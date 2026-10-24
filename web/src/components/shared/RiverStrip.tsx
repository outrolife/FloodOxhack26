// River strip: the gauge chain from upstream to Oxford, one branch per river
// system, each link labelled with the median half-rise travel time T½.
import type { Station, TravelPair } from "../../contracts";
import { formatDateTime } from "../../time";
import { Sparkline } from "./Sparkline";

type Point = { t: string; level: number };

// Flow paths from SPEC §4.1 / §4.1.1, upstream first. Gauges missing from
// stations.json are skipped, so this works with both old and new gauge sets.
const BRANCHES: { title: string; gauges: string[] }[] = [
  { title: "Thames (west and south Oxford streams)", gauges: ["farmoor", "eynsham", "cassington", "newbotley", "minns", "coldharbour"] },
  { title: "Cherwell", gauges: ["enslow", "islip", "kingsmill"] },
  { title: "Thames main channel (live only)", gauges: ["godstow", "osney", "iffley"] },
];

// When a gauge feeds several targets, label the link to the primary one.
const TARGET_PREFERENCE = ["newbotley", "kingsmill", "minns", "coldharbour", "osney", "godstow", "iffley"];

function linkLabel(key: string, pairs: TravelPair[], stations: Station[]): string | null {
  const from = pairs
    .filter((p) => p.up === key)
    .sort((a, b) => rank(a.down) - rank(b.down));
  if (from.length === 0) return null;
  const p = from[0];
  const down = stations.find((s) => s.key === p.down)?.name ?? p.down;
  const xc = p.n < 3 ? " (cross-correlation only)" : "";
  return `≈ ${Math.round(p.tHalf.median)} h to ${down}${xc}`;
}

function rank(gauge: string): number {
  const i = TARGET_PREFERENCE.indexOf(gauge);
  return i < 0 ? TARGET_PREFERENCE.length : i;
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
  stale,
  dataAsOf,
}: {
  stations: Station[];
  pairs: TravelPair[];
  /** Hourly levels per gauge (replay observed data, or live history if provided). */
  series?: Record<string, Point[]>;
  /** Time Machine: show levels as at this time and hide anything later. */
  until?: string;
  /** Latest level per gauge when no series is available. */
  levelNow?: Record<string, number>;
  /** Live: gauges whose latest reading is > 3 h old (Forecast.stale), and when each was last read. */
  stale?: string[];
  dataAsOf?: Record<string, string>;
}) {
  return (
    <div className="strip">
      {BRANCHES.filter((b) => b.gauges.some((g) => stations.some((s) => s.key === g))).map((b) => (
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
            const isStale = stale?.includes(g) ?? false;
            const asOf = dataAsOf?.[g];
            return (
              <div key={g}>
                <div className={`strip-node ${st.role === "target" ? "target" : ""}`}>
                  <div>
                    <div className="name">{st.name}</div>
                    <div className="meta">
                      {st.river} · {now != null ? `${now.toFixed(2)} m` : "no reading"}
                      {isStale ? (
                        // An old level must not read as today's (e.g. a gauge outage).
                        <> · stale: last reading {asOf ? formatDateTime(asOf) : "unknown"}</>
                      ) : (
                        vsAmber != null && (
                          <> · {vsAmber >= 0 ? `${vsAmber.toFixed(2)} m above` : `${(-vsAmber).toFixed(2)} m below`} normal top</>
                        )
                      )}
                    </div>
                  </div>
                  {pts && pts.length > 1 && <Sparkline points={pts} amber={st.amber} until={until} width={96} height={28} />}
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
