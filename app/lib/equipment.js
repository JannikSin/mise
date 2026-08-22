// WHAT THE KITCHEN CAN DO (P6, P7).
//
// Two directions, and David named both: the app must not tell you to make
// something you have no equipment for, and owning a thing must EXPAND what it
// offers you. A Dutch oven should unlock Dutch oven food.
//
// Until 2026-08-22 neither worked, and not because the filter was missing.
// `weekbuilder.js` has always excluded a recipe whose `equipment` a profile
// lacks — but NOT ONE of the 126 bank recipes declared any equipment, so
// `r.equipment ?? []` was empty every time and the filter excluded nothing,
// forever. A working filter over data nobody wrote is the same shape as
// synth.js sitting inert behind a tag no recipe carried, which is this
// codebase's standing lesson.
//
// A capability, not a possession. A recipe declares what it NEEDS to be
// cookable ("oven", "pot"), never a brand or a specific pan, and a kitchen
// declares what it HAS. Owning a bigger or more capable thing satisfies the
// smaller need, which is the whole reason substitution exists here rather
// than in a comment telling people to use their judgment.

/**
 * Everything a recipe may require or a kitchen may declare. Kept small on
 * purpose: every entry is a thing whose ABSENCE genuinely stops you cooking.
 * A grater, a thermometer and a scale are all improvisable, so requiring them
 * would exclude food for no real reason.
 * @type {{ id: string, label: string, note?: string }[]}
 */
export const EQUIPMENT = [
  { id: "stovetop", label: "Stove or hot plate", note: "any working burner" },
  { id: "oven", label: "Oven" },
  { id: "microwave", label: "Microwave" },
  { id: "skillet", label: "Skillet or frying pan" },
  { id: "saucepan", label: "Saucepan", note: "small or medium, with a lid" },
  { id: "pot", label: "Large pot or stockpot" },
  { id: "dutch-oven", label: "Dutch oven", note: "unlocks braises; also counts as a pot" },
  { id: "sheet-pan", label: "Sheet pan" },
  { id: "baking-dish", label: "Baking dish" },
  { id: "wok", label: "Wok", note: "counts as a skillet" },
  { id: "blender", label: "Blender", note: "smoothies need this" },
  { id: "food-processor", label: "Food processor" },
  { id: "rice-cooker", label: "Rice cooker" },
  { id: "air-fryer", label: "Air fryer", note: "many halls ban these, check first" },
  { id: "slow-cooker", label: "Slow cooker" },
  { id: "pressure-cooker", label: "Pressure cooker or Instant Pot", note: "also counts as a pot" },
  { id: "toaster-oven", label: "Toaster oven", note: "counts as an oven, but a full sheet pan may not fit" },
  { id: "grill", label: "Grill or grill pan" },
  { id: "steamer", label: "Steamer basket" },
];

/** @type {Set<string>} */
export const EQUIPMENT_IDS = new Set(EQUIPMENT.map((e) => e.id));

/**
 * Owning the key satisfies every need in the value.
 *
 * Deliberately one-directional and deliberately conservative. A large pot
 * does a saucepan's job; a saucepan does NOT do a stockpot's, because volume
 * is the whole point. An air fryer does NOT satisfy an oven: it is the
 * substitution people most want to make and the one most likely to end with
 * a sheet pan that does not fit.
 * @type {Record<string, string[]>}
 */
export const SATISFIES = {
  "dutch-oven": ["pot", "saucepan"],
  "pressure-cooker": ["pot", "saucepan"],
  pot: ["saucepan"],
  wok: ["skillet"],
  "toaster-oven": ["oven"],
};

/**
 * Everything a declared kitchen can do, including by substitution.
 * @param {string[] | null | undefined} owned
 * @returns {Set<string>}
 */
export function capabilities(owned) {
  /** @type {Set<string>} */
  const out = new Set();
  for (const item of owned ?? []) {
    const id = String(item ?? "").trim();
    if (!id) continue;
    out.add(id);
    for (const also of SATISFIES[id] ?? []) out.add(also);
  }
  return out;
}

/**
 * Can this kitchen cook this recipe?
 *
 * An UNDECLARED kitchen (null/undefined) can cook everything, which is how
 * this stays safe to ship to people already using the app: nobody's week
 * changes until they tell the app what they own. An EMPTY declared list is a
 * different thing and means exactly what it says.
 * @param {string[] | null | undefined} owned what the kitchen HAS
 * @param {string[] | null | undefined} needs what the recipe REQUIRES
 * @returns {boolean}
 */
export function canMake(owned, needs) {
  if (!Array.isArray(owned)) return true;
  const have = capabilities(owned);
  return (needs ?? []).every((n) => have.has(String(n)));
}

/**
 * What a recipe needs that this kitchen cannot do, for a UI that explains
 * itself instead of silently dropping food.
 * @param {string[] | null | undefined} owned
 * @param {string[] | null | undefined} needs
 * @returns {string[]}
 */
export function missingFor(owned, needs) {
  if (!Array.isArray(owned)) return [];
  const have = capabilities(owned);
  return (needs ?? []).filter((n) => !have.has(String(n)));
}

/**
 * THE EXPANDING HALF, and the reason this is a feature rather than a filter.
 *
 * How many more bank recipes each un-owned item would unlock, so the app can
 * say "a Dutch oven opens 3 more dinners" instead of making someone guess
 * whether a purchase is worth it. Only items that unlock something are
 * returned, highest first.
 * @param {string[] | null | undefined} owned
 * @param {{ equipment?: string[] }[]} recipes
 * @returns {{ id: string, label: string, unlocks: number }[]}
 */
export function unlockCounts(owned, recipes) {
  const current = Array.isArray(owned) ? owned : [];
  const base = recipes.filter((r) => canMake(current, r.equipment)).length;
  const out = [];
  for (const e of EQUIPMENT) {
    if (current.includes(e.id)) continue;
    const withIt = recipes.filter((r) => canMake([...current, e.id], r.equipment)).length;
    const unlocks = withIt - base;
    if (unlocks > 0) out.push({ id: e.id, label: e.label, unlocks });
  }
  return out.sort((a, b) => b.unlocks - a.unlocks || a.label.localeCompare(b.label));
}

/**
 * Keep only ids this app knows, so a typo or a stale field can never silently
 * exclude every recipe in the bank.
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeEquipment(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((x) => String(x ?? "").trim()).filter((x) => EQUIPMENT_IDS.has(x)))].sort();
}
