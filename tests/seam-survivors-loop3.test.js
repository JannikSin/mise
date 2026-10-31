// Mise 2.0, seam fix loop 3, item 10 (ENG 3 T2, T3, T1 rest; Red Team 3
// L-d; P4 store): tests for the loop 2 mutants that survived verify 3.
// Made-up people only.
import test from "node:test";
import assert from "node:assert/strict";
import { idb, kv, queued, settle } from "./helpers/fake-browser.js";
import { fakeSupabase } from "./helpers/fake-supabase.js";

const { createSupabaseAdapter } = await import("../app/lib/backend/supabase-adapter.js");
const { installBackend } = await import("../app/lib/backend.js");
const store = await import("../app/lib/store.js");
const { read, write, flushNow, onSessionChange } = store;

const A = { slug: "housemate-1", admin: false, home: "house-a" };
const B = { slug: "housemate-2", admin: false, home: "house-a" };

function fresh() {
  idb.clear();
  kv.clear();
  store.resetFileChecks();
}

test("T2 / L-d: in the whoami window the remembered account decides, not the live session", async () => {
  fresh();
  const sb = fakeSupabase({});
  installBackend(createSupabaseAdapter({ client: sb.client, session: () => A }));
  await onSessionChange(null, A.slug);
  const P = "profiles/housemate-1/occasions.json";
  idb.set(P, { ...queued(P, { note: "A's" }), account: A.slug });
  // B's session is live, but the store has not been told yet (adopt's window)
  installBackend(createSupabaseAdapter({ client: sb.client, session: () => B }));
  assert.deepEqual(await read(P, { raw: true }), { note: "A's" }, "still A's phone for reading");
  await write("shopping.json", { items: [] }, { raw: true });
  assert.equal(idb.get("shopping.json")?.account, A.slug, "stamped by the remembered account");
  // and the send guard keeps both off B's session
  await flushNow({ timeoutMs: 500 });
  assert.equal(sb.docs.has(P), false);
  assert.equal(sb.docs.has("shopping.json"), false);
  installBackend(null);
});

test("hold on every call: the same account again still moves another account's write out of its slot", async () => {
  fresh();
  installBackend(createSupabaseAdapter({ client: fakeSupabase({}).client, session: () => A }));
  kv.set("mise.storeAccount", A.slug);
  idb.set("pins.json", { ...queued("pins.json", { pins: { b: 1 } }), queuedAt: 7, account: B.slug });
  await onSessionChange(A.slug, A.slug);
  assert.equal(idb.has("pins.json"), false, "the slot is free");
  assert.ok(idb.has(`#held/${B.slug}/7/pins.json`));
  installBackend(null);
});

const OLD = "special-quick-curry-2026-10-20";
const LEGACY = `recipes/${OLD}.json`;
const special = {
  id: OLD,
  name: "Quick curry",
  tags: ["ai-special"],
  ingredients: [{ food: "chickpeas", qty: 200, unit: "g" }],
  nutrition: { calories: 600, protein: 30 },
};

test("T3: a refused rehomed special is marked at its 1.95 path, the record really queued", async () => {
  fresh();
  idb.set(LEGACY, queued(LEGACY, special, { branch: "main" }));
  const sb = fakeSupabase({ isAdmin: () => false, canWrite: (p) => !p.startsWith("households/") });
  installBackend(createSupabaseAdapter({ client: sb.client, session: () => A }));
  await flushNow({ timeoutMs: 1000 });
  assert.equal(idb.get(LEGACY)?.refused?.reason, "forbidden");
  assert.equal(
    [...idb.keys()].some((k) => k.startsWith("households/")),
    false,
    "nothing at the house path",
  );
  installBackend(null);
});

test("T3: a rehomed special whose landing races an account change stores nothing at the house path", async () => {
  fresh();
  idb.set(LEGACY, queued(LEGACY, special, { branch: "main" }));
  const sb = fakeSupabase({ isAdmin: () => false });
  const a = createSupabaseAdapter({ client: sb.client, session: () => A });
  /** @type {(() => void)[]} */
  const gate = [];
  installBackend({
    ...a,
    write: async (/** @type {any[]} */ ...args) => {
      await new Promise((r) => gate.push(() => r(undefined)));
      return /** @type {any} */ (a.write)(...args);
    },
  });
  await onSessionChange(null, A.slug);
  const flushing = flushNow({ timeoutMs: 2000 });
  await settle();
  assert.equal(gate.length, 1, "the house push is in flight");
  await onSessionChange(A.slug, B.slug);
  gate.splice(0).forEach((go) => go());
  await flushing;
  assert.equal(
    [...idb.keys()].some((k) => k.startsWith("households/")),
    false,
    "the landed copy is not cached for the next account",
  );
  installBackend(null);
});
