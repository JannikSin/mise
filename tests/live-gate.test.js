// Mise 2.0 db fix loop 3, item 5 (Engineer E5): tools/live-gate.mjs. The gate
// itself is for the real stack and is never run here. These tests drive the
// SAME script against the PGlite stand-in through a small fake of PostgREST
// and Auth (each request runs under the role its key or token maps to), so a
// wrong check, a wrong code or a wrong seed shows up before the admin runs it,
// and negative controls prove each check can fail. No network.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { freshDb, SKIP } from "./_pglite.js";
import { runGate, gateInputs, CHECKS } from "../tools/live-gate.mjs";

const TOOL = fileURLToPath(new URL("../tools/live-gate.mjs", import.meta.url));
const SEED = readFileSync(new URL("../tools/live-gate-seed.sql", import.meta.url), "utf8");
const TEARDOWN = readFileSync(new URL("../tools/live-gate-teardown.sql", import.meta.url), "utf8");
const URL_ = "http://127.0.0.1:54321";
const SECRET = "sb_secret_test-only-not-a-key";
const PUBLISHABLE = "sb_publishable_test-only-not-a-key";

/**
 * A fetch that answers like PostgREST and Auth, backed by the stand-in.
 * @param {any} db
 * @returns {typeof fetch}
 */
function fakeSupabase(db) {
  /** @type {Map<string, string>} token -> user id */
  const tokens = new Map();
  /** @type {Map<string, string>} email -> password */
  const passwords = new Map();
  /** @param {string} role @param {string} uid @param {() => Promise<any>} fn */
  const as = async (role, uid, fn) => {
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [uid]);
    await db.exec(`set role ${role}`);
    try {
      return await fn();
    } finally {
      await db.exec("reset role");
      await db.query("select set_config('request.jwt.claim.sub', '', false)");
    }
  };
  /** @param {number} status @param {unknown} body */
  const reply = (status, body) => /** @type {Response} */ (/** @type {unknown} */ ({ status, ok: status < 300, text: async () => JSON.stringify(body) }));
  /** @param {any} e @param {string} role */
  const pgError = (e, role) => {
    if (e?.code === "42883") return reply(404, { code: "PGRST202", message: "Could not find the function" });
    if (e?.code === "42501") return reply(role === "anon" ? 401 : 403, { code: "42501", message: String(e.message) });
    return reply(400, { code: String(e?.code ?? ""), message: String(e?.message ?? e) });
  };
  return /** @type {typeof fetch} */ (
    async (input, init) => {
      const u = new URL(String(input));
      const h = /** @type {Record<string, string>} */ (init?.headers ?? {});
      const bearer = String(h.authorization ?? "").replace(/^Bearer /, "");
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const secret = h.apikey === SECRET && bearer === SECRET;
      const uid = tokens.get(bearer) ?? "";
      const role = secret ? "service_role" : uid ? "authenticated" : h.apikey === PUBLISHABLE ? "anon" : "";
      if (!role) return reply(401, { code: "401", message: "no key" });
      const route = u.pathname;
      if (route.startsWith("/rest/v1/rpc/")) {
        const schema = h["content-profile"] ?? "public";
        const fn = route.slice("/rest/v1/rpc/".length);
        const keys = Object.keys(body);
        const sql = `select to_jsonb(${schema}.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")})) as r`;
        const params = keys.map((k) => (body[k] !== null && typeof body[k] === "object" ? JSON.stringify(body[k]) : body[k]));
        try {
          return reply(200, (await as(role, uid, () => db.query(sql, params))).rows[0].r);
        } catch (e) {
          return pgError(e, role);
        }
      }
      if (route === "/rest/v1/docs") {
        try {
          await as(role, uid, () => db.query("insert into public.docs (path, data) values ($1, $2)", [body.path, JSON.stringify(body.data)]));
          return reply(201, null);
        } catch (e) {
          return pgError(e, role);
        }
      }
      if (route === "/auth/v1/admin/users") {
        if (!secret) return reply(401, { code: "no_authorization" });
        if (init?.method === "GET") return reply(200, { users: (await db.query("select id, email from auth.users")).rows });
        try {
          const id = (await db.query("insert into auth.users (email, email_confirmed_at) values ($1, now()) returning id", [body.email])).rows[0].id;
          passwords.set(body.email, body.password);
          return reply(200, { id, email: body.email });
        } catch {
          return reply(500, { code: "unexpected_failure", msg: "Database error creating new user" });
        }
      }
      if (route === "/auth/v1/token") {
        const row = (await db.query("select id from auth.users where email = $1", [body.email])).rows[0];
        if (!row || passwords.get(body.email) !== body.password) return reply(400, { code: "invalid_credentials" });
        const t = `token-${row.id}`;
        tokens.set(t, row.id);
        return reply(200, { access_token: t });
      }
      return reply(404, { code: "not_found" });
    }
  );
}

/**
 * A seeded stand-in, optionally broken by `sql` after the seed, or by `wrap`
 * around the fake's answers.
 * @param {string} [sql] @param {(f: typeof fetch) => typeof fetch} [wrap]
 */
async function gateOn(sql, wrap) {
  const db = await freshDb();
  await db.exec(SEED);
  if (sql) await db.exec(sql);
  const f = fakeSupabase(db);
  const out = await runGate({ url: URL_, secretKey: SECRET, publishableKey: PUBLISHABLE, fetch: wrap ? wrap(f) : f });
  return { db, out, failed: out.filter((c) => !c.ok).map((c) => c.check) };
}

test("E5: on a correct stack every check passes, each check runs once in the listed order, and the teardown leaves nothing", { skip: SKIP }, async () => {
  const { db, out, failed } = await gateOn();
  assert.deepEqual(failed, [], JSON.stringify(out, null, 1));
  assert.deepEqual(out.map((c) => c.check), CHECKS);
  await db.exec(TEARDOWN);
  for (const [t, where] of [
    ["public.households", "slug like 'gate-%'"],
    ["public.profiles", "slug like 'gate-%'"],
    ["public.docs", "path like '%gate-%'"],
    ["public.plates", "true"],
    ["auth.users", "email like 'gate-%'"],
    ["private.pending_links", "true"],
    ["private.guard_terms", "true"],
  ]) {
    assert.equal((await db.query(`select count(*)::int n from ${t} where ${where}`)).rows[0].n, 0, t);
  }
  assert.equal((await db.query("select count(*)::int n from pg_proc where proname = 'gate_probe'")).rows[0].n, 0);
  assert.equal((await db.query("select count(*)::int n from pg_constraint where conname = 'gate_abort'")).rows[0].n, 0);
  await db.close();
});

/** Each a mistake the real platform could hide, and the check that must catch it. */
const BROKEN = [
  ["the auth.users trigger is missing", "drop trigger link_pending on auth.users", "auth.users trigger links a confirmed account"],
  ["link_pending swallows its failure", "alter table public.profiles drop constraint gate_abort", "a failing link_pending aborts the account"],
  ["svc is open to the publishable key", "grant usage on schema svc to anon; grant execute on function svc.slug_free(text) to anon", "svc refused to the publishable key"],
  ["svc is open to signed-in users", "grant usage on schema svc to authenticated; grant execute on function svc.slug_free(text) to authenticated", "svc refused to a signed-in user"],
  ["the default privileges let anon run new functions", "grant execute on function public.gate_probe() to anon", "global execute revoke: a later function is not anon's"],
  ["the default privileges let users run new functions", "grant execute on function public.gate_probe() to authenticated", "global execute revoke: a later function is not authenticated's"],
  ["anon may run write_doc", "grant execute on function public.write_doc(text, jsonb, bigint) to anon", "write_doc not executable by the publishable key"],
  ["direct insert into docs comes back", "grant insert (path, data) on public.docs to authenticated", "direct insert into docs refused"],
  ["the name guard is off", "delete from private.guard_terms", "P0422 a hidden word"],
  [
    "write_doc ignores the rev",
    `create or replace function public.write_doc(p_path text, p_data jsonb, p_expected_rev bigint) returns bigint language plpgsql security definer set search_path = '' as $$
     declare v bigint; begin
       if not private.can_write(p_path) then raise exception 'mise_forbidden' using errcode = 'P0403'; end if;
       insert into public.docs (path, data) values (p_path, p_data) on conflict (path) do update set data = excluded.data returning rev into v;
       return v; end $$`,
    "P0409 a stale rev",
  ],
  ["another house is writable", "insert into public.memberships select p.id, h.id from public.profiles p, public.households h where p.slug = 'gate-a1' and h.slug = 'gate-house-b'", "P0403 another house"],
  ["plate_for answers everyone", "create or replace function public.plate_for(p_slug text) returns jsonb language sql stable security definer set search_path = '' as $$ select jsonb_build_object('data', pl.data) from public.plates pl join public.profiles p on p.id = pl.profile_id where p.slug = p_slug $$", "plate_for null for another house"],
];

for (const [name, sql, check] of BROKEN) {
  test(`E5 negative control: ${name}, and the gate says so`, { skip: SKIP }, async () => {
    const { db, failed } = await gateOn(sql);
    assert.ok(failed.includes(check), `expected "${check}" to fail; failed: ${JSON.stringify(failed)}`);
    await db.close();
  });
}

test("E5 negative control: Auth answers an error but keeps the half-made account, and the gate says so", { skip: SKIP }, async () => {
  const { db, failed } = await gateOn(undefined, (f) => /** @type {typeof fetch} */ (async (input, init) => {
    const res = await f(input, init);
    if (String(input).includes("/auth/v1/admin/users?") && init?.method === "GET") {
      const body = JSON.parse(await res.text());
      body.users.push({ id: "00000000-0000-4000-8000-000000000000", email: "gate-abort@example.invalid" });
      return /** @type {Response} */ (/** @type {unknown} */ ({ status: 200, ok: true, text: async () => JSON.stringify(body) }));
    }
    return res;
  }));
  assert.ok(failed.includes("a failing link_pending aborts the account"), JSON.stringify(failed));
  await db.close();
});

test("E5: the inputs are refused before anything is sent: no URL, no keys, placeholders, the same key twice, a URL with a path", async () => {
  const ok = { url: URL_, secretKey: SECRET, publishableKey: PUBLISHABLE };
  assert.deepEqual(gateInputs(ok), ok);
  assert.equal(gateInputs({ ...ok, url: "https://abcdefgh.supabase.co" }).url, "https://abcdefgh.supabase.co");
  for (const [bad, msg] of [
    [{ ...ok, url: undefined }, /--url is required/],
    [{ ...ok, url: "" }, /--url is required/],
    [{ ...ok, secretKey: "" }, /must be set/],
    [{ ...ok, publishableKey: undefined }, /must be set/],
    [{ ...ok, url: "https://YOUR-PROJECT.supabase.co" }, /must be https|placeholder/],
    [{ ...ok, publishableKey: "sb_publishable_PLACEHOLDER" }, /placeholder/],
    [{ ...ok, publishableKey: SECRET }, /same key/],
    [{ ...ok, url: "https://abcdefgh.supabase.co/rest/v1" }, /no path/],
    [{ ...ok, url: "http://db.example.com:5432" }, /must be https/],
  ]) {
    assert.throws(() => gateInputs(/** @type {any} */ (bad)), /** @type {RegExp} */ (msg));
    let sent = 0;
    await assert.rejects(() => runGate({ .../** @type {any} */ (bad), fetch: async () => (sent++, /** @type {any} */ (null)) }));
    assert.equal(sent, 0, "nothing sent");
  }
});

test("E5 CLI: refuses without an explicit URL and both keys from the environment; --help points at the runbook", () => {
  const env = { ...process.env };
  delete env.MISE_GATE_SECRET_KEY;
  delete env.MISE_GATE_PUBLISHABLE_KEY;
  const help = spawnSync(process.execPath, [TOOL, "--help"], { encoding: "utf8", env });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /live-gate\.md/);
  assert.match(help.stdout, /Never the live project/);
  const noUrl = spawnSync(process.execPath, [TOOL], { encoding: "utf8", env: { ...env, MISE_GATE_SECRET_KEY: SECRET, MISE_GATE_PUBLISHABLE_KEY: PUBLISHABLE } });
  assert.equal(noUrl.status, 2);
  assert.match(noUrl.stderr, /REFUSED --url is required/);
  const noKeys = spawnSync(process.execPath, [TOOL, "--url", URL_], { encoding: "utf8", env });
  assert.equal(noKeys.status, 2);
  assert.match(noKeys.stderr, /REFUSED MISE_GATE_SECRET_KEY/);
});

test("E5: the runbook names every check, the seed, the teardown and the order", () => {
  const md = readFileSync(new URL("../tools/live-gate.md", import.meta.url), "utf8");
  for (const c of CHECKS) assert.ok(md.includes(c), c);
  for (const s of ["supabase db reset", "live-gate-seed.sql", "live-gate-teardown.sql", "MISE_GATE_SECRET_KEY", "MISE_GATE_PUBLISHABLE_KEY", "Never the live project"]) assert.ok(md.includes(s), s);
});
