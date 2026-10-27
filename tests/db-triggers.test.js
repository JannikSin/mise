// Mise 2.0 B1: the row triggers (plan section 4.2, items 10 and 13, RT N4).
// The server, not the client, decides a row's kind and owner; rev bumps on
// every table; the name guard runs on every write whoever makes it.
// Made-up slugs and terms only.
import test from "node:test";
import assert from "node:assert/strict";
import { freshDb, errorOf, SKIP } from "./_pglite.js";

async function seeded() {
  const db = await freshDb();
  await db.exec(`
    insert into public.households (slug) values ('house-a'), ('house-b');
    insert into public.profiles (slug) values ('owner-1'), ('member-2');
    insert into private.settings values ('root_profile', 'owner-1');
    insert into public.memberships
      select p.id, h.id from public.profiles p, public.households h
       where (p.slug, h.slug) in (('owner-1','house-a'), ('owner-1','house-b'), ('member-2','house-b'));
    insert into private.guard_terms
      select 'zorblat', id from public.households where slug = 'house-a';`);
  return db;
}

/** @param {any} db @param {string} path */
async function row(db, path) {
  const r = await db.query(
    `select d.kind, d.rev, d.legacy_sha, d.doc_id, p.slug as profile, h.slug as household
       from public.docs d left join public.profiles p on p.id = d.profile_id
       left join public.households h on h.id = d.household_id where d.path = $1`,
    [path],
  );
  return r.rows[0];
}

test("docs insert: kind and owner come from the path, never the client", { skip: SKIP }, async () => {
  const db = await seeded();
  const other = (await db.query("select id from public.profiles where slug = 'member-2'")).rows[0].id;
  await db.query(
    `insert into public.docs (path, data, kind, profile_id, rev) values ('shopping.json', '{}', 'global', $1, 99)`,
    [other],
  );
  const r = await row(db, "shopping.json");
  assert.equal(r.kind, "shopping");
  assert.equal(r.profile, "owner-1");
  assert.equal(r.rev, 1);
  assert.equal(await errorOf(() => db.query(`insert into public.docs (path, data) values ('notes/x.json', '{}')`)).then((e) => /mise_bad_path/.test(e?.message ?? "")), true);
  await db.close();
});

test("docs update: path, kind, owner and legacy sha are pinned; rev bumps", { skip: SKIP }, async () => {
  const db = await seeded();
  await db.exec(`insert into public.docs (path, data, legacy_sha) values ('households/house-b/events.json', '{"tables":[]}', 'abc123')`);
  const before = await row(db, "households/house-b/events.json");
  await db.exec(`update public.docs set data = '{"tables":[1]}', kind = 'global', household_id = null,
                   legacy_sha = 'zzz', doc_id = gen_random_uuid() where path = 'households/house-b/events.json'`);
  const after = await row(db, "households/house-b/events.json");
  assert.equal(after.kind, "events");
  assert.equal(after.household, "house-b");
  assert.equal(after.legacy_sha, "abc123");
  assert.equal(after.doc_id, before.doc_id);
  assert.equal(after.rev, 2);
  await db.close();
});

test("recipes: rev bumps, doc_id and legacy sha stay", { skip: SKIP }, async () => {
  const db = await seeded();
  await db.exec(`insert into public.recipes (id, data, legacy_sha) values ('soup', '{"id":"soup"}', 's1')`);
  const a = (await db.query("select rev, doc_id from public.recipes")).rows[0];
  await db.exec(`update public.recipes set data = '{"id":"soup","name":"Soup"}', legacy_sha = 'x', doc_id = gen_random_uuid()`);
  const b = (await db.query("select rev, doc_id, legacy_sha from public.recipes")).rows[0];
  assert.equal(a.rev, 1);
  assert.equal(b.rev, 2);
  assert.equal(b.doc_id, a.doc_id);
  assert.equal(b.legacy_sha, "s1");
  await db.close();
});

test("plates: content hash is the server's, rev bumps, legacy sha stays", { skip: SKIP }, async () => {
  const db = await seeded();
  const pid = (await db.query("select id from public.profiles where slug = 'member-2'")).rows[0].id;
  await db.query(`insert into public.plates (profile_id, data, content_hash, legacy_sha) values ($1, '{"diet":"vegan"}', 'forged', 'g1')`, [pid]);
  const a = (await db.query("select rev, content_hash from public.plates")).rows[0];
  assert.equal(a.rev, 1);
  assert.notEqual(a.content_hash, "forged");
  await db.exec(`update public.plates set data = '{"diet":"omnivore"}', legacy_sha = null`);
  const b = (await db.query("select rev, content_hash, legacy_sha from public.plates")).rows[0];
  assert.equal(b.rev, 2);
  assert.notEqual(b.content_hash, a.content_hash);
  assert.equal(b.legacy_sha, "g1");
  await db.close();
});

test("name guard: a term hidden from a house is refused in that house's rows only", { skip: SKIP }, async () => {
  const db = await seeded();
  const bad = '{"note":"Zorblat is coming"}';
  // house-a may not see it
  const e1 = await errorOf(() => db.query(`insert into public.docs (path, data) values ('households/house-a/events.json', $1)`, [bad]));
  assert.equal(e1?.code, "P0422");
  // owner-1 belongs to house-a, so their plan reaches house-a
  const e2 = await errorOf(() => db.query(`insert into public.docs (path, data) values ('plans/2026-W30.json', $1)`, [bad]));
  assert.equal(e2?.code, "P0422");
  // house-b and member-2 (house-b only) are fine
  await db.query(`insert into public.docs (path, data) values ('households/house-b/events.json', $1)`, [bad]);
  await db.query(`insert into public.docs (path, data) values ('profiles/member-2/plans/2026-W30.json', $1)`, [bad]);
  await db.close();
});

test("name guard: the bank and the global files refuse every term", { skip: SKIP }, async () => {
  const db = await seeded();
  const e1 = await errorOf(() => db.query(`insert into public.recipes (id, data) values ('pie', '{"id":"pie","from":"zorblat"}')`));
  assert.equal(e1?.code, "P0422");
  const e2 = await errorOf(() => db.query(`insert into public.docs (path, data) values ('philosophies/whole-food.json', '{"by":"ZORBLAT"}')`));
  assert.equal(e2?.code, "P0422");
  await db.close();
});

test("name guard is whole-word: a term inside a longer word passes", { skip: SKIP }, async () => {
  const db = await seeded();
  await db.exec(`insert into private.guard_terms select 'cam', id from public.households where slug = 'house-a'`);
  await db.exec(`insert into public.recipes (id, data) values ('tea', '{"id":"tea","name":"chamomile and cardamom"}')`);
  const e = await errorOf(() => db.query(`insert into public.recipes (id, data) values ('tea2', '{"id":"tea2","name":"for cam"}')`));
  assert.equal(e?.code, "P0422");
  await db.close();
});
