// Mise 2.0, seam fix loop 1, item 2 (Red Team 2): on Supabase a single file
// the policies now hide reads as null, and the clean cached copy is evicted.
// A queued edit is never evicted. GitHub keeps 1.95's behaviour.
import test from "node:test";
import assert from "node:assert/strict";
import { idb, settle, queued } from "./helpers/fake-browser.js";
import { fakeSupabase } from "./helpers/fake-supabase.js";

const { createSupabaseAdapter } = await import("../app/lib/backend/supabase-adapter.js");
const { installBackend } = await import("../app/lib/backend.js");
const { read, resetFileChecks } = await import("../app/lib/store.js");

const PLAN = "profiles/housemate-1/plans/2026-W45.json";
const ME = { slug: "housemate-1", admin: false, home: "house-a" };

/** @param {any} rec */
const clean = (rec) => ({ ...rec, dirty: false, queuedAt: null, branch: "supabase", sha: "pg:2" });

test("a row the server no longer shows is evicted from the cache", async () => {
  idb.clear();
  resetFileChecks();
  const sb = fakeSupabase();
  installBackend(createSupabaseAdapter({ client: sb.client, session: () => ME }));
  idb.set(PLAN, clean(queued(PLAN, { entries: ["old"] })));
  assert.deepEqual(await read(PLAN, { raw: true }), { entries: ["old"] }, "served once from cache");
  await settle();
  assert.equal(idb.has(PLAN), false, "evicted after the null read");
  assert.equal(await read(PLAN, { raw: true }), null);
  installBackend(null);
});

test("a queued edit is never evicted by a null read", async () => {
  idb.clear();
  resetFileChecks();
  const sb = fakeSupabase();
  installBackend(createSupabaseAdapter({ client: sb.client, session: () => ME }));
  idb.set(PLAN, { ...queued(PLAN, { entries: ["mine"] }), branch: "supabase" });
  await read(PLAN, { raw: true });
  await settle();
  assert.equal(idb.get(PLAN)?.dirty, true);
  installBackend(null);
});
