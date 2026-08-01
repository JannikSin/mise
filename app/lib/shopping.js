// Shopping list derivation (blueprint §5.4): aggregate the week's plan
// ingredients (scaled to planned servings), merge duplicates, drop staples,
// add running-low pantry staples, group by store section. Regeneration
// preserves check-state and manual items.

import {
  canonicalFood,
  canonicalUnit,
  convertUnit,
  dimensionOf,
  mergeIdentity,
  aisleOf,
  toPreferred,
} from "./ingredients.js";

/**
 * @typedef {{ id: string, food: string, qty: number, unit: string, section: string, checked: boolean, manual: boolean, fromRecipes?: string[] }} ShoppingItem
 * @typedef {{ generatedFrom?: string, items: ShoppingItem[] }} ShoppingList
 */

/**
 * Sections you shop FRESH, close to when you cook. Everything else is the
 * shelf-stable run.
 */
const FRESH_AISLES = new Set(["produce", "meat", "seafood", "dairy", "bakery"]);

/**
 * Which shopping trip a store section belongs to when a profile shops more
 * than once a week (survey-v2 David-ask #3, targets.shopsPerWeek > 1): a
 * shelf-stable "pantry" run (grains, canned, spices, ... — buy in bulk, less
 * often) versus a "fresh" run (produce, meat, dairy — buy close to when you
 * cook). Shops-per-week of 1 ignores this entirely and shows one list.
 * @param {string} section
 * @returns {"pantry" | "fresh"}
 */
export function tripOf(section) {
  return FRESH_AISLES.has(section) ? "fresh" : "pantry";
}

/**
 * Which aisle a food belongs to.
 *
 * Was seven keyword buckets with everything unmatched falling to "other"
 * (David, 2026-07-25: "the items are not sorted in any helpful way"). Now
 * delegates to the shared aisle taxonomy in ingredients.js, so the list
 * sections, the pantry groups, and the canonical merge key are all one
 * vocabulary rather than three that can drift.
 * @param {string} food
 * @returns {string}
 */
export function sectionOf(food) {
  return aisleOf(food);
}

/** @param {string} food */
export function slug(food) {
  return food
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * @param {import("./plan.js").Plan} plan
 * @param {Map<string, any>} recipesById
 * @param {Record<string, any>} pantry
 * @param {ShoppingList | null} [previous]
 * @param {string} [fromDate] skip entries dated before this local YYYY-MM-DD —
 *   you cannot shop for a meal you already ate. Absent = whole week. The
 *   buffer pseudo-entry has no date and always shops (its portions are
 *   already scaled to remaining days by generateWeek).
 * @param {{ dates?: string[], slots?: string[] }} [only] shop for PART of the
 *   week. David, 2026-07-26: guests came, the fridge was full, and he still
 *   wanted to stay on the plan — so he needed to buy for three days rather
 *   than either seven or none. Opting the meals OUT was wrong, because the
 *   meals are still happening; only the SHOPPING is partial. Absent = the
 *   whole week, exactly as before.
 * @returns {ShoppingList}
 */
export function deriveShoppingList(plan, recipesById, pantry, previous, fromDate, only) {
  const onlyDates = only?.dates?.length ? new Set(only.dates) : null;
  const onlySlots = only?.slots?.length ? new Set(only.slots) : null;
  /** @type {Map<string, ShoppingItem>} */
  const merged = new Map();

  /** food slugs the plan already shops, any unit (suppresses running-low dupes) */
  const shoppedFoods = new Set();
  // the documented contract (docs/SCHEMAS.md): subtract pantry onHand staples
  // by name — this is what makes P+ ("I already own this") stick across builds.
  // A running-low staple is NOT subtracted: it needs buying.
  const onHandSlugs = new Set(
    (pantry.staples ?? [])
      .filter((/** @type {any} */ s) => s.onHand && !s.runningLow)
      .flatMap((/** @type {any} */ s) => [s.id, slug(s.name), canonicalFood(s.name)]),
  );

  // the weekly buffer snack shops exactly like a planned entry: its batch is
  // `portions` servings of the recipe
  // the weekly buffer is a WEEK-long batch, so a partial shop leaves it out
  // rather than buying a full week of stand-by snack for three days of food
  const partial = Boolean(onlyDates || onlySlots);
  const toShop = [
    ...plan.entries,
    ...(plan.buffer && !partial
      ? [{ recipeId: plan.buffer.recipeId, servings: plan.buffer.portions }]
      : []),
  ];
  for (const entry of toShop) {
    if (!entry.recipeId) continue;
    if (fromDate && "date" in entry && entry.date < fromDate) continue;
    // a partial shop: the meals stay planned, they just are not bought yet
    if (onlyDates && "date" in entry && !onlyDates.has(entry.date)) continue;
    if (onlySlots && "slot" in entry && !onlySlots.has(entry.slot)) continue;
    const recipe = recipesById.get(entry.recipeId);
    if (!recipe) continue;
    const perServing = entry.servings / (recipe.servings || 1);
    for (const ing of recipe.ingredients ?? []) {
      const canon = canonicalFood(ing.food);
      if (ing.staple || onHandSlugs.has(slug(ing.food)) || onHandSlugs.has(canon)) continue;
      // A known food merges to ONE row in its own preferred unit, whatever
      // unit the recipe wrote (this is the broccoli fix). An unknown food
      // keeps the unit in its id, exactly as before, so two different things
      // can never silently collapse into one row.
      const ident = mergeIdentity(ing.food, ing.unit);
      const converted = ident.qty(ing.qty * perServing);
      const id = ident.id;
      const existing = merged.get(id);
      const qty = converted ? converted.qty : ing.qty * perServing;
      const unit = converted ? converted.unit : ing.unit;
      shoppedFoods.add(canon);
      if (existing) {
        existing.qty += qty;
        if (!existing.fromRecipes?.includes(recipe.id)) existing.fromRecipes?.push(recipe.id);
      } else {
        merged.set(id, {
          id,
          food: ing.food,
          qty,
          unit,
          section: sectionOf(ing.food),
          checked: false,
          manual: false,
          fromRecipes: [recipe.id],
        });
      }
    }
  }

  // pantry staples flagged running-low re-enter the list — unless the week's
  // recipes already put that food on it
  for (const s of pantry.staples ?? []) {
    if (!s.runningLow || shoppedFoods.has(slug(s.name)) || shoppedFoods.has(canonicalFood(s.name)))
      continue;
    const id = `${slug(s.name)}-x`;
    if (!merged.has(id)) {
      merged.set(id, {
        id,
        food: s.name,
        qty: 1,
        unit: "x",
        section: s.section ?? sectionOf(s.name),
        checked: false,
        manual: false,
      });
    }
  }

  // regeneration keeps check-state and manual items
  for (const prev of previous?.items ?? []) {
    if (prev.manual) {
      if (!merged.has(prev.id)) merged.set(prev.id, prev);
    } else if (prev.checked) {
      const item = merged.get(prev.id) ?? [...merged.values()].find((i) => i.id === prev.id);
      if (item) item.checked = true;
    }
  }

  // rounding happens here, AFTER all merging/summing above — round-then-sum
  // would inflate totals (two 0.3-each requirements would ceil to 1+1=2
  // instead of the correct sum-then-ceil(0.6)=1)
  const items = [...merged.values()].map((i) => {
    const { qty, unit } = roundForPurchase(i.qty, i.unit);
    return { ...i, qty, unit };
  });
  items.sort((a, b) => a.section.localeCompare(b.section) || a.food.localeCompare(b.food));
  return { generatedFrom: plan.week, items };
}

/**
 * Self-heal a shopping list read from disk onto the canonical id scheme.
 *
 * This is the load-bearing half of the canonical-ingredient change, and it
 * has to run BEFORE any merge. Item ids are the 409 merge key and the
 * check-state carryover key across four phones. Change the scheme without
 * this and four things break silently: every ticked item unchecks on the
 * next build, manual items come back under their old ids as fresh
 * duplicates, ticking an item in the store stops writing through to another
 * profile's list, and a mid-trip 409 keeps both the old-id and new-id rows.
 *
 * Re-keying on READ makes every device compute the same ids from the same
 * content without talking to each other, the same trick normalizePlan and
 * normalizePantry already use. Rows that collapse together sum, and stay
 * checked only if every row that fed them was checked (re-buying something
 * is a cheaper mistake than missing it).
 * @param {ShoppingList | null | undefined} list
 * @returns {ShoppingList | null | undefined}
 */
export function normalizeShoppingList(list) {
  const items = list?.items;
  if (!items?.length) return list;
  const rekeyed = items.map((item) => {
    // sections are re-derived here too: the aisle taxonomy widened from seven
    // buckets to fourteen, and a row stored under an old name ("dry-goods")
    // would otherwise match no section group and silently vanish from the list
    const section = sectionOf(item.food);
    const i = section === item.section ? item : { ...item, section };
    const ident = mergeIdentity(i.food, i.unit);
    if (ident.id === i.id) return i;
    const converted = ident.qty(i.qty);
    return converted
      ? { ...i, id: ident.id, qty: converted.qty, unit: converted.unit }
      : { ...i, id: ident.id };
  });
  if (rekeyed.every((i, n) => i === items[n])) return list;

  /** @type {Map<string, ShoppingItem>} */
  const merged = new Map();
  for (const item of rekeyed) {
    const existing = merged.get(item.id);
    if (!existing) {
      merged.set(item.id, { ...item });
      continue;
    }
    existing.qty = roundForPurchase(existing.qty + item.qty, existing.unit).qty;
    existing.checked = existing.checked && item.checked;
    existing.manual = existing.manual && item.manual;
    if (item.fromRecipes?.length) {
      existing.fromRecipes = [...new Set([...(existing.fromRecipes ?? []), ...item.fromRecipes])];
    }
  }
  return { ...list, items: [...merged.values()] };
}

/** Units bought as whole discrete items — never a fraction of one. */
const COUNTABLE_UNITS = new Set([
  "each",
  "scoop",
  "scoops",
  "clove",
  "cloves",
  "can",
  "cans",
  "slice",
  "slices",
  "pita",
  "pitas",
  "egg",
  "eggs",
]);

/**
 * Round a summed quantity up to an amount you can actually buy in a store.
 * Always rounds UP (better a little extra than short mid-recipe) and never
 * rounds a nonzero quantity down to zero. Unit is preserved as-is except for
 * the g→kg and ml→L promotions at the 1000 threshold.
 * @param {number} qty
 * @param {string} unit
 * @returns {{ qty: number, unit: string }}
 */
export function roundForPurchase(qty, unit) {
  const u = unit.toLowerCase().trim();
  if (COUNTABLE_UNITS.has(u)) return { qty: Math.ceil(qty), unit };
  if (u === "g") {
    if (qty < 100) return { qty: ceilStep(qty, 10), unit };
    if (qty < 1000) return { qty: ceilStep(qty, 25), unit };
    return { qty: ceilStep(qty / 1000, 0.1), unit: "kg" };
  }
  if (u === "ml") {
    if (qty < 100) return { qty: ceilStep(qty, 10), unit };
    if (qty < 1000) return { qty: ceilStep(qty, 50), unit };
    return { qty: ceilStep(qty / 1000, 0.1), unit: "l" };
  }
  if (u === "cup" || u === "cups" || u === "tbsp" || u === "tsp") {
    return { qty: ceilStep(qty, 0.25), unit };
  }
  if (u === "lb" || u === "lbs") return { qty: ceilStep(qty, 0.25), unit };
  if (u === "oz") return { qty: ceilStep(qty, 1), unit };
  return { qty: ceilStep(qty, 0.1), unit };
}

/**
 * Ceil qty to the nearest multiple of step, guarding against float dust.
 * @param {number} qty
 * @param {number} step
 * @returns {number}
 */
function ceilStep(qty, step) {
  return Math.round(Math.ceil((qty - 1e-9) / step) * step * 1e6) / 1e6;
}

/**
 * DISPLAY-ONLY conversion of a metric quantity to what a US shopper reads
 * on a store shelf. The stored quantity stays metric and authoritative
 * (roundForPurchase already made it purchasable); this is a FAITHFUL
 * convert — never re-stepped, never re-rounded onto an imperial grid, so
 * the imperial number and its metric parenthetical always agree ("1.76 lb
 * (800 g)", not the lie "1.80 lb (800 g)") and can never under-buy.
 * Returns null for units a US shopper already reads natively (cup, tbsp,
 * each, can, ...) — callers render those unchanged.
 * @param {number} qty
 * @param {string} unit
 * @returns {{ qty: number, unit: string } | null}
 */
export function toStoreUnits(qty, unit) {
  const u = unit.toLowerCase().trim();
  const round1 = (/** @type {number} */ n) => Math.round(n * 10) / 10;
  const round2 = (/** @type {number} */ n) => Math.round(n * 100) / 100;
  if (u === "g") {
    if (qty >= 400) return { qty: round2(qty / 453.59237), unit: "lb" };
    return { qty: round1(qty / 28.349523), unit: "oz" };
  }
  if (u === "kg") return { qty: round2((qty * 1000) / 453.59237), unit: "lb" };
  if (u === "ml") {
    if (qty >= 946) return { qty: round2(qty / 946.352946), unit: "qt" };
    return { qty: round1(qty / 29.5735296), unit: "fl oz" };
  }
  if (u === "l") return { qty: round2((qty * 1000) / 946.352946), unit: "qt" };
  return null;
}

/**
 * Store-shelf display string for a list row: imperial first, metric kept
 * in parentheses as the authority ("1.76 lb (800 g)"); native-US units
 * pass through untouched ("3 cup").
 * @param {number} qty
 * @param {string} unit
 * @returns {string}
 */
export function formatStoreQty(qty, unit) {
  const conv = toStoreUnits(qty, unit);
  if (!conv) return `${qty} ${unit}`;
  return `${conv.qty} ${conv.unit} (${qty} ${unit})`;
}

/**
 * Store-pack language (David, 2026-08-01: "I want 2 lbs of this or a bag of
 * this"). A metric quantity is honest but nobody shops in grams of spinach —
 * they buy bags, bunches and heads. Each entry: substrings to match on the
 * food name, the typical US store pack in grams (or ml / count), and the
 * pack's name. Sizes are deliberately common-denominator (a 5 oz clamshell
 * of greens, a 2 lb bag of rice); the metric number stays the authority and
 * renders alongside, so a store that sells bigger bags can't under-buy you.
 */
const PACK_HINTS = [
  {
    match: ["baby spinach", "spinach", "arugula", "spring mix", "mixed greens", "salad greens"],
    per: 140,
    unit: "g",
    name: "bag",
    plural: "bags",
  }, // 5 oz clamshell
  {
    match: ["kale", "swiss chard", "collard"],
    per: 200,
    unit: "g",
    name: "bunch",
    plural: "bunches",
  },
  {
    match: ["cilantro", "parsley", "mint", "dill"],
    per: 60,
    unit: "g",
    name: "bunch",
    plural: "bunches",
  },
  { match: ["scallion", "green onion"], per: 100, unit: "g", name: "bunch", plural: "bunches" },
  { match: ["cabbage"], per: 900, unit: "g", name: "head", plural: "heads" },
  { match: ["cauliflower"], per: 700, unit: "g", name: "head", plural: "heads" },
  { match: ["broccoli"], per: 300, unit: "g", name: "crown", plural: "crowns" },
  { match: ["romaine", "lettuce"], per: 300, unit: "g", name: "head", plural: "heads" },
  { match: ["ginger"], per: 50, unit: "g", name: "knob", plural: "knobs" },
  {
    match: ["greek yogurt", "yogurt"],
    per: 900,
    unit: "g",
    name: "32 oz tub",
    plural: "32 oz tubs",
  },
  { match: ["cottage cheese"], per: 680, unit: "g", name: "24 oz tub", plural: "24 oz tubs" },
  { match: ["blueberr"], per: 340, unit: "g", name: "pint", plural: "pints" },
  { match: ["strawberr"], per: 450, unit: "g", name: "1 lb clamshell", plural: "1 lb clamshells" },
  { match: ["rice"], per: 900, unit: "g", name: "2 lb bag", plural: "2 lb bags" },
  { match: ["rolled oats", "oats"], per: 1190, unit: "g", name: "42 oz tub", plural: "42 oz tubs" },
  { match: ["tofu"], per: 400, unit: "g", name: "block", plural: "blocks" },
  {
    match: ["pasta", "spaghetti", "penne", "orzo"],
    per: 450,
    unit: "g",
    name: "1 lb box",
    plural: "1 lb boxes",
  },
  { match: ["potato"], per: 2270, unit: "g", name: "5 lb bag", plural: "5 lb bags" },
  { match: ["milk"], per: 1900, unit: "ml", name: "half-gallon", plural: "half-gallons" },
];

/**
 * "≈ 2 bags" for a list row, or "" when no honest pack language exists.
 * Garlic cloves get their own rule (10 cloves ≈ 1 head). Counts ceil to a
 * whole pack — you cannot buy 1.4 bunches — and anything over 12 packs
 * returns "" rather than shout "≈ 19 bags" at a bulk buy.
 * @param {string} food
 * @param {number} qty
 * @param {string} unit
 * @returns {string}
 */
export function packHint(food, qty, unit) {
  const f = String(food ?? "").toLowerCase();
  if (!(Number(qty) > 0)) return "";
  if (f.includes("garlic") && /clove/.test(unit)) {
    const heads = Math.ceil(qty / 10);
    return `≈ ${heads} ${heads === 1 ? "head" : "heads"}`;
  }
  const inBase =
    unit === "g" || unit === "ml"
      ? qty
      : unit === "kg" || unit === "L" || unit === "l"
        ? qty * 1000
        : unit === "lb"
          ? qty * 453.6
          : unit === "oz"
            ? qty * 28.35
            : null;
  if (inBase == null) return "";
  const baseKind = unit === "ml" || unit === "L" || unit === "l" ? "ml" : "g";
  for (const h of PACK_HINTS) {
    if (h.unit !== baseKind) continue;
    if (!h.match.some((m) => f.includes(m))) continue;
    const n = Math.ceil(inBase / h.per);
    if (n < 1 || n > 12) return "";
    return `≈ ${n} ${n === 1 ? h.name : h.plural}`;
  }
  return "";
}

/**
 * @typedef {{ id: string, food: string, qty: number, unit: string, section: string, sources: { profileId: string, checked: boolean }[] }} CombinedItem
 */

/**
 * The other profiles whose lists join this profile's EVERYONE trip: same
 * `household` only (profiles.json, absent = "home" — every pre-household
 * profile keeps merging exactly as before). A profile alone in its
 * household gets an empty list, which also hides the EVERYONE tab.
 * @param {Record<string, any>[]} profiles profiles.json entries
 * @param {string} meId active profile id
 * @returns {Record<string, any>[]}
 */
export function householdOthers(profiles, meId) {
  const mine = householdOf(profiles, meId);
  return profiles.filter((p) => p.id !== meId && (p.household ?? "home") === mine);
}

/**
 * The active profile's household slug (absent = "home"), the key both the
 * EVERYONE trip and the shared pantry hang off.
 * @param {Record<string, any>[]} profiles profiles.json entries
 * @param {string} meId active profile id
 * @returns {string}
 */
export function householdOf(profiles, meId) {
  return profiles.find((p) => p.id === meId)?.household ?? "home";
}

/**
 * Where a household's SHARED pantry lives (B2, 2026-07-21): one kitchen,
 * one fridge, one pantry file — everyone in the household reads and writes
 * the same one, and moving household (B3) re-points you automatically
 * because the path derives from profiles.json. Always read/written raw
 * (never profile-scoped).
 * @param {string} household
 * @returns {string}
 */
export function pantryPathFor(household) {
  return `households/${household || "home"}/pantry.json`;
}

/**
 * One store trip for the whole household: merge every profile's shopping
 * list into a single read-time view. Items merge by their unit-aware id,
 * quantities sum (each source list already rounded up to purchasable
 * amounts, so the sum stays purchasable), and each merged item remembers
 * which profiles want it. A combined item reads checked only when EVERY
 * source has it checked — half-bought is not bought.
 * @param {{ profileId: string, list: ShoppingList }[]} lists
 * @returns {CombinedItem[]}
 */
export function mergeProfileLists(lists) {
  /** @type {Map<string, CombinedItem>} */
  const merged = new Map();
  for (const { profileId, list } of lists) {
    for (const item of list.items ?? []) {
      const existing = merged.get(item.id);
      if (existing) {
        existing.qty += item.qty;
        existing.sources.push({ profileId, checked: item.checked });
      } else {
        merged.set(item.id, {
          id: item.id,
          food: item.food,
          qty: item.qty,
          unit: item.unit,
          section: item.section,
          sources: [{ profileId, checked: item.checked }],
        });
      }
    }
  }
  const items = [...merged.values()];
  items.sort((a, b) => a.section.localeCompare(b.section) || a.food.localeCompare(b.food));
  return items;
}

/**
 * Fridge-first shopping (David, 2026-08-01: "use everything in the fridge…
 * only buy stuff that we need"): before a trip, food the kitchen already
 * holds comes off what is bought. Works on any row shape carrying
 * `{ food, qty, unit }` — per-profile ShoppingItems and CombinedItems alike —
 * against the household pantry's PERISHABLES (staples are already dropped at
 * derive time by `onHand`).
 *
 * Honesty fences, mirroring consumeForCook:
 *  - only rows whose pantry qty parses as "<number> <unit>" AND converts to
 *    the list row's unit count — a "half a bag" is never fake-subtracted,
 *    that row simply doesn't reduce the buy;
 *  - unit "x" list rows (manual items, running-low staples) never reduce —
 *    a running-low staple is on the list BECAUSE the kitchen is out;
 *  - stock is consumed across the trip in item order, so two rows of the
 *    same food can never both claim the same fridge pack;
 *  - a remainder is re-rounded UP to a purchasable amount.
 *
 * Render-time only: stored lists are never rewritten, so no device ever
 * double-subtracts and un-scanning food simply restores the full buy.
 * @template {{ food: string, qty: number, unit: string }} T
 * @param {T[]} items
 * @param {Record<string, any>} pantry the household pantry
 * @returns {{ toBuy: (T & { kitchenHas?: boolean })[], covered: T[] }}
 *   `toBuy` = rows still needing purchase (qty reduced where the kitchen
 *   partially covers, flagged `kitchenHas`); `covered` = rows the kitchen
 *   fully covers, for an honest "already in the kitchen" display.
 */
export function subtractPantryFromTrip(items, pantry) {
  /** @type {Map<string, { qty: number, unit: string }[]>} */
  const stock = new Map();
  for (const p of pantry?.perishables ?? []) {
    const have = parseQty(p.qty);
    if (!have || have.unit === "x") continue;
    const key = canonicalFood(String(p.food ?? ""));
    const rows = stock.get(key);
    if (rows) rows.push(have);
    else stock.set(key, [have]);
  }
  /** @type {(T & { kitchenHas?: boolean })[]} */
  const toBuy = [];
  /** @type {T[]} */
  const covered = [];
  for (const item of items) {
    const key = canonicalFood(item.food);
    const rows = stock.get(key);
    const wanted = Number(item.qty);
    if (!rows || rows.length === 0 || !(wanted > 0) || !item.unit || item.unit === "x") {
      toBuy.push(item);
      continue;
    }
    let need = wanted;
    let needUnit = item.unit;
    let reduced = false;
    for (const row of rows) {
      if (need <= 0 || row.qty <= 0) continue;
      const both = commonUnit(row, { qty: need, unit: needUnit }, key);
      if (!both) continue;
      const take = Math.min(both.a, both.b);
      row.qty = both.a - take;
      row.unit = both.unit;
      need = both.b - take;
      needUnit = both.unit;
      reduced = true;
    }
    if (!reduced) {
      toBuy.push(item);
    } else if (need <= 0.001) {
      covered.push(item);
    } else {
      const { qty, unit } = roundForPurchase(need, needUnit);
      toBuy.push({ ...item, qty, unit, kitchenHas: true });
    }
  }
  return { toBuy, covered };
}

/** Sections where a single-profile buy tends to strand most of a container
 *  (herbs wilt, cheeses mold, dressings die in the fridge door). */
const PARTIAL_CONTAINER_SECTIONS = new Set(["dairy", "produce", "spices", "other"]);

/**
 * Harmonizer pilot (council verdict: report, never a rewriter): items only
 * ONE profile is buying, in partial-container-prone sections, paired with
 * what the other profiles are already buying in that same section — the
 * "you're already buying feta for her, his salad could take feta too" label.
 * Suggestion only; recipes are never auto-edited (a Greger-audited recipe
 * with a silently swapped cheese is no longer audited).
 * @param {CombinedItem[]} combined
 * @returns {{ item: CombinedItem, alreadyBuying: CombinedItem[] }[]}
 */
export function swapCandidates(combined) {
  const out = [];
  for (const item of combined) {
    if (item.sources.length !== 1 || !PARTIAL_CONTAINER_SECTIONS.has(item.section)) continue;
    const alreadyBuying = combined.filter(
      (other) =>
        other.section === item.section &&
        other.id !== item.id &&
        (other.sources.length > 1 || other.sources[0]?.profileId !== item.sources[0]?.profileId),
    );
    if (alreadyBuying.length > 0) out.push({ item, alreadyBuying });
  }
  return out;
}

/**
 * Days a bought perishable is assumed good in the fridge, by food keyword.
 * First match wins. Deliberately conservative so nothing edible vanishes too
 * early, but a two-week-old bag of spinach or a week-old chicken breast does
 * leave on its own. Staples never expire (they're the other tier).
 * @type {[RegExp, number][]}
 */
const PERISHABLE_SHELF_DAYS = [
  [/\b(salmon|tuna|cod|tilapia|shrimp|prawn|scallop|fish|seafood)\b/, 3],
  [/\b(chicken|turkey|pork|beef|lamb|mince|steak|thigh|breast|ground)\b/, 4],
  [/\b(spinach|lettuce|arugula|greens|kale|herb|cilantro|parsley|basil|berries|berry)\b/, 6],
  [/\b(broccoli|cauliflower|cucumber|tomato|pepper|mushroom|zucchini|avocado|asparagus)\b/, 8],
  [/\b(tofu|tempeh|hummus)\b/, 8],
  [/\b(milk|yogurt|kefir|cream|cottage)\b/, 10],
  [/\b(carrot|onion|potato|cabbage|apple|citrus|lemon|lime|orange)\b/, 18],
  [/\b(egg|eggs|cheese)\b/, 28],
];

/**
 * Where a perishable is kept. `unsorted` is the quarantine for rows that
 * predate locations: a location sweep must never delete something it could
 * not see, and every item in an existing pantry has no location at all.
 * @typedef {"fridge" | "freezer" | "pantry" | "unsorted"} PantryLocation
 */
export const PANTRY_LOCATIONS = /** @type {PantryLocation[]} */ ([
  "fridge",
  "freezer",
  "pantry",
  "unsorted",
]);

/**
 * How long the same food keeps somewhere OTHER than the fridge, by keyword.
 *
 * David asked how the expiry matching works, and the honest answer was that
 * it did not know where the food was: spinach is six days in the fridge and
 * months in the freezer, and one table could not tell them apart.
 *
 * Numbers are the LOW end of the ranges in the app's own offline food-safety
 * guide (views/shopping.js FOOD_SAFETY), which is where they have to stay in
 * sync. Deliberately conservative, because this function DELETES rows: a
 * false "still good" is the dangerous failure, a false "expired" only costs
 * food. A food with no entry for a location keeps its fridge number, which is
 * always the shorter of the two, so an unknown can never be extended.
 * @type {[RegExp, { freezer?: number, pantry?: number }][]}
 */
const OTHER_LOCATION_DAYS = [
  [/\b(salmon|tuna|cod|tilapia|shrimp|prawn|scallop|fish|seafood)\b/, { freezer: 90 }],
  [/\b(chicken|turkey|pork|beef|lamb|mince|steak|thigh|breast|ground)\b/, { freezer: 90 }],
  [/\b(berries|berry)\b/, { freezer: 240 }],
  [/\b(spinach|lettuce|arugula|greens|kale|herb|cilantro|parsley|basil)\b/, { freezer: 180 }],
  [
    /\b(broccoli|cauliflower|pepper|mushroom|zucchini|asparagus|peas|corn|edamame)\b/,
    { freezer: 240 },
  ],
  [/\b(tofu|tempeh)\b/, { freezer: 90 }],
  [/\b(bread|pita|tortilla|bun|bagel)\b/, { freezer: 90, pantry: 5 }],
  // the guide's own note: these prefer a cool cupboard to the fridge
  [/\b(potato|onion|shallot|garlic|squash)\b/, { pantry: 30 }],
  [/\b(banana|avocado|tomato)\b/, { pantry: 5 }],
  [/\b(apple|citrus|lemon|lime|orange)\b/, { pantry: 10 }],
];

/**
 * Shelf life in days for a perishable, given where it is kept.
 *
 * `location` is optional and everything without one behaves EXACTLY as it did
 * before this existed. That matters more than it looks: expirePerishables
 * runs on every pantry load and persists the trim, so a migration that
 * shortened any existing window would delete other people's food on whichever
 * device opened the app first. Unknown locations fall back to the fridge
 * number for the same reason.
 * @param {string} food
 * @param {PantryLocation | string} [location]
 * @returns {number}
 */
export function shelfLifeDays(food, location) {
  const f = (food ?? "").toLowerCase();
  let fridge = 14; // default: long enough not to nuke a mystery item early
  for (const [re, days] of PERISHABLE_SHELF_DAYS) {
    if (re.test(f)) {
      fridge = days;
      break;
    }
  }
  if (location !== "freezer" && location !== "pantry") return fridge;
  for (const [re, other] of OTHER_LOCATION_DAYS) {
    if (re.test(f)) {
      const days = other[location];
      // never SHORTER than the fridge figure for a pantry item that the table
      // says keeps longer there, and never longer for one it does not cover
      if (days != null) return location === "pantry" ? days : Math.max(days, fridge);
    }
  }
  return fridge;
}

/**
 * Wipe the pantry. `keepStaples` keeps the permanent shelf (oil, salt, rice)
 * and clears only the perishables, which is what "reset" almost always means.
 * @param {Record<string, any>} pantry
 * @param {boolean} keepStaples
 * @returns {Record<string, any>}
 */
export function emptyPantry(pantry, keepStaples) {
  return { ...pantry, staples: keepStaples ? (pantry.staples ?? []) : [], perishables: [] };
}

/**
 * Apply one location's photo sweep: the confirmed items REPLACE that
 * location's perishables.
 *
 * Replace-on-confirm rather than an incremental merge is deliberate. No
 * vendor has shipped a reliable diff between successive fridge photos, and
 * pretending to would silently keep things that are long gone. But it is only
 * safe with three fences, all of them here:
 *
 *  - it touches PERISHABLES only, never staples, whose `onHand` flags are
 *    what stop the shopping list re-buying every staple in the house;
 *  - it only clears rows at the SCANNED location, so a fridge sweep cannot
 *    take the freezer with it;
 *  - rows with no location sit in `unsorted` and are never touched by any
 *    sweep, because a camera cannot see the back of the fridge and every row
 *    in an existing pantry predates locations entirely.
 *
 * Ids are content-derived, so two people sweeping the same shelf on the same
 * day converge on one row instead of duplicating it on the 409 merge.
 * @param {Record<string, any>} pantry
 * @param {PantryLocation} location
 * @param {{ food: string, qty?: string, group?: string }[]} items
 * @param {string} today ISO date
 * @returns {Record<string, any>}
 */
export function applySweep(pantry, location, items, today) {
  const kept = (pantry.perishables ?? []).filter(
    (/** @type {any} */ p) => (p.location ?? "unsorted") !== location,
  );
  const swept = items.map((i) => ({
    id: `${slug(i.food)}-${location}`,
    food: i.food,
    ...(i.qty ? { qty: i.qty } : {}),
    added: today,
    location,
    group: i.group ?? aisleOf(i.food),
  }));
  return { ...pantry, perishables: [...kept, ...swept] };
}

/**
 * A perishable's freshness window: the last day it's assumed good and how
 * many days remain (0 = last day today). Null fields when the item has no
 * `added` date — we can't judge what we can't date.
 * @param {Record<string, any>} p pantry perishable
 * @param {string} todayIso
 * @returns {{ goodUntil: string | null, daysLeft: number | null }}
 */
export function perishableStatus(p, todayIso) {
  if (!p.added) return { goodUntil: null, daysLeft: null };
  const until = new Date(`${p.added}T00:00:00`);
  until.setDate(until.getDate() + shelfLifeDays(p.food, p.location));
  const today = new Date(`${todayIso}T00:00:00`);
  const daysLeft = Math.round((until.getTime() - today.getTime()) / 86400000);
  const y = until.getFullYear();
  const m = String(until.getMonth() + 1).padStart(2, "0");
  const d = String(until.getDate()).padStart(2, "0");
  return { goodUntil: `${y}-${m}-${d}`, daysLeft };
}

/**
 * Auto-flag `useSoon` on any perishable within its last 3 days, so the week
 * generator favors recipes that cook the expiring food first — without David
 * hand-flagging anything. Manual useSoon flags are preserved; the input is
 * never mutated.
 * @param {Record<string, any>} pantry
 * @param {string} todayIso
 * @returns {Record<string, any>}
 */
export function withAutoUseSoon(pantry, todayIso) {
  const perishables = (pantry.perishables ?? []).map((/** @type {any} */ p) => {
    if (p.useSoon) return p;
    const { daysLeft } = perishableStatus(p, todayIso);
    return daysLeft != null && daysLeft <= 3 ? { ...p, useSoon: true } : p;
  });
  return { ...pantry, perishables };
}

/**
 * Drop perishables whose `added` date plus their shelf life is before today.
 * Perishables with no `added` date are kept (we can't judge them). Returns the
 * updated pantry and the names dropped, so the UI can say what left.
 * @param {Record<string, any>} pantry
 * @param {string} todayIso
 * @returns {{ pantry: Record<string, any>, expired: string[] }}
 */
export function expirePerishables(pantry, todayIso) {
  const today = new Date(`${todayIso}T00:00:00`);
  /** @type {string[]} */
  const expired = [];
  const kept = (pantry.perishables ?? []).filter((/** @type {any} */ p) => {
    if (!p.added) return true;
    const gone = new Date(`${p.added}T00:00:00`);
    gone.setDate(gone.getDate() + shelfLifeDays(p.food, p.location));
    if (gone < today) {
      expired.push(p.food);
      return false;
    }
    return true;
  });
  if (expired.length === 0) return { pantry, expired };
  return { pantry: { ...pantry, perishables: kept }, expired };
}

/** @returns {string} unique-per-device perishable id */
function perishableId() {
  return crypto.randomUUID().slice(0, 8);
}

/**
 * Deterministic id for a legacy (pre-id) perishable: two devices
 * independently self-healing the same household pantry MUST agree on ids,
 * or the id-keyed 409 merge would duplicate rows and resurrect deletions.
 * FNV-1a over stable content plus the index among identical twins — the
 * same scheme plan.js uses for legacy entries.
 * @param {Record<string, any>} p
 * @param {number} twinIndex
 * @returns {string}
 */
function legacyPerishableId(p, twinIndex) {
  const s = `${p.food ?? ""}|${p.added ?? ""}|${p.qty ?? ""}|${twinIndex}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `l${h.toString(16).padStart(8, "0")}`;
}

/**
 * Self-heal a pantry read from disk: every perishable gets a stable id
 * (persisted on the next write, like plan.js legacy entries). Ids are what
 * make household-shared pantries merge safely — staples always had them,
 * perishables were removed BY INDEX and merged positionally, so two people
 * editing the same fridge could mis-target or duplicate rows on a 409.
 * @param {Record<string, any>} pantry
 * @returns {Record<string, any>}
 */
export function normalizePantry(pantry) {
  const perishables = pantry.perishables ?? [];
  const settled = perishables.every(
    (/** @type {any} */ p) =>
      typeof p.id === "string" && typeof p.location === "string" && typeof p.group === "string",
  );
  if (settled) return pantry;
  /** @type {Map<string, number>} */
  const twinCounts = new Map();
  return {
    ...pantry,
    perishables: perishables.map((/** @type {any} */ p) => {
      let id = p.id;
      if (typeof id !== "string") {
        const contentKey = `${p.food ?? ""}|${p.added ?? ""}|${p.qty ?? ""}`;
        const twinIndex = twinCounts.get(contentKey) ?? 0;
        twinCounts.set(contentKey, twinIndex + 1);
        id = legacyPerishableId(p, twinIndex);
      }
      return {
        ...p,
        id,
        // UNSORTED, not a guess. Every row that predates locations is
        // somewhere the app has never been told about, and a photo sweep must
        // never delete something it could not see. A guess of "fridge" here
        // would put the whole legacy pantry in the blast radius of the first
        // fridge rescan.
        location: typeof p.location === "string" ? p.location : "unsorted",
        group: typeof p.group === "string" ? p.group : aisleOf(p.food ?? ""),
      };
    }),
  };
}

/**
 * Remove a pantry entry outright (mis-added chicken, a staple you no longer
 * keep). `kind` picks the tier; both match by id.
 * @param {Record<string, any>} pantry
 * @param {"staple" | "perishable"} kind
 * @param {string} key the entry's id
 * @returns {Record<string, any>}
 */
export function removeFromPantry(pantry, kind, key) {
  if (kind === "staple") {
    return {
      ...pantry,
      staples: (pantry.staples ?? []).filter((/** @type {any} */ s) => s.id !== key),
    };
  }
  return {
    ...pantry,
    perishables: (pantry.perishables ?? []).filter((/** @type {any} */ p) => p.id !== key),
  };
}

/**
 * "I already have this — permanently": a list item becomes (or refreshes) a
 * pantry staple with onHand true and leaves the list. For the found-it-in-
 * the-cupboard case; plain ticking covers "have enough for this week".
 * @param {ShoppingList} shopping
 * @param {Record<string, any>} pantry
 * @param {string} itemId
 * @returns {{ shopping: ShoppingList, pantry: Record<string, any> }}
 */
export function ownItemToPantry(shopping, pantry, itemId) {
  const item = shopping.items.find((i) => i.id === itemId);
  if (!item) return { shopping, pantry };
  const foodSlug = slug(item.food);
  const canon = canonicalFood(item.food);
  const staples = [...(pantry.staples ?? [])];
  const existing = staples.findIndex(
    (s) => s.id === foodSlug || slug(s.name) === foodSlug || canonicalFood(s.name) === canon,
  );
  if (existing >= 0) {
    staples[existing] = { ...staples[existing], onHand: true, runningLow: false };
  } else {
    staples.push({
      id: foodSlug,
      name: item.food,
      section: item.section,
      onHand: true,
      runningLow: false,
    });
  }
  return {
    // owning a food clears EVERY row of it, whatever the unit or spelling
    shopping: {
      ...shopping,
      items: shopping.items.filter(
        (i) => slug(i.food) !== foodSlug && canonicalFood(i.food) !== canon,
      ),
    },
    pantry: { ...pantry, staples },
  };
}

/**
 * "Just bought": checked items leave the list; staples flip onHand, anything
 * else lands in pantry perishables with today's date.
 * @param {ShoppingList} shopping
 * @param {Record<string, any>} pantry
 * @param {string} today ISO date
 * @param {{ fridgeFirst?: boolean }} [opts] `fridgeFirst: true` banks the
 *   pantry-REDUCED quantities via subtractPantryFromTrip — pass it ONLY when
 *   `shopping` is the very row set whose rendered trip subtracted this same
 *   pantry (a solo profile's list, or the house's MERGED trip at receipt
 *   time). Default false banks stored quantities verbatim: in a household,
 *   per-profile rows are PORTIONS of a merged sum, and re-subtracting the
 *   shared stock from each portion independently banks ~nothing while the
 *   real fridge fills (Tribunal BLOCK, 2026-08-01).
 * @returns {{ shopping: ShoppingList, pantry: Record<string, any> }}
 */
export function applyJustBought(shopping, pantry, today, opts = {}) {
  const bought = shopping.items.filter((i) => i.checked);
  const staples = (pantry.staples ?? []).map((/** @type {any} */ s) => {
    const hit = bought.find(
      (b) =>
        b.id === s.id ||
        slug(b.food) === slug(s.name) ||
        canonicalFood(b.food) === canonicalFood(s.name),
    );
    return hit ? { ...s, onHand: true, runningLow: false } : s;
  });
  const stapleIds = new Set(staples.map((/** @type {any} */ s) => s.id));
  const stapleSlugs = new Set(
    staples.flatMap((/** @type {any} */ s) => [slug(s.name), canonicalFood(s.name)]),
  );
  const boughtPerishables = bought.filter(
    (b) =>
      !stapleIds.has(b.id) &&
      !stapleSlugs.has(slug(b.food)) &&
      !stapleSlugs.has(canonicalFood(b.food)),
  );
  // fridgeFirst: bank what was actually BOUGHT, not the stored row — the
  // rendered trip subtracted what the kitchen already held, so the shopper
  // bought the reduced amount, and a fully-covered ticked row banks nothing
  // ("have enough", not "bought another"). Only valid when this row set IS
  // the rendered trip; see the opts JSDoc for why a household portion must
  // bank verbatim instead.
  const bankRows = opts.fridgeFirst
    ? subtractPantryFromTrip(boughtPerishables, pantry).toBuy
    : boughtPerishables;
  const newPerishables = bankRows.map((b) => ({
    id: perishableId(),
    food: b.food,
    qty: `${b.qty} ${b.unit}`,
    added: today,
    // WHERE it went, not just that it arrived (David, 2026-07-26: "the
    // fridge is kind of a thing but not really"). Without this every bought
    // item landed unsorted, which is the one location no shelf view shows
    // and no sweep touches — the shelves stayed empty however much he
    // bought.
    location: locationForBuy(b.section),
    group: b.section ?? aisleOf(b.food),
  }));
  return {
    shopping: { ...shopping, items: shopping.items.filter((i) => !i.checked) },
    pantry: {
      ...pantry,
      staples,
      perishables: [...(pantry.perishables ?? []), ...newPerishables],
    },
  };
}

/**
 * Which shelf a freshly-bought item goes on, from its store section. Frozen
 * is the freezer, anything from the fresh run is the fridge, the shelf-stable
 * run is the pantry. Deliberately mechanical: he can still move it by hand,
 * and a shelf photo sweep overwrites the guess wholesale.
 * @param {string} section
 * @returns {PantryLocation}
 */
export function locationForBuy(section) {
  if (section === "frozen") return "freezer";
  return tripOf(section) === "fresh" ? "fridge" : "pantry";
}

/**
 * The receipt IS the trip: every list row the till confirms is bought, so it
 * leaves the list and lands on a shelf.
 *
 * David, 2026-07-26: ticking in the aisle should mean "got it", and uploading
 * the receipt should mean "the trip is done" — the list empties and the food
 * shows up in the fridge/pantry. Rows he ticked that the scan never read still
 * count as bought (applyJustBought clears every ticked row): a missed OCR line
 * must not resurrect food that is already in the bag.
 * @param {ShoppingList} shopping
 * @param {Record<string, any>} pantry
 * @param {{ name: string }[]} lines receipt lines, already decoded
 * @param {string} today ISO date
 * @returns {{ shopping: ShoppingList, pantry: Record<string, any> }}
 */
export function applyReceiptStock(shopping, pantry, lines, today) {
  const onReceipt = new Set((lines ?? []).map((l) => canonicalFood(l.name)));
  const marked = {
    ...shopping,
    items: (shopping.items ?? []).map((i) =>
      onReceipt.has(canonicalFood(i.food)) ? { ...i, checked: true } : i,
    ),
  };
  // fridgeFirst is correct here BY CONTRACT: the caller must hand this
  // function the trip that was actually shopped — a solo profile's own list,
  // or the household's MERGED list (main.js handleReceiptApprove) — never
  // one household member's portion of it.
  return applyJustBought(marked, pantry, today, { fridgeFirst: true });
}

/**
 * The receipt ends the WHOLE HOUSE's trip, not just the scanner's (David,
 * 2026-08-01: "when a receipt is pictured it will exit everyone's list").
 * One person shops the FAMILY trip and photographs the till roll; every
 * housemate's rows the till confirms — plus rows already ticked in the
 * aisle, same rule as applyJustBought — leave THEIR list too.
 *
 * Unlike applyJustBought this NEVER banks: the scanner's device stocks the
 * shared pantry exactly once from the MERGED household trip (main.js
 * handleReceiptApprove), which already contains every member's summed
 * quantities. Clearing here is bookkeeping on the to-do lists only.
 * @param {ShoppingList} list a housemate's shopping list
 * @param {{ name: string }[]} lines receipt lines, already decoded
 * @returns {{ list: ShoppingList, changed: boolean }} changed=false means
 *   nothing to remove — skip the write, don't churn their file
 */
export function clearReceiptRows(list, lines) {
  const onReceipt = new Set((lines ?? []).map((l) => canonicalFood(l.name)));
  const kept = (list.items ?? []).filter(
    (i) => !i.checked && !onReceipt.has(canonicalFood(i.food)),
  );
  if (kept.length === (list.items ?? []).length) return { list, changed: false };
  return { list: { ...list, items: kept }, changed: true };
}

/**
 * `"1.98 lb"` → `{ qty: 1.98, unit: "lb" }`. Null for a free-text quantity a
 * shelf scan wrote ("half a bag"), which is exactly the case where arithmetic
 * would be a lie.
 * @param {unknown} raw
 * @returns {{ qty: number, unit: string } | null}
 */
function parseQty(raw) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([a-zA-Z]*)/.exec(String(raw ?? ""));
  if (!m) return null;
  const qty = Number(m[1]);
  return Number.isFinite(qty) ? { qty, unit: m[2] || "x" } : null;
}

/**
 * Both amounts of one food expressed in the same unit, or null when that is
 * not knowable (unknown food AND different units). Known foods route through
 * their own preferred unit, which is what makes "500 g chicken" subtract
 * cleanly from a "1.98 lb" row.
 * @param {{ qty: number, unit: string }} a
 * @param {{ qty: number, unit: string }} b
 * @param {string} key canonical food key
 * @returns {{ a: number, b: number, unit: string } | null}
 */
function commonUnit(a, b, key) {
  const pa = toPreferred(a.qty, a.unit, key);
  const pb = toPreferred(b.qty, b.unit, key);
  if (pa && pb && pa.unit === pb.unit) return { a: pa.qty, b: pb.qty, unit: pa.unit };
  const ua = canonicalUnit(a.unit);
  const ub = canonicalUnit(b.unit);
  if (ua === ub) return { a: a.qty, b: b.qty, unit: ua };
  // same DIMENSION, different units, food not in the preferred table
  // (Tribunal B1): a receipt banks the summed trip as "1.5 kg" of a food
  // FOOD_UNITS never heard of, and next week's "500 g" need must still
  // subtract from it — and consumeForCook must decrement it instead of
  // hitting the "cannot measure" delete. Counts stay excluded: a "can" is
  // not an "each" however equal their table entries look.
  if (dimensionOf(ua) !== "count") {
    const conv = convertUnit(b.qty, ub, ua);
    if (conv != null) return { a: a.qty, b: conv, unit: ua };
  }
  return null;
}

/**
 * Cooking a meal takes its ingredients off the shelves.
 *
 * David, 2026-07-26: "as each recipe is reported to be cooked I want the
 * ingredients subtracted from their respective places." This replaces the
 * old blanket "no decrement-on-cook ledger, ever" rule in docs/SCHEMAS.md,
 * with the honesty fences that made that rule attractive kept intact:
 *
 *  - STAPLES are never decremented. `onHand` is what stops the list re-buying
 *    the whole spice rack every week; a pinch of cayenne is not an inventory
 *    event. Running low stays a manual tap, as it always was.
 *  - Oldest row of a food goes first, and a need bigger than one row carries
 *    into the next — buying chicken twice must not strand the first pack.
 *  - A row whose quantity is free text ("half a bag" from a shelf scan) is
 *    REMOVED rather than fake-subtracted. It went into the pan; inventing a
 *    number for what is left would be worse than admitting we cannot count.
 *  - A row left with a sliver (≤2% ) is removed rather than kept as dust.
 *
 * @param {Record<string, any>} pantry
 * @param {{ food: string, qty?: number, unit?: string, staple?: boolean }[]} ingredients
 *   already scaled to the servings actually cooked
 * @returns {{ pantry: Record<string, any>, used: string[] }}
 */
export function consumeForCook(pantry, ingredients) {
  let perishables = [...(pantry.perishables ?? [])];
  /** @type {string[]} */
  const used = [];
  let changed = false;
  for (const ing of ingredients ?? []) {
    if (!ing || ing.staple) continue;
    const key = canonicalFood(ing.food);
    // oldest first: the pack bought last week is the one to finish
    const rows = perishables
      .map((/** @type {any} */ p, /** @type {number} */ idx) => ({ p, idx }))
      .filter(({ p }) => canonicalFood(p.food) === key)
      .sort((x, y) => String(x.p.added ?? "").localeCompare(String(y.p.added ?? "")));
    if (rows.length === 0) continue;
    let need = Number(ing.qty);
    let needUnit = ing.unit ?? "";
    /** @type {Set<number>} */
    const drop = new Set();
    for (const { p, idx } of rows) {
      const have = parseQty(p.qty);
      const both =
        have && Number.isFinite(need) && needUnit
          ? commonUnit(have, { qty: need, unit: needUnit }, key)
          : null;
      if (!both) {
        // cannot measure it: it was used, so the row goes
        drop.add(idx);
        used.push(p.food);
        changed = true;
        break;
      }
      if (both.b >= both.a * 0.98) {
        drop.add(idx);
        used.push(p.food);
        changed = true;
        // carry the shortfall onto the next row of the same food
        const left = both.b - both.a;
        if (left <= 0) break;
        // subsequent rows are compared in the unit we just resolved into
        need = left;
        needUnit = both.unit;
        continue;
      }
      perishables[idx] = { ...p, qty: `${Number((both.a - both.b).toFixed(2))} ${both.unit}` };
      changed = true;
      break;
    }
    if (drop.size > 0) perishables = perishables.filter((_p, idx) => !drop.has(idx));
  }
  return changed ? { pantry: { ...pantry, perishables }, used } : { pantry, used };
}

/**
 * SUBSTITUTE: converge MY week toward what the rest of the house already buys.
 *
 * David asked for a button that "regenerates lists to match each other more".
 * The obvious reading of that (edit everyone's week so the lists converge) was
 * vetoed at the Tribunal plan gate, and correctly: applying a swap to another
 * person's plan means writing their plan file from my device, which the tables
 * architecture forbids by name. The concrete failure is not hypothetical —
 * their avoid-list may have changed since my copy synced, and a recipe that
 * arrives as a plain plan entry passes no screen on their device.
 *
 * So this only ever proposes swaps to the ACTING profile's own week. That is
 * both safe by construction and what the ask means from the seat of the person
 * pressing the button: fewer odd single-buyer items, one trip that hangs
 * together. Whole recipes are swapped, never ingredients inside one, because
 * editing a Greger-audited recipe's ingredients silently voids the audit.
 *
 * @param {CombinedItem[]} combined the merged household list
 * @param {string} meId
 * @param {Record<string, any>[]} myEntries my plan entries for the week
 * @param {Record<string, any>[]} myPool recipes I may be served (already screened)
 * @param {Map<string, any>} recipesById
 * @returns {{ entryId: string, date: string, slot: string, fromId: string, fromName: string, toId: string, toName: string, drops: string[] }[]}
 */
export function substitutionPlan(combined, meId, myEntries, myPool, recipesById) {
  // foods somebody ELSE is already buying: swapping toward these is free,
  // because the item is in the house's trolley either way
  const othersBuy = new Set();
  /** foods only I am buying — each one is a container someone strands */
  const soloFoods = new Set();
  for (const item of combined) {
    const key = canonicalFood(item.food);
    const mineOnly = item.sources.length === 1 && item.sources[0]?.profileId === meId;
    if (mineOnly) soloFoods.add(key);
    else othersBuy.add(key);
  }
  if (soloFoods.size === 0) return [];

  const foodsOf = (/** @type {any} */ r) =>
    (r?.ingredients ?? [])
      .filter((/** @type {any} */ i) => !i.staple)
      .map((/** @type {any} */ i) => canonicalFood(i.food));

  const out = [];
  for (const entry of myEntries) {
    if (!entry.recipeId || entry.pinned || entry.out || entry.table) continue;
    const current = recipesById.get(entry.recipeId);
    if (!current) continue;
    const currentSolo = foodsOf(current).filter((/** @type {string} */ f) => soloFoods.has(f));
    if (currentSolo.length === 0) continue;

    let best = null;
    for (const candidate of myPool) {
      if (candidate.id === current.id) continue;
      if (candidate.mealType !== current.mealType) continue;
      // a swap must not move the day: same ballpark or it is a different plan,
      // not a substitution
      const a = current.nutrition?.calories ?? 0;
      const b = candidate.nutrition?.calories ?? 0;
      if (a <= 0 || b <= 0 || Math.abs(a - b) / a > 0.15) continue;
      const foods = foodsOf(candidate);
      // every single-buyer food the CANDIDATE needs, including any the current
      // recipe already needed. Excluding those would score a swap between two
      // blue-cheese recipes as a saving when the blue cheese is still bought.
      const newSolo = foods.filter((/** @type {string} */ f) => soloFoods.has(f));
      const shared = foods.filter((/** @type {string} */ f) => othersBuy.has(f)).length;
      // net items removed from the trolley
      const gain = currentSolo.length - newSolo.length;
      if (gain <= 0) continue;
      if (!best || gain > best.gain || (gain === best.gain && shared > best.shared)) {
        best = { candidate, gain, shared };
      }
    }
    if (!best) continue;
    out.push({
      entryId: entry.id,
      date: entry.date,
      slot: entry.slot,
      fromId: current.id,
      fromName: current.name,
      toId: best.candidate.id,
      toName: best.candidate.name,
      drops: currentSolo,
    });
  }
  // biggest saving first, and never more than a handful: this is a suggestion
  // to read, not a rewrite of the week
  return out.sort((a, b) => b.drops.length - a.drops.length).slice(0, 5);
}
