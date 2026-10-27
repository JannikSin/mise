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
  GLOBAL_QUOTA_USER,
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
 * @param {{ entitled?: boolean, offset?: Record<string, number>, fail?: boolean }} [o]
 */
async function world(o = {}) {
  resetJwksCacheForTests();
  resetAuthCachesForTests();
  resetGuestCachesForTests();
  const key = await makeKey("kid-1");
  /** @type {any[]} */
  const takes = [];
  /** @type {Record<string, number>} */
  const counts = {};
  const sb = fakeSupabase({
    jwks: { [SANDBOX_REF]: [key.jwk], [PROJECT_REF]: [key.jwk] },
    rpc: {
      entitled: () => o.entitled ?? true,
      ai_count: (a) => {
        takes.push(a);
        if (o.fail) return Response.json({ message: "boom" }, { status: 500 });
        counts[a.p_sub] = (counts[a.p_sub] ?? 0) + 1;
        return counts[a.p_sub] + (o.offset?.[a.p_sub] ?? 0);
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
  assert.deepEqual(
    takes.map((t) => t.p_sub),
    [USER_A, GLOBAL_QUOTA_USER],
    "one slot on the person's row, then one on the global row",
  );
  // the secret key goes to svc, in the svc schema
  const call = sb.calls.find((c) => c.fn === "ai_count");
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
  assert.equal(sb.calls.filter((c) => c.fn === "ai_count").length, 0, "no quota for the unentitled");
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
    const { key, sb, takes } = await world({
      offset: which === "user" ? { [USER_A]: 80 } : { [GLOBAL_QUOTA_USER]: 600 },
    });
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
    if (which === "user") {
      assert.equal(takes.some((t) => t.p_sub === GLOBAL_QUOTA_USER), false, "over your own: the global row is not spent");
    }
  }
});

test("quota: an unreachable allowance fails CLOSED", async () => {
  const { key, sb } = await world({ fail: true });
  await withFetch(sb.fetchImpl, async () => {
    const r = await worker.fetch(workerReq("/scan", {}, { auth: await signJwt(key) }), SCAN_ENV);
    assert.equal(r.status, 503);
  });
});

test("quota weights: annotate 4, transcribe 2; caps come from env", async () => {
  const { key, sb, takes } = await world({ offset: { [USER_A]: 0 } });
  const env = { ...SCAN_ENV, AI_DAILY_PER_USER: "10", AI_DAILY_GLOBAL: "50" };
  const who = /** @type {any} */ ({
    kind: "jwt",
    sub: USER_A,
    jwt: await signJwt(key),
    project: { url: `https://${SANDBOX_REF}.supabase.co`, secret: "s", ref: SANDBOX_REF },
  });
  for (const pathname of ["/annotate", "/transcribe", "/dinner", "/kroger/search", "/invite/new"]) {
    const r = await takeAiQuota({ who, branch: "sandbox", pathname, env, fetchImpl: sb.fetchImpl });
    assert.equal(r.ok, true, pathname);
  }
  const mine = takes.filter((t) => t.p_sub === USER_A).length;
  assert.equal(mine, 4 + 2 + 1, "non-AI routes are not metered");
  // the 11th slot passes the per-person cap of 10
  const over = await takeAiQuota({ who, branch: "sandbox", pathname: "/annotate", env, fetchImpl: sb.fetchImpl });
  assert.equal(over.ok, false);
  assert.equal(!over.ok && over.status, 429);
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
  assert.deepEqual(
    takes.map((t) => t.p_sub),
    [PAT_QUOTA_USER, GLOBAL_QUOTA_USER],
  );
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

// ---- fix loop 1, item 1 (Red Team R1): the local dev origin owns no branch,
// and it is no way around the PAT cutoff or the quota. Probes P1 and P1b.
const LOCAL = "http://127.0.0.1:8378";
const BOTH_PAST = {
  ...SCAN_ENV,
  SUPABASE_BACKEND: "sandbox,main",
  SUPABASE_URL: PROJECT_URL,
  SUPABASE_SECRET_KEY: "sb_secret_PLACEHOLDER_LIVE",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_PLACEHOLDER",
  PAT_AUTH_UNTIL: "2020-01-01",
};

test("R1 P1: past the cutoff, the local dev origin is refused like the live one (deployed, no ALLOW_DEV_ORIGIN)", async () => {
  const { sb } = await world();
  await withFetch(sb.fetchImpl, async () => {
    const live = await worker.fetch(workerReq("/scan", {}, { auth: PAT, origin: LIVE }), BOTH_PAST);
    assert.equal(live.status, 401);
    const local = await worker.fetch(workerReq("/scan", {}, { auth: PAT, origin: LOCAL }), BOTH_PAST);
    assert.equal(local.status, 403, "the deployed Worker refuses an origin with no branch once switched");
  });
  assert.equal(sb.calls.filter((c) => c.fn).length, 0);
});

test("R1 P1, with ALLOW_DEV_ORIGIN: the local origin's PAT still meets the cutoff", async () => {
  const { sb } = await world();
  const env = { ...BOTH_PAST, ALLOW_DEV_ORIGIN: "1" };
  await withFetch(sb.fetchImpl, async () => {
    const local = await worker.fetch(workerReq("/scan", {}, { auth: PAT, origin: LOCAL }), env);
    assert.equal(local.status, 401, "after PAT_AUTH_UNTIL, whatever the origin");
  });
});

test("R1 P1b: the local origin's PAT is AI-only once switched (annotate-save refused)", async () => {
  const { sb } = await world();
  const env = { ...BOTH_PAST, PAT_AUTH_UNTIL: "2099-01-01", ALLOW_DEV_ORIGIN: "1" };
  await withFetch(sb.fetchImpl, async () => {
    const r = await worker.fetch(workerReq("/annotate-save", {}, { auth: PAT, origin: LOCAL }), env);
    assert.equal(r.status, 401);
    assert.match((await r.json()).error, /sign in to your account/);
  });
});

test("R1: the local origin's PAT on an AI route is metered on main's shared and global rows", async () => {
  const { sb, takes } = await world();
  const env = { ...BOTH_PAST, PAT_AUTH_UNTIL: "2099-01-01", ALLOW_DEV_ORIGIN: "1" };
  await withFetch(sb.fetchImpl, async () => {
    const r = await worker.fetch(workerReq("/scan", {}, { auth: PAT, origin: LOCAL }), env);
    assert.equal(r.status, 400, "past auth and quota, at body validation");
  });
  assert.deepEqual(
    takes.map((t) => t.p_sub),
    [PAT_QUOTA_USER, GLOBAL_QUOTA_USER],
  );
  const hosts = sb.calls.filter((c) => c.fn === "ai_count").map((c) => new URL(c.url).host.split(".")[0]);
  assert.ok(hosts.length === 2 && hosts.every((h) => h === PROJECT_REF), `metered on main: ${hosts}`);
});

test("R1: sandbox-only switch meters the local origin's PAT on the sandbox; nothing switched is 1.95", async () => {
  const q = await takeAiQuota({
    who: { kind: "pat", token: PAT },
    branch: null,
    pathname: "/scan",
    env: { SUPABASE_BACKEND: "" },
  });
  assert.deepEqual(q, { ok: true }, "nothing switched: no quota");
  const { sb, takes } = await world();
  await withFetch(sb.fetchImpl, async () => {
    const r = await worker.fetch(
      workerReq("/scan", {}, { auth: PAT, origin: LOCAL }),
      { ...SCAN_ENV, ALLOW_DEV_ORIGIN: "1" },
    );
    assert.equal(r.status, 400);
  });
  assert.equal(takes.length, 2);
  assert.ok(sb.calls.filter((c) => c.fn === "ai_count").every((c) => new URL(c.url).host.startsWith(SANDBOX_REF + ".")));
  // nothing switched: the local origin is 1.95, no refusal, no Supabase call
  const w2 = await world();
  await withFetch(w2.sb.fetchImpl, async () => {
    const r = await worker.fetch(workerReq("/scan", {}, { auth: PAT, origin: LOCAL }), { ANTHROPIC_API_KEY: "x" });
    assert.equal(r.status, 400);
  });
  assert.equal(w2.sb.calls.filter((c) => c.fn).length, 0);
});

test("R1: authenticate judges a branchless PAT as switched once any branch is", async () => {
  const r = await authenticate({
    token: PAT,
    branch: null,
    pathname: "/annotate-save",
    env: { SUPABASE_BACKEND: "sandbox" },
    patCheck: async () => "ok",
  });
  assert.equal(r.ok, false);
});
