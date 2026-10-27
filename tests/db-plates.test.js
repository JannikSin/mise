// Mise 2.0 B3: plates are made by the server from either targets path, by any
// writer, and their rev moves only when the card changes (plan section 4.2,
// items 3, 8, 10, 13).
import test from "node:test";
import assert from "node:assert/strict";
import { asRole, asUser, errorOf, SKIP } from "./_pglite.js";
import { world, targetsFor } from "./_world.js";

/** @param {any} db @param {string} pid */
async function plate(db, pid) {
  return (await db.query("select data, rev, legacy_sha, content_hash from public.plates where profile_id = $1", [pid])).rows[0];
}

test("svc insert makes a plate", { skip: SKIP }, async () => {
  const { db, house, pid } = await world();
  await db.query("insert into public.invites (code_hash, host_household, created_by, expires_at) values ('c', $1, $2, now() + interval '1 hour')", [house["house-w"], pid["owner-1"]]);
  const id = (await asRole(db, "service_role", () =>
    db.query("select svc.claim_guest('c', 'guest-z', '{}'::jsonb, $1::jsonb, '2999-01-01') as id", [JSON.stringify(targetsFor("guest-z"))]),
  )).rows[0].id;
  const p = await plate(db, id);
  assert.equal(p.data.diet, "vegetarian");
  assert.equal(p.rev, 1);
  await db.close();
});

test("the migration's insert makes a plate carrying the canonical file's git sha", { skip: SKIP }, async () => {
  const { db, pid } = await world();
  const p = await plate(db, pid["mate-1"]);
  assert.equal(p.legacy_sha, "sha-profiles/mate-1/profile/targets.json");
  assert.equal(p.rev, 1);
  assert.equal("goalWeightLb" in p.data, false);
  await db.close();
});

test("mirror-only write refreshes the plate", { skip: SKIP }, async () => {
  const { db, uid, pid } = await world();
  const t = targetsFor("kin-1", { diet: "vegan" });
  await asUser(db, uid["kin-1"], () => db.query("select public.write_doc('profiles/kin-1/fitness/targets.json', $1::jsonb, 1)", [JSON.stringify(t)]));
  const p = await plate(db, pid["kin-1"]);
  assert.equal(p.data.diet, "vegan");
  assert.equal(p.rev, 2);
  await db.close();
});

test("unchanged projection keeps plate rev", { skip: SKIP }, async () => {
  const { db, uid, pid } = await world();
  const before = await plate(db, pid["kin-1"]);
  // an owner-only edit: weight and a reason; the card is the same
  const t = targetsFor("kin-1", { goalWeightLb: 999, targetReason: "changed" });
  await asUser(db, uid["kin-1"], () => db.query("select public.write_doc('profiles/kin-1/profile/targets.json', $1::jsonb, 1)", [JSON.stringify(t)]));
  const after = await plate(db, pid["kin-1"]);
  assert.equal(after.rev, before.rev);
  assert.equal(after.content_hash, before.content_hash);
  assert.equal(after.legacy_sha, before.legacy_sha);
  await db.close();
});

test("plate rev bumps on change, and the legacy sha stays", { skip: SKIP }, async () => {
  const { db, uid, pid } = await world();
  const before = await plate(db, pid["kin-1"]);
  const t = targetsFor("kin-1", { macros: { calories: 2500, protein: 140 } });
  await asUser(db, uid["kin-1"], () => db.query("select public.write_doc('profiles/kin-1/profile/targets.json', $1::jsonb, 1)", [JSON.stringify(t)]));
  const after = await plate(db, pid["kin-1"]);
  assert.equal(after.rev, before.rev + 1);
  assert.notEqual(after.content_hash, before.content_hash);
  assert.equal(after.legacy_sha, before.legacy_sha);
  await db.close();
});

test("a plate that would show a hidden name is refused with the targets write", { skip: SKIP }, async () => {
  const { db, uid } = await world();
  // owner-1's plate reaches house-w, where "kinword" is hidden
  const t = targetsFor("owner-1", { avoidRecipes: ["kinword-pie"] });
  const e = await asUser(db, uid["owner-1"], () => errorOf(() => db.query("select public.write_doc('profile/targets.json', $1::jsonb, 1)", [JSON.stringify(t)])));
  assert.equal(e?.code, "P0422");
  // the same name in an owner-only field is fine: it never reaches the plate
  const ok = targetsFor("owner-1", { targetReason: "kinword said so" });
  const r = await asUser(db, uid["owner-1"], () => db.query("select public.write_doc('profile/targets.json', $1::jsonb, 1) as rev", [JSON.stringify(ok)]));
  assert.equal(r.rows[0].rev, 2);
  await db.close();
});

test("no client can write a plate", { skip: SKIP }, async () => {
  const { db, uid, pid } = await world();
  const e = await asUser(db, uid["owner-1"], () => errorOf(() => db.query("update public.plates set data = '{}' where profile_id = $1", [pid["mate-1"]])));
  assert.match(e?.message ?? "", /permission denied/);
  const e2 = await asUser(db, uid["mate-1"], () => errorOf(() => db.query("insert into public.plates (profile_id, data, content_hash) values ($1, '{}', '')", [pid["mate-1"]])));
  assert.match(e2?.message ?? "", /permission denied/);
  await db.close();
});
