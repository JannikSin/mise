// Mise 2.0 db fix loop 1, items 3 to 7 and 10 (Red Team F4, F5, F6, F9;
// worker gate E1), each a probe as a regression case. The negative controls
// put back the function exactly as the earlier migration file wrote it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { asRole, asUser, errorOf, SKIP } from "./_pglite.js";
import { world, targetsFor } from "./_world.js";

/** The text of `create function <name>` from an earlier migration file, as create or replace. */
function oldFunction(/** @type {string} */ file, /** @type {string} */ name) {
  const sql = readFileSync(new URL(`../supabase/migrations/${file}`, import.meta.url), "utf8");
  const start = sql.indexOf(`create function ${name}(`);
  assert.ok(start >= 0, name);
  const end = sql.indexOf("end $$;", start) + "end $$;".length;
  return "create or replace " + sql.slice(start + "create ".length, end);
}
const B2 = "20261028090000_b2_writer_plate_roster_svc.sql";
const G1 = "20261030090000_g1_pending_links.sql";

// ---- F4 (probe1 P10)

/** A bare, unconfirmed account for the admin's address: does it become admin? */
async function unconfirmedTakesOver(/** @type {any} */ db, /** @type {any} */ pid) {
  await db.exec(`insert into private.settings values ('admin_profile', 'owner-1') on conflict (key) do update set value = excluded.value;
    update public.profiles set user_id = null where slug = 'owner-1';
    delete from public.admins;`);
  await db.query("insert into private.pending_links values ('admin-x@example.invalid', $1)", [pid["owner-1"]]);
  await db.exec("insert into auth.users (email) values ('ADMIN-X@example.invalid')");
  return (await db.query("select count(*)::int n from public.admins")).rows[0].n > 0;
}

test("F4: an unconfirmed account links nothing; confirming it links and makes the admin", { skip: SKIP }, async () => {
  const { db, pid } = await world();
  assert.equal(await unconfirmedTakesOver(db, pid), false);
  assert.equal((await db.query("select user_id from public.profiles where slug = 'owner-1'")).rows[0].user_id, null);
  await db.exec("update auth.users set email_confirmed_at = now() where email = 'ADMIN-X@example.invalid'");
  assert.equal((await db.query("select count(*)::int n from public.admins")).rows[0].n, 1);
  await db.close();
});

test("negative control: the G1 link_pending (no confirmation check) fails F4", { skip: SKIP }, async () => {
  const { db, pid } = await world();
  await db.exec(oldFunction(G1, "private.link_pending"));
  assert.equal(await unconfirmedTakesOver(db, pid), true);
  await db.close();
});

// ---- F5 (probe1 P3)

/** mate-1 renames itself to a word hidden from its own house. */
async function rosterNameRefused(/** @type {any} */ db, /** @type {any} */ uid) {
  const e = await errorOf(() =>
    asUser(db, uid["mate-1"], async () => {
      const cur = (await db.query("select public.roster() r")).rows[0].r;
      const mine = cur.profiles.find((/** @type {any} */ x) => x.id === "mate-1");
      const next = { profiles: [{ id: "mate-1", ...mine.roster, name: "Kinwords", household: mine.household, family: mine.family, admin: mine.admin }] };
      return db.query("select public.write_doc('profiles.json', $1::jsonb, $2)", [JSON.stringify(next), cur.rev]);
    }),
  );
  return e?.code === "P0422";
}

test("F5: a roster display name carrying a hidden word is refused; a guest's too", { skip: SKIP }, async () => {
  const { db, uid, house, pid } = await world();
  assert.equal(await rosterNameRefused(db, uid), true);
  await db.query("insert into public.invites (code_hash, host_household, created_by, expires_at) values ('c', $1, $2, now() + interval '1 hour')", [house["house-w"], pid["owner-1"]]);
  const e = await errorOf(() => asRole(db, "service_role", () => db.query("select svc.claim_guest('c', 'guest-k', '{\"name\":\"Kіnword\"}', '{}', '2999-01-01')")));
  assert.equal(e?.code, "P0422");
  assert.equal((await db.query("select used_at from public.invites where code_hash = 'c'")).rows[0].used_at, null, "nothing spent");
  // a clean claim sets status_until (item 12)
  await asRole(db, "service_role", () => db.query("select svc.claim_guest('c', 'guest-k', '{\"name\":\"Guest K\"}', '{}', '2999-01-01')"));
  const inv = (await db.query("select status_until > now() + interval '59 days' as ok from public.invites where code_hash = 'c'")).rows[0];
  assert.equal(inv.ok, true);
  await db.close();
});

test("negative control: the B2 patch_roster (no guard) fails F5", { skip: SKIP }, async () => {
  const { db, uid } = await world();
  await db.exec(oldFunction(B2, "private.patch_roster"));
  assert.equal(await rosterNameRefused(db, uid), false);
  await db.close();
});

// ---- F6 (probe1 P5)

test("F6: a member cannot call the private helpers about another house", { skip: SKIP }, async () => {
  const { db, uid, house, pid } = await world();
  for (const sql of [
    ["select private.guard_hit('\"mateword\"'::jsonb, array[$1::uuid])", [house["house-f"]]],
    ["select private.houses_of($1)", [pid["kin-1"]]],
    ["select private.doc_scope('households/house-f/events.json')", []],
    ["select private.audience('plan', $1, null)", [pid["kin-1"]]],
    ["select private.plate_of('{}'::jsonb)", []],
  ]) {
    const e = await errorOf(() => asUser(db, uid["mate-1"], () => db.query(/** @type {string} */ (sql[0]), /** @type {unknown[]} */ (sql[1]))));
    assert.match(String(e?.message), /permission denied/, String(sql[0]));
  }
  // and the app's own paths still work for them
  const rev = (await db.query("select rev from public.docs where path = 'profiles/mate-1/shopping.json'")).rows[0].rev;
  assert.equal(await errorOf(() => asUser(db, uid["mate-1"], () => db.query("select public.write_doc('profiles/mate-1/shopping.json', '{\"items\":[]}'::jsonb, $1)", [rev]))), null);
  await db.close();
});

// ---- item 10 (worker gate E1): every svc function, granted by name

test("item 10: every svc function is executable by service_role only; public.whoami by authenticated only", { skip: SKIP }, async () => {
  const { db } = await world();
  const fns = (await db.query("select p.oid::regprocedure::text as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'svc' order by 1")).rows.map((/** @type {any} */ r) => r.f);
  assert.ok(fns.length >= 15, fns.join(", "));
  for (const f of fns) {
    const r = (await db.query("select has_function_privilege('service_role', $1, 'execute') s, has_function_privilege('authenticated', $1, 'execute') a, has_function_privilege('anon', $1, 'execute') n", [f])).rows[0];
    assert.deepEqual(r, { s: true, a: false, n: false }, f);
  }
  const w = (await db.query("select has_function_privilege('authenticated', 'public.whoami()', 'execute') a, has_function_privilege('anon', 'public.whoami()', 'execute') n")).rows[0];
  assert.deepEqual(w, { a: true, n: false });
  await db.close();
});

// ---- item 8: a non-admin member of two houses and the guard

test("item 8: a member of both houses, not the admin: their plan reaches both, so either house's hidden word is refused", { skip: SKIP }, async () => {
  const { db } = await world();
  await db.exec(`
    insert into auth.users (email, email_confirmed_at) values ('both-1@example.invalid', now());
    insert into public.profiles (slug, user_id, kind, home_household, roster)
      select 'both-1', u.id, 'member', h.id, '{"name":"Both"}' from auth.users u, public.households h
       where u.email = 'both-1@example.invalid' and h.slug = 'house-w';
    insert into public.memberships select p.id, h.id from public.profiles p, public.households h where p.slug = 'both-1';
    insert into public.docs (path, data) values ('profiles/both-1/plans/2026-W40.json', '{"week":"2026-W40","entries":[]}');`);
  const u = (await db.query("select user_id from public.profiles where slug = 'both-1'")).rows[0].user_id;
  const write = (/** @type {string} */ path, /** @type {unknown} */ data, /** @type {number | null} */ rev) =>
    errorOf(() => asUser(db, u, () => db.query("select public.write_doc($1, $2::jsonb, $3)", [path, JSON.stringify(data), rev])));
  assert.equal((await write("profiles/both-1/plans/2026-W40.json", { note: "kinword" }, 1))?.code, "P0422");
  assert.equal((await write("profiles/both-1/plans/2026-W40.json", { note: "mateword" }, 1))?.code, "P0422");
  // a house file reaches one house only: the other house's word is fine there
  assert.equal(await write("households/house-f/events.json", { tables: [], note: "kinword" }, 1), null);
  assert.equal((await write("households/house-w/events.json", { tables: [], note: "kinword" }, 1))?.code, "P0422");
  // and they see both houses' plates, never anyone's full targets
  const seen = await asUser(db, u, () => db.query("select count(*)::int n from public.docs where kind = 'targets'"));
  assert.equal(seen.rows[0].n, 0);
  const plates = await asUser(db, u, () => db.query("select count(*)::int n from public.plates"));
  assert.equal(plates.rows[0].n, 5, "owner, mate, kin-1, kin-2 and the live guest of house-w");
  void targetsFor;
  await db.close();
});

test("negative control: the B2 schema-wide grant to authenticated fails F6", { skip: SKIP }, async () => {
  const { db, uid, pid } = await world();
  await db.exec("grant execute on all functions in schema private to authenticated");
  assert.equal(await errorOf(() => asUser(db, uid["mate-1"], () => db.query("select private.houses_of($1)", [pid["kin-1"]]))), null);
  await db.close();
});
