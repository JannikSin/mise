// Join by link (guesthouse spec §8, 2026-09-14): the pure half of the three
// Worker routes. The claim and status routes are the only unauthenticated
// routes besides the Kroger callback, so what they accept is pinned here.
import test from "node:test";
import assert from "node:assert/strict";
import {
  branchForOrigin,
  mintInviteCode,
  INVITE_CODE_RE,
  sanitizeInviteEntry,
  sanitizeInviteTargets,
  slugForName,
  findInvite,
  inviteState,
  inviteStatusRows,
} from "../worker/src/lib.js";

test("branchForOrigin: the sandbox writes sandbox, the live app writes main, nobody else writes", () => {
  assert.equal(branchForOrigin("https://mise-next.pages.dev"), "sandbox");
  assert.equal(branchForOrigin("https://janniksin.github.io"), "main");
  assert.equal(branchForOrigin("http://127.0.0.1:8378"), null, "a local server may not write");
  assert.equal(branchForOrigin("https://evil.pages.dev"), null);
  assert.equal(branchForOrigin(null), null);
});

test("mintInviteCode: 20 lowercase base32 chars from 20 bytes, matching the route's regex", () => {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  const code = mintInviteCode(bytes);
  assert.equal(code.length, 20);
  assert.match(code, INVITE_CODE_RE);
  assert.doesNotMatch("ABCDEFGHIJKLMNOPQRST", INVITE_CODE_RE, "uppercase is normalised before the regex, never accepted raw");
  assert.doesNotMatch("k3m7pq2xv9a4bcdefgh", INVITE_CODE_RE, "19 chars");
});

test("sanitizeInviteEntry: name and emoji only; the household is never the body's to choose", () => {
  const e = sanitizeInviteEntry({ name: "  Priya  ", emoji: "🌶", family: "Shah Family", household: "wayne", id: "david" });
  assert.deepEqual(e, { name: "Priya", emoji: "🌶", family: "shah-family" });
  assert.equal(sanitizeInviteEntry({ name: "", emoji: "x" }), null);
  assert.equal(sanitizeInviteEntry({ name: "<script>", emoji: "x" }), null);
  assert.equal(sanitizeInviteEntry(null), null);
  assert.equal(sanitizeInviteEntry({ name: "a".repeat(80), emoji: "🙂" })?.name.length, 40);
});

test("sanitizeInviteTargets: whitelisted keys, sane macros, size cap", () => {
  const ok = sanitizeInviteTargets({
    macros: { calories: 2400, protein: 130, fat: 80, carbs: 290 },
    phase: "recomp",
    allergens: ["peanuts"],
    avoidIngredients: ["peanut", "groundnut"],
    mealSlots: ["breakfast", "lunch", "dinner"],
    equipment: ["blender"],
    __proto__: { polluted: true },
    capabilities: ["money"],
    household: "wayne",
    stores: ["Pay Less"],
  });
  assert.ok(ok);
  assert.equal(ok.macros.calories, 2400);
  assert.equal(ok.capabilities, undefined, "not a targets key");
  assert.equal(ok.household, undefined, "not a targets key");
  assert.deepEqual(ok.avoidIngredients, ["peanut", "groundnut"]);
  assert.equal(sanitizeInviteTargets({ macros: { calories: 50, protein: 10 } }), null, "nonsense numbers refused");
  assert.equal(sanitizeInviteTargets({ phase: "gain" }), null, "no macros, no profile");
  assert.equal(sanitizeInviteTargets({ macros: { calories: 2000, protein: 100 }, phase: "wizard" })?.phase, "maintain");
  const big = { macros: { calories: 2000, protein: 100 }, nonNegotiables: Array.from({ length: 40 }, () => "x".repeat(200)) };
  assert.ok(sanitizeInviteTargets(big), "40 x 200 chars is under the cap");
  const huge = { macros: { calories: 2000, protein: 100 }, dailyDozen: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, "y".repeat(200)])), supplementPlan: Array.from({ length: 40 }, () => ({ notes: "z".repeat(200), name: "n".repeat(200), dose: "d".repeat(200) })) };
  assert.equal(sanitizeInviteTargets(huge), null, "over 24 KB is refused");
});

test("slugForName never collides with an existing id", () => {
  const taken = new Set(["david", "priya", "priya-2"]);
  assert.equal(slugForName("Priya", taken), "priya-3");
  assert.equal(slugForName("Sam O'Neil", taken), "sam-o-neil");
  assert.equal(slugForName("!!!", taken), "guest");
});

test("findInvite + inviteState: unknown, used, expired, ok", () => {
  const file = {
    invites: [
      { code: "aaaaaaaaaaaaaaaaaaaa", house: "guesthouse", expiresAt: "2026-09-21T00:00:00.000Z" },
      { code: "bbbbbbbbbbbbbbbbbbbb", house: "guesthouse", expiresAt: "2026-09-21T00:00:00.000Z", usedAt: "2026-09-15T00:00:00.000Z", profileId: "priya" },
      { code: "cccccccccccccccccccc", house: "wayne", expiresAt: "2026-09-01T00:00:00.000Z" },
    ],
  };
  const now = "2026-09-14T12:00:00.000Z";
  assert.equal(inviteState(findInvite(file, "aaaaaaaaaaaaaaaaaaaa"), now), "ok");
  assert.equal(inviteState(findInvite(file, "bbbbbbbbbbbbbbbbbbbb"), now), "used");
  assert.equal(inviteState(findInvite(file, "cccccccccccccccccccc"), now), "expired");
  assert.equal(inviteState(findInvite(file, "dddddddddddddddddddd"), now), "unknown");
  assert.equal(findInvite(file, "not a code"), null);
  assert.equal(findInvite(null, "aaaaaaaaaaaaaaaaaaaa"), null);
});

test("inviteStatusRows: only this person's live seats in the window, with their plate", () => {
  const tables = [
    { date: "2026-09-15", slot: "dinner", recipeId: "pasta", cookId: "david", seats: [{ id: "priya", servings: 1.25 }], tailor: { seats: { priya: { plate: ["add 100 g pasta"] } } } },
    { date: "2026-09-16", slot: "dinner", recipeId: "stew", cookId: "david", seats: [{ id: "priya", servings: 1, status: "skipped" }] },
    { date: "2026-09-17", slot: "dinner", recipeId: "curry", cookId: "elliot", seats: [{ id: "david", servings: 1 }] },
    { date: "2026-10-30", slot: "dinner", recipeId: "far", cookId: "david", seats: [{ id: "priya", servings: 1 }] },
    { date: "2026-09-13", slot: "dinner", recipeId: "past", cookId: "david", seats: [{ id: "priya", servings: 1 }] },
  ];
  const rows = inviteStatusRows(tables, "priya", (id) => `Dish ${id}`, (id) => id.toUpperCase(), "2026-09-14");
  assert.deepEqual(rows, [
    { date: "2026-09-15", slot: "dinner", dish: "Dish pasta", servings: 1.25, plate: ["add 100 g pasta"], cook: "DAVID" },
  ]);
});
