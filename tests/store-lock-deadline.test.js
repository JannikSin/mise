// Mise 2.0, seam fix loop 2, item 8 (ENG 2, item 15 row): the store lock
// waits for a push in flight only until its deadline, then reports a
// timeout instead of hanging sign-in or sign-out forever.
import test from "node:test";
import assert from "node:assert/strict";
import { idb, kv, settle } from "./helpers/fake-browser.js";
import { fakeGithubLane } from "./helpers/fake-github-lane.js";

const { installBackend } = await import("../app/lib/backend.js");
const store = await import("../app/lib/store.js");

test(
  "a push hung on a stalled fetch: the lock gives up at its deadline and says so",
  { timeout: 5000 },
  async () => {
    idb.clear();
    kv.clear();
    store.resetFileChecks();
    const l = fakeGithubLane();
    /** @type {(() => void)[]} */
    const stalled = [];
    installBackend({
      ...l.backend,
      write: () => new Promise((r) => stalled.push(() => r({ sha: "g1" }))),
    });
    await store.write("shopping.json", { items: ["rice"] }, { raw: true });
    await settle();
    assert.equal(store.getSyncStatus().flushing, true, "a push is hung");
    const t0 = Date.now();
    const release = await store.acquireStoreLock({ timeoutMs: 150 });
    assert.ok(Date.now() - t0 < 2000, "it did not hang");
    assert.equal(release.timedOut, true);
    assert.equal(store.getSyncStatus().lastError, store.LOCK_TIMEOUT_MESSAGE);
    release();
    stalled.splice(0).forEach((r) => r());
    await settle();
    installBackend(null);
  },
);

test("with nothing in flight the lock is taken at once and did not time out", async () => {
  const release = await store.acquireStoreLock({ timeoutMs: 150 });
  assert.equal(release.timedOut, false);
  release();
});
