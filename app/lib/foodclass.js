// NEUTRAL FOOD FACTS. Not a philosophy.
//
// This module answers questions ABOUT a food that no nutrition philosophy
// disputes: is this a whole food or an industrially formulated one, is this
// grain whole or refined, is this an added sugar, is this processed red meat,
// does this protein come from a plant or an animal, and which plant species
// is it. What to DO with those facts, which ones matter and how much, is the
// bundle's job (see philosophy.js). Keeping the facts here and the weights
// there is what makes "the engine holds no philosophy" true rather than
// asserted.
//
// STATED JUDGMENTS, because a reader deserves to argue with them:
//  - Three tiers, NOVA-shaped but deliberately coarser. Tier 0 is a food you
//    could have grown or butchered; tier 1 is something a kitchen does to a
//    food (pressing oil, milling flour, culturing milk, canning tomatoes);
//    tier 2 is something only a factory does (emulsified sauces, cured deli
//    meat, formulated drinks).
//  - CONVENIENCE IS NOT PENALISED. Frozen vegetables, canned beans, canned
//    tuna, tofu and plain whey are a broke student's friends and score clean.
//    Gardner's SWAP-MEAT trial found a NOVA-4 food beating beef on TMAO and
//    LDL, so processing degree is a signal, never a verdict.
//  - Flavor rows are NOT classified here. `partOf` in synth.js already does
//    that, and it has been debugged the hard way: black pepper once read as a
//    vegetable, beef broth as beef, rice vinegar as rice, green beans as a
//    starch. Reusing it rather than writing a second keyword list is the
//    whole point.
//
// The matcher is LONGEST-KEYWORD-FIRST, never first-match, for exactly the
// reason above: "whole wheat pasta" must not resolve on "pasta", and
// "unsweetened soy milk" must not resolve on "milk".

/**
 * Foods a factory makes. Anything not listed and not culinary is treated as
 * whole, so this table failing open means "we did not claim it was bad".
 * @type {string[]}
 */
const FORMULATED = [
  "bulgogi marinade",
  "japanese curry roux",
  "instant dashi powder",
  "basil pesto",
  "oyster sauce",
  "ponzu",
  "sriracha",
  "mayonnaise",
  "sports drink",
  "gelatin dessert",
  "ice pop",
  "saltine crackers",
  "granola",
  "white bread",
  "apple juice",
  "sliced turkey",
  "queso para freir",
  "cream of wheat",
  "berbere spice blend",
  "harissa paste",
  "aji amarillo paste",
  "doubanjiang",
  "gochujang",
];

/**
 * Things a kitchen does to a food. Not a criticism: olive oil, canned
 * tomatoes and cultured yogurt are how cooking works.
 * @type {string[]}
 */
const CULINARY = [
  "olive oil",
  "sesame oil",
  "vegetable oil",
  "light coconut milk",
  "unsalted butter",
  "butter",
  "sugar",
  "brown sugar",
  "honey",
  "maple syrup",
  "all-purpose flour",
  "whole wheat flour",
  "whole wheat breadcrumbs",
  "cornstarch",
  "crushed tomatoes",
  "tomato paste",
  "chicken broth",
  "beef broth",
  "vegetable broth",
  "low-sodium vegetable broth",
  "soy sauce",
  "low-sodium soy sauce",
  "low-sodium tamari",
  "miso paste",
  "fermented black beans",
  "dijon mustard",
  "rice vinegar",
  "red wine vinegar",
  "sherry vinegar",
  "dry white wine",
  "red wine",
  "whey protein powder",
  "creatine monohydrate",
  "parmesan",
  "parmesan rind",
  "feta cheese",
  "mild cheddar",
  "shredded cheddar cheese",
  "cottage cheese",
  "greek yogurt",
  "plain low-fat yogurt",
  "milk",
  "skim milk",
  "unsweetened soy milk",
  "tahini",
  "peanut butter",
  "almond butter",
  "kalamata olives",
  "capers",
  "pasta",
  "potato gnocchi",
  "rice vermicelli noodles",
  "white rice",
  "arborio rice",
  "applesauce",
  "canned peaches",
  "cocoa powder",
  "vanilla extract",
  "baking powder",
  "matcha green tea powder",
  "wheat germ",
  "nori",
  "dried porcini mushrooms",
  "dried apricots",
  "espresso",
  "black coffee",
];

/** Whole grains, which are also tier 0. */
const WHOLE_GRAIN = [
  "brown rice",
  "cooked brown rice",
  "quinoa",
  "farro",
  "rolled oats",
  "steel-cut oats",
  "whole wheat pasta",
  "whole wheat spaghetti",
  "whole wheat rigatoni",
  "whole wheat orzo",
  "whole wheat couscous",
  "whole wheat egg noodles",
  "whole wheat small pasta",
  "whole wheat angel hair pasta",
  "whole wheat pita bread",
  "whole wheat bread",
  "whole grain bread",
  "crusty whole grain bread",
  "whole wheat flour",
  "whole wheat breadcrumbs",
  "wheat germ",
  "bulgur",
];

/** Refined grains. */
const REFINED_GRAIN = [
  "white rice",
  "arborio rice",
  "all-purpose flour",
  "pasta",
  "potato gnocchi",
  "rice vermicelli noodles",
  "white bread",
  "sourdough bread",
  "crusty bread",
  "saltine crackers",
  "cream of wheat",
  "couscous",
];

/** Sugars added to a dish, as opposed to sugar that came inside a fruit. */
const ADDED_SUGAR = ["sugar", "brown sugar", "honey", "maple syrup", "apple juice"];

/**
 * Processed red meat. The ONE animal-food rule with evidence strong enough
 * to be absolute here (IARC 2015 and the EPIC cohorts), and deliberately
 * narrower than "red meat", which does not carry the same weight.
 */
const PROCESSED_RED_MEAT = [
  "bacon",
  "sausage",
  "chorizo",
  "pepperoni",
  "salami",
  "prosciutto",
  "ham",
  "hot dog",
  "deli meat",
  "sliced turkey",
  "pancetta",
  "guanciale",
];

/** Protein sources, split by where the protein came from. */
const PLANT_PROTEIN = [
  "extra-firm tofu",
  "silken tofu",
  "soft tofu",
  "tofu",
  "tempeh",
  "shelled edamame",
  "black beans",
  "cannellini beans",
  "kidney beans",
  "pinto beans",
  "chickpeas",
  "brown lentils",
  "red lentils",
  "lentils",
  "unsweetened soy milk",
  "peanut butter",
  "roasted peanuts",
  "almonds",
  "sliced almonds",
  "slivered almonds",
  "walnuts",
  "cashews",
  "pecans",
  "pine nuts",
  "chia seeds",
  "ground flaxseed",
  "sesame seeds",
  "tahini",
  "almond butter",
  "quinoa",
];

const ANIMAL_PROTEIN = [
  "chicken breast",
  "chicken thigh",
  "chicken thighs",
  "boneless skinless chicken thighs",
  "ground beef",
  "ground turkey",
  "beef",
  "beef cheeks",
  "flank steak",
  "salmon fillet",
  "cod",
  "cod fillet",
  "shrimp",
  "canned tuna",
  "anchovy",
  "egg",
  "greek yogurt",
  "plain low-fat yogurt",
  "cottage cheese",
  "milk",
  "skim milk",
  "parmesan",
  "feta cheese",
  "mild cheddar",
  "shredded cheddar cheese",
  "queso para freir",
  "whey protein powder",
  "sliced turkey",
];

// ONE RESOLUTION, NOT EIGHT INDEPENDENT ONES.
//
// The first version of this asked each category "does any of your keywords
// appear in this food name", which made the longest-first ordering
// decorative: "whole wheat pasta" matched WHOLE_GRAIN *and* REFINED_GRAIN,
// because it contains "pasta". That is the identical shape of the bug the P8
// unparking found four times in an hour, and the test caught it here before
// it could score anything.
//
// So: find the single LONGEST keyword that matches, once, and then ask which
// categories that exact keyword belongs to. A food may legitimately sit in
// several (whole wheat flour is a whole grain AND a kitchen ingredient); what
// it may never do is answer to a shorter keyword that happens to be a
// substring of its real name.

/** every keyword any table knows, longest first */
const KEYWORDS = [
  ...new Set([
    ...FORMULATED,
    ...CULINARY,
    ...WHOLE_GRAIN,
    ...REFINED_GRAIN,
    ...ADDED_SUGAR,
    ...PROCESSED_RED_MEAT,
    ...PLANT_PROTEIN,
    ...ANIMAL_PROTEIN,
  ]),
].sort((a, b) => b.length - a.length);

/**
 * The most specific keyword this food answers to, or null.
 * @param {string} food
 * @returns {string | null}
 */
function bestKeyword(food) {
  const f = String(food ?? "").toLowerCase().trim();
  if (!f) return null;
  return KEYWORDS.find((k) => f === k || f.includes(k)) ?? null;
}

/**
 * @param {string} food
 * @param {string[]} list
 * @returns {boolean}
 */
function inCategory(food, list) {
  const k = bestKeyword(food);
  return k !== null && list.includes(k);
}

/**
 * How processed a food is. 0 whole, 1 kitchen-processed, 2 industrially
 * formulated. Unknown foods return 0: we do not claim a food is bad merely
 * because this table has not heard of it.
 * @param {string} food
 * @returns {0 | 1 | 2}
 */
export function processingTier(food) {
  const k = bestKeyword(food);
  if (k === null) return 0;
  if (FORMULATED.includes(k)) return 2;
  // a whole grain is tier 0 even when it is also a kitchen ingredient, EXCEPT
  // once it has been milled: whole wheat flour is still whole, but making it
  // is something a kitchen does
  if (WHOLE_GRAIN.includes(k) && !/flour|breadcrumb/.test(k)) return 0;
  if (CULINARY.includes(k)) return 1;
  return 0;
}

/** @param {string} food @returns {boolean} */
export const isWholeGrain = (food) => inCategory(food, WHOLE_GRAIN);
/** @param {string} food @returns {boolean} */
export const isRefinedGrain = (food) => inCategory(food, REFINED_GRAIN);
/** @param {string} food @returns {boolean} */
export const isAddedSugar = (food) => inCategory(food, ADDED_SUGAR);
/** @param {string} food @returns {boolean} */
export const isProcessedRedMeat = (food) => inCategory(food, PROCESSED_RED_MEAT);

/**
 * Where a protein-carrying food's protein comes from, or null when the food
 * is not a meaningful protein source at all.
 * @param {string} food
 * @returns {"plant" | "animal" | null}
 */
export function proteinSourceOf(food) {
  const k = bestKeyword(food);
  if (k === null) return null;
  if (ANIMAL_PROTEIN.includes(k)) return "animal";
  if (PLANT_PROTEIN.includes(k)) return "plant";
  return null;
}

/**
 * A canonical plant name for diversity counting, or null for anything that
 * is not a distinct plant. Species diversity is a WEEK-level idea, which is
 * exactly why it lives as a fact here and a floor in the bundle.
 * @param {string} food
 * @returns {string | null}
 */
export function plantSpeciesOf(food) {
  const f = String(food ?? "").toLowerCase().trim();
  if (!f) return null;
  if (proteinSourceOf(f) === "animal") return null;
  if (/\b(water|ice|salt|broth|coffee|tea|wine|vinegar)\b/.test(f)) return null;
  // strip preparation words so "frozen mixed berries" and "mixed berries",
  // or "chicken thighs, boneless skinless", collapse to one species
  const stripped = f
    .replace(
      /\b(fresh|frozen|dried|ground|sliced|slivered|shredded|chopped|minced|cooked|canned|low-sodium|unsweetened|whole wheat|whole grain|extra-firm|silken|soft|baby|large|small|red|green|light)\b/g,
      " ",
    )
    .replace(/,.*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return stripped || null;
}
