// Mise 2.0 B2: the Worker's svc functions (plan section 4.2, ENG L2-5, RT N5).
// service_role only; a signed-in phone and anon cannot call them.
import test from "node:test";
import assert from "node:assert/strict";
import { asRole, asUser, errorOf, SKIP } from "./_pglite.js";
import { world, targetsFor } from "./_world.js";

/** @param {any} db @param {string} sql @param {unknown[]} [params] */
async function svc(db, sql, params = []) {
  return (await asRole(db, "service_role", () => db.query(sql, params))).rows[0];
}

test("svc is closed to signed-in phones and anon", { skip: SKIP }, async () => {
  const { db, uid } = await world();
  const e1 = await asUser(db, uid["owner-1"], () => errorOf(() => db.query("select svc.slug_free('x')")));
  assert.match(e1?.message ?? "", /permission denied/);
  const e2 = await asRole(db, "anon", () => errorOf(() => db.query("select svc.entitled(gen_random_uuid())")));
  assert.match(e2?.message ?? "", /permission denied/);
  const e3 = await asRole(db, "anon", () => errorOf(() => db.query("select public.roster()")));
  assert.match(e3?.message ?? "", /permission denied/);
  await db.close();
});

test("entitled: entitled members and the admin, never a probe or a stranger", { skip: SKIP }, async () => {
  const { db, uid } = await world();
  await db.exec("update public.profiles set entitled = false where slug in ('owner-1', 'kin-2')");
  const q = "select svc.entitled($1) as ok";
  assert.equal((await svc(db, q, [uid["mate-1"]])).ok, true);
  assert.equal((await svc(db, q, [uid["owner-1"]])).ok, true, "admin");
  assert.equal((await svc(db, q, [uid["kin-2"]])).ok, false);
  assert.equal((await svc(db, q, [uid["probe-0a1b2c"]])).ok, false);
  assert.equal((await svc(db, q, ["00000000-0000-0000-0000-000000000000"])).ok, false);
  await db.close();
});

test("ai_count counts today's calls per user", { skip: SKIP }, async () => {
  const { db, uid } = await world();
  assert.equal((await svc(db, "select svc.ai_count($1) as n", [uid["mate-1"]])).n, 1);
  assert.equal((await svc(db, "select svc.ai_count($1) as n", [uid["mate-1"]])).n, 2);
  assert.equal((await svc(db, "select svc.ai_count($1) as n", [uid["kin-1"]])).n, 1);
  await db.close();
});

test("recipe_for and recipe_names: bank, the house's own special, nothing else", { skip: SKIP }, async () => {
  const { db } = await world();
  const q = "select svc.recipe_for($1, $2) as r";
  assert.equal((await svc(db, q, ["house-w", "bank-soup"])).r.name, "Soup");
  assert.equal((await svc(db, q, ["house-w", "draft-stew"])).r, null, "staging");
  assert.equal((await svc(db, q, ["house-w", "house-00000000000a"])).r.name, "Shared house special");
  assert.equal((await svc(db, q, ["house-w", "house-00000000000f"])).r, null, "another house's special");
  assert.equal((await svc(db, q, ["house-w", "own-mate-1"])).r, null, "own recipes are not served");
  const names = (await svc(db, "select svc.recipe_names($1, $2) as n", ["house-f", ["bank-soup", "house-00000000000f", "house-00000000000a", "nope"]])).n;
  assert.deepEqual(names, { "bank-soup": "Soup", "house-00000000000f": "Family house special" });
  await db.close();
});

test("guest_summary returns a guest's own targets, never a member's", { skip: SKIP }, async () => {
  const { db, pid } = await world();
  const q = "select svc.guest_summary($1) as t";
  assert.equal((await svc(db, q, [pid["guest-1"]])).t.diet, "vegetarian");
  assert.equal((await svc(db, q, [pid["mate-1"]])).t, null);
  await db.close();
});

test("slug_free: no profile and no file under the slug", { skip: SKIP }, async () => {
  const { db } = await world();
  const q = "select svc.slug_free($1) as ok";
  assert.equal((await svc(db, q, ["new-guest"])).ok, true);
  assert.equal((await svc(db, q, ["mate-1"])).ok, false);
  assert.equal((await svc(db, q, ["Bad Slug"])).ok, false);
  assert.equal((await svc(db, q, ["guest-1"])).ok, false);
  await db.close();
});

test("claim_guest spends the invite once and makes the plate", { skip: SKIP }, async () => {
  const { db, house, pid, uid } = await world();
  await db.query(
    "insert into public.invites (code_hash, host_household, created_by, expires_at) values ('h1', $1, $2, now() + interval '1 day'), ('old', $1, $2, now() - interval '1 day')",
    [house["house-w"], pid["owner-1"]],
  );
  const q = "select svc.claim_guest($1, $2, $3::jsonb, $4::jsonb, $5::date) as id";
  const t = JSON.stringify(targetsFor("guest-n"));
  const id = (await svc(db, q, ["h1", "guest-n", '{"name":"Guest N"}', t, "2999-01-01"])).id;
  assert.ok(id);
  const docs = (await db.query("select path from public.docs where profile_id = $1 order by path", [id])).rows.map((/** @type {any} */ r) => r.path);
  assert.deepEqual(docs, ["profiles/guest-n/fitness/targets.json", "profiles/guest-n/profile/targets.json"]);
  const plate = (await db.query("select data from public.plates where profile_id = $1", [id])).rows[0].data;
  assert.equal(plate.diet, "vegetarian");
  assert.equal("body" in plate, false);
  // the shared house sees the new guest's plate; the family house does not
  const seen = await asUser(db, uid["mate-1"], () => db.query("select count(*)::int n from public.plates where profile_id = $1", [id]));
  assert.equal(seen.rows[0].n, 1);
  const unseen = await asUser(db, uid["kin-1"], () => db.query("select count(*)::int n from public.plates where profile_id = $1", [id]));
  assert.equal(unseen.rows[0].n, 0);
  // spent, expired and taken slugs refuse
  assert.equal((await asRole(db, "service_role", () => errorOf(() => db.query(q, ["h1", "guest-m", "{}", t, "2999-01-01"]))))?.code, "P0403");
  assert.equal((await asRole(db, "service_role", () => errorOf(() => db.query(q, ["old", "guest-m", "{}", t, "2999-01-01"]))))?.code, "P0403");
  await db.close();
});

test("guard_hits counts rows that show a hidden name, counts only", { skip: SKIP }, async () => {
  const { db } = await world();
  assert.deepEqual((await svc(db, "select svc.guard_hits() as h")).h, { docs: 0, recipes: 0, plates: 0 });
  // a term added after the fact (the guard runs on writes, the probe catches the rest)
  await db.exec("insert into private.guard_terms select 'soup', id from public.households where slug = 'house-w'");
  assert.deepEqual((await svc(db, "select svc.guard_hits() as h")).h, { docs: 0, recipes: 1, plates: 0 });
  await db.close();
});
