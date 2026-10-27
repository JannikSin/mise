// Mise 2.0, plan section 5 (C2): prices and pins are the caller's home
// house's; guest logins, invite codes and meta.json are never read or written
// from a phone on Supabase; the first Supabase boot purges every clean
// GitHub-era record; a revoked account purges everything.
import test from "node:test";
import assert from "node:assert/strict";
import { idb, settle, queued } from "./helpers/fake-browser.js";
import { fakeSupabase } from "./helpers/fake-supabase.js";

const { createSupabaseAdapter } = await import("../app/lib/backend/supabase-adapter.js");
const { installBackend } = await import("../app/lib/backend.js");
const { read, write, flushNow, purgeForeignRecords, purgeEverything, resetFileChecks } =
  await import("../app/lib/store.js");

const ME = { slug: "housemate-1", admin: false, home: "house-a" };

test("prices.json and pins.json read and write the home house's files", async () => {
  const sb = fakeSupabase();
  sb.docs.set("households/house-a/prices.json", {
    path: "households/house-a/prices.json",
    data: { items: { rice: 1.5 } },
    rev: 3,
    legacy_sha: null,
  });
  const a = createSupabaseAdapter({ client: sb.client, session: () => ME });
  const got = await a.read("prices.json");
  assert.deepEqual(got, { data: { items: { rice: 1.5 } }, sha: "pg:3@house-a" }); // tied to the house (fix loop 1, ENG F5)
  assert.equal((await a.write("prices.json", { items: {} }, got?.sha)).sha, "pg:4@house-a");
  assert.equal((await a.write("pins.json", { pins: [] }, null)).sha, "pg:1@house-a");
  assert.ok(sb.docs.has("households/house-a/pins.json"));
  assert.equal(sb.docs.has("pins.json"), false);
});

test("with no home house there is nothing to read, and a write is refused", async () => {
  const sb = fakeSupabase();
  const a = createSupabaseAdapter({ client: sb.client, session: () => ({ ...ME, home: null }) });
  assert.equal(await a.read("prices.json"), null);
  await assert.rejects(a.write("prices.json", {}, null), { name: "ForbiddenError" });
});

test("guests.json, invites.json and meta.json never leave or reach the phone", async () => {
  const sb = fakeSupabase();
  const a = createSupabaseAdapter({ client: sb.client, session: () => ME });
  for (const p of ["guests.json", "invites.json", "meta.json"]) {
    assert.equal(await a.read(p), null, p);
    await assert.rejects(a.write(p, {}, null), { name: "ForbiddenError" }, p);
  }
  assert.equal(sb.log.length, 0, "nothing was sent");
});

test("first boot on Supabase purges clean GitHub-era records and keeps the queue", async () => {
  idb.clear();
  resetFileChecks();
  const sb = fakeSupabase();
  idb.set("shopping.json", { ...queued("shopping.json", {}), dirty: false, branch: "main" });
  idb.set("recipes/old.json", { ...queued("recipes/old.json", {}), dirty: false });
  idb.set("plans/2026-W44.json", queued("plans/2026-W44.json", {}, { branch: "main" }));
  idb.set("pantry.json", { ...queued("pantry.json", {}), dirty: false, branch: "supabase" });
  // on GitHub nothing is touched
  installBackend(null);
  assert.equal(await purgeForeignRecords(), 0);
  installBackend(createSupabaseAdapter({ client: sb.client, session: () => ME }));
  assert.equal(await purgeForeignRecords(), 2);
  assert.deepEqual([...idb.keys()].sort(), ["pantry.json", "plans/2026-W44.json"]);
  installBackend(null);
});

test("a revoked account purges everything, the queue included", async () => {
  idb.clear();
  idb.set("plans/2026-W44.json", queued("plans/2026-W44.json", {}, { branch: "supabase" }));
  idb.set("pantry.json", { ...queued("pantry.json", {}), dirty: false, branch: "supabase" });
  assert.equal(await purgeEverything(), 2);
  assert.equal(idb.size, 0);
});

test("through the store, a phone's prices.json round-trips to its house", async () => {
  idb.clear();
  resetFileChecks();
  const sb = fakeSupabase();
  installBackend(createSupabaseAdapter({ client: sb.client, session: () => ME }));
  await write("prices.json", { items: { oats: 2 } }, { raw: true });
  assert.equal((await flushNow({ timeoutMs: 3000 })).landed, true);
  assert.deepEqual(sb.docs.get("households/house-a/prices.json")?.data, { items: { oats: 2 } });
  await settle();
  assert.deepEqual(await read("prices.json", { raw: true }), { items: { oats: 2 } });
  installBackend(null);
});
