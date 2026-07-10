// Daily Dozen habit tally (docs/SCHEMAS.md fitness/daily.json.dozen): the
// four food groups an Opus nutrition audit found recipes alone can't
// reliably deliver — beverages, greens, other fruit, other veg — so David
// checks them off by hand each day, same as pushups/water. Pure helpers
// only; the stepper UI lives in app/views/dozen-tally.js.

/** The four hand-tracked categories, display order. Recipe-deliverable
 * categories (beans, wholeGrains, etc.) are already covered by
 * generateWeek's foodGroupGaps and don't need a manual tally.
 * @type {{ key: string, label: string }[]} */
export const DOZEN_GROUPS = [
  { key: "beverages", label: "Beverages" },
  { key: "greens", label: "Greens" },
  { key: "otherFruit", label: "Other fruit" },
  { key: "otherVeg", label: "Other veg" },
];

/**
 * Servings still needed today per hand-tracked category, floored at 0.
 * Reads goals from fitness/targets.json's dailyDozen block; a missing
 * target reads as already met (0 remaining), never a fabricated goal.
 * @param {Record<string, any> | undefined} day
 * @param {Record<string, any> | null} targets
 * @returns {Record<string, number>}
 */
export function dozenRemaining(day, targets) {
  const have = day?.dozen ?? {};
  const goals = targets?.dailyDozen ?? {};
  /** @type {Record<string, number>} */
  const out = {};
  for (const { key } of DOZEN_GROUPS) {
    out[key] = Math.max(0, (goals[key] ?? 0) - (have[key] ?? 0));
  }
  return out;
}
