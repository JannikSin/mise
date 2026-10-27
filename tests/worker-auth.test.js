// Mise 2.0 F1 (plan section 1 B1 and E4): who may call the Worker once a
// branch is switched to Supabase. Driven through worker.fetch() against an
// in-memory Supabase and an in-memory GitHub; no real project, no real key.
import test from "node:test";
import assert from "node:assert/strict";
import worker, { resetGuestCachesForTests } from "../worker/src/index.js";
import { resetJwksCacheForTests } from "../worker/src/jwt.js";
import {
  resetAuthCachesForTests,
  PAT_QUOTA_USER,
  authenticate,
  takeAiQuota,
} from "../worker/src/auth.js";
import {
  makeKey,
  signJwt,
  fakeSupabase,
  withFetch,
  workerReq,
  SANDBOX_ENV,
  SANDBOX_REF,
  USER_A,
  PROJECT_URL,
  PROJECT_REF,
} from "./supabase-fakes.js";

const PAT = "github_pat_PLACEHOLDER0000000000";
const LIVE = "https://janniksin.github.io";

/** GitHub answering "this token sees the private data repo" */
const github = async (/** @type {any} */ input) => {
  const url = new URL(String(input));
  if (url.host === "api.github.com" && url.pathname === "/repos/JannikSin/mise-data") {
    return Response.json({ private: true });
  }
  return new Response("not found", { status: 404 });
};

/**
 * @param {{ entitled?: boolean, take?: string | ((a: any) => any) }} [o]
 */
async function world(o = {}) {
  resetJwksCacheForTests();
  resetAuthCachesForTests();
  resetGuestCachesForTests();
  const key = await makeKey("kid-1");
  /** @type {any[]} */
  const takes = [];
  const sb = fakeSupabase({
    jwks: { [SANDBOX_REF]: [key.jwk], [PROJECT_REF]: [key.jwk] },
    rpc: {
      entitled: () => o.entitled ?? true,
      ai_take: (a) => {
        takes.push(a);
        return typeof o.take === "function" ? o.take(a) : (o.take ?? "ok");
      },
    },
    other: github,
  });
  return { key, sb, takes };
}

const SCAN_ENV = { ...SANDBOX_ENV, ANTHROPIC_API_KEY: "sk-PLACEHOLDER" };

test("no Supabase config: the Worker is 1.95, a JWT is just an unknown token", async () => {
  const { key, sb } = await world();
  await withFetch(sb.fetchImpl, async () => {
    const jwt = await signJwt(key);
    const r = await worker.fetch(workerReq("/scan", {}, { auth: jwt }), { ANTHROPIC_API_KEY: "x" });
    assert.equal(r.status, 401);
    // the PAT still reaches the route (400 = past auth, at body validation)
    const p = await worker.fetch(workerReq("/scan", {}, { auth: PAT }), { ANTHROPIC_API_KEY: "x" });
    assert.equal(p.status, 400);
  });
  assert.equal(sb.calls.filter((c) => c.fn).length, 0, "no Supabase call at all");
});

test("a JWT on a switched branch reaches the AI route after entitlement and quota", async () => {
  const { key, sb, takes } = await world();
  await withFetch(sb.fetchImpl, async () => {
    const r = await worker.fetch(workerReq("/scan", {}, { auth: await signJwt(key) }), SCAN_ENV);
    assert.equal(r.status, 400, "past auth and quota, refused only for the missing image");
  });
  assert.equal(takes.length, 1);
  assert.equal(takes[0].p_user, USER_A);
  assert.equal(takes[0].p_weight, 1);
  assert.equal(takes[0].p_user_cap, 80);
  assert.equal(takes[0].p_global_cap, 600);
  // the secret key goes to svc, in the svc schema
  const call = sb.calls.find((c) => c.fn === "ai_take");
  assert.equal(call?.headers.get("content-profile"), "svc");
  assert.equal(call?.headers.get("apikey"), "sb_secret_PLACEHOLDER");
});

test("entitlement: false is 403, and the answer is cached for 5 minutes", async () => {
  const { key, sb } = await world({ entitled: false });
  await withFetch(sb.fetchImpl, async () => {
    const jwt = await signJwt(key);
    const a = await worker.fetch(workerReq("/scan", {}, { auth: jwt }), SCAN_ENV);
    const b = await worker.fetch(workerReq("/scan", {}, { auth: jwt }), SCAN_ENV);
    assert.equal(a.status, 403);
    assert.equal(b.status, 403);
  });
  assert.equal(sb.calls.filter((c) => c.fn === "entitled").length, 1);
  assert.equal(sb.calls.filter((c) => c.fn === "ai_take").length, 0, "no quota for the unentitled");
});

test("entitlement cache expires after 5 minutes", async () => {
  const { key, sb } = await world();
  const t0 = Date.now();
  const jwt = await signJwt(key);
  const project = { branch: "sandbox", pathname: "/scan", env: SANDBOX_ENV, fetchImpl: sb.fetchImpl };
  const patCheck = async () => "no";
  await authenticate({ token: jwt, ...project, branch: "sandbox", patCheck, nowMs: t0 });
  await authenticate({ token: jwt, ...project, branch: "sandbox", patCheck, nowMs: t0 + 299_000 });
  assert.equal(sb.calls.filter((c) => c.fn === "entitled").length, 1);
  await authenticate({ token: jwt, ...project, branch: "sandbox", patCheck, nowMs: t0 + 301_000 });
  assert.equal(sb.calls.filter((c) => c.fn === "entitled").length, 2);
});

test("quota: a spent personal or global allowance is 429 with no model call", async () => {
  for (const which of ["user", "global"]) {
    const { key, sb } = await world({ take: which });
    let modelCalls = 0;
    const f = async (/** @type {any} */ i, /** @type {any} */ n) => {
      if (String(i).includes("anthropic")) modelCalls++;
      return sb.fetchImpl(i, n);
    };
    await withFetch(f, async () => {
      const r = await worker.fetch(
        workerReq("/scan", { image: "aGk=", mediaType: "image/jpeg" }, { auth: await signJwt(key) }),
        SCAN_ENV,
      );
      assert.equal(r.status, 429);
      const body = await r.json();
      assert.match(body.error, which === "user" ? /you have used/ : /kitchen's AI allowance/);
    });
    assert.equal(modelCalls, 0);
  }
});

test("quota: an unreachable allowance fails CLOSED", async () => {
  const { key, sb } = await world({
    take: () => Response.json({ message: "boom" }, { status: 500 }),
  });
  await withFetch(sb.fetchImpl, async () => {
    const r = await worker.fetch(workerReq("/scan", {}, { auth: await signJwt(key) }), SCAN_ENV);
    assert.equal(r.status, 503);
  });
});

test("quota weights: annotate 4, transcribe 2; caps come from env", async () => {
  const { key, sb, takes } = await world();
  const env = { ...SCAN_ENV, AI_DAILY_PER_USER: "10", AI_DAILY_GLOBAL: "50" };
  const who = /** @type {any} */ ({
    kind: "jwt",
    sub: USER_A,
    jwt: await signJwt(key),
    project: { url: `https://${SANDBOX_REF}.supabase.co`, secret: "s", ref: SANDBOX_REF },
  });
  for (const pathname of ["/annotate", "/transcribe", "/dinner", "/kroger/search", "/invite/new"]) {
    const r = await takeAiQuota({ who, branch: "sandbox", pathname, env, fetchImpl: sb.fetchImpl });
    assert.equal(r.ok, true);
  }
  assert.deepEqual(
    takes.map((t) => t.p_weight),
    [4, 2, 1],
    "non-AI routes are not metered",
  );
  assert.equal(takes[0].p_user_cap, 10);
  assert.equal(takes[0].p_global_cap, 50);
});

test("PAT on a switched branch: AI routes only, under the one shared quota", async () => {
  const { sb, takes } = await world();
  await withFetch(sb.fetchImpl, async () => {
    const ai = await worker.fetch(workerReq("/scan", {}, { auth: PAT }), SCAN_ENV);
    assert.equal(ai.status, 400, "the AI route still works on the old key");
    for (const path of ["/invite/new", "/annotate-save", "/notify-test", "/kroger/search", "/hall/day"]) {
      const r = await worker.fetch(workerReq(path, {}, { auth: PAT }), SCAN_ENV);
      assert.equal(r.status, 401, path);
      assert.match((await r.json()).error, /sign in to your account/);
    }
  });
  assert.equal(takes.length, 1);
  assert.equal(takes[0].p_user, PAT_QUOTA_USER);
});

test("PAT on a switched branch stops after PAT_AUTH_UNTIL", async () => {
  const { sb } = await world();
  const r = await authenticate({
    token: PAT,
    branch: "sandbox",
    pathname: "/scan",
    env: { ...SANDBOX_ENV, PAT_AUTH_UNTIL: "2026-11-22" },
    patCheck: async () => "ok",
    fetchImpl: sb.fetchImpl,
    nowMs: Date.parse("2026-11-23T18:00:00Z"),
  });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.status, 401);
  const before = await authenticate({
    token: PAT,
    branch: "sandbox",
    pathname: "/scan",
    env: { ...SANDBOX_ENV, PAT_AUTH_UNTIL: "2026-11-22" },
    patCheck: async () => "ok",
    nowMs: Date.parse("2026-11-22T18:00:00Z"),
  });
  assert.equal(before.ok, true);
});

test("the PAT on a branch still on GitHub is untouched while the sandbox is switched", async () => {
  const { sb, takes } = await world();
  await withFetch(sb.fetchImpl, async () => {
    const r = await worker.fetch(workerReq("/kroger/search", { term: "" }, { auth: PAT, origin: LIVE }), SCAN_ENV);
    assert.notEqual(r.status, 401);
  });
  assert.equal(takes.length, 0, "live PAT is not metered before its switch");
});

test("a sandbox token does not work on live, even when both are switched", async () => {
  const { key, sb } = await world();
  const env = {
    ...SCAN_ENV,
    SUPABASE_BACKEND: "sandbox,main",
    SUPABASE_URL: PROJECT_URL,
    SUPABASE_SECRET_KEY: "sb_secret_PLACEHOLDER_LIVE",
  };
  await withFetch(sb.fetchImpl, async () => {
    const sandboxToken = await signJwt(key); // iss = the sandbox project
    const r = await worker.fetch(workerReq("/scan", {}, { auth: sandboxToken, origin: LIVE }), env);
    assert.equal(r.status, 401);
    const liveToken = await signJwt(key, {}, {}, `${PROJECT_URL}/auth/v1`);
    const ok = await worker.fetch(workerReq("/scan", {}, { auth: liveToken, origin: LIVE }), env);
    assert.equal(ok.status, 400);
  });
});

test("switched but half-configured: 503, never a quiet fallback to GitHub", async () => {
  const { key, sb } = await world();
  await withFetch(sb.fetchImpl, async () => {
    const env = { SUPABASE_BACKEND: "sandbox", ANTHROPIC_API_KEY: "x" };
    const r = await worker.fetch(workerReq("/scan", {}, { auth: await signJwt(key) }), env);
    assert.equal(r.status, 503);
  });
});

test("rate limiting for a JWT is keyed by the person, not the token string", async () => {
  const { key, sb } = await world();
  await withFetch(sb.fetchImpl, async () => {
    let last = 0;
    for (let i = 0; i < 40; i++) {
      // a fresh token each time (as an hourly refresh would give)
      const jwt = await signJwt(key, { iat: Math.floor(Date.now() / 1000) - i });
      const r = await worker.fetch(workerReq("/scan", {}, { auth: jwt }), SCAN_ENV);
      last = r.status;
      if (last === 429) break;
    }
    assert.equal(last, 429);
  });
});
