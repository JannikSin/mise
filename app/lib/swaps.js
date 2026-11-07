// USE WHAT YOU HAVE, OR ARE ALREADY BUYING (P5, P6, P4).
//
// David, 2026-11-07: "the whole point of the mise app is to make changes to
// recipies to uswe ingridients you already have or already are buying. so
// yes that is the wholepoint and look into more changes to make."
//
// When the planner sets a week, each dish it wrote may trade one ingredient
// for a like-for-like one the kitchen already holds (the Costco walnuts, his
// dates) or is already buying that week for another dish (the Greek yogurt
// that is on the list anyway). The swap is stored ON THE TABLE, beside the
// plating ratio, so the List, the plates, the recipe page and every phone
// read the same dish (withSwaps, applied after withRatio everywhere a table's
// dish is read).
//
// A swap is kept only when ALL of these hold:
//   1. the new food is owned (pantry) or already on this week's buy;
//   2. it saves money at real package prices (the package the old food would
//      have needed, less any extra package of the new one);
//   3. it adds no allergy, avoid or diet conflict for anyone at the table
//      (the same recipeConflicts screen the planner uses), and never brings a
//      nut into a dish that had none (Elliot, 10/27: "tree nuts are off");
//   4. every seat's day stays inside its calorie and protein band (David:
//      protein 190 to 215 g on everything eaten, swipe included).
// Chickpeas are never a swap target (David, 11/6, refused the chickpea swap).
// Pure: no IO, no clock.

import { canonicalFood, toGrams, toPreferred } from "./ingredients.js";
import { recipeConflicts } from "./plan.js";
import { enforcedCeilings, enforcedFloors } from "./targets.js";

/**
 * Per 100 g: kcal, protein, carbs, fat. Ordinary USDA figures, used only to
 * move a dish's nutrition by the difference a swap makes.
 * @type {Record<string, [number, number, number, number]>}
 */
const MACROS = {
  "almond-butter": [614, 21, 19, 56],
  walnuts: [654, 15, 14, 65],
  pecans: [691, 9, 14, 72],
  almonds: [579, 21, 22, 50],
  "sliced-almonds": [579, 21, 22, 50],
  "slivered-almonds": [579, 21, 22, 50],
  "cottage-cheese": [84, 11, 4, 2.3],
  "greek-yogurt": [73, 10, 4, 2],
  "plain-low-fat-yogurt": [63, 5.3, 7, 1.6],
  "chocolate-chips": [480, 4.2, 63, 30],
  dates: [277, 1.8, 75, 0.2],
  raisins: [299, 3.1, 79, 0.5],
  "maple-syrup": [260, 0, 67, 0],
  honey: [304, 0.3, 82, 0],
  "chia-seeds": [486, 17, 42, 31],
  "ground-flaxseed": [534, 18, 29, 42],
  "pumpkin-seeds": [559, 30, 11, 49],
  "sunflower-seeds": [584, 21, 20, 51],
  kale: [49, 4.3, 9, 0.9],
  "baby-spinach": [23, 2.9, 3.6, 0.4],
  "red-onion": [40, 1.1, 9.3, 0.1],
  shallot: [72, 2.5, 17, 0.1],
  onion: [40, 1.1, 9.3, 0.1],
  "lemon-juice": [22, 0.4, 6.9, 0.2],
  "lime-juice": [25, 0.4, 8.4, 0.1],
  "black-beans": [91, 6, 16.6, 0.3],
  "kidney-beans": [84, 5.2, 15, 0.4],
  "cannellini-beans": [114, 7.4, 21, 0.4],
  "ground-beef": [215, 18.6, 0, 15],
  "ground-turkey": [150, 18.7, 0, 8.3],
  "chicken-breast": [120, 22.5, 0, 2.6],
  "chicken-thigh": [121, 19.7, 0, 4.1],
  "chicken-broth": [6, 0.6, 0.4, 0.2],
  "vegetable-broth": [5, 0.1, 0.9, 0.1],
  "unsweetened-soy-milk": [33, 2.9, 1.2, 1.8],
  milk: [50, 3.3, 4.8, 2],
};

/** How a swap target is written on the List and the recipe page. */
const NAME = /** @type {Record<string, string>} */ ({
  walnuts: "walnuts",
  pecans: "pecans",
  almonds: "almonds",
  "greek-yogurt": "greek yogurt",
  dates: "dates",
  honey: "honey",
  "chia-seeds": "chia seeds",
  "ground-flaxseed": "ground flaxseed",
  "pumpkin-seeds": "pumpkin seeds",
  "sunflower-seeds": "sunflower seeds",
  kale: "kale",
  "baby-spinach": "baby spinach",
  onion: "onion",
  "lemon-juice": "lemon juice",
  "lime-juice": "lime juice",
  "black-beans": "black beans",
  "kidney-beans": "kidney beans",
  "cannellini-beans": "cannellini beans",
  "ground-beef": "ground beef",
  "ground-turkey": "ground turkey",
  "chicken-breast": "chicken breast",
  "chicken-thigh": "chicken thigh",
  "chicken-broth": "chicken broth",
  "vegetable-broth": "vegetable broth",
  milk: "milk",
});
const NUTS = ["walnuts", "pecans", "almonds"];
const BEANS = ["black-beans", "kidney-beans", "cannellini-beans"];
/**
 * Like-for-like swaps, by canonical key: same job in the dish, swapped by
 * weight. First listed is tried first.
 * @type {Record<string, string[]>}
 */
export const SWAP_TABLE = {
  "almond-butter": NUTS,
  walnuts: ["pecans", "almonds"],
  pecans: ["walnuts", "almonds"],
  almonds: ["walnuts", "pecans"],
  "sliced-almonds": ["almonds", "walnuts", "pecans"],
  "slivered-almonds": ["almonds", "walnuts", "pecans"],
  "cottage-cheese": ["greek-yogurt"],
  "plain-low-fat-yogurt": ["greek-yogurt"],
  "chocolate-chips": ["dates"],
  raisins: ["dates"],
  "maple-syrup": ["honey"],
  "chia-seeds": ["ground-flaxseed"],
  "ground-flaxseed": ["chia-seeds"],
  "pumpkin-seeds": ["sunflower-seeds"],
  "sunflower-seeds": ["pumpkin-seeds"],
  kale: ["baby-spinach"],
  "baby-spinach": ["kale"],
  "red-onion": ["onion"],
  shallot: ["onion"],
  "lemon-juice": ["lime-juice"],
  "lime-juice": ["lemon-juice"],
  "black-beans": BEANS.filter((b) => b !== "black-beans"),
  "kidney-beans": BEANS.filter((b) => b !== "kidney-beans"),
  "cannellini-beans": BEANS.filter((b) => b !== "cannellini-beans"),
  "ground-beef": ["ground-turkey"],
  "ground-turkey": ["ground-beef"],
  "chicken-breast": ["chicken-thigh"],
  "chicken-thigh": ["chicken-breast"],
  "vegetable-broth": ["chicken-broth"],
  "chicken-broth": ["vegetable-broth"],
  "unsweetened-soy-milk": ["milk"],
};

// THE DISH KEEPS ITS NAME: a food the recipe is named for is never swapped
// ("Tuscan White Bean Minestrone" stays white bean; "Almond Butter Cocoa
// Bars" keeps the almond butter). The words a title uses for each food.
/** @type {Record<string, string[]>} */
const TITLE_WORDS = {
  "almond-butter": ["almond butter", "almond"],
  "cottage-cheese": ["cottage"],
  "chocolate-chips": ["chocolate chip"],
  "cannellini-beans": ["cannellini", "white bean"],
  "black-beans": ["black bean"],
  "kidney-beans": ["kidney"],
  "ground-beef": ["beef"],
  "ground-turkey": ["turkey"],
  "chicken-breast": ["chicken breast"],
  "chicken-thigh": ["thigh"],
  "baby-spinach": ["spinach"],
  "maple-syrup": ["maple"],
  "lemon-juice": ["lemon"],
  "lime-juice": ["lime"],
  "red-onion": ["red onion"],
  "pumpkin-seeds": ["pumpkin seed"],
  "sunflower-seeds": ["sunflower"],
  "chia-seeds": ["chia"],
  "ground-flaxseed": ["flax"],
};
/** @param {string} name @param {string} key */
export function namedFor(name, key) {
  const title = String(name ?? "").toLowerCase();
  const words = TITLE_WORDS[key] ?? [key.replace(/-/g, " ").replace(/s$/, "")];
  return words.some((w) => title.includes(w));
}

const NUT_RE = /\b(almond|walnut|pecan|cashew|pistachio|hazelnut|macadamia|brazil nut|peanut)/i;

/**
 * @typedef {{ from: string, to: string, grams: number, why: "have" | "buying", saved: number }} Swap
 *   `from` and `to` are canonical keys; `grams` is the weight swapped in the
 *   recipe AS WRITTEN (before any plating ratio); `saved` is the trip saving
 *   in dollars when it was chosen.
 */

/**
 * The dish with its table's swaps applied: each swapped ingredient becomes
 * the new food by weight, in that food's list unit, and the nutrition moves
 * by the difference. Apply AFTER withRatio. Unknown swaps are ignored.
 * @param {Record<string, any> | undefined} recipe
 * @param {Swap[] | undefined} swaps
 * @returns {Record<string, any> | undefined}
 */
export function withSwaps(recipe, swaps) {
  if (!recipe || !Array.isArray(swaps) || swaps.length === 0) return recipe;
  const n = { ...(recipe.nutrition ?? {}) };
  const per = Number(recipe.servings) || 1;
  let changed = false;
  const ingredients = (recipe.ingredients ?? []).map((/** @type {Record<string, any>} */ ing) => {
    const key = canonicalFood(String(ing.food ?? ""));
    const s = swaps.find((x) => x.from === key);
    if (!s || !MACROS[s.from] || !MACROS[s.to]) return ing;
    const g = toGrams(Number(ing.qty), String(ing.unit), key);
    if (g == null || !(g > 0)) return ing;
    const out = toPreferred(g, "g", s.to) ?? { qty: g, unit: "g" };
    const [k1, p1, c1, f1] = /** @type {[number, number, number, number]} */ (MACROS[s.from]);
    const [k2, p2, c2, f2] = /** @type {[number, number, number, number]} */ (MACROS[s.to]);
    n.calories = (Number(n.calories) || 0) + ((k2 - k1) * g) / 100 / per;
    n.protein = (Number(n.protein) || 0) + ((p2 - p1) * g) / 100 / per;
    n.carbs = (Number(n.carbs) || 0) + ((c2 - c1) * g) / 100 / per;
    n.fat = (Number(n.fat) || 0) + ((f2 - f1) * g) / 100 / per;
    changed = true;
    const { note: _drop, ...rest } = ing;
    void _drop;
    return {
      ...rest,
      food: NAME[s.to] ?? s.to,
      qty: Math.round(out.qty * 100) / 100,
      unit: out.unit,
      note: `in place of ${String(ing.food)}${s.why === "have" ? ", from what you have" : ", already on the list"}`,
      swappedFrom: String(ing.food),
      swapWhy: s.why,
    };
  });
  if (!changed) return recipe;
  for (const k of ["calories", "protein", "carbs", "fat"]) {
    if (k in n) n[k] = Math.round(Number(n[k]) * 10) / 10;
  }
  return { ...recipe, ingredients, nutrition: n, swaps };
}

/**
 * The swap pass of a week the planner just set.
 * @param {{
 *   tables: Record<string, any>[],
 *   fresh: Set<string>,
 *   dishOf: (t: Record<string, any>) => Record<string, any> | undefined,
 *   targetsById: Map<string, any>,
 *   report: Record<string, any>[],
 *   held: (food: string, grams: number) => boolean,
 *   priceNeed: (food: string, qty: number, unit: string) => number,
 * }} args `tables` = the week's tables (all of them, for the demand);
 *   `fresh` = ids of tables this run wrote, the only ones that may change;
 *   `dishOf` = a table's dish as planned (withRatio applied, no swaps)
 * @returns {{ tables: Record<string, any>[], chosen: { tableId: string, recipeId: string, date: string, slot: string, swap: Swap }[] }}
 */
export function assignSwaps(args) {
  const { tables, fresh, dishOf, targetsById, report, held, priceNeed } = args;
  const byId = new Map(tables.map((t) => [String(t.id), { ...t }]));
  const potOf = (/** @type {Record<string, any>} */ t) =>
    t.leftoverOf ? byId.get(String(t.leftoverOf)) : t;
  const servingsOf = (/** @type {Record<string, any>} */ t) =>
    (t.seats ?? [])
      .filter((/** @type {any} */ s) => s.status !== "skipped")
      .reduce((/** @type {number} */ a, /** @type {any} */ s) => a + (Number(s.servings) || 0), 0);
  // each pot's servings: its own seats plus every leftover night it feeds
  /** @type {Map<string, number>} */
  const potServings = new Map();
  for (const t of byId.values()) {
    const pot = potOf(t);
    if (!pot) continue;
    potServings.set(String(pot.id), (potServings.get(String(pot.id)) ?? 0) + servingsOf(t));
  }
  // the week's demand in grams, by canonical food
  /** @type {Map<string, number>} */
  const demand = new Map();
  /** @type {Map<string, Record<string, any>>} */
  const dishes = new Map();
  for (const t of byId.values()) {
    if (t.leftoverOf) continue;
    const dish = withSwaps(dishOf(t), t.swaps);
    if (!dish) continue;
    dishes.set(String(t.id), /** @type {Record<string, any>} */ (dishOf(t)));
    const scale = (potServings.get(String(t.id)) ?? 0) / (Number(dish.servings) || 1);
    for (const ing of dish.ingredients ?? []) {
      const key = canonicalFood(String(ing.food ?? ""));
      const g = toGrams(Number(ing.qty), String(ing.unit), key);
      if (g != null && g > 0) demand.set(key, (demand.get(key) ?? 0) + g * scale);
    }
  }
  const cost = (/** @type {string} */ key, /** @type {number} */ g) => {
    if (g <= 0.5) return 0;
    if (held(NAME[key] ?? key.replace(/-/g, " "), g)) return 0;
    return priceNeed(NAME[key] ?? key.replace(/-/g, " "), g, "g") || 0;
  };
  /** @type {{ tableId: string, recipeId: string, date: string, slot: string, swap: Swap }[]} */
  const chosen = [];
  const rows = (/** @type {string} */ date, /** @type {string} */ seatId) =>
    report.find((r) => r.date === date && r.seatId === seatId);

  // ONE DISH, ONE DECISION: the same recipe on the same plating across the
  // week is one batch (seven daily muffin tables are one bake), so it is
  // judged and swapped together. Judged a table at a time, no single day's
  // share ever freed a whole jar of almond butter.
  /** @type {Map<string, Record<string, any>[]>} */
  const groups = new Map();
  for (const t of [...byId.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
    if (t.leftoverOf || !fresh.has(String(t.id)) || !dishes.has(String(t.id))) continue;
    const key = `${t.recipeId}|${JSON.stringify(t.ratio ?? null)}`;
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  for (const group of groups.values()) {
    const t = /** @type {Record<string, any>} */ (group[0]);
    const base = /** @type {Record<string, any>} */ (dishes.get(String(t.id)));
    const scale =
      group.reduce((a, g) => a + (potServings.get(String(g.id)) ?? 0), 0) /
      (Number(base.servings) || 1);
    if (!(scale > 0)) continue;
    const ids = new Set(group.map((g) => String(g.id)));
    const eaters = [...byId.values()].filter(
      (x) => ids.has(String(x.id)) || ids.has(String(x.leftoverOf ?? "")),
    );
    /** @type {Swap[]} */
    const mine = [...(t.swaps ?? [])];
    for (const ing of base.ingredients ?? []) {
      if (ing.optional) continue;
      const from = canonicalFood(String(ing.food ?? ""));
      if (!SWAP_TABLE[from] || mine.some((s) => s.from === from)) continue;
      if (namedFor(String(base.name ?? ""), from)) continue;
      const gPer = toGrams(Number(ing.qty), String(ing.unit), from);
      if (gPer == null || !(gPer > 0)) continue;
      const gPot = gPer * scale;
      for (const to of SWAP_TABLE[from]) {
        if (to === "chickpeas" || !MACROS[to]) continue;
        const dA = demand.get(from) ?? 0;
        const dB = demand.get(to) ?? 0;
        const have = held(NAME[to] ?? to, dB + gPot);
        if (!have && !(dB > 0)) continue; // neither owned nor already bought
        const saved = cost(from, dA) - cost(from, dA - gPot) - (cost(to, dB + gPot) - cost(to, dB));
        if (!(saved >= 0.5)) continue;
        const swap = /** @type {Swap} */ ({
          from,
          to,
          grams: Math.round(gPer * 10) / 10,
          why: have ? "have" : "buying",
          saved: Math.round(saved * 100) / 100,
        });
        const before = withSwaps(base, mine);
        const after = withSwaps(base, [...mine, swap]);
        if (!before || !after) continue;
        // never a nut where there was none
        if (NUT_RE.test(NAME[to] ?? to)) {
          const nutty = (before.ingredients ?? []).some(
            (/** @type {any} */ i) => !i.optional && NUT_RE.test(String(i.food)),
          );
          if (!nutty) continue;
        }
        // no new conflict for anyone at this pot
        const seatIds = new Set(
          eaters.flatMap((e) => (e.seats ?? []).map((/** @type {any} */ s) => s.id)),
        );
        let clean = true;
        for (const id of seatIds) {
          const tg = targetsById.get(id);
          const was = new Set(
            recipeConflicts(before, tg?.diet, tg?.avoidIngredients, tg?.avoidRecipes),
          );
          const now = recipeConflicts(after, tg?.diet, tg?.avoidIngredients, tg?.avoidRecipes);
          if (now.some((r) => !was.has(r))) clean = false;
        }
        if (!clean) continue;
        // every seat's day stays in band
        const dk =
          (Number(after.nutrition?.calories) || 0) - (Number(before.nutrition?.calories) || 0);
        const dp =
          (Number(after.nutrition?.protein) || 0) - (Number(before.nutrition?.protein) || 0);
        /** @type {{ row: Record<string, any>, k: number, p: number }[]} */
        const moves = [];
        let inBand = true;
        for (const e of eaters) {
          for (const s of e.seats ?? []) {
            if (s.status === "skipped") continue;
            const row = rows(String(e.date), String(s.id));
            if (!row) continue;
            const sv = Number(s.servings) || 0;
            const k = row.dayKcal + sv * dk;
            const p = row.dayProtein + sv * dp;
            const m = targetsById.get(s.id)?.macros;
            const fl = enforcedFloors(m);
            const ce = enforcedCeilings(m);
            const whole = (Number(row.share) || 1) >= 1;
            if (ce.protein != null && p > ce.protein + 0.5 && p > row.dayProtein) inBand = false;
            if (ce.calories > 0 && k > ce.calories && k > row.dayKcal) inBand = false;
            if (whole && fl.protein > 0 && p < fl.protein - 0.5 && p < row.dayProtein)
              inBand = false;
            if (whole && fl.calories > 0 && k < fl.calories && k < row.dayKcal) inBand = false;
            moves.push({ row, k: sv * dk, p: sv * dp });
          }
        }
        if (!inBand) continue;
        for (const mv of moves) {
          mv.row.dayKcal = Math.round(mv.row.dayKcal + mv.k);
          mv.row.kcal = Math.round(mv.row.kcal + mv.k);
          mv.row.dayProtein = Math.round(mv.row.dayProtein + mv.p);
          mv.row.protein = Math.round(mv.row.protein + mv.p);
        }
        mine.push(swap);
        demand.set(from, Math.max(0, dA - gPot));
        demand.set(to, dB + gPot);
        chosen.push({
          tableId: String(t.id),
          recipeId: String(t.recipeId),
          date: String(t.date),
          slot: String(t.slot),
          swap,
        });
        break;
      }
    }
    if (mine.length > 0) for (const e of eaters) e.swaps = mine;
  }
  return { tables: tables.map((t) => byId.get(String(t.id)) ?? t), chosen };
}

/**
 * One line per swap for the planner's notes, newest first by saving.
 * @param {{ recipeId: string, swap: Swap }[]} chosen
 * @param {(id: string) => string} nameOf
 * @returns {string | null}
 */
export function swapNote(chosen, nameOf) {
  if (chosen.length === 0) return null;
  const total = chosen.reduce((a, c) => a + c.swap.saved, 0);
  const parts = chosen.map(
    (c) =>
      `${nameOf(c.recipeId)}: ${NAME[c.swap.to] ?? c.swap.to} for ${c.swap.from.replace(/-/g, " ")} (${c.swap.why === "have" ? "you have it" : "already on the list"}, saves $${c.swap.saved.toFixed(2)})`,
  );
  return `used what you have or are already buying, about $${total.toFixed(2)} off this trip: ${parts.join("; ")}`;
}

/**
 * The week's swaps as Plan shows them, read from the tables themselves (so
 * the line stays after the run and on every phone): one entry per dish and
 * swap, the saving counted once per dish.
 * @param {Record<string, any>[]} tables
 * @param {string[]} dates
 * @param {(id: string) => string} nameOf
 * @returns {{ line: string, total: number } | null}
 */
export function weekSwapLine(tables, dates, nameOf) {
  const inWeek = new Set(dates);
  /** @type {Map<string, Swap & { recipeId: string }>} */
  const seen = new Map();
  for (const t of tables ?? []) {
    if (!inWeek.has(String(t.date)) || t.leftoverOf) continue;
    for (const s of Array.isArray(t.swaps) ? t.swaps : []) {
      const key = `${t.recipeId}|${s.from}|${s.to}`;
      if (!seen.has(key)) seen.set(key, { ...s, recipeId: String(t.recipeId) });
    }
  }
  if (seen.size === 0) return null;
  const all = [...seen.values()];
  const total = Math.round(all.reduce((a, s) => a + (Number(s.saved) || 0), 0) * 100) / 100;
  const parts = all.map(
    (s) =>
      `${NAME[s.to] ?? s.to} for ${s.from.replace(/-/g, " ")} in ${nameOf(s.recipeId)}${s.why === "have" ? " (you have it)" : " (already on the list)"}`,
  );
  return {
    line: `Using what you have: ${parts.join("; ")}. About $${total.toFixed(2)} off this trip.`,
    total,
  };
}
