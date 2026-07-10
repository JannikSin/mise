// Shared JSDoc @typedefs mirroring docs/SCHEMAS.md, for shapes new enough
// (Phase 1) that no single lib file owns them yet. Single-file shapes stay
// colocated at their point of use (see app/lib/plan.js, app/lib/fitness.js,
// etc.) per mise-conventions: only add here what's genuinely cross-cutting.

/**
 * Daily Dozen servings a recipe provides per serving (docs/SCHEMAS.md,
 * `recipes/<id>.json`.foodGroups).
 * @typedef {{
 *   beans: number,
 *   berries: number,
 *   otherFruit: number,
 *   cruciferousVeg: number,
 *   greens: number,
 *   otherVeg: number,
 *   flaxseed: number,
 *   nuts: number,
 *   spicesHerbs: number,
 *   wholeGrains: number,
 *   beverages: number,
 *   method: "estimated" | "book-verified"
 * }} FoodGroups
 */

/**
 * `plans/<week>.json` entry, extended with the optional `pinned` flag
 * (docs/SCHEMAS.md): true means GENERATE WEEK must never clear or overwrite
 * this entry. Absent = unpinned (today's default behavior, unchanged). The
 * base shape still lives in app/lib/plan.js as `PlanEntry`; this is that
 * type intersected with the new field.
 * @typedef {import("./lib/plan.js").PlanEntry & { pinned?: boolean }} PinnedPlanEntry
 */

/**
 * Weekday -> templateId map, fixed rotation (docs/SCHEMAS.md,
 * `fitness/workouts.json`.schedule). null = rest day.
 * @typedef {{
 *   mon: string | null,
 *   tue: string | null,
 *   wed: string | null,
 *   thu: string | null,
 *   fri: string | null,
 *   sat: string | null,
 *   sun: string | null
 * }} WorkoutSchedule
 */

export {};
