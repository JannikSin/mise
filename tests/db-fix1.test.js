// Mise 2.0 db fix loop 1: the Red Team's probes (scratchpad redteam-db
// probe1, probe2, probe3) as regression cases, each with a negative control
// that puts the old function back and shows the case would fail.
//   blocker 1 (F1): names after an escape, plurals, lookalikes, split strings, paths
//   blocker 2 (F2, F7): the plate keeps allergens; non-owners only make safety stricter
import test from "node:test";
import assert from "node:assert/strict";
import { asUser, errorOf, SKIP } from "./_pglite.js";
import { world, targetsFor } from "./_world.js";
import { planMigration, runMigration, verify, GateError } from "../tools/migrate-to-supabase.mjs";
import { PEOPLE, writeSnapshot } from "./_snapshot.js";
import { freshDb } from "./_pglite.js";
import { HITS } from "./_guard-corpus.js";

/** @param {any} db @param {string} uid @param {string} path @param {unknown} data @param {number | null} rev */
function writeAs(db, uid, path, data, rev) {
  return errorOf(() => asUser(db, uid, () => db.query("select public.write_doc($1, $2::jsonb, $3)", [path, JSON.stringify(data), rev])));
}
/** @param {any} db @param {string} path */
async function revOf(db, path) {
  return (await db.query("select rev from public.docs where path = $1", [path])).rows[0]?.rev ?? null;
}
/** @param {any} db @param {string} pid */
async function plateData(db, pid) {
  return (await db.query("select data from public.plates where profile_id = $1", [pid])).rows[0]?.data;
}

// ---- blocker 1 (F1), probe1 P2

test("P2: every F1 string written into a shared-house doc is refused", { skip: SKIP }, async () => {
  const { db, uid } = await world();
  const p = "households/house-w/events.json";
  for (const [name, data] of HITS.filter(([, , extra]) => extra === null)) {
    const e = await writeAs(db, uid["owner-1"], p, { tables: [], note: data }, await revOf(db, p));
    assert.equal(e?.code, "P0422", name);
  }
  // the bank, and an own recipe whose PATH carries the word
  for (const name of ["Soup\nkinword", "kіnword soup", "the Kinwords' soup"]) {
    const e = await writeAs(db, uid["owner-1"], "recipes/probe-x.json", { id: "probe-x", name }, null);
    assert.equal(e?.code, "P0422", name);
  }
  assert.equal((await writeAs(db, uid["owner-1"], "recipes/kinword-pie.json", { id: "kinword-pie", name: "Pie" }, null))?.code, "P0422");
  assert.equal((await writeAs(db, uid["mate-1"], "profiles/mate-1/recipes/kinword-lasagna.json", { id: "x" }, null))?.code, "P0422");
  // and the plain write still goes through
  assert.equal(await writeAs(db, uid["owner-1"], p, { tables: [], note: "lentils" }, await revOf(db, p)), null);
  await db.close();
});

// ---- blocker 2 (F2), probe1 P4, P4b, P4c, probe2 A, A2

/** probe1 P4: the owner writes a stale mirror; does the plate keep the canonical allergens? */
async function mirrorWriteKeepsAllergens(/** @type {any} */ db, /** @type {any} */ uid, /** @type {any} */ pid) {
  const p = "profiles/mate-1/fitness/targets.json";
  const stale = targetsFor("mate-1");
  delete (/** @type {any} */ (stale).allergens);
  delete (/** @type {any} */ (stale).avoidIngredients);
  const e = await writeAs(db, uid["mate-1"], p, stale, await revOf(db, p));
  assert.equal(e, null, "the owner may write their own mirror");
  const pl = await plateData(db, pid["mate-1"]);
  return JSON.stringify(pl.allergens) === '["peanut"]' && JSON.stringify(pl.avoidIngredients) === '["peanut","chicken"]';
}

test("P4: a stale mirror write leaves the plate's allergens as the canonical row says", { skip: SKIP }, async () => {
  const { db, uid, pid } = await world();
  assert.equal(await mirrorWriteKeepsAllergens(db, uid, pid), true);
  await db.close();
});

test("negative control: the old targets_after (plate from the last row written) fails P4", { skip: SKIP }, async () => {
  const { db, uid, pid } = await world();
  await db.exec(`create or replace function private.targets_after() returns trigger language plpgsql security definer set search_path = '' as $$
    declare v jsonb := private.plate_of(new.data);
    begin
      insert into public.plates (profile_id, data, content_hash) values (new.profile_id, v, '')
        on conflict (profile_id) do update set data = excluded.data where public.plates.data is distinct from excluded.data;
      return null;
    end $$;`);
  assert.equal(await mirrorWriteKeepsAllergens(db, uid, pid), false);
  await db.close();
});

/** probe1 P4b and probe2 A, A2: what a non-owner (the admin) may do to someone's safety keys. */
async function nonOwnerCannotLoosen(/** @type {any} */ db, /** @type {any} */ uid, /** @type {any} */ pid) {
  const c = "profiles/kin-1/profile/targets.json";
  const cur = targetsFor("kin-1", { slotAvoid: { breakfast: ["egg"] } });
  await db.query("update public.docs set data = $1::jsonb where path = $2", [JSON.stringify(cur), c]);
  const refused = [];
  for (const loose of [
    { ...cur, allergens: [] },
    { ...cur, avoidIngredients: null },
    { ...cur, avoidRecipes: [] },
    { ...cur, diet: "omnivore" },
    { ...cur, slotAvoid: {} },
  ]) {
    refused.push((await writeAs(db, uid["owner-1"], c, loose, await revOf(db, c)))?.code === "P0403");
  }
  // an INSERT of a missing mirror with fewer keys (probe2 A), by write_doc and directly (A2)
  await db.query("delete from public.docs where path = 'profiles/kin-2/fitness/targets.json'");
  refused.push((await writeAs(db, uid["owner-1"], "profiles/kin-2/fitness/targets.json", { macros: { calories: 2500 } }, null))?.code === "P0403");
  await db.query("delete from public.docs where path = 'profiles/kin-1/fitness/targets.json'");
  const direct = await errorOf(() => asUser(db, uid["owner-1"], () => db.query(`insert into public.docs (path, data) values ('profiles/kin-1/fitness/targets.json', '{"diet":"omnivore"}')`)));
  // fix loop 3 E3: no insert grant, so the direct form stops at the grant
  refused.push(direct?.code === "42501");
  const pl1 = await plateData(db, pid["kin-1"]);
  const pl2 = await plateData(db, pid["kin-2"]);
  return refused.every(Boolean) && JSON.stringify(pl1.allergens) === '["peanut"]' && JSON.stringify(pl2.allergens) === '["peanut"]';
}

test("P4b, A, A2: a non-owner, the admin included, cannot loosen a safety key on update or insert", { skip: SKIP }, async () => {
  const { db, uid, pid } = await world();
  assert.equal(await nonOwnerCannotLoosen(db, uid, pid), true);
  await db.close();
});

test("negative control: with the safety check stubbed out, P4b fails", { skip: SKIP }, async () => {
  const { db, uid, pid } = await world();
  await db.exec(`create or replace function private.safety_loosened(prev jsonb, nxt jsonb) returns boolean language sql immutable as $$ select false $$;`);
  assert.equal(await nonOwnerCannotLoosen(db, uid, pid), false);
  await db.close();
});

test("stricter is always allowed: the admin adds an allergen and tightens the diet; the owner may loosen their own", { skip: SKIP }, async () => {
  const { db, uid, pid } = await world();
  const c = "profiles/kin-1/profile/targets.json";
  const cur = targetsFor("kin-1");
  assert.equal(await writeAs(db, uid["owner-1"], c, { ...cur, diet: "vegan", allergens: ["peanut", "sesame"], allergensFreeText: "and shellfish" }, await revOf(db, c)), null);
  assert.deepEqual((await plateData(db, pid["kin-1"])).allergens, ["peanut", "sesame"]);
  assert.equal((await writeAs(db, uid["owner-1"], c, { ...cur, diet: "vegan", allergens: ["peanut", "sesame"], allergensFreeText: "" }, await revOf(db, c)))?.code, "P0403", "free text may not lose words");
  assert.equal(await writeAs(db, uid["kin-1"], c, { ...cur, diet: "omnivore", allergens: [] }, await revOf(db, c)), null);
  assert.deepEqual((await plateData(db, pid["kin-1"])).allergens, []);
  await db.close();
});

test("P4c: the root profile's slug-form path is the root row, never a second canonical row", { skip: SKIP }, async () => {
  const { db, uid, pid } = await world();
  const before = await plateData(db, pid["owner-1"]);
  const e = await writeAs(db, uid["owner-1"], "profiles/owner-1/profile/targets.json", { macros: { calories: 2000 } }, null);
  assert.equal(e?.code, "P0409", "a create over the existing root row is a conflict");
  assert.equal((await db.query("select count(*)::int n from public.docs where kind = 'targets' and profile_id = $1", [pid["owner-1"]])).rows[0].n, 1);
  assert.deepEqual(await plateData(db, pid["owner-1"]), before);
  // an update by the slug form edits the root row
  const t = targetsFor("owner-1", { phase: "cut" });
  assert.equal(await writeAs(db, uid["owner-1"], "profiles/owner-1/profile/targets.json", t, 1), null);
  assert.equal((await db.query("select data->>'phase' p from public.docs where path = 'profile/targets.json'")).rows[0].p, "cut");
  // and a direct insert by the slug form lands on the root path (and conflicts)
  const direct = await errorOf(() => db.query(`insert into public.docs (path, data) values ('profiles/owner-1/shopping.json', '{}')`));
  assert.match(String(direct?.message), /duplicate key/);
  await db.close();
});

// ---- the migration (probe3)

test("probe3: the migration refuses a stale mirror and a bank recipe naming someone after a newline or as a plural", () => {
  const stale = writeSnapshot((f) => {
    const m = /** @type {any} */ ({ ...(/** @type {any} */ (f["profiles/mate-1/fitness/targets.json"])) });
    delete m.allergens;
    delete m.avoidIngredients;
    f["profiles/mate-1/fitness/targets.json"] = m;
  });
  assert.throws(() => planMigration(stale, PEOPLE), (e) => e instanceof GateError && e.gate === "targets-mirror" && !/mate/.test(e.message));
  for (const recipe of [
    { id: "chili", name: "Chili", steps: ["Brown the beans.\nKinword likes it hot."] },
    { id: "chili", name: "Chili", note: "the Kinwords' favourite" },
  ]) {
    const dir = writeSnapshot((f) => (f["recipes/chili.json"] = recipe));
    assert.throws(() => planMigration(dir, PEOPLE), (e) => e instanceof GateError && e.gate === "scrub");
  }
  // F5: a roster display name carrying a hidden word
  const roster = writeSnapshot((f) => {
    const p = /** @type {any} */ (f["profiles.json"]);
    p.profiles[1] = { ...p.profiles[1], name: "Kinword" };
  });
  assert.throws(() => planMigration(roster, PEOPLE), (e) => e instanceof GateError && e.gate === "name-guard");
});

test("verify: every plate equals plateOf(canonical); a plate_of that drops allergens fails it", { skip: SKIP }, async () => {
  const db = await freshDb();
  const plan = planMigration(writeSnapshot(), PEOPLE);
  const out = await runMigration(db, plan);
  assert.equal(out.checks.find((c) => c.check === "plate equals plateOf(canonical)")?.ok, true);
  // negative control: a broken projection, then any targets write refreshes the plates
  await db.exec(`alter function private.plate_of(jsonb) rename to plate_of_real;
    create function private.plate_of(t jsonb) returns jsonb language sql immutable set search_path = '' as $$ select private.plate_of_real(t) - 'allergens' $$;
    update public.docs set data = data || '{"x": 1}' where kind = 'targets';`);
  const checks = await verify(db, plan);
  assert.equal(checks.find((c) => c.check === "plate equals plateOf(canonical)")?.ok, false);
  await db.close();
});
