// Does a bigger upstream rise travel faster? (#103 item 2)
// travel_times.json stores a least-squares slope of T½ against rise, which a
// couple of extreme points (e.g. two rises that took > 100 h) can drive on
// their own. We only claim a trend when it survives a robustness check:
//   - at least MIN_TREND_N matched rises,
//   - the rank correlation (Spearman, insensitive to outliers) is at least
//     MIN_TREND_RHO in size, and
//   - the outlier-resistant Theil–Sen slope has the same sign as the stored slope.
// Otherwise the panel says there is no clear pattern.

export const MIN_TREND_N = 8;
export const MIN_TREND_RHO = 0.5;

export const NO_CLEAR_PATTERN = "No clear pattern between rise size and travel time.";

type Pt = { rise: number; tHalf: number };

/** Average ranks (ties share the mean rank), 1-based. */
function ranks(v: number[]): number[] {
  const idx = v.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array<number>(v.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const mean = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k][1]] = mean;
    i = j + 1;
  }
  return r;
}

export function spearman(points: Pt[]): number {
  const n = points.length;
  if (n < 2) return 0;
  const a = ranks(points.map((p) => p.rise));
  const b = ranks(points.map((p) => p.tHalf));
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da === 0 || db === 0 ? 0 : num / Math.sqrt(da * db);
}

/** Median of pairwise slopes (hours per metre). */
export function theilSen(points: Pt[]): number {
  const slopes: number[] = [];
  for (let i = 0; i < points.length; i++)
    for (let j = i + 1; j < points.length; j++) {
      const dx = points[j].rise - points[i].rise;
      if (dx !== 0) slopes.push((points[j].tHalf - points[i].tHalf) / dx);
    }
  if (slopes.length === 0) return 0;
  slopes.sort((x, y) => x - y);
  const m = slopes.length >> 1;
  return slopes.length % 2 ? slopes[m] : (slopes[m - 1] + slopes[m]) / 2;
}

export type Trend = {
  /** True when the trend passes every check above. */
  robust: boolean;
  /** One plain sentence for the panel. */
  text: string;
  /** The checks, for a tooltip. */
  detail: string;
};

export function travelTrend(points: Pt[], storedSlope: number | null): Trend {
  const n = points.length;
  const rho = spearman(points);
  const ts = theilSen(points);
  const detail =
    `${n} matched ${n === 1 ? "rise" : "rises"}; rank correlation ${rho.toFixed(2)}; ` +
    `outlier-resistant slope ${ts.toFixed(1)} h per metre` +
    (storedSlope != null ? `; straight-line fit ${storedSlope.toFixed(1)} h per metre` : "") +
    `. We only call it a pattern with at least ${MIN_TREND_N} rises, a rank correlation of at least ${MIN_TREND_RHO} in size, and both slopes agreeing in direction.`;
  const robust =
    storedSlope != null &&
    n >= MIN_TREND_N &&
    Math.abs(rho) >= MIN_TREND_RHO &&
    Math.sign(ts) === Math.sign(storedSlope) &&
    ts !== 0;
  if (!robust) return { robust, text: NO_CLEAR_PATTERN, detail };
  return {
    robust,
    text: `Bigger rises travel ${ts < 0 ? "faster" : "slower"}: about ${Math.abs(ts).toFixed(0)} h ${ts < 0 ? "less" : "more"} per metre of extra rise.`,
    detail,
  };
}
