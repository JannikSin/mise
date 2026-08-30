// Canonical ingredient identity: one food name, one unit family, one row on
// the shopping list. The bug this exists to kill (David, 2026-07-25): the
// list showed broccoli several times, because deriveShoppingList keyed merged
// items on `slug(food)-slug(unit)` and the bank writes free-text food names
// in whatever unit each recipe happened to use.
//
// Measured against the real bank: 215 distinct ingredient names, 70 of them
// appearing in more than one unit. The shape of that 70 decides the design:
//
//   1. COUNT SYNONYMS are the biggest group and cost nothing to fix. "onion"
//      is each/unit/whole/medium/large; "egg" is each/large/whole/unit. All
//      mean one item.
//   2. VOLUME SYNONYMS are next. tsp/tbsp/cup/pinch/ml are one dimension and
//      convert exactly, no per-food knowledge needed.
//   3. Only ~25 foods genuinely cross dimensions (broccoli is cup AND g AND
//      head). Those, and only those, need a per-food weight.
//
// So the table is small: aliases for the handful of names that differ, and
// gram weights for the handful of foods that cross dimensions. Everything
// else is handled by unit arithmetic that needs no data at all. Foods absent
// from the table degrade to exactly today's behaviour.
//
// SUM IN THE BASE, DISPLAY IN THE FOOD'S OWN UNIT. Normalizing everything to
// grams would merge correctly and read terribly: 2 tsp of paprika becomes
// "0.3 fl oz (10 ml)". Each known food carries the unit it should be READ in,
// so olive oil stays tbsp, spinach stays cup, chicken breast stays g.

/** @typedef {"mass" | "volume" | "count"} Dimension */

/**
 * Unit spellings the bank actually uses, mapped to one canonical unit per
 * meaning. This alone collapses onion's five spellings and egg's four.
 * @type {Record<string, string>}
 */
const UNIT_ALIASES = {
  // count: a thing you pick up. Size words lose their size, which is correct
  // for a shopping list ("2 large onions" and "2 onions" buy the same bag).
  each: "each",
  unit: "each",
  units: "each",
  whole: "each",
  piece: "each",
  pieces: "each",
  small: "each",
  medium: "each",
  large: "each",
  head: "each",
  heads: "each",
  stalk: "each",
  stalks: "each",
  bunch: "each",
  bunches: "each",
  sprig: "each",
  sprigs: "each",
  bag: "each",
  bags: "each",
  clove: "clove",
  cloves: "clove",
  can: "can",
  cans: "can",
  slice: "slice",
  slices: "slice",
  scoop: "scoop",
  scoops: "scoop",
  pita: "each",
  pitas: "each",
  egg: "each",
  eggs: "each",
  // mass
  g: "g",
  gram: "g",
  grams: "g",
  kg: "kg",
  oz: "oz",
  ounce: "oz",
  ounces: "oz",
  lb: "lb",
  lbs: "lb",
  pound: "lb",
  pounds: "lb",
  // volume
  ml: "ml",
  l: "l",
  liter: "l",
  liters: "l",
  tsp: "tsp",
  teaspoon: "tsp",
  teaspoons: "tsp",
  tbsp: "tbsp",
  tablespoon: "tbsp",
  tablespoons: "tbsp",
  cup: "cup",
  cups: "cup",
  pinch: "pinch",
  pinches: "pinch",
  "fl oz": "fl oz",
  qt: "qt",
  quart: "qt",
};

/** Teaspoons in one US cup, exactly, by definition. The volume base unit is
 * the teaspoon, so this is the bridge to any per-cup weight in FOOD_UNITS. */
const TSP_PER_CUP = 48;

/** One US teaspoon in millilitres, exactly, by definition. */
const ML_PER_TSP = 4.92892159375;

/**
 * Canonical unit to its dimension and size in that dimension's base.
 *
 * Mass counts in grams. Volume counts in TEASPOONS, not millilitres, and
 * that is deliberate: the spoon units are defined as exact multiples of each
 * other (3 tsp to the tbsp, 48 to the cup), so counting in tsp makes every
 * everyday conversion exact integer arithmetic. Counting in ml instead put
 * float dust in the ratio (1 cup came out as 16.0000027 tbsp), which then
 * ceiled a clean 18 tbsp up to 18.25 on the shopping list.
 * @type {Record<string, { dim: Dimension, per: number }>}
 */
const UNIT_BASE = {
  g: { dim: "mass", per: 1 },
  kg: { dim: "mass", per: 1000 },
  oz: { dim: "mass", per: 28.349523125 },
  lb: { dim: "mass", per: 453.59237 },
  tsp: { dim: "volume", per: 1 },
  tbsp: { dim: "volume", per: 3 },
  cup: { dim: "volume", per: 48 },
  "fl oz": { dim: "volume", per: 6 },
  qt: { dim: "volume", per: 192 },
  // a pinch is 1/16 tsp by the usual convention. It only ever appears on
  // spices, where it rounds away against the tsp figures it merges into.
  pinch: { dim: "volume", per: 0.0625 },
  ml: { dim: "volume", per: 1 / ML_PER_TSP },
  l: { dim: "volume", per: 1000 / ML_PER_TSP },
  each: { dim: "count", per: 1 },
  clove: { dim: "count", per: 1 },
  can: { dim: "count", per: 1 },
  slice: { dim: "count", per: 1 },
  scoop: { dim: "count", per: 1 },
};

/**
 * Free-text food names that mean the same thing. Deliberately short: only
 * pairs verified in the bank, because over-merging is the worse failure.
 *
 * NOT merged, on purpose, and each of these is a real trap:
 *   fresh ginger / ground ginger  — different products entirely
 *   firm / extra-firm / silken tofu — different products
 *   brown rice / cooked brown rice — cooked weighs ~3x raw, merging lies
 *   lemon / lemon juice, lime / lime juice — one is fruit, one is a bottle
 *   bell pepper / red bell pepper — the colour was asked for
 * @type {Record<string, string>}
 */
const NAME_ALIASES = {
  oats: "rolled-oats",
  "broccoli-florets": "broccoli",
  mushrooms: "mushroom",
  cilantro: "fresh-cilantro",
  parsley: "fresh-parsley",
  butter: "unsalted-butter",
  "chili-flakes": "red-pepper-flakes",
  "sesame-oil": "toasted-sesame-oil",
  "whole-wheat-pita-bread": "whole-wheat-pita",
  "frozen-mango-chunks": "frozen-mango",
  "celery-stalk": "celery",
  "green-onion": "scallion",
  "spring-onion": "scallion",
  "garbanzo-beans": "chickpeas",
  "greek-yoghurt": "greek-yogurt",
  // the pantry says "Whey protein (5 lb tub)", recipes say "whey protein
  // powder" — two keys meant the PLENTY tub never suppressed the list row
  // and David was told to buy whey he owns in bulk (2026-08-18)
  "whey-protein": "whey-protein-powder",
  // plurals that appear as their own keys in the bank (2026-08-19 audit) —
  // each split key was silently pricing/pinning the same food twice
  scallions: "scallion",
  onions: "onion",
  "bay-leaves": "bay-leaf",
  eggs: "egg",
  "chicken-thighs": "chicken-thigh",
  // David 2026-08-19: fresh vs frozen mixed berries as two rows is
  // "pointless" — every bank use (smoothies, bowls) takes frozen, and the
  // split double-charged one bag as two ($14.49 twice on the same list)
  "frozen-mixed-berries": "mixed-berries",
  "sweet-potatoes": "sweet-potato",
};

/**
 * Per-food data for the foods that genuinely cross unit dimensions, plus the
 * unit each food should be READ in on a shopping list.
 *
 * `cup` = grams per cup, `piece` = grams per one of them, `can` = grams per
 * standard can. Weights are ordinary US-kitchen figures; they only have to be
 * close enough to buy the right amount, never nutrition-grade (macros are
 * computed from the recipe, never from this).
 * @type {Record<string, { unit: string, cup?: number, piece?: number, can?: number }>}
 */
const FOOD_UNITS = {
  // cross-dimension: these are the rows that were splitting
  broccoli: { unit: "g", cup: 91, piece: 600 },
  // GRAMS, not cups (2026-08-23). At 30 g/cup a real week reads "19.5 cup",
  // which is arithmetically right and useless at a shelf: nobody sells
  // spinach by the cup. 585 g maps to bags.
  "baby-spinach": { unit: "g", cup: 30 },
  "rolled-oats": { unit: "g", cup: 90 },
  "cooked-brown-rice": { unit: "cup", cup: 195 },
  "brown-rice": { unit: "g", cup: 190 },
  "shelled-edamame": { unit: "g", cup: 155 },
  "greek-yogurt": { unit: "g", cup: 245 },
  "cherry-tomatoes": { unit: "g", cup: 149 },
  parmesan: { unit: "g", cup: 100 },
  "whole-wheat-couscous": { unit: "g", cup: 173 },
  "feta-cheese": { unit: "g", cup: 150 },
  "kalamata-olives": { unit: "g", cup: 135 },
  "shredded-cheddar-cheese": { unit: "g", cup: 113 },
  "sliced-almonds": { unit: "cup", cup: 92 },
  "peanut-butter": { unit: "tbsp", cup: 258 },
  carrot: { unit: "each", piece: 61 },
  "sweet-potato": { unit: "each", piece: 130 },
  "red-cabbage": { unit: "each", piece: 900 },
  mushroom: { unit: "g", cup: 70 },
  "chicken-breast": { unit: "g", piece: 174 },
  // one fillet portion ≈ 6 oz — without a piece weight, "4 each" priced as
  // four POUNDS at a per-lb store row (seed audit 2026-08-19)
  "salmon-fillet": { unit: "g", piece: 170 },
  apricot: { unit: "each", piece: 35 },
  // a sandwich slice ≈ 34 g — without it, "5 slice" charged five whole loaves
  "whole-grain-bread": { unit: "slice", piece: 34 },
  "whey-protein-powder": { unit: "scoop", piece: 30 },
  // one knob ≈ 60 g (the retail purchase floor lives in prices.js
  // PER_LB_MIN_G, not here — this is the portion fact)
  "fresh-ginger": { unit: "tbsp", cup: 96, piece: 60 },
  // frozen berries ≈ 150 g/cup — without it the cups-vs-oz-bag conversion
  // failed and every berry row fell back to "one whole package, flagged"
  "mixed-berries": { unit: "cup", cup: 150 },
  // same class as the spinach and flaxseed rows (2026-08-23): berries carried
  // no weight, so a real week read "blueberries 11 cup" — true, and not a
  // thing you can pick up. ~148 g/cup, so it reads as a bag.
  blueberries: { unit: "g", cup: 148 },
  strawberries: { unit: "g", cup: 152 },
  raspberries: { unit: "g", cup: 123 },
  // canned goods read in CANS, because that is the thing on the shelf you put
  // in the trolley. "1.3 kg black beans" is a true number and a useless one.
  "black-beans": { unit: "can", cup: 172, can: 425 },
  chickpeas: { unit: "can", cup: 164, can: 425 },
  "kidney-beans": { unit: "can", cup: 177, can: 425 },
  "cannellini-beans": { unit: "can", cup: 179, can: 425 },
  "crushed-tomatoes": { unit: "can", cup: 244, can: 411 },
  // dry lentils were in NO unit table, so mergeIdentity fell back to
  // `${key}-${unit}` and the same food bought in grams by one recipe and in
  // cups by another became TWO rows on the list, bought twice (2026-08-23).
  // 1 cup dry ~ 192 g.
  "red-lentils": { unit: "g", cup: 192 },
  lentils: { unit: "g", cup: 192 },
  "dried-apricots": { unit: "g", cup: 130, piece: 8 },
  "fresh-mint": { unit: "cup", cup: 16 },
  "green-tea-bags": { unit: "each" },
  "red-wine": { unit: "ml" },
  // Cup weights here too (2026-08-30, second round): a gram-written need
  // against a fl-oz bottle, or a tsp against a weight jar, fell to the
  // whole-package fallback — 10 g of olive oil "ate" the $7.49 bottle and
  // the composer's cost signal read a $17/serving rice bowl.
  "olive-oil": { unit: "tbsp", cup: 216 },
  "toasted-sesame-oil": { unit: "tbsp", cup: 218 },
  // Cup weights on the spice/condiment rows (USDA): without one, a tsp-sized
  // need against a weight-labelled jar cannot convert, itemCost falls back to
  // "one whole package, flagged", and eaten==cost — $129.00 of the W36 week's
  // $247 "eaten" was whole spice jars and syrup bottles counted as consumed
  // (2026-08-30). The trip cost was right; the eaten meter was lying.
  salt: { unit: "tsp", cup: 288 },
  "black-pepper": { unit: "tsp", cup: 110 },
  cayenne: { unit: "tsp", cup: 102 },
  paprika: { unit: "tsp", cup: 110 },
  "smoked-paprika": { unit: "tsp", cup: 110 },
  "ground-cumin": { unit: "tsp", cup: 96 },
  "cocoa-powder": { unit: "tbsp" },
  "sesame-seeds": { unit: "tbsp", cup: 144 },
  // was { unit: "tbsp" } with NO cup weight, so it could not convert to
  // anything purchasable and a real week read "31.25 tbsp" (2026-08-23).
  // 1 tbsp = 7 g, so 1 cup = 112 g.
  "ground-flaxseed": { unit: "g", cup: 112 },
  honey: { unit: "tbsp", cup: 336 },
  "maple-syrup": { unit: "tbsp", cup: 315 },
  sugar: { unit: "tbsp", cup: 200 },
  mayonnaise: { unit: "tbsp", cup: 232 },
  // cup weight so a "3 tbsp" row can read "≈ 1 × 10 oz" against a
  // weight-labelled bottle (P4: every row maps to a purchasable thing)
  "soy-sauce": { unit: "tbsp", cup: 255 },
  sriracha: { unit: "tbsp", cup: 260 },
  cornstarch: { unit: "tbsp", cup: 128 },
  "dijon-mustard": { unit: "tbsp", cup: 249 },
  "rice-vinegar": { unit: "tbsp", cup: 239 },
  "red-wine-vinegar": { unit: "tbsp", cup: 239 },
  "unsalted-butter": { unit: "tbsp", cup: 227 },
  "fresh-cilantro": { unit: "cup", cup: 16 },
  "fresh-parsley": { unit: "tbsp", cup: 60 },
  "bulgogi-marinade": { unit: "tbsp", cup: 288 },
  gochujang: { unit: "tbsp", cup: 336 },
  "mixed-vegetables": { unit: "g", cup: 91 },
  water: { unit: "cup", cup: 237 },
  milk: { unit: "cup", cup: 245 },
  "whole-milk": { unit: "cup", cup: 245 },
  "chicken-broth": { unit: "cup", cup: 240 },
  "beef-broth": { unit: "cup", cup: 240 },
  "vegetable-broth": { unit: "cup", cup: 240 },
  "low-sodium-vegetable-broth": { unit: "cup", cup: 240 },
  "low-sodium-soy-sauce": { unit: "tbsp", cup: 255 },
  // "ginger" unqualified means the fresh knob in this bank (mapo tofu et al);
  // a separate key from fresh-ginger on purpose — aliasing them would re-key
  // the existing pins and catalogue rows written under "ginger"
  ginger: { unit: "tbsp", cup: 96, piece: 60 },
  "ground-ginger": { unit: "tsp", cup: 86 },
  turmeric: { unit: "tsp", cup: 150 },
  "dried-oregano": { unit: "tsp", cup: 48 },
  "dried-herbes-de-provence": { unit: "tsp", cup: 43 },
  "chili-powder": { unit: "tsp", cup: 128 },
  "baking-powder": { unit: "tsp", cup: 220 },
  "pine-nuts": { unit: "tbsp", cup: 135 },
  walnuts: { unit: "cup", cup: 117 },
  pecans: { unit: "cup", cup: 109 },
  almonds: { unit: "cup", cup: 143 },
  raisins: { unit: "cup", cup: 145 },
  "dark-chocolate-chips": { unit: "cup", cup: 170 },
  "frozen-mango": { unit: "cup", cup: 165 },
  "frozen-pineapple-chunks": { unit: "cup", cup: 165 },
  "fresh-basil": { unit: "cup", cup: 24 },
  "tomato-paste": { unit: "tbsp", cup: 262 },
  "fermented-black-beans": { unit: "tbsp", cup: 160 },
  // Piece weights (grams, USDA medium sizes) for every counted food the bank
  // uses: without one, "3 each" against a weight-labelled package cannot be
  // weighed and used to charge one PACKAGE per piece — 3 lemons billed as
  // three 2 lb bags, the 2026-08-18 rescue-cart failure ($43 est → $70 till).
  onion: { unit: "each", piece: 200 },
  "red-onion": { unit: "each", piece: 200 },
  egg: { unit: "each", piece: 50 }, // large egg, USDA — 150 g of eggs is 3, never a 60 ct carton
  tomato: { unit: "each", piece: 123 },
  cucumber: { unit: "each", piece: 300 },
  lemon: { unit: "each", piece: 100 },
  lime: { unit: "each", piece: 67 },
  orange: { unit: "each", piece: 150 },
  apple: { unit: "each", piece: 180 },
  banana: { unit: "each", piece: 118 }, // medium banana, USDA
  avocado: { unit: "each", piece: 150 },
  "bell-pepper": { unit: "each", piece: 180 },
  "green-bell-pepper": { unit: "each", piece: 180 },
  "red-bell-pepper": { unit: "each", piece: 180 },
  "bay-leaf": { unit: "each" },
  scallion: { unit: "each", piece: 15 },
  celery: { unit: "each", piece: 40 },
  zucchini: { unit: "each", piece: 200 },
  eggplant: { unit: "each", piece: 450 },
  "cauliflower-head": { unit: "each", piece: 600 },
  "fennel-bulb": { unit: "each", piece: 230 },
  shallot: { unit: "each", piece: 30 },
  "russet-potato": { unit: "each", piece: 300 },
  "scotch-bonnet-chili": { unit: "each", piece: 10 },
  "red-chili": { unit: "each", piece: 15 },
  garlic: { unit: "clove", piece: 5 },
  "chicken-thigh": { unit: "g", piece: 130 }, // boneless-skinless raw
  "white-bread": { unit: "slice", piece: 30 },
  "whole-wheat-bread": { unit: "slice", piece: 34 },
  "sourdough-bread": { unit: "slice", piece: 50 },
  "crusty-bread": { unit: "slice", piece: 50 },
  "crusty-whole-grain-bread": { unit: "slice", piece: 50 },
  "canned-tuna": { unit: "can", can: 142 },
  "frozen-mixed-vegetables": { unit: "g", piece: 340, cup: 91 }, // piece = one 12 oz bag
  "whole-wheat-pita": { unit: "each", piece: 60 },
};

/** Prep states written after a comma: "silken tofu, cubed" is silken tofu. */
const PREP_SUFFIX =
  /,\s*(chopped|cubed|diced|sliced|minced|trimmed|drained|rinsed|halved|quartered|shredded|grated|crushed|torn|peeled|thawed|cooked|beaten|melted|softened|to taste|optional)\b.*$/i;

/**
 * Slug a food name the way the shopping list always has.
 * @param {string} food
 * @returns {string}
 */
function slugify(food) {
  return (food ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * The one key a food is known by: prep suffix stripped, then aliased. A name
 * the table has never seen passes through as its own slug, so a new recipe
 * with a novel spelling behaves exactly as it does today rather than
 * mis-merging into something else.
 * @param {string} food
 * @returns {string}
 */
export function canonicalFood(food) {
  // parentheticals are packaging or prep, never identity: "Oats (large
  // container)" is oats. prices.js words() has always stripped them; this
  // matcher not doing the same is why onHand pantry rows failed to subtract
  // and David bought food he already owned (fix list 0.3, 2026-08-18).
  const stripped = (food ?? "").replace(/\s*\([^)]*\)/g, "").replace(PREP_SUFFIX, "");
  const key = slugify(stripped);
  return NAME_ALIASES[key] ?? key;
}

/**
 * Canonical spelling of a unit ("cups" and "cup" are one unit; "large" and
 * "whole" are both just one of the thing). Unknown units pass through
 * lowercased and trimmed.
 * @param {string} unit
 * @returns {string}
 */
export function canonicalUnit(unit) {
  const u = (unit ?? "").toLowerCase().trim();
  return UNIT_ALIASES[u] ?? u;
}

/**
 * Which dimension a canonical unit measures, or null if we do not know it.
 * @param {string} unit
 * @returns {Dimension | null}
 */
/**
 * Convert a quantity between two units of the SAME dimension via the unit
 * table, independent of any food's preferred unit. Null when either unit is
 * unknown or the dimensions differ. The receipt-banking fix (Tribunal B1,
 * 2026-08-01) rides on this: a summed trip banks "1.5 kg" of a food that has
 * no FOOD_UNITS entry, and next week's "500 g" need must still subtract.
 * @param {number} qty
 * @param {string} from
 * @param {string} to
 * @returns {number | null}
 */
export function convertUnit(qty, from, to) {
  const f = UNIT_BASE[/** @type {keyof typeof UNIT_BASE} */ (canonicalUnit(from))];
  const t = UNIT_BASE[/** @type {keyof typeof UNIT_BASE} */ (canonicalUnit(to))];
  if (!f || !t || f.dim !== t.dim) return null;
  return (qty * f.per) / t.per;
}

/**
 * @param {string} unit
 * @returns {Dimension | null}
 */
export function dimensionOf(unit) {
  const base = UNIT_BASE[canonicalUnit(unit)];
  return base ? /** @type {Dimension} */ (base.dim) : null;
}

/**
 * Convert a quantity into a food's own preferred unit, so every recipe's
 * contribution can be summed on one row and read in a sane unit.
 *
 * Returns null when the conversion is not knowable: an unknown unit, or a
 * cross-dimension hop for a food with no weight in the table. Callers fall
 * back to today's unit-aware behaviour, which keeps the row split but never
 * invents a number.
 * @param {number} qty
 * @param {string} unit
 * @param {string} key canonical food key
 * @returns {{ qty: number, unit: string } | null}
 */
export function toPreferred(qty, unit, key) {
  const from = canonicalUnit(unit);
  const food = FOOD_UNITS[key];
  if (!food) return null;
  const to = canonicalUnit(food.unit);
  if (from === to) return { qty, unit: to };

  const fromBase = UNIT_BASE[from];
  const toBase = UNIT_BASE[to];
  if (!fromBase || !toBase) return null;

  // same dimension: pure arithmetic, no food knowledge needed. This is what
  // fixes tsp/tbsp/cup and each/whole/large without any table entry.
  if (fromBase.dim === toBase.dim) {
    return { qty: (qty * fromBase.per) / toBase.per, unit: to };
  }

  // crossing dimensions needs this food's weight. Everything routes through
  // grams: get there from the source unit, then out to the target unit.
  const grams = toGrams(qty, from, key);
  if (grams == null) return null;
  if (toBase.dim === "mass") return { qty: grams / toBase.per, unit: to };
  if (toBase.dim === "volume" && food.cup) {
    return { qty: (grams / food.cup) * (TSP_PER_CUP / toBase.per), unit: to };
  }
  if (toBase.dim === "count") {
    const per = to === "can" ? food.can : food.piece;
    if (per) return { qty: grams / per, unit: to };
  }
  return null;
}

/**
 * Weight in grams of a quantity of a known food, or null when unknowable.
 * @param {number} qty
 * @param {string} unit
 * @param {string} key canonical food key
 * @returns {number | null}
 */
export function toGrams(qty, unit, key) {
  const u = canonicalUnit(unit);
  const base = UNIT_BASE[u];
  if (!base) return null;
  if (base.dim === "mass") return qty * base.per;
  const food = FOOD_UNITS[key];
  if (!food) return null;
  if (base.dim === "volume") {
    if (!food.cup) return null;
    return ((qty * base.per) / TSP_PER_CUP) * food.cup;
  }
  // count
  const per = u === "can" ? food.can : food.piece;
  return per ? qty * per : null;
}

/**
 * The merge identity of a recipe ingredient: the key a shopping row is
 * summed under. Foods in the table collapse to one row; foods outside it
 * keep the unit in the key exactly as before, so an unknown name can never
 * silently merge two different things.
 * @param {string} food
 * @param {string} unit
 * @returns {{ id: string, key: string, qty: (q: number) => { qty: number, unit: string } | null }}
 */
export function mergeIdentity(food, unit) {
  const key = canonicalFood(food);
  const known = FOOD_UNITS[key];
  return {
    key,
    id: known ? key : `${key}-${slugify(canonicalUnit(unit))}`,
    qty: (q) => (known ? toPreferred(q, unit, key) : null),
  };
}

/** Store aisles, in the order a US grocery store actually walks. */
export const AISLES = [
  "produce",
  "meat",
  "seafood",
  "dairy",
  "frozen",
  "bakery",
  "grains",
  "canned",
  "condiments",
  "spices",
  "baking",
  "snacks",
  "beverages",
  "household",
  "other",
];

/**
 * Aisle for a food. Keyword-matched like the old SECTIONS list it replaces,
 * but wider and ordered so the first match is the most specific one.
 * @type {[string, RegExp][]}
 */
const AISLE_RULES = [
  ["frozen", /\bfrozen\b/],
  // BEFORE meat and produce, both of which used to claim it: "chicken broth"
  // matched `chicken` and filed under MEAT, "low-sodium vegetable broth"
  // matched `vegetables?` and filed under PRODUCE. Neither is where a carton
  // of stock is shelved, and an aisle is a walking order, so a wrong one
  // costs a lap of the store (2026-08-23).
  ["canned", /\b(broth|stock)s?\b/],
  // a GROUND spice is a shaker in the spice aisle, whatever the plant is.
  // Without this, "ground ginger" matched `ginger` and filed under PRODUCE,
  // sending him to the fresh-root shelf for a jar (2026-08-23). Same shape
  // as the bare-`ground` fix in the meat rule below.
  [
    "spices",
    /\bground (ginger|cinnamon|cumin|coriander|turmeric|nutmeg|clove|allspice|cardamom|mustard)s?\b/,
  ],
  // BEFORE produce, which claims the entire `pepper` family. Cayenne was
  // ALREADY listed in the spices rule further down and could never reach it,
  // because produce matched `pepper` first and the first match wins. David
  // scanned his spice cabinet on 2026-08-26 and cayenne pepper filed under
  // PRODUCE. Paprika, peppercorns and a jar of red pepper flakes are shakers
  // on a rack, not fresh peppers on a produce table. Same shape as the
  // `ground ginger` fix above.
  [
    "spices",
    /\b(cayenne|paprika|peppercorns?|black pepper|white pepper|red pepper flakes|crushed red pepper|pepper flakes|chill?i powder|curry powder)\b/,
  ],
  // BEFORE dairy, which claims every `butter`. A nut or seed butter is a jar
  // on a shelf, not a refrigerated case, and TAHINI (a sesame butter) is
  // already filed under condiments below, so its siblings belong beside it.
  // "almond butter" filed under DAIRY in David's first Wayne scan.
  [
    "condiments",
    /\b(almond|peanut|cashew|sunflower|hazelnut|pistachio|nut|seed|sesame|soy) butters?\b/,
  ],
  // butter BEANS are a tin. The canned rule below already says so and never
  // got the chance, because dairy's `butter` matched first (2026-08-27).
  ["canned", /\bbutter beans?\b/],
  // BEFORE dairy and baking, each of which claims a snack by one word:
  // "parmesan crisps" is not cheese and "almond flour crackers" are not
  // flour (2026-08-27). Chocolate chips genuinely ARE baking, so they are
  // claimed first.
  ["baking", /\bchocolate chips?\b/],
  ["snacks", /\b(crackers?|crisps?|chips?|pretzels?|popcorn)\b/],
  ["seafood", /\b(salmon|tuna|cod|tilapia|shrimps?|prawns?|scallops?|fish|seafood|anchov)\b/],
  // NO bare `ground` (2026-08-23). It filed "ground flaxseed" under MEAT, and
  // would do the same to ground cumin, cinnamon and ginger. Every real ground
  // meat is already caught by its animal: ground beef by `beef`, ground
  // turkey by `turkey`, with `mince` for the rest.
  ["meat", /\b(beef|chicken|pork|lamb|turkey|thighs?|breasts?|steaks?|mince|bacon|sausages?)\b/],
  [
    "dairy",
    /\b(milk|kefir|yogurt|yoghurt|cheeses?|butter|creams?|cottage|parmesan|feta|brie|halloumi|eggs?)\b/,
  ],
  ["bakery", /\b(breads?|sourdough|pitas?|tortillas?|buns?|bagels?|naan|rolls?)\b/],
  // BEFORE produce, which now matches the plural `tomatoes`. A tin of crushed
  // tomatoes is not a produce run, and it used to file under canned only
  // because the singular `tomato` missed the word entirely (2026-08-27).
  ["canned", /\b(crushed|diced|canned|stewed)[- ]tomatoes\b|\btomato paste\b/],
  // BEFORE produce, whose `herb` now matches the plural `herbs`. Dried herbs
  // are a jar on the spice rack; the fresh ones below are the produce table.
  [
    "spices",
    /\bdried (?:[a-z]+ )?(?:herbs?|herbes|oregano|basil|thyme|rosemary|parsley|mint|dill|sage|tarragon|chives?|bay)\b/,
  ],
  // PLURALS (David, 2026-08-27). Every keyword below used to be singular
  // inside \b...\b, so "bananas", "lemons" and "pumpkin seeds" matched
  // nothing and fell through to OTHER while "banana", "lemon" and "seed"
  // classified fine. A camera scan writes what the LABEL says and labels are
  // plural, so most of the fresh half of David's first Wayne pantry landed
  // unsorted. The trailing (?:e?s)? covers -s and -es; irregular plurals
  // (berries, cherries) stay spelled out.
  [
    "produce",
    /\b(?:onion|garlic|tomato|cucumber|cabbage|spinach|broccoli|cauliflower|mushroom|lemon|lime|ginger|avocado|[a-z]*berr(?:y|ies)|cherr(?:y|ies)|potato|shallot|herb|parsley|cilantro|basil|mint|scallion|lettuce|arugula|kale|carrot|celery|pepper|apple|banana|mango|kiwi|pear|fruit|greens|zucchini|eggplant|fennel|asparagus|edamame|sprouts|green bean|snap peas|vegetable)(?:e?s)?\b/,
  ],
  [
    "canned",
    // legumes in a tin. NOT plain "beans": produce above already claimed the
    // fresh ones, and a bag of green beans is not a canned good
    /\b(?:can|canned|crushed tomatoes|tomato paste|coconut milk|broth|stock|black bean|kidney bean|cannellini|pinto|butter bean|baked bean|refried|chickpea|garbanzo|lentil)(?:e?s)?\b/,
  ],
  [
    // cooking oils shelve with the vinegars and dressings in a US store
    "condiments",
    /\b(?:oil|sauce|soy|vinegar|mustard|sriracha|mayo|dressing|salsa|harissa|marinade|tahini|miso|mirin|doubanjiang|gochujang|pesto)(?:e?s)?\b/,
  ],
  [
    "spices",
    /\b(?:cayenne|paprika|salt|peppercorn|black pepper|cumin|coriander|spice|saffron|oregano|thyme|turmeric|cinnamon|chili|curry|bay leaf|flake)(?:e?s)?\b/,
  ],
  ["baking", /\b(?:flour|sugar|baking|yeast|cocoa|vanilla|cornstarch|honey|maple syrup)(?:e?s)?\b/],
  [
    "grains",
    /\b(?:rice|oats|pasta|noodle|quinoa|couscous|farro|bulgur|barley|tortilla|rigatoni|spaghetti|penne|macaroni|linguine|fettuccine|orzo)(?:e?s)?\b/,
  ],
  [
    "snacks",
    /\b(?:nut|almond|walnut|pecan|cashew|peanut|seed|flaxseed|chia|hemp heart|granola|bar|chip|cracker|apricot|raisin|date)(?:e?s)?\b/,
  ],
  ["beverages", /\b(?:coffee|tea|juice|water|wine|beer|soda)(?:e?s)?\b/],
  ["household", /\b(?:foil|wrap|bag|towel|soap|detergent)(?:e?s)?\b/],
];

/**
 * Which aisle a food belongs to. Takes the raw food name (not the key) so a
 * name outside the alias table still classifies on its own words.
 * @param {string} food
 * @returns {string}
 */
export function aisleOf(food) {
  const f = (food ?? "").toLowerCase();
  for (const [aisle, re] of AISLE_RULES) if (re.test(f)) return aisle;
  return "other";
}

/** Foods the table knows, for the drift-guard test. @returns {string[]} */
export function knownFoods() {
  return Object.keys(FOOD_UNITS);
}
