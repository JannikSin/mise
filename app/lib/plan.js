// Weekly plan operations (plans/<week>.json). Entries carry a unique id —
// the key mergeFieldWise prefers — so multiple entries may STACK in the same
// date+slot and two devices editing the same week merge cleanly.
import { isoWeekId } from "./dates.js";

/**
 * @typedef {{ id: string, date: string, slot: string, recipeId?: string, freeText?: string, servings: number }} PlanEntry
 * @typedef {{ week: string, entries: PlanEntry[] }} Plan
 */

/** The valid slot keys, in display order (docs/SCHEMAS.md plan section). */
export const SLOT_KEYS = ["breakfast", "lunch", "dinner", "smoothie", "snack"];

/**
 * Monday..Sunday ISO dates of an ISO week id like "2026-W28".
 * @param {string} weekId
 * @returns {string[]}
 */
export function datesOfWeek(weekId) {
  const m = weekId.match(/^(\d{4})-W(\d{2})$/);
  if (!m) return [];
  const isoYear = Number(m[1]);
  const week = Number(m[2]);
  // ISO 8601: week 1 contains Jan 4; weeks start Monday
  const jan4 = new Date(isoYear, 0, 4);
  const week1Monday = new Date(isoYear, 0, 4 - ((jan4.getDay() + 6) % 7));
  const out = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(week1Monday);
    d.setDate(week1Monday.getDate() + (week - 1) * 7 + i);
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    out.push(`${d.getFullYear()}-${mm}-${dd}`);
  }
  return out;
}

/**
 * ISO week id shifted by n weeks — derived from datesOfWeek/isoWeekId so the
 * week-1 math lives in exactly one place.
 * @param {string} weekId
 * @param {number} delta
 * @returns {string}
 */
export function shiftWeek(weekId, delta) {
  const monday = datesOfWeek(weekId)[0];
  const d = new Date(`${monday}T12:00:00`);
  d.setDate(d.getDate() + delta * 7);
  return isoWeekId(d);
}

/** @returns {string} unique-per-device entry id */
function genId() {
  return crypto.randomUUID().slice(0, 8);
}

/**
 * Deterministic id for a legacy (pre-id) entry: two devices independently
 * self-healing the same file MUST agree on ids, or id-keyed merges would
 * duplicate entries and resurrect deletions. FNV-1a over the entry's stable
 * content plus its index among identical twins.
 * @param {Record<string, any>} e
 * @param {number} twinIndex
 * @returns {string}
 */
function legacyId(e, twinIndex) {
  const s = `${e.date}|${e.slot}|${e.recipeId ?? ""}|${e.freeText ?? ""}|${e.servings}|${twinIndex}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `l${h.toString(16).padStart(8, "0")}`;
}

/**
 * Append a planned item; entries stack, nothing is replaced. Pure.
 * @param {Plan} plan
 * @param {string} date
 * @param {string} slot
 * @param {{ recipeId?: string, freeText?: string, servings: number }} content
 * @returns {Plan}
 */
export function addEntry(plan, date, slot, content) {
  return { ...plan, entries: [...plan.entries, { id: genId(), date, slot, ...content }] };
}

/**
 * @param {Plan} plan
 * @param {string} id
 * @returns {Plan}
 */
export function removeEntryById(plan, id) {
  return { ...plan, entries: plan.entries.filter((e) => e.id !== id) };
}

/**
 * @param {Plan} plan
 * @param {string} id
 * @param {string} date
 * @param {string} slot
 * @returns {Plan}
 */
export function moveEntry(plan, id, date, slot) {
  return {
    ...plan,
    entries: plan.entries.map((e) => (e.id === id ? { ...e, date, slot } : e)),
  };
}

/**
 * Shape a freshly-read (or absent) plan file: guarantees week + entries and
 * self-heals pre-id legacy entries by assigning ids (persisted on next write).
 * @param {Record<string, any> | null} raw
 * @param {string} weekId
 * @returns {Plan}
 */
export function normalizePlan(raw, weekId) {
  if (!raw || !Array.isArray(raw.entries)) return { week: weekId, entries: [] };
  /** @type {Map<string, number>} */
  const twinCounts = new Map();
  return {
    week: typeof raw.week === "string" ? raw.week : weekId,
    entries: raw.entries.map((/** @type {any} */ e) => {
      if (typeof e.id === "string") return e;
      const contentKey = `${e.date}|${e.slot}|${e.recipeId ?? ""}|${e.freeText ?? ""}|${e.servings}`;
      const twinIndex = twinCounts.get(contentKey) ?? 0;
      twinCounts.set(contentKey, twinIndex + 1);
      return { ...e, id: legacyId(e, twinIndex) };
    }),
  };
}

/**
 * @param {PlanEntry[]} entries
 * @param {string} date
 * @param {string} slot
 * @returns {PlanEntry[]}
 */
export function entriesAt(entries, date, slot) {
  return entries.filter((e) => e.date === date && e.slot === slot);
}

/**
 * Planned calories/protein for one day. freeText and unknown recipes count 0.
 * @param {PlanEntry[]} entries
 * @param {Map<string, any>} recipesById
 * @param {string} date
 * @returns {{ calories: number, protein: number }}
 */
export function dayTotals(entries, recipesById, date) {
  let calories = 0;
  let protein = 0;
  for (const e of entries) {
    if (e.date !== date || !e.recipeId) continue;
    const n = recipesById.get(e.recipeId)?.nutrition;
    if (!n) continue;
    calories += (n.calories ?? 0) * e.servings;
    protein += (n.protein ?? 0) * e.servings;
  }
  return { calories, protein };
}
