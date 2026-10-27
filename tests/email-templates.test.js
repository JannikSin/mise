// Mise 2.0 fix loop 1, item 6 (Red Team R7): the Supabase Invite and Reset
// templates link to the app's SET PASSWORD screen with the token HASH, never
// {{ .ConfirmationURL }} (a mail scanner would spend it), and the redirect
// allowlist is the two exact URLs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { authLinkFrom, authGateWanted, resetRedirect } from "../app/views/auth-gate.js";

const dir = new URL("../supabase/email-templates/", import.meta.url);
const read = (/** @type {string} */ f) => readFileSync(new URL(f, dir), "utf8");

for (const [file, type] of [
  ["invite.html", "invite"],
  ["recovery.html", "recovery"],
]) {
  test(`${file}: the one link is the SET PASSWORD hash link, type ${type}`, () => {
    const body = read(file);
    assert.equal(/ConfirmationURL/.test(body.replace(/<!--[\s\S]*?-->/g, "")), false, "no ConfirmationURL in the body");
    const hrefs = [...body.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    assert.deepEqual(hrefs, [`{{ .SiteURL }}#/set-password?token_hash={{ .TokenHash }}&type=${type}`]);
    // what Supabase sends, filled in for the live project, opens the gate on SET PASSWORD
    const sent = String(hrefs[0])
      .replace("{{ .SiteURL }}", "https://janniksin.github.io/mise/")
      .replace("{{ .TokenHash }}", "pkce_0123456789abcdef0123");
    const hash = sent.slice(sent.indexOf("#"));
    assert.deepEqual(authLinkFrom(hash), { tokenHash: "pkce_0123456789abcdef0123", type });
    assert.equal(authGateWanted({ backend: "supabase", hash, storage: null }), "setpw");
    assert.equal(/\u2014/.test(body), false);
  });
}

test("the redirect allowlist is exactly the two app URLs, and redirectTo equals them", () => {
  const doc = read("README.md");
  const row = (/** @type {string} */ name) => doc.split("\n").find((l) => l.startsWith(`| \`${name}\``)) ?? "";
  assert.match(row("mise"), /\| `https:\/\/janniksin\.github\.io\/mise\/` \| `https:\/\/janniksin\.github\.io\/mise\/` \|$/);
  assert.match(row("mise-sandbox"), /\| `https:\/\/mise-next\.pages\.dev\/` \| `https:\/\/mise-next\.pages\.dev\/` \|$/);
  assert.equal(resetRedirect("https://janniksin.github.io", "/mise/index.html"), "https://janniksin.github.io/mise/");
  assert.equal(resetRedirect("https://janniksin.github.io", "/mise/"), "https://janniksin.github.io/mise/");
  assert.equal(resetRedirect("https://mise-next.pages.dev", "/"), "https://mise-next.pages.dev/");
});
