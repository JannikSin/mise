// Date helpers for the console statusline and week-keyed plan files.

const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

/**
 * The app's week id, e.g. "2026-W28".
 *
 * WEEKS START ON SUNDAY (David, 2026-09-05: "most calendars start the week on
 * Sunday", and his cooking rhythm — batch and cook Fri–Mon, eat leftovers
 * Tue–Thu — only fits inside one week when Sunday opens it). The id is the
 * ISO 8601 number of the week whose MONDAY falls inside these seven days, so
 * "2026-W36" is Sun Aug 30 … Sat Sep 5 and the number printed on the Plan
 * tab still matches every calendar. The ISO year can differ from the
 * calendar year at boundaries (Jan 1 2027 → 2026-W53).
 *
 * Before 2026-09-05 this was plain ISO (Mon–Sun); a Sunday now belongs to
 * the FOLLOWING id. Plan files written under the old rule keep their Sunday
 * entries in the earlier file; main.js adopts them at read time (the
 * straddle read) so no history is lost.
 * @param {Date} d
 * @returns {string}
 */
export function isoWeekId(d) {
  // step a Sunday forward onto its Monday, then run the ISO arithmetic —
  // Thursday of that Monday's week decides the ISO year (ISO 8601)
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (t.getDay() === 0) t.setDate(t.getDate() + 1);
  t.setDate(t.getDate() + 3 - ((t.getDay() + 6) % 7));
  const isoYear = t.getFullYear();
  const jan4 = new Date(isoYear, 0, 4);
  const week1Monday = new Date(isoYear, 0, 4 - ((jan4.getDay() + 6) % 7));
  const week = 1 + Math.round((t.getTime() - week1Monday.getTime()) / (7 * 86400000));
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/**
 * Local calendar date as YYYY-MM-DD — plan entries key on local days,
 * never UTC (an evening in Berlin must not read as tomorrow).
 * @param {Date} d
 * @returns {string}
 */
export function localIsoDate(d) {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * Parse a YYYY-MM-DD string to a local Date anchored at noon — the anchor
 * keeps day arithmetic safe across DST shifts and midnight rollovers.
 * @param {string} iso
 * @returns {Date}
 */
export function parseLocalIso(iso) {
  return new Date(`${iso}T12:00:00`);
}

/**
 * Time for today's syncs; date + time once it's stale enough to mislead.
 * @param {string | null} iso
 * @returns {string}
 */
export function formatSyncTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

/**
 * Console statusline date, e.g. "MON 07·06".
 * @param {Date} d
 * @returns {string}
 */
export function statusDate(d) {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${DAYS[d.getDay()]} ${mm}·${dd}`;
}
