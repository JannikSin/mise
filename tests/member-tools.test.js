// Mise 2.0 G2: the operator tools that write a SQL script for David to run
// (add-member, delete-member, make-probe) and the person export. The scripts
// run here against PGlite; nothing contacts a real service.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { asUser, errorOf, SKIP } from "./_pglite.js";
import { world } from "./_world.js";
import { checkPerson, addMemberSql } from "../tools/add-member.mjs";
import { deleteMemberSql } from "../tools/delete-member.mjs";
import { personFiles } from "../tools/export-person.mjs";
import { newProbe, probeSql, createProbeUser, secretNames } from "../tools/make-probe.mjs";
import { takeSnapshot } from "../tools/db-snapshot.mjs";

const tool = (/** @type {string} */ n) => fileURLToPath(new URL(`../tools/${n}`, import.meta.url));
const tmp = () => mkdtempSync(path.join(tmpdir(), "mise-tools-"));
const N = async (/** @type {any} */ db, /** @type {string} */ sql, /** @type {unknown[]} */ p = []) => (await db.query(sql, p)).rows[0].n;

/** Run a script; on failure roll back (psql with ON_ERROR_STOP does the same by disconnecting). */
async function run(/** @type {any} */ db, /** @type {string} */ sql) {
  const e = await errorOf(() => db.exec(sql));
  if (e) await db.exec("rollback");
  return e;
}

const PERSON = { slug: "mate-2", email: "Mate-2@example.invalid", houses: ["house-w"], roster: { name: "Mate Two", emoji: "x" } };

test("add-member: checks the person file and names the field, never the value", () => {
  assert.equal(checkPerson(PERSON).email, "mate-2@example.invalid");
  for (const [bad, field] of /** @type {[any, string][]} */ ([
    [{ ...PERSON, slug: "Bad Slug" }, "slug"],
    [{ ...PERSON, slug: "probe-abcdef" }, "slug"],
    [{ ...PERSON, email: "nope" }, "email"],
    [{ ...PERSON, houses: [] }, "houses"],
    [{ ...PERSON, home: "house-f" }, "home"],
    [{ ...PERSON, roster: { name: "x", admin: true } }, "roster"],
    [{ ...PERSON, roster: { name: "x", passkey: {} } }, "roster"],
    [{ ...PERSON, guardTerms: [{ term: "a", hiddenFrom: "house-f" }] }, "guardTerms"],
  ])) {
    assert.throws(() => checkPerson(bad), new RegExp(`^Error: ${field}`));
  }
});

test("add-member: the script adds a member, never an admin, and the invite links them", { skip: SKIP }, async () => {
  const { db } = await world();
  const rev = await N(db, "select rev::int n from public.roster_rev");
  assert.equal(await run(db, addMemberSql(checkPerson({ ...PERSON, guardTerms: [{ term: "Kinfolk", hiddenFrom: "house-w" }] }))), null);
  const p = (await db.query("select p.kind, p.entitled, h.slug home, p.roster, p.sort_order from public.profiles p join public.households h on h.id = p.home_household where p.slug = 'mate-2'")).rows[0];
  assert.deepEqual(p, { kind: "member", entitled: false, home: "house-w", roster: { name: "Mate Two", emoji: "x" }, sort_order: 8 });
  assert.equal(await N(db, "select count(*)::int n from public.memberships m join public.profiles p on p.id = m.profile_id where p.slug = 'mate-2'"), 1);
  assert.equal(await N(db, "select count(*)::int n from private.guard_terms where term = 'kinfolk'"), 1);
  assert.equal(await N(db, "select rev::int n from public.roster_rev"), rev + 1);
  await db.exec("insert into auth.users (email, email_confirmed_at) values ('mate-2@example.invalid', now())");
  assert.equal(await N(db, "select count(*)::int n from public.profiles where slug = 'mate-2' and user_id is not null"), 1);
  assert.equal(await N(db, "select count(*)::int n from public.admins"), 1, "still only the admin");
  // a housemate sees the new row in the roster
  const uid = (await db.query("select user_id from public.profiles where slug = 'mate-1'")).rows[0].user_id;
  const r = await asUser(db, uid, () => db.query("select public.roster() r"));
  assert.ok(r.rows[0].r.profiles.some((/** @type {any} */ x) => x.id === "mate-2"));
  await db.close();
});

test("add-member: refusals leave nothing behind", { skip: SKIP }, async () => {
  const { db } = await world();
  const before = await N(db, "select count(*)::int n from public.profiles");
  for (const [p, why] of /** @type {[any, RegExp][]} */ ([
    [{ ...PERSON, slug: "mate-1" }, /slug is taken/],
    [{ ...PERSON, houses: ["house-x"] }, /house does not exist/],
    [{ ...PERSON, email: "mate-1@example.invalid" }, /./],
    [{ ...PERSON, roster: { name: "Kinwords" } }, /display fields/],
    [{ ...PERSON, guardTerms: [{ term: "soup", hiddenFrom: "house-w" }] }, /already appears/],
  ])) {
    if (p.email === "mate-1@example.invalid") await db.exec("insert into private.pending_links values ('mate-1@example.invalid', (select id from public.profiles where slug = 'mate-1'))");
    const e = await run(db, addMemberSql(checkPerson(p)));
    assert.match(String(e?.message), why);
  }
  assert.equal(await N(db, "select count(*)::int n from public.profiles"), before);
  assert.equal(await N(db, "select count(*)::int n from private.guard_terms"), 2);
  await db.close();
});

test("delete-member: the person, their account and every row they own; never a house's rows", { skip: SKIP }, async () => {
  const { db, pid } = await world();
  const houseRows = await N(db, "select count(*)::int n from public.docs where household_id is not null");
  assert.equal(await run(db, deleteMemberSql("kin-2")), null);
  assert.equal(await N(db, "select count(*)::int n from public.profiles where slug = 'kin-2'"), 0);
  assert.equal(await N(db, "select count(*)::int n from public.docs where starts_with(path, 'profiles/kin-2/')"), 0);
  assert.equal(await N(db, "select count(*)::int n from public.plates where profile_id = $1", [pid["kin-2"]]), 0);
  assert.equal(await N(db, "select count(*)::int n from auth.users where email = 'kin-2@example.invalid'"), 0);
  assert.equal(await N(db, "select count(*)::int n from public.docs where household_id is not null"), houseRows);
  // a guest who claimed an invite: the invite row stays, cleared
  await db.query("insert into public.invites (code_hash, host_household, created_by, expires_at, claimed_profile, used_at) select 'c', h.id, $1, now() + interval '1 day', $2, now() from public.households h where slug = 'house-w'", [pid["mate-1"], pid["guest-1"]]);
  assert.equal(await run(db, deleteMemberSql("guest-1")), null);
  assert.equal((await db.query("select claimed_profile from public.invites where code_hash = 'c'")).rows[0].claimed_profile, null);
  // deleting the inviter removes the invites they made
  assert.equal(await run(db, deleteMemberSql("mate-1")), null);
  assert.equal(await N(db, "select count(*)::int n from public.invites"), 0);
  await db.close();
});

test("delete-member: refuses the admin and the root profile, and a stranger", { skip: SKIP }, async () => {
  const { db } = await world();
  await db.exec("insert into private.settings values ('admin_profile', 'owner-1') on conflict (key) do update set value = excluded.value");
  assert.match(String((await run(db, deleteMemberSql("owner-1")))?.message), /refuses the admin/);
  assert.match(String((await run(db, deleteMemberSql("nobody")))?.message), /no such person/);
  assert.equal(await N(db, "select count(*)::int n from public.profiles where slug = 'owner-1'"), 1);
  assert.throws(() => deleteMemberSql("x'; drop table public.docs; --"), /slug/);
  await db.close();
});

test("export-person: their own rows, their account and plate, nobody else's, no account ids", { skip: SKIP }, async () => {
  const { db } = await world();
  const snap = await takeSnapshot(db);
  await db.close();
  const files = personFiles(snap, "mate-1");
  const paths = [...files.keys()].sort();
  assert.deepEqual(paths, [
    "account.json",
    "plate.json",
    "profiles/mate-1/fitness/targets.json",
    "profiles/mate-1/health/vitals.json",
    "profiles/mate-1/plans/2026-W40.json",
    "profiles/mate-1/profile/targets.json",
    "profiles/mate-1/recipes/own-mate-1.json",
    "profiles/mate-1/shopping.json",
  ]);
  assert.deepEqual(files.get("account.json"), { slug: "mate-1", kind: "member", roster: { name: "Mate" }, home: "house-w", houses: ["house-w"], family: null, grants: [] });
  const text = JSON.stringify([...files.values()]);
  assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/, "no uuid");
  assert.equal(text.includes("secret reason of mate-1"), true, "their own full targets");
  assert.equal(/kin-1|owner-1/.test(text), false);
  assert.throws(() => personFiles(snap, "probe-0a1b2c"), /no such person/);
  // CLI: dry run, then --write
  const dir = tmp();
  const f = path.join(dir, "snap.json");
  writeFileSync(f, JSON.stringify(snap));
  const out = path.join(dir, "out");
  const dry = spawnSync(process.execPath, [tool("export-person.mjs"), "--snapshot", f, "--slug", "mate-1", "--out", out], { encoding: "utf8" });
  assert.match(dry.stdout, /would write 8 file/);
  assert.equal(existsSync(out), false);
  spawnSync(process.execPath, [tool("export-person.mjs"), "--snapshot", f, "--slug", "mate-1", "--out", out, "--write"], { encoding: "utf8" });
  assert.equal(JSON.parse(readFileSync(path.join(out, "account.json"), "utf8")).slug, "mate-1");
});

test("make-probe: a hidden probe in one house, its account confirmed without an email, its password only in the Worker secret", { skip: SKIP }, async () => {
  const { db } = await world();
  const p = newProbe({ house: "house-w", target: "sandbox", emailDomain: "probe.example.invalid", hex: "c0ffee" });
  assert.deepEqual(p, { slug: "probe-c0ffee", email: "probe-c0ffee@probe.example.invalid", target: "sandbox", house: "house-w" });
  assert.equal(await run(db, probeSql(p)), null);
  // step 2 with a fake Supabase and a fake wrangler
  /** @type {any[]} */
  const calls = [];
  /** @type {Record<string, string>} */
  const secrets = {};
  const r = await createProbeUser(p, {
    url: "https://abcdefghijklmnopqrst.supabase.co",
    secretKey: "sb_secret_PLACEHOLDER",
    fetch: /** @type {any} */ (async (/** @type {string} */ u, /** @type {any} */ init) => (calls.push([u, JSON.parse(init.body)]), { ok: true, status: 200 })),
    putSecret: (n, v) => ((secrets[n] = v), true),
  });
  assert.deepEqual(r, { ok: true, status: 200, secrets: ["PROBE_SANDBOX_EMAIL", "PROBE_SANDBOX_PASSWORD"] });
  assert.equal(calls[0][0], "https://abcdefghijklmnopqrst.supabase.co/auth/v1/admin/users");
  assert.equal(calls[0][1].email_confirm, true);
  assert.equal(calls[0][1].password, secrets.PROBE_SANDBOX_PASSWORD);
  assert.ok(String(secrets.PROBE_SANDBOX_PASSWORD).length >= 30);
  assert.deepEqual(secretNames("live"), { email: "PROBE_EMAIL", password: "PROBE_PASSWORD" });
  // what Supabase does on that call: a confirmed user, which the trigger links
  await db.query("insert into auth.users (email, email_confirmed_at) values ($1, now())", [p.email]);
  const uid = (await db.query("select user_id from public.profiles where slug = 'probe-c0ffee'")).rows[0].user_id;
  assert.ok(uid);
  await asUser(db, uid, async () => {
    assert.equal((await db.query("select count(*)::int n from public.docs where kind in ('targets', 'health')")).rows[0].n, 0);
    const roster = (await db.query("select public.roster() r")).rows[0].r.profiles.map((/** @type {any} */ x) => x.id);
    assert.equal(roster.some((/** @type {string} */ id) => id.startsWith("probe-")), false);
    assert.ok((await db.query("select count(*)::int n from public.plates")).rows[0].n > 0, "it reads its housemates' plates");
  });
  await db.close();
});

test("CLIs: dry runs by default, no network, nothing written", () => {
  const dir = tmp();
  const pf = path.join(dir, "person.local.json");
  writeFileSync(pf, JSON.stringify(PERSON));
  const add = spawnSync(process.execPath, [tool("add-member.mjs"), "--person", pf], { encoding: "utf8" });
  assert.match(add.stdout, /dry run: would add 1 member/);
  assert.equal(add.stdout.includes("mate-2"), false);
  const del = spawnSync(process.execPath, [tool("delete-member.mjs"), "--slug", "kin-2"], { encoding: "utf8" });
  assert.match(del.stdout, /dry run/);
  const probe = spawnSync(process.execPath, [tool("make-probe.mjs"), "--house", "house-w", "--target", "live", "--email-domain", "probe.example.invalid"], { encoding: "utf8" });
  assert.match(probe.stdout, /dry run/);
  const sql = path.join(dir, "probe.sql");
  spawnSync(process.execPath, [tool("make-probe.mjs"), "--house", "house-w", "--target", "live", "--email-domain", "probe.example.invalid", "--sql", sql], { encoding: "utf8" });
  const local = JSON.parse(readFileSync(path.join(dir, "probe.local.json"), "utf8"));
  assert.match(local.slug, /^probe-[0-9a-f]{6}$/);
  assert.equal("password" in local, false);
  const create = spawnSync(process.execPath, [tool("make-probe.mjs"), "--create-user", path.join(dir, "probe.local.json")], { encoding: "utf8", env: { ...process.env, SUPABASE_URL: "", SUPABASE_SECRET_KEY: "" } });
  assert.match(create.stdout, /dry run: would create the live probe's account/);
  const send = spawnSync(process.execPath, [tool("make-probe.mjs"), "--create-user", path.join(dir, "probe.local.json"), "--send"], { encoding: "utf8", env: { ...process.env, SUPABASE_URL: "", SUPABASE_SECRET_KEY: "" } });
  assert.equal(send.status, 1);
  assert.match(send.stderr, /set SUPABASE_URL/);
});
