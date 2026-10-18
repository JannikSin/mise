// Guest log in (Mise v1.6, P8 + P3; David 2026-10-18: "not too much security,
// just a little bit of a boundary"). The pure half: names, passkeys, the
// passkey hash, the signed session, and the lockout arithmetic.
import test from "node:test";
import assert from "node:assert/strict";
import {
  guestNameKey,
  validGuestPin,
  hashGuestPin,
  verifyGuestPin,
  signGuestSession,
  verifyGuestSession,
  guestLocked,
  guestAfterFail,
  findGuestLogin,
  firstNameOf,
  guestRecipe,
  GUEST_DUMMY_SALT,
  GUEST_LOCK_MS,
  GUEST_SESSION_TTL_MS,
} from "../worker/src/lib.js";

test("a login name ignores case and spacing, and refuses junk", () => {
  assert.equal(guestNameKey("Sam K"), guestNameKey("  sam   k "));
  assert.equal(guestNameKey("José"), "josé");
  assert.equal(guestNameKey("O'Neil-Ray"), "oneilray");
  for (const bad of ["", "a", "x".repeat(31), "<script>", "12", "Sam1", null, 7]) {
    assert.equal(guestNameKey(bad), null, `${String(bad)} refused`);
  }
});

test("a passkey is exactly four digits", () => {
  assert.ok(validGuestPin("0042"));
  for (const bad of ["123", "12345", "12a4", 1234, ""]) assert.equal(validGuestPin(bad), false);
});

test("the passkey hash verifies the right passkey only, with its own salt", async () => {
  const { salt, hash } = await hashGuestPin("4821");
  assert.equal(await verifyGuestPin("4821", salt, hash), true);
  assert.equal(await verifyGuestPin("4822", salt, hash), false);
  const other = await hashGuestPin("4821");
  assert.notEqual(other.salt, salt, "a fresh salt each time");
  // the unknown-name path hashes too, so a miss costs what a hit costs
  const dummy = await hashGuestPin("4821", GUEST_DUMMY_SALT);
  assert.equal(dummy.salt, GUEST_DUMMY_SALT);
});

test("a session holds only for its signature, its branch and its lifetime", async () => {
  const now = Date.parse("2026-10-18T12:00:00Z");
  const tok = await signGuestSession({ p: "priya", b: "main" }, "secret-a", now);
  assert.deepEqual((await verifyGuestSession(tok, "secret-a", "main", now))?.p, "priya");
  assert.equal(await verifyGuestSession(tok, "secret-b", "main", now), null, "other key");
  assert.equal(await verifyGuestSession(tok, "secret-a", "sandbox", now), null, "other branch");
  assert.equal(
    await verifyGuestSession(tok, "secret-a", "main", now + GUEST_SESSION_TTL_MS + 1),
    null,
    "expired",
  );
  const [body, sig] = tok.split(".");
  const b64 = btoa(JSON.stringify({ p: "david", b: "main", exp: now + 1e9 }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const forged = `${b64}.${sig}`;
  assert.equal(await verifyGuestSession(forged, "secret-a", "main", now), null, "tampered body");
  assert.equal(await verifyGuestSession(`${body}.${sig}.x`, "secret-a", "main", now), null);
  assert.equal(await verifyGuestSession("junk", "secret-a", "main", now), null);
});

test("five wrong tries lock a login for fifteen minutes, then the count starts again", () => {
  const now = 1_000_000;
  let e = null;
  for (let i = 1; i <= 4; i++) {
    e = guestAfterFail(e, now);
    assert.equal(guestLocked(e, now), false, `try ${i} does not lock`);
  }
  e = guestAfterFail(e, now);
  assert.equal(guestLocked(e, now), true, "the fifth locks");
  assert.equal(guestLocked(e, now + GUEST_LOCK_MS + 1), false, "the lock runs out");
  assert.equal(guestAfterFail(e, now + GUEST_LOCK_MS + 1).fails, 1, "a fresh count after it");
});

test("a guest sees first names and a whitelisted recipe, nothing else", () => {
  assert.equal(firstNameOf("David Taranowski"), "David");
  assert.equal(findGuestLogin({ logins: [{ nameKey: "sam" }] }, "sam")?.nameKey, "sam");
  assert.equal(findGuestLogin(null, "sam"), null);
  const r = guestRecipe({
    name: "Chili",
    servings: 8,
    ingredients: [{ qty: 3, unit: "lb", food: "ground turkey", note: "", staple: false, secret: "x" }],
    instructions: [{ step: 1, text: "Brown it." }],
    audited: { by: "someone" },
    sourceUrl: "https://example.com",
  });
  assert.deepEqual(Object.keys(r).sort(), ["ingredients", "name", "servings", "steps"]);
  assert.deepEqual(Object.keys(r.ingredients[0]).sort(), ["food", "note", "qty", "unit"]);
  assert.deepEqual(r.steps, ["Brown it."]);
});
