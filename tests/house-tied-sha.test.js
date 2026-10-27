// Mise 2.0, seam fix loop 1, item 10 (ENG F5): prices.json and pins.json are
// the home house's, so their sha names the house (pg:N@<home>). After a house
// move the cached copy no longer matches and is refetched, and a write queued
// against the old house's row is a create, which conflicts and merges instead
// of replacing the new house's catalogue. Made-up houses only.
import test from "node:test";
import assert from "node:assert/strict";
import { idb, settle } from "./helpers/fake-browser.js";
import { fakeSupabase } from "./helpers/fake-supabase.js";

const { createSupabaseAdapter } = await import("../app/lib/backend/supabase-adapter.js");
const { installBackend } = await import("../app/lib/backend.js");
const { read, resetFileChecks } = await import("../app/lib/store.js");

function twoHouses() {
  const sb = fakeSupabase();
  for (const [h, item] of [
    ["house-a", "rice"],
    ["house-b", "oats"],
  ]) {
    const path = `households/${h}/prices.json`;
    sb.docs.set(path, { path, data: { items: { [item]: 1 } }, rev: 3, legacy_sha: null });
  }
  return sb;
}

test("a stale write from another house conflicts instead of overwriting", async () => {
  const sb = twoHouses();
  const me = { slug: "housemate-1", admin: false, home: "house-a" };
  const a = createSupabaseAdapter({ client: sb.client, session: () => me });
  const got = await a.read("prices.json");
  assert.equal(got?.sha, "pg:3@house-a");
  me.home = "house-b"; // moved house; house-b's row is also at rev 3
  await assert.rejects(a.write("prices.json", { items: { rice: 9 } }, got?.sha), {
    name: "ConflictError",
  });
  assert.deepEqual(sb.docs.get("households/house-b/prices.json")?.data, { items: { oats: 1 } });
  assert.equal(
    (await a.write("prices.json", { items: { oats: 2 } }, "pg:3@house-b")).sha,
    "pg:4@house-b",
  );
});

test("after a house move the cached prices are refetched", async () => {
  idb.clear();
  resetFileChecks();
  const sb = twoHouses();
  const me = { slug: "housemate-1", admin: false, home: "house-a" };
  installBackend(createSupabaseAdapter({ client: sb.client, session: () => me }));
  await read("prices.json", { raw: true });
  await settle();
  assert.deepEqual(await read("prices.json", { raw: true }), { items: { rice: 1 } });
  me.home = "house-b";
  resetFileChecks();
  await read("prices.json", { raw: true });
  await settle();
  assert.deepEqual(await read("prices.json", { raw: true }), { items: { oats: 1 } });
  installBackend(null);
});
