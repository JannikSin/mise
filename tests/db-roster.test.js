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
/**
 * A roster() row as the seam lane's adapter turns it into a 1.95 profiles.json
 * entry (mise-2-seam app/lib/backend/supabase-adapter.js rosterEntry).
 * @param {any} row
 */
function entry(row) {
  /** @type {Record<string, unknown>} */
  const out = { ...(row.roster ?? {}), id: row.id };
  for (const k of ["household", "family"]) if (row[k] != null) out[k] = row[k];
  if (row.admin === true) out.admin = true;
  return out;
}
/** @param {any} r */
const entries = (r) => r.profiles.map(entry);

test("the admin sees everyone but the probe, in the old order, with houses and families", { skip: SKIP }, async () => {
  const { db, uid } = await world();
  const r = await rosterAs(db, uid["owner-1"]);
  assert.deepEqual(ids(r), ["owner-1", "mate-1", "kin-1", "kin-2", "guest-1", "guest-2"]);
  assert.equal(rowOf(r, "kin-1").household, "house-f");
  assert.equal(rowOf(r, "kin-1").family, "house-f");
  assert.equal(rowOf(r, "owner-1").admin, true);
  assert.equal(rowOf(r, "mate-1").admin, false);
  assert.deepEqual(Object.keys(rowOf(r, "kin-1")).sort(), ["admin", "family", "household", "id", "roster"]);
  assert.deepEqual(rowOf(r, "kin-1").roster, { name: "Kin One" });
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
  assert.deepEqual(rowOf(r, "mate-1").roster, { name: "Mate" });
  await db.close();
});

const W = "select public.write_doc('profiles.json', $1::jsonb, $2) as rev";

test("a member renames themself; the rev bumps", { skip: SKIP }, async () => {
  const { db, uid } = await world();
  const r = await rosterAs(db, uid["mate-1"]);
  const rows = entries(r).map((/** @type {any} */ p) => (p.id === "mate-1" ? { ...p, name: "Mate Renamed" } : p));
  const out = await asUser(db, uid["mate-1"], () => db.query(W, [JSON.stringify({ profiles: rows }), r.rev]));
  assert.equal(out.rows[0].rev, 2);
  assert.equal(rowOf(await rosterAs(db, uid["owner-1"]), "mate-1").roster.name, "Mate Renamed");
  await db.close();
});

test("an unchanged write keeps the rev; a stale rev conflicts", { skip: SKIP }, async () => {
  const { db, uid } = await world();
  const r = await rosterAs(db, uid["mate-1"]);
  const same = await asUser(db, uid["mate-1"], () => db.query(W, [JSON.stringify({ profiles: entries(r) }), 1]));
  assert.equal(same.rows[0].rev, 1);
  const e = await asUser(db, uid["mate-1"], () => errorOf(() => db.query(W, [JSON.stringify({ profiles: entries(r) }), 7])));
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
    const rows = edit(entries(base));
    const e = await asUser(db, uid["mate-1"], () => errorOf(() => db.query(W, [JSON.stringify({ profiles: rows }), base.rev])));
    assert.equal(e?.code, "P0403", what);
  }
  // the admin may rename anyone visible, but not move houses through the app
  const adminView = await rosterAs(db, uid["owner-1"]);
  const merged = entries(adminView).map((/** @type {any} */ p) => (p.id === "mate-1" ? { ...p, name: "By admin" } : p));
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

test("plate_for: a plate by slug under plates_read's rules, never a uuid", { skip: SKIP }, async () => {
  const { db, uid } = await world();
  const q = "select public.plate_for($1) as p";
  /** @param {string} who @param {string} slug */
  const as = async (who, slug) => (await asUser(db, uid[who], () => db.query(q, [slug]))).rows[0].p;
  const p = await as("mate-1", "owner-1");
  assert.deepEqual(Object.keys(p).sort(), ["content_hash", "data", "legacy_sha", "rev"]);
  assert.equal(p.data.diet, "vegetarian");
  assert.equal("body" in p.data, false);
  assert.equal(p.rev, 1);
  assert.ok(await as("kin-1", "kin-2"), "the family house sees each other's plates");
  assert.ok(await as("owner-1", "kin-1"), "the admin sees every plate");
  assert.ok(await as("mate-1", "guest-1"), "a live guest");
  assert.equal(await as("mate-1", "kin-1"), null, "another house");
  assert.equal(await as("kin-1", "mate-1"), null, "another house");
  assert.equal(await as("kin-1", "guest-2"), null, "an expired guest");
  assert.equal(await as("guest-1", "owner-1"), null, "a guest sees only their own");
  assert.ok(await as("guest-1", "guest-1"));
  assert.equal(await as("mate-1", "nobody"), null);
  await db.close();
});

test("meta.json, guests.json and invites.json are server-only: writes refused, nothing to read", { skip: SKIP }, async () => {
  const { db, uid } = await world();
  for (const who of ["owner-1", "mate-1"]) {
    for (const path of ["meta.json", "guests.json", "invites.json"]) {
      for (const rev of [null, 1]) {
        const e = await asUser(db, uid[who], () => errorOf(() => db.query("select public.write_doc($1, '{}'::jsonb, $2)", [path, rev])));
        assert.equal(e?.code, "P0403", `${who} ${path} ${rev}`);
      }
      const n = (await asUser(db, uid[who], () => db.query("select count(*)::int n from public.docs where path = $1", [path]))).rows[0].n;
      assert.equal(n, 0);
    }
  }
  await db.close();
});
