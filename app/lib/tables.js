// Tables: shared meals (docs/tables-design.md v2, Tribunal-gated).
// A table lives ONLY in its house's households/<h>/events.json; every
// profile's app DERIVES virtual pinned entries from it at read time — no
// cross-profile writes, ever. Cancel/edit = one file edit, propagates on
// the next sync tick. Derived entries are NEVER persisted into a plan file
// (main.js strips `e.table` before every plan write).
import { recipeConflicts, SLOT_KEYS } from "./plan.js";

/**
 * @typedef {{ id: string, servings: number, status?: "in" | "skipped" }} Seat seat id = profileId
 * @typedef {{ id: string, name: string, date: string, slot: string, recipeId: string, seats: Seat[] }} TableEvent
 * @typedef {{ tables: TableEvent[] }} HouseEvents
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
    // S3 (brigades) is unbuilt; carry the key through UNTOUCHED so a
    // hand-prototyped brigades array is never silently deleted by a table
    // CRUD write round-tripping this normalized object
    ...(raw?.brigades !== undefined ? { brigades: raw.brigades } : {}),
  };
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
  return known.find((s) => (profilesById.get(s.id)?.household ?? "home") === house) ?? null;
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
 *  - `cookExtras`: if I am the cook (first non-skipped seat whose house is
 *    the table's house), pseudo-entries for deriveShoppingList carrying the
 *    summed NON-skipped servings, dated so the fromDate filter drops past
 *    tables.
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
 *   bankById: Map<string, any>,
 *   ownEntries: Record<string, any>[],
 *   today: string,
 *   profilesById?: Map<string, any>
 * }} ctx
 * @returns {{
 *   entries: Record<string, any>[],
 *   conflicts: { table: TableEvent, reasons: string[] }[],
 *   collisions: TableEvent[],
 *   cookExtras: { recipeId: string, date: string, servings: number }[]
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
  // collision = only DELIBERATE own entries (pinned or OUT), per amendment
  // 4: "pinning your own meal is how a guest declines". A generated unpinned
  // meal never blocks a table — the view displaces it and the next generate
  // clears it.
  const takenSlots = new Set(
    ctx.ownEntries.filter((e) => e.pinned || e.out).map((e) => `${e.date}|${e.slot}`),
  );
  /** slots already filled by an earlier valid table (one pin per slot) */
  const derivedSlots = new Set();
  const horizon = new Date(`${ctx.today}T12:00:00`);
  horizon.setDate(horizon.getDate() - RETAIN_PAST_DAYS);

  for (const { house, events } of houses) {
    for (const t of events.tables) {
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
      if (cook && cook.id === ctx.profileId && recipe) {
        const total = known.reduce((sum, s) => sum + clampServings(s.servings), 0);
        if (total > 0) cookExtras.push({ recipeId: t.recipeId, date: t.date, servings: total });
      }

      const mySeat = live.find((s) => s.id === ctx.profileId);
      if (!mySeat) continue;

      if (!recipe) {
        // a table on a non-bank recipe (someone's personal variant) has no
        // honest macros for anyone else — surface it, never silently no-op
        // a family dinner out of existence (Red Team F4)
        conflicts.push({ table: t, reasons: ["recipe not in the shared bank"] });
        continue;
      }

      const reasons = recipeConflicts(recipe, ctx.diet, ctx.avoid);
      if (reasons.length > 0) {
        conflicts.push({ table: t, reasons });
        continue; // no pin, no macros — never a backdoor around the screen
      }
      const key = `${t.date}|${t.slot}`;
      if (takenSlots.has(key)) {
        collisions.push(t); // my own entry wins; pinning my own meal = declining
        continue;
      }
      if (derivedSlots.has(key)) continue; // one derived pin per slot
      derivedSlots.add(key);

      const servings = clampServings(mySeat.servings);
      const n = recipe.nutrition ?? {};
      const knownTotal = known.reduce((sum, s2) => sum + clampServings(s2.servings), 0);
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
        freeText: `🍽 ${t.name || recipe.name}`,
        servings,
        pinned: true,
        estCalories: Math.round((n.calories ?? 0) * servings),
        estProtein: Math.round((n.protein ?? 0) * servings),
      });
    }
  }
  return { entries, conflicts, collisions, cookExtras };
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
