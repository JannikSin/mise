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

/** Tribunal amendment 2: servings clamp bounds. */
const SERVINGS_MIN = 0.5;
const SERVINGS_MAX = 10;

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
    typeof t.recipeId === "string" &&
    typeof t.date === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(t.date) &&
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
 *   myHouse: string,
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
      if (!recipe) continue; // unknown recipe: nothing honest to derive
      const live = t.seats.filter((s) => s.status !== "skipped");

      // cook rule: FIRST non-skipped seat whose profile lives in the
      // table's house shops the summed batch; everyone else buys nothing
      const cook = live.find((s) => {
        const p = ctx.profilesById?.get(s.id);
        const seatHouse = p?.household ?? "home";
        return seatHouse === house;
      });
      if (cook && cook.id === ctx.profileId) {
        const total = live.reduce((sum, s) => sum + clampServings(s.servings), 0);
        if (total > 0) cookExtras.push({ recipeId: t.recipeId, date: t.date, servings: total });
      }

      const mySeat = live.find((s) => s.id === ctx.profileId);
      if (!mySeat) continue;

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
      entries.push({
        id: `table-${t.id}`,
        table: t.id,
        date: t.date,
        slot: t.slot,
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
 * @returns {HouseEvents}
 */
export function patchSeat(events, tableId, profileId, patch) {
  return {
    ...events,
    tables: events.tables.map((t) =>
      t.id === tableId
        ? {
            ...t,
            seats: t.seats.map((s) =>
              s.id === profileId
                ? {
                    ...s,
                    ...patch,
                    ...(patch.servings != null ? { servings: clampServings(patch.servings) } : {}),
                  }
                : s,
            ),
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
    tables: events.tables.filter(
      (t) =>
        typeof t.date !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(t.date) ||
        new Date(`${t.date}T12:00:00`) >= horizon,
    ),
  };
}
