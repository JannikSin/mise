// Mise 2.0 fix loop 1, item 9 (Engineer F8, F20, section 7 survivors): each
// test here kills a mutant the gate's mutation run left alive. The mutant it
// kills is named in the test title. In-memory project and keys only.
import test from "node:test";
import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import { verifySupabaseJwt, resetJwksCacheForTests } from "../worker/src/jwt.js";
import { verifyGuestSessionV2, signGuestSessionV2 } from "../worker/src/guest-session.js";
import { supaGuestRoute, supaInviteRoute, inviteCodeHash } from "../worker/src/supa-routes.js";
import { weeklyProbes } from "../worker/src/probe.js";
import { projectFor } from "../worker/src/supabase-env.js";
import { hashGuestPin, GUEST_LOCK_MS } from "../worker/src/lib.js";
import { makeKey, signJwt, fakeSupabase, SANDBOX_ENV, SANDBOX_REF } from "./supabase-fakes.js";

const KEY = SANDBOX_ENV.GUEST_SESSION_KEY;
const project = /** @type {NonNullable<ReturnType<typeof projectFor>>} */ (projectFor("sandbox", SANDBOX_ENV));
const NOW = 1_800_000_000_000;

/** a RouteCtx over an in-memory cache @param {Record<string, any>} [cache] @param {any} [fetchImpl] */
function ctx(cache = {}, fetchImpl = undefined) {
  return {
    json: (/** @type {number} */ status, /** @type {any} */ body) => Response.json(body, { status }),
    cacheGet: async (/** @type {string} */ k) => cache[k] ?? null,
    cachePut: async (/** @type {string} */ k, /** @type {any} */ v) => void (cache[k] = v),
    cacheDelete: async (/** @type {string} */ k) => void delete cache[k],
    rateState: new Map(),
    todayIso: "2026-10-27",
    nowMs: NOW,
    fetchImpl,
  };
}

test("mutant 'jwt iat': a token issued in the future is refused as iat", async () => {
  resetJwksCacheForTests();
  const key = await makeKey("kid-1");
  const sb = fakeSupabase({ jwks: { [SANDBOX_REF]: [key.jwk] } });
  const nowS = Math.floor(Date.now() / 1000);
  const r = await verifySupabaseJwt(await signJwt(key, { iat: nowS + 3600 }), project, { fetchImpl: sb.fetchImpl });
  assert.deepEqual(r, { ok: false, reason: "iat" });
  const ok = await verifySupabaseJwt(await signJwt(key, { iat: nowS + 30 }), project, { fetchImpl: sb.fetchImpl });
  assert.equal(ok.ok, true, "inside the 60 s leeway");
});

test("mutant 'session branch' (F8): a sandbox guest session is refused on live", async () => {
  const s = await signGuestSessionV2({ p: "guest-a", b: "sandbox" }, KEY, NOW);
  assert.ok(await verifyGuestSessionV2(s, KEY, "sandbox", NOW));
  assert.equal(await verifyGuestSessionV2(s, KEY, "main", NOW), null);
});

test("mutant 'session typ' (F8): a correctly signed payload without typ guest is refused", async () => {
  // sign an untyped payload with the same derived key the module uses
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`mise-guest-session-v2:${KEY}`));
  const k = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const enc = (/** @type {Uint8Array} */ b) => Buffer.from(b).toString("base64url");
  for (const payload of [{ p: "guest-a", b: "sandbox", exp: NOW + 60_000 }, { typ: "member", p: "guest-a", b: "sandbox", exp: NOW + 60_000 }]) {
    const body = enc(new TextEncoder().encode(JSON.stringify(payload)));
    const sig = enc(new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(body))));
    assert.equal(await verifyGuestSessionV2(`${body}.${sig}`, KEY, "sandbox", NOW), null, JSON.stringify(payload));
  }
});

/** the svc fake for the guest routes @param {{ hasLogin?: boolean }} o */
async function guestSvc(o = {}) {
  const pin = await hashGuestPin("4821");
  const sb = fakeSupabase({
    rpc: {
      guest_login_row: (/** @type {any} */ a) => (a.p_name_key === "guesta" ? { slug: "guest-a", salt: pin.salt, hash: pin.hash } : null),
      guest_view: () => ({ profile_id: "p", name: "Guest A", has_login: o.hasLogin ?? true, host_house: "house-w", tables: [], names: {} }),
    },
  });
  return sb;
}

test("mutant 'guest lock' (F20): a locked name is paused even with the right passkey", async () => {
  const sb = await guestSvc();
  const cache = { "https://mise-worker.internal/sb-guest-fail/sandbox/guesta": { fails: 5, lockedUntil: NOW + GUEST_LOCK_MS } };
  const r = await supaGuestRoute("/guest/login", { name: "Guest A", pin: "4821" }, "sandbox", SANDBOX_ENV, ctx(cache, sb.fetchImpl));
  assert.equal(r.status, 429);
  const open = await supaGuestRoute("/guest/login", { name: "Guest A", pin: "4821" }, "sandbox", SANDBOX_ENV, ctx({}, sb.fetchImpl));
  assert.equal(open.status, 200, "unlocked, the same passkey logs in");
});

test("mutant 'guest hasLogin' (F20): a login whose profile has no live login is refused", async () => {
  const sb = await guestSvc({ hasLogin: false });
  const r = await supaGuestRoute("/guest/login", { name: "Guest A", pin: "4821" }, "sandbox", SANDBOX_ENV, ctx({}, sb.fetchImpl));
  assert.equal(r.status, 401);
});

test("mutants 'claim usedAt' and 'claim expired': refused before claim_guest is ever called", async () => {
  const code = "k3m7pq2xvta4bcdefgh2";
  const hash = await inviteCodeHash(code);
  for (const [inv, words] of /** @type {const} */ ([
    [{ host_house: "house-w", expires_at: "2099-01-01T00:00:00Z", used_at: "2026-10-01T00:00:00Z", claimed: "guest-z" }, /already used/],
    [{ host_house: "house-w", expires_at: "2020-01-01T00:00:00Z", used_at: null, claimed: null }, /expired/],
  ])) {
    let claims = 0;
    const sb = fakeSupabase({
      rpc: {
        invite_get: (/** @type {any} */ a) => (a.p_code_hash === hash ? inv : null),
        claim_guest: () => (claims++, "a0000000-0000-4000-8000-000000000009"),
        slug_free: () => true,
      },
    });
    const r = await supaInviteRoute("/invite/claim", { entry: { name: "Guest Z", emoji: "x" }, targets: {} }, code, "sandbox", SANDBOX_ENV, ctx({}, sb.fetchImpl));
    assert.equal(r.status, 410);
    assert.match((await r.json()).error, words);
    assert.equal(claims, 0);
  }
});

test("mutant 'probe pass report': a clean weekly probe posts a pass", async () => {
  /** @type {any[]} */
  const posts = [];
  const clean = fakeSupabase({
    rpc: {
      __token: () => ({ access_token: "s" }),
      "table:docs": () => [{ kind: "plan" }],
      "table:plates": () => [],
      roster: () => ({ profiles: [] }),
      guard_hits: () => 0,
    },
  });
  const env = { ...SANDBOX_ENV, PROBE_SANDBOX_EMAIL: "p@example.test", PROBE_SANDBOX_PASSWORD: "x" };
  await weeklyProbes(env, async (n) => void posts.push(n), clean.fetchImpl);
  assert.equal(posts.length, 1);
  assert.match(posts[0].title, /passed \(sandbox\)/);
});
