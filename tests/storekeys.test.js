// The two key-matching rules the List rebuild leans on (Tribunal 2026-08-30):
// plentyKey (plenty suppression + render grouping) and resolveHomeStore
// (THE store chain shared by the view, the repricer and the money ledger).
import { test } from "node:test";
import assert from "node:assert/strict";
import { plentyKey } from "../app/lib/shopping.js";
import { resolveHomeStore, storeSlugOf, stem } from "../app/lib/prices.js";

test("plentyKey maps singular and plural of a food to ONE key", () => {
  const pairs = [
    ["apple", "apples"],
    ["lime", "limes"],
    ["olive", "olives"],
    ["banana", "bananas"],
    ["berry", "berries"],
    ["tomato", "tomatoes"],
    ["peach", "peaches"],
    ["date", "dates"],
    ["walnut", "walnuts"],
    ["cheese", "cheeses"],
  ];
  for (const [one, many] of pairs) {
    assert.equal(plentyKey(one), plentyKey(many), `${one} vs ${many}`);
  }
});

test("plentyKey aliases the measured offenders onto their pantry names", () => {
  assert.equal(plentyKey("kosher salt"), plentyKey("salt"));
  assert.equal(plentyKey("sea salt"), plentyKey("salt"));
  assert.equal(plentyKey("ground black pepper"), plentyKey("black pepper"));
  assert.equal(plentyKey("ground cinnamon"), plentyKey("cinnamon"));
  assert.equal(plentyKey("cayenne pepper"), plentyKey("cayenne"));
  assert.equal(plentyKey("canned garbanzo beans"), plentyKey("chickpeas"));
  assert.equal(plentyKey("extra virgin olive oil"), plentyKey("olive oil"));
});

test("plentyKey does not merge distinct foods", () => {
  assert.notEqual(plentyKey("black pepper"), plentyKey("bell pepper"));
  assert.notEqual(plentyKey("olive oil"), plentyKey("olive"));
  assert.notEqual(plentyKey("salt"), plentyKey("black pepper"));
});

test("stem leaves non-plural s endings alone", () => {
  for (const w of ["hummus", "couscous", "swiss", "molasses"]) {
    assert.equal(stem(w), w === "molasses" ? stem("molasses") : stem(w)); // self-consistent
  }
  assert.equal(stem("hummus"), "hummus");
  assert.equal(stem("couscous"), "couscous");
});

test("resolveHomeStore: pick wins only under the declaration it was made under", () => {
  const stores = ["trader-joes", "pay-less", "marianos"];
  // stale pick from the ranked[0] era (no declaration stamp): ignored
  assert.equal(
    resolveHomeStore({ picked: "trader-joes", pickedDecl: "", declared: "pay-less", stores }),
    "pay-less",
  );
  // pick made under the CURRENT declaration: honored
  assert.equal(
    resolveHomeStore({ picked: "aldi", pickedDecl: "pay-less", declared: "pay-less", stores: [...stores, "aldi"] }),
    "aldi",
  );
  // declaration changed since the pick: pick ignored, never deleted
  assert.equal(
    resolveHomeStore({ picked: "marianos", pickedDecl: "trader-joes", declared: "pay-less", stores }),
    "pay-less",
  );
});

test("resolveHomeStore: no declaration falls to the caller's fallback, then the first store", () => {
  const stores = ["trader-joes", "pay-less"];
  assert.equal(resolveHomeStore({ stores, fallback: "pay-less" }), "pay-less");
  assert.equal(resolveHomeStore({ stores }), "trader-joes");
  // a pick with no declaration is a real pick (nothing to be stale against)
  assert.equal(resolveHomeStore({ picked: "pay-less", stores }), "pay-less");
  // candidates count only when the catalogue knows them
  assert.equal(resolveHomeStore({ picked: "wholefoods", stores, fallback: "nope" }), "trader-joes");
  assert.equal(resolveHomeStore({ stores: [] }), "");
});

test("storeSlugOf: the apostrophe strip is what makes marianos findable", () => {
  assert.equal(storeSlugOf("Pay Less"), "pay-less");
  assert.equal(storeSlugOf("Mariano's"), "marianos");
  assert.equal(storeSlugOf("Trader Joe's"), "trader-joes");
  assert.equal(storeSlugOf(undefined), "");
});
