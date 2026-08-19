// Tables: shared meals (docs/tables-design.md v2, Tribunal-gated).
// A table lives ONLY in its house's households/<h>/events.json; every
// profile's app DERIVES virtual pinned entries from it at read time — no
// cross-profile writes, ever. Cancel/edit = one file edit, propagates on
// the next sync tick. Derived entries are NEVER persisted into a plan file
// (main.js strips `e.table` before every plan write).
import { recipeConflicts, SLOT_KEYS, untrustedForAutoPlan } from "./plan.js";
import { parsePot, solveSeat } from "./synth.js";

/**
 * @typedef {{ id: string, servings: number, rawServings?: number, status?: "in" | "skipped" }} Seat seat id = profileId
 * @typedef {{ portionGrams?: number, plate: string[], estCalories: number, estProtein: number }} TailorSeat scale-first: portionGrams = weighed grams of the finished dish on this plate (absent/0 on pre-scale tailors)
 * @typedef {{ at: string, seats: Record<string, TailorSeat>, cook: string[] }} TableTailor AI plate-tailoring result
 * @typedef {{ id: string, name: string, date: string, slot: string, recipeId: string, seats: Seat[], tailor?: TableTailor, cookId?: string, buyerId?: string, fromBrigade?: string, sameForEveryone?: boolean, cookedAt?: string, pot?: string, headId?: string }} TableEvent
 * @typedef {{ id: string, name: string, memberIds: string[], slots: string[], cookId?: string, rotateCooks?: boolean, from: string, until: string }} Brigade
 * @typedef {{ tables: TableEvent[], brigades?: Brigade[] }} HouseEvents
 */

/** the storage name is legacy ("household"); the user-facing concept is house */
export const eventsPathFor = (/** @type {string} */ house) => `households/${house}/events.json`;

/** Derivation ignores tables further past than this; CRUD writes prune them. */
const RETAIN_PAST_DAYS = 14;

/** Tribunal amendment 2: servings clamp bounds (UI inputs share them). */
export const SERVINGS_MIN = 0.5;
export const SERVINGS_MAX = 10;

/**
 * Shape a freshly-read (or absent) events file. Also the self-heal point:
 * anything not recognizably a table array becomes an empty one.
 * @param {Record<string, any> | null} raw
 * @returns {HouseEvents}
 */
export function normalizeEvents(raw) {
  return {
    tables: /** @type {TableEvent[]} */ (
      Array.isArray(raw?.tables) ? raw.tables.filter(isPlainObject) : []
    ),
    // brigades drive a WRITE loop (materializeBrigade), so unlike the old
    // pass-through this is now a real trust boundary: one bad brigade is
    // dropped on its own rather than throwing or, worse, materializing five
    // meals a day forever into the file all four devices read every load.
    ...(raw?.brigades !== undefined
      ? {
          brigades: /** @type {Brigade[]} */ (
            Array.isArray(raw.brigades) ? raw.brigades.filter(validBrigade) : []
          ),
        }
      : {}),
  };
}

/** A brigade may not run longer than this without being renewed (Red Team). */
const MAX_BRIGADE_DAYS = 28;

/**
 * One brigade validated at the trust boundary, mirroring validTable.
 *
 * `until` is REQUIRED and the span is capped: an open-ended brigade over
 * several slots would materialize tables with no horizon, and every one of
 * them adds a shopping pseudo-entry for the cook.
 * @param {unknown} b
 * @returns {b is Brigade}
 */
export function validBrigade(b) {
  if (!isPlainObject(b)) return false;
  const isDate = (/** @type {any} */ d) =>
    typeof d === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(d) &&
    !Number.isNaN(+new Date(`${d}T12:00:00`));
  if (typeof b.id !== "string" || b.id.length === 0) return false;
  if (!isDate(b.from) || !isDate(b.until)) return false;
  if (b.until < b.from) return false;
  const span = (+new Date(`${b.until}T12:00:00`) - +new Date(`${b.from}T12:00:00`)) / 86400000;
  if (span > MAX_BRIGADE_DAYS) return false;
  if (!Array.isArray(b.memberIds) || b.memberIds.length < 2) return false;
  if (!b.memberIds.every((/** @type {any} */ m) => typeof m === "string" && m.length > 0))
    return false;
  if (!Array.isArray(b.slots) || b.slots.length === 0) return false;
  if (!b.slots.every((/** @type {any} */ s) => SLOT_KEYS.includes(s))) return false;
  return true;
}

/** @param {unknown} v @returns {v is Record<string, any>} */
function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * One table validated at the trust boundary (Tribunal amendment 2): every
 * field a device could have poisoned is checked here; invalid = the table
 * is individually skipped, never a broken plan for the whole house.
 * @param {Record<string, any>} t
 * @returns {t is TableEvent}
 */
function validTable(t) {
  return (
    typeof t.id === "string" &&
    t.id.length > 0 && // "" would defeat main.js's !e.table strip (Red Team F1)
    typeof t.recipeId === "string" &&
    typeof t.date === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(t.date) &&
    !Number.isNaN(+new Date(`${t.date}T12:00:00`)) && // "9999-99-99" dodges retention (F7)
    SLOT_KEYS.includes(t.slot) &&
    Array.isArray(t.seats) &&
    t.seats.every(
      (/** @type {any} */ s) =>
        isPlainObject(s) && typeof s.id === "string" && Number.isFinite(Number(s.servings)),
    )
  );
}

/** @param {number} n */
const clampServings = (n) => Math.min(SERVINGS_MAX, Math.max(SERVINGS_MIN, Number(n) || 1));

/**
 * THE cook rule, exported so the money ledger can never drift from it:
 * the FIRST non-skipped seat belonging to a REAL profile that lives in the
 * table's house. Null when no such seat exists.
 * @param {TableEvent} t
 * @param {string} house
 * @param {Map<string, any>} profilesById
 * @returns {Seat | null}
 */
export function cookOf(t, house, profilesById) {
  const known = (t.seats ?? []).filter((s) => s.status !== "skipped" && profilesById.has(s.id));
  const inHouse = known.filter((s) => (profilesById.get(s.id)?.household ?? "home") === house);
  // An EXPLICIT cookId wins over array position. Position was fine while a
  // human created every table by hand, but it is not a place to keep "who
  // pays": mergeKeyedArrays rebuilds seat order from map insertion order, so
  // a 409 could hand the bill to someone else. Brigade-materialized tables
  // always carry cookId; hand-made ones fall back to the original rule.
  // A SKIPPED named cook does NOT cook (David, 2026-08-09, superseding
  // Tribunal 2026-08-01's "cooking is not eating"): in this family SKIP MINE
  // means "I'm not there", so the role falls to the first non-skipped
  // in-house seat and the house still eats. The 08-01 concern (billing
  // sliding to seat #1 on a merge) is accepted as the smaller harm than a
  // named cook who is away and a dinner nobody cooks.
  const namedSeat = t.cookId
    ? (t.seats ?? []).find((s) => s.id === t.cookId && s.status !== "skipped")
    : null;
  const named =
    namedSeat &&
    profilesById.has(namedSeat.id) &&
    (profilesById.get(namedSeat.id)?.household ?? "home") === house
      ? namedSeat
      : null;
  return named ?? inHouse[0] ?? null;
}

/**
 * Everything ONE profile derives from every house's tables, computed fresh
 * at read time (a memo in main.js, never persisted):
 *  - `entries`: virtual PINNED plan entries for tables I'm seated at —
 *    est-based (recipe macros from the BANK × my seat's servings; my
 *    filtered pool may not even contain the recipe), `table: <id>`,
 *    `pinned: true` so the whole generator pin machinery applies.
 *  - `conflicts`: tables whose recipe fails MY diet/avoid screen — a seat
 *    NEVER silently pins food the rest of the app would refuse me
 *    (Tribunal amendment 1); surfaced as a banner, no pin, no macros.
 *  - `cookExtras`: if I CLAIMED the groceries (t.buyerId === me — see the
 *    claims note in the body; the name predates the claim system),
 *    pseudo-entries for deriveShoppingList carrying the summed NON-skipped
 *    servings, dated so the fromDate filter drops past tables. No claim =
 *    the batch rides nobody's list.
 * Collision precedence (amendment 4): my OWN entry at that date+slot wins;
 * the table entry is skipped and reported in `collisions`. At most one
 * derived pin per date+slot (first valid table wins).
 * The whole derivation is wrapped by the caller; any throw degrades to
 * "no tables", never a broken plan.
 * @param {{ house: string, events: HouseEvents }[]} houses every house's events
 * @param {{
 *   profileId: string,
 *   diet?: string,
 *   avoid?: string[],
 *   avoidRecipes?: string[],
 *   bankById: Map<string, any>,
 *   ownEntries: Record<string, any>[],
 *   today: string,
 *   profilesById?: Map<string, any>,
 *   myTargets?: Record<string, any> | null
 * }} ctx
 * @returns {{
 *   entries: Record<string, any>[],
 *   conflicts: { table: TableEvent, reasons: string[] }[],
 *   collisions: TableEvent[],
 *   cookExtras: { recipeId: string, date: string, servings: number, potFromBank?: boolean }[],
 *   allCookExtras: { cookId: string, buyerId?: string, recipeId: string, date: string, servings: number }[]
 * }}
 */
export function deriveTables(houses, ctx) {
  /** @type {Record<string, any>[]} */
  const entries = [];
  /** @type {{ table: TableEvent, reasons: string[] }[]} */
  const conflicts = [];
  /** @type {TableEvent[]} */
  const collisions = [];
  /** @type {{ recipeId: string, date: string, servings: number }[]} */
  const cookExtras = [];
  /** @type {{ cookId: string, recipeId: string, date: string, servings: number }[]} */
  const allCookExtras = [];
  // collision = only DELIBERATE own entries (pinned or OUT), per amendment
  // 4: "pinning your own meal is how a guest declines". A generated unpinned
  // meal never blocks a table — the view displaces it and the next generate
  // clears it.
  const takenSlots = new Set(
    ctx.ownEntries.filter((e) => e.pinned || e.out).map((e) => `${e.date}|${e.slot}`),
  );
  /** slots already filled by an earlier valid table (one pin per slot) */
  const derivedSlots = new Set();
  /** slots I am already shopping as cook — one meal is bought once */
  const cookSlots = new Set();
  const horizon = new Date(`${ctx.today}T12:00:00`);
  horizon.setDate(horizon.getDate() - RETAIN_PAST_DAYS);

  // PRECEDENCE. A hand-set table beats a brigade's standing one for the same
  // date and slot: setting a family dinner by hand is exactly how you say
  // "not the usual tonight", and the brigade must yield to it rather than
  // race it on file order. Sorting here (rather than at each guard) also
  // makes the cook's shopping choice deterministic across devices.
  const ordered = houses.flatMap(({ house, events }) => events.tables.map((t) => ({ house, t })));
  ordered.sort(
    (a, b) =>
      a.t.date?.localeCompare(b.t.date) ||
      String(a.t.slot).localeCompare(String(b.t.slot)) ||
      (a.t.fromBrigade ? 1 : 0) - (b.t.fromBrigade ? 1 : 0) ||
      String(a.t.id).localeCompare(String(b.t.id)),
  );

  {
    for (const { house, t } of ordered) {
      if (!validTable(t)) continue;
      if (new Date(`${t.date}T12:00:00`) < horizon) continue; // retention
      const recipe = ctx.bankById.get(t.recipeId);
      const live = t.seats.filter((s) => s.status !== "skipped");
      // only seats belonging to REAL profiles count for cooking and for the
      // shopping sum — a poisoned seats array must not flood the list or
      // steal/void the cook role (Red Team F2/F3); the total is thereby
      // bounded at #profiles x 10
      const known = live.filter((s) => ctx.profilesById?.has(s.id));

      // cook rule shared with the money ledger (cookOf)
      const cook = ctx.profilesById ? cookOf(t, house, ctx.profilesById) : null;
      const slotKey = `${t.date}|${t.slot}`;
      // the SHOPPING dedupe is HOUSE-scoped: "one meal is bought once" means
      // one KITCHEN. Unscoped, the first table across ALL houses at a
      // date+slot ate the key and a cook whose relatives' house also eats
      // that night bought nothing for their own (review 2026-08-02, HIGH #2).
      // My-plan collision/pin keys (takenSlots/derivedSlots) stay date|slot —
      // I eat one dinner however many houses are cooking.
      const houseSlotKey = `${house}|${slotKey}`;
      // GROCERY CLAIMS (David, 2026-08-03): a family dinner's ingredients
      // ride NOBODY's shopping list until someone claims the buy — "you
      // don't know who will buy it, it may not be the cook." `buyerId`
      // names the volunteer (I'LL BUY THIS); absent = the batch appears on
      // no list at all, while the dinner still pins and plans for every
      // seat. The buyer must be an in-house profile or the claim is inert.
      const buyer =
        t.buyerId && (ctx.profilesById?.get(t.buyerId)?.household ?? "home") === house
          ? t.buyerId
          : null;
      if (cook && recipe && !cookSlots.has(houseSlotKey)) {
        // A GUEST IS ONE MORE PLATE (canon P8, fix list 7.4): the same pot
        // with extra plates on a sensible default — one recipe serving each.
        // Guests join the cook's pot and the buy; billing them stays parked
        // in Mise-Later, so their cost rides the cook's ledger for now.
        const total =
          known.reduce((sum, s) => sum + clampServings(s.servings), 0) + clampGuests(t);
        if (total > 0) {
          // one meal is bought once. Without this guard two tables claiming
          // the same slot (a hand-set dinner over a brigade's, or the same
          // brigade meal written twice by two offline devices) each add a
          // shopping pseudo-entry, and the buyer quietly buys the dinner twice
          cookSlots.add(houseSlotKey);
          // every table's batch with its cook and claimant — for the claim
          // buttons. Derived-only, like everything else this function returns.
          allCookExtras.push({
            cookId: cook.id,
            ...(buyer ? { buyerId: buyer } : {}),
            recipeId: t.recipeId,
            date: t.date,
            servings: total,
          });
          if (buyer === ctx.profileId) {
            // potFromBank: the SHARED POT is always the bank recipe, never the
            // buyer's personal variant of the same id (David, 2026-08-10).
            // Without this flag deriveShoppingList resolves this id through the
            // MERGED pool, where a profile's own variant wins by id — so when
            // mom claimed a family dinner the house was shopped from her
            // 480 kcal personal kofta scaled by a seat total computed from the
            // bank's 842 kcal one. Her own PLAN entries must still resolve
            // through the merged pool (her variant is correct for her own
            // plate), so the distinction has to travel on the entry; a single
            // lookup map cannot carry it, because both meanings share one id.
            // A FROZEN POT (solved tables only, spec §10) overrides the
            // quantities wholesale: deriveTables reads t.pot when present and
            // computes only when absent. Invalid pots drop to the plain path.
            const frozen = parsePot(/** @type {any} */ (t).pot, recipe);
            cookExtras.push(
              /** @type {any} */ ({
                recipeId: t.recipeId,
                date: t.date,
                servings: total,
                potFromBank: true,
                // rung-3 top-ups are part of the buy (§11.4): appended to
                // the pot rows so the list prices and displays them like any
                // other line, absolute grams, no perServing multiply
                ...(frozen ? { potRows: [...frozen.rows, ...(frozen.topUps ?? [])] } : {}),
              }),
            );
          }
        }
      }

      const mySeat = live.find((s) => s.id === ctx.profileId);
      if (!mySeat) continue;

      // conflict banners are for meals still AHEAD: an old table that
      // already happened cannot be acted on, and mom's phone showing four
      // July onion-dinner warnings in mid-August is pure noise (2026-08-09)
      const past = t.date < ctx.today;
      if (!recipe) {
        // a table on a non-bank recipe (someone's personal variant) has no
        // honest macros for anyone else — surface it, never silently no-op
        // a family dinner out of existence (Red Team F4)
        if (!past) conflicts.push({ table: t, reasons: ["recipe not in the shared bank"] });
        continue;
      }

      const reasons = recipeConflicts(recipe, ctx.diet, ctx.avoid, ctx.avoidRecipes);
      if (reasons.length > 0) {
        if (!past) conflicts.push({ table: t, reasons });
        continue; // no pin, no macros — never a backdoor around the screen
      }
      const key = slotKey;
      if (takenSlots.has(key)) {
        collisions.push(t); // my own entry wins; pinning my own meal = declining
        continue;
      }
      if (derivedSlots.has(key)) continue; // one derived pin per slot
      derivedSlots.add(key);

      const servings = clampServings(mySeat.servings);
      // MY plate's bucket multipliers, for Daily Dozen credit scaling
      // (spec §11.2). Uniform (untagged, unshopped-guard is the caller's
      // weekShopped concern at freeze time; credits are display-side and
      // follow the live solve) -> all 1 -> groupScale omitted entirely.
      const mySolve =
        recipe.assembly === "plated" && !t.sameForEveryone && ctx.myTargets
          ? solveSeat({
              recipe,
              assembly: recipe.assembly,
              seat: /** @type {any} */ (mySeat),
              targets: ctx.myTargets,
              slotShare: slotShareFor(ctx.myTargets, t.slot),
            })
          : null;
      // CREDIT WHAT YOU RENDER (§4.2, Loyalist): the serve step rounds cup
      // amounts to quarters, so the credit multiplier is the QUARTIZED
      // beta, never the float — the scoreboard must not credit food the
      // instruction never conveyed. Floor 0.25: a rendered spoonful is
      // still food.
      const qtr = mySolve ? Math.max(0.25, Math.round(mySolve.beta * 4) / 4) : 1;
      const groupScale =
        mySolve && mySolve.synthMode === "solved"
          ? {
              // ONLY wholeGrains scales: its foods (rice, oats, bread…)
              // genuinely resolve to the carbfat bucket beta moves. Flax,
              // most nuts and seeds resolve to FLAVOR — the seat eats 100%
              // of them — and beans can resolve to protein (alpha). Crediting
              // those at beta would shrink credit for food fully eaten
              // (credit-what-you-render, inverted). Per-food part-aware
              // credit can extend this later.
              wholeGrains: qtr,
            }
          : null;
      const myTailor = t.tailor?.seats?.[ctx.profileId];
      const n = recipe.nutrition ?? {};
      // GUESTS COOK TOO (7.4, reviewer catch 2026-08-19): the buy included
      // their plates, so the batch the cook is walked through must as well —
      // buying for "us plus two" and cooking for "us" shorts the table
      const knownTotal =
        known.reduce((sum, s2) => sum + clampServings(s2.servings), 0) + clampGuests(t);
      entries.push({
        id: `table-${t.id}`,
        table: t.id,
        date: t.date,
        slot: t.slot,
        // viewRecipeId: lets Cook view link to the recipe WITHOUT tripping
        // deriveShoppingList/dayTotals, which key on recipeId specifically —
        // a real recipeId here would make every guest shop the dish
        viewRecipeId: t.recipeId,
        // the cook needs the BATCH total at cook time, not just their portion
        ...(cook && cook.id === ctx.profileId ? { cookTotal: knownTotal } : {}),
        // WHO cooks tonight, resolved to a display name here so no view needs
        // the profiles list (Tribunal U1: with rotating cooks nobody could
        // see whose turn it was). Derived-only, stripped like the rest.
        ...(cook
          ? {
              cookId: cook.id,
              cookName: ctx.profilesById?.get(cook.id)?.name ?? cook.id,
            }
          : {}),
        freeText: `🍽 ${t.name || recipe.name}`,
        servings,
        pinned: true,
        // council 2026-07-23: a tailored plate's estimate replaces recipe ×
        // servings in the day meters, so tailoring is never theater — the
        // meter must count the plate David actually eats
        estCalories:
          myTailor && myTailor.estCalories > 0
            ? myTailor.estCalories
            : Math.round((n.calories ?? 0) * servings),
        estProtein:
          myTailor && myTailor.estProtein > 0
            ? myTailor.estProtein
            : Math.round((n.protein ?? 0) * servings),
        // my seat's AI plate-tailoring, if the table has been tailored —
        // view-only, stripped with the rest of the derived entry
        ...(myTailor ? { plate: myTailor.plate } : {}),
        ...(groupScale ? { groupScale } : {}),
      });
    }
  }
  return { entries, conflicts, collisions, cookExtras, allCookExtras };
}

/**
 * The ONE strip predicate (Engineer seam): derived table entries must never
 * reach plans/<week>.json. Property presence, not truthiness — an empty
 * table id must still strip.
 * @param {Record<string, any>[]} entries
 * @returns {Record<string, any>[]}
 */
export function stripTableEntries(entries) {
  return entries.filter((e) => !("table" in e));
}

/**
 * The view merge (Engineer seam): pure plan + derived entries, with any
 * unpinned/non-OUT own entry DISPLACED from a slot a table claims (the next
 * generate clears it for real). Derived entries are CLAMPED to the plan's
 * own week — a current-week table must never leak into a future week's
 * generate as an out-of-week pinned day (Realist HIGH: the generator's
 * passes would top it up with real snack entries dated outside the week).
 * @param {import("./plan.js").Plan} plan
 * @param {Record<string, any>[]} tableEntries
 * @param {string[]} weekDates datesOfWeek(plan.week)
 * @param {string} [today] past days are NEVER displaced: a generate would
 *   set the displaced view aside as "past history", strip the table entry,
 *   and persist a hole where a real eaten meal used to be (Engineer gate)
 * @returns {{ plan: import("./plan.js").Plan, displaced: boolean }}
 */
export function mergeViewPlan(plan, tableEntries, weekDates, today) {
  const weekSet = new Set(weekDates);
  const inWeek = tableEntries.filter((e) => weekSet.has(e.date));
  if (inWeek.length === 0) return { plan, displaced: false };
  const claimed = new Set(inWeek.map((e) => `${e.date}|${e.slot}`));
  const kept = plan.entries.filter(
    (e) =>
      e.pinned ||
      e.out ||
      (today !== undefined && e.date < today) ||
      !claimed.has(`${e.date}|${e.slot}`),
  );
  return {
    plan: { ...plan, entries: /** @type {any} */ ([...kept, ...inWeek]) },
    displaced: kept.length !== plan.entries.length,
  };
}

/** @returns {string} unique-per-device table id */
const genId = () => crypto.randomUUID().slice(0, 8);

/**
 * Add a table; also prunes past-retention tables (the documented cleanup
 * point). Pure.
 * @param {HouseEvents} events
 * @param {{ name: string, date: string, slot: string, recipeId: string, seats: Seat[] }} t
 * @param {string} today
 * @returns {HouseEvents}
 */
export function addTable(events, t, today) {
  const cleaned = pruneTables(events, today);
  return {
    ...cleaned,
    tables: [
      ...cleaned.tables,
      {
        id: genId(),
        ...t,
        seats: t.seats.map((s) => ({ ...s, servings: clampServings(s.servings) })),
      },
    ],
  };
}

/**
 * @param {HouseEvents} events
 * @param {string} id
 * @param {string} today
 * @returns {HouseEvents}
 */
export function removeTable(events, id, today) {
  const cleaned = pruneTables(events, today);
  return { ...cleaned, tables: cleaned.tables.filter((t) => t.id !== id) };
}

/**
 * Edit YOUR OWN seat (servings and/or skipped status) — the one write a
 * non-creator makes, id-keyed so it merges cleanly (amendment 5). Pure.
 * @param {HouseEvents} events
 * @param {string} tableId
 * @param {string} profileId
 * @param {Partial<Seat>} patch
 * @param {string} [today] prunes past-retention tables like every CRUD write
 * @returns {HouseEvents}
 */
export function patchSeat(events, tableId, profileId, patch, today) {
  // whitelist: a patch may change servings/status, never id or junk keys
  const clean = {
    ...(patch.servings != null ? { servings: clampServings(patch.servings) } : {}),
    ...(patch.status != null ? { status: patch.status } : {}),
  };
  const base = today ? pruneTables(events, today) : events;
  return {
    ...base,
    tables: base.tables.map((t) =>
      t.id === tableId
        ? {
            ...t,
            seats: t.seats.map((s) => (s.id === profileId ? { ...s, ...clean } : s)),
          }
        : t,
    ),
  };
}

/**
 * Claim (or release) a table's GROCERY BUY. buyerId names who volunteered to
 * shop the batch — "I'll buy this" — and only that profile's derived list
 * carries the ingredients. Null clears the claim, and clearing writes the
 * field out of the object entirely (absent, not null, per SCHEMAS
 * conventions). Membership sanity (buyer in the table's house) is enforced
 * at derive time, so a stale claim from someone who moved out simply goes
 * inert instead of corrupting anything.
 * @param {HouseEvents} events
 * @param {string} tableId
 * @param {string | null} buyerId
 * @param {string} today prune anchor, like every other CRUD write
 * @returns {HouseEvents}
 */
export function setTableBuyer(events, tableId, buyerId, today) {
  const base = pruneTables(events, today);
  return {
    ...base,
    tables: base.tables.map((t) => {
      if (t.id !== tableId) return t;
      if (!buyerId) {
        const rest = { ...t };
        delete rest.buyerId;
        return rest;
      }
      return { ...t, buyerId };
    }),
  };
}

/**
 * "Everyone eats the same tonight" — the EXCEPTION, not the default (David,
 * 2026-08-10). Tailoring now runs automatically on every upcoming table,
 * because following the plan should be what happens when nobody does
 * anything. Setting this flag opts one meal out: no per-person plates, one
 * dish, serve it how you like. Clearing it drops the field entirely
 * (absent = tailored, per the SCHEMAS "absent != null" convention) and the
 * auto-tailor picks the table up again.
 *
 * Deliberately per-TABLE and not a profile setting: a cheat night is one
 * dinner, not a new way of eating.
 * @param {HouseEvents} events
 * @param {string} tableId
 * @param {boolean} same
 * @param {string} [today] prunes past-retention tables like every CRUD write
 * @returns {HouseEvents}
 */
export function setTableSameForEveryone(events, tableId, same, today) {
  const base = today ? pruneTables(events, today) : events;
  return {
    ...base,
    tables: base.tables.map((t) => {
      if (t.id !== tableId) return t;
      if (!same) {
        const rest = { ...t };
        delete rest.sameForEveryone;
        return rest;
      }
      // dropping any existing tailor is the point: the plates are what the
      // person just said they do not want tonight. The frozen pot goes with
      // it (Tribunal loop-2 N9): a solved pot must not keep driving the buy
      // under a flag that promises no per-person plates.
      const rest = /** @type {Record<string, any>} */ ({ ...t, sameForEveryone: true });
      delete rest.tailor;
      delete rest.pot;
      return /** @type {TableEvent} */ (rest);
    }),
  };
}

/**
 * Write (or clear, with null) a table's FROZEN POT string (spec §10). The
 * pot is the contract for money and buying; it freezes at buy-claim or at
 * COOKED, whichever fires first, and ONLY in solved mode — the caller
 * computes the string via synth.js freezePotString and passes null for
 * uniform tables. Stored as a string so the merge treats it atomically.
 * @param {HouseEvents} events
 * @param {string} tableId
 * @param {string | null} potString
 * @param {string} today
 * @returns {HouseEvents}
 */
export function setTablePot(events, tableId, potString, today) {
  const base = pruneTables(events, today);
  return {
    ...base,
    tables: base.tables.map((t) => {
      if (t.id !== tableId) return t;
      if (!potString) {
        const rest = /** @type {Record<string, any>} */ ({ ...t });
        delete rest.pot;
        return /** @type {TableEvent} */ (rest);
      }
      return /** @type {TableEvent} */ ({ ...t, pot: potString });
    }),
  };
}

/**
 * Confirm a table's meal COOKED (per-person-plates-design §7.2): the serve
 * step's button writes this, and it is the only honest adoption signal the
 * instrument has. Set-once by design — you cannot un-cook food, same rule
 * as a plan entry's cookedAt. Pure.
 * @param {HouseEvents} events
 * @param {string} tableId
 * @param {string} dateIso local YYYY-MM-DD of the confirmation
 * @param {string} today prune anchor, like every other CRUD write
 * @returns {HouseEvents}
 */
export function setTableCooked(events, tableId, dateIso, today) {
  const base = pruneTables(events, today);
  return {
    ...base,
    tables: base.tables.map((t) =>
      t.id === tableId && !t.cookedAt ? { ...t, cookedAt: dateIso } : t,
    ),
  };
}

/**
 * Name (or clear) the table's head — the ONE person whose plate decisions
 * win for this table (per-person-plates-design §9). Written ONLY by a
 * human tap (B5: a device-stamped head at materialization would break the
 * byte-identical offline-merge contract). Pure.
 * @param {HouseEvents} events
 * @param {string} tableId
 * @param {string | null} headId null = clear, fall back to the default chain
 * @param {string} today prune anchor, like every other CRUD write
 * @returns {HouseEvents}
 */
/**
 * Bounded guest count for a table: whole plates, 0..10. A poisoned guests
 * field must not flood the buy (same F2-class bound as seats).
 * @param {TableEvent | Record<string, any>} t
 * @returns {number}
 */
export function clampGuests(t) {
  const g = Number(/** @type {any} */ (t).guests);
  return Number.isFinite(g) ? Math.min(10, Math.max(0, Math.round(g))) : 0;
}

/**
 * Set the table's guest plates (7.4, canon P8: "Friday it is us plus two" is
 * the same pot with two extra plates, not a special event). 0 clears.
 * @param {HouseEvents} events
 * @param {string} tableId
 * @param {number} guests
 * @param {string} today prune anchor, like every other CRUD write
 * @returns {HouseEvents}
 */
export function setTableGuests(events, tableId, guests, today) {
  const base = pruneTables(events, today);
  const g = Math.min(10, Math.max(0, Math.round(Number(guests) || 0)));
  return {
    ...base,
    tables: base.tables.map((t) => {
      if (t.id !== tableId) return t;
      if (g === 0) {
        const rest = { ...t };
        delete (/** @type {any} */ (rest).guests);
        return rest;
      }
      return { ...t, guests: g };
    }),
  };
}

/**
 * Name the table's head (spec §9/B5: written only by a human tap). Pure.
 * @param {HouseEvents} events
 * @param {string} tableId
 * @param {string | null} headId null = clear, fall back to the default chain
 * @param {string} today prune anchor
 * @returns {HouseEvents}
 */
export function setTableHead(events, tableId, headId, today) {
  const base = pruneTables(events, today);
  return {
    ...base,
    tables: base.tables.map((t) => {
      if (t.id !== tableId) return t;
      if (headId === null) {
        const rest = { ...t };
        delete rest.headId;
        return rest;
      }
      return { ...t, headId };
    }),
  };
}

/**
 * Who sets this table (spec §9 resolution chain): the tapped head if they
 * are seated and present, else the effective cook, else the first present
 * seat in profiles.json order (the only merge-stable order we have).
 * @param {TableEvent} t
 * @param {Record<string, any>[]} profilesOrder profiles.json order
 * @returns {string | null}
 */
export function resolveHead(t, profilesOrder) {
  // SEATED means in the seats array AT ALL, ignoring skip status (spec §9,
  // verbatim): cookOf filters skipped seats, so reusing it here would mean
  // tapping "skip mine" silently moves the head — the exact bug §9 names.
  // Someone cooking-but-eating-late keeps their table.
  const seated = new Set((t.seats ?? []).map((s) => s.id));
  const head = t.headId;
  if (typeof head === "string" && seated.has(head)) return head;
  if (t.cookId && seated.has(t.cookId)) return t.cookId;
  for (const p of profilesOrder) if (seated.has(p.id)) return p.id;
  return null;
}

/**
 * Attach (or replace) a table's AI plate-tailoring result. Whitelisted like
 * patchSeat: only the known keys land in the file. Pure.
 * @param {HouseEvents} events
 * @param {string} tableId
 * @param {{ at: string, seats: Record<string, { plate: string[], estCalories: number, estProtein: number }>, cook: string[] }} tailor
 * @param {string} today prunes past-retention tables like every CRUD write
 * @returns {HouseEvents}
 */
export function setTableTailor(events, tableId, tailor, today) {
  const clean = {
    at: typeof tailor.at === "string" ? tailor.at : "",
    seats: tailor.seats && typeof tailor.seats === "object" ? tailor.seats : {},
    cook: Array.isArray(tailor.cook) ? tailor.cook : [],
  };
  const base = pruneTables(events, today);
  return {
    ...base,
    tables: base.tables.map((t) => (t.id === tableId ? { ...t, tailor: clean } : t)),
  };
}

// ---------------------------------------------------------------------------
// BRIGADES (S3). A brigade is a STANDING table: two or more people living in
// one house who eat the same meals at their own portions.
//
// The whole design is one decision: a brigade is a TABLE FACTORY. It stores
// only the standing rule, and generation materializes ordinary tables tagged
// `fromBrigade`. Nothing below re-implements derivation, because everything
// tables already do then applies for free and identically: the diet screen at
// both ends, per-seat servings, skip status, cook-shops-the-sum, the
// retention prune, the money ledger, and the strip that keeps derived entries
// out of plan files.
// ---------------------------------------------------------------------------

/** Rough share of a day each slot carries, before a member's own slots renormalize it. */
const SLOT_WEIGHT = { breakfast: 1, lunch: 1.15, dinner: 1.3, smoothie: 0.7, snack: 0.5 };

/** Brigade portions are tighter than hand-set table portions. */
export const BRIGADE_SERVINGS_MAX = 3;

/**
 * How many servings of `recipe` this member eats at `slot`, from their own
 * targets. This is the "same meal, different plates" rule: one pot, and
 * gain-phase David and maintenance Mom take different amounts out of it.
 *
 * The slot's share of the day renormalizes over the member's OWN meal slots,
 * so someone who skips breakfast gets a correspondingly bigger dinner rather
 * than a silently short day.
 * @param {Record<string, any> | undefined} targets that member's targets.json
 * @param {string} slot
 * @param {Record<string, any>} recipe
 * @returns {number}
 */
export function seatServingsFor(targets, slot, recipe) {
  const raw = seatServingsRaw(targets, slot, recipe);
  if (raw === null) return 1;
  const quarters = Math.round(raw * 4) / 4;
  return Math.min(BRIGADE_SERVINGS_MAX, Math.max(SERVINGS_MIN, quarters));
}

/**
 * The RAW, unrounded, unclamped appetite ratio (sigma, per-person-plates
 * spec 4.3): the solve's target side divides by THIS so it is never asked
 * to close a gap that is pure quantization. Null when it cannot be
 * computed (no targets, no calories, empty slots) - the spec's rung 0d.
 * Stored on seats as `rawServings` in the SAME materialization write as
 * `servings`, so the pair is stale together or fresh together.
 * @param {Record<string, any> | undefined} targets
 * @param {string} slot
 * @param {Record<string, any>} recipe
 * @returns {number | null}
 */
export function seatServingsRaw(targets, slot, recipe) {
  const perServing = recipe?.nutrition?.calories ?? 0;
  const dayCalories = targets?.macros?.calories ?? 0;
  if (perServing <= 0 || dayCalories <= 0) return null;
  const slots =
    Array.isArray(targets?.mealSlots) && targets.mealSlots.length > 0
      ? targets.mealSlots
      : ["breakfast", "lunch", "dinner"];
  const weightOf = (/** @type {string} */ s) =>
    SLOT_WEIGHT[/** @type {keyof typeof SLOT_WEIGHT} */ (s)] ?? 1;
  const total = slots.reduce((sum, /** @type {string} */ s) => sum + weightOf(s), 0);
  if (total <= 0) return null;
  const slotCalories = dayCalories * (weightOf(slot) / total);
  return slotCalories / perServing;
}

/**
 * The slot's share of a member's day (same weights seatServingsFor uses),
 * exported so the solve derives the calorie and protein targets from the
 * already use (spec 4.3: P* = targets.protein x slot calorie share).
 * @param {Record<string, any> | undefined} targets
 * @param {string} slot
 * @returns {number}
 */
export function slotShareFor(targets, slot) {
  const slots =
    Array.isArray(targets?.mealSlots) && targets.mealSlots.length > 0
      ? targets.mealSlots
      : ["breakfast", "lunch", "dinner"];
  const weightOf = (/** @type {string} */ s) =>
    SLOT_WEIGHT[/** @type {keyof typeof SLOT_WEIGHT} */ (s)] ?? 1;
  const total = slots.reduce((sum, /** @type {string} */ s) => sum + weightOf(s), 0);
  if (total <= 0) return 0;
  return weightOf(slot) / total;
}

/**
 * Recipes every member of the brigade can eat: the INTERSECTION of their
 * screens, never the union. This is what makes "we all eat the same meal"
 * safe rather than a backdoor around a screen every other path enforces.
 *
 * Screens against the shared BANK only. Each profile's `own` recipes are
 * deliberately exempt from diet screening elsewhere (they are that person's
 * private variants), which is safe when only they eat them and unsafe the
 * moment the meal is served to three other people.
 * @param {Map<string, any>} bankById
 * @param {{ id: string, diet?: string, avoid?: string[], avoidRecipes?: string[] }[]} members
 * @param {string} slot
 * @returns {Record<string, any>[]} eligible recipes, id-sorted for determinism
 */
export function brigadePool(bankById, members, slot) {
  const out = [];
  for (const recipe of bankById.values()) {
    if (recipe.mealType && recipe.mealType !== slot) continue;
    if ((recipe.nutrition?.calories ?? 0) <= 0) continue;
    // an AI-written recipe is choosable deliberately, never auto-planned
    // (council 2026-07-23: "AI at the table, never in the plan"). Shared
    // TAG-keyed predicate: the old `recipe.source` check here was dead code,
    // production writes tags:["ai-special"] and never a source key.
    if (untrustedForAutoPlan(recipe)) continue;
    // a recipe any member has banned outright (targets.avoidRecipes) never
    // reaches the shared pot — intersection, same as the diet screens
    if (members.some((m) => (m.avoidRecipes ?? []).includes(recipe.id))) continue;
    if (members.every((m) => recipeConflicts(recipe, m.diet, m.avoid).length === 0))
      out.push(recipe);
  }
  return out.sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

/**
 * FNV-1a over a string. The same trick plan.js and shopping.js use to make
 * independent devices agree without talking to each other.
 * @param {string} s
 * @returns {number}
 */
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * The deterministic id of one materialized brigade meal.
 *
 * This is load-bearing, not cosmetic. Two members generating the same week
 * while offline both write these tables, and the 409 merge is id-keyed: with
 * random ids nothing collides, the file ends up holding two tables per meal,
 * and because the cook's shopping pseudo-entry is pushed BEFORE the one-pin
 * -per-slot guard, the cook silently buys and gets billed for every dinner
 * twice. Same id from both devices, and the merge is a no-op.
 * @param {string} brigadeId @param {string} date @param {string} slot
 */
export const brigadeTableId = (brigadeId, date, slot) => `b-${brigadeId}-${date}-${slot}`;

/**
 * Materialize a brigade's meals into ordinary tables for the given dates.
 *
 * Idempotent on (brigade, date, slot) via the deterministic id above, so ANY
 * member may generate: whoever gets there first fixes the week, and a second
 * device's write merges onto the same rows instead of duplicating them. The
 * `cookId` decides who SHOPS, not who is allowed to generate, otherwise
 * everyone else stares at empty dinner slots waiting on the cook.
 *
 * Regeneration REPLACES only this brigade's own future tables, and carries
 * every existing seat forward. That second half matters: seats hold
 * `status: "skipped"`, so rebuilding them from scratch would silently
 * un-decline someone who had already said they were out, and the cook would
 * shop and cook a portion nobody eats.
 * @param {HouseEvents} events
 * @param {Brigade} brigade
 * @param {{
 *   dates: string[],
 *   today: string,
 *   house: string,
 *   profilesById: Map<string, any>,
 *   targetsById: Map<string, any>,
 *   bankById: Map<string, any>,
 *   regenerate?: boolean
 * }} ctx
 * @returns {{ events: HouseEvents, made: number, thin: { slot: string, available: number }[] }}
 */
export function materializeBrigade(events, brigade, ctx) {
  if (!validBrigade(brigade)) return { events, made: 0, thin: [] };

  // ONE HOUSE. Members who have moved out stop counting, rechecked here every
  // time rather than trusted from when the brigade was created: Laurie goes
  // home after the visit and her seat must stop riding the cook's list.
  const members = brigade.memberIds
    .filter((id) => (ctx.profilesById.get(id)?.household ?? "home") === ctx.house)
    .map((id) => ({
      id,
      diet: ctx.targetsById.get(id)?.diet,
      avoid: ctx.targetsById.get(id)?.avoidIngredients,
      avoidRecipes: ctx.targetsById.get(id)?.avoidRecipes,
    }));
  if (members.length < 2) return { events, made: 0, thin: [] };

  const firstMember = members[0];
  if (!firstMember) return { events, made: 0, thin: [] };
  const cookId = members.some((m) => m.id === brigade.cookId) ? brigade.cookId : firstMember.id;
  // ROTATING COOKS (David, 2026-08-01: "each person is responsible for 1-2
  // dinners"): with `rotateCooks`, the cook cycles through the members in
  // memberIds order, one per calendar day from the brigade's start. Derived
  // from the DATE, never from a loop counter, so a regeneration run next
  // Wednesday assigns the same cooks the whole house already agreed to, and
  // two offline devices materialize identical tables (the id-keyed merge
  // depends on that).
  // whole days since the brigade began, UTC-parsed ISO dates so every device
  // in every timezone computes the same offset
  const dayOffset = (/** @type {string} */ date) =>
    Math.round((Date.parse(date) - Date.parse(brigade.from)) / 86400000);
  const cookFor = (/** @type {string} */ date) => {
    if (!brigade.rotateCooks || members.length === 0) return cookId;
    const at = ((dayOffset(date) % members.length) + members.length) % members.length;
    return (members[at] ?? firstMember).id;
  };
  const dates = ctx.dates
    .filter((d) => d >= brigade.from && d <= brigade.until)
    .filter((d) => d >= ctx.today) // day-aware: never touch a day already lived
    .sort();

  let tables = pruneTables(events, ctx.today).tables;
  /** @type {Map<string, TableEvent>} */
  const byId = new Map(tables.map((t) => [t.id, t]));
  /** @type {{ slot: string, available: number }[]} */
  const thin = [];
  let made = 0;

  for (const slot of brigade.slots) {
    const pool = brigadePool(ctx.bankById, members, slot);
    if (pool.length === 0) {
      thin.push({ slot, available: 0 });
      continue;
    }
    if (pool.length < dates.length) thin.push({ slot, available: pool.length });

    // the walk order is a deterministic SHUFFLE of the pool, keyed on
    // brigade+slot (David, 2026-08-01: "variety in the food"). The pool is
    // id-sorted, so a plain walk put beef-bulgogi-rice-bowl next to
    // beef-kofta-with-rice — near-identical dinners on consecutive nights.
    // Hash-ordering scatters cuisines while staying byte-identical on every
    // device and keeping the no-repeat-within-pool.length window.
    const walk = [...pool].sort(
      (a, b) =>
        hash(`${brigade.id}|${slot}|${a.id}`) - hash(`${brigade.id}|${slot}|${b.id}`) ||
        String(a.id).localeCompare(String(b.id)),
    );

    for (const date of dates) {
      const id = brigadeTableId(brigade.id, date, slot);
      const existing = byId.get(id);
      if (existing && !ctx.regenerate) continue; // idempotent: already set

      // STATELESS per-date pick (Tribunal 2026-08-01): the meal is a pure
      // function of (brigade, slot, date), never of which dates this RUN
      // happens to materialize. The old used-set walked the pool relative to
      // the run's date list, so a device generating on Wednesday picked
      // different meals than one that ran Monday — same deterministic ids,
      // DIFFERENT dinners, and the id-keyed merge silently swapped tonight's
      // meal after the cook had shopped for the other one. Anchoring on the
      // brigade+slot hash and walking by day offset repeats nothing within
      // pool.length days and is byte-identical on every device on every day.
      const meal =
        walk[
          (((hash(`${brigade.id}|${slot}`) + dayOffset(date)) % walk.length) + walk.length) %
            walk.length
        ];
      if (!meal) continue;

      // seats carry FORWARD on regeneration: a skip is a decision, not a
      // detail to rebuild away (Tribunal amendment A3). SERVINGS carry only
      // while the recipe is unchanged — 1.25 servings of a 500-kcal chili
      // carried onto an 1800-kcal dish would be a 2250-kcal plate and the
      // cook would shop for it; a new recipe recomputes from targets.
      const seats = members.map((m) => {
        const old = existing?.seats?.find((s) => s.id === m.id);
        const sameRecipe = existing?.recipeId === meal.id;
        const carried = sameRecipe ? old?.servings : undefined;
        // rawServings carries and recomputes UNDER THE SAME GATE as
        // servings (spec 10, loop-2 C2): carrying one while recomputing
        // the other trips the manual-override detector and silently
        // degrades the seat to sigma := s_p.
        const carriedRaw = sameRecipe ? /** @type {any} */ (old)?.rawServings : undefined;
        const rawExact = carriedRaw ?? seatServingsRaw(ctx.targetsById.get(m.id), slot, meal);
        // BOTH numbers derive from the SAME 3-decimal value (review 2b #4):
        // rounding raw after computing servings from the unrounded value
        // opens a ~0.2% window where the manual-override detector falsely
        // reclassifies an untouched seat as hand-edited, silently.
        const raw3 =
          rawExact === null || rawExact === undefined
            ? undefined
            : Math.round(rawExact * 1000) / 1000;
        const fromRaw =
          raw3 === undefined
            ? undefined
            : Math.min(BRIGADE_SERVINGS_MAX, Math.max(SERVINGS_MIN, Math.round(raw3 * 4) / 4));
        return {
          id: m.id,
          servings: carried ?? fromRaw ?? seatServingsFor(ctx.targetsById.get(m.id), slot, meal),
          ...(raw3 !== undefined ? { rawServings: raw3 } : {}),
          ...(old?.status ? { status: old.status } : {}),
        };
      });

      // fields that survive regeneration ONLY while the dish is unchanged
      // (per-person-plates-design §10): a cooked flag or an opt-out carried
      // onto a swapped meal would mark a dish cooked that never was, or
      // silently opt a new dish out of tailoring
      const sameDish = existing?.recipeId === meal.id;
      byId.set(id, {
        id,
        name: brigade.name,
        date,
        slot,
        recipeId: meal.id,
        seats,
        cookId: cookFor(date),
        // a grocery claim survives regeneration like a skip does: "I'm
        // buying Wednesday" is a decision, not a detail to rebuild away
        ...(existing?.buyerId ? { buyerId: existing.buyerId } : {}),
        // the tapped head is about PEOPLE, not the dish: it survives even a
        // dish swap (resolveHead re-validates presence at read time anyway)
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
  }

  tables = [...byId.values()];
  return { events: { ...events, tables }, made, thin };
}

/**
 * Add a brigade. Rejects anything validBrigade would drop, so a bad one can
 * never reach the file in the first place.
 * @param {HouseEvents} events
 * @param {Omit<Brigade, "id">} b
 * @param {string} today
 * @returns {HouseEvents}
 */
export function addBrigade(events, b, today) {
  // id is stamped LAST: the caller never supplies one, and spreading their
  // object over a generated id would let a stray `id: undefined` blank it
  const brigade = { ...b, id: genId() };
  if (!validBrigade(brigade)) return events;
  const cleaned = pruneTables(events, today);
  return { ...cleaned, brigades: [...(cleaned.brigades ?? []), brigade] };
}

/**
 * Remove a brigade AND every future table it materialized. Past meals stay:
 * they already happened, and the money ledger is entitled to them.
 * @param {HouseEvents} events
 * @param {string} id
 * @param {string} today
 * @returns {HouseEvents}
 */
export function removeBrigade(events, id, today) {
  const cleaned = pruneTables(events, today);
  return {
    ...cleaned,
    brigades: (cleaned.brigades ?? []).filter((b) => b.id !== id),
    tables: cleaned.tables.filter((t) => !(t.fromBrigade === id && t.date >= today)),
  };
}

/**
 * Drop tables past the retention window. Called by every CRUD write.
 * @param {HouseEvents} events
 * @param {string} today
 * @returns {HouseEvents}
 */
export function pruneTables(events, today) {
  const horizon = new Date(`${today}T12:00:00`);
  horizon.setDate(horizon.getDate() - RETAIN_PAST_DAYS);
  return {
    ...events,
    // malformed dates are pruned too: derivation skips them anyway, they
    // would only accumulate as permanent file residue
    tables: events.tables.filter(
      (t) =>
        typeof t.date === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(t.date) &&
        !Number.isNaN(+new Date(`${t.date}T12:00:00`)) &&
        new Date(`${t.date}T12:00:00`) >= horizon,
    ),
  };
}
