// Mise 2.0 fix loop 1, item 8 (Engineer F7): the app sends the Worker the
// credential it can read. GitHub shell: the PAT, as 1.95. Supabase shell: the
// session's access token, BARE in x-mise-auth (the backend's authHeader is
// "Bearer <jwt>"). The Worker also takes an optional "Bearer " prefix off.
// No real project, key or network: a fake backend, a fake fetch.
import test from "node:test";
import assert from "node:assert/strict";
import { workerAuth, liveRemedy } from "../app/lib/worker.js";
import { installBackend } from "../app/lib/backend.js";
import worker, { resetGuestCachesForTests } from "../worker/src/index.js";
import { resetJwksCacheForTests } from "../worker/src/jwt.js";
import { resetAuthCachesForTests, bareAuth } from "../worker/src/auth.js";
import { makeKey, signJwt, fakeSupabase, withFetch, workerReq, SANDBOX_ENV, SANDBOX_REF } from "./supabase-fakes.js";

const PAT = "github_pat_PLACEHOLDER0000000000";

/** @param {"supabase" | null} meta @param {Record<string, string>} ls */
function shell(meta, ls = {}) {
  const g = /** @type {any} */ (globalThis);
  const saved = { document: g.document, localStorage: g.localStorage, navigator: Object.getOwnPropertyDescriptor(g, "navigator") };
  g.document = { querySelector: () => (meta ? { getAttribute: () => meta } : null) };
  const m = new Map(Object.entries(ls));
  g.localStorage = {
    getItem: (/** @type {string} */ k) => m.get(k) ?? null,
    setItem: (/** @type {string} */ k, /** @type {string} */ v) => void m.set(k, v),
    removeItem: (/** @type {string} */ k) => void m.delete(k),
  };
  Object.defineProperty(g, "navigator", { value: { onLine: true }, configurable: true });
  return () => {
    g.document = saved.document;
    g.localStorage = saved.localStorage;
    if (saved.navigator) Object.defineProperty(g, "navigator", saved.navigator);
    installBackend(null);
  };
}

/** @param {string | null} header */
const fakeBackend = (header) => /** @type {any} */ ({ name: "supabase", authHeader: async () => header });

test("GitHub shell: the PAT, exactly as 1.95", async () => {
  const done = shell(null, { "mise.pat": PAT, "mise.pat.savedAt": "2026-10-01T00:00:00Z" });
  try {
    assert.equal(await workerAuth(), PAT);
  } finally {
    done();
  }
});

test("Supabase shell: the bare access token, never the PAT; locked or signed out is null", async () => {
  const done = shell("supabase", { "mise.pat": PAT });
  try {
    installBackend(fakeBackend("Bearer aaa.bbb.ccc"));
    assert.equal(await workerAuth(), "aaa.bbb.ccc");
    installBackend(fakeBackend(null));
    assert.equal(await workerAuth(), null, "a PAT left in storage is not sent from a Supabase shell");
    await assert.rejects(liveRemedy("x"), /sign in first/);
  } finally {
    done();
  }
});

test("Supabase shell end to end: what post() sends is what the Worker verifies", async () => {
  resetJwksCacheForTests();
  resetAuthCachesForTests();
  resetGuestCachesForTests();
  const key = await makeKey("kid-1");
  const jwt = await signJwt(key);
  const sb = fakeSupabase({ jwks: { [SANDBOX_REF]: [key.jwk] }, rpc: { entitled: () => true, ai_take: () => "ok" } });
  const done = shell("supabase");
  /** @type {string | null} */
  let sent = null;
  try {
    installBackend(fakeBackend(`Bearer ${jwt}`));
    await withFetch(
      async (/** @type {any} */ input, /** @type {any} */ init) => {
        if (String(input).startsWith("https://mise-worker.")) {
          sent = init.headers["x-mise-auth"];
          return Response.json({ protocol: { steps: [] } });
        }
        return sb.fetchImpl(input, init);
      },
      async () => {
        await liveRemedy("headache");
      },
    );
    assert.equal(sent, jwt, "bare JWT in x-mise-auth");
    await withFetch(sb.fetchImpl, async () => {
      const env = { ...SANDBOX_ENV, ANTHROPIC_API_KEY: "sk-PLACEHOLDER" };
      const bare = await worker.fetch(workerReq("/scan", {}, { auth: /** @type {any} */ (sent) }), env);
      assert.equal(bare.status, 400, "past auth, at body validation");
      const prefixed = await worker.fetch(workerReq("/scan", {}, { auth: `Bearer ${jwt}` }), env);
      assert.equal(prefixed.status, 400, "the Worker takes the prefix off too");
    });
  } finally {
    done();
  }
});

test("bareAuth: only a leading Bearer is removed", () => {
  assert.equal(bareAuth(null), null);
  assert.equal(bareAuth("Bearer a.b.c"), "a.b.c");
  assert.equal(bareAuth("bearer  a.b.c"), "a.b.c");
  assert.equal(bareAuth(PAT), PAT);
});
