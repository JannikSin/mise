// THE NETWORK HALF OF P10.
//
// `dininghall.js` is the pure composer and it has been correct and tested
// since it shipped. It had ZERO importers: nothing in the app fetched a menu,
// so choosing a dining hall and getting a tray was not something a person
// could do. That is the synth.js failure again, and this is the half that
// makes the other half reachable.
//
// The fetches live here rather than in the view because the item endpoint is
// the only place nutrition exists, so composing one tray means one request per
// candidate item. That needs bounding and caching, neither of which belongs
// in a render function.
//
// THE WORKER IS IN THE PATH, and I argued it should not be an hour before
// writing this. **Purdue's API sends no Access-Control-Allow-Origin.** It is
// public and keyless, so curl and node reach it happily and a browser will
// not. The CSP already allowed api.hfs.purdue.edu and that was never the
// blocker. The first click on a real device said "Failed to fetch", which is
// what found it.
//
// The proxy also turns ~40 item lookups into one round trip, which matters
// more on dorm wifi than it does here.

import { itemsForMeal, parseItem } from "./dininghall.js";
import { hallDay, hallItems } from "./worker.js";

/**
 * Purdue's residential dining courts. Names are the API's own location
 * segment, which is also what a person calls them.
 * @type {{ id: string, label: string }[]}
 */
export const COURTS = [
  { id: "Earhart", label: "Earhart" },
  { id: "Ford", label: "Ford" },
  { id: "Hillenbrand", label: "Hillenbrand" },
  { id: "Wiley", label: "Wiley" },
  { id: "Windsor", label: "Windsor" },
];

/** The meals a court publishes. "Late Lunch" only exists at some courts. */
export const MEALS = ["Breakfast", "Lunch", "Late Lunch", "Dinner"];

/** per-session item cache: the same dish recurs across courts and days */
const itemCache = new Map();

/**
 * One court's published menu for one date.
 * @param {string} court
 * @param {string} dateIso
 * @returns {Promise<Record<string, any>>}
 */
export async function fetchDay(court, dateIso) {
  return hallDay(court, dateIso);
}

/**
 * Which meals that day actually has, so the picker offers real choices rather
 * than a fixed list a court may not serve.
 * @param {Record<string, any> | null} day
 * @returns {string[]}
 */
export function mealsOn(day) {
  return (day?.Meals ?? [])
    .filter((/** @type {any} */ m) => String(m?.Status ?? "").toLowerCase() !== "closed")
    .map((/** @type {any} */ m) => String(m?.Name ?? m?.Type ?? ""))
    .filter(Boolean);
}

/**
 * Fetch nutrition for a meal's items.
 *
 * BOUNDED ON PURPOSE. A dinner menu runs to ~45 items and each needs its own
 * request; an unbounded fan-out from a phone on dorm wifi is how this feature
 * would earn a reputation for hanging. Items the hall published no numbers for
 * are dropped by the composer anyway, so they are not fetched.
 * @param {{ id: string, name: string, nutritionReady: boolean }[]} items
 * @param {{ max?: number, onProgress?: (done: number, total: number) => void }} [opts]
 */
export async function fetchNutrition(items, opts = {}) {
  const max = Math.max(1, opts.max ?? 60);
  const wanted = items.filter((i) => i.nutritionReady !== false).slice(0, max);
  const missing = wanted.filter((i) => !itemCache.has(i.id));
  if (missing.length > 0) {
    opts.onProgress?.(0, missing.length);
    const raw = await hallItems(missing.map((i) => i.id));
    for (const j of raw) {
      const parsed = parseItem(j);
      // the id lives on the payload; match on it rather than on order, which
      // the batch does not promise
      const id = String(j?.ID ?? j?.Id ?? j?.id ?? "");
      if (parsed && id) itemCache.set(id, parsed);
    }
    opts.onProgress?.(missing.length, missing.length);
  }
  const out = [];
  for (const it of wanted) {
    const parsed = itemCache.get(it.id);
    if (parsed) out.push({ ...it, ...parsed });
  }
  return out;
}

/**
 * Everything the view needs for one court + meal, in one call.
 * @param {string} court
 * @param {string} dateIso
 * @param {string} mealType
 * @param {{ onProgress?: (done: number, total: number) => void }} [opts]
 */
export async function loadMeal(court, dateIso, mealType, opts = {}) {
  const day = await fetchDay(court, dateIso);
  const listed = itemsForMeal(day, mealType);
  const priced = await fetchNutrition(listed, opts);
  return { day, listed, priced, published: day?.IsPublished !== false };
}

/**
 * What a tray at this meal should aim for: the day's remaining need, not the
 * whole day. Falls back to an even split across the profile's meal slots when
 * nothing has been eaten yet.
 * @param {{ calories: number, protein: number }} dayTarget
 * @param {{ calories: number, protein: number }} already what the rest of the day already provides
 * @param {number} slotsLeft
 * @returns {{ calories: number, protein: number }}
 */
export function quotaFor(dayTarget, already, slotsLeft) {
  const left = Math.max(1, slotsLeft || 1);
  const cal = Math.max(0, (dayTarget.calories || 0) - (already.calories || 0));
  const pro = Math.max(0, (dayTarget.protein || 0) - (already.protein || 0));
  return { calories: Math.round(cal / left), protein: Math.round(pro / left) };
}
