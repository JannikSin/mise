// Mise 2.0, seam fix loop 2, item 6 (ENG 2 N4, the 9b mutant; P3 knows-you):
// a collection listing that started under one account and lands after the
// switch to the next stores nothing. cacheRemote's purge-epoch check is
// what stops it. Made-up people only.
import test from "node:test";
import assert from "node:assert/strict";
import { idb, kv, settle } from "./helpers/fake-browser.js";

const { installBackend } = await import("../app/lib/backend.js");
const store = await import("../app/lib/store.js");

test("an A-era collection listing in flight across the switch to B never lands", async () => {
  idb.clear();
  kv.clear();
  store.resetFileChecks();
  await store.setSyncScope(null);
  /** @type {(() => void)[]} */
  const waiting = [];
  let who = { slug: "housemate-1", admin: false, home: "house-a" };
  installBackend(
    /** @type {any} */ ({
      name: "supabase",
      read: async () => null,
      write: async () => ({ sha: "pg:2" }),
      list: async (/** @type {string} */ dir) => {
        await new Promise((r) => waiting.push(() => r(undefined)));
        return [{ name: "x.json", path: `${dir}/x.json`, sha: "pg:1", data: { secret: "A only" } }];
      },
      readMeta: async () => null,
      authHeader: async () => null,
      status: async () => ({ privacy: "private", auth: "ok", reachable: true }),
      authBroken: () => false,
      stamp: () => "supabase",
      laneOf: () => "supabase",
      session: () => who,
    }),
  );
  await store.onSessionChange(null, "housemate-1");
  await store.readCollection("households/house-a/recipes", { raw: true });
  await settle();
  assert.equal(waiting.length, 1, "A's listing is in flight");
  await store.onSessionChange("housemate-1", "housemate-2");
  who = { slug: "housemate-2", admin: false, home: "house-b" };
  waiting.splice(0).forEach((r) => r());
  await settle();
  assert.equal(idb.has("households/house-a/recipes/x.json"), false, "nothing of A's lands");
  installBackend(null);
});
