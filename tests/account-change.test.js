// Mise 2.0, seam fix loop 1, items 1 and 14 (Red Team 1, ENG F3 seam half):
// one phone, two accounts. On an account change the cache the last account
// could read is purged; what it queued is held, never pushed under the next
// session, never read by it, and listed as refused "made by another account"
// with DISCARD. The names are exactly onSessionChange(prev, next) and
// canSwitchProfile(), which the sign-in side calls. Made-up people only.
import test from "node:test";
import assert from "node:assert/strict";
import { idb, kv, settle } from "./helpers/fake-browser.js";
import { fakeSupabase } from "./helpers/fake-supabase.js";

const { createSupabaseAdapter } = await import("../app/lib/backend/supabase-adapter.js");
const { installBackend } = await import("../app/lib/backend.js");
const store = await import("../app/lib/store.js");
const { read, write, flushNow, onSessionChange, refusedRecords, discardRefused, resetFileChecks } =
  store;

const A = { slug: "housemate-1", admin: false, home: "house-a" };
const B = { slug: "housemate-2", admin: false, home: "house-a" };
const QUEUED = "profiles/housemate-1/occasions.json";
const CACHED = "profiles/housemate-1/profile/targets.json";

/** the server for both accounts; writes fail while `offline` is set */
function server() {
  const state = { offline: true };
  const sb = fakeSupabase({
    failWith: (op) =>
      op === "write_doc" && state.offline ? { status: 0, message: "offline" } : null,
  });
  return { sb, state };
}

/** @param {any} sb @param {typeof A} who */
const signIn = (sb, who) =>
  installBackend(createSupabaseAdapter({ client: sb.client, session: () => who }));

/** @param {any} sb */
const writesSent = (sb) => sb.log.filter((/** @type {any} */ e) => e.table === "write_doc").length;

test("the exact names the sign-in side calls exist", () => {
  assert.equal(typeof store.onSessionChange, "function");
  assert.equal(typeof store.canSwitchProfile, "function");
  assert.equal(typeof store.acquireStoreLock, "function");
});

test("an account change purges the cache and holds the last account's queue", async () => {
  idb.clear();
  kv.clear();
  resetFileChecks();
  const { sb, state } = server();
  signIn(sb, A);
  await onSessionChange(null, A.slug);
  // A has the full targets cached and one write queued (no signal)
  idb.set(CACHED, {
    path: CACHED,
    data: { goalWeightLb: 150 },
    base: { goalWeightLb: 150 },
    sha: "pg:2",
    dirty: false,
    queuedAt: null,
    rev: 1,
    branch: "supabase",
  });
  await write(QUEUED, { note: "A's plan" }, { raw: true });
  await flushNow({ timeoutMs: 2000 });
  assert.equal(idb.get(QUEUED)?.account, A.slug, "the write knows who made it");

  // B signs in on the same phone, and the signal is back
  state.offline = false;
  await onSessionChange(A.slug, B.slug);
  signIn(sb, B);
  assert.equal(idb.has(CACHED), false, "A's cached targets are gone");
  const before = writesSent(sb);
  await flushNow({ timeoutMs: 2000 });
  assert.equal(writesSent(sb), before, "A's write is never pushed under B");
  assert.equal(sb.docs.has(QUEUED), false);
  assert.equal(await read(QUEUED, { raw: true }), null, "B never reads A's queued data");
  assert.deepEqual(
    (await refusedRecords()).map((r) => [r.path, r.reason]),
    [[QUEUED, "account"]],
  );
  assert.equal(store.REFUSED_REASON.account, "made by another account");

  // A comes back: the held write goes out under A
  await onSessionChange(B.slug, A.slug);
  signIn(sb, A);
  assert.equal((await flushNow({ timeoutMs: 2000 })).landed, true);
  assert.deepEqual(sb.docs.get(QUEUED)?.data, { note: "A's plan" });
  installBackend(null);
});

test("DISCARD drops another account's held write", async () => {
  idb.clear();
  kv.clear();
  resetFileChecks();
  const { sb } = server();
  signIn(sb, A);
  await onSessionChange(null, A.slug);
  await write(QUEUED, { note: "A's plan" }, { raw: true });
  await settle();
  await onSessionChange(A.slug, B.slug);
  signIn(sb, B);
  assert.equal(await discardRefused(QUEUED), true);
  assert.equal(idb.has(QUEUED), false);
  installBackend(null);
});

test("the store remembers the account even when the caller's memory is lost", async () => {
  idb.clear();
  kv.clear();
  resetFileChecks();
  const { sb } = server();
  signIn(sb, A);
  await onSessionChange(null, A.slug);
  idb.set(CACHED, {
    path: CACHED,
    data: {},
    base: {},
    sha: "pg:2",
    dirty: false,
    queuedAt: null,
    rev: 1,
    branch: "supabase",
  });
  // the caller is wrong about who was here before (says B, it was A)
  assert.ok((await onSessionChange(B.slug, B.slug)) >= 1, "still a change, still purged");
  assert.equal(idb.has(CACHED), false);
  // the same account again changes nothing
  idb.set(CACHED, { path: CACHED, data: {}, base: {}, sha: "pg:2", dirty: false, rev: 1 });
  assert.equal(await onSessionChange(B.slug, B.slug), 0);
  assert.equal(idb.has(CACHED), true, "kept");
  installBackend(null);
});
