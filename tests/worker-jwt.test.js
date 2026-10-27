// Mise 2.0 F1 (plan section 4.2, "Worker token check, all of these
// required"): the Supabase JWT check. Every key here is generated in this
// process; no real project is ever contacted.
import test from "node:test";
import assert from "node:assert/strict";
import { verifySupabaseJwt, resetJwksCacheForTests, looksLikeJwt } from "../worker/src/jwt.js";
import { projectFor } from "../worker/src/supabase-env.js";
import { makeKey, signJwt, fakeSupabase, SANDBOX_ENV, SANDBOX_REF, PROJECT_URL } from "./supabase-fakes.js";

const project = /** @type {NonNullable<ReturnType<typeof projectFor>>} */ (
  projectFor("sandbox", SANDBOX_ENV)
);

async function setup() {
  resetJwksCacheForTests();
  const key = await makeKey("kid-1");
  const sb = fakeSupabase({ jwks: { [SANDBOX_REF]: [key.jwk] } });
  return { key, sb };
}

test("projectFor: placeholder config maps the sandbox, and nothing else is switched", () => {
  assert.equal(project.iss, `https://${SANDBOX_REF}.supabase.co/auth/v1`);
  assert.equal(projectFor("main", SANDBOX_ENV), null);
  assert.equal(projectFor("sandbox", {}), null);
  assert.equal(projectFor(null, SANDBOX_ENV), null);
  // a URL with a path or a non-supabase host is refused, not trimmed
  assert.equal(
    projectFor("sandbox", { ...SANDBOX_ENV, SUPABASE_SANDBOX_URL: "https://evil.example/x" }),
    null,
  );
  assert.equal(projectFor("sandbox", { ...SANDBOX_ENV, SUPABASE_SANDBOX_SECRET_KEY: "" }), null);
});

test("a good token verifies and yields its sub", async () => {
  const { key, sb } = await setup();
  const r = await verifySupabaseJwt(await signJwt(key), project, { fetchImpl: sb.fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.sub, "11111111-1111-4111-8111-111111111111");
});

test("each required claim refuses on its own", async () => {
  const { key, sb } = await setup();
  const o = { fetchImpl: sb.fetchImpl };
  const cases = /** @type {[string, Record<string, any>][]} */ ([
    ["iss", { iss: `${PROJECT_URL}/auth/v1` }],
    ["aud", { aud: "anon" }],
    ["role", { role: "anon" }],
    ["role", { role: "service_role" }],
    ["anonymous", { is_anonymous: true }],
    ["anonymous", { is_anonymous: undefined }],
    ["exp", { exp: Math.floor(Date.now() / 1000) - 5 }],
    ["nbf", { nbf: Math.floor(Date.now() / 1000) + 3600 }],
    ["sub", { sub: "not-a-uuid" }],
  ]);
  for (const [reason, claims] of cases) {
    const r = await verifySupabaseJwt(await signJwt(key, claims), project, o);
    assert.deepEqual(r, { ok: false, reason }, JSON.stringify(claims));
  }
  // aud as an array that contains authenticated is fine
  const arr = await verifySupabaseJwt(await signJwt(key, { aud: ["authenticated"] }), project, o);
  assert.equal(arr.ok, true);
});

test("the alg is pinned: HS256, none and RS256 headers are refused before any key lookup", async () => {
  const { key, sb } = await setup();
  for (const alg of ["HS256", "none", "RS256"]) {
    const t = await signJwt(key, {}, { alg });
    const r = await verifySupabaseJwt(t, project, { fetchImpl: sb.fetchImpl });
    assert.deepEqual(r, { ok: false, reason: "alg" });
  }
  assert.equal(sb.calls.length, 0, "no JWKS fetch for a wrong alg");
});

test("a token signed by a different key fails the signature", async () => {
  const { sb } = await setup();
  const stranger = await makeKey("kid-1"); // same kid, different key
  const r = await verifySupabaseJwt(await signJwt(stranger), project, { fetchImpl: sb.fetchImpl });
  assert.deepEqual(r, { ok: false, reason: "signature" });
});

test("a tampered payload fails the signature", async () => {
  const { key, sb } = await setup();
  const [h, , s] = (await signJwt(key)).split(".");
  const forged = btoa(
    JSON.stringify({ sub: "22222222-2222-4222-8222-222222222222", role: "authenticated" }),
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const r = await verifySupabaseJwt(`${h}.${forged}.${s}`, project, { fetchImpl: sb.fetchImpl });
  assert.equal(r.ok, false);
});

test("JWKS: cached across calls, one refetch on an unknown kid, floored at 30 seconds", async () => {
  resetJwksCacheForTests();
  const k1 = await makeKey("kid-1");
  const k2 = await makeKey("kid-2");
  /** @type {Record<string, any[]>} */
  const jwks = { [SANDBOX_REF]: [k1.jwk] };
  const sb = fakeSupabase({ jwks });
  const t0 = 1_800_000_000_000;
  const at = (/** @type {number} */ ms) => ({ fetchImpl: sb.fetchImpl, nowMs: t0 + ms });
  const good = async (/** @type {any} */ k, /** @type {number} */ ms) =>
    signJwt(k, { iat: Math.floor((t0 + ms) / 1000), exp: Math.floor((t0 + ms) / 1000) + 3600 });

  assert.equal((await verifySupabaseJwt(await good(k1, 0), project, at(0))).ok, true);
  assert.equal((await verifySupabaseJwt(await good(k1, 1000), project, at(1000))).ok, true);
  assert.equal(sb.calls.length, 1, "second verify served from cache");

  // a new kid inside the floor: no refetch, refused
  jwks[SANDBOX_REF] = [k1.jwk, k2.jwk];
  assert.deepEqual(await verifySupabaseJwt(await good(k2, 5000), project, at(5000)), {
    ok: false,
    reason: "kid",
  });
  assert.equal(sb.calls.length, 1);
  // past the floor: exactly one refetch, then it verifies
  assert.equal((await verifySupabaseJwt(await good(k2, 31_000), project, at(31_000))).ok, true);
  assert.equal(sb.calls.length, 2);
  // a kid that is nowhere costs at most one refetch per floor window
  const ghost = await makeKey("kid-ghost");
  await verifySupabaseJwt(await good(ghost, 32_000), project, at(32_000));
  await verifySupabaseJwt(await good(ghost, 33_000), project, at(33_000));
  assert.equal(sb.calls.length, 2, "inside the floor, an unknown kid does not refetch");
  // the cache lives at most 10 minutes
  await verifySupabaseJwt(await good(k1, 31_000 + 600_000), project, at(31_000 + 600_000));
  assert.equal(sb.calls.length, 3);
});

test("a JWK that names a different alg, or the wrong curve, is not used", async () => {
  resetJwksCacheForTests();
  const key = await makeKey("kid-1");
  for (const jwk of [{ ...key.jwk, alg: "RS256" }, { ...key.jwk, crv: "P-384" }, { ...key.jwk, use: "enc" }]) {
    resetJwksCacheForTests();
    const sb = fakeSupabase({ jwks: { [SANDBOX_REF]: [jwk] } });
    const r = await verifySupabaseJwt(await signJwt(key), project, { fetchImpl: sb.fetchImpl });
    assert.equal(r.ok, false);
  }
});

test("a JWKS outage is its own reason (the route answers try again, not signed out)", async () => {
  resetJwksCacheForTests();
  const key = await makeKey("kid-1");
  const r = await verifySupabaseJwt(await signJwt(key), project, {
    fetchImpl: async () => new Response("down", { status: 503 }),
  });
  assert.deepEqual(r, { ok: false, reason: "jwks" });
});

test("looksLikeJwt tells a JWT from a GitHub PAT", async () => {
  const key = await makeKey();
  assert.equal(looksLikeJwt(await signJwt(key)), true);
  assert.equal(looksLikeJwt("github_pat_11ABCDEFG0123456789_abcdefghijklmnop"), false);
  assert.equal(looksLikeJwt(null), false);
  assert.equal(looksLikeJwt("a.b"), false);
});

// ---- fix loop 1, item 5 (Red Team R5, probe P2): stale-if-error with a
// 30-second backoff. A JWKS blip never throws away good keys, and an outage
// costs one fetch per 30 seconds, not one per request.
test("R5 P2: JWKS down from the start: 20 requests make one fetch, then one per 30 s", async () => {
  resetJwksCacheForTests();
  const key = await makeKey("kid-1");
  let hits = 0;
  const down = async () => {
    hits++;
    return new Response("down", { status: 500 });
  };
  const t0 = 1_800_000_000_000;
  for (let i = 0; i < 20; i++) {
    const r = await verifySupabaseJwt(await signJwt(key), project, { fetchImpl: down, nowMs: t0 + i * 100 });
    assert.deepEqual(r, { ok: false, reason: "jwks" });
  }
  assert.equal(hits, 1);
  await verifySupabaseJwt(await signJwt(key), project, { fetchImpl: down, nowMs: t0 + 31_000 });
  assert.equal(hits, 2, "the next try waits out the backoff");
});

test("R5: after the TTL a failed refetch keeps the cached keys (stale-if-error) and backs off 30 s", async () => {
  resetJwksCacheForTests();
  const key = await makeKey("kid-1");
  const sb = fakeSupabase({ jwks: { [SANDBOX_REF]: [key.jwk] } });
  let up = true;
  let hits = 0;
  /** @type {(input: string, init?: any) => Promise<Response>} */
  const fetchImpl = async (input, init) => {
    hits++;
    return up ? sb.fetchImpl(input, init) : new Response("down", { status: 503 });
  };
  const t0 = 1_800_000_000_000;
  const tok = async (/** @type {number} */ ms) =>
    signJwt(key, { iat: Math.floor((t0 + ms) / 1000), exp: Math.floor((t0 + ms) / 1000) + 3600 });
  assert.equal((await verifySupabaseJwt(await tok(0), project, { fetchImpl, nowMs: t0 })).ok, true);
  up = false;
  const late = 11 * 60 * 1000;
  for (let i = 0; i < 10; i++) {
    const r = await verifySupabaseJwt(await tok(late + i), project, { fetchImpl, nowMs: t0 + late + i * 1000 });
    assert.equal(r.ok, true, "the held key still verifies during the blip");
  }
  assert.equal(hits, 2, "one failed refetch, then the backoff");
  up = true;
  await verifySupabaseJwt(await tok(late + 40_000), project, { fetchImpl, nowMs: t0 + late + 40_000 });
  assert.equal(hits, 3, "after the backoff it fetches again and recovers");
  await verifySupabaseJwt(await tok(late + 41_000), project, { fetchImpl, nowMs: t0 + late + 41_000 });
  assert.equal(hits, 3, "fresh again: served from the cache");
});

// fix loop 1, item 9: the mutation-killing tests for this file's sources
import { jwtKills } from "./_mutation-kills.js";
jwtKills(test);
