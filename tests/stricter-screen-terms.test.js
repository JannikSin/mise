// Mise 2.0, seam fix loop 3, item 7 (Red Team 3 L-a; P3 knows-you, P8
// plates): the stricter merge of a refused own-targets edit reads the typed
// allergy text the way the allergy screen does, so every term the server
// text screens and every term the local edit screens is still screened.
import test from "node:test";
import assert from "node:assert/strict";

const { stricterTargets } = await import("../app/lib/stricter-targets.js");
const { avoidTermsFromAllergens } = await import("../app/lib/targets.js");

/** @param {string} text */
const screen = (text) => new Set(avoidTermsFromAllergens([], text));
/** @param {string} server @param {string} local */
const merged = (server, local) =>
  String(
    /** @type {any} */ (stricterTargets({ allergensFreeText: server }, { allergensFreeText: local }))
      .allergensFreeText ?? "",
  );

test("Q6: kiwi behind a newline in the server text is still screened", () => {
  const out = merged("apple\nkiwi", "kiwi");
  assert.ok(screen("kiwi").has("kiwi"));
  assert.ok(screen(out).has("kiwi"), `kiwi screened by ${JSON.stringify(out)}`);
  assert.ok(screen(out).has("apple\nkiwi"), "the server's own term too");
});

test("the merged text screens the union of both sides, for every pair", () => {
  const texts = [
    "",
    "kiwi",
    "Kiwi",
    "apple\nkiwi",
    "pineapple",
    "apple",
    "peanut",
    "nut",
    "celery and okra",
    "celery, okra",
    "tree nuts; mango",
    "mango, kiwi, mango; lime",
    "shellfish / sesame",
    "  fish  ",
    "milk\n, eggs",
  ];
  for (const s of texts) {
    for (const l of texts) {
      const out = screen(merged(s, l));
      for (const t of [...screen(s), ...screen(l)]) {
        assert.ok(out.has(t), `${JSON.stringify(t)} lost merging ${JSON.stringify(s)} with ${JSON.stringify(l)}`);
      }
    }
  }
});

test("nothing new locally leaves the server text exactly as it is", () => {
  assert.equal(merged("apple\nkiwi", "apple\nkiwi"), "apple\nkiwi");
  assert.equal(merged("Kiwi, sesame", "sesame, KIWI"), "Kiwi, sesame");
});

test("a new local term repeated in the edit arrives once", () => {
  assert.equal(merged("kiwi", "mango, Mango, mango"), "kiwi, mango");
});
