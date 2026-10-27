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
  setPasswordStep,
  verifiedLinkFrom,
  verifiedHash,
  projectRef,
  gateAfterBoot,
  isNetworkError,
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
const REF = "placeholderref01";
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
    assert.equal(authGateWanted({ backend: "github", hash, storage: store({}), ref: REF }), null);
    assert.equal(authGateWanted({ backend: "github", hash, storage: null, ref: REF }), null);
  }
});

test("on Supabase: no session signs in, a persisted session boots (E5, offline too)", () => {
  assert.equal(
    authGateWanted({ backend: "supabase", hash: "#/plan", storage: store({}), ref: REF }),
    "signin",
  );
  assert.equal(authGateWanted({ backend: "supabase", hash: "#/plan", storage: SESSION, ref: REF }), null);
  assert.equal(authGateWanted({ backend: "supabase", hash: "", storage: null, ref: REF }), "signin");
});

test("an invite or reset link opens SET PASSWORD even when a session exists", () => {
  const hash = "#/set-password?token_hash=pkce_0123456789abcdef&type=recovery";
  assert.equal(authGateWanted({ backend: "supabase", hash, storage: SESSION, ref: REF }), "setpw");
});

test("guest pages stay on the guest flow, never the account gate", () => {
  for (const hash of [
    "#/join/k3m7pq2xvta4bcdefgh2",
    "#/status/k3m7pq2xvta4bcdefgh2",
    "#/me",
    "#/join?member=1",
  ]) {
    assert.equal(authGateWanted({ backend: "supabase", hash, storage: store({}), ref: REF }), null, hash);
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
  assert.equal(hasPersistedSession(SESSION, REF), true);
  assert.equal(hasPersistedSession(store({ "sb-x-auth-token": "null" }), "x"), false);
  assert.equal(hasPersistedSession(store({ "sb-x-auth-token": "{bad json" }), "x"), false);
  assert.equal(
    hasPersistedSession(store({ "mise.token": "github_pat_x" }), REF),
    false,
    "a PAT is not a session",
  );
  assert.equal(hasPersistedSession(null, REF), false);
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
  assert.match(authErrorText(new TypeError("Failed to fetch"), "signin"), /Can't reach Mise/);
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
  const step = src.lastIndexOf("export async function setPasswordStep(", at);
  assert.ok(step > 0 && at - step < 1600, "verifyOtp lives in setPasswordStep");
  const uses = [...src.matchAll(/setPasswordStep\(/g)].length;
  assert.equal(uses, 2, "defined once, called once");
  const call = src.lastIndexOf("setPasswordStep({");
  const handler = src.lastIndexOf("const setNewPassword = () =>", call);
  assert.ok(handler > 0 && call - handler < 400, "called only from the SET PASSWORD tap handler");
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

// ---- fix loop 1, item 4 (Red Team R4, Engineer F3, Usability 1): the token
// is spent at most once; a retry after a refused password calls only
// updateUser; the token leaves the address bar right after verify; a reload
// then lands on the signed-in password step, never "expired".

/** a fake client.auth: verifyOtp works once per token, updateUser answers from a queue */
function fakeAuth(/** @type {any[]} */ updateAnswers) {
  /** @type {string[]} */
  const calls = [];
  const spent = new Set();
  return {
    calls,
    async signInWithPassword() {
      return { error: { status: 400 } };
    },
    async verifyOtp(/** @type {any} */ a) {
      calls.push("verifyOtp");
      if (spent.has(a.token_hash)) return { error: { status: 403, code: "otp_expired" } };
      spent.add(a.token_hash);
      return { data: { session: { access_token: "x" } } };
    },
    async updateUser() {
      calls.push("updateUser");
      const next = updateAnswers.shift();
      if (next instanceof Error) throw next;
      return next ?? { data: { user: {} } };
    },
    async resetPasswordForEmail() {
      return {};
    },
  };
}

test("R4 probe: a refused password then a retry calls verifyOtp once and lands done", async () => {
  const auth = fakeAuth([{ error: { status: 422, code: "weak_password" } }, { data: {} }]);
  /** @type {string[]} */
  const hashes = [];
  const link = { tokenHash: "pkce_0123456789abcdef", type: /** @type {const} */ ("invite") };
  const one = await setPasswordStep({ auth, link, password: "long-enough-1", verified: false, replaceHash: (h) => hashes.push(h) });
  assert.equal(one.done, false);
  assert.equal(one.verified, true);
  assert.match(one.note, /too easy/);
  assert.deepEqual(hashes, ["#/set-password?verified=1&type=invite"], "the token left the bar right after verify");
  const two = await setPasswordStep({ auth, link, password: "longer-and-better-2", verified: one.verified, replaceHash: (h) => hashes.push(h) });
  assert.equal(two.done, true);
  assert.deepEqual(auth.calls, ["verifyOtp", "updateUser", "updateUser"]);
  assert.equal(hashes.at(-1), "#/plan");
});

test("R4: no signal on updateUser after a good verify says the person is still signed in", async () => {
  const auth = fakeAuth([new TypeError("Failed to fetch")]);
  const r = await setPasswordStep({
    auth,
    link: { tokenHash: "pkce_0123456789abcdef", type: "recovery" },
    password: "long-enough-1",
    verified: false,
    replaceHash: () => {},
  });
  assert.equal(r.verified, true);
  assert.match(r.note, /still signed in/);
});

test("R4: a spent link never reaches updateUser", async () => {
  const auth = fakeAuth([]);
  const link = { tokenHash: "pkce_0123456789abcdef", type: /** @type {const} */ ("invite") };
  await auth.verifyOtp({ token_hash: link.tokenHash });
  auth.calls.length = 0;
  const r = await setPasswordStep({ auth, link, password: "long-enough-1", verified: false, replaceHash: () => assert.fail("no hash change") });
  assert.equal(r.verified, false);
  assert.match(r.note, /expired|no longer works/i);
  assert.deepEqual(auth.calls, ["verifyOtp"]);
});

test("R4/U1: a reload after verify shows the password step while the session lasts, sign-in after", () => {
  const hash = verifiedHash("invite");
  assert.deepEqual(verifiedLinkFrom(hash), { type: "invite" });
  assert.equal(authLinkFrom(hash), null, "no token in the bar");
  assert.equal(authGateWanted({ backend: "supabase", hash, storage: SESSION, ref: REF }), "setpw");
  assert.equal(authGateWanted({ backend: "supabase", hash, storage: store({}), ref: REF }), "signin");
  assert.equal(authGateWanted({ backend: "github", hash, storage: SESSION, ref: REF }), null);
  assert.equal(verifiedLinkFrom("#/set-password?verified=1&type=invite&token_hash=abcdef0123"), null);
  assert.equal(verifiedLinkFrom("#/set-password?verified=1&type=signup"), null);
});

// ---- fix loop 1, item 7 (Engineer F5, F15)
test("E15: only THIS project's sb-<ref>-auth-token counts; another app's session on the shared origin does not", () => {
  const other = store({ "sb-someotherapp01-auth-token": JSON.stringify({ access_token: "a", refresh_token: "r" }) });
  assert.equal(hasPersistedSession(other, REF), false);
  assert.equal(authGateWanted({ backend: "supabase", hash: "#/plan", storage: other, ref: REF }), "signin");
  assert.equal(hasPersistedSession(SESSION, null), false, "no project, no session");
  assert.equal(projectRef("https://placeholderref01.supabase.co"), REF);
  assert.equal(projectRef("https://YOUR-PROJECT.supabase.co"), null);
  assert.equal(projectRef("https://placeholderref01.supabase.co.evil.test"), null);
});

test("E5: a stored session that is dead, or a removed account, goes back to SIGN IN; no signal stays in the app", () => {
  assert.deepEqual(gateAfterBoot("signed-out"), { start: "signin", reason: "signed-out" });
  assert.deepEqual(gateAfterBoot("expired"), { start: "signin", reason: "expired" });
  assert.deepEqual(gateAfterBoot("revoked"), { start: "signin", reason: "removed" });
  assert.equal(gateAfterBoot("offline"), null);
  assert.equal(gateAfterBoot("signed-in"), null);
});

// ---- fix loop 1, item 11 (Engineer F16): "can't reach" only for a request
// that never reached the server
test("E16: only a real network failure reads as no signal", () => {
  const net = Object.assign(new Error("x"), { name: "AuthRetryableFetchError", status: 0 });
  assert.equal(isNetworkError(net), true);
  assert.equal(isNetworkError(new TypeError("Load failed")), true);
  assert.equal(isNetworkError({ status: 0 }), false, "status 0 alone is not no signal");
  assert.equal(isNetworkError({}), false);
  assert.equal(isNetworkError({ status: 400, message: "network policy" }), false);
  assert.match(authErrorText(net, "password"), /Can't reach Mise/);
  assert.doesNotMatch(authErrorText({ status: 0 }, "signin"), /reach|signal/i);
  assert.doesNotMatch(authErrorText({}, "link"), /reach|signal/i);
});
