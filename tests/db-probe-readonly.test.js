// gate20 Red Team RT20-4: the probe account writes nothing; members still do.
import test from "node:test";
import assert from "node:assert/strict";
import { asUser, errorOf, SKIP } from "./_pglite.js";
import { world } from "./_world.js";

test("the probe can write no file, its house's or a housemate's; a member still can", { skip: SKIP }, async () => {
  const { db, uid } = await world();
  /** @param {string} who @param {string} path */
  const write = (who, path) =>
    errorOf(() => asUser(db, uid[who], () => db.query("select public.write_doc($1, '{\"x\":1}'::jsonb, null)", [path])));
  for (const path of ["profiles/mate-1/plans/2026-W40.json", "households/house-w/pantry.json", "profiles/probe-0a1b2c/occasions.json"]) {
    assert.equal((await write("probe-0a1b2c", path))?.code, "P0403", path);
  }
  const mate = await write("mate-1", "profiles/mate-1/plans/2026-W40.json");
  assert.ok(!mate || mate.code !== "P0403", "a member's own write is not refused");
  await db.close();
});
