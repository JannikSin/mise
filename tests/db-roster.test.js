// Mise 2.0 B2: public.roster() and profiles.json writes (plan section 4.2,
// RT N2, B4). Who appears, which house and family they show, and what a
// phone may change.
import test from "node:test";
import assert from "node:assert/strict";
import { asUser, errorOf, SKIP } from "./_pglite.js";
import { world } from "./_world.js";

/** @param {any} db @param {string} uid */
async function rosterAs(db, uid) {
  return (await asUser(db, uid, () => db.query("select public.roster() as r"))).rows[0].r;
}
/** @param {any} r */
const ids = (r) => r.profiles.map((/** @type {any} */ p) => p.id);
/** @param {any} r @param {string} id */
const rowOf = (r, id) => r.profiles.find((/** @type {any} */ p) => p.id === id);

test("the admin sees everyone but the probe, in the old order, with houses and families", { skip: SKIP }, async () => {
  const { db, uid } = await world();
  const r = await rosterAs(db, uid["owner-1"]);
  assert.deepEqual(ids(r), ["owner-1", "mate-1", "kin-1", "kin-2", "guest-1", "guest-2"]);
  assert.equal(rowOf(r, "kin-1").household, "house-f");
  assert.equal(rowOf(r, "kin-1").family, "house-f");
  assert.equal(rowOf(r, "owner-1").admin, true);
  assert.equal("admin" in rowOf(r, "mate-1"), false);
  assert.equal(rowOf(r, "kin-1").name, "Kin One");
  assert.equal(r.rev, 1);
  await db.close();
});

test("a shared-house member sees housemates and live guests only, no family", { skip: SKIP }, async () => {
  const { db, uid } = await world();
  const r = await rosterAs(db, uid["mate-1"]);
  assert.deepEqual(ids(r), ["owner-1", "mate-1", "guest-1"]);
  for (const p of r.profiles) assert.equal(p.family, null, p.id);
  assert.equal(rowOf(r, "owner-1").household, "house-w");
  // a guest belongs to no house
  assert.equal(rowOf(r, "guest-1").household, null);
  await db.close();
});

test("a family-house member sees the family and the admin; the admin's home house is hidden", { skip: SKIP }, async () => {
  const { db, uid } = await world();
  const r = await rosterAs(db, uid["kin-1"]);
  assert.deepEqual(ids(r), ["owner-1", "kin-1", "kin-2"]);
  assert.equal(rowOf(r, "kin-2").family, "house-f");
  // owner-1's home is house-w, which kin-1 is not in: null, never a slug
  assert.equal(rowOf(r, "owner-1").household, null);
  await db.close();
});

test("a guest sees only themself; the probe sees its house minus itself", { skip: SKIP }, async () => {
  const { db, uid } = await world();
  assert.deepEqual(ids(await rosterAs(db, uid["guest-1"])), ["guest-1"]);
  assert.deepEqual(ids(await rosterAs(db, uid["probe-0a1b2c"])), ["owner-1", "mate-1", "guest-1"]);
  await db.close();
});

test("no passkey hash ever leaves the roster", { skip: SKIP }, async () => {
  const { db, uid } = await world();
  await db.exec(`update public.profiles set roster = roster || '{"passkey":{"salt":"s","hash":"h"},"adminKey":"k"}' where slug = 'mate-1'`);
  const r = await rosterAs(db, uid["owner-1"]);
  assert.equal("passkey" in rowOf(r, "mate-1"), false);
  assert.equal("adminKey" in rowOf(r, "mate-1"), false);
  await db.close();
});

const W = "select public.write_doc('profiles.json', $1::jsonb, $2) as rev";

test("a member renames themself; the rev bumps", { skip: SKIP }, async () => {
  const { db, uid } = await world();
  const r = await rosterAs(db, uid["mate-1"]);
  rowOf(r, "mate-1").name = "Mate Renamed";
  const out = await asUser(db, uid["mate-1"], () => db.query(W, [JSON.stringify({ profiles: r.profiles }), r.rev]));
  assert.equal(out.rows[0].rev, 2);
  assert.equal(rowOf(await rosterAs(db, uid["owner-1"]), "mate-1").name, "Mate Renamed");
  await db.close();
});

test("an unchanged write keeps the rev; a stale rev conflicts", { skip: SKIP }, async () => {
  const { db, uid } = await world();
  const r = await rosterAs(db, uid["mate-1"]);
  const same = await asUser(db, uid["mate-1"], () => db.query(W, [JSON.stringify({ profiles: r.profiles }), 1]));
  assert.equal(same.rows[0].rev, 1);
  const e = await asUser(db, uid["mate-1"], () => errorOf(() => db.query(W, [JSON.stringify({ profiles: r.profiles }), 7])));
  assert.equal(e?.code, "P0409");
  await db.close();
});

test("refused: another person's row, a new row, a house move, a family, an admin flag", { skip: SKIP }, async () => {
  const { db, uid } = await world();
  const base = await rosterAs(db, uid["mate-1"]);
  /** @type {[string, (rows: any[]) => any[]][]} */
  const edits = [
    ["other row", (rows) => rows.map((p) => (p.id === "owner-1" ? { ...p, name: "x" } : p))],
    ["new row", (rows) => [...rows, { id: "intruder", name: "x" }]],
    ["hidden row", (rows) => [...rows, { id: "kin-1", name: "Kin One" }]],
    ["house move", (rows) => rows.map((p) => (p.id === "mate-1" ? { ...p, household: "house-f" } : p))],
    ["family", (rows) => rows.map((p) => (p.id === "mate-1" ? { ...p, family: "house-f" } : p))],
    ["admin", (rows) => rows.map((p) => (p.id === "mate-1" ? { ...p, admin: true } : p))],
  ];
  for (const [what, edit] of edits) {
    const rows = edit(structuredClone(base.profiles));
    const e = await asUser(db, uid["mate-1"], () => errorOf(() => db.query(W, [JSON.stringify({ profiles: rows }), base.rev])));
    assert.equal(e?.code, "P0403", what);
  }
  // the admin may rename anyone visible, but not move houses through the app
  const ok = structuredClone(base.profiles).map((/** @type {any} */ p) => (p.id === "mate-1" ? { ...p, name: "By admin" } : p));
  const adminView = await rosterAs(db, uid["owner-1"]);
  const merged = adminView.profiles.map((/** @type {any} */ p) => ok.find((/** @type {any} */ o) => o.id === p.id && p.id === "mate-1") ?? p);
  const out = await asUser(db, uid["owner-1"], () => db.query(W, [JSON.stringify({ profiles: merged }), adminView.rev]));
  assert.equal(out.rows[0].rev, 2);
  await db.close();
});

test("clients have no grant on the people tables", { skip: SKIP }, async () => {
  const { db, uid } = await world();
  for (const t of ["profiles", "households", "memberships", "admins", "roster_rev", "guest_grants", "invites", "guest_logins", "ai_usage"]) {
    const e = await asUser(db, uid["owner-1"], () => errorOf(() => db.query(`select * from public.${t}`)));
    assert.match(e?.message ?? "", /permission denied/, t);
  }
  for (const t of ["private.settings", "private.guard_terms", "private.pending_links"]) {
    const e = await asUser(db, uid["owner-1"], () => errorOf(() => db.query(`select * from ${t}`)));
    assert.match(e?.message ?? "", /permission denied/, t);
  }
  await db.close();
});
