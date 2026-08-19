// The weekly review, read side (fix list 7.1, promise P11): everything
// tracked comes back once a week — cooked against planned, spent against
// budgeted, tossed against used, stated cook time against recorded, and what
// the scale did. This module only COMPOSES from data other systems already
// wrote (cookedAt/cookSeconds, plan.spend, the waste ledger, daily weigh-ins);
// it never invents a number, and every axis says so when its data is dark.
// Still open in 7.1: the fridge photo, free-text comments, and generation
// demonstrably reading the output — the write side of the loop.

/**
 * @param {{
 *   plan: import("./plan.js").Plan | null,
 *   waste: { events?: { date: string, food: string }[] } | null,
 *   daily: { days?: Record<string, any>[] } | null,
 *   targets: Record<string, any> | null,
 *   weekDates: string[],
 *   recipesById?: Map<string, any>,
 * }} inputs
 * @returns {{
 *   hasData: boolean,
 *   cooked: { done: number, planned: number },
 *   spend: { total: number, receipts: number, budget: number | null } | null,
 *   tossed: { count: number, foods: string[] },
 *   time: { timed: number, statedMin: number, recordedMin: number } | null,
 *   weighIns: { count: number, days: number },
 * }}
 */
export function composeWeekReview({ plan, waste, daily, targets, weekDates, recipesById }) {
  const dates = new Set(weekDates);
  const entries = (plan?.entries ?? []).filter((e) => dates.has(e.date));
  // planned = meals that were REAL cooking commitments: recipe entries,
  // not out/away placeholders and not someone else's table
  const planned = entries.filter((e) => e.recipeId && !e.out && !e.table);
  const done = planned.filter((e) => e.cookedAt);

  const receipts = (Array.isArray(/** @type {any} */ (plan)?.spend) ? /** @type {any} */ (plan).spend : []).filter(
    (/** @type {any} */ s) => dates.has(s.date),
  );
  const spend =
    receipts.length > 0
      ? {
          total:
            Math.round(
              receipts.reduce(
                (/** @type {number} */ s, /** @type {any} */ r) => s + (Number(r.total) || 0),
                0,
              ) * 100,
            ) / 100,
          receipts: receipts.length,
          budget: typeof targets?.weeklyBudgetUsd === "number" ? targets.weeklyBudgetUsd : null,
        }
      : null;

  const tossedEvents = (waste?.events ?? []).filter((ev) => dates.has(ev.date));
  const tossed = {
    count: tossedEvents.length,
    foods: [...new Set(tossedEvents.map((ev) => ev.food))].slice(0, 6),
  };

  // stated vs recorded, only over meals the timer actually timed — a
  // partial sample is labelled as one, never extrapolated
  const timed = done.filter((e) => (e.cookSeconds ?? 0) > 0);
  const time =
    timed.length > 0
      ? {
          timed: timed.length,
          statedMin: Math.round(
            timed.reduce(
              (s, e) => s + (recipesById?.get(e.recipeId ?? "")?.totalTime ?? 0),
              0,
            ),
          ),
          recordedMin: Math.round(timed.reduce((s, e) => s + (e.cookSeconds ?? 0) / 60, 0)),
        }
      : null;

  const weighIns = {
    count: (daily?.days ?? []).filter((d) => dates.has(d.date) && (d.weight ?? 0) > 0).length,
    days: weekDates.length,
  };

  const hasData =
    planned.length > 0 || receipts.length > 0 || tossedEvents.length > 0 || weighIns.count > 0;
  return { hasData, cooked: { done: done.length, planned: planned.length }, spend, tossed, time, weighIns };
}
