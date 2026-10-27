#!/usr/bin/env node
// Mise 2.0 db fix loop 3, item 5 (Engineer E5): the one gate before the live
// run. Read tools/live-gate.md first. It proves on a REAL Supabase stack (the
// local Docker stack after `supabase db reset`, or the sandbox project; never
// the live project) what the PGlite stand-in cannot:
//   - the auth.users trigger (link_pending) links a confirmed account;
//   - a failing link_pending aborts the account's creation;
//   - the svc schema answers only the secret key;
//   - the global execute revoke holds for a function made after the migrations;
//   - write_doc's P0409, P0403 and P0422 reach the client as error.code;
//   - direct inserts into docs are refused (fix loop 3, E3);
//   - plate_for answers a housemate and is null for anyone else.
//
//   node tools/live-gate.mjs --url <http://127.0.0.1:54321 | https://<ref>.supabase.co> [--invite-email <address>]
//
// The keys come from the environment at run time, typed by David, never
// committed: MISE_GATE_SECRET_KEY (the secret or service_role key) and
// MISE_GATE_PUBLISHABLE_KEY (the publishable or anon key). There is no
// default URL. It speaks HTTP to PostgREST and Auth exactly as supabase-js
// does (POST /rest/v1/rpc/<fn>, the Content-Profile header for svc,
// /auth/v1/admin/users, /auth/v1/token), so it needs no package.
//
// Before it: apply supabase/migrations/ in name order, then paste
// tools/live-gate-seed.sql. After it: tools/live-gate-teardown.sql. It prints
// one line per check and exits 1 if any fails.
import { randomBytes } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** Every check the gate runs, in order. tests/live-gate.test.js holds the list to this. */
export const CHECKS = [
  "seed present (svc answers the secret key)",
  "svc refused to the publishable key",
  "auth.users trigger links a confirmed account",
  "a failing link_pending aborts the account",
  "svc refused to a signed-in user",
  "write_doc create and update (rev 1, rev 2)",
  "P0409 a stale rev",
  "P0409 a create over a row",
  "P0403 another house",
  "P0403 a house that does not exist",
  "P0422 a hidden word",
  "direct insert into docs refused",
  "plate_for a housemate",
  "plate_for null for another house",
  "global execute revoke: a later function is not anon's",
  "global execute revoke: a later function is not authenticated's",
  "write_doc not executable by the publishable key",
];

/**
 * The inputs, checked before anything is sent.
 * @param {{ url?: unknown, secretKey?: string, publishableKey?: string }} o
 * @returns {{ url: string, secretKey: string, publishableKey: string }}
 */
export function gateInputs({ url, secretKey, publishableKey }) {
  if (typeof url !== "string" || !url) throw new Error("--url is required (the local stack or the sandbox; there is no default)");
  if (!/^(https:\/\/[a-z0-9-]+\.supabase\.co|http:\/\/(127\.0\.0\.1|localhost):\d+)$/.test(url)) {
    throw new Error("--url must be https://<ref>.supabase.co or http://127.0.0.1:<port> (no path, no trailing slash)");
  }
  if (!secretKey || !publishableKey) throw new Error("MISE_GATE_SECRET_KEY and MISE_GATE_PUBLISHABLE_KEY must be set in the environment for this run");
  for (const v of [url, secretKey, publishableKey]) {
    if (/YOUR-PROJECT|PLACEHOLDER/i.test(v)) throw new Error("a placeholder from the committed config was passed; use the real values for this run");
  }
  if (secretKey === publishableKey) throw new Error("the two keys are the same key");
  return { url, secretKey, publishableKey };
}

/**
 * Run the gate.
 * @param {{ url: string, secretKey: string, publishableKey: string, fetch?: typeof fetch, inviteEmail?: string, log?: (line: string) => void }} o
 * @returns {Promise<{ check: string, ok: boolean, detail: string }[]>}
 */
export async function runGate(o) {
  const { url, secretKey, publishableKey } = gateInputs(o);
  const f = o.fetch ?? fetch;
  const log = o.log ?? (() => {});
  /** @type {{ check: string, ok: boolean, detail: string }[]} */
  const out = [];
  /** @param {string} check @param {boolean} ok @param {string} [detail] */
  const add = (check, ok, detail = "") => {
    if (!CHECKS.includes(check)) throw new Error(`unlisted check ${check}`);
    out.push({ check, ok, detail });
    log(`${ok ? "ok  " : "FAIL"} ${check}${detail ? `: ${detail}` : ""}`);
  };

  /**
   * @param {string} route @param {{ method?: string, key: string, bearer?: string, body?: unknown, schema?: string }} r
   * @returns {Promise<{ status: number, body: any }>}
   */
  const call = async (route, r) => {
    /** @type {Record<string, string>} */
    const headers = { apikey: r.key, authorization: `Bearer ${r.bearer ?? r.key}`, "content-type": "application/json" };
    if (r.schema) headers["content-profile"] = r.schema;
    const res = await f(`${url}${route}`, { method: r.method ?? "POST", headers, body: r.body === undefined ? undefined : JSON.stringify(r.body) });
    const text = await res.text();
    /** @type {any} */
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: res.status, body };
  };
  const svc = (/** @type {string} */ fn, /** @type {object} */ args, key = secretKey, bearer = key) => call(`/rest/v1/rpc/${fn}`, { key, bearer, body: args, schema: "svc" });
  /** @param {string} token @param {string} p @param {unknown} data @param {number | null} rev */
  const write = (token, p, data, rev) => call("/rest/v1/rpc/write_doc", { key: publishableKey, bearer: token, body: { p_path: p, p_data: data, p_expected_rev: rev } });
  const codeOf = (/** @type {{ body: any }} */ r) => (r.body && typeof r.body === "object" ? String(r.body.code ?? "") : "");
  // not executable: permission denied, or hidden by PostgREST (no such function / schema for this role)
  const denied = (/** @type {{ status: number, body: any }} */ r) => r.status >= 400 && ["42501", "PGRST202", "PGRST106"].includes(codeOf(r));

  // 1. the seed is there, and svc answers the secret key only
  const seed = await svc("slug_free", { p_slug: "gate-a1" });
  add("seed present (svc answers the secret key)", seed.status === 200 && seed.body === false, `HTTP ${seed.status}`);
  const anonSvc = await svc("slug_free", { p_slug: "gate-a1" }, publishableKey);
  add("svc refused to the publishable key", denied(anonSvc), `HTTP ${anonSvc.status} ${codeOf(anonSvc)}`);

  // 2. accounts: the trigger links a confirmed one; a failing trigger aborts one
  const password = randomBytes(24).toString("base64url");
  /** @type {Record<string, string>} */
  const ids = {};
  for (const who of ["gate-a1", "gate-a2", "gate-b1"]) {
    const r = await call("/auth/v1/admin/users", { key: secretKey, body: { email: `${who}@example.invalid`, password, email_confirm: true } });
    ids[who] = r.body?.id ?? "";
  }
  /** @type {string[]} */
  const linked = [];
  for (const who of Object.keys(ids)) {
    const w = await svc("whoami", { p_sub: ids[who] });
    if (w.status === 200 && w.body?.slug === who) linked.push(who);
  }
  add("auth.users trigger links a confirmed account", linked.length === 3, `${linked.length} of 3 linked`);
  const abort = await call("/auth/v1/admin/users", { key: secretKey, body: { email: "gate-abort@example.invalid", password, email_confirm: true } });
  const users = await call("/auth/v1/admin/users?page=1&per_page=1000", { method: "GET", key: secretKey });
  const kept = (users.body?.users ?? []).some((/** @type {any} */ u) => u.email === "gate-abort@example.invalid");
  add("a failing link_pending aborts the account", abort.status >= 400 && users.status === 200 && !kept, `HTTP ${abort.status}, account ${kept ? "kept" : "absent"}`);

  /** @param {string} who */
  const signIn = async (who) => (await call("/auth/v1/token?grant_type=password", { key: publishableKey, body: { email: `${who}@example.invalid`, password } })).body?.access_token ?? "";
  const a1 = await signIn("gate-a1");
  const a2 = await signIn("gate-a2");
  const b1 = await signIn("gate-b1");
  const authSvc = await svc("slug_free", { p_slug: "gate-a1" }, publishableKey, a1);
  add("svc refused to a signed-in user", Boolean(a1) && denied(authSvc), `HTTP ${authSvc.status} ${codeOf(authSvc)}`);

  // 3. the writer's codes, as the client sees them
  const ev = "households/gate-house-a/events.json";
  const c1 = await write(a1, ev, { tables: [] }, null);
  const c2 = await write(a2, ev, { tables: [{ id: "t-1", seats: [] }] }, 1);
  add("write_doc create and update (rev 1, rev 2)", c1.status === 200 && Number(c1.body) === 1 && c2.status === 200 && Number(c2.body) === 2, `HTTP ${c1.status}, ${c2.status}`);
  const stale = await write(a1, ev, { tables: [] }, 1);
  add("P0409 a stale rev", codeOf(stale) === "P0409", `HTTP ${stale.status} ${codeOf(stale)}`);
  const over = await write(a1, ev, { tables: [] }, null);
  add("P0409 a create over a row", codeOf(over) === "P0409", `HTTP ${over.status} ${codeOf(over)}`);
  const other = await write(a1, "households/gate-house-b/events.json", { tables: [] }, null);
  add("P0403 another house", codeOf(other) === "P0403", `HTTP ${other.status} ${codeOf(other)}`);
  const none = await write(a1, "households/gate-house-zz/events.json", { tables: [] }, null);
  add("P0403 a house that does not exist", codeOf(none) === "P0403", `HTTP ${none.status} ${codeOf(none)}`);
  const hidden = await write(a1, "households/gate-house-a/pantry-notes.json", { note: "for gatehidden" }, null);
  add("P0422 a hidden word", codeOf(hidden) === "P0422", `HTTP ${hidden.status} ${codeOf(hidden)}`);
  const direct = await call("/rest/v1/docs", { key: publishableKey, bearer: a1, body: { path: "households/gate-house-a/occasions.json", data: {} } });
  add("direct insert into docs refused", direct.status >= 400 && codeOf(direct) === "42501", `HTTP ${direct.status} ${codeOf(direct)}`);

  // 4. plate_for: a housemate gets the plate, another house gets null
  const targets = { diet: "vegetarian", allergens: ["sesame"], macros: { calories: 2400, protein: 140 } };
  await write(a2, "profiles/gate-a2/profile/targets.json", targets, null);
  const mate = await call("/rest/v1/rpc/plate_for", { key: publishableKey, bearer: a1, body: { p_slug: "gate-a2" } });
  add("plate_for a housemate", mate.status === 200 && Array.isArray(mate.body?.data?.allergens) && mate.body?.data?.diet === "vegetarian", `HTTP ${mate.status}`);
  const stranger = await call("/rest/v1/rpc/plate_for", { key: publishableKey, bearer: b1, body: { p_slug: "gate-a2" } });
  add("plate_for null for another house", stranger.status === 200 && stranger.body === null, `HTTP ${stranger.status}`);

  // 5. the global execute revoke, on a function the seed made after the migrations
  const probeAnon = await call("/rest/v1/rpc/gate_probe", { key: publishableKey, body: {} });
  add("global execute revoke: a later function is not anon's", denied(probeAnon), `HTTP ${probeAnon.status} ${codeOf(probeAnon)}`);
  const probeAuth = await call("/rest/v1/rpc/gate_probe", { key: publishableKey, bearer: a1, body: {} });
  add("global execute revoke: a later function is not authenticated's", denied(probeAuth), `HTTP ${probeAuth.status} ${codeOf(probeAuth)}`);
  const anonWrite = await call("/rest/v1/rpc/write_doc", { key: publishableKey, body: { p_path: ev, p_data: {}, p_expected_rev: 2 } });
  add("write_doc not executable by the publishable key", denied(anonWrite), `HTTP ${anonWrite.status} ${codeOf(anonWrite)}`);

  // optional: one real invite (an unconfirmed account links nothing, F4)
  if (o.inviteEmail) {
    const r = await call("/auth/v1/invite", { key: secretKey, body: { email: o.inviteEmail } });
    log(`invite sent: HTTP ${r.status} (check by hand that the account is unconfirmed and linked to no profile until the link is used)`);
  }
  return out;
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = String(argv[i]);
    if (!k.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      a[k.slice(2)] = next;
      i++;
    } else a[k.slice(2)] = true;
  }
  return a;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) {
    console.log("usage: MISE_GATE_SECRET_KEY=... MISE_GATE_PUBLISHABLE_KEY=... node tools/live-gate.mjs --url <local stack or sandbox URL> [--invite-email <address>]\nRead tools/live-gate.md first: migrations, then tools/live-gate-seed.sql, then this, then tools/live-gate-teardown.sql. Never the live project.");
    return;
  }
  let inputs;
  try {
    inputs = gateInputs({ url: a.url, secretKey: process.env.MISE_GATE_SECRET_KEY, publishableKey: process.env.MISE_GATE_PUBLISHABLE_KEY });
  } catch (e) {
    console.error(`REFUSED ${/** @type {Error} */ (e).message}`);
    process.exit(2);
  }
  const out = await runGate({ ...inputs, inviteEmail: typeof a["invite-email"] === "string" ? a["invite-email"] : undefined, log: (l) => console.log(`  ${l}`) });
  const failed = out.filter((c) => !c.ok).length;
  console.log(failed ? `GATE FAILED: ${failed} of ${out.length} checks` : `gate passed: ${out.length} checks`);
  console.log("now paste tools/live-gate-teardown.sql");
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => {
    console.error(String(e?.message ?? e));
    process.exit(1);
  });
}
