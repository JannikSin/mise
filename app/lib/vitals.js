// Apple Watch / Apple Health vitals: pure read-side helpers for the Vitals
// dashboard. The app NEVER writes this file — an Apple Shortcuts automation
// on David's phone posts HealthKit data to profiles/<id>/health/vitals.json
// (a PWA cannot read HealthKit directly). Schema in docs/SCHEMAS.md.

/**
 * @typedef {{
 *   date: string,
 *   steps?: number,
 *   distanceMi?: number,
 *   activeKcal?: number,
 *   restingHR?: number,
 *   hrvMs?: number,
 *   sleepHours?: number,
 *   vo2max?: number
 * }} VitalsDay
 * @typedef {{ date: string, result: string, avgBpm?: number }} EkgEvent
 * @typedef {{ days?: VitalsDay[], ekg?: EkgEvent[] }} Vitals
 */

/**
 * The most recent day that has a value for `field`, scanning newest-first.
 * Null when no day carries it (a metric the watch never posted).
 * @param {VitalsDay[]} days
 * @param {keyof VitalsDay} field
 * @returns {{ date: string, value: number } | null}
 */
export function latestWith(days, field) {
  const sorted = [...days].sort((a, b) => b.date.localeCompare(a.date));
  for (const d of sorted) {
    const v = d[field];
    if (typeof v === "number") return { date: d.date, value: v };
  }
  return null;
}

/**
 * Last-N-days series for one field, oldest-first, days missing that field
 * skipped (so a sparkline never plots a phantom zero). Capped at `n` most
 * recent days that HAVE the value.
 * @param {VitalsDay[]} days
 * @param {keyof VitalsDay} field
 * @param {number} n
 * @returns {{ date: string, value: number }[]}
 */
export function series(days, field, n) {
  return [...days]
    .sort((a, b) => a.date.localeCompare(b.date))
    .flatMap((d) => (typeof d[field] === "number" ? [{ date: d.date, value: /** @type {number} */ (d[field]) }] : []))
    .slice(-n);
}

/**
 * Mean of a numeric series, rounded to `digits`, or null when empty.
 * @param {{ value: number }[]} points
 * @param {number} [digits]
 * @returns {number | null}
 */
export function average(points, digits = 0) {
  if (!points.length) return null;
  const mean = points.reduce((s, p) => s + p.value, 0) / points.length;
  const f = 10 ** digits;
  return Math.round(mean * f) / f;
}

/**
 * SVG polyline points string for a sparkline in a `width`x`height` box, with
 * a couple px of vertical padding. Flat series render as a centered line.
 * Empty series return "" (caller renders nothing).
 * @param {{ value: number }[]} points
 * @param {number} width
 * @param {number} height
 * @returns {string}
 */
export function sparkPoints(points, width, height) {
  if (points.length === 0) return "";
  if (points.length === 1) return `0,${height / 2} ${width},${height / 2}`;
  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = 2;
  const span = max - min || 1;
  return points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * width;
      const y = pad + (1 - (p.value - min) / span) * (height - 2 * pad);
      return `${Math.round(x * 100) / 100},${Math.round(y * 100) / 100}`;
    })
    .join(" ");
}

/** The last EKG reading, newest-first, or null. @param {EkgEvent[]} ekg */
export function latestEkg(ekg) {
  if (!ekg?.length) return null;
  return [...ekg].sort((a, b) => b.date.localeCompare(a.date))[0];
}
