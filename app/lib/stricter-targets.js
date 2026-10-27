// A REFUSED OWN-TARGETS EDIT NEVER LOOSENS THE ALLERGY SCREEN (Mise 2.0,
// seam fix loop 1, item 5; Red Team 5; serves P3 knows-you and P8 plates).
//
// A refused record reads as the server's copy (ENG L2-8). For a person's own
// targets that would drop an allergy they have just told the app about, if
// the server refused the file for another reason (a name in a note). So their
// own refused targets read as the server copy with every restriction from the
// local edit added on: allergens, the typed allergy text, avoided
// ingredients, never-again recipes, and the stricter of the two diets. It can
// only refuse more, never less.

const UNION_FIELDS = /** @type {const} */ (["allergens", "avoidIngredients", "avoidRecipes"]);
// strictest last; each admits a subset of the one before (plan.js DIET_ADMITS)
const DIET_LADDER = ["omnivore", "pescatarian", "vegetarian", "vegan"];

/**
 * @param {unknown} a
 * @param {unknown} b
 * @returns {unknown[] | undefined}
 */
function unionList(a, b) {
  const left = Array.isArray(a) ? a : [];
  const right = Array.isArray(b) ? b : [];
  if (left.length === 0 && right.length === 0) return Array.isArray(a) ? a : undefined;
  const seen = new Set(left.map((x) => JSON.stringify(x)));
  return [...left, ...right.filter((x) => !seen.has(JSON.stringify(x)))];
}

/**
 * The stricter of two diets. An unknown value is kept as is when it is the
 * server's; a local unknown value never replaces a known server diet.
 * @param {unknown} server
 * @param {unknown} local
 * @returns {unknown}
 */
function stricterDiet(server, local) {
  const s = DIET_LADDER.indexOf(String(server ?? "omnivore"));
  const l = DIET_LADDER.indexOf(String(local ?? "omnivore"));
  if (s < 0) return server;
  if (l < 0) return server ?? local;
  return l > s ? local : server;
}

/**
 * @param {Record<string, unknown> | null} server the server copy (null when none came down)
 * @param {Record<string, unknown> | null} local the refused local edit
 * @returns {Record<string, unknown> | null}
 */
export function stricterTargets(server, local) {
  if (!local) return server;
  /** @type {Record<string, unknown>} */
  const out = { ...(server ?? {}) };
  for (const k of UNION_FIELDS) {
    const v = unionList(server?.[k], local[k]);
    if (v !== undefined) out[k] = v;
  }
  const sText = String(server?.allergensFreeText ?? "").trim();
  const lText = String(local.allergensFreeText ?? "").trim();
  if (lText && !sText.toLowerCase().includes(lText.toLowerCase())) {
    out.allergensFreeText = sText ? `${sText}; ${lText}` : lText;
  }
  const diet = stricterDiet(server?.diet, local.diet);
  if (diet !== undefined) out.diet = diet;
  return out;
}
