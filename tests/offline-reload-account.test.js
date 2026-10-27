// Mise 2.0, seam fix loop 2, item 2 (ENG 2 N2; P4 store, architecture rule
// 3): "another account" is decided from the account the STORE remembers,
// never the live session. An offline reload boots the locked backend (no
// session), and the person's own queued shopping ticks must stay readable
// and writable. Made-up people only.
import test from "node:test";
import assert from "node:assert/strict";
import { idb, kv } from "./helpers/fake-browser.js";
import { fakeSupabase } from "./helpers/fake-supabase.js";

const { createSupabaseAdapter } = await import("../app/lib/backend/supabase-adapter.js");
const { installBackend, lockedBackend } = await import("../app/lib/backend.js");
const store = await import("../app/lib/store.js");
const { read, write, flushNow, onSessionChange, refusedRecords } = store;

const A = { slug: "housemate-1", admin: false, home: "house-a" };
const LIST = "profiles/housemate-1/shopping.json";

/** @param {any} sb @param {typeof A} who */
const signIn = (sb, who) =>
  installBackend(createSupabaseAdapter({ client: sb.client, session: () => who }));

test("the milk tick survives an offline reload plus a new edit, and lands when signed in", async () => {
  idb.clear();
  kv.clear();
  store.resetFileChecks();
  const state = { offline: true };
  const sb = fakeSupabase({
    failWith: (op) =>
      op === "write_doc" && state.offline ? { status: 0, message: "offline" } : null,
  });
  signIn(sb, A);
  await onSessionChange(null, A.slug);
  await write(LIST, { items: [{ name: "milk", ticked: true }] }, { raw: true });
  await flushNow({ timeoutMs: 1000 });

  // iOS reloads the PWA with no signal: the boot puts the locked backend in
  // and whoami fails, so there is no session at all
  installBackend(lockedBackend());
  store.resetFileChecks();
  const seen = /** @type {any} */ (await read(LIST, { raw: true }));
  assert.deepEqual(seen, { items: [{ name: "milk", ticked: true }] }, "her own tick still reads");
  await write(LIST, { items: [...seen.items, { name: "eggs", ticked: true }] }, { raw: true });
  assert.equal(idb.get(LIST)?.account, A.slug, "the new edit is still hers");
  assert.deepEqual(await refusedRecords(), [], "nothing of hers is listed as another account's");
  const sent = sb.log.filter((/** @type {any} */ e) => e.table === "write_doc").length;
  await flushNow({ timeoutMs: 500 });
  assert.equal(
    sb.log.filter((/** @type {any} */ e) => e.table === "write_doc").length,
    sent,
    "nothing is sent without a session",
  );

  // signal back, she is signed in again
  state.offline = false;
  await onSessionChange(A.slug, A.slug);
  signIn(sb, A);
  assert.equal((await flushNow({ timeoutMs: 2000 })).landed, true);
  assert.deepEqual(sb.docs.get(LIST)?.data, {
    items: [
      { name: "milk", ticked: true },
      { name: "eggs", ticked: true },
    ],
  });
  installBackend(null);
});

test("a remembered account's queue is never sent under another live session", async () => {
  idb.clear();
  kv.clear();
  store.resetFileChecks();
  const sb = fakeSupabase({});
  installBackend(lockedBackend());
  await onSessionChange(null, A.slug);
  await write(LIST, { items: [{ name: "milk", ticked: true }] }, { raw: true });
  // a direct switch: supabase-js already carries housemate-2's session before
  // the sign-in side has told the store (Red Team 2 N3)
  signIn(sb, { slug: "housemate-2", admin: false, home: "house-a" });
  await flushNow({ timeoutMs: 1000 });
  assert.equal(sb.log.filter((/** @type {any} */ e) => e.table === "write_doc").length, 0);
  assert.equal(idb.get(LIST)?.dirty, true, "still queued for her");
  installBackend(null);
});
