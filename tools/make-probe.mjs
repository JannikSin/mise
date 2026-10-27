#!/usr/bin/env node
// Mise 2.0 G2: make a probe account (plan 4.2, RT N5; section 7 step 15). A
// probe has a neutral slug `probe-` plus 6 random hex characters, kind
// 'probe' (roster() hides it, svc.entitled refuses it), no targets and no
// health rows, and reads exactly what a member of its house could. The
// Worker's weekly probe signs in as it; its password goes straight into a
// Worker secret and is never printed or written to disk.
//
// Two steps, both dry runs unless told otherwise:
//   1. node tools/make-probe.mjs --house <house slug> --target live|sandbox --email-domain <domain> --sql probe.sql
//      writes probe.sql (the profile, its membership, its pending link) and
//      probe.local.json (slug, email, target; no password). Run probe.sql
//      with psql against that project.
//   2. node tools/make-probe.mjs --create-user probe.local.json [--send]
//      with SUPABASE_URL and SUPABASE_SECRET_KEY set (typed by David): creates
//      the auth user with a random password and its email marked confirmed
//      (no email is sent), so the link trigger ties it to the profile; then
//      puts the email and the password into the Worker's secrets with
//      `npx wrangler secret put` (PROBE_EMAIL and PROBE_PASSWORD for live,
//      PROBE_SANDBOX_EMAIL and PROBE_SANDBOX_PASSWORD for the sandbox; the
//      names worker/src/probe.js reads).
// `--no-house` makes the no-house probe instead (plan section 6 step 6).
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { lit, SLUG, parseArgs } from "./sql-script.mjs";

/** @typedef {{ slug: string, email: string, target: "live" | "sandbox", house: string | null }} Probe */

/**
 * @param {{ house: string | null, target: string, emailDomain: string, hex?: string }} o
 * @returns {Probe}
 */
export function newProbe({ house, target, emailDomain, hex = randomBytes(3).toString("hex") }) {
  if (target !== "live" && target !== "sandbox") throw new Error("--target must be live or sandbox");
  if (house !== null && !SLUG.test(house)) throw new Error("--house must be a house slug");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(emailDomain)) throw new Error("--email-domain must be a domain");
  if (!/^[0-9a-f]{6}$/.test(hex)) throw new Error("bad hex");
  const slug = `probe-${hex}`;
  return { slug, email: `${slug}@${emailDomain}`, target, house };
}

/** @param {Probe} p */
export function probeSql(p) {
  const s = lit(p.slug);
  return `-- Mise 2.0 make-probe (tools/make-probe.mjs). One transaction.
begin;
do $check$ begin
  if not svc.slug_free(${s}) then raise exception 'mise_probe: the slug is taken, run again'; end if;
  ${p.house === null ? "" : `if not exists (select 1 from public.households where slug = ${lit(p.house)}) then raise exception 'mise_probe: no such house'; end if;`}
end $check$;
insert into public.profiles (slug, kind, home_household, roster, entitled, sort_order)
  select ${s}, 'probe', ${p.house === null ? "null" : `(select id from public.households where slug = ${lit(p.house)})`}, '{}'::jsonb, false, 0;
${p.house === null ? "" : `insert into public.memberships select p.id, h.id from public.profiles p, public.households h where p.slug = ${s} and h.slug = ${lit(p.house)};`}
insert into private.pending_links select ${lit(p.email)}, id from public.profiles where slug = ${s};
commit;
`;
}

/** The Worker secret names for a target (worker/src/probe.js). @param {"live" | "sandbox"} target */
export function secretNames(target) {
  return target === "live" ? { email: "PROBE_EMAIL", password: "PROBE_PASSWORD" } : { email: "PROBE_SANDBOX_EMAIL", password: "PROBE_SANDBOX_PASSWORD" };
}

/**
 * Create the auth user (confirmed, no email sent) and hand the credentials to
 * the Worker. Never logs the password.
 * @param {Probe} p
 * @param {{ url: string, secretKey: string, fetch?: typeof fetch, putSecret?: (name: string, value: string) => boolean, password?: string }} o
 * @returns {Promise<{ ok: boolean, status: number, secrets: string[] }>}
 */
export async function createProbeUser(p, { url, secretKey, fetch: f = fetch, putSecret = wranglerPut, password = randomBytes(24).toString("base64url") }) {
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url)) throw new Error("SUPABASE_URL must be https://<ref>.supabase.co");
  const res = await f(`${url}/auth/v1/admin/users`, {
    method: "POST",
    headers: { apikey: secretKey, authorization: `Bearer ${secretKey}`, "content-type": "application/json" },
    body: JSON.stringify({ email: p.email, password, email_confirm: true }),
  });
  if (!res.ok) return { ok: false, status: res.status, secrets: [] };
  const names = secretNames(p.target);
  const done = [];
  for (const [name, value] of [
    [names.email, p.email],
    [names.password, password],
  ]) {
    if (!putSecret(String(name), String(value))) return { ok: false, status: res.status, secrets: done };
    done.push(String(name));
  }
  return { ok: true, status: res.status, secrets: done };
}

/** `npx wrangler secret put NAME`, the value on stdin (never on the command line). @param {string} name @param {string} value */
function wranglerPut(name, value) {
  const r = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", ["wrangler", "secret", "put", name], {
    input: value,
    stdio: ["pipe", "ignore", "inherit"],
    shell: process.platform === "win32",
  });
  return r.status === 0;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (typeof a["create-user"] === "string") {
    const p = /** @type {Probe} */ (JSON.parse(readFileSync(a["create-user"], "utf8")));
    if (!/^probe-[0-9a-f]{6}$/.test(p.slug)) throw new Error("not a probe file");
    if (!a.send) {
      const n = secretNames(p.target);
      console.log(`dry run: would create the ${p.target} probe's account (confirmed, no email) and set the Worker secrets ${n.email} and ${n.password}; add --send`);
      return;
    }
    const url = process.env.SUPABASE_URL ?? "";
    const secretKey = process.env.SUPABASE_SECRET_KEY ?? "";
    if (!url || !secretKey) throw new Error("set SUPABASE_URL and SUPABASE_SECRET_KEY first");
    const r = await createProbeUser(p, { url, secretKey });
    console.log(r.ok ? `probe account made; Worker secrets set: ${r.secrets.join(", ")}` : `refused: HTTP ${r.status}${r.secrets.length ? `, secrets set before the failure: ${r.secrets.join(", ")}` : ""}`);
    if (!r.ok) process.exit(1);
    return;
  }
  const house = a["no-house"] ? null : typeof a.house === "string" ? a.house : undefined;
  if (house === undefined || typeof a.target !== "string" || typeof a["email-domain"] !== "string") {
    console.log("usage: node tools/make-probe.mjs (--house <slug> | --no-house) --target live|sandbox --email-domain <domain> [--sql <out.sql>]");
    console.log("       node tools/make-probe.mjs --create-user <probe.local.json> [--send]");
    process.exit(2);
  }
  const p = newProbe({ house, target: a.target, emailDomain: a["email-domain"] });
  if (typeof a.sql !== "string") {
    console.log(`dry run: would make one ${p.target} probe${house === null ? " in no house" : " in 1 house"}; add --sql <file>`);
    return;
  }
  writeFileSync(a.sql, probeSql(p), { mode: 0o600 });
  const local = path.join(path.dirname(a.sql), "probe.local.json");
  writeFileSync(local, JSON.stringify(p, null, 2) + "\n", { mode: 0o600 });
  console.log(`wrote the script and ${path.basename(local)}; run the script with psql, then --create-user ${path.basename(local)} --send`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => {
    console.error(String(e?.message ?? e));
    process.exit(1);
  });
}
