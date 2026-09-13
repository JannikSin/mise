// PLATE TAILORING, THE DETERMINISTIC HALF (P8 plates).
//
// David, 2026-09-13: "ai tailoring needs to be fixed and better." The 09-07
// breakfast table's tailor told him to add a scoop of protein powder (out of
// the bowl since 08-29) and to build the base from every topping "as cooked".
// Two causes, both fixed here:
//  1. A per-portion dish (the bowl, a smoothie, a plate) has no pot to tailor.
//     Each seat is its own portion of today's list, which is arithmetic, so
//     `bowlTailor` writes those plates and no model is asked.
//  2. A cooked dish's model saw the recipe AS WRITTEN and guessed the rest.
//     `dishContext` hands it the WHOLE POT at the table's real total and
//     `seatSay` each seat's share of it; `screenTailorToDish` then drops any
//     line that names a food the pot does not hold, powders and supplements
//     first. Code enforces it after the model, the same shape as the avoid
//     screen (council 2026-07-23): never an AI judgment.
import { cookPlan, scaleQty } from "./portions.js";
import { rotateComponents, rotates } from "./rotate.js";
import { formatRecipeQty } from "./shopping.js";

/** @typedef {{ id: string, servings?: number, status?: string }} Seat */
/** @typedef {{ portionGrams: number, plate: string[], estCalories: number, estProtein: number }} SeatPlate */
/** @typedef {{ seats: Record<string, SeatPlate>, cook: string[] }} Tailor */

const servingsOf = (/** @type {any} */ s) => {
  const n = Number(s?.servings);
  return Number.isFinite(n) && n > 0 ? n : 1;
};
const liveSeats = (/** @type {Seat[]} */ seats) =>
  (Array.isArray(seats) ? seats : []).filter(
    (s) => s && typeof s.id === "string" && s.id && s.status !== "skipped",
  );

/**
 * Per-seat plates for a dish everyone assembles for themselves: today's list
 * (the rotation's picks on a rotating recipe, the recipe as written
 * otherwise), scaled to the seat's own portion, macros to match.
 * @param {Record<string, any>} recipe
 * @param {Seat[]} seats
 * @param {string} dateIso the table's date, so the rotation is THAT day's
 * @returns {Tailor}
 */
export function bowlTailor(recipe, seats, dateIso) {
  const makes = Math.max(1, Number(recipe?.servings) || 1);
  const chosen = rotates(recipe) ? rotateComponents(recipe.rotation, dateIso) : null;
  const rows = chosen ? chosen.picks : (recipe?.ingredients ?? []);
  const baseCal = chosen ? chosen.macros.calories : Number(recipe?.nutrition?.calories) || 0;
  const basePro = chosen ? chosen.macros.protein : Number(recipe?.nutrition?.protein) || 0;
  /** @type {Record<string, SeatPlate>} */
  const out = {};
  for (const s of liveSeats(seats)) {
    const ratio = servingsOf(s) / makes;
    const line = rows
      .map(
        (/** @type {any} */ c) =>
          `${formatRecipeQty(scaleQty(Number(c.qty) || 0, c.unit, ratio), c.unit)} ${c.food}`,
      )
      .join(" · ");
    out[s.id] = {
      portionGrams: 0,
      plate: [`your own: ${line}`],
      estCalories: Math.round(baseCal * ratio),
      estProtein: Math.round(basePro * ratio),
    };
  }
  return {
    seats: out,
    cook: ["Nothing is shared out of a pot: each person builds their own from today's list."],
  };
}

/**
 * The dish as the model should see it: the WHOLE POT for these seats, at the
 * table's real total, every amount scaled. Per-serving macros stay the
 * recipe's own so the model can weigh a plate honestly.
 * @param {Record<string, any>} recipe
 * @param {Seat[]} seats
 * @returns {{ name: string, servings: number, calories: number, protein: number, carbs: number, fat: number, ingredients: string[] }}
 */
export function dishContext(recipe, seats) {
  const live = liveSeats(seats);
  const total = Math.round(live.reduce((sum, s) => sum + servingsOf(s), 0) * 100) / 100 || 1;
  const pot = cookPlan(recipe, total);
  const n = recipe?.nutrition ?? {};
  return {
    name: String(recipe?.name ?? ""),
    servings: total,
    calories: Number(n.calories) || 0,
    protein: Number(n.protein) || 0,
    carbs: Number(n.carbs) || 0,
    fat: Number(n.fat) || 0,
    ingredients: (pot.ingredients ?? []).map((/** @type {any} */ i) =>
      i.qty ? `${i.qty} ${i.unit ?? "x"} ${i.food}` : String(i.food ?? ""),
    ),
  };
}

/**
 * One seat's line of context (the Worker caps it at 300 characters): its
 * share of the pot and what that share comes to before any adjustment.
 * @param {Record<string, any>} recipe
 * @param {Seat | undefined} seat
 * @param {Seat[]} seats
 * @returns {string}
 */
export function seatSay(recipe, seat, seats) {
  const live = liveSeats(seats);
  const total = Math.round(live.reduce((sum, s) => sum + servingsOf(s), 0) * 100) / 100 || 1;
  const mine = servingsOf(seat);
  const n = recipe?.nutrition ?? {};
  const kcal = Math.round((Number(n.calories) || 0) * mine);
  const pro = Math.round((Number(n.protein) || 0) * mine);
  return (
    `eats ${mine} of the pot's ${total} servings (about ${kcal} kcal / ${pro} g protein ` +
    `before adjustments); adjust only with foods already in the pot`
  );
}

// ---- the after-the-model screen -------------------------------------------

/** words in a food name that carry no identity ("boneless skinless chicken thigh" is chicken thigh) */
const FILLER = new Set([
  "and",
  "with",
  "the",
  "for",
  "fresh",
  "frozen",
  "ground",
  "plain",
  "large",
  "small",
  "medium",
  "whole",
  "chopped",
  "sliced",
  "diced",
  "minced",
  "boneless",
  "skinless",
  "cooked",
  "raw",
  "dry",
  "dried",
  "low",
  "fat",
  "free",
  "extra",
  "virgin",
  "light",
  "canned",
  "mixed",
  "baby",
  "thawed",
  "halved",
  "grated",
  "shredded",
  "toasted",
  "unsweetened",
  "sweet",
  "white",
  "brown",
  "red",
  "green",
  "black",
  "of",
  "or",
  "in",
]);
/** always fair game at the stove, even when the recipe does not list them */
const STAPLES = ["salt", "pepper", "oil", "water", "lemon", "lime", "vinegar", "pasta water"];
/** what a tailor may never add: the 09-07 failure was the first of these */
const NEVER = [
  "protein powder",
  "whey",
  "casein",
  "creatine",
  "supplement",
  "protein shake",
  "protein bar",
  "collagen",
  "mass gainer",
  "powder",
];
/** a line that puts something ON the plate; a portion or an omission does not */
const ADDS =
  /\b(add|adds|added|extra|additional|plus|top(?:ped)? with|on top|on the side|alongside|stir in|mix(?:ed)? in|sprinkle|drizzle|scoop|serve with|side of)\b/i;

/**
 * The identity words of every food in the dish, so "add 150 g cooked rice" is
 * recognised on a dish that lists "1 cup jasmine rice".
 * @param {Record<string, any>} recipe
 * @returns {string[]}
 */
function dishWords(recipe) {
  /** @type {Set<string>} */
  const words = new Set();
  for (const i of recipe?.ingredients ?? []) {
    for (const w of String(i?.food ?? "")
      .toLowerCase()
      .split(/[^a-z]+/)) {
      if (w.length >= 3 && !FILLER.has(w)) words.add(w);
    }
  }
  for (const s of STAPLES) words.add(s);
  return [...words];
}

/**
 * Does the line name a food the pot holds (or a stove staple)? Plural-tolerant
 * both ways: "tomatoes" finds "tomato", "chickpea" finds "chickpeas".
 * @param {string} line
 * @param {string[]} words
 */
function namesDishFood(line, words) {
  const l = line.toLowerCase();
  return words.some((w) => {
    const stem = w.replace(/(es|s)$/, "");
    return stem.length >= 3 && l.includes(stem);
  });
}

/**
 * Drop every tailored line that names a food the pot does not hold: the NEVER
 * list outright (unless the dish itself lists that food), and any line that
 * adds something without naming one of the dish's own foods. Portion lines
 * and omissions pass. A seat left with nothing is dropped, as the avoid
 * screen does; the same rule reads the cook notes.
 * @param {{ seats: Record<string, { portionGrams?: number, plate: string[], estCalories: number, estProtein: number }>, cook: string[] }} tailor
 * @param {Record<string, any>} recipe
 * @returns {Tailor}
 */
export function screenTailorToDish(tailor, recipe) {
  const words = dishWords(recipe);
  const listed = (recipe?.ingredients ?? [])
    .map((/** @type {any} */ i) => String(i?.food ?? "").toLowerCase())
    .join(" | ");
  const banned = NEVER.filter((term) => !listed.includes(term));
  const clean = (/** @type {string} */ line) => {
    const l = line.toLowerCase();
    if (banned.some((term) => l.includes(term))) return false;
    if (ADDS.test(line) && !namesDishFood(line, words)) return false;
    return true;
  };
  /** @type {Record<string, SeatPlate>} */
  const seats = {};
  for (const [id, notes] of Object.entries(tailor?.seats ?? {})) {
    const plate = (notes?.plate ?? []).filter(clean);
    if (plate.length > 0) seats[id] = { ...notes, portionGrams: notes?.portionGrams ?? 0, plate };
  }
  return { seats, cook: (tailor?.cook ?? []).filter(clean) };
}
