// RED TEAM gate 20 probe S1-W: a flush already in flight when supabase-js
// switches to B keeps pushing A's queue under B's JWT until the lock is taken.
import test from "node:test";
import assert from "node:assert/strict";
import { idb, kv, settle } from "./helpers/fake-browser.js";
import { fakeSupabase } from "./helpers/fake-supabase.js";

const backendMod = await import("../app/lib/backend.js");
const { createSupabaseAdapter } = await import("../app/lib/backend/supabase-adapter.js");
const store = await import("../app/lib/store.js");
const { createSessionBoot } = await import("../app/lib/session-boot.js");

const PEOPLE = {
  A: { slug: "housemate-1", admin: false, home: "house-a" },
  B: { slug: "kin-9", admin: false, home: "house-b" },
};

test("S1-W: A's queued writes go out under B's token while adopt(B) waits for the lock", { timeout: 15000 }, async () => {
  idb.clear(); kv.clear(); store.resetFileChecks(); backendMod.installBackend(null);
  const state = /** @type {any} */ ({ jwt: "A", who: PEOPLE, offline: true });
  /** @type {{ user: string, path: string }[]} */
  const writes = [];
  let stall = /** @type {null | (() => void)} */ (null);
  let stallNext = false;
  // the server: B may not write A's files (another house)
  const sb = fakeSupabase({
    canWrite: (p) => !(state.jwt === "B" && p.includes("housemate-1")),
    failWith: (op) => (op === "write_doc" && state.offline ? { status: 0, message: "offline" } : null),
  });
  let handler = /** @type {any} */ (null);
  const client = {
    from: (/** @type {string} */ t) => sb.client.from(t),
    rpc: async (/** @type {string} */ name, /** @type {any} */ args) => {
      if (name === "whoami") return { data: state.who[state.jwt], error: null };
      if (name === "write_doc") {
        // who a request is from is fixed when it is sent (the adapter pins
        // the Authorization header), not when its answer comes back
        writes.push({ user: state.jwt, path: args?.p_path });
        if (stallNext) { stallNext = false; await new Promise((r) => (stall = () => r(undefined))); }
      }
      return sb.client.rpc(name, args);
    },
    auth: {
      onAuthStateChange: (/** @type {any} */ cb) => (handler = cb),
      getSession: async () => ({ data: { session: { user: { id: "uA" }, access_token: "tA" } } }),
      signOut: async () => {},
    },
  };
  const boot = createSessionBoot({
    client, project: { stamp: "supabase", label: "live" }, storage: null,
    seam: {
      installBackend: backendMod.installBackend, lockedBackend: backendMod.lockedBackend, createSupabaseAdapter,
      onSessionChange: store.onSessionChange, resetFileChecks: store.resetFileChecks,
      flushNow: () => store.flushNow({ timeoutMs: 300 }), purgeEverything: store.purgeEverything,
      refusedRecords: store.refusedRecords, discardRefused: store.discardRefused, canSwitchProfile: store.canSwitchProfile,
      acquireStoreLock: () => store.acquireStoreLock({ timeoutMs: 5000 }),
    },
  });
  assert.equal(await boot.boot(), "signed-in");
  const paths = ["profiles/housemate-1/occasions.json", "profiles/housemate-1/shopping.json", "profiles/housemate-1/pantry.json"];
  for (const [i, p] of paths.entries()) await store.write(p, { note: `A ${i}` }, { raw: true });
  await settle(10);
  // back online; the first push stalls (slow network)
  state.offline = false; stallNext = true;
  const f = store.flushNow({ timeoutMs: 4000 });
  await settle(10);
  assert.ok(stall, "first push in flight");
  // B opens an invite link on A's phone: supabase-js holds B's session at once
  state.jwt = "B";
  handler("SIGNED_IN", { user: { id: "uB" }, access_token: "tB" });
  await settle(5);
  /** @type {any} */ (stall)();
  await f; await settle(60);
  const underB = writes.filter((w) => w.user === "B" && w.path.includes("housemate-1"));
  assert.deepEqual((await store.refusedRecords()).filter((r) => r.reason === "forbidden"), [], "nothing refused for good");
  // A comes back: do A's edits ever land?
  state.jwt = "A";
  handler("SIGNED_IN", { user: { id: "uA" }, access_token: "tA" });
  await settle(80);
  await store.flushNow({ timeoutMs: 500 }); await settle(40);
  const landedA = paths.filter((p) => sb.docs.get(p)?.data?.note?.startsWith("A"));
  backendMod.installBackend(null);
  assert.deepEqual(underB, [], "A's queued writes never go out under B's token");
  assert.equal(landedA.length, 3, "all of A's edits land once A is back");
});
