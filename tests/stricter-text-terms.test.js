// Mise 2.0, seam fix loop 2, item 9 (Red Team 2 L1; P3 knows-you, P8
// plates): a refused own-targets edit merges the typed allergy text by
// WHOLE normalized terms, never by substring, so no new term is lost.
import test from "node:test";
import assert from "node:assert/strict";

const { stricterTargets } = await import("../app/lib/stricter-targets.js");

/** @param {string} server @param {string} local */
const merged = (server, local) =>
  stricterTargets({ allergensFreeText: server }, { allergensFreeText: local })?.allergensFreeText;

test("apple is kept beside pineapple, in both directions", () => {
  assert.equal(merged("pineapple", "apple"), "pineapple; apple");
  assert.equal(merged("apple", "pineapple"), "apple; pineapple");
  assert.equal(merged("peanut", "nut"), "peanut; nut");
});

test("a term already there, in any case or spacing, is not added twice", () => {
  assert.equal(merged("Kiwi, sesame", "kiwi"), "Kiwi, sesame");
  assert.equal(merged("tree  nuts", "Tree nuts; mango"), "tree  nuts; mango");
});

test("several new terms each arrive once, and an empty server takes the local list", () => {
  assert.equal(merged("kiwi", "mango, kiwi, mango; lime"), "kiwi; mango; lime");
  assert.equal(merged("", "mango"), "mango");
});
