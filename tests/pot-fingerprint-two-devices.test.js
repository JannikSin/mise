// Mise 2.0, plan section 5 (ENG L2-3): a frozen pot fingerprints each
// diner's targets. On Supabase the owner reads the full row and a housemate
// reads the plate, so the row's own sha would differ between their phones.
// readMeta therefore answers with the PLATE's sha on every device, the
// owner's included: both phones freeze the same pot with the same
// fingerprint, and an owner-only edit (goal weight) changes neither.
import test from "node:test";
import assert from "node:assert/strict";
import { idb, settle } from "./helpers/fake-browser.js";
import { fakeSupabase } from "./helpers/fake-supabase.js";

const { createSupabaseAdapter } = await import("../app/lib/backend/supabase-adapter.js");
const { installBackend } = await import("../app/lib/backend.js");
const { readTargetsMetaOf, writeTargetsOf, flushNow, resetFileChecks } =
  await import("../app/lib/store.js");

const OWNER = { slug: "housemate-1", admin: false, home: "house-a" };
const HOUSEMATE = { slug: "housemate-2", admin: false, home: "house-a" };
// the plate keeps cook-facing keys only (plate-fields.js PLATE_FIELDS, db lane)
const COOK_FACING = new Set(["diet", "allergens", "avoidIngredients", "macros"]);
const plateOf = (/** @type {any} */ t) =>
  Object.fromEntries(Object.entries(t).filter(([k]) => COOK_FACING.has(k)));

const sb = fakeSupabase({ plateOf });
const PATH = "profiles/housemate-1/profile/targets.json";
const MIGRATED_GIT_SHA = "9b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c";
sb.docs.set(PATH, {
  path: PATH,
  data: {
    diet: "vegetarian",
    allergens: ["peanut"],
    macros: { calories: 2200 },
    goalWeightLb: 150,
  },
  rev: 1,
  legacy_sha: MIGRATED_GIT_SHA,
});
sb.plates.set("housemate-1", {
  data: { diet: "vegetarian", allergens: ["peanut"], macros: { calories: 2200 } },
  rev: 1,
  content_hash: "seed",
  legacy_sha: MIGRATED_GIT_SHA,
});

/** one phone: a fresh cache and its own session */
async function fingerprintOn(/** @type {typeof OWNER} */ who) {
  idb.clear();
  resetFileChecks();
  installBackend(createSupabaseAdapter({ client: sb.client, session: () => who }));
  await readTargetsMetaOf("housemate-1");
  await settle();
  const meta = await readTargetsMetaOf("housemate-1");
  return meta.sha;
}

test("owner and housemate get the same fingerprint for the same targets", async () => {
  const ownerSha = await fingerprintOn(OWNER);
  const housemateSha = await fingerprintOn(HOUSEMATE);
  assert.equal(ownerSha, MIGRATED_GIT_SHA, "a migrated plate at rev 1 is its git sha");
  assert.equal(housemateSha, ownerSha);
});

test("an owner-only edit changes neither phone's fingerprint; a cook-facing edit changes both", async () => {
  const before = await fingerprintOn(OWNER);
  // the owner edits their goal weight only
  installBackend(createSupabaseAdapter({ client: sb.client, session: () => OWNER }));
  const full = /** @type {any} */ (sb.docs.get(PATH)).data;
  await writeTargetsOf("housemate-1", { ...full, goalWeightLb: 155 });
  assert.equal((await flushNow({ timeoutMs: 3000 })).landed, true);
  assert.equal(sb.docs.get(PATH)?.rev, 2, "the row itself did change");
  assert.equal(await fingerprintOn(OWNER), before);
  assert.equal(await fingerprintOn(HOUSEMATE), before);
  // a new allergy is exactly what a frozen pot must notice
  installBackend(createSupabaseAdapter({ client: sb.client, session: () => OWNER }));
  const now = /** @type {any} */ (sb.docs.get(PATH)).data;
  await writeTargetsOf("housemate-1", { ...now, allergens: ["peanut", "sesame"] });
  assert.equal((await flushNow({ timeoutMs: 3000 })).landed, true);
  const after = await fingerprintOn(OWNER);
  assert.notEqual(after, before);
  assert.equal(await fingerprintOn(HOUSEMATE), after);
  installBackend(null);
});
