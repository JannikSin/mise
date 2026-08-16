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

// ---- the untruncated allergen screen (P2 gate2 C2) -------------------------
// The Worker's sanitizePeople caps avoid at 20 terms, so the WORKER's scan can
// silently drop the 21st (misses "pecan"). The client therefore re-screens the
// returned transcription + result here, on the FULL medical-preset expansion,
// before anything renders or saves. Derivative rows are a compact port of the
// P1 skill's references/allergens.md.

/** @type {Record<string, string[]>} */
const DERIVATIVES = {
  peanut: ["groundnut", "satay", "praline"],
  "tree nut": [
    "almond",
    "cashew",
    "walnut",
    "pecan",
    "hazelnut",
    "pistachio",
    "macadamia",
    "brazil nut",
    "pine nut",
    "marzipan",
    "frangipane",
    "praline",
    "pesto",
    "nut butter",
    "nut milk",
    "amaretto",
    "orgeat",
    "gianduja",
  ],
  milk: [
    "butter",
    "ghee",
    "cream",
    "buttermilk",
    "yogurt",
    "cheese",
    "parmesan",
    "mozzarella",
    "ricotta",
    "cheddar",
    "brie",
    "mascarpone",
    "whey",
    "casein",
    "milk powder",
    "white chocolate",
  ],
  egg: [
    "mayonnaise",
    "aioli",
    "hollandaise",
    "bearnaise",
    "meringue",
    "royal icing",
    "fresh pasta",
  ],
  wheat: [
    "soy sauce",
    "worcestershire",
    "seitan",
    "udon",
    "ramen",
    "couscous",
    "bulgur",
    "farro",
    "semolina",
    "panko",
    "breadcrumb",
    "roux",
    "malt",
  ],
  gluten: [
    "soy sauce",
    "worcestershire",
    "seitan",
    "udon",
    "ramen",
    "couscous",
    "bulgur",
    "farro",
    "semolina",
    "panko",
    "breadcrumb",
    "roux",
    "malt",
    "rye",
    "barley",
    "brewer's yeast",
  ],
  soy: ["soy sauce", "tamari", "miso", "tofu", "edamame", "lecithin", "textured vegetable protein"],
  fish: [
    "worcestershire",
    "caesar dressing",
    "fish sauce",
    "dashi",
    "bonito",
    "oyster sauce",
    "anchovy",
    "anchovies",
  ],
  shellfish: [
    "shrimp paste",
    "xo sauce",
    "fish sauce",
    "seafood stock",
    "surimi",
    "shrimp",
    "prawn",
    "crab",
    "lobster",
  ],
  sesame: ["tahini", "hummus", "halva", "za'atar", "everything bagel", "gomashio", "sesame oil"],
};

/** aliases that route a stored avoid term onto a derivative row */
const DERIVATIVE_ALIASES = /** @type {Record<string, string>} */ ({
  peanuts: "peanut",
  "tree nuts": "tree nut",
  nuts: "tree nut",
  nut: "tree nut",
  dairy: "milk",
  lactose: "milk",
  eggs: "egg",
  shrimp: "shellfish",
  crustacean: "shellfish",
});

/**
 * Expand a diner's avoid terms with their hidden-source derivatives. Never
 * truncated: this is the list the client screens with, past any Worker cap.
 * @param {string[]} avoid
 * @returns {string[]} deduped lowercase terms, originals first
 */
export function expandAvoid(avoid) {
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  const push = (/** @type {string} */ term) => {
    const t = term.trim().toLowerCase();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  };
  for (const term of avoid ?? []) {
    push(String(term));
    const key = String(term).trim().toLowerCase();
    const canonical = DERIVATIVE_ALIASES[key];
    if (canonical) push(canonical); // "eggs" must also screen the singular "egg"
    const row = DERIVATIVES[key] ?? DERIVATIVES[canonical ?? ""];
    for (const d of row ?? []) push(d);
  }
  return out;
}

/**
 * Screen a text against every diner's UNTRUNCATED expanded avoid list.
 * Case-insensitive substring, the safe direction for a denylist.
 * @param {string} text
 * @param {{ id: string, name: string, avoid: string[] }[]} diners
 * @returns {string[]} hard-stop reasons ("Mom: pecan"), empty = clean
 */
export function screenTextForDiners(text, diners) {
  const t = String(text).toLowerCase();
  const out = [];
  for (const d of diners ?? []) {
    const hits = expandAvoid(d.avoid).filter((a) => t.includes(a));
    if (hits.length > 0) out.push(`${d.name}: ${hits.join(", ")}`);
  }
  return out;
}

/**
 * The fail-closed gate in front of a scan (C1): a diner whose targets file
 * could not be read is UNCONFIRMED and the scan refuses to run: an unread
 * profile must never screen as allergy-free.
 * @param {{ name: string, unconfirmed?: boolean }[]} diners
 * @returns {string} the refusal reason, "" when everyone read cleanly
 */
export function unconfirmedReason(diners) {
  const names = (diners ?? []).filter((d) => d.unconfirmed).map((d) => d.name);
  if (names.length === 0) return "";
  return `${names.join(" and ")}'s restrictions could not be read, not checked. Sync and retry, or unpick them.`;
}

/**
 * The human-readable text of a scan result, for the untruncated client
 * allergen screen. Deliberately NOT JSON.stringify (Tribunal F1: a diner
 * avoiding "nut" would hard-stop every scan on the word "nutrition", and
 * "egg" on a done-egg temperature label). Covers everything a person could
 * eat or read: title, ingredient foods and notes, step text and notes,
 * summary, planFit and the found-allergen list.
 * @param {Record<string, any>} result a validated /annotate result
 * @returns {string}
 */
export function resultHumanText(result) {
  const r = result ?? {};
  return [
    r.title,
    ...(r.ingredients ?? []).flatMap((/** @type {any} */ i) => [i.food, i.note, i.wasOriginal]),
    ...(r.steps ?? []).flatMap((/** @type {any} */ s) => [s.title, s.text, ...(s.notes ?? [])]),
    ...(r.summary ?? []),
    ...(r.planFit ?? []),
    ...(r.allergensFound ?? []),
    r.refusalReason,
    r.cuisine,
    r.deal?.time,
    r.deal?.cost,
    r.deal?.buys,
    r.deal?.skipIf,
  ]
    .filter(Boolean)
    .join(" ");
}
