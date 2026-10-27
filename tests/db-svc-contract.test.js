// Mise 2.0 db fix loop 1, item 9: the svc functions the Worker's svc.js marks
// [NEEDED], and public.whoami() for the app's session boot. Shapes as the
// Worker reads them; who may do what; service_role only.
import test from "node:test";
import assert from "node:assert/strict";
import { asRole, asUser, errorOf, SKIP } from "./_pglite.js";
import { world } from "./_world.js";

/** @param {any} db @param {string} sql @param {unknown[]} [params] */
async function svc(db, sql, params = []) {
  return (await asRole(db, "service_role", () => db.query(sql, params))).rows[0];
}

test("svc.whoami and public.whoami: who is asking, or null", { skip: SKIP }, async () => {
  const { db, uid } = await world();
  assert.deepEqual((await svc(db, "select svc.whoami($1) w", [uid["owner-1"]])).w, { slug: "owner-1", admin: true, houses: ["house-f", "house-w"] });
  assert.deepEqual((await svc(db, "select svc.whoami($1) w", [uid["mate-1"]])).w, { slug: "mate-1", admin: false, houses: ["house-w"] });
  assert.equal((await svc(db, "select svc.whoami(gen_random_uuid()) w")).w, null);
  const me = await asUser(db, uid["mate-1"], () => db.query("select public.whoami() w"));
  assert.deepEqual(me.rows[0].w, { slug: "mate-1", admin: false, home: "house-w" });
  const guest = await asUser(db, uid["guest-1"], () => db.query("select public.whoami() w"));
  assert.deepEqual(guest.rows[0].w, { slug: "guest-1", admin: false, home: null });
  // an account with no profile any more: null, no error (the app's confirmed revoke)
  await db.query("update public.profiles set user_id = null where slug = 'kin-2'");
  assert.equal((await asUser(db, uid["kin-2"], () => db.query("select public.whoami() w"))).rows[0].w, null);
  assert.match(String((await errorOf(() => asRole(db, "anon", () => db.query("select public.whoami()"))))?.message), /permission denied/);
  await db.close();
});

test("svc.cron_inputs: the root profile's plan, house events and shopping list", { skip: SKIP }, async () => {
  const { db } = await world();
  await db.exec(`update public.docs set data = '{"items":[{"name":"rice"}]}' where path = 'shopping.json';
    update public.docs set data = '{"tables":[{"id":"t1"}]}' where path = 'households/house-w/events.json';`);
  const a = (await svc(db, "select svc.cron_inputs('2026-W40', true) c")).c;
  assert.deepEqual(a, { profile: "owner-1", house: "house-w", plan: { week: "2026-W40", entries: [] }, events: { tables: [{ id: "t1" }] }, shopping: { items: [{ name: "rice" }] } });
  const b = (await svc(db, "select svc.cron_inputs('2026-W41', false) c")).c;
  assert.equal(b.plan, null);
  assert.equal(b.shopping, null);
  assert.equal((await svc(db, "select svc.cron_inputs('../x', false) c")).c.plan, null);
  await db.close();
});

test("svc.mint_invite: the admin, or an entitled member of that house; never a guest, a probe or a past expiry", { skip: SKIP }, async () => {
  const { db, uid } = await world();
  const mint = async (/** @type {string} */ who, /** @type {string} */ code, /** @type {string} */ house, interval = "1 day") =>
    (await svc(db, `select svc.mint_invite($1, $2, $3, now() + interval '${interval}') r`, [uid[who], code, house])).r;
  assert.equal(await mint("mate-1", "c1", "house-w"), "ok");
  assert.equal(await mint("mate-1", "c2", "house-f"), "forbidden", "not a member of that house");
  assert.equal(await mint("owner-1", "c3", "house-f"), "ok", "the admin");
  assert.equal(await mint("mate-1", "c1", "house-w"), "forbidden", "a code already used");
  assert.equal(await mint("mate-1", "c4", "house-w", "-1 minute"), "forbidden", "an expiry in the past");
  assert.equal(await mint("guest-1", "c5", "house-w"), "forbidden");
  assert.equal(await mint("probe-0a1b2c", "c6", "house-w"), "forbidden");
  assert.equal(await mint("mate-1", "c7", "nowhere"), "forbidden");
  await db.query("update public.profiles set entitled = false where slug = 'mate-1'");
  assert.equal(await mint("mate-1", "c8", "house-w"), "forbidden", "not entitled");
  const row = (await db.query("select h.slug, p.slug as by from public.invites i join public.households h on h.id = i.host_household join public.profiles p on p.id = i.created_by where code_hash = 'c1'")).rows[0];
  assert.deepEqual(row, { slug: "house-w", by: "mate-1" });
  await db.close();
});

test("svc.invite_get, then claim, then guest_login_add and guest_login_row", { skip: SKIP }, async () => {
  const { db, uid, pid } = await world();
  await svc(db, "select svc.mint_invite($1, 'cx', 'house-w', now() + interval '1 day')", [uid["mate-1"]]);
  const before = (await svc(db, "select svc.invite_get('cx') i")).i;
  assert.equal(before.host_house, "house-w");
  assert.equal(before.used_at, null);
  assert.equal(before.claimed, null);
  assert.equal(typeof before.expires_at, "string");
  assert.equal((await svc(db, "select svc.invite_get('nope') i")).i, null);
  const gid = (await svc(db, "select svc.claim_guest('cx', 'guest-n', '{\"name\":\"Guest N\"}', '{\"diet\":\"vegan\"}', '2999-01-01') id")).id;
  const after = (await svc(db, "select svc.invite_get('cx') i")).i;
  assert.equal(after.claimed, "guest-n");
  assert.equal(typeof after.used_at, "string");

  const add = async (/** @type {string} */ p, /** @type {string} */ key) => (await svc(db, "select svc.guest_login_add($1, $2, 's', 'h') r", [p, key])).r;
  assert.equal(await add(gid, "guest n"), true);
  assert.equal(await add(gid, "guest n2"), false, "one login per guest");
  assert.equal(await add(pid["guest-1"], "guest n"), false, "a taken name");
  assert.equal(await add(pid["mate-1"], "mate"), false, "members have no name login");
  assert.deepEqual((await svc(db, "select svc.guest_login_row('guest n') r")).r, { slug: "guest-n", salt: "s", hash: "h" });
  assert.equal((await svc(db, "select svc.guest_login_row('nobody') r")).r, null);
  await db.close();
});

test("svc.guest_view: a live grant only; names only of the guest's own co-diners", { skip: SKIP }, async () => {
  const { db, pid } = await world();
  const tables = [
    { id: "t1", seats: [{ id: "guest-1" }, { id: "mate-1" }] },
    { id: "t2", seats: [{ id: "owner-1" }] },
  ];
  await db.query("update public.docs set data = $1::jsonb where path = 'households/house-w/events.json'", [JSON.stringify({ tables })]);
  const v = (await svc(db, "select svc.guest_view('guest-1') v")).v;
  assert.deepEqual(v, { profile_id: pid["guest-1"], name: "Guest A", has_login: false, host_house: "house-w", tables, names: { "guest-1": "Guest A", "mate-1": "Mate" } });
  assert.equal((await svc(db, "select svc.guest_view('guest-2') v")).v, null, "a lapsed grant");
  assert.equal((await svc(db, "select svc.guest_view('mate-1') v")).v, null, "not a guest");
  assert.equal((await svc(db, "select svc.guest_view('nobody') v")).v, null);
  await db.close();
});

test("the new svc functions are service_role only", { skip: SKIP }, async () => {
  const { db, uid } = await world();
  for (const sql of ["select svc.whoami(gen_random_uuid())", "select svc.cron_inputs('2026-W40', true)", "select svc.guest_view('guest-1')", "select svc.invite_get('x')", "select svc.guest_login_row('x')"]) {
    const e = await errorOf(() => asUser(db, uid["mate-1"], () => db.query(sql)));
    assert.match(String(e?.message), /permission denied/, sql);
    const a = await errorOf(() => asRole(db, "anon", () => db.query(sql)));
    assert.match(String(a?.message), /permission denied/, sql);
  }
  await db.close();
});

test("negative control: a mint_invite without the house check, and a guest_view without the expiry, fail these checks", { skip: SKIP }, async () => {
  const { db, uid } = await world();
  await db.exec(`create or replace function svc.mint_invite(p_sub uuid, p_code_hash text, p_host_house text, p_expires_at timestamptz) returns text
    language sql volatile security definer set search_path = '' as $$
    insert into public.invites (code_hash, host_household, created_by, expires_at)
      select p_code_hash, h.id, p.id, p_expires_at from public.households h, public.profiles p where h.slug = p_host_house and p.user_id = p_sub
    returning 'ok' $$;
    create or replace function svc.guest_view(p_slug text) returns jsonb language sql stable security definer set search_path = '' as $$
    select jsonb_build_object('host_house', h.slug) from public.profiles p join public.guest_grants g on g.guest_profile = p.id
      join public.households h on h.id = g.host_household where p.slug = p_slug limit 1 $$;
    grant execute on all functions in schema svc to service_role;`);
  const r = (await svc(db, "select svc.mint_invite($1, 'n1', 'house-f', now() + interval '1 day') r", [uid["mate-1"]])).r;
  assert.notEqual(r, "forbidden", "the broken version lets a member of another house invite");
  assert.notEqual((await svc(db, "select svc.guest_view('guest-2') v")).v, null, "the broken version shows a lapsed guest");
  await db.close();
});
