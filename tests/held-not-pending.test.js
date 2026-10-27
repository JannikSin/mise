// Mise 2.0, seam fix loop 3, item 8 (ENG 3 L1; P4 store): another account's
// held write counts under refused only, so the account now signed in sees
// its own queue land and Sync stops warning. Made-up people only.
import test from "node:test";
import assert from "node:assert/strict";
import { idb, kv } from "./helpers/fake-browser.js";
import { fakeSupabase } from "./helpers/fake-supabase.js";

const { createSupabaseAdapter } = await import("../app/lib/backend/supabase-adapter.js");
const { installBackend, lockedBackend } = await import("../app/lib/backend.js");
const store = await import("../app/lib/store.js");
const { write, flushNow, onSessionChange, getSyncStatus } = store;

const A = { slug: "housemate-1", admin: false, home: "house-a" };
const B = { slug: "housemate-2", admin: false, home: "house-a" };

test("A's held write is refused, not pending, for B; B's own queue is pending until it lands", async () => {
  idb.clear();
  kv.clear();
  store.resetFileChecks();
  const state = { offline: true };
  const sb = fakeSupabase({
    failWith: (op) =>
      op === "write_doc" && state.offline ? { status: 0, message: "offline" } : null,
  });
  const signIn = (/** @type {typeof A} */ who) =>
    installBackend(createSupabaseAdapter({ client: sb.client, session: () => who }));
  signIn(A);
  await onSessionChange(null, A.slug);
  await write("profiles/housemate-1/occasions.json", { note: "A" }, { raw: true });
  await flushNow({ timeoutMs: 300 });
  assert.equal(getSyncStatus().pending, 1, "A's own write is pending for A");

  await onSessionChange(A.slug, B.slug);
  signIn(B);
  assert.equal(getSyncStatus().pending, 0);
  assert.equal(getSyncStatus().refused, 1);

  await write("profiles/housemate-2/occasions.json", { note: "B" }, { raw: true });
  assert.equal(getSyncStatus().pending, 1, "B's own write is pending");
  state.offline = false;
  const r = await flushNow({ timeoutMs: 2000 });
  assert.equal(r.landed, true, "nothing of B's is left, so it says landed");
  assert.equal(r.pending, 0);
  assert.equal(getSyncStatus().refused, 1, "A's write still listed");
  installBackend(null);
});

test("a write made before sign-in waits while signed out, then is refused, not pending, once someone signs in", async () => {
  idb.clear();
  kv.clear();
  store.resetFileChecks();
  installBackend(lockedBackend());
  await write("shopping.json", { items: [] }, { raw: true });
  assert.equal(getSyncStatus().pending, 1, "signed out it reads as this phone's own");
  await onSessionChange(null, B.slug);
  installBackend(
    createSupabaseAdapter({ client: fakeSupabase({}).client, session: () => B }),
  );
  const r = await flushNow({ timeoutMs: 300 });
  assert.equal(r.pending, 0);
  assert.equal(r.landed, true);
  assert.equal(getSyncStatus().refused, 1);
  installBackend(null);
});
