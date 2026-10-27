// Mise 2.0 D1: the account gate's decisions. The screens themselves are
// driven in Chrome at phone width (tests/e2e/auth-gate.html); these pin the
// rules that decide WHETHER the gate shows, so a GitHub shell can never
// see it and a guest link never lands on it.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  authGateWanted,
  authLinkFrom,
  hasPersistedSession,
  passwordProblem,
  authErrorText,
  shellBackend,
  MIN_PASSWORD,
} from "../app/views/auth-gate.js";

/** @param {Record<string, string>} o */
const store = (o) => {
  const keys = Object.keys(o);
  return {
    length: keys.length,
    key: (/** @type {number} */ i) => keys[i] ?? null,
    getItem: (/** @type {string} */ k) => o[k] ?? null,
  };
};
const SESSION = store({
  "sb-placeholderref01-auth-token": JSON.stringify({ access_token: "a", refresh_token: "r" }),
});

test("the GitHub backend never shows the gate, whatever the hash or storage", () => {
  for (const hash of [
    "",
    "#/plan",
    "#/set-password?token_hash=abcdef0123&type=invite",
    "#/join/x",
  ]) {
    assert.equal(authGateWanted({ backend: "github", hash, storage: store({}) }), null);
    assert.equal(authGateWanted({ backend: "github", hash, storage: null }), null);
  }
});

test("on Supabase: no session signs in, a persisted session boots (E5, offline too)", () => {
  assert.equal(
    authGateWanted({ backend: "supabase", hash: "#/plan", storage: store({}) }),
    "signin",
  );
  assert.equal(authGateWanted({ backend: "supabase", hash: "#/plan", storage: SESSION }), null);
  assert.equal(authGateWanted({ backend: "supabase", hash: "", storage: null }), "signin");
});

test("an invite or reset link opens SET PASSWORD even when a session exists", () => {
  const hash = "#/set-password?token_hash=pkce_0123456789abcdef&type=recovery";
  assert.equal(authGateWanted({ backend: "supabase", hash, storage: SESSION }), "setpw");
});

test("guest pages stay on the guest flow, never the account gate", () => {
  for (const hash of [
    "#/join/k3m7pq2xvta4bcdefgh2",
    "#/status/k3m7pq2xvta4bcdefgh2",
    "#/me",
    "#/join?member=1",
  ]) {
    assert.equal(authGateWanted({ backend: "supabase", hash, storage: store({}) }), null, hash);
  }
});

test("authLinkFrom takes only a well-formed token and the two known types", () => {
  assert.deepEqual(authLinkFrom("#/set-password?token_hash=abcdef0123&type=invite"), {
    tokenHash: "abcdef0123",
    type: "invite",
  });
  assert.equal(authLinkFrom("#/set-password?token_hash=abcdef0123&type=signup"), null);
  assert.equal(authLinkFrom("#/set-password?token_hash=<script>&type=invite"), null);
  assert.equal(authLinkFrom("#/set-password?type=invite"), null);
  assert.equal(authLinkFrom("#/plan?token_hash=abcdef0123&type=invite"), null);
});

test("hasPersistedSession reads only supabase-js session keys with a token", () => {
  assert.equal(hasPersistedSession(SESSION), true);
  assert.equal(hasPersistedSession(store({ "sb-x-auth-token": "null" })), false);
  assert.equal(hasPersistedSession(store({ "sb-x-auth-token": "{bad json" })), false);
  assert.equal(
    hasPersistedSession(store({ "mise.token": "github_pat_x" })),
    false,
    "a PAT is not a session",
  );
  assert.equal(hasPersistedSession(null), false);
});

test("passwordProblem: length, edge spaces, mismatch", () => {
  assert.match(passwordProblem("short", "short"), new RegExp(`${MIN_PASSWORD} characters`));
  assert.match(passwordProblem(" padded-password ", " padded-password "), /spaces/);
  assert.match(passwordProblem("long-enough-1", "long-enough-2"), /not the same/);
  assert.equal(passwordProblem("long-enough-1", "long-enough-1"), "");
});

test("error text is plain and never echoes the server's words", () => {
  const leaky = {
    status: 400,
    message: "Invalid login for guest-a@example.test on project placeholderref01",
  };
  const t = authErrorText(leaky, "signin");
  assert.equal(t.includes("example.test"), false);
  assert.equal(t.includes("placeholderref01"), false);
  assert.match(authErrorText({ status: 429 }, "signin"), /Too many tries/);
  assert.match(authErrorText({ message: "Failed to fetch" }, "signin"), /No signal/);
  assert.match(
    authErrorText({ status: 403, code: "otp_expired" }, "link"),
    /expired or was already used/,
  );
  assert.match(authErrorText({ status: 422, code: "weak_password" }, "password"), /too easy/);
});

test("shellBackend reads the meta only", () => {
  const doc = (/** @type {string | null} */ v) => ({
    querySelector: () => (v === null ? null : { getAttribute: () => v }),
  });
  assert.equal(shellBackend(doc(null)), "github");
  assert.equal(shellBackend(doc("supabase")), "supabase");
  assert.equal(shellBackend(doc(" supabase ")), "supabase");
  assert.equal(shellBackend(doc("github")), "github");
  assert.equal(shellBackend(undefined), "github");
});

test("index.html (this shell) carries no supabase meta, so it boots as 1.95", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.equal(/name="mise-backend"\s+content="supabase"/.test(html), false);
});

test("the SET PASSWORD screen spends the token only inside the tap handler (E6)", () => {
  const src = readFileSync(new URL("../app/views/auth-gate.js", import.meta.url), "utf8");
  const calls = [...src.matchAll(/\.verifyOtp\(/g)].length;
  assert.equal(calls, 1);
  const at = src.indexOf(".verifyOtp(");
  const handler = src.lastIndexOf("const setNewPassword = () =>", at);
  assert.ok(handler > 0 && at - handler < 800, "verifyOtp lives in the SET PASSWORD tap handler");
  assert.equal(/useEffect/.test(src), false, "no effect runs on load");
});

const CONFIG = fileURLToPath(new URL("../app/lib/backend/config.js", import.meta.url));
test(
  "shellBackend agrees with backend/config.js backendChoice",
  {
    todo: existsSync(CONFIG)
      ? false
      : "OWNER schelkin: runs once the seam lane's backend/config.js is on wip-2.0",
  },
  async () => {
    if (!existsSync(CONFIG)) return;
    const { backendChoice } = /** @type {any} */ (await import("../app/lib/backend/config.js"));
    const real = /** @type {any} */ (globalThis).document;
    try {
      for (const v of [null, "supabase", "github", "nonsense"]) {
        /** @type {any} */ (globalThis).document = {
          querySelector: () => (v === null ? null : { getAttribute: () => v }),
        };
        assert.equal(shellBackend(), backendChoice(), String(v));
      }
    } finally {
      /** @type {any} */ (globalThis).document = real;
    }
  },
);
