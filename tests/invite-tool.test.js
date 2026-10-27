// Mise 2.0 G1: tools/invite.mjs (plan section 7). One invite per run, members
// only, dry by default; the request shape is the Supabase invite endpoint.
// A stub fetch only: nothing here reaches the network.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sendInvite, inviteeOf } from "../tools/invite.mjs";
import { PEOPLE } from "./_snapshot.js";

const TOOL = fileURLToPath(new URL("../tools/invite.mjs", import.meta.url));

test("inviteeOf: the admin with --me, a member by slug, never a guest or a stranger", () => {
  assert.deepEqual(inviteeOf(PEOPLE, { me: true }), { slug: "owner-1", email: "owner-1@example.invalid" });
  assert.equal(inviteeOf(PEOPLE, { slug: "mate-1" }).email, "mate-1@example.invalid");
  assert.throws(() => inviteeOf(PEOPLE, { slug: "guest-1" }), /guests/);
  assert.throws(() => inviteeOf(PEOPLE, { slug: "nobody" }), /not in/);
});

test("sendInvite posts one invite with the secret key and the exact redirect", async () => {
  /** @type {any[]} */
  const calls = [];
  const fake = /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init) => {
    calls.push({ url, init });
    return new Response("{}", { status: 200 });
  });
  const r = await sendInvite({ url: "https://your-project.supabase.co", secretKey: "sb_secret_PLACEHOLDER", email: "mate-1@example.invalid", redirectTo: "https://example.invalid/mise/", fetch: fake });
  assert.deepEqual(r, { ok: true, status: 200 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://your-project.supabase.co/auth/v1/invite?redirect_to=https%3A%2F%2Fexample.invalid%2Fmise%2F");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.apikey, "sb_secret_PLACEHOLDER");
  assert.deepEqual(JSON.parse(calls[0].init.body), { email: "mate-1@example.invalid" });
  await assert.rejects(() => sendInvite({ url: "http://evil.example", secretKey: "k", email: "a@b", redirectTo: "x", fetch: fake }), /SUPABASE_URL/);
});

test("the CLI is a dry run without --send", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mise-invite-"));
  const file = path.join(dir, "people.local.json");
  writeFileSync(file, JSON.stringify(PEOPLE));
  const r = spawnSync(process.execPath, [TOOL, "--people", file, "--me"], { encoding: "utf8", env: { ...process.env, SUPABASE_URL: "", SUPABASE_SECRET_KEY: "" } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /dry run/);
  assert.equal(r.stdout.includes("example.invalid"), false, "no email printed");
  const s = spawnSync(process.execPath, [TOOL, "--people", file, "--me", "--send"], { encoding: "utf8", env: { ...process.env, SUPABASE_URL: "", SUPABASE_SECRET_KEY: "" } });
  assert.equal(s.status, 1);
  assert.match(s.stderr, /set SUPABASE_URL/);
  rmSync(dir, { recursive: true, force: true });
});
