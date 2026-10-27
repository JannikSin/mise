#!/usr/bin/env node
// Mise 2.0 G1: send one Supabase invite (plan section 7, steps 12, 16, 18).
// Sign-ups are off, so an invite is the only way an account starts. The
// invite creates the auth user; the database's link_pending trigger then ties
// it to the person's profile through private.pending_links (written by the
// migration). Invites go out two per hour (the built-in email limit), so this
// sends exactly one per run.
//
//   node tools/invite.mjs --people people.local.json --me [--send]
//   node tools/invite.mjs --people people.local.json --slug <slug> [--send]
//
// Without --send it prints what it would do and touches nothing. With --send
// it needs SUPABASE_URL and SUPABASE_SECRET_KEY in the environment (typed by
// David, never committed) and MISE_REDIRECT_URL (the exact Site URL).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * POST /auth/v1/invite with the secret key.
 * @param {{ url: string, secretKey: string, email: string, redirectTo: string, fetch?: typeof fetch }} o
 * @returns {Promise<{ ok: boolean, status: number }>}
 */
export async function sendInvite({ url, secretKey, email, redirectTo, fetch: f = fetch }) {
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url)) throw new Error("SUPABASE_URL must be https://<ref>.supabase.co");
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error("not an email address");
  const res = await f(`${url}/auth/v1/invite?redirect_to=${encodeURIComponent(redirectTo)}`, {
    method: "POST",
    headers: { apikey: secretKey, authorization: `Bearer ${secretKey}`, "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  return { ok: res.ok, status: res.status };
}

/**
 * The person an invite is for.
 * @param {any} people parsed people.local.json
 * @param {{ me?: boolean, slug?: string }} pick
 * @returns {{ slug: string, email: string }}
 */
export function inviteeOf(people, pick) {
  const slug = pick.me ? people?.admin : pick.slug;
  const p = (people?.people ?? []).find((/** @type {any} */ x) => x.slug === slug);
  if (!p) throw new Error("that person is not in people.local.json");
  if (p.kind === "guest") throw new Error("guests are invited by their host in the app, not here");
  if (!p.email) throw new Error("that person has no email in people.local.json");
  return { slug: String(p.slug), email: String(p.email) };
}

async function main() {
  const args = process.argv.slice(2);
  const val = (/** @type {string} */ k) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const peopleFile = val("--people");
  if (!peopleFile || (!args.includes("--me") && !val("--slug"))) {
    console.log("usage: node tools/invite.mjs --people <people.local.json> (--me | --slug <slug>) [--send]");
    process.exit(2);
  }
  const who = inviteeOf(JSON.parse(readFileSync(peopleFile, "utf8")), { me: args.includes("--me"), slug: val("--slug") });
  if (!args.includes("--send")) {
    console.log("dry run: would send one invite to the person named; add --send to send it");
    return;
  }
  const url = process.env.SUPABASE_URL ?? "";
  const secretKey = process.env.SUPABASE_SECRET_KEY ?? "";
  const redirectTo = process.env.MISE_REDIRECT_URL ?? "";
  if (!url || !secretKey || !redirectTo) throw new Error("set SUPABASE_URL, SUPABASE_SECRET_KEY and MISE_REDIRECT_URL first");
  const r = await sendInvite({ url, secretKey, email: who.email, redirectTo });
  console.log(r.ok ? "invite sent" : `invite refused: HTTP ${r.status}`);
  if (!r.ok) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => {
    console.error(String(e?.message ?? e));
    process.exit(1);
  });
}
