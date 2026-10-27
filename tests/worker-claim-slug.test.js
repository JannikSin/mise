// Mise 2.0 F2 (plan section 4.2, Worker readers: index.js:1131 to
// svc.slug_free): a claim never reuses a slug that has a profile OR any
// leftover docs row under profiles/<slug>/ (a recycled id would inherit a
// stranger's targets, H5).
import test from "node:test";
import assert from "node:assert/strict";
import worker, { resetGuestCachesForTests } from "../worker/src/index.js";
import { inviteCodeHash } from "../worker/src/supa-routes.js";
import { fakeSupabase, fakeSvcDb, withFetch, workerReq, SANDBOX_ENV } from "./supabase-fakes.js";

const CODE = "k3m7pq2xvta4bcdefgh2";

test("claim skips a slug with leftover files and one with a profile; slug_free is asked every time", async () => {
  resetGuestCachesForTests();
  const db = fakeSvcDb({
    people: [{ id: "p1", slug: "guest-c", kind: "guest", name: "Earlier" }],
    // no profile for guest-c-2, but a stray targets row: still not free
    docs: { "profiles/guest-c-2/profile/targets.json": { macros: {} } },
  });
  db.st.invites[await inviteCodeHash(CODE)] = {
    host_house: "house-w",
    expires_at: "2099-01-01T00:00:00.000Z",
    used_at: null,
    claimed: null,
    status_until: null,
  };
  const sb = fakeSupabase({ rpc: db.rpc });
  await withFetch(sb.fetchImpl, async () => {
    const r = await worker.fetch(
      workerReq("/invite/claim", {
        code: CODE,
        entry: { name: "Guest C", emoji: "🍋" },
        targets: { macros: { calories: 2000, protein: 100 } },
      }),
      SANDBOX_ENV,
    );
    assert.equal(r.status, 200);
    const out = await r.json();
    assert.notEqual(out.id, "guest-c");
    assert.notEqual(out.id, "guest-c-2");
    assert.ok(db.st.docs[`profiles/${out.id}/profile/targets.json`], "both targets rows land");
    assert.ok(db.st.docs[`profiles/${out.id}/fitness/targets.json`]);
  });
  const asked = sb.calls.filter((c) => c.fn === "slug_free").map((c) => c.args.p_slug);
  assert.ok(asked.length >= 3);
  assert.equal(new Set(asked).size, asked.length, "never asks the same slug twice");
});

test("a claim the database answers slug_taken (a race) moves to the next slug", async () => {
  resetGuestCachesForTests();
  const db = fakeSvcDb({});
  db.st.invites[await inviteCodeHash(CODE)] = {
    host_house: "house-w",
    expires_at: "2099-01-01T00:00:00.000Z",
    used_at: null,
    claimed: null,
    status_until: null,
  };
  let first = true;
  const rpc = {
    ...db.rpc,
    claim_guest: (/** @type {any} */ a, /** @type {any} */ ctx) => {
      if (first) {
        first = false;
        return { status: "slug_taken" };
      }
      return db.rpc.claim_guest(a, ctx);
    },
  };
  const sb = fakeSupabase({ rpc });
  await withFetch(sb.fetchImpl, async () => {
    const r = await worker.fetch(
      workerReq("/invite/claim", {
        code: CODE,
        entry: { name: "Guest F", emoji: "🍋" },
        targets: { macros: { calories: 2000, protein: 100 } },
      }),
      SANDBOX_ENV,
    );
    assert.equal(r.status, 200);
  });
  const claims = sb.calls.filter((c) => c.fn === "claim_guest").map((c) => c.args.p_slug);
  assert.equal(claims.length, 2);
  assert.notEqual(claims[0], claims[1]);
});
