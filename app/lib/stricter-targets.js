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

import { avoidTermsFromAllergens, typedAvoidTerms } from "./targets.js";

const UNION_FIELDS =/** @type {const} */ (["allergens", "avoidIngredients", "avoidRecipes"]);
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
 * The typed allergy text in the pieces the allergy screen reads it in:
 * split at commas only, as avoidTermsFromAllergens does (loop 3, item 7).
 * @param {string} text
 */
const screenPieces = (text) =>
  text
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

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
  // the typed allergy text is merged by what the ALLERGY SCREEN reads in it
  // (loop 3 item 7, Red Team 3 L-a; whole terms since loop 2 item 9): a
  // local piece is kept unless every term the screen draws from it is
  // already drawn from the server text, and pieces are joined with the comma
  // the screen splits at. So the merged text screens all the server text
  // screens plus all the local edit screens: "kiwi" survives a server
  // "apple\nkiwi" (one term to the screen), "apple" a server "pineapple".
  const sText = String(server?.allergensFreeText ?? "").trim();
  const have = new Set(avoidTermsFromAllergens([], sText));
  const extra = screenPieces(String(local.allergensFreeText ?? "")).filter((piece) => {
    const drawn = typedAvoidTerms(piece);
    if (drawn.every((t) => have.has(t))) return false;
    for (const t of drawn) have.add(t);
    return true;
  });
  if (extra.length > 0) {
    out.allergensFreeText = [...(sText ? [sText] : []), ...extra].join(", ");
  }
  const diet = stricterDiet(server?.diet, local.diet);
  if (diet !== undefined) out.diet = diet;
  return out;
}
