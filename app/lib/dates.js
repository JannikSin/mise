// Date helpers for the console statusline and week-keyed plan files.

const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

/**
 * ISO 8601 week id, e.g. "2026-W28". The ISO year can differ from the
 * calendar year at boundaries (Jan 1 2027 → 2026-W53).
 * @param {Date} d
 * @returns {string}
 */
export function isoWeekId(d) {
  // Thursday of this week decides the ISO year (ISO 8601)
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
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
