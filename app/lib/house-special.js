// WHERE AN AI DINNER SPECIAL IS WRITTEN (Mise 2.0, plan section 5, ENG 3 and
// ENG L2-4; serves P2 decided and P12 bank).
//
// On GitHub (1.95) a special is a bank recipe, `recipes/special-<name>-<date>`.
// On Supabase the bank is shared by every house and only the admin writes it,
// and a dish name invented at one table can carry a person's name. So a
// special belongs to the house that invented it: it is written to
// `households/<house>/recipes/house-<12 random hex>.json`, with the `id` set
// to the same opaque value, which names nothing and nobody. The house is
// bound by the path (doc_scope), so only that house reads it.

const HOUSE_SLUG = /^[a-z0-9][a-z0-9-]{0,80}$/;

/** @returns {string} 12 lowercase hex characters */
function randomHex12() {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * @param {string} id
 * @returns {boolean} true for an opaque house-special id
 */
export function isHouseRecipeId(id) {
  return /^house-[0-9a-f]{12}$/.test(id);
}

/**
 * The id and path a new special is written under.
 * @param {"github" | "supabase"} backendName
 * @param {string} house the inventing house's slug
 * @param {string} githubId the 1.95 id, `special-<name>-<date>`
 * @param {() => string} [hex] injectable for tests
 * @returns {{ id: string, path: string }}
 */
export function specialTarget(backendName, house, githubId, hex = randomHex12) {
  if (backendName !== "supabase") return { id: githubId, path: `recipes/${githubId}.json` };
  if (!HOUSE_SLUG.test(house)) throw new Error("this phone has no house to keep the special in");
  const id = `house-${hex()}`;
  if (!isHouseRecipeId(id)) throw new Error("bad house recipe id");
  return { id, path: `households/${house}/recipes/${id}.json` };
}
