// Adherence: the accountability score (David, 2026-07-24). Derived ONLY
// from confirmations that already exist — cookedAt on plan entries and the
// week's shoppedAt receipt stamp. Nothing new to track, nothing stored
// (pure derivation), transparent components, and numbers rather than
// verdict language (the Apple Watch pipeline rule).
//
// 2026-08-09: the daily-log component retired with the in-app check-in —
// David's personal tracking (sleep, weight, water, supplements, the Daily
// Dozen) lives in Crystal now, and scoring the family on a chore the app no
// longer renders would be the exact rig the 2026-08-02 council killed.

import { datesOfWeek } from "./plan.js";

/**
 * One profile's adherence for one week, from days already over (a day is
 * not failed until it has ended, so today never counts against anyone).
 * Weights: cooking 70, the shopping receipt 30 — a component with nothing
 * to measure yet drops out and the rest renormalizes, so a Monday score is
 * honest instead of zero.
 * @param {{
 *   plan: { week: string, shoppedAt?: string, entries: Record<string, any>[] } | null,
 *   weekId: string,
 *   today: string
 * }} args
 * @returns {{ score: number, cooked: { done: number, total: number }, shopped: boolean }}
 */
export function weekAdherence({ plan, weekId, today }) {
  const elapsed = datesOfWeek(weekId).filter((d) => d < today);
  const elapsedSet = new Set(elapsed);

  const cookable = (plan?.entries ?? []).filter(
    (e) => elapsedSet.has(e.date) && e.recipeId && !e.out && !e.table,
  );
  const cooked = {
    done: cookable.filter((e) => e.cookedAt).length,
    total: cookable.length,
  };

  const shopped = Boolean(plan?.shoppedAt);

  // weighted average over the components that have anything to measure;
  // shopping always measures (the receipt either exists or it doesn't)
  const parts = [
    ...(cooked.total > 0 ? [{ w: 70, frac: cooked.done / cooked.total }] : []),
    { w: 30, frac: shopped ? 1 : 0 },
  ];
  const weight = parts.reduce((s, p) => s + p.w, 0);
  const score = Math.round((100 * parts.reduce((s, p) => s + p.w * p.frac, 0)) / weight);

  return { score, cooked, shopped };
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
