// VARIETY WITHOUT MOVING THE MACROS (P2, P9).
//
// David, 2026-08-24: "let's say for the yogurt bowl there are 10 toppings that
// I could put on, just recommend per each day seven to put on... so then that
// adds a little bit of variety while not sacrificing macros, and certain ones
// can stay in every time like the protein powder."
//
// The bowl and the smoothie are the two meals he eats EVERY day, which is
// exactly right nutritionally and exactly how a person gets bored. So the
// recipe keeps its spine and rotates its trimmings.
//
// Three rules, and the third is the one that makes this safe:
//  1. KEEP items are in every single day. Whey, yogurt, soy milk: the things
//     the macros actually rest on.
//  2. POOL items rotate. `perDay` of them are chosen, deterministically per
//     (recipe, date), so the same day always shows the same bowl — refreshing
//     the screen must not reshuffle his breakfast.
//  3. THE MACROS ARE A CONSTRAINT, not an afterthought. A pick that moves
//     protein or calories outside a stated tolerance is REJECTED and the next
//     candidate ordering is tried. Variety that quietly costs him 12 g of
//     protein is not variety, it is drift, and this whole lane has been one
//     long argument about protein drift.
//
// The chosen set's REAL macros are returned, never the recipe's headline
// numbers, so the plan totals reflect what is actually in the bowl.

/**
 * Small stable string hash. Local rather than imported because the two
 * existing copies (weekbuilder.js, tables.js) are both private, and a third
 * private copy is cheaper than exporting one and coupling three modules.
 * @param {string} s
 * @returns {number}
 */
function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * @typedef {{
 *   food: string, qty: number, unit: string,
 *   calories?: number, protein?: number,
 *   staple?: boolean, note?: string
 * }} Component
 */

/**
 * Deterministic shuffle of a pool for one (recipe, date, attempt). Same inputs
 * always give the same order, which is what stops a re-render changing
 * somebody's breakfast.
 * @param {Component[]} pool
 * @param {string} seed
 * @returns {Component[]}
 */
function orderFor(pool, seed) {
  return [...pool]
    .map((c, i) => ({ c, k: hash(`${seed}|${c.food}|${i}`) }))
    .sort((a, b) => a.k - b.k || a.c.food.localeCompare(b.c.food))
    .map((x) => x.c);
}

/** @param {Component[]} items */
function macrosOf(items) {
  return items.reduce(
    (a, c) => ({
      calories: a.calories + (Number(c.calories) || 0),
      protein: a.protein + (Number(c.protein) || 0),
    }),
    { calories: 0, protein: 0 },
  );
}

/**
 * Choose today's components.
 *
 * @param {{
 *   keep?: Component[],
 *   pool?: Component[],
 *   perDay?: number,
 *   target?: { calories?: number, protein?: number },
 *   tolerance?: { calories?: number, protein?: number }
 * }} rotation the recipe's `rotation` block
 * @param {string} dateIso
 * @param {string|number} [salt]
 * @returns {{
 *   picks: Component[], kept: Component[], rotated: Component[],
 *   macros: { calories: number, protein: number },
 *   withinTolerance: boolean, attempts: number
 * }}
 */
export function rotateComponents(rotation, dateIso, salt = 0) {
  const keep = Array.isArray(rotation?.keep) ? rotation.keep : [];
  const pool = Array.isArray(rotation?.pool) ? rotation.pool : [];
  const perDay = Math.max(0, Math.min(pool.length, Number(rotation?.perDay) || 0));
  if (pool.length === 0 || perDay === 0) {
    const macros = macrosOf(keep);
    return { picks: keep, kept: keep, rotated: [], macros, withinTolerance: true, attempts: 0 };
  }

  const target = rotation?.target ?? {};
  const tol = rotation?.tolerance ?? {};
  const calTol = Number.isFinite(Number(tol.calories)) ? Number(tol.calories) : Infinity;
  const proTol = Number.isFinite(Number(tol.protein)) ? Number(tol.protein) : Infinity;
  const wantCal = Number(target.calories);
  const wantPro = Number(target.protein);

  const ok = (/** @type {{calories:number,protein:number}} */ m) => {
    if (Number.isFinite(wantPro) && Math.abs(m.protein - wantPro) > proTol) return false;
    if (Number.isFinite(wantCal) && Math.abs(m.calories - wantCal) > calTol) return false;
    return true;
  };

  // Try a few deterministic orderings before giving up. Each attempt is a
  // different shuffle of the same pool, so a tolerance that is merely tight
  // still finds a set, and one that is impossible fails honestly rather than
  // silently drifting.
  let best = null;
  for (let attempt = 0; attempt < 12; attempt++) {
    const rotated = orderFor(pool, `${dateIso}|${salt}|${attempt}`).slice(0, perDay);
    const picks = [...keep, ...rotated];
    const macros = macrosOf(picks);
    const result = { picks, kept: keep, rotated, macros, withinTolerance: true, attempts: attempt + 1 };
    if (ok(macros)) return result;
    // remember the closest miss so a too-tight tolerance still returns a bowl
    const miss =
      (Number.isFinite(wantPro) ? Math.abs(macros.protein - wantPro) : 0) +
      (Number.isFinite(wantCal) ? Math.abs(macros.calories - wantCal) / 10 : 0);
    if (!best || miss < best.miss) best = { ...result, withinTolerance: false, miss };
  }
  // every ordering missed the tolerance: return the CLOSEST and say so, so a
  // pool that cannot hit the macros is visible rather than silently drifting
  const closest = /** @type {any} */ (best);
  return {
    picks: closest.picks,
    kept: closest.kept,
    rotated: closest.rotated,
    macros: closest.macros,
    withinTolerance: false,
    attempts: closest.attempts,
  };
}

/**
 * Does this recipe rotate at all? Everything else in the app must behave
 * exactly as before for a recipe that does not.
 * @param {Record<string, any> | null | undefined} recipe
 */
export function rotates(recipe) {
  const r = recipe?.rotation;
  return Boolean(r && Array.isArray(r.pool) && r.pool.length > 0 && Number(r.perDay) > 0);
}

/**
 * A human line for the plan: what is in it today, and whether the swap held
 * the macros.
 * @param {ReturnType<typeof rotateComponents>} chosen
 * @returns {string}
 */
export function rotationLine(chosen) {
  const names = chosen.rotated.map((c) => c.food).join(", ");
  const m = `${Math.round(chosen.macros.calories)} kcal · ${Math.round(chosen.macros.protein)} g`;
  return names ? `today: ${names} — ${m}` : m;
}
