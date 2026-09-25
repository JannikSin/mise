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

/** 7:30 pm: after this, today's meals are over for planning and buying */
export const DINNER_CUTOFF_MINUTES = 19 * 60 + 30;

/**
 * The first day a GENERATE plans and a BUILD buys for (David, 2026-09-24:
 * "a generate must start from today, or tomorrow if dinner is past"). Before
 * the cutoff that is today; after it, tomorrow, so a late-night run never
 * plans or buys a dinner that already did not happen.
 * @param {Date} now
 * @param {number} [cutoffMinutes]
 * @returns {string}
 */
export function planStartIso(now, cutoffMinutes = DINNER_CUTOFF_MINUTES) {
  if (now.getHours() * 60 + now.getMinutes() < cutoffMinutes) return localIsoDate(now);
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 12);
  return localIsoDate(t);
}

/**
 * The day the week's food is bought, 0 Sun … 6 Sat. FRIDAY by default
 * (David, 2026-09-25: "sunday was not a good day to buy. cause busy with
 * mtgs and all that. so really lets switch the buy day to friday"). Each
 * shopper can change it in SYS (`targets.buyDay`).
 */
export const DEFAULT_BUY_DAY = 5;

/**
 * A shopper's buy day from their targets; anything unusable is Friday.
 * @param {Record<string, any> | null | undefined} targets
 * @returns {number}
 */
export function buyDayOf(targets) {
  const n = targets?.buyDay;
  return Number.isInteger(n) && n >= 0 && n <= 6 ? /** @type {number} */ (n) : DEFAULT_BUY_DAY;
}

/**
 * THE TRIP: the seven days one shop buys for, opening on the buy day. Plans
 * stay Sunday-to-Saturday weeks; only the buying moves, so a Friday trip
 * takes Fri + Sat from one week's plan and Sun … Thu from the next. Returns
 * the trip that contains `iso` (a Friday returns itself + six; a Wednesday
 * returns the trip that opened on the Friday before it).
 * @param {string} iso YYYY-MM-DD
 * @param {number} [buyDay] 0 Sun … 6 Sat
 * @returns {string[]}
 */
export function tripDates(iso, buyDay = DEFAULT_BUY_DAY) {
  const d = parseLocalIso(iso);
  d.setDate(d.getDate() - ((d.getDay() - buyDay + 7) % 7));
  const out = [];
  for (let i = 0; i < 7; i++) {
    out.push(localIsoDate(d));
    d.setDate(d.getDate() + 1);
  }
  return out;
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
