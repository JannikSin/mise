// Mise 2.0, seam fix loop 3, item 3 (Red Team 3 S2; P4 store): a confirmed
// revoke on a shared phone purges the revoked account, never a housemate's
// held writes. Made-up people only.
import test from "node:test";
import assert from "node:assert/strict";
import { idb, kv, queued } from "./helpers/fake-browser.js";
import { fakeSupabase } from "./helpers/fake-supabase.js";

const { createSupabaseAdapter } = await import("../app/lib/backend/supabase-adapter.js");
const { installBackend, lockedBackend } = await import("../app/lib/backend.js");
const store = await import("../app/lib/store.js");
const { write, flushNow, onSessionChange, purgeEverything, refusedRecords } = store;

const A = { slug: "housemate-1", admin: false, home: "house-a" };
const OCC = "profiles/housemate-1/occasions.json";

function setup() {
  idb.clear();
  kv.clear();
  store.resetFileChecks();
  const state = { offline: false };
  const sb = fakeSupabase({
    failWith: (op) =>
      op === "write_doc" && state.offline ? { status: 0, message: "offline" } : null,
  });
  const signIn = (/** @type {typeof A} */ who) =>
    installBackend(createSupabaseAdapter({ client: sb.client, session: () => who }));
  return { sb, state, signIn };
}

test("Q2: B's revoke on the kitchen tablet keeps A's held plan, and it lands when A returns", async () => {
  const { sb, state, signIn } = setup();
  signIn(A);
  await onSessionChange(null, A.slug);
  state.offline = true;
  await write(OCC, { note: "A's offline plan" }, { raw: true });
  await flushNow({ timeoutMs: 300 });
  // A signs out: the write is held
  installBackend(lockedBackend());
  await onSessionChange(A.slug, null);
  assert.equal([...idb.keys()].filter((k) => k.startsWith("#held/housemate-1/")).length, 1);

  // B, whose profile was deleted, signs in: whoami says revoked
  state.offline = false;
  await purgeEverything();
  await onSessionChange(null, null);
  const left = [...idb.keys()];
  assert.equal(left.length, 1, "only A's held write is left");
  assert.ok(left[0].startsWith("#held/housemate-1/"));
  assert.deepEqual(
    (await refusedRecords()).map((r) => [r.path, r.reason]),
    [[OCC, "account"]],
  );

  // A comes back
  signIn(A);
  await onSessionChange(null, A.slug);
  const r = await flushNow({ timeoutMs: 2000 });
  assert.equal(r.landed, true);
  assert.deepEqual(sb.docs.get(OCC)?.data, { note: "A's offline plan" });
  installBackend(null);
});

test("a revoke drops the revoked account's queue, the before-sign-in bucket, unstamped queues and every clean record", async () => {
  setup();
  installBackend(lockedBackend());
  kv.set("mise.storeAccount", "housemate-2");
  const heldA = "#held/housemate-1/5/pins.json";
  idb.set(heldA, {
    ...queued(heldA, { pins: { a: 1 } }),
    account: "housemate-1",
    branch: "held",
    held: { path: "pins.json", account: "housemate-1" },
  });
  const heldB = "#held/housemate-2/6/pins.json";
  idb.set(heldB, {
    ...queued(heldB, { pins: { b: 1 } }),
    account: "housemate-2",
    branch: "held",
    held: { path: "pins.json", account: "housemate-2" },
  });
  const heldPre = "#held/#before-sign-in/7/shopping.json";
  idb.set(heldPre, {
    ...queued(heldPre, { items: [] }),
    account: "#before-sign-in",
    branch: "held",
    held: { path: "shopping.json", account: "#before-sign-in" },
  });
  idb.set("profiles/housemate-2/occasions.json", {
    ...queued("profiles/housemate-2/occasions.json", { note: "B" }),
    account: "housemate-2",
  });
  idb.set("plans/2026-W44.json", queued("plans/2026-W44.json", { days: [] }));
  idb.set("recipes/r1.json", { ...queued("recipes/r1.json", { id: "r1" }), dirty: false });
  // another account's write still in its slot (an interrupted switch)
  const slotA = "profiles/housemate-1/notes.json";
  idb.set(slotA, { ...queued(slotA, { n: 1 }), queuedAt: 9, account: "housemate-1" });

  const removed = await purgeEverything();
  assert.equal(removed, 5);
  assert.deepEqual(
    [...idb.keys()].sort(),
    [heldA, `#held/housemate-1/9/${slotA}`].sort(),
    "A's writes are kept, the one in a slot now held",
  );
});

test("the caller may name the revoked account", async () => {
  setup();
  installBackend(lockedBackend());
  kv.set("mise.storeAccount", "housemate-1");
  const heldB = "#held/housemate-2/6/pins.json";
  idb.set(heldB, {
    ...queued(heldB, { pins: { b: 1 } }),
    account: "housemate-2",
    branch: "held",
    held: { path: "pins.json", account: "housemate-2" },
  });
  const slotA = "profiles/housemate-1/notes.json";
  idb.set(slotA, { ...queued(slotA, { n: 1 }), account: "housemate-1" });
  await purgeEverything("housemate-2");
  assert.deepEqual([...idb.keys()].map((k) => k.split("/").slice(0, 2).join("/")), [
    "#held/housemate-1",
  ]);
});
