// THE HOUSEHOLD IS THE KITCHEN (P6).
//
// Canon: "The household is the kitchen. It knows its equipment... it knows its
// CAPACITY, fridge, freezer and pantry volume, so a generated week physically
// fits the cold storage it will live in; it knows its TRIP CADENCE... and it
// knows its occupancy window: a semester lease, a three-week winter break, a
// permanent family home. A departure date is a drain-down target."
//
// Until 2026-08-19 no `household.json` existed at all. Equipment lived on each
// person's targets, so two people sharing one oven each declared it privately;
// there was no capacity anywhere, so a week could be generated that does not
// physically fit the fridge it will live in; and there was no occupancy window,
// so moving out on a known date looked exactly like living somewhere forever.
//
// Trip cadence is the one piece that already existed (`targets.shopsPerWeek`
// splits the list into a shelf-stable run and a fresh run) and it is left where
// it is rather than moved for tidiness.

/** Roles a household member can hold. The head is not a role, it is an id. */
export const ROLES = /** @type {const} */ (["cook", "shopper", "eater"]);

/**
 * Refrigerated food is mostly water, so grams convert to millilitres close
 * enough to be useful. What is NOT close enough is pretending a fridge packs
 * solid: tubs, boxes, bags and the air between them mean roughly half of the
 * declared volume is reachable in practice.
 *
 * This is a STATED assumption, not a measured one, which is why it is a named
 * constant. The first week that overflows a fridge this said would fit should
 * move it.
 */
export const PACKING_EFFICIENCY = 0.55;

/**
 * Normalize a household file. Every field is optional and every absence is a
 * working state: a household that has declared nothing behaves exactly as the
 * app did before this file existed, which is the only way to add a model to a
 * live app without breaking the people already using it.
 * @param {Record<string, any> | null | undefined} raw
 * @returns {{
 *   headId: string | null,
 *   members: { id: string, roles: string[] }[],
 *   equipment: string[] | null,
 *   capacityL: { fridge: number | null, freezer: number | null, pantry: number | null },
 *   occupancy: { from: string | null, until: string | null }
 * }}
 */
export function normalizeHousehold(raw) {
  const num = (/** @type {any} */ v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
  const iso = (/** @type {any} */ v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  const members = Array.isArray(raw?.members)
    ? raw.members
        .filter((/** @type {any} */ m) => m && typeof m.id === "string" && m.id)
        .map((/** @type {any} */ m) => ({
          id: m.id,
          roles: Array.isArray(m.roles) ? m.roles.filter((/** @type {any} */ r) => ROLES.includes(r)) : [],
        }))
    : [];
  return {
    headId: typeof raw?.headId === "string" && raw.headId ? raw.headId : null,
    members,
    // absent means "has everything", exactly as the per-profile equipment
    // field already means, so an undeclared kitchen filters nothing
    equipment: Array.isArray(raw?.equipment) ? raw.equipment.map(String) : null,
    capacityL: {
      fridge: num(raw?.capacityL?.fridge),
      freezer: num(raw?.capacityL?.freezer),
      pantry: num(raw?.capacityL?.pantry),
    },
    occupancy: { from: iso(raw?.occupancy?.from), until: iso(raw?.occupancy?.until) },
  };
}

/** Where a household's model lives, beside its shared pantry. */
export const householdPathFor = (/** @type {string} */ slug) =>
  `households/${slug || "home"}/household.json`;

/**
 * "A household has a head. The head assigns the roles... only the head
 * reassigns roles." Enforced in code, not in the UI, because a rule that only
 * a screen enforces is a rule two devices can disagree about.
 *
 * A household with NO declared head is not locked: the first person to write
 * one becomes it. Refusing everybody would make the file unreachable.
 * @param {ReturnType<typeof normalizeHousehold>} household
 * @param {string} actorId
 * @returns {boolean}
 */
export function canAssignRoles(household, actorId) {
  if (!household.headId) return true;
  return household.headId === actorId;
}

/**
 * Set one member's roles. Returns the household UNCHANGED when the actor is
 * not the head, so a refused write is a no-op rather than a thrown error a
 * caller might swallow.
 * @param {ReturnType<typeof normalizeHousehold>} household
 * @param {string} actorId
 * @param {string} memberId
 * @param {string[]} roles
 * @returns {{ household: ReturnType<typeof normalizeHousehold>, changed: boolean, reason: string }}
 */
export function setMemberRoles(household, actorId, memberId, roles) {
  if (!canAssignRoles(household, actorId)) {
    return { household, changed: false, reason: "only the head of the household reassigns roles" };
  }
  const clean = roles.filter((r) => ROLES.includes(/** @type {any} */ (r)));
  const exists = household.members.some((m) => m.id === memberId);
  const members = exists
    ? household.members.map((m) => (m.id === memberId ? { ...m, roles: clean } : m))
    : [...household.members, { id: memberId, roles: clean }];
  return { household: { ...household, members }, changed: true, reason: "" };
}

/**
 * Everyone who holds a role. "Everyone in the household sees everything, the
 * cook sees the list and the shopper sees the recipes" is a rendering rule, so
 * this answers who HOLDS a role rather than gating what anybody may read.
 * @param {ReturnType<typeof normalizeHousehold>} household
 * @param {string} role
 * @returns {string[]}
 */
export function membersWithRole(household, role) {
  return household.members.filter((m) => m.roles.includes(role)).map((m) => m.id);
}

/**
 * The cold-storage load a set of pantry rows puts on the kitchen, in litres.
 * Freezer rows are counted against the freezer, everything dated against the
 * fridge, and undated stock against the pantry.
 * @param {Record<string, any>[]} items normalized pantry items
 * @param {(food: string, qty: number, unit: string) => number | null} toGramsFn
 * @returns {{ fridge: number, freezer: number, pantry: number, unknownRows: number }}
 */
export function coldLoad(items, toGramsFn) {
  let fridge = 0;
  let freezer = 0;
  let pantry = 0;
  let unknownRows = 0;
  for (const it of items ?? []) {
    const m = /^\s*(\d+(?:\.\d+)?)\s*([a-zA-Z]*)/.exec(String(it.qty ?? ""));
    const grams = m ? toGramsFn(String(it.food ?? ""), Number(m[1]), m[2] || "x") : null;
    if (grams == null || !(grams > 0)) {
      unknownRows += 1;
      continue;
    }
    const litres = grams / 1000; // water density, stated above
    if (it.location === "freezer") freezer += litres;
    else if (it.location === "pantry") pantry += litres;
    else fridge += litres;
  }
  const round = (/** @type {number} */ n) => Math.round(n * 100) / 100;
  return { fridge: round(fridge), freezer: round(freezer), pantry: round(pantry), unknownRows };
}

/**
 * Does the week physically fit the kitchen it will live in?
 *
 * Reports rather than refuses. A person whose fridge is genuinely too small
 * needs to know that before they shop, not to be told their week is illegal:
 * the plan is theirs, and P6's promise is that the app KNOWS the constraint,
 * not that it overrules them with it.
 * @param {ReturnType<typeof normalizeHousehold>} household
 * @param {{ fridge: number, freezer: number, pantry: number, unknownRows: number }} load
 * @returns {{ checked: boolean, fits: boolean, over: { where: string, byL: number }[], unknownRows: number }}
 */
export function capacityCheck(household, load) {
  const declared = household.capacityL;
  /** @type {{ where: string, byL: number }[]} */
  const over = [];
  let checked = false;
  for (const where of /** @type {const} */ (["fridge", "freezer", "pantry"])) {
    const cap = declared[where];
    if (cap == null) continue;
    checked = true;
    const usable = cap * PACKING_EFFICIENCY;
    if (load[where] > usable) {
      over.push({ where, byL: Math.round((load[where] - usable) * 100) / 100 });
    }
  }
  return { checked, fits: over.length === 0, over, unknownRows: load.unknownRows };
}

/**
 * "A departure date is a drain-down target: perishables reach zero by the
 * date." So the last day a perishable may be eaten is the earlier of its own
 * date and the day the kitchen empties.
 *
 * A household with NO departure date is never pushed to eat its stock, which
 * is the other half of the same rule and the reason this returns null rather
 * than a far-future date.
 * @param {ReturnType<typeof normalizeHousehold>} household
 * @returns {string | null}
 */
export function drainDownDate(household) {
  return household.occupancy.until;
}
