// gate20 Red Team RT20-5: a housemate must not get the git blob sha of the
// owner's FULL targets file. That sha is SHA-1 over the whole private file, in
// a format public code writes, so with the visible plate it is an offline
// guessing oracle for the owner-only fields. The plate's fingerprint is its
// content hash on every device, and neither plate_for nor a direct select of
// plates hands a client the legacy sha.
import test from "node:test";
import assert from "node:assert/strict";
import { asUser, errorOf, SKIP } from "./_pglite.js";
import { world } from "./_world.js";
import { plateShaOf } from "../app/lib/backend/supabase-adapter.js";

test("RT20-5: plate_for never returns the owner's legacy git sha", { skip: SKIP }, async () => {
  const { db, uid } = await world();
  const got = (await asUser(db, uid["mate-1"], () =>
    db.query("select public.plate_for('owner-1') as p"),
  )).rows[0].p;
  assert.ok(got && got.content_hash, "mate-1 still sees owner-1's plate");
  assert.equal("legacy_sha" in got, false, JSON.stringify(Object.keys(got)));
  await db.close();
});

test("RT20-5: a member cannot select plates.legacy_sha directly", { skip: SKIP }, async () => {
  const { db, uid } = await world();
  const e = await asUser(db, uid["mate-1"], () =>
    errorOf(() => db.query("select legacy_sha from public.plates")),
  );
  assert.ok(e, "the column is not granted");
  const ok = await asUser(db, uid["mate-1"], () =>
    errorOf(() => db.query("select data, rev, content_hash from public.plates")),
  );
  assert.equal(ok, null);
  await db.close();
});

test("RT20-5: the plate fingerprint is its content hash, even at rev 1", () => {
  assert.equal(plateShaOf({ data: {}, rev: 1, content_hash: "h1" }), "plate:h1");
  assert.equal(plateShaOf({ data: {}, rev: 1, content_hash: "h1", legacy_sha: "abc" }), "plate:h1");
});
