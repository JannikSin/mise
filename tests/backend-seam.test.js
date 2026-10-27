// Mise 2.0, plan item A: the storage seam and the branch-to-backend stamp.
// With the GitHub adapter selected everything is 1.95 (the rest of the suite
// is the proof of that); these cases pin the seam itself.
import test from "node:test";
import assert from "node:assert/strict";
import { idb, settle, queued } from "./helpers/fake-browser.js";

const { backend, installBackend, stampHere, replaysHere, tokenBroken } =
  await import("../app/lib/backend.js");
const { dataBranch, tokenBroken: githubTokenBroken } = await import("../app/lib/github.js");
const { write, flushNow, discardMismatched, getSyncStatus } = await import("../app/lib/store.js");

/**
 * A recording backend standing in for Supabase.
 * @param {string} stamp
 */
function fakeBackend(stamp) {
  /** @type {{ path: string, sha: string | null | undefined }[]} */
  const writes = [];
  /** @type {import("../app/lib/backend.js").Backend} */
  const b = {
    name: "supabase",
    read: async () => null,
    write: async (path, _data, sha) => {
      writes.push({ path, sha });
      return { sha: "pg:2" };
    },
    list: async () => [],
    readMeta: async () => null,
    authHeader: async () => null,
    status: async () => ({ privacy: "private", auth: "ok", reachable: true }),
    authBroken: (s) => s === "invalid",
    stamp: () => stamp,
    laneOf: () => "supabase",
    session: () => null,
  };
  return { b, writes };
}

test("with no shell meta the backend is GitHub and the stamp is the data branch", () => {
  installBackend(null);
  assert.equal(backend().name, "github");
  assert.equal(stampHere(), dataBranch());
  assert.equal(stampHere(), "main");
  for (const s of ["invalid", "norepo", "throttled", "ok", "missing", undefined]) {
    assert.equal(tokenBroken(s), githubTokenBroken(s), String(s));
  }
});

test("on GitHub a record replays only under its own branch, exactly as 1.95", () => {
  assert.equal(replaysHere("main", "main"), true);
  assert.equal(replaysHere("sandbox", "main"), false);
  assert.equal(replaysHere("main", "sandbox"), false);
  assert.equal(replaysHere("main", null), false);
});

test("a Supabase project takes over the 1.95 branch it replaced, and only that one", () => {
  assert.equal(replaysHere("supabase", "supabase"), true);
  assert.equal(replaysHere("main", "supabase"), true);
  assert.equal(replaysHere("sandbox", "supabase"), false);
  assert.equal(replaysHere("sandbox", "supabase-sandbox"), true);
  assert.equal(replaysHere("main", "supabase-sandbox"), false);
  assert.equal(replaysHere("supabase", "main"), false, "a 2.0 record never goes back to GitHub");
});

test("a Supabase build before sign-in refuses everything and stamps its project", async () => {
  const { lockedBackend } = await import("../app/lib/backend.js");
  const locked = lockedBackend();
  assert.equal(locked.stamp(), "supabase");
  await assert.rejects(locked.read("pantry.json"), { name: "AuthError" });
  await assert.rejects(locked.write("pantry.json", {}), { name: "AuthError" });
});

test("new writes carry the installed backend's stamp", async () => {
  idb.clear();
  const { b } = fakeBackend("supabase");
  installBackend(b);
  await write("profiles/housemate-1/pantry.json", { items: [] }, { raw: true });
  await settle();
  assert.equal(idb.get("profiles/housemate-1/pantry.json")?.branch, "supabase");
});

test("a 1.95 queue replays into the project that took over its branch, restamped", async () => {
  idb.clear();
  const { b, writes } = fakeBackend("supabase");
  installBackend(b);
  idb.set(
    "shopping.json",
    queued("shopping.json", { items: [] }, { branch: "main", sha: "abc123" }),
  );
  idb.set(
    "plans/2026-W44.json",
    queued("plans/2026-W44.json", { days: [] }, { branch: "sandbox", queuedAt: 1 }),
  );
  const res = await flushNow({ timeoutMs: 2000 });
  assert.deepEqual(writes, [{ path: "shopping.json", sha: "abc123" }], "the old sha rides along");
  assert.equal(idb.get("shopping.json")?.dirty, false);
  assert.equal(idb.get("shopping.json")?.branch, "supabase");
  assert.equal(getSyncStatus().mismatched, 1, "the sandbox record is refused, not pushed");
  assert.equal(res.pending, 1);
  assert.equal(await discardMismatched(), 1);
  assert.equal(idb.has("plans/2026-W44.json"), false);
  installBackend(null);
});
