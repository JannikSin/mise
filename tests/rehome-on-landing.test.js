// Mise 2.0, seam fix loop 2, item 7 (ENG 2, item 12 row): a queued 1.95 AI
// special is rehomed to the house only once its push LANDS. Until then the
// phone keeps it at its 1.95 path (a rollback still pushes it to the bank
// as 1.95 would), and a retry reuses the same house id. A home that is no
// house slug refuses the record instead of crashing the flush.
// Made-up people only.
import test from "node:test";
import assert from "node:assert/strict";
import { idb, kv, queued } from "./helpers/fake-browser.js";
import { fakeSupabase } from "./helpers/fake-supabase.js";

const { createSupabaseAdapter } = await import("../app/lib/backend/supabase-adapter.js");
const { installBackend } = await import("../app/lib/backend.js");
const { flushNow, refusedRecords, resetFileChecks } = await import("../app/lib/store.js");

const OLD = "special-quick-curry-2026-10-20";
const LEGACY = `recipes/${OLD}.json`;
const special = {
  id: OLD,
  name: "Quick curry",
  tags: ["ai-special"],
  ingredients: [{ food: "chickpeas", qty: 200, unit: "g" }],
  nutrition: { calories: 600, protein: 30 },
};

/** @param {any} sb @param {string} home */
function signIn(sb, home) {
  installBackend(
    createSupabaseAdapter({
      client: sb.client,
      session: () => ({ slug: "housemate-1", admin: false, home }),
    }),
  );
}

function fresh() {
  idb.clear();
  kv.clear();
  resetFileChecks();
  idb.set(LEGACY, queued(LEGACY, special, { branch: "main" }));
}

test("a push that fails leaves the special at its 1.95 path; the retry lands it once, same id", async () => {
  fresh();
  const state = { offline: true };
  const sb = fakeSupabase({
    isAdmin: () => false,
    failWith: (op) =>
      op === "write_doc" && state.offline ? { status: 0, message: "offline" } : null,
  });
  signIn(sb, "house-a");
  await flushNow({ timeoutMs: 1000 });
  const kept = idb.get(LEGACY);
  assert.equal(kept?.dirty, true, "still queued where 1.95 left it");
  assert.equal(kept?.branch, "main", "still a GitHub-era write");
  assert.deepEqual(kept?.data, special, "its data untouched");
  assert.equal(
    [...idb.keys()].some((k) => k.startsWith("households/")),
    false,
    "nothing at the house path yet",
  );
  const chosen = kept?.rehome?.path;
  assert.match(String(chosen), /^households\/house-a\/recipes\/house-[0-9a-f]{12}\.json$/);

  await flushNow({ timeoutMs: 1000 });
  assert.equal(idb.get(LEGACY)?.rehome?.path, chosen, "a retry keeps the same id");

  state.offline = false;
  assert.equal((await flushNow({ timeoutMs: 2000 })).landed, true);
  const rows = [...sb.docs.values()].filter((r) => r.path.startsWith("households/house-a/recipes/"));
  assert.deepEqual(
    rows.map((r) => r.path),
    [chosen],
    "one copy on the server",
  );
  assert.equal(idb.has(LEGACY), false, "the 1.95 record goes once it landed");
  const landed = idb.get(String(chosen));
  assert.equal(landed?.dirty, false);
  assert.equal(landed?.branch, "supabase");
  assert.equal(landed?.data.legacyId, OLD);
  assert.equal("rehome" in (landed ?? {}), false);
  installBackend(null);
});

test("a home that is no house slug refuses the special, and the rest of the queue still goes", async () => {
  fresh();
  const sb = fakeSupabase({ isAdmin: () => false });
  const OTHER = "profiles/housemate-1/occasions.json";
  idb.set(OTHER, queued(OTHER, { note: "x" }, { queuedAt: Date.now() + 10, branch: "supabase" }));
  signIn(sb, "House A!");
  const r = await flushNow({ timeoutMs: 2000 });
  assert.equal(sb.docs.get(OTHER)?.data.note, "x", "the flush did not crash");
  assert.equal(r.error, null);
  assert.deepEqual(
    (await refusedRecords()).map((x) => [x.path, x.reason]),
    [[LEGACY, "forbidden"]],
  );
  installBackend(null);
});
