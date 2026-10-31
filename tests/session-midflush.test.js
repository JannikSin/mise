// gate20 Engineer E1 (fixed): the supabase-js JWT flips at sign-in/sign-out time,
// BEFORE the store hears of it. A flush pass already in flight keeps going
// (alive() checks only the store epoch and installed backend) while the
// session-boot waits for the store lock. Its next records go out under the
// NEW credential.
import test from "node:test";
import assert from "node:assert/strict";
import { idb, kv, settle } from "./helpers/fake-browser.js";
import { fakeSupabase } from "./helpers/fake-supabase.js";

const backendMod = await import("../app/lib/backend.js");
const { createSupabaseAdapter } = await import("../app/lib/backend/supabase-adapter.js");
const store = await import("../app/lib/store.js");
const { createSessionBoot } = await import("../app/lib/session-boot.js");

const A = { slug: "housemate-1", admin: false, home: "house-a" };
const B = { slug: "student-1", admin: false, home: "house-b" };

function harness() {
  const state = /** @type {any} */ ({ jwt: "A", hang: true, release: null });
  const sb = fakeSupabase({});
  /** @type {{ user: string, path: string }[]} */
  const sent = [];
  /** @type {any} */ let handler = null;
  const client = {
    from: (/** @type {string} */ t) => sb.client.from(t),
    rpc: async (/** @type {string} */ name, /** @type {any} */ args) => {
      if (name === "whoami") return { data: state.jwt === "A" ? A : state.jwt === "B" ? B : null, error: null };
      if (name === "write_doc") {
        const as = state.jwt;
        sent.push({ user: as, path: args?.p_path });
        if (state.hang) { state.hang = false; await new Promise((r) => (state.release = r)); }
        // the database's answer as that credential
        if (as === "anon") return { data: null, error: { code: "42501", message: "permission denied for function write_doc" } };
        if (as === "B" && !String(args?.p_path).includes("house-b") && !String(args?.p_path).includes("student-1"))
          return { data: null, error: { code: "P0403", message: "mise_forbidden" } };
      }
      return sb.client.rpc(name, args);
    },
    auth: {
      onAuthStateChange: (/** @type {any} */ cb) => (handler = cb),
      getSession: async () => ({ data: { session: { user: { id: "uA" }, access_token: "tA" } } }),
      signOut: async () => { state.jwt = "anon"; },
    },
  };
  const boot = createSessionBoot({
    client, project: { stamp: "supabase", label: "live" }, storage: null,
    seam: {
      installBackend: backendMod.installBackend, lockedBackend: backendMod.lockedBackend, createSupabaseAdapter,
      onSessionChange: store.onSessionChange, resetFileChecks: store.resetFileChecks,
      flushNow: () => store.flushNow({ timeoutMs: 300 }), purgeEverything: store.purgeEverything,
      refusedRecords: store.refusedRecords, discardRefused: store.discardRefused,
      canSwitchProfile: store.canSwitchProfile, acquireStoreLock: () => store.acquireStoreLock({ timeoutMs: 2000 }),
    },
  });
  return { state, sb, sent, boot, fire: (/** @type {any[]} */ ...a) => handler(...a) };
}

test("E1a: SIGN OUT while a flush is in flight: A's later queued writes are sent with no session and end REFUSED", async () => {
  idb.clear(); kv.clear(); store.resetFileChecks(); backendMod.installBackend(null);
  const h = harness();
  h.state.hang = false;
  assert.equal(await h.boot.boot(), "signed-in");
  // A queues three edits offline
  /** @type {any} */ (globalThis.navigator).onLine = false;
  await store.write("profiles/housemate-1/occasions.json", { n: 1 }, { raw: true });
  await store.write("profiles/housemate-1/pantry.json", { n: 2 }, { raw: true });
  await store.write("households/house-a/events.json", { n: 3 }, { raw: true });
  await settle();
  /** @type {any} */ (globalThis.navigator).onLine = true;
  h.state.hang = true;
  const f = store.flushNow({ timeoutMs: 3000 });
  await settle(5);
  // A taps SIGN OUT: supabase-js drops the session at once; the boot waits for the lock
  const so = h.boot.signOut();
  await settle(5);
  h.state.release?.();
  await f; await so; await settle(40);
  const anon = h.sent.filter((s) => s.user === "anon");
  // held for A (reason "account") is right; refused "forbidden" would be lost
  assert.deepEqual((await store.refusedRecords()).filter((r) => r.reason === "forbidden"), [], "nothing refused by the sign-out");
  // A signs back in (same phone, signal fine): are the writes pushed?
  h.state.jwt = "A";
  assert.equal(await h.boot.adopt({ user: { id: "uA" }, access_token: "tA2" }), "signed-in");
  await store.flushNow({ timeoutMs: 500 }); await settle(40);
  const after = await store.refusedRecords();
  assert.deepEqual(anon, [], "no write goes out after the session is gone");
  assert.deepEqual(after.map((r) => r.path), [], "nothing of A's is left refused once A is back");
});

test("E1b: an invite link for B opened mid-flush: A's queued writes go out under B's JWT", async () => {
  idb.clear(); kv.clear(); store.resetFileChecks(); backendMod.installBackend(null);
  const h = harness();
  h.state.hang = false;
  assert.equal(await h.boot.boot(), "signed-in");
  /** @type {any} */ (globalThis.navigator).onLine = false;
  await store.write("profiles/housemate-1/occasions.json", { n: 1 }, { raw: true });
  await store.write("profiles/housemate-1/pantry.json", { n: 2 }, { raw: true });
  await settle();
  /** @type {any} */ (globalThis.navigator).onLine = true;
  h.state.hang = true;
  const f = store.flushNow({ timeoutMs: 3000 });
  await settle(5);
  h.state.jwt = "B";                // verifyOtp saved B's session
  h.fire("SIGNED_IN", { user: { id: "uB" }, access_token: "tB" });
  await settle(5);
  h.state.release?.();
  await f; await settle(60);
  assert.deepEqual(h.sent.filter((s) => s.user === "B" && s.path.includes("housemate-1")), [], "A's write never goes out as B");
});

test("E1: every adapter request carries the adopted token, whatever the client's own session", async () => {
  /** @type {string[]} */
  const auth = [];
  const q = () => {
    /** @type {any} */
    const b = {
      setHeader: (/** @type {string} */ k, /** @type {string} */ v) => (k === "Authorization" && auth.push(v), b),
      then: (/** @type {any} */ ok) => Promise.resolve({ data: null, error: null }).then(ok),
      select: () => b, eq: () => b, like: () => b, maybeSingle: () => b,
    };
    return b;
  };
  const client = { from: () => q(), rpc: () => q() };
  const ad = createSupabaseAdapter({
    client, stamp: "supabase", accessToken: () => "tokA",
    session: () => ({ slug: "housemate-1", admin: false, home: "house-a" }),
  });
  await ad.read("profiles/housemate-1/pantry.json").catch(() => {});
  await ad.write("profiles/housemate-1/pantry.json", { n: 1 }).catch(() => {});
  assert.ok(auth.length >= 2, "each request set its own Authorization");
  assert.ok(auth.every((v) => v === "Bearer tokA"));
});

test("an expired pinned token is resent once with the refreshed one (gate20 loop 2)", async () => {
  /** @type {string[]} */
  const sent = [];
  let tok = "old";
  const q = () => {
    /** @type {string} */ let auth = "";
    /** @type {any} */
    const b = {
      setHeader: (/** @type {string} */ k, /** @type {string} */ v) => ((auth = v), b),
      then: (/** @type {any} */ ok) => {
        sent.push(auth);
        // supabase-js refreshes during the request; the old token is refused
        if (auth === "Bearer old") {
          tok = "new";
          return Promise.resolve({ data: null, error: { status: 401, code: "PGRST301", message: "JWT expired" } }).then(ok);
        }
        return Promise.resolve({ data: { data: { n: 1 }, rev: 2 }, error: null }).then(ok);
      },
      select: () => b, eq: () => b, maybeSingle: () => b,
    };
    return b;
  };
  const ad = createSupabaseAdapter({
    client: { from: () => q(), rpc: () => q() },
    stamp: "supabase",
    accessToken: () => tok,
    session: () => ({ slug: "housemate-1", admin: false, home: "house-a" }),
  });
  const got = await ad.read("profiles/housemate-1/pantry.json");
  assert.deepEqual(sent, ["Bearer old", "Bearer new"]);
  assert.ok(got, "the resend landed");
});
