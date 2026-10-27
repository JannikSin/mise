// Mise 2.0 B1: private.doc_scope and its JS mirror (app/lib/doc-scope.js) give
// the same answer for every path shape mise-data holds (plan section 4, ENG 1).
// Made-up slugs only: house-a, house-b, owner-1, member-2, guest-3.
import test from "node:test";
import assert from "node:assert/strict";
import { docScope, audienceOf, BadPathError } from "../app/lib/doc-scope.js";
import { freshDb, SKIP } from "./_pglite.js";

const WORLD = {
  households: ["house-a", "house-b"],
  profiles: ["owner-1", "member-2", "guest-3"],
  rootProfile: "owner-1",
};

/** [path, kind, profile, household] or [path, null] for a refusal. */
const CASES = /** @type {[string, string | null, (string | null)?, (string | null)?][]} */ ([
  // bank and roster are not docs rows: write_doc routes them first
  ["recipes/test-noodle-bowl.json", null],
  ["recipes-staging/new-dish.json", null],
  ["profiles.json", null],
  ["prices.json", null],
  ["pins.json", null],
  ["meta.json", null],
  ["invites.json", null],
  ["guests.json", null],
  // global
  ["philosophies/whole-food.json", "global", null, null],
  ["philosophies/Bad.json", null],
  // house files
  ["households/house-a/events.json", "events", null, "house-a"],
  ["households/house-a/ledger.json", "ledger", null, "house-a"],
  ["households/house-a/pantry.json", "pantry", null, "house-a"],
  ["households/house-a/pantry-notes.json", "pantry-notes", null, "house-a"],
  ["households/house-b/waste.json", "waste", null, "house-b"],
  ["households/house-b/household.json", "household", null, "house-b"],
  ["households/house-b/prices.json", "prices", null, "house-b"],
  ["households/house-b/pins.json", "pins", null, "house-b"],
  ["households/house-z/events.json", null],
  ["households/house-a/notes.json", null],
  // house specials: opaque ids only (item 7)
  ["households/house-a/recipes/house-0123456789ab.json", "house_recipe", null, "house-a"],
  ["households/house-a/recipes/house-0123456789a.json", null],
  ["households/house-a/recipes/chili.json", null],
  // the root profile's files
  ["plans/2026-W28.json", "plan", "owner-1", null],
  ["plans/2026-28.json", null],
  ["profile/targets.json", "targets", "owner-1", null],
  ["shopping.json", "shopping", "owner-1", null],
  ["occasions.json", "occasions", "owner-1", null],
  ["pantry.json", "pantry", "owner-1", null],
  ["profile/notes.json", null],
  // root fitness and health stay on GitHub (the composite lane)
  ["fitness/targets.json", null],
  ["fitness/daily.json", null],
  ["health/vitals.json", null],
  // everyone else under profiles/<slug>/
  ["profiles/member-2/profile/targets.json", "targets", "member-2", null],
  ["profiles/member-2/fitness/targets.json", "targets", "member-2", null],
  ["profiles/member-2/fitness/daily.json", "health", "member-2", null],
  ["profiles/member-2/health/vitals.json", "health", "member-2", null],
  ["profiles/member-2/plans/2026-W40.json", "plan", "member-2", null],
  ["profiles/member-2/shopping.json", "shopping", "member-2", null],
  ["profiles/member-2/occasions.json", "occasions", "member-2", null],
  ["profiles/member-2/pantry.json", "pantry", "member-2", null],
  ["profiles/member-2/recipes/lentil-soup.json", "own_recipe", "member-2", null],
  ["profiles/guest-3/profile/targets.json", "targets", "guest-3", null],
  ["profiles/nobody/shopping.json", null],
  ["profiles/member-2/meta.json", null],
  ["profiles/member-2/recipes/sub/x.json", null],
  // malformed
  ["../shopping.json", null],
  ["plans//2026-W28.json", null],
  ["plans/../profile/targets.json", null],
  ["/shopping.json", null],
  ["shopping.txt", null],
  ["", null],
  [`profiles/member-2/recipes/${"a".repeat(200)}.json`, null],
]);

test("JS doc scope: every case", () => {
  for (const [p, kind, profile, household] of CASES) {
    if (kind === null) {
      assert.throws(() => docScope(p, WORLD), BadPathError, p);
    } else {
      assert.deepEqual(docScope(p, WORLD), { kind, profile, household }, p);
    }
  }
});

test("JS doc scope: no root profile set refuses the root files", () => {
  assert.throws(() => docScope("shopping.json", { ...WORLD, rootProfile: null }), BadPathError);
});

test("JS audience: house rows reach their house, food files reach the owner's houses", () => {
  const housesOf = (/** @type {string} */ s) => (s === "owner-1" ? ["house-a", "house-b"] : []);
  assert.deepEqual(audienceOf(docScope("households/house-b/events.json", WORLD), housesOf), ["house-b"]);
  assert.deepEqual(audienceOf(docScope("plans/2026-W28.json", WORLD), housesOf), ["house-a", "house-b"]);
  assert.equal(audienceOf(docScope("profile/targets.json", WORLD), housesOf), null);
  assert.equal(audienceOf(docScope("philosophies/whole-food.json", WORLD), housesOf), null);
});

test("SQL doc_scope matches the JS mirror on every case", { skip: SKIP }, async () => {
  const db = await freshDb();
  await db.exec(`
    insert into public.households (slug) values ('house-a'), ('house-b');
    insert into public.profiles (slug) values ('owner-1'), ('member-2'), ('guest-3');
    insert into private.settings values ('root_profile', 'owner-1');`);
  for (const [p] of CASES) {
    /** @type {any} */
    let sql;
    try {
      const r = await db.query(
        `select s.kind, p.slug as profile, h.slug as household
           from private.doc_scope($1) s
           left join public.profiles p on p.id = s.profile_id
           left join public.households h on h.id = s.household_id`,
        [p],
      );
      sql = r.rows[0];
    } catch (e) {
      assert.match(String(/** @type {any} */ (e).message), /mise_bad_path/, p);
      sql = null;
    }
    /** @type {any} */
    let js;
    try {
      js = docScope(p, WORLD);
    } catch {
      js = null;
    }
    assert.deepEqual(sql, js, p);
  }
  await db.close();
});
