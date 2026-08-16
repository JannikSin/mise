// HBP Recipe Scan (P2) client logic. Starts with the fail-closed diner read:
// the old handleDinerFacts collapsed a FAILED targets read (null) and a CLEAN
// profile ([]) into the same avoid:[], so an offline/corrupt profile screened
// nothing and looked allergy-free (P2 gate2 fix C1). The split lives here so
// every AI surface shares one mapper and /annotate can refuse on unconfirmed.

/**
 * Map one profile's targets file (or a failed read) to the diner-facts shape
 * every AI feature sends the Worker.
 *
 * `unconfirmed` is the load-bearing field: true means the targets file could
 * not be read or parsed, so the avoid list is UNKNOWN, not empty. Callers
 * that gate on allergens must treat unconfirmed as "refuse or say not
 * checked", never as clean.
 * @param {string} id profile id
 * @param {string} name display name
 * @param {Record<string, any> | null} t the parsed targets file, or null when
 *   the read/parse failed
 * @returns {{ id: string, name: string, goal: string, calories: number,
 *   protein: number, diet: string, avoid: string[], avoidRecipes: string[],
 *   unconfirmed: boolean }}
 */
export function dinerFacts(id, name, t) {
  return {
    id,
    name,
    goal: /** @type {string} */ (t?.phase ?? "maintain"),
    calories: /** @type {number} */ (t?.macros?.calories ?? 0),
    protein: /** @type {number} */ (t?.macros?.protein ?? 0),
    diet: /** @type {string} */ (t?.diet ?? "omnivore"),
    avoid: /** @type {string[]} */ (t?.avoidIngredients ?? []),
    // client-side only (the Worker's sanitizePeople drops it): the week
    // planner screens candidate recipes with the full predicate
    avoidRecipes: /** @type {string[]} */ (t?.avoidRecipes ?? []),
    unconfirmed: t === null,
  };
}
