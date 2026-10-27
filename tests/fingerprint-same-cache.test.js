// Mise 2.0, seam fix loop 1, items 7 and 11 (Red Team 7, ENG F1 and F6).
// On ONE phone's cache (no clearing between reads): right after the owner's
// own targets save lands, readMeta reports dirty until a fetch brings the
// plate fingerprint back, so a pot frozen in that window never keys on the
// row sha. A refused targets record learns the new fingerprint. A plate that
// moved while the row did not is refetched (the fingerprint compare in
// revalidate). A record edited while its refused push was in flight is not
// marked refused, and its newer edit lands (the refused-marking rev guard).
// Made-up people only.
import test from "node:test";
import assert from "node:assert/strict";
import { idb, settle } from "./helpers/fake-browser.js";
import { fakeSupabase } from "./helpers/fake-supabase.js";

const { createSupabaseAdapter } = await import("../app/lib/backend/supabase-adapter.js");
const { installBackend } = await import("../app/lib/backend.js");
const { readMeta, readNow, write, flushNow, resetFileChecks } = await import("../app/lib/store.js");

const OWNER = { slug: "housemate-1", admin: false, home: "house-a" };
const HOUSEMATE = { slug: "housemate-2", admin: false, home: "house-a" };
const PATH = "profiles/housemate-1/profile/targets.json";
const COOK_FACING = new Set(["diet", "allergens", "macros"]);
const plateOf = (/** @type {any} */ t) =>
  Object.fromEntries(Object.entries(t).filter(([k]) => COOK_FACING.has(k)));

function seeded(/** @type {any} */ hooks = {}) {
  idb.clear();
  resetFileChecks();
  const sb = fakeSupabase({ plateOf, ...hooks });
  const data = { diet: "omnivore", macros: { calories: 2400 }, goalWeightLb: 150 };
  sb.docs.set(PATH, { path: PATH, data, rev: 2, legacy_sha: null });
  sb.plates.set("housemate-1", {
    data: plateOf(data),
    rev: 2,
    content_hash: "seed",
    legacy_sha: null,
  });
  return sb;
}

test("after the owner's own save the phone reports dirty, then the plate's fingerprint", async () => {
  const sb = seeded();
  installBackend(createSupabaseAdapter({ client: sb.client, session: () => OWNER }));
  await readNow(PATH, { raw: true });
  const before = await readMeta(PATH, { raw: true });
  assert.equal(before.sha, "plate:seed");
  // an owner-only edit: the plate does not move
  await write(
    PATH,
    { diet: "omnivore", macros: { calories: 2400 }, goalWeightLb: 155 },
    { raw: true },
  );
  assert.equal((await flushNow({ timeoutMs: 3000 })).landed, true);
  const right = await readMeta(PATH, { raw: true });
  assert.equal(right.dirty, true, "no fingerprint yet, so it says dirty, never the row's pg:N");
  assert.notEqual(right.sha, "pg:3");
  await readNow(PATH, { raw: true });
  const after = await readMeta(PATH, { raw: true });
  assert.deepEqual([after.sha, after.dirty], ["plate:seed", false]);
  const housemate = createSupabaseAdapter({ client: sb.client, session: () => HOUSEMATE });
  assert.equal((await housemate.readMeta(PATH))?.sha, after.sha, "the same on every device");
  installBackend(null);
});

test("a plate that moved while the row did not is refetched", async () => {
  const sb = seeded();
  installBackend(createSupabaseAdapter({ client: sb.client, session: () => OWNER }));
  await readNow(PATH, { raw: true });
  assert.equal((await readMeta(PATH, { raw: true })).sha, "plate:seed");
  // the plate projection changed server side (a plate_of change), the row's rev did not
  const plate = /** @type {any} */ (sb.plates.get("housemate-1"));
  sb.plates.set("housemate-1", { ...plate, rev: 3, content_hash: "moved" });
  resetFileChecks();
  await readNow(PATH, { raw: true });
  assert.equal((await readMeta(PATH, { raw: true })).sha, "plate:moved");
  installBackend(null);
});

test("a refused targets record learns the new fingerprint", async () => {
  const sb = seeded();
  installBackend(createSupabaseAdapter({ client: sb.client, session: () => OWNER }));
  idb.set(PATH, {
    path: PATH,
    data: { diet: "omnivore", note: "named" },
    base: { diet: "omnivore" },
    sha: "pg:2",
    fingerprint: "plate:old",
    dirty: true,
    queuedAt: 1,
    rev: 4,
    branch: "supabase",
    refused: { reason: "name", at: 1 },
  });
  await readNow(PATH, { raw: true });
  assert.equal(idb.get(PATH)?.fingerprint, "plate:seed");
  assert.equal((await readMeta(PATH, { raw: true })).sha, "plate:seed");
  installBackend(null);
});

test("an edit made while its refused push was in flight is not refused, and lands", async () => {
  const P = "profiles/housemate-1/occasions.json";
  /** @type {(() => void) | null} */
  let release = null;
  let held = false;
  const sb = seeded({
    nameGuard: (/** @type {string} */ _p, /** @type {any} */ d) => d?.note === "named",
  });
  const rpc = sb.client.rpc;
  sb.client.rpc = async (/** @type {string} */ name, /** @type {any} */ args) => {
    if (name === "write_doc" && !held) {
      held = true;
      await new Promise((r) => (release = () => r(undefined)));
    }
    return rpc(name, args);
  };
  installBackend(createSupabaseAdapter({ client: sb.client, session: () => OWNER }));
  await write(P, { note: "named" }, { raw: true });
  await settle();
  // the refused push is in flight; a newer edit lands on the phone
  await write(P, { note: "clean" }, { raw: true });
  /** @type {any} */ (release)();
  await settle();
  assert.equal(idb.get(P)?.refused, undefined, "the newer edit is not marked refused");
  assert.equal((await flushNow({ timeoutMs: 3000 })).landed, true);
  assert.equal(sb.docs.get(P)?.data.note, "clean");
  installBackend(null);
});
