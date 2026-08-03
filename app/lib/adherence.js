// Adherence: the accountability score (David, 2026-07-24). Derived ONLY
// from confirmations that already exist — cookedAt on plan entries, the
// week's shoppedAt receipt stamp, and the daily check-in log. Nothing new
// to track, nothing stored (pure derivation), transparent components, and
// numbers rather than verdict language (the Apple Watch pipeline rule).
// Every profile is scored by the same RULES against its OWN declared
// tracks — the yardstick is shared, the chores are theirs. Scoring someone
// on inputs their app never renders is not a competition, it is a rig.

import { datesOfWeek } from "./plan.js";

/**
 * The daily-log tracks the score counted before 2026-08-02, kept as the
 * default so a profile without `targets.tracks` (David, legacy installs)
 * scores exactly as before. The council caught the hard-coded version
 * scoring Mom on pushups and supplements her own check-in never renders —
 * her ceiling was 85 in a "fair" competition. A profile is now scored ONLY
 * on tracks it declares (the same list that decides what Home shows).
 */
const DEFAULT_LOG_TRACKS = ["weight", "pushups", "water", "supplements"];

/** targets.tracks values that are daily-loggable, mapped to their day field */
const TRACK_FIELDS = /** @type {Record<string, string>} */ ({
  weight: "weight",
  waist: "waist",
  pushups: "pushups",
  water: "water",
  sleep: "sleepHours",
  supplements: "supplements",
  dailyDozen: "dozen",
});

/**
 * Whether one day's log has a given track filled.
 * @param {Record<string, any>} day
 * @param {string} track
 * @returns {boolean}
 */
function logged(day, track) {
  if (track === "supplements") return Object.values(day.supplements ?? {}).some(Boolean);
  if (track === "dailyDozen")
    return Object.values(day.dozen ?? {}).some((v) => typeof v === "number" && v > 0);
  const v = day[TRACK_FIELDS[track] ?? track];
  return typeof v === "number" && v > 0;
}

/**
 * One profile's adherence for one week, from days already over (a day is
 * not failed until it has ended, so today never counts against anyone).
 * Weights: cooking 50, logging 30, the shopping receipt 20 — components
 * with nothing to measure yet drop out and the rest renormalize, so a
 * Monday score is honest instead of zero.
 * @param {{
 *   plan: { week: string, shoppedAt?: string, entries: Record<string, any>[] } | null,
 *   daily: { days?: Record<string, any>[] } | null,
 *   weekId: string,
 *   today: string,
 *   tracks?: string[]
 * }} args `tracks` = the profile's own targets.tracks; absent = the legacy
 *   four, and unknown values are ignored so a future track can't zero a score
 * @returns {{ score: number, cooked: { done: number, total: number }, logged: { done: number, total: number }, shopped: boolean }}
 */
export function weekAdherence({ plan, daily, weekId, today, tracks }) {
  const logTracks = (tracks ?? DEFAULT_LOG_TRACKS).filter((t) => t in TRACK_FIELDS);
  const elapsed = datesOfWeek(weekId).filter((d) => d < today);
  const elapsedSet = new Set(elapsed);

  const cookable = (plan?.entries ?? []).filter(
    (e) => elapsedSet.has(e.date) && e.recipeId && !e.out && !e.table,
  );
  const cooked = {
    done: cookable.filter((e) => e.cookedAt).length,
    total: cookable.length,
  };

  const days = daily?.days ?? [];
  const logCells = elapsed.length * logTracks.length;
  let logDone = 0;
  for (const date of elapsed) {
    const day = days.find((d) => d.date === date) ?? {};
    for (const track of logTracks) if (logged(day, track)) logDone++;
  }
  const log = { done: logDone, total: logCells };

  const shopped = Boolean(plan?.shoppedAt);

  // weighted average over the components that have anything to measure;
  // shopping always measures (the receipt either exists or it doesn't)
  const parts = [
    ...(cooked.total > 0 ? [{ w: 50, frac: cooked.done / cooked.total }] : []),
    ...(log.total > 0 ? [{ w: 30, frac: log.done / log.total }] : []),
    { w: 20, frac: shopped ? 1 : 0 },
  ];
  const weight = parts.reduce((s, p) => s + p.w, 0);
  const score = Math.round((100 * parts.reduce((s, p) => s + p.w * p.frac, 0)) / weight);

  return { score, cooked, logged: log, shopped };
}

/**
 * Sort a household's entries into the scoreboard (highest first, name as
 * the tiebreaker so the order is stable and undramatic).
 * @template {{ score: number, name: string }} T
 * @param {T[]} rows
 * @returns {T[]}
 */
export function rankScoreboard(rows) {
  return [...rows].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}
