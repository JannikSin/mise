// Mise 2.0, seam fix loop 1, items 13 and 15. While freeze.json says the
// kitchen is frozen for the move, the flush holds every queued change except
// the freeze file itself. The store lock (acquireStoreLock) waits for a push
// already in flight and keeps any new flush from starting until released, and
// the sign-in side switches accounts holding it (worker gate E4).
import test from "node:test";
import assert from "node:assert/strict";
import { idb, kv, settle } from "./helpers/fake-browser.js";

const { installBackend } = await import("../app/lib/backend.js");
const { write, flushNow, acquireStoreLock, resetFileChecks } = await import("../app/lib/store.js");
const { createSessionBoot } = await import("../app/lib/session-boot.js");

/**
 * A GitHub-lane stand-in: freeze.json reads as `freeze.file`; every write is
 * recorded, and held until released while `hold` is set.
 */
function lane() {
  const freeze = { file: /** @type {any} */ (null) };
  /** @type {string[]} */
  const writes = [];
  /** @type {(() => void)[]} */
  const held = [];
  const ctl = { hold: false };
  /** @type {import("../app/lib/backend.js").Backend} */
  const b = {
    name: "github",
    read: async (path) =>
      path === "freeze.json" && freeze.file
        ? { data: freeze.file, sha: `f:${JSON.stringify(freeze.file)}` }
        : null,
    write: async (path) => {
      writes.push(path);
      if (ctl.hold) await new Promise((r) => held.push(() => r(undefined)));
      return { sha: `s${writes.length}` };
    },
    list: async () => [],
    readMeta: async () => null,
    authHeader: async () => null,
    status: async () => ({ privacy: "private", auth: "ok", reachable: true }),
    authBroken: () => false,
    stamp: () => "main",
    laneOf: () => "github",
    session: () => null,
  };
  return { b, freeze, writes, ctl, release: () => held.splice(0).forEach((r) => r()) };
}

/** the switch-morning shell: `<meta name="mise-move" content="on">` (loop 2 item 4) */
function moveShell(on = true) {
  /** @type {any} */ (globalThis).document = on
    ? {
        querySelector: (/** @type {string} */ s) =>
          s === 'meta[name="mise-move"]' ? { getAttribute: () => "on" } : null,
      }
    : undefined;
}

test("a frozen kitchen holds every queued change but the freeze file", async () => {
  idb.clear();
  kv.clear();
  resetFileChecks();
  moveShell();
  const l = lane();
  l.freeze.file = { frozen: true, at: "2026-11-15T09:00:00Z", by: "admin-1" };
  installBackend(l.b);
  await write("shopping.json", { items: ["rice"] }, { raw: true });
  await flushNow({ timeoutMs: 2000 });
  assert.deepEqual(l.writes, [], "nothing lands in the old store after the copy");
  assert.equal(idb.get("shopping.json")?.dirty, true, "it waits on the phone");
  // the freeze file itself always goes out, even while frozen (so UNFREEZE can land)
  await write(
    "freeze.json",
    { frozen: true, at: "2026-11-15T09:05:00Z", by: "admin-1" },
    { raw: true },
  );
  await flushNow({ timeoutMs: 2000 });
  assert.deepEqual(l.writes, ["freeze.json"]);
  l.freeze.file = { frozen: false };
  resetFileChecks();
  const res = await flushNow({ timeoutMs: 2000 });
  assert.equal(res.landed, true);
  assert.deepEqual(l.writes, ["freeze.json", "shopping.json"], "unfrozen, the queue goes");
  moveShell(false);
  installBackend(null);
});

test("the store lock waits for the push in flight and blocks new flushes until released", async () => {
  idb.clear();
  kv.clear();
  resetFileChecks();
  const l = lane();
  installBackend(l.b);
  l.ctl.hold = true;
  await write("shopping.json", { items: ["a"] }, { raw: true });
  await settle();
  assert.deepEqual(l.writes, ["shopping.json"], "a push is in flight");
  let locked = false;
  const lockP = acquireStoreLock().then((rel) => {
    locked = true;
    return rel;
  });
  await settle();
  assert.equal(locked, false, "the lock waits for the push");
  l.release();
  const release = await lockP;
  assert.equal(locked, true);
  l.ctl.hold = false;
  await write("pantry.json", { items: ["b"] }, { raw: true });
  await settle();
  assert.deepEqual(l.writes, ["shopping.json"], "no flush starts while the lock is held");
  release();
  release(); // idempotent
  assert.equal((await flushNow({ timeoutMs: 2000 })).landed, true);
  assert.deepEqual(l.writes, ["shopping.json", "pantry.json"]);
  installBackend(null);
});

test("the sign-in side switches accounts holding the store lock, and flushes after", async () => {
  /** @type {string[]} */
  const log = [];
  const boot = createSessionBoot({
    client: {
      rpc: async () => ({
        data: { slug: "housemate-2", admin: false, home: "house-a" },
        error: null,
      }),
      auth: { getSession: async () => ({ data: { session: null } }) },
    },
    project: { stamp: "supabase", label: "live" },
    storage: null,
    seam: {
      installBackend: () => log.push("install"),
      lockedBackend: () => ({}),
      createSupabaseAdapter: () => ({ name: "supabase" }),
      onSessionChange: async () => void log.push("session"),
      resetFileChecks: () => log.push("reset"),
      flushNow: async () => log.push("flush"),
      purgeEverything: async () => log.push("PURGE"),
      acquireStoreLock: async () => {
        log.push("lock");
        return () => log.push("unlock");
      },
    },
  });
  assert.equal(await boot.adopt({ user: { id: "u2" }, access_token: "t" }), "signed-in");
  // seam loop 2's order (worker fix loop 1, item 15): the locked backend is
  // in when onSessionChange runs, then the new adapter, all under the lock
  assert.deepEqual(log, ["lock", "install", "reset", "session", "install", "reset", "unlock", "flush"]);
  log.length = 0;
  await boot.signOut();
  assert.deepEqual(log.slice(0, 1), ["lock"]);
  assert.equal(log.at(-1), "unlock");
});
