// River strip: the gauge chain from upstream to Oxford, one branch per river
// system, each link labelled with the median half-rise travel time T½.
import type { Station, TravelPair } from "../../contracts";
import { formatDateTime } from "../../time";
import { Sparkline } from "./Sparkline";
import { countAtOrBefore } from "./series";

type Point = { t: string; level: number };

// Flow paths from SPEC §4.1 / §4.1.1, upstream first. Gauges missing from
// stations.json are skipped, so this works with both old and new gauge sets.
const BRANCHES: { title: string; gauges: string[] }[] = [
  { title: "Thames (west and south Oxford streams)", gauges: ["farmoor", "eynsham", "cassington", "newbotley", "minns", "coldharbour"] },
  { title: "Cherwell", gauges: ["enslow", "islip", "kingsmill"] },
  { title: "Thames main channel (live only)", gauges: ["godstow", "osney", "iffley"] },
];

// When a gauge feeds several targets, label the best-measured link: pairs
// matched on >= 3 events beat cross-correlation-only ones, then more events
// beat fewer (a steadier median), then the primary target wins ties.
const TARGET_PREFERENCE = ["newbotley", "kingsmill", "minns", "coldharbour", "osney", "godstow", "iffley"];

export function bestPair(key: string, pairs: TravelPair[]): TravelPair | undefined {
  return pairs
    .filter((p) => p.up === key)
    .sort((a, b) => Number(a.n < 3) - Number(b.n < 3) || b.n - a.n || rank(a.down) - rank(b.down))[0];
}

/** Travel times measured on fewer floods than this are shown greyed, tagged "low confidence" (#99). */
export const LOW_CONFIDENCE_N = 5;

/**
 * Upstream gauges on a tributary, not the main river: their rises take a
 * different (often longer) route, so a judge reading the strip needs telling.
 */
export const TRIBUTARY_NOTE: Record<string, { short: string; long: string }> = {
  islip: {
    short: "on the River Ray, a slower tributary",
    long: "Islip is on the River Ray, a slow clay tributary that joins the Cherwell below Islip, so its rises can take longer to reach Oxford than Enslow's, even though Islip is closer.",
  },
};

export type LinkInfo = {
  /** "Farmoor → Cold Harbour ≈ 23 h" (+ " (cross-correlation only)" when n < 3). Names both ends, so it can't be read as the next box down. */
  text: string;
  n: number;
  lowConfidence: boolean;
  /** Tooltip: what the number rests on, including the peak-to-peak median for comparison. */
  title: string;
  /** Short on-screen note when the upstream gauge is on a tributary (TRIBUTARY_NOTE). */
  tributary?: string;
};

export function linkInfo(key: string, pairs: TravelPair[], stations: Pick<Station, "key" | "name">[]): LinkInfo | null {
  const p = bestPair(key, pairs);
  if (!p) return null;
  const down = stations.find((s) => s.key === p.down)?.name ?? p.down;
  const up = stations.find((s) => s.key === p.up)?.name ?? p.up;
  const xc = p.n < 3 ? " (cross-correlation only)" : "";
  const lowConfidence = p.n < LOW_CONFIDENCE_N;
  const trib = TRIBUTARY_NOTE[p.up];
  return {
    text: `${up} → ${down} ≈ ${Math.round(p.tHalf.median)} h${xc}`,
    n: p.n,
    lowConfidence,
    title:
      `Median half-rise travel time T½ ${p.tHalf.median.toFixed(1)} h, n = ${p.n} events; ` +
      `peak-to-peak median ${p.tPeak.median.toFixed(1)} h.` +
      (lowConfidence ? ` Fewer than ${LOW_CONFIDENCE_N} events: low confidence.` : "") +
      (trib ? ` ${trib.long}` : ""),
    tributary: trib?.short,
  };
}

/** "based on 4 past rises" */
export const basedOn = (n: number): string => `based on ${n} past ${n === 1 ? "rise" : "rises"}`;

function StripLink({ info }: { info: LinkInfo }) {
  return (
    <div className={`strip-link labelled${info.lowConfidence ? " low" : ""}`} title={info.title}>
      <span className="strip-link-text">{info.text}</span> · {basedOn(info.n)}
      {info.tributary && <span className="strip-trib"> ({info.tributary})</span>}
      {info.lowConfidence && <span className="tag-low">low confidence</span>}
    </div>
  );
}

function rank(gauge: string): number {
  const i = TARGET_PREFERENCE.indexOf(gauge);
  return i < 0 ? TARGET_PREFERENCE.length : i;
}

function lastAtOrBefore(points: Point[] | undefined, until?: string): Point | undefined {
  if (!points) return undefined;
  const k = countAtOrBefore(points, until ? Date.parse(until) : Infinity);
  return k > 0 ? points[k - 1] : undefined;
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
  // Time Machine: a gauge with no replay data (e.g. the live-only main channel)
  // would only say "no reading", so leave it out.
  const shown = (g: string) => stations.some((s) => s.key === g) && (!until || (series?.[g]?.length ?? 0) > 0);
  return (
    <div className="strip">
      {BRANCHES.filter((b) => b.gauges.some(shown)).map((b) => (
        <div className="strip-branch" key={b.title}>
          <h3>{b.title}</h3>
          {b.gauges.filter(shown).map((g, i, visible) => {
            const st = stations.find((s) => s.key === g);
            if (!st) return null;
            const pts = series?.[g];
            const now = lastAtOrBefore(pts, until)?.level ?? levelNow?.[g];
            const link = linkInfo(g, pairs, stations);
            const isLast = i === visible.length - 1;
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
                {link ? <StripLink info={link} /> : !isLast && <div className="strip-link" />}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
