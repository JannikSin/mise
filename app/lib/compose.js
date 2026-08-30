// THE DAY COMPOSER: the one arithmetic authority for shared-meal planning
// (Tribunal plan gate 2026-08-30, session monolith). A brigade day is one
// recipe per slot shared by every seat, with only servings varying per seat.
// The model that used to size plates measurably could not (six patch layers,
// 2026-08-29, each failing the same way); this module is the replacement:
// deterministic, offline, exhaustive over a small space, and honest when the
// pool cannot deliver.
//
// Acceptance is GRADUATED (Red Team loop 1): strict bands first — calories in
// [remaining, remaining+100], protein in [floor, ceiling] pulled toward aim —
// then a seat that cannot land degrades to its calorie-FLOOR band with the
// shortfall named on that seat, and a seat that cannot even reach floor gets
// a named miss while the day still materializes at best effort. A whole-day
// refusal does not exist: half a week of slightly-small food beats no week,
// and the report says exactly which seat is short, where, and why.
import {
  SERVINGS_MIN,
  BRIGADE_SERVINGS_MAX,
  SLOT_WEIGHT,
  seatServingsRaw,
  brigadePool,
  brigadeTableId,
  pruneTables,
  validBrigade,
} from "./tables.js";
import { buffetMacroEstimate, recipeConflicts, weekRunSwipes } from "./plan.js";

/** serving grids: quarter steps; light slots may halve, meals start at 0.75 */
const MEAL_STEPS = [0.75, 1, 1.25, 1.5, 1.75, 2];
const LIGHT_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const LIGHT_SLOTS = new Set(["smoothie", "snack"]);
// Portion sanity is enforced by the GRIDS themselves: meals 0.75-2.0×, light
// slots 0.5-2.0× — the worst reachable spread is a half-portion snack beside
// a double dinner, which is a normal day. (An explicit spread cap shipped
// here briefly and was dead code: the grids already bound it. One less name.)
/** how many alternates a single-slot swap tries, and how many each side of a
 * two-slot swap tries (Red Team: single-slot solves 94% of real days, one
 * two-slot pass takes it to 100%) */
const SWAP_ALTS = 8;
const PAIR_ALTS = 5;

/**
 * A seat's remaining-macro bands for one date: what the composed slots must
 * deliver AFTER the covered credit (swipe, screened fixed slots, the seat's
 * own pinned/out entries) is subtracted. All numbers derive from the seat's
 * own targets at run time — nothing here bakes in anyone's 3700.
 *
 * proteinCeiling is DERIVED when absent (protein × 1.15, the same fallback
 * the old bounds notes used): four of five live profiles carry none, and an
 * unbounded upper band re-creates the 229-270 g overshoot this build exists
 * to end (Red Team near-block). SCHEMAS.md states the derivation. A profile
 * with no protein number at all gets an unconstrained protein band and no
 * aim — the composer only optimizes numbers the person actually tracks.
 *
 * `share` scales the band to the planned slots' fraction of the member's
 * day (SLOT_WEIGHT arithmetic in the caller): a dinner-only brigade budgets
 * a dinner's share, never the whole remainder — otherwise it would try to
 * force-feed a day into one pot. The +100 kcal tolerance stays absolute.
 * @param {Record<string, any> | null | undefined} targets
 * @param {{ calories: number, protein: number }} covered
 * @param {number} [share] planned slots' share of the remaining day, (0, 1]
 * @returns {{ kcalLo: number, kcalHi: number, kcalFloorLo: number, pLo: number, pHi: number, pAim: number | null } | null}
 */
export function seatBands(targets, covered, share = 1) {
  const m = targets?.macros;
  const calories = Number(m?.calories) || 0;
  const protein = Number(m?.protein) || 0;
  if (calories <= 0) return null;
  const floor = Number(m?.caloriesFloor) || Math.max(0, calories - 200);
  const s = Math.min(1, Math.max(0, share)) || 1;
  const kcalLo = Math.round(Math.max(0, calories - covered.calories) * s);
  if (protein <= 0) {
    return {
      kcalLo,
      kcalHi: kcalLo + 100,
      kcalFloorLo: Math.round(Math.max(0, floor - covered.calories) * s),
      pLo: 0,
      pHi: Infinity,
      pAim: null,
    };
  }
  const ceil = Number(m?.proteinCeiling) || Math.round(protein * 1.15);
  const aim = Number(m?.proteinAim) || protein;
  return {
    kcalLo,
    kcalHi: kcalLo + 100,
    kcalFloorLo: Math.round(Math.max(0, floor - covered.calories) * s),
    pLo: Math.round(Math.max(0, protein - covered.protein) * s),
    pHi: Math.round(Math.max(0, ceil - covered.protein) * s),
    pAim: Math.round(Math.max(0, aim - covered.protein) * s),
  };
}

/** @param {string} slot @returns {number[]} */
const stepsFor = (slot) => (LIGHT_SLOTS.has(slot) ? LIGHT_STEPS : MEAL_STEPS);

/**
 * Solve ONE seat's servings for a fixed recipe tuple. Exhaustive over the
 * quarter-step grid (≤ ~1.8k combos for four slots), so the returned plate
 * is the true optimum, not a heuristic. `fixed` holds slots whose servings a
 * human already set (a carried hand-edit binds — the solve works around it
 * and reports if that leaves the seat out of band, never silently overrules).
 *
 * Status ladder: "band" (strict), "floor" (calories landed between the
 * seat's floor and target — named, not hidden), "miss" (best effort, named).
 * @param {{ slot: string, recipe: Record<string, any> }[]} dishes
 * @param {ReturnType<typeof seatBands>} bands
 * @param {Record<string, number>} sigma natural appetite serving per slot
 * @param {Record<string, number>} [fixed] slot -> hand-set servings
 * @returns {{ servings: Record<string, number>, kcal: number, protein: number, status: "band" | "floor" | "miss" | "over" } | null}
 */
export function solveSeatDay(dishes, bands, sigma, fixed = {}) {
  if (!bands) return null;
  const free = dishes.filter((d) => fixed[d.slot] === undefined);
  const fixedKcal = dishes.reduce(
    (s, d) => s + (fixed[d.slot] ?? 0) * (d.recipe.nutrition?.calories ?? 0),
    0,
  );
  const fixedP = dishes.reduce(
    (s, d) => s + (fixed[d.slot] ?? 0) * (d.recipe.nutrition?.protein ?? 0),
    0,
  );
  const grids = free.map((d) =>
    stepsFor(d.slot).filter((s) => s >= SERVINGS_MIN && s <= BRIGADE_SERVINGS_MAX),
  );
  /**
   * @typedef {{ servings: Record<string, number>, kcal: number, protein: number, score: number, overScore?: number, over?: boolean }} Combo
   */
  /** @type {Combo | null} */
  let bestBand = null;
  /** @type {Combo | null} */
  let bestFloor = null;
  /** @type {Combo | null} */
  let bestMiss = null;
  const combo = new Array(free.length).fill(0);
  const total = grids.reduce((p, g) => p * g.length, 1);
  for (let i = 0; i < total; i++) {
    let rem = i;
    let kcal = fixedKcal;
    let p = fixedP;
    let sigmaDev = 0;
    for (let j = 0; j < free.length; j++) {
      const grid = /** @type {number[]} */ (grids[j]);
      const s = /** @type {number} */ (grid[rem % grid.length]);
      rem = Math.floor(rem / grid.length);
      combo[j] = s;
      const d = /** @type {{ slot: string, recipe: Record<string, any> }} */ (free[j]);
      kcal += s * (d.recipe.nutrition?.calories ?? 0);
      p += s * (d.recipe.nutrition?.protein ?? 0);
      sigmaDev += Math.abs(s - (sigma[d.slot] ?? s));
    }
    const score = (bands.pAim === null ? 0 : Math.abs(p - bands.pAim) / 10) + sigmaDev;
    const pick = () => ({
      servings: Object.fromEntries(free.map((d, j) => [d.slot, combo[j]])),
      kcal: Math.round(kcal),
      protein: Math.round(p),
      score,
    });
    if (p > bands.pHi || kcal > bands.kcalHi) {
      // over the ceiling or the +100 cap: only ever acceptable as the least
      // violation when NOTHING fits under the caps (a seat so small the
      // tiniest plate overshoots must still be fed, and named)
      const overScore =
        Math.max(0, kcal - bands.kcalHi) / 25 + Math.max(0, p - bands.pHi) + score;
      // an over-miss never displaces an under-miss (too little names itself
      // on the day report; too much silently overfeeds)
      if (!bestMiss || (bestMiss.over && overScore < (bestMiss.overScore ?? Infinity))) {
        bestMiss = { ...pick(), score: overScore, overScore, over: true };
      }
      continue;
    }
    if (kcal >= bands.kcalLo && p >= bands.pLo) {
      if (!bestBand || score < bestBand.score) bestBand = pick();
    } else if (kcal >= bands.kcalFloorLo && p >= bands.pLo) {
      // under target but at/above the seat's own floor: acceptable, named
      const floorScore = (bands.kcalLo - kcal) / 50 + score;
      if (!bestFloor || floorScore < bestFloor.score) bestFloor = { ...pick(), score: floorScore };
    } else {
      // best effort from below: closest to the floor band, protein first
      const missScore =
        Math.max(0, bands.kcalFloorLo - kcal) / 25 + Math.max(0, bands.pLo - p) + score;
      if (!bestMiss || bestMiss.over || missScore < bestMiss.score) {
        bestMiss = { ...pick(), score: missScore, overScore: Infinity, over: false };
      }
    }
  }
  const chosen = bestBand ?? bestFloor ?? bestMiss;
  if (!chosen) return null;
  const withFixed = { ...chosen.servings };
  for (const [slot, s] of Object.entries(fixed)) withFixed[slot] = s;
  return {
    servings: withFixed,
    kcal: chosen.kcal,
    protein: chosen.protein,
    // a miss carries its DIRECTION out: "too much" and "too little" demand
    // opposite reactions, and the old single word rendered a 235-kcal-over
    // seat as "short" (Final Gate Engineer, 2026-08-30)
    status:
      chosen === bestBand
        ? "band"
        : chosen === bestFloor
          ? "floor"
          : chosen.over
            ? "over"
            : "miss",
  };
}

/**
 * Compose ONE day for every seat at once: one shared recipe per slot, one
 * servings map per seat (Red Team block 1: the tuple walk is joint — a swap
 * that rescues one seat changes everyone's food, so acceptance is
 * all-seats-in-band or the best tuple with each shortfall named).
 *
 * Tuple order is deterministic: the rotation's start tuple, then single-slot
 * swaps (light slots first, alternates in walk order), then bounded two-slot
 * swaps. First tuple where every seat lands strictly wins; otherwise the
 * best tuple by (seats in band, then floor-seats, then total score) wins and
 * degrades gracefully.
 * @param {{
 *   slots: string[],
 *   poolsBySlot: Record<string, Record<string, any>[]>,
 *   startBySlot: Record<string, Record<string, any>>,
 *   seats: {
 *     id: string,
 *     targets: Record<string, any> | null,
 *     bands: ReturnType<typeof seatBands>,
 *     fixed?: Record<string, { servings: number, recipeId: string }>,
 *     exclude?: Set<string>,
 *   }[],
 *   recentBySlot?: Record<string, Map<string, number>>,
 * }} day seats may exclude slots they do not eat from the pot (their own
 *   pinned entry or a carried skip covers them there instead). A seat's
 *   `fixed` binds ONLY while that slot's pick IS the named recipe — a
 *   hand-set 1.25 servings of chili must never ride onto a swapped
 *   1800-kcal lasagna. `recentBySlot` maps a recipe to how many nights ago
 *   the slot last served it; a repeat's cost is 1/gap, so LAST NIGHT'S
 *   dinner loses to a four-nights-ago dish that lands the same seats
 *   (Engineer, loop 2: a flat count chose back-to-back stew over three
 *   equally-landing alternatives at zero arithmetic cost). Variety is
 *   still only a tie-break the bands outrank, in both directions.
 * @returns {{
 *   picks: Record<string, Record<string, any>>,
 *   seats: Record<string, { servings: Record<string, number>, kcal: number, protein: number, status: string }>,
 *   allInBand: boolean,
 * } | null}
 */
export function composeDay(day) {
  const slots = day.slots.filter((s) => day.startBySlot[s]);
  if (slots.length === 0 || day.seats.length === 0) return null;
  const recent = (/** @type {string} */ slot) => day.recentBySlot?.[slot];

  /** @param {Record<string, Record<string, any>>} picks */
  const evaluate = (picks) => {
    const allDishes = slots.map((slot) => ({
      slot,
      recipe: /** @type {Record<string, any>} */ (picks[slot]),
    }));
    /** @type {Record<string, { servings: Record<string, number>, kcal: number, protein: number, status: string }>} */
    const seatsOut = {};
    let considered = 0;
    let inBand = 0;
    let floors = 0;
    let score = 0;
    for (const seat of day.seats) {
      const dishes = allDishes.filter((d) => !seat.exclude?.has(d.slot));
      if (dishes.length === 0) continue;
      considered++;
      /** @type {Record<string, number>} */
      const sigma = {};
      /** @type {Record<string, number>} */
      const effFixed = {};
      for (const d of dishes) {
        const raw = seatServingsRaw(seat.targets ?? undefined, d.slot, d.recipe);
        if (raw !== null) sigma[d.slot] = raw;
        const f = seat.fixed?.[d.slot];
        if (f && f.recipeId === d.recipe.id) effFixed[d.slot] = f.servings;
      }
      const solved = solveSeatDay(/** @type {any} */ (dishes), seat.bands, sigma, effFixed);
      if (!solved) return null;
      seatsOut[seat.id] = solved;
      if (solved.status === "band") inBand++;
      if (solved.status === "floor") floors++;
      score += Math.abs(solved.protein - (seat.bands?.pAim ?? solved.protein));
    }
    if (considered === 0) return null;
    let repeats = 0;
    for (const s of slots) {
      const gap = recent(s)?.get(picks[s]?.id);
      if (gap !== undefined && gap > 0) repeats += 1 / gap;
    }
    return { picks, seats: seatsOut, considered, inBand, floors, repeats, score };
  };

  /** @type {NonNullable<ReturnType<typeof evaluate>>[]} */
  const candidates = [];
  // the short-circuit bar: every eating seat strictly in band AND nothing
  // repeated — a repeat that lands is kept as a candidate but the walk keeps
  // looking for something fresh that also lands (Final Gate Engineer: the
  // old early-accept let a landing start pick serve the same stew four
  // nights while fresh dishes would have landed too)
  const tryTuple = (/** @type {Record<string, Record<string, any>>} */ picks) => {
    const r = evaluate(picks);
    if (r) candidates.push(r);
    return r !== null && r.inBand === r.considered && r.repeats === 0;
  };

  const start = { ...day.startBySlot };
  if (tryTuple(start)) return finish(candidates);

  // single-slot swaps, light slots first — a smoothie is cheaper to change
  // than the dinner the house already agreed to
  const swapOrder = [...slots].sort(
    (a, b) => (LIGHT_SLOTS.has(b) ? 1 : 0) - (LIGHT_SLOTS.has(a) ? 1 : 0),
  );
  const altsFor = (/** @type {string} */ slot, /** @type {number} */ n) => {
    const pool = day.poolsBySlot[slot] ?? [];
    const startId = day.startBySlot[slot]?.id;
    const rec = recent(slot);
    const at = pool.findIndex((r) => r.id === startId);
    /** @type {Record<string, any>[]} */
    const fresh = [];
    /** @type {Record<string, any>[]} */
    const repeats = [];
    for (let k = 1; k <= pool.length - 1; k++) {
      const alt = pool[(at + k + pool.length) % pool.length];
      if (!alt || alt.id === startId) continue;
      (rec?.has(alt.id) ? repeats : fresh).push(alt);
    }
    return [...fresh, ...repeats].slice(0, n);
  };
  for (const slot of swapOrder) {
    for (const alt of altsFor(slot, SWAP_ALTS)) {
      if (tryTuple({ ...start, [slot]: alt })) return finish(candidates);
    }
  }
  // bounded two-slot swaps
  for (let a = 0; a < swapOrder.length; a++) {
    for (let b = a + 1; b < swapOrder.length; b++) {
      const sa = /** @type {string} */ (swapOrder[a]);
      const sb = /** @type {string} */ (swapOrder[b]);
      for (const altA of altsFor(sa, PAIR_ALTS)) {
        for (const altB of altsFor(sb, PAIR_ALTS)) {
          if (tryTuple({ ...start, [sa]: altA, [sb]: altB })) return finish(candidates);
        }
      }
    }
  }
  return finish(candidates);
}

/**
 * Best candidate: seats in band first, then floor-seats, then FEWEST repeats
 * (variety is a tie-break the bands outrank), then protein score.
 * @param {any[]} candidates
 */
function finish(candidates) {
  if (candidates.length === 0) return null;
  candidates.sort(
    (a, b) =>
      b.inBand - a.inBand || b.floors - a.floors || a.repeats - b.repeats || a.score - b.score,
  );
  const best = candidates[0];
  return { picks: best.picks, seats: best.seats, allInBand: best.inBand === best.considered };
}

/**
 * What one member's day already delivers OUTSIDE the brigade's slots, per
 * date, from three honest sources: their own plan's pinned/OUT entries (a
 * pinned meal is a decision — it also blocks that slot's seat, E6), their
 * dining swipes (entries already in the plan count at their stored estimate;
 * remaining allowance is presumed onto swipe-free days exactly as
 * weekRunSwipes budgets it), and their fixed slots — credited ONLY when the
 * recipe passes this member's own screens (Red Team block 2: dailyCovered
 * used to credit the raw bank blind, so a fixed smoothie the intersection
 * screen can never serve still shrank the remaining budget by 702 kcal).
 * @param {Record<string, any> | null} targets
 * @param {import("./plan.js").Plan | null} plan that member's week plan (may be empty)
 * @param {string[]} dates the run's dates
 * @param {Set<string>} brigadeSlots slots the brigade plans
 * @param {Map<string, any>} bankById
 * @param {string} today
 * @returns {{
 *   coveredByDate: Record<string, { calories: number, protein: number }>,
 *   coveredSlotsByDate: Record<string, Set<string>>,
 *   blocked: Set<string>,
 * }} blocked holds "date|slot" pairs where this member's own entry wins;
 *   coveredSlotsByDate names WHICH slots each date's credit came from, so
 *   the share arithmetic can tell "already fed" from "someone plans it later"
 */
export function memberCoverage(targets, plan, dates, brigadeSlots, bankById, today) {
  /** @type {Record<string, { calories: number, protein: number }>} */
  const coveredByDate = Object.fromEntries(dates.map((d) => [d, { calories: 0, protein: 0 }]));
  /** @type {Record<string, Set<string>>} */
  const coveredSlotsByDate = Object.fromEntries(dates.map((d) => [d, new Set()]));
  const blocked = new Set();
  // trust boundary once, at the top: a plan file is device-written, and every
  // leg below (own entries, the swipe ledger, the occupied set) walks this
  const entries = (plan?.entries ?? []).filter(
    (e) => e !== null && typeof e === "object",
  );
  const dateSet = new Set(dates);

  for (const e of entries) {
    if (!dateSet.has(e.date)) continue;
    if (!(e.pinned || e.out)) continue;
    const cov = coveredByDate[e.date];
    if (!cov) continue;
    if (brigadeSlots.has(e.slot)) blocked.add(`${e.date}|${e.slot}`);
    coveredSlotsByDate[e.date]?.add(e.slot);
    if (e.recipeId) {
      const n = bankById.get(e.recipeId)?.nutrition;
      cov.calories += (n?.calories ?? 0) * (e.servings || 1);
      cov.protein += (n?.protein ?? 0) * (e.servings || 1);
    } else {
      cov.calories += e.estCalories ?? 0;
      cov.protein += e.estProtein ?? 0;
    }
  }

  // presumed swipes: the allowance this member's plan has not spent yet,
  // walked over the run's dates with the same ledger rules the planner uses
  const buffet = (targets?.currencies ?? []).find(
    (/** @type {any} */ c) => c.venue === "buffet" && Number(c.perWeek) > 0,
  );
  if (buffet) {
    const slot = String(buffet.preferredSlot || "lunch");
    const meals = dates.map((d) => ({ date: d, slot }));
    const ledger = plan ?? { week: "", entries: [] };
    const est = buffetMacroEstimate([], slot, buffet);
    const already = new Set(
      entries.filter((e) => e.out && /** @type {any} */ (e).currency).map((e) => `${e.date}|${e.slot}`),
    );
    for (const pair of weekRunSwipes(meals, /** @type {any} */ (buffet), /** @type {any} */ (ledger), today)) {
      if (already.has(`${pair.date}|${pair.slot}`)) continue; // counted above at its stored estimate
      const cov = coveredByDate[pair.date];
      if (!cov) continue;
      cov.calories += est.estCalories;
      cov.protein += est.estProtein;
      coveredSlotsByDate[pair.date]?.add(pair.slot);
      if (brigadeSlots.has(pair.slot)) blocked.add(`${pair.date}|${pair.slot}`);
    }
  }

  // fixed slots: daily, on slots the brigade is NOT planning (a planned slot
  // wins — the convention every surface already keeps), screened first
  const occupied = new Set(entries.filter((e) => e.pinned || e.out).map((e) => `${e.date}|${e.slot}`));
  for (const [slot, rid] of Object.entries(targets?.fixedSlots ?? {})) {
    if (brigadeSlots.has(slot)) continue;
    const recipe = bankById.get(String(rid));
    if (!recipe) continue;
    if (recipeConflicts(recipe, targets?.diet, targets?.avoidIngredients, targets?.avoidRecipes).length > 0)
      continue; // a fixed slot the screens refuse is a miss, never a phantom credit
    for (const d of dates) {
      if (occupied.has(`${d}|${slot}`)) continue;
      // a slot the day's credit already covers (a presumed swipe on the same
      // slot) must not ALSO credit its fixed recipe — 1900 kcal for one lunch
      // was measurable with fixedSlots.lunch + a lunch buffet currency
      // (Final Gate Engineer, 2026-08-30)
      if (coveredSlotsByDate[d]?.has(slot)) continue;
      const cov = coveredByDate[d];
      if (!cov) continue;
      cov.calories += recipe.nutrition?.calories ?? 0;
      cov.protein += recipe.nutrition?.protein ?? 0;
      coveredSlotsByDate[d]?.add(slot);
    }
  }
  return { coveredByDate, coveredSlotsByDate, blocked };
}

/**
 * PLAN A BRIGADE'S WEEK, composed (the one engine; replaces the picking and
 * sizing halves of the old materializeBrigade and the deleted AI week run).
 *
 * Keeps every settled behaviour of the table factory: deterministic ids so
 * offline devices merge instead of double-shopping, run-day-independent
 * start picks (the FNV walk), idempotence without `regenerate`, seat skip /
 * buyer / head / cooked carry-forward, one-house membership, the retention
 * prune, cook rotation by calendar day, and honest `thin` reporting.
 *
 * What is new: per DATE, the day's slots are composed JOINTLY across every
 * seat (composeDay) so each member's day lands inside their own remaining
 * calorie band and protein band, with graduated acceptance and a per-seat
 * per-day report the caller can show. Servings on every seat come from the
 * solve — recipe.nutrition × servings is then the single read-side truth.
 * @param {import("./tables.js").HouseEvents} events
 * @param {import("./tables.js").Brigade} brigade
 * @param {{
 *   dates: string[],
 *   today: string,
 *   house: string,
 *   profilesById: Map<string, any>,
 *   targetsById: Map<string, any>,
 *   plansById: Map<string, import("./plan.js").Plan | null>,
 *   bankById: Map<string, any>,
 *   regenerate?: boolean,
 * }} ctx
 * @returns {{
 *   events: import("./tables.js").HouseEvents,
 *   made: number,
 *   thin: { slot: string, available: number }[],
 *   report: { date: string, seatId: string, kcal: number, protein: number, dayKcal: number, dayProtein: number, share: number, status: string }[],
 * }}
 */
export function planBrigadeWeek(events, brigade, ctx) {
  if (!validBrigade(brigade)) return { events, made: 0, thin: [], report: [] };

  const members = brigade.memberIds
    .filter((id) => (ctx.profilesById.get(id)?.household ?? "home") === ctx.house)
    .map((id) => {
      const t = ctx.targetsById.get(id);
      return {
        id,
        diet: t?.diet,
        avoid: t?.avoidIngredients,
        avoidRecipes: t?.avoidRecipes,
        slotAvoid: t?.slotAvoid,
        breakfastStyle: t?.breakfastStyle,
        snackPortable: t?.snackPortable === true,
        dinnerAnchor: t?.dinnerAnchor === true,
      };
    });
  if (members.length < 2) return { events, made: 0, thin: [], report: [] };

  const firstMember = /** @type {{ id: string }} */ (members[0]);
  const cookId = members.some((m) => m.id === brigade.cookId) ? brigade.cookId : firstMember.id;
  const dayOffset = (/** @type {string} */ date) =>
    Math.round((Date.parse(date) - Date.parse(brigade.from)) / 86400000);
  const cookFor = (/** @type {string} */ date) => {
    if (!brigade.rotateCooks || members.length === 0) return cookId;
    const at = ((dayOffset(date) % members.length) + members.length) % members.length;
    return (members[at] ?? firstMember).id;
  };
  const dates = ctx.dates
    .filter((d) => d >= brigade.from && d <= brigade.until)
    .filter((d) => d >= ctx.today)
    .sort();

  let tables = pruneTables(events, ctx.today).tables
    // trust boundary, same bar deriveTables holds: a device-poisoned table
    // (seats not an array, junk dates) is skipped here rather than throwing
    // three lines into the write loop
    .filter(
      (t) =>
        t &&
        typeof t === "object" &&
        typeof t.date === "string" &&
        typeof t.slot === "string" &&
        Array.isArray(t.seats) &&
        // element shape too: a null seat in a poisoned file threw three
        // lines into the write loop (Red Team loop 2) — same bar validTable
        // holds at derivation
        t.seats.every(
          (/** @type {any} */ s) => s && typeof s === "object" && typeof s.id === "string",
        ),
    );
  // THE SHADOW SWEEP (Final Gate Red Team + Realist, 2026-08-30): upcoming
  // tables the RETIRED AI week run wrote (`fromWeekRun`, or its pre-stamp
  // "Family <slot>" naming) at the very date+slots this brigade plans are
  // cleared before composing. Without this, 28 stale tables with random ids
  // shadowed every composed meal on the live data (derivation prefers
  // non-brigade tables) while the note claimed every day landed — six of
  // seven days actually under the calorie floor. A standing brigade OWNS its
  // span; hand-set tables carry neither marker and survive, still outranking
  // the brigade at derivation exactly as designed.
  const plannedKeys = new Set(
    dates.flatMap((d) => brigade.slots.map((s) => `${d}|${s}`)),
  );
  tables = tables.filter(
    (t) =>
      !(
        (/** @type {any} */ (t).fromWeekRun || String(t.name ?? "").startsWith("Family ")) &&
        !t.fromBrigade &&
        t.date >= ctx.today &&
        plannedKeys.has(`${t.date}|${t.slot}`)
      ),
  );
  /** @type {Map<string, import("./tables.js").TableEvent>} */
  const byId = new Map(tables.map((t) => [t.id, t]));
  /** @type {{ slot: string, available: number }[]} */
  const thin = [];
  /** @type {{ date: string, seatId: string, kcal: number, protein: number, dayKcal: number, dayProtein: number, share: number, status: string }[]} */
  const report = [];
  let made = 0;

  // pools + walks per slot, once
  /** @type {Record<string, Record<string, any>[]>} */
  const poolsBySlot = {};
  /** @type {Record<string, Record<string, any>[]>} */
  const walksBySlot = {};
  for (const slot of brigade.slots) {
    const pool = brigadePool(ctx.bankById, members, slot);
    if (pool.length === 0) {
      thin.push({ slot, available: 0 });
      continue;
    }
    if (pool.length < dates.length) thin.push({ slot, available: pool.length });
    const walk = [...pool].sort(
      (a, b) =>
        hash(`${brigade.id}|${slot}|${a.id}`) - hash(`${brigade.id}|${slot}|${b.id}`) ||
        String(a.id).localeCompare(String(b.id)),
    );
    poolsBySlot[slot] = walk; // swap alternates follow the same variety order
    walksBySlot[slot] = walk;
  }
  const liveSlots = brigade.slots.filter((s) => walksBySlot[s]);
  if (liveSlots.length === 0) return { events: { ...events, tables }, made, thin, report };

  const brigadeSlotSet = new Set(liveSlots);
  // what each slot served on nearby days (existing tables + this run's own
  // picks as they land): composeDay tries fresh alternates before repeats,
  // so the rotation's variety survives wherever the bands allow it
  /** @type {Record<string, Map<string, string>>} */
  const servedBySlot = {};
  for (const slot of liveSlots) {
    servedBySlot[slot] = new Map(
      [...byId.values()]
        .filter((t) => t.fromBrigade === brigade.id && t.slot === slot)
        .map((t) => [t.date, t.recipeId]),
    );
  }
  const recentFor = (/** @type {string} */ slot, /** @type {string} */ date) => {
    const walk = walksBySlot[slot] ?? [];
    const windowDays = Math.max(0, walk.length - 1);
    const served = servedBySlot[slot];
    /** @type {Map<string, number>} recipe -> nights since the slot served it */
    const out = new Map();
    if (!served) return out;
    for (const [d, rid] of served) {
      const gap = dayOffset(date) - dayOffset(d);
      if (gap > 0 && gap <= windowDays) {
        const prev = out.get(rid);
        if (prev === undefined || gap < prev) out.set(rid, gap);
      }
    }
    return out;
  };
  const coverage = new Map(
    members.map((m) => [
      m.id,
      memberCoverage(
        ctx.targetsById.get(m.id) ?? null,
        ctx.plansById.get(m.id) ?? null,
        dates,
        brigadeSlotSet,
        ctx.bankById,
        ctx.today,
      ),
    ]),
  );

  for (const date of dates) {
    /** @type {Record<string, import("./tables.js").TableEvent | undefined>} */
    const existingBySlot = {};
    let allExisting = true;
    for (const slot of liveSlots) {
      const t = byId.get(brigadeTableId(brigade.id, date, slot));
      existingBySlot[slot] = t;
      if (!t) allExisting = false;
    }
    if (allExisting && !ctx.regenerate) continue; // idempotent

    // the stateless START pick per slot: a pure function of (brigade, slot,
    // date). Honest scope of the H2 guarantee (Final Gate Red Team): the
    // COMPOSED result also depends on coverage and the in-run recency
    // window, so two UNSYNCED devices regenerating with different inputs
    // can land different recipes under the same table id — same class of
    // divergence any coverage-aware engine has. Synced devices hit the
    // idempotent path and write nothing; the id-keyed merge keeps the
    // first writer's week.
    /** @type {Record<string, Record<string, any>>} */
    const startBySlot = {};
    for (const slot of liveSlots) {
      const walk = /** @type {Record<string, any>[]} */ (walksBySlot[slot]);
      const pick =
        walk[(((hash(`${brigade.id}|${slot}`) + dayOffset(date)) % walk.length) + walk.length) % walk.length];
      if (pick) startBySlot[slot] = pick;
    }

    const seats = members.map((m) => {
      const cov = coverage.get(m.id);
      const covered = cov?.coveredByDate[date] ?? { calories: 0, protein: 0 };
      const targets = ctx.targetsById.get(m.id) ?? null;
      // slots this member is not eating from the pot: their own pinned/OUT
      // entry wins (declining by pinning, amendment 4), and a carried HUMAN
      // skip stays skipped. A machine-stamped skip (auto: true) is
      // recomputed fresh every run — carrying it would keep a member off the
      // pot forever after they unpin (the resurrect-the-decline bug, inverted)
      const blockedSlots = new Set(
        liveSlots.filter((slot) => cov?.blocked.has(`${date}|${slot}`)),
      );
      const exclude = new Set(
        liveSlots.filter((slot) => {
          if (blockedSlots.has(slot)) return true;
          const old = existingBySlot[slot]?.seats?.find((s) => s.id === m.id);
          return old?.status === "skipped" && !(/** @type {any} */ (old).auto);
        }),
      );
      // the planned slots' SHARE of this member's remaining day (SLOT_WEIGHT
      // arithmetic): a subset brigade must never force-feed a whole day into
      // one pot. Slots already covered (a swipe, a fixed slot, their own
      // pin) are out of both sides — their calories sit in `covered`.
      const weightOf = (/** @type {string} */ s) =>
        SLOT_WEIGHT[/** @type {keyof typeof SLOT_WEIGHT} */ (s)] ?? 1;
      const memberSlots = /** @type {string[]} */ (
        Array.isArray(targets?.mealSlots) && targets.mealSlots.length > 0
          ? targets.mealSlots
          : ["breakfast", "lunch", "dinner"]
      );
      const coveredSlots = cov?.coveredSlotsByDate[date] ?? new Set();
      const participating = liveSlots.filter((s) => !exclude.has(s));
      const restUncovered = memberSlots.filter(
        (s) => !brigadeSlotSet.has(s) && !coveredSlots.has(s),
      );
      const wPlanned = participating.reduce((sum, s) => sum + weightOf(s), 0);
      const wRest = restUncovered.reduce((sum, s) => sum + weightOf(s), 0);
      const share = wPlanned + wRest > 0 ? wPlanned / (wPlanned + wRest) : 1;
      // a hand-edited portion binds while the dish is unchanged — and ONLY a
      // portion the human explicitly stamped (`edited: true`, written by
      // patchSeat). The previous build INFERRED edits by comparing servings
      // against quantized rawServings, which misread 80% of the composer's
      // own output as human and froze regenerations (Final Gate, 2026-08-30).
      // Intent is stamped, never derived. The recipeId travels with the
      // constraint so a swap drops it (composeDay applies it per-tuple).
      /** @type {Record<string, { servings: number, recipeId: string }>} */
      const fixed = {};
      for (const slot of liveSlots) {
        if (exclude.has(slot)) continue;
        const ex = existingBySlot[slot];
        const old = ex?.seats?.find((s) => s.id === m.id);
        if (old && ex && /** @type {any} */ (old).edited === true) {
          fixed[slot] = { servings: old.servings, recipeId: ex.recipeId };
        }
      }
      return {
        id: m.id,
        targets,
        bands: seatBands(targets, covered, share),
        covered,
        share,
        exclude,
        blockedSlots,
        fixed,
      };
    });

    // compose over seats that actually eat something from the pot today
    const eating = seats.filter((s) => s.bands && s.exclude.size < liveSlots.length);
    const composed =
      eating.length > 0
        ? composeDay({
            slots: liveSlots,
            poolsBySlot,
            startBySlot,
            recentBySlot: Object.fromEntries(liveSlots.map((s) => [s, recentFor(s, date)])),
            seats: eating.map((s) => ({
              id: s.id,
              targets: s.targets,
              bands: s.bands,
              fixed: s.fixed,
              exclude: s.exclude,
            })),
          })
        : null;
    const picks = composed?.picks ?? startBySlot;
    for (const slot of liveSlots) {
      const rid = picks[slot]?.id;
      if (rid) servedBySlot[slot]?.set(date, rid);
    }

    for (const slot of liveSlots) {
      const meal = picks[slot];
      if (!meal) continue;
      const id = brigadeTableId(brigade.id, date, slot);
      const existing = existingBySlot[slot];
      if (existing && !ctx.regenerate && existing.recipeId === meal.id) {
        // untouched existing table on a partially-new day stays untouched
        continue;
      }
      const sameDish = existing?.recipeId === meal.id;
      const seatRows = members.map((m) => {
        const seat = seats.find((s) => s.id === m.id);
        const old = existing?.seats?.find((s) => s.id === m.id);
        const solvedS = composed?.seats[m.id]?.servings?.[slot];
        const rawExact = seatServingsRaw(ctx.targetsById.get(m.id), slot, meal);
        const raw3 = rawExact === null ? undefined : Math.round(rawExact * 1000) / 1000;
        const fallback =
          raw3 === undefined
            ? 1
            : Math.min(BRIGADE_SERVINGS_MAX, Math.max(SERVINGS_MIN, Math.round(raw3 * 4) / 4));
        const edited = sameDish && /** @type {any} */ (old)?.edited === true;
        // a seat whose own pinned/OUT entry wins this slot is written
        // SKIPPED with auto: true — never silently seated at a fallback
        // portion the cook would shop and cook for nobody (Final Gate:
        // 1.25 servings of gyudon bought for a person eating their own
        // pinned pasta). auto marks it machine-stamped: recomputed every
        // run, unlike a human decline, which carries.
        if (seat?.blockedSlots?.has(slot)) {
          return {
            id: m.id,
            servings: old?.servings ?? fallback,
            ...(raw3 !== undefined ? { rawServings: raw3 } : {}),
            status: /** @type {"skipped"} */ ("skipped"),
            auto: true,
            ...(edited ? { edited: true } : {}),
          };
        }
        const fixedSeat = seat?.fixed[slot];
        const fixedHere = edited && fixedSeat != null && fixedSeat.recipeId === meal.id;
        return {
          id: m.id,
          servings: fixedHere
            ? fixedSeat.servings
            : seat?.exclude.has(slot)
              ? (sameDish ? (old?.servings ?? fallback) : fallback)
              : (solvedS ?? fallback),
          ...(raw3 !== undefined ? { rawServings: raw3 } : {}),
          ...(old?.status && !(/** @type {any} */ (old).auto) ? { status: old.status } : {}),
          ...(edited ? { edited: true } : {}),
        };
      });
      byId.set(id, {
        id,
        name: brigade.name,
        date,
        slot,
        recipeId: meal.id,
        seats: seatRows,
        cookId: cookFor(date),
        ...(existing?.buyerId ? { buyerId: existing.buyerId } : {}),
        ...(existing?.headId ? { headId: existing.headId } : {}),
        ...(sameDish && existing?.cookedAt ? { cookedAt: existing.cookedAt } : {}),
        ...(sameDish && existing?.sameForEveryone ? { sameForEveryone: true } : {}),
        ...(sameDish && /** @type {any} */ (existing)?.pot
          ? { pot: /** @type {any} */ (existing).pot }
          : {}),
        fromBrigade: brigade.id,
      });
      made++;
    }

    if (composed) {
      for (const s of eating) {
        const solved = composed.seats[s.id];
        if (!solved) continue;
        report.push({
          date,
          seatId: s.id,
          kcal: solved.kcal,
          protein: solved.protein,
          dayKcal: solved.kcal + s.covered.calories,
          dayProtein: solved.protein + s.covered.protein,
          // share < 1 = a subset brigade: dayKcal is the planned slots'
          // share plus covered credit, NOT a whole day — the caller's copy
          // must not read as a starvation warning (Final Gate Engineer)
          share: s.share,
          status: solved.status,
        });
      }
    }
    // a member with no usable targets is still seated (at 1 serving) but
    // never solved — the report says so instead of letting the view claim
    // "everyone lands" over a seat nobody ever computed (Final Gate Red
    // Team: a new member who hasn't filled targets in was silently unfed
    // and affirmatively covered up)
    for (const s of seats) {
      if (s.bands || s.exclude.size >= liveSlots.length) continue;
      report.push({
        date,
        seatId: s.id,
        kcal: 0,
        protein: 0,
        dayKcal: 0,
        dayProtein: 0,
        share: 1,
        status: "no-targets",
      });
    }
  }

  tables = [...byId.values()];
  return { events: { ...events, tables }, made, thin, report };
}

/** FNV-1a, the same deterministic shuffle key tables.js uses. */
function hash(/** @type {string} */ s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}
