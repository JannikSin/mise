// Weight trend for the gain phase (docs/SCHEMAS.md fitness/daily.json.weight
// and fitness/targets.json.adjustmentRule): the trailing 7 weigh-ins versus
// the 7 before that, read as a lb/week trend against the gain-phase target
// band. Pure; dates are ISO YYYY-MM-DD strings so windows compare lexically
// and no Date object is needed.

/**
 * @typedef {{
 *   current: number | null,
 *   avg7: number | null,
 *   prevAvg7: number | null,
 *   lbPerWeek: number | null,
 *   verdict: "no-data" | "building" | "on-target" | "too-slow" | "too-fast"
 * }} WeightTrend
 */

const GAIN_LO = 0.25; // lb/week, gain-phase floor
const GAIN_HI = 0.75; // lb/week, gain-phase ceiling

/** @param {number[]} nums */
function average(nums) {
  return nums.reduce((sum, n) => sum + n, 0) / nums.length;
}

/**
 * Weight trend for the gain phase: the average of the most recent 7
 * weigh-ins against the average of the 7 before that. Windows are counted
 * in actual weigh-ins, not calendar days, so a skipped morning never
 * corrupts the average the way a fixed 7-calendar-day window would. Ignores
 * days without a `weight` number and anything dated after `todayIso` (no
 * extrapolation).
 * @param {Record<string, any>[]} days
 * @param {string} todayIso
 * @returns {WeightTrend}
 */
export function weightTrend(days, todayIso) {
  const weighIns = days
    .filter((d) => typeof d.weight === "number" && d.date <= todayIso)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (weighIns.length === 0) {
    return { current: null, avg7: null, prevAvg7: null, lbPerWeek: null, verdict: "no-data" };
  }

  const current = /** @type {any} */ (weighIns[weighIns.length - 1]).weight;

  if (weighIns.length < 7) {
    return { current, avg7: null, prevAvg7: null, lbPerWeek: null, verdict: "building" };
  }

  const last7 = weighIns.slice(-7);
  const prior = weighIns.slice(-14, -7);
  const avg7 = average(last7.map((d) => d.weight));

  if (prior.length === 0) {
    return { current, avg7, prevAvg7: null, lbPerWeek: null, verdict: "building" };
  }

  const prevAvg7 = average(prior.map((d) => d.weight));
  const lbPerWeek = avg7 - prevAvg7;
  const verdict =
    lbPerWeek < GAIN_LO ? "too-slow" : lbPerWeek > GAIN_HI ? "too-fast" : "on-target";

  return { current, avg7, prevAvg7, lbPerWeek, verdict };
}
