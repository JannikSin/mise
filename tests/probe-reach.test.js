// Mise 2.0 G1: tools/probe-reach.mjs, the probe assertions of the migration's
// verify and of the weekly cron (plan section 6 step 6, RT N3). Run against a
// migrated stand-in as each kind of probe, then against deliberately leaky
// policies, which it must catch.
import test from "node:test";
import assert from "node:assert/strict";
import { probeReach, expectFor, sqlReader, restReader } from "../tools/probe-reach.mjs";
import { planMigration, runMigration } from "../tools/migrate-to-supabase.mjs";
import { freshDb, SKIP } from "./_pglite.js";
import { PEOPLE, writeSnapshot } from "./_snapshot.js";

async function migrated() {
  const db = await freshDb();
  await runMigration(db, planMigration(writeSnapshot(), PEOPLE));
  // three probes, as tools/make-probe.mjs will make them: neutral slugs, kind probe
  await db.exec(`
    insert into auth.users (email) values ('p1@example.invalid'), ('p2@example.invalid'), ('p3@example.invalid');
    insert into public.profiles (slug, kind, user_id)
      select v.slug, 'probe', u.id from (values ('probe-0a0a0a', 'p1'), ('probe-0b0b0b', 'p2'), ('probe-0c0c0c', 'p3')) v(slug, u0)
      join auth.users u on u.email = v.u0 || '@example.invalid';
    insert into public.memberships select p.id, h.id from public.profiles p, public.households h
      where (p.slug, h.slug) in (('probe-0a0a0a', 'house-w'), ('probe-0b0b0b', 'house-f'));`);
  /** @type {Record<string, string>} */
  const uid = {};
  for (const r of (await db.query("select slug, user_id from public.profiles where kind = 'probe'")).rows) uid[r.slug] = r.user_id;
  return { db, uid };
}

/** @param {any} db @param {Record<string, string>} uid @param {string} slug */
async function run(db, uid, slug) {
  return probeReach(sqlReader(db, uid[slug] ?? ""), await expectFor(db, slug));
}

test("shared-house, family-house and no-house probes all pass on the real policies", { skip: SKIP }, async () => {
  const { db, uid } = await migrated();
  for (const slug of ["probe-0a0a0a", "probe-0b0b0b", "probe-0c0c0c"]) {
    const checks = await run(db, uid, slug);
    assert.deepEqual(checks.filter((c) => !c.ok), [], slug);
    assert.ok(checks.length >= 12);
  }
  // the shared-house probe does see something: its house and its housemates' plates
  const r = sqlReader(db, uid["probe-0a0a0a"] ?? "");
  const docs = await r.select("docs");
  assert.ok(Array.isArray(docs) && docs.some((d) => d.household_id));
  const plates = await r.select("plates");
  assert.ok(Array.isArray(plates) && plates.length === 3, "owner, housemate, live guest");
  await db.close();
});

const LEAKS = [
  ["targets to housemates", `create policy leak on public.docs for select to authenticated using (kind = 'targets' and profile_id = any ((select private.housemates())::uuid[]))`, "no targets or health rows"],
  ["the other house's rows", `create policy leak on public.docs for select to authenticated using (household_id is not null)`, "house rows only of its houses"],
  ["every plate", `create policy leak on public.plates for select to authenticated using (true)`, "plates only of housemates and live guests"],
  ["people tables", `grant select on public.profiles to authenticated; create policy leak on public.profiles for select to authenticated using (true)`, "zero rows from the people tables"],
  ["staging", `create policy leak on public.recipes for select to authenticated using (true)`, "no staging recipes"],
];

for (const [name, sql, check] of LEAKS) {
  test(`negative control: the probe catches a leak (${name})`, { skip: SKIP }, async () => {
    const { db, uid } = await migrated();
    await db.exec(sql);
    const failed = (await run(db, uid, "probe-0a0a0a")).filter((c) => !c.ok).map((c) => c.check);
    assert.ok(failed.includes(check), `${name}: failed ${JSON.stringify(failed)}`);
    await db.close();
  });
}

test("negative control: a roster that shows probes and families is caught", { skip: SKIP }, async () => {
  const { db, uid } = await migrated();
  await db.exec(`create or replace function public.roster() returns jsonb language sql stable security definer set search_path = '' as $$
    select jsonb_build_object('profiles', jsonb_agg(jsonb_build_object('id', slug, 'family', family)), 'rev', 1) from public.profiles $$`);
  const failed = (await run(db, uid, "probe-0a0a0a")).filter((c) => !c.ok).map((c) => c.check);
  assert.ok(failed.includes("roster shows no probe"));
  assert.ok(failed.includes("roster family null for every row"));
  await db.close();
});

test("restReader speaks PostgREST with the publishable key and the probe token", async () => {
  /** @type {{ url: string, init: any }[]} */
  const calls = [];
  const fake = /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init) => {
    calls.push({ url, init });
    if (url.includes("/profiles")) return new Response(JSON.stringify({ code: "42501" }), { status: 401 });
    if (url.includes("/rpc/roster")) return new Response(JSON.stringify({ profiles: [], rev: 1 }), { status: 200 });
    return new Response("[]", { status: 200 });
  });
  const r = restReader({ url: "https://YOUR-PROJECT.supabase.co", key: "sb_publishable_PLACEHOLDER", accessToken: "token", fetch: fake });
  assert.deepEqual(await r.select("docs"), []);
  assert.equal(await r.select("profiles"), "denied");
  assert.deepEqual(await r.rpc("roster"), { profiles: [], rev: 1 });
  assert.equal(calls[0]?.url, "https://YOUR-PROJECT.supabase.co/rest/v1/docs?select=*");
  assert.equal(calls[0]?.init.headers.apikey, "sb_publishable_PLACEHOLDER");
  assert.equal(calls[0]?.init.headers.authorization, "Bearer token");
  assert.equal(calls[2]?.init.method, "POST");
});
