// Mise 2.0 B3: the policy go/no-go (plan section 8, Tue 10/27). Every person
// in the made-up world reads and writes the database under SET ROLE
// authenticated with a stubbed auth.uid(), and what they reach is compared,
// row by row, with an oracle written from the rules (decision 1: plate cards
// for everyone, the family house included; full profiles for the admin only).
//
// The NEGATIVE CONTROL is the point of the suite: a deliberately leaky policy
// is added, and the same comparison must catch it. A suite that cannot fail
// proves nothing about the policies it passes.
import test from "node:test";
import assert from "node:assert/strict";
import { asUser, asRole, errorOf, SKIP } from "./_pglite.js";
import { world, PEOPLE } from "./_world.js";
import { plateOf } from "../app/lib/plate-of.js";

/**
 * Fix loop 1, item 8: a NON-admin member of both houses (the admin short-
 * circuits every check, so without this person the two-house rules were
 * never exercised). Returns the people list to check.
 * @param {any} db @param {Record<string, string>} uid
 */
async function addBoth(db, uid) {
  await db.exec(`
    insert into auth.users (email, email_confirmed_at) values ('both-1@example.invalid', now());
    insert into public.profiles (slug, user_id, kind, home_household, roster, sort_order)
      select 'both-1', u.id, 'member', h.id, '{"name":"Both"}', 8 from auth.users u, public.households h
       where u.email = 'both-1@example.invalid' and h.slug = 'house-w';
    insert into public.memberships select p.id, h.id from public.profiles p, public.households h where p.slug = 'both-1';`);
  await db.query("insert into public.docs (path, data) values ($1, $2), ($3, $4), ($5, '{\"items\":[]}')", [
    "profiles/both-1/profile/targets.json", JSON.stringify({ diet: "pescatarian", allergens: ["sesame"], body: { age: 40 } }),
    "profiles/both-1/plans/2026-W40.json", JSON.stringify({ week: "2026-W40", entries: [] }),
    "profiles/both-1/shopping.json",
  ]);
  uid["both-1"] = (await db.query("select user_id from public.profiles where slug = 'both-1'")).rows[0].user_id;
  return [...PEOPLE, "both-1"];
}

/**
 * Every place a policy decides, for every person: the rows they should and do
 * reach. Returns the differences, empty when the policies match the rules.
 * @param {any} db
 * @param {Record<string, string>} uid
 * @returns {Promise<string[]>}
 */
async function reachViolations(db, uid, people = /** @type {readonly string[]} */ (PEOPLE)) {
  const docs = (await db.query(
    `select d.path, d.kind, p.slug as owner, h.slug as house
       from public.docs d left join public.profiles p on p.id = d.profile_id
       left join public.households h on h.id = d.household_id`,
  )).rows;
  const members = (await db.query(
    "select p.slug, h.slug as house from public.memberships m join public.profiles p on p.id = m.profile_id join public.households h on h.id = m.household_id",
  )).rows;
  const grants = (await db.query(
    "select p.slug, h.slug as house from public.guest_grants g join public.profiles p on p.id = g.guest_profile join public.households h on h.id = g.host_household where g.until >= current_date",
  )).rows;
  const plateOwners = (await db.query("select p.slug from public.plates pl join public.profiles p on p.id = pl.profile_id")).rows.map((/** @type {any} */ r) => r.slug);
  const recipes = (await db.query("select id, staging from public.recipes")).rows;
  // item 8: row CONTENT, not only reach. The plate each person should carry,
  // from the JS port of plate_of on their canonical row (the mirror when none)
  const targets = (await db.query("select p.slug, d.path, d.data from public.docs d join public.profiles p on p.id = d.profile_id where d.kind = 'targets'")).rows;
  /** @param {string} s */
  const wantPlate = (s) => {
    const mine = targets.filter((/** @type {any} */ t) => t.slug === s);
    const src = mine.find((/** @type {any} */ t) => t.path.endsWith("profile/targets.json")) ?? mine[0];
    return src ? plateOf(src.data) : null;
  };
  const profiles = (await db.query(
    "select p.slug, p.kind, p.roster, p.family, h.slug as home, exists (select 1 from public.admins a where a.user_id = p.user_id) as admin from public.profiles p left join public.households h on h.id = p.home_household",
  )).rows;

  const housesOf = (/** @type {string} */ s) => members.filter((/** @type {any} */ m) => m.slug === s).map((/** @type {any} */ m) => m.house);
  const shareHouse = (/** @type {string} */ a, /** @type {string} */ b) => housesOf(a).some((h) => housesOf(b).includes(h));
  const isAdmin = (/** @type {string} */ s) => s === "owner-1";

  // the rules, written out (SCHEMAS.md "Who reads what")
  const canRead = (/** @type {string} */ me, /** @type {any} */ d) => {
    if (isAdmin(me)) return true;
    if (d.house) return housesOf(me).includes(d.house);
    if (d.kind === "global") return true;
    if (d.kind === "targets" || d.kind === "health") return d.owner === me;
    return d.owner === me || shareHouse(me, d.owner);
  };
  const canWrite = (/** @type {string} */ me, /** @type {any} */ d) => {
    if (isAdmin(me)) return true;
    if (d.house) return housesOf(me).includes(d.house);
    if (d.owner === me) return true;
    return ["plan", "shopping", "occasions"].includes(d.kind) && shareHouse(me, d.owner);
  };
  const canSeePlate = (/** @type {string} */ me, /** @type {string} */ owner) =>
    isAdmin(me) ||
    owner === me ||
    shareHouse(me, owner) ||
    grants.some((/** @type {any} */ g) => g.slug === owner && housesOf(me).includes(g.house));

  /** @type {string[]} */
  const out = [];
  /** @param {string} what @param {string[]} want @param {string[]} got */
  const diff = (what, want, got) => {
    for (const x of got) if (!want.includes(x)) out.push(`LEAK ${what}: ${x}`);
    for (const x of want) if (!got.includes(x)) out.push(`MISSING ${what}: ${x}`);
  };

  for (const me of people) {
    await asUser(db, uid[me], async () => {
      const seen = (await db.query("select path from public.docs")).rows.map((/** @type {any} */ r) => r.path);
      diff(`${me} reads docs`, docs.filter((d) => canRead(me, d)).map((d) => d.path), seen);

      const plates = (await db.query("select data from public.plates")).rows.length;
      const viaRpc = [];
      for (const owner of plateOwners) {
        if ((await db.query("select public.plate_for($1) as p", [owner])).rows[0].p) viaRpc.push(owner);
      }
      const wantPlates = plateOwners.filter((o) => canSeePlate(me, o));
      diff(`${me} reads plates (plate_for)`, wantPlates, viaRpc);
      if (plates !== wantPlates.length) out.push(`LEAK or MISSING ${me} plates table: ${plates} rows, want ${wantPlates.length}`);
      for (const owner of viaRpc) {
        const got = (await db.query("select public.plate_for($1) as p", [owner])).rows[0].p.data;
        if (JSON.stringify(sortKeys(got)) !== JSON.stringify(sortKeys(wantPlate(owner)))) out.push(`LEAK or WRONG ${me} plate content: ${owner}`);
      }

      // roster() rows, content included (RT N2)
      const roster = (await db.query("select public.roster() as r")).rows[0].r.profiles;
      const wantRoster = profiles
        .filter((/** @type {any} */ p) => p.kind !== "probe" && (isAdmin(me) || p.slug === me || shareHouse(me, p.slug) || grants.some((/** @type {any} */ g) => g.slug === p.slug && housesOf(me).includes(g.house))))
        .map((/** @type {any} */ p) => ({
          id: p.slug,
          roster: p.roster,
          household: p.home && (isAdmin(me) || housesOf(me).includes(p.home)) ? p.home : null,
          family: p.family && (isAdmin(me) || housesOf(me).includes(p.family)) ? p.family : null,
          admin: p.admin,
        }));
      diff(`${me} roster rows`, wantRoster.map((r) => r.id), roster.map((/** @type {any} */ r) => r.id));
      for (const r of roster) {
        const w = wantRoster.find((x) => x.id === r.id);
        if (w && JSON.stringify(sortKeys(w)) !== JSON.stringify(sortKeys(r))) out.push(`LEAK or WRONG ${me} roster row content: ${r.id}`);
      }

      const rs = (await db.query("select id from public.recipes")).rows.map((/** @type {any} */ r) => r.id);
      diff(`${me} reads bank`, recipes.filter((/** @type {any} */ r) => !r.staging || isAdmin(me)).map((/** @type {any} */ r) => r.id), rs);

      // fix loop 3 E3: write_doc is the only door. A direct insert or update
      // that lands is a leak whatever the row.
      /** @type {string[]} */
      const direct = [];
      for (const d of docs) {
        await db.exec("begin");
        try {
          const r = await db.query("update public.docs set data = data where path = $1", [d.path]);
          if (r.affectedRows === 1) direct.push(d.path);
        } catch {
          // refused (grant, policy or trigger)
        } finally {
          await db.exec("rollback");
        }
        await db.exec("begin");
        try {
          await db.exec("reset role");
          const row = (await db.query("delete from public.docs where path = $1 returning data", [d.path])).rows[0];
          await db.exec("set role authenticated");
          await db.query("insert into public.docs (path, data) values ($1, $2)", [d.path, JSON.stringify(row.data)]);
          direct.push(d.path);
        } catch {
          // refused
        } finally {
          await db.exec("rollback");
        }
      }
      if (direct.length) out.push(`LEAK ${me} writes docs directly: ${[...new Set(direct)].join(", ")}`);

      // an update pass through write_doc, at the row's current rev
      /** @type {string[]} */
      const wrote = [];
      for (const d of docs) {
        await db.exec("begin");
        try {
          await db.exec("reset role");
          const cur = (await db.query("select data, rev from public.docs where path = $1", [d.path])).rows[0];
          await db.exec("set role authenticated");
          await db.query("select public.write_doc($1, $2::jsonb, $3)", [d.path, JSON.stringify(cur.data), cur.rev]);
          wrote.push(d.path);
        } catch {
          // refused (P0403, or a trigger)
        } finally {
          await db.exec("rollback");
        }
      }
      diff(`${me} updates docs`, docs.filter((d) => canWrite(me, d)).map((d) => d.path), wrote);

      // item 8: an INSERT pass. Each row is removed (as the superuser, inside
      // a transaction that is rolled back) and the person creates it again
      // through write_doc
      /** @type {string[]} */
      const inserted = [];
      for (const d of docs) {
        await db.exec("begin");
        try {
          await db.exec("reset role");
          const row = (await db.query("delete from public.docs where path = $1 returning data", [d.path])).rows[0];
          await db.exec("set role authenticated");
          await db.query("select public.write_doc($1, $2::jsonb, null)", [d.path, JSON.stringify(row.data)]);
          inserted.push(d.path);
        } catch {
          // refused (P0403, or a trigger)
        } finally {
          await db.exec("rollback");
        }
      }
      diff(`${me} inserts docs`, docs.filter((d) => canWrite(me, d)).map((d) => d.path), inserted);
    });
  }
  return out;
}

/** @param {unknown} v @returns {unknown} */
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(/** @type {any} */ (v)[k])]));
  return v;
}

test("policy go/no-go: every person reaches exactly what the rules allow", { skip: SKIP }, async () => {
  const { db, uid } = await world();
  assert.deepEqual(await reachViolations(db, uid, await addBoth(db, uid)), []);
  await db.close();
});

test("anon (the publishable key with no session) reaches nothing", { skip: SKIP }, async () => {
  const { db } = await world();
  for (const q of ["select * from public.docs", "select * from public.plates", "select * from public.recipes", "select public.roster()", "select public.plate_for('owner-1')", "select public.write_doc('shopping.json', '{}'::jsonb, null)"]) {
    const e = await asRole(db, "anon", () => errorOf(() => db.query(q)));
    assert.match(e?.message ?? "", /permission denied/, q);
  }
  await db.close();
});

test("decision 1 in plain terms: housemates get the plate, never the full targets", { skip: SKIP }, async () => {
  const { db, uid } = await world();
  /** @param {string} who @param {string} path */
  const reads = async (who, path) =>
    (await asUser(db, uid[who], () => db.query("select count(*)::int n from public.docs where path = $1", [path]))).rows[0].n;
  // the family house: each other's plate cards, not full profiles
  assert.equal(await reads("kin-1", "profiles/kin-2/profile/targets.json"), 0);
  assert.equal(await reads("kin-1", "profiles/kin-2/fitness/targets.json"), 0);
  assert.equal(await reads("kin-1", "profiles/kin-2/health/vitals.json"), 0);
  // the shared house: the admin's plate, not his targets
  assert.equal(await reads("mate-1", "profile/targets.json"), 0);
  // the admin sees full profiles
  assert.equal(await reads("owner-1", "profiles/kin-2/profile/targets.json"), 1);
  await db.close();
});

/** Leaky policies, each one a mistake that could plausibly be made. */
const LEAKS = [
  [
    "full targets to housemates (decision 1 broken)",
    `create policy leak on public.docs for select to authenticated using (kind in ('targets','health') and profile_id = any ((select private.housemates())::uuid[]))`,
  ],
  ["plates to everyone signed in", `create policy leak on public.plates for select to authenticated using (true)`],
  ["every house's rows to everyone", `create policy leak on public.docs for select to authenticated using (household_id is not null)`],
  ["staging to everyone", `create policy leak on public.recipes for select to authenticated using (staging)`],
  // fix loop 3 E3: writes go through write_doc only, so the write rule is
  // private.can_write (the docs_insert and docs_update policies are a second
  // lock behind revoked grants). Leaks in that rule, and the grant coming back:
  [
    "housemates may update each other's targets (can_write)",
    `alter function private.can_write(text) rename to can_write_real;
     create function private.can_write(p text) returns boolean language sql stable security definer set search_path = '' as $$
       select private.can_write_real(p) or exists (select 1 from private.doc_scope(p) s
         where s.kind = 'targets' and s.profile_id = any (private.housemates())) $$`,
  ],
  ["direct update comes back (the update grant)", `grant update (data) on public.docs to authenticated`],
  [
    "plate_for without the house check",
    `create or replace function public.plate_for(p_slug text) returns jsonb language sql stable security definer set search_path = '' as $$
       select jsonb_build_object('data', pl.data) from public.plates pl join public.profiles p on p.id = pl.profile_id where p.slug = p_slug $$`,
  ],
  // fix loop 1, item 8: leaks only the new passes can see
  [
    "anyone may create any docs row (the insert pass, can_write)",
    `alter function private.can_write(text) rename to can_write_real;
     create function private.can_write(p text) returns boolean language sql stable security definer set search_path = '' as $$
       select private.can_write_real(p) or not exists (select 1 from public.docs where path = p) $$`,
  ],
  ["direct insert comes back (the insert grant)", `grant insert (path, data) on public.docs to authenticated`],
  [
    "roster() shows every home house and family (row content)",
    `create or replace function public.roster() returns jsonb language sql stable security definer set search_path = '' as $$
       select jsonb_build_object('rev', 1, 'profiles', coalesce(jsonb_agg(jsonb_build_object('id', p.slug,
         'roster', p.roster, 'household', h.slug, 'family', p.family,
         'admin', exists (select 1 from public.admins a where a.user_id = p.user_id)) order by p.sort_order), '[]'::jsonb))
       from public.profiles p left join public.households h on h.id = p.home_household
       where p.kind <> 'probe' and ((select private.is_admin()) or p.id = (select private.my_profile())
         or p.id = any ((select private.housemates())::uuid[]) or p.id = any ((select private.visible_guests())::uuid[])) $$`,
  ],
  [
    "plates carry an owner-only key (plate content)",
    `alter function private.plate_of(jsonb) rename to plate_of_real;
     create function private.plate_of(t jsonb) returns jsonb language sql immutable set search_path = '' as $$
       select private.plate_of_real(t) || jsonb_build_object('goalWeightLb', t->'goalWeightLb') $$;
     update public.docs set data = data || '{"x": 1}' where kind = 'targets';`,
  ],
];

for (const [name, sql] of LEAKS) {
  test(`negative control: the suite catches a leaky policy (${name})`, { skip: SKIP }, async () => {
    const { db, uid } = await world();
    await db.exec(sql);
    const v = await reachViolations(db, uid);
    assert.ok(v.length > 0, `the leak "${name}" went unnoticed`);
    assert.ok(v.every((x) => x.startsWith("LEAK")), v.join("\n"));
    await db.close();
  });
}
