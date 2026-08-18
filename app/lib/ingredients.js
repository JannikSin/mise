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
 *   mixed berries / frozen mixed berries — different aisles
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
  "baby-spinach": { unit: "cup", cup: 30 },
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
  "whey-protein-powder": { unit: "scoop", piece: 30 },
  "fresh-ginger": { unit: "tbsp", cup: 96 },
  // canned goods read in CANS, because that is the thing on the shelf you put
  // in the trolley. "1.3 kg black beans" is a true number and a useless one.
  "black-beans": { unit: "can", cup: 172, can: 425 },
  chickpeas: { unit: "can", cup: 164, can: 425 },
  "kidney-beans": { unit: "can", cup: 177, can: 425 },
  "cannellini-beans": { unit: "can", cup: 179, can: 425 },
  "crushed-tomatoes": { unit: "can", cup: 244, can: 411 },
  "dried-apricots": { unit: "g", cup: 130, piece: 8 },
  "fresh-mint": { unit: "cup", cup: 16 },
  "green-tea-bags": { unit: "each" },
  "red-wine": { unit: "ml" },
  // same-dimension, listed only to pin the unit the list should read in
  "olive-oil": { unit: "tbsp" },
  "toasted-sesame-oil": { unit: "tbsp" },
  salt: { unit: "tsp" },
  "black-pepper": { unit: "tsp" },
  cayenne: { unit: "tsp" },
  paprika: { unit: "tsp" },
  "smoked-paprika": { unit: "tsp" },
  "ground-cumin": { unit: "tsp" },
  "cocoa-powder": { unit: "tbsp" },
  "sesame-seeds": { unit: "tbsp" },
  "ground-flaxseed": { unit: "tbsp" },
  honey: { unit: "tbsp" },
  "maple-syrup": { unit: "tbsp" },
  sugar: { unit: "tbsp" },
  mayonnaise: { unit: "tbsp" },
  "soy-sauce": { unit: "tbsp" },
  sriracha: { unit: "tbsp" },
  cornstarch: { unit: "tbsp" },
  "dijon-mustard": { unit: "tbsp" },
  "rice-vinegar": { unit: "tbsp" },
  "red-wine-vinegar": { unit: "tbsp" },
  "unsalted-butter": { unit: "tbsp" },
  "fresh-cilantro": { unit: "cup" },
  "fresh-parsley": { unit: "tbsp" },
  "bulgogi-marinade": { unit: "tbsp" },
  water: { unit: "cup" },
  milk: { unit: "cup" },
  "chicken-broth": { unit: "cup" },
  "beef-broth": { unit: "cup" },
  onion: { unit: "each" },
  "red-onion": { unit: "each" },
  egg: { unit: "each" },
  tomato: { unit: "each" },
  cucumber: { unit: "each" },
  lemon: { unit: "each" },
  banana: { unit: "each", piece: 118 }, // medium banana, USDA
  avocado: { unit: "each" },
  "bell-pepper": { unit: "each" },
  "bay-leaf": { unit: "each" },
  scallion: { unit: "each" },
  celery: { unit: "each" },
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
  ["seafood", /\b(salmon|tuna|cod|tilapia|shrimp|prawn|scallop|fish|seafood|anchov)\b/],
  ["meat", /\b(beef|chicken|pork|lamb|turkey|thigh|breast|steak|mince|bacon|sausage|ground)\b/],
  [
    "dairy",
    /\b(milk|kefir|yogurt|yoghurt|cheese|butter|cream|cottage|parmesan|feta|brie|halloumi|egg|eggs)\b/,
  ],
  ["bakery", /\b(bread|sourdough|pita|tortilla|bun|bagel|naan|roll)\b/],
  [
    "produce",
    /\b(onion|garlic|tomato|cucumber|cabbage|spinach|broccoli|cauliflower|mushroom|lemon|lime|ginger|avocado|[a-z]*berr(y|ies)|potato|shallot|herb|parsley|cilantro|basil|mint|scallion|lettuce|arugula|kale|carrot|celery|pepper|apple|banana|mango|fruit|greens|zucchini|asparagus|edamame|sprouts|green beans|snap peas|vegetables?)\b/,
  ],
  [
    "canned",
    // legumes in a tin. NOT plain "beans": produce above already claimed the
    // fresh ones, and a bag of green beans is not a canned good
    /\b(can|canned|crushed tomatoes|tomato paste|coconut milk|broth|stock|black beans|kidney beans|cannellini|pinto|butter beans|baked beans|refried|chickpeas|garbanzo|lentil)\b/,
  ],
  [
    // cooking oils shelve with the vinegars and dressings in a US store
    "condiments",
    /\b(oil|sauce|soy|vinegar|mustard|sriracha|mayo|dressing|salsa|harissa|marinade|tahini|miso|mirin)\b/,
  ],
  [
    "spices",
    /\b(cayenne|paprika|salt|peppercorn|black pepper|cumin|coriander|spice|saffron|oregano|thyme|turmeric|cinnamon|chili|curry|bay leaf|flakes)\b/,
  ],
  ["baking", /\b(flour|sugar|baking|yeast|cocoa|vanilla|cornstarch|honey|maple syrup)\b/],
  ["grains", /\b(rice|oats|pasta|noodle|quinoa|couscous|farro|bulgur|barley|tortilla)\b/],
  [
    "snacks",
    /\b(nuts|almond|walnut|cashew|peanut|seed|flaxseed|chia|bar|chips|crackers|apricot|raisin)\b/,
  ],
  ["beverages", /\b(coffee|tea|juice|water|wine|beer|soda)\b/],
  ["household", /\b(foil|wrap|bag|towel|soap|detergent)\b/],
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
