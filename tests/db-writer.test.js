// Mise 2.0 B2: public.write_doc, the one client write path (plan section 4.2,
// ENG 2, ENG L2-2, RT N4). Run as `authenticated` with a stubbed auth.uid().
import test from "node:test";
import assert from "node:assert/strict";
import { asUser, errorOf, SKIP } from "./_pglite.js";
import { world, targetsFor } from "./_world.js";

const W = "select public.write_doc($1, $2::jsonb, $3) as rev";

/** @param {any} db @param {string} path */
async function revOf(db, path) {
  return (await db.query("select rev from public.docs where path = $1", [path])).rows[0]?.rev ?? null;
}

test("a member edits their own plan with the current rev", { skip: SKIP }, async () => {
  const { db, uid } = await world();
  const r = await asUser(db, uid["mate-1"], () => db.query(W, ["profiles/mate-1/plans/2026-W40.json", '{"week":"2026-W40","entries":[1]}', 1]));
  assert.equal(r.rows[0].rev, 2);
  await db.close();
});

test("stale rev is conflict", { skip: SKIP }, async () => {
  const { db, uid } = await world();
  await asUser(db, uid["mate-1"], () => db.query(W, ["profiles/mate-1/shopping.json", '{"items":[1]}', 1]));
  const e = await asUser(db, uid["mate-1"], () => errorOf(() => db.query(W, ["profiles/mate-1/shopping.json", '{"items":[2]}', 1])));
  assert.equal(e?.code, "P0409");
  // a create over an existing row is a conflict too (it takes the merge path)
  const e2 = await asUser(db, uid["mate-1"], () => errorOf(() => db.query(W, ["profiles/mate-1/shopping.json", '{"items":[2]}', null])));
  assert.equal(e2?.code, "P0409");
  await db.close();
});

test("hidden row is forbidden, same as absent", { skip: SKIP }, async () => {
  const { db, uid } = await world();
  // mate-1 (shared house) and the family house: an existing row and a missing one answer alike
  const hidden = await asUser(db, uid["mate-1"], () => errorOf(() => db.query(W, ["households/house-f/events.json", "{}", 1])));
  const absent = await asUser(db, uid["mate-1"], () => errorOf(() => db.query(W, ["households/house-f/ledger.json", "{}", null])));
  const kinTargets = await asUser(db, uid["mate-1"], () => errorOf(() => db.query(W, ["profiles/kin-1/profile/targets.json", "{}", 1])));
  const bad = await asUser(db, uid["mate-1"], () => errorOf(() => db.query(W, ["../etc.json", "{}", null])));
  for (const e of [hidden, absent, kinTargets, bad]) {
    assert.equal(e?.code, "P0403");
    assert.equal(e?.message, "mise_forbidden");
  }
  assert.equal(await revOf(db, "households/house-f/events.json"), 1);
  await db.close();
});

test("housemates may write each other's plan, never each other's targets", { skip: SKIP }, async () => {
  const { db, uid } = await world();
  const ok = await asUser(db, uid["kin-2"], () => db.query(W, ["profiles/kin-1/plans/2026-W40.json", '{"week":"2026-W40","entries":[]}', 1]));
  assert.equal(ok.rows[0].rev, 2);
  const e = await asUser(db, uid["kin-2"], () => errorOf(() => db.query(W, ["profiles/kin-1/fitness/targets.json", JSON.stringify(targetsFor("kin-1")), 1])));
  assert.equal(e?.code, "P0403");
  await db.close();
});

test("admin partial targets write refused", { skip: SKIP }, async () => {
  const { db, uid } = await world();
  const partial = { diet: "vegan", macros: { calories: 2000, protein: 120 } };
  const e = await asUser(db, uid["owner-1"], () => errorOf(() => db.query(W, ["profiles/kin-1/profile/targets.json", JSON.stringify(partial), 1])));
  assert.equal(e?.code, "P0403");
  // and the table directly: no update grant since fix loop 3 E3 (write_doc is the only door)
  const e2 = await asUser(db, uid["owner-1"], () =>
    errorOf(() => db.query("update public.docs set data = $1 where path = 'profiles/kin-1/profile/targets.json'", [JSON.stringify(partial)])),
  );
  assert.equal(e2?.code, "42501");
  // a full write that keeps every key is allowed
  const full = { ...targetsFor("kin-1"), diet: "vegan" };
  const ok = await asUser(db, uid["owner-1"], () => db.query(W, ["profiles/kin-1/profile/targets.json", JSON.stringify(full), 1]));
  assert.equal(ok.rows[0].rev, 2);
  await db.close();
});

test("owner may drop a targets key", { skip: SKIP }, async () => {
  const { db, uid } = await world();
  const t = /** @type {Record<string, unknown>} */ (targetsFor("kin-1"));
  delete t.goalWeightLb;
  const ok = await asUser(db, uid["kin-1"], () => db.query(W, ["profiles/kin-1/profile/targets.json", JSON.stringify(t), 1]));
  assert.equal(ok.rows[0].rev, 2);
  await db.close();
});

test("family name in a shared-house-readable plan refused", { skip: SKIP }, async () => {
  const { db, uid } = await world();
  const data = JSON.stringify({ week: "2026-W40", entries: [{ note: "Cooking with Kinword" }] });
  // owner-1 belongs to house-w too, so their plan reaches it
  const e = await asUser(db, uid["owner-1"], () => errorOf(() => db.query(W, ["plans/2026-W40.json", data, 1])));
  assert.equal(e?.code, "P0422");
  const e2 = await asUser(db, uid["mate-1"], () => errorOf(() => db.query(W, ["households/house-w/events.json", data, 1])));
  assert.equal(e2?.code, "P0422");
  await db.close();
});

test("family name in a family-only file allowed", { skip: SKIP }, async () => {
  const { db, uid } = await world();
  const data = JSON.stringify({ week: "2026-W40", entries: [{ note: "Cooking with Kinword" }] });
  const r1 = await asUser(db, uid["kin-1"], () => db.query(W, ["profiles/kin-1/plans/2026-W40.json", data, 1]));
  const r2 = await asUser(db, uid["kin-1"], () => db.query(W, ["households/house-f/events.json", data, 1]));
  assert.equal(r1.rows[0].rev, 2);
  assert.equal(r2.rows[0].rev, 2);
  await db.close();
});

test("any name in the bank refused", { skip: SKIP }, async () => {
  const { db, uid } = await world();
  for (const term of ["kinword", "mateword"]) {
    const e = await asUser(db, uid["owner-1"], () =>
      errorOf(() => db.query(W, [`recipes/dish-${term}.json`, JSON.stringify({ id: `dish-${term}`, name: `${term} chili` }), null])),
    );
    assert.equal(e?.code, "P0422", term);
  }
  await db.close();
});

test("chamomile and cardamom pass", { skip: SKIP }, async () => {
  const { db, uid } = await world();
  await db.exec(`insert into private.guard_terms select t, id from public.households, unnest(array['cam','mom']) t where slug = 'house-w'`);
  const r = await asUser(db, uid["owner-1"], () =>
    db.query(W, ["recipes/tea.json", JSON.stringify({ id: "tea", name: "Chamomile tea with cardamom, Momofuku style" }), null]),
  );
  assert.equal(r.rows[0].rev, 1);
  await db.close();
});

test("only the admin writes the bank; staging moves by path", { skip: SKIP }, async () => {
  const { db, uid } = await world();
  const e = await asUser(db, uid["mate-1"], () => errorOf(() => db.query(W, ["recipes/new.json", '{"id":"new"}', null])));
  assert.equal(e?.code, "P0403");
  const r = await asUser(db, uid["owner-1"], () => db.query(W, ["recipes/draft-stew.json", '{"id":"draft-stew","name":"Stew"}', 1]));
  assert.equal(r.rows[0].rev, 2);
  const staging = (await db.query("select staging from public.recipes where id = 'draft-stew'")).rows[0].staging;
  assert.equal(staging, false);
  await db.close();
});

test("a signed-in phone cannot forge kind, owner or rev through the table", { skip: SKIP }, async () => {
  const { db, uid, pid } = await world();
  const e = await asUser(db, uid["mate-1"], () =>
    errorOf(() => db.query("insert into public.docs (path, data, kind, profile_id) values ('profiles/mate-1/occasions.json', '{}', 'global', $1)", [pid["kin-1"]])),
  );
  assert.match(e?.message ?? "", /permission denied/);
  const e2 = await asUser(db, uid["mate-1"], () => errorOf(() => db.query("update public.docs set rev = 1 where path = 'profiles/mate-1/shopping.json'")));
  assert.match(e2?.message ?? "", /permission denied/);
  await db.close();
});
