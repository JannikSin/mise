// Adherence: the accountability score (David, 2026-07-24). Derived ONLY
// from confirmations that already exist — cookedAt on plan entries, the
// week's shoppedAt receipt stamp, and the daily check-in log. Nothing new
// to track, nothing stored (pure derivation), transparent components, and
// numbers rather than verdict language (the Apple Watch pipeline rule).
// Every profile is scored with the same yardstick so the household
// scoreboard is a fair competition.

import { datesOfWeek } from "./plan.js";

/** the four daily-log tracks the score counts, same for everyone */
const LOG_TRACKS = ["weight", "pushups", "water", "supplements"];

/**
 * Whether one day's log has a given track filled.
 * @param {Record<string, any>} day
 * @param {string} track
 * @returns {boolean}
 */
function logged(day, track) {
  if (track === "supplements") return Object.values(day.supplements ?? {}).some(Boolean);
  const v = day[track];
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
 *   today: string
 * }} args
 * @returns {{ score: number, cooked: { done: number, total: number }, logged: { done: number, total: number }, shopped: boolean }}
 */
export function weekAdherence({ plan, daily, weekId, today }) {
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
  const logCells = elapsed.length * LOG_TRACKS.length;
  let logDone = 0;
  for (const date of elapsed) {
    const day = days.find((d) => d.date === date) ?? {};
    for (const track of LOG_TRACKS) if (logged(day, track)) logDone++;
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
