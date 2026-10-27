// A made-up world for the Mise 2.0 database tests (not a test file). No real
// person: two houses, an admin who belongs to both, a housemate, two members
// of the "family" house, two guests and a probe.
//
//   house-w  ("the shared house"):   owner-1 (admin, home here), mate-1, probe-0a1b2c
//   house-f  ("the family house"):   owner-1, kin-1, kin-2      (family = "house-f")
//   guest-1: guest, live grant to house-w;  guest-2: guest, grant to house-f expired
//
// Guard terms: "kinword" is hidden from house-w, "mateword" from house-f.
import { freshDb } from "./_pglite.js";

export const PEOPLE = /** @type {const} */ ([
  "owner-1",
  "mate-1",
  "kin-1",
  "kin-2",
  "guest-1",
  "guest-2",
  "probe-0a1b2c",
]);

/** A full targets document with plate and owner-only keys. */
export function targetsFor(/** @type {string} */ who, extra = {}) {
  return {
    diet: "vegetarian",
    allergens: ["peanut"],
    allergensFreeText: "",
    avoidIngredients: ["peanut", "chicken"],
    avoidRecipes: ["never-again"],
    phase: "gain",
    macros: { calories: 3000, protein: 160, fat: 90, carbs: 380, waterLiters: 3 },
    mealSlots: ["breakfast", "lunch", "dinner"],
    currencies: [{ id: "swipes", name: "Dining swipes", unit: "swipe", perWeek: 7, expires: "weekly", venue: "buffet", estProtein: 60 }],
    weeklyBudgetUsd: 80,
    body: { sex: "m", age: 30, heightIn: 70, weightLb: 170 },
    goalWeightLb: 180,
    supplementPlan: [{ id: "fishOil" }],
    targetReason: `secret reason of ${who}`,
    ...extra,
  };
}

/**
 * A fresh database holding the world, as superuser (the migration's view).
 * @returns {Promise<{ db: any, uid: Record<string, string>, pid: Record<string, string>, house: Record<string, string> }>}
 */
export async function world() {
  const db = await freshDb();
  await db.exec(`
    insert into public.households (slug) values ('house-w'), ('house-f');
    insert into auth.users (email) select p || '@example.invalid' from unnest(array[${PEOPLE.map((p) => `'${p}'`).join(",")}]) p;
    insert into public.profiles (slug, user_id, kind, home_household, family, roster, entitled, sort_order)
      select v.slug, u.id, v.kind, h.id, v.family, v.roster::jsonb, true, v.ord
        from (values
          ('owner-1', 'member', 'house-w', null, '{"name":"Owner"}', 1),
          ('mate-1', 'member', 'house-w', null, '{"name":"Mate"}', 2),
          ('kin-1', 'member', 'house-f', 'house-f', '{"name":"Kin One"}', 3),
          ('kin-2', 'member', 'house-f', 'house-f', '{"name":"Kin Two"}', 4),
          ('guest-1', 'guest', null, null, '{"name":"Guest A"}', 5),
          ('guest-2', 'guest', null, null, '{"name":"Guest B"}', 6),
          ('probe-0a1b2c', 'probe', 'house-w', null, '{"name":"probe"}', 7)
        ) v(slug, kind, home, family, roster, ord)
        join auth.users u on u.email = v.slug || '@example.invalid'
        left join public.households h on h.slug = v.home;
    insert into public.memberships
      select p.id, h.id from public.profiles p, public.households h
       where (p.slug, h.slug) in (('owner-1','house-w'), ('owner-1','house-f'), ('mate-1','house-w'),
                                  ('kin-1','house-f'), ('kin-2','house-f'), ('probe-0a1b2c','house-w'));
    insert into public.admins select user_id from public.profiles where slug = 'owner-1';
    insert into public.guest_grants
      select p.id, h.id, v.until::date from (values ('guest-1','house-w', '2999-01-01'), ('guest-2','house-f', '2000-01-01')) v(g, h, until)
      join public.profiles p on p.slug = v.g join public.households h on h.slug = v.h;
    insert into private.settings values ('root_profile', 'owner-1');
    insert into private.guard_terms select 'kinword', id from public.households where slug = 'house-w';
    insert into private.guard_terms select 'mateword', id from public.households where slug = 'house-f';
  `);
  /** @type {Record<string, string>} */
  const uid = {};
  /** @type {Record<string, string>} */
  const pid = {};
  for (const r of (await db.query("select slug, user_id, id from public.profiles")).rows) {
    uid[r.slug] = r.user_id;
    pid[r.slug] = r.id;
  }
  /** @type {Record<string, string>} */
  const house = {};
  for (const r of (await db.query("select slug, id from public.households")).rows) house[r.slug] = r.id;

  // one of each kind of file, superuser writes (the migration)
  /** @type {[string, unknown][]} */
  const files = [
    ["profile/targets.json", targetsFor("owner-1")],
    ["plans/2026-W40.json", { week: "2026-W40", entries: [] }],
    ["shopping.json", { items: [] }],
    ["households/house-w/events.json", { tables: [] }],
    ["households/house-w/pantry.json", { items: [] }],
    ["households/house-w/recipes/house-00000000000a.json", { id: "house-00000000000a", name: "Shared house special" }],
    ["households/house-f/events.json", { tables: [] }],
    ["households/house-f/recipes/house-00000000000f.json", { id: "house-00000000000f", name: "Family house special" }],
    ["philosophies/whole-food.json", { id: "whole-food" }],
    ["profiles/owner-1/fitness/daily.json", { days: [] }],
  ];
  for (const p of ["mate-1", "kin-1", "kin-2", "guest-1", "guest-2"]) {
    files.push([`profiles/${p}/profile/targets.json`, targetsFor(p)]);
    files.push([`profiles/${p}/fitness/targets.json`, targetsFor(p)]);
    files.push([`profiles/${p}/plans/2026-W40.json`, { week: "2026-W40", entries: [] }]);
    files.push([`profiles/${p}/shopping.json`, { items: [] }]);
    files.push([`profiles/${p}/health/vitals.json`, { readings: [] }]);
    files.push([`profiles/${p}/recipes/own-${p}.json`, { id: `own-${p}` }]);
  }
  for (const [path, data] of files) {
    await db.query("insert into public.docs (path, data, legacy_sha) values ($1, $2, $3)", [path, JSON.stringify(data), `sha-${path}`]);
  }
  await db.exec(`
    insert into public.recipes (id, data) values ('bank-soup', '{"id":"bank-soup","name":"Soup"}');
    insert into public.recipes (id, data, staging) values ('draft-stew', '{"id":"draft-stew","name":"Stew"}', true);`);
  return { db, uid, pid, house };
}
