// Tier 3 Kroger loop: pins, candidate ranking, live price write-through,
// staleness, swap classes, allergen output-screen (fix list 3.1-3.5, PF.3).
import test from "node:test";
import assert from "node:assert/strict";
import {
  allergenHits,
  applyLivePrice,
  confirmPin,
  isStalePrice,
  locationIdFor,
  normalizePins,
  pinFor,
  priceAgeDays,
  rankCandidates,
  setPin,
  swapClassFor,
  unitPriceOf,
  STALE_PRICE_DAYS,
} from "../app/lib/kroger.js";

/** @param {Partial<import("../app/lib/kroger.js").KrogerProduct>} p */
const product = (p = {}) => ({
  upc: "0001111000000",
  description: "Kroger Fresh Atlantic Salmon Fillet",
  brand: "Kroger",
  categories: ["Meat & Seafood"],
  size: "16 oz",
  soldBy: "UNIT",
  price: { regular: 12.0, promo: null },
  stock: "HIGH",
  aisle: "Seafood",
  ...p,
});

// ---- pins ------------------------------------------------------------------

test("normalizePins survives null, junk, and partial shapes", () => {
  assert.deepEqual(normalizePins(null), { redList: [], stores: {}, pins: {} });
  assert.deepEqual(normalizePins("nope"), { redList: [], stores: {}, pins: {} });
  const kept = normalizePins({ redList: ["badbrand"], stores: { marianos: { locationId: "5" } } });
  assert.deepEqual(kept.redList, ["badbrand"]);
  assert.equal(kept.stores.marianos.locationId, "5");
});

test("setPin/pinFor round-trip on the canonical key, confirm clears provisional", () => {
  let book = normalizePins(null);
  book = setPin(book, "Salmon (fresh)", "pay-less", product(), "2026-08-19", false);
  const pin = pinFor(book, "salmon", "pay-less");
  assert.ok(pin, "parenthetical-stripped key finds the pin");
  assert.equal(pin.provisional, true);
  assert.equal(pin.upc, "0001111000000");
  book = confirmPin(book, "salmon", "pay-less", "2026-08-20");
  const confirmed = pinFor(book, "salmon", "pay-less");
  assert.equal(confirmed.provisional, undefined);
  assert.equal(confirmed.confirmedAt, "2026-08-20");
});

test("locationIdFor: registered store yields its id, anything else empty", () => {
  const book = normalizePins({ stores: { "pay-less": { locationId: "02100824" } } });
  assert.equal(locationIdFor(book, "pay-less"), "02100824");
  assert.equal(locationIdFor(book, "trader-joes"), "");
  assert.equal(locationIdFor(null, "pay-less"), "");
});

// ---- candidate ranking -----------------------------------------------------

test("rankCandidates: every food word must appear — tilapia never surfaces for salmon", () => {
  const rows = [
    product(),
    product({ upc: "2", description: "Fresh Tilapia Fillet", price: { regular: 4.99, promo: null } }),
  ];
  const ranked = rankCandidates(rows, "salmon fillet");
  assert.deepEqual(ranked.map((r) => r.upc), ["0001111000000"]);
});

test("rankCandidates: category denylist kills the baby-powder-for-cornstarch class", () => {
  const rows = [
    product({ description: "Baby Powder Cornstarch", categories: ["Baby"], upc: "3" }),
    product({ description: "Argo Corn Starch", categories: ["Baking Goods"], upc: "4", size: "16 oz" }),
  ];
  const ranked = rankCandidates(rows, "cornstarch");
  assert.deepEqual(ranked.map((r) => r.upc), ["4"], "space-insensitive match + category gate");
});

test("rankCandidates: form denylist, red list, out-of-stock and unpriced all drop", () => {
  const rows = [
    product({ upc: "5", description: "Chocolate Covered Dates Candy" }),
    product({ upc: "6", description: "Sun Dates Medjool", brand: "BadBrand" }),
    product({ upc: "7", description: "Medjool Dates", stock: "TEMPORARILY_OUT_OF_STOCK" }),
    product({ upc: "8", description: "Pitted Dates", price: { regular: null, promo: null } }),
    product({ upc: "9", description: "Deglet Noor Dates", size: "32 oz", price: { regular: 6.0, promo: null } }),
  ];
  const ranked = rankCandidates(rows, "dates", ["badbrand"]);
  assert.deepEqual(ranked.map((r) => r.upc), ["9"]);
});

test("rankCandidates sorts by UNIT price, never shelf price", () => {
  const rows = [
    product({ upc: "small", description: "Rolled Oats", size: "16 oz", price: { regular: 3.0, promo: null }, categories: ["Breakfast"] }),
    product({ upc: "big", description: "Rolled Oats Value", size: "42 oz", price: { regular: 5.0, promo: null }, categories: ["Breakfast"] }),
  ];
  const ranked = rankCandidates(rows, "rolled oats");
  assert.equal(ranked[0].upc, "big", "$0.12/oz beats $0.19/oz despite the higher shelf price");
});

test("unitPriceOf: WEIGHT-sold items are per-lb, packaged derive from size", () => {
  const byWeight = unitPriceOf(product({ soldBy: "WEIGHT", price: { regular: 8.0, promo: null } }));
  assert.equal(byWeight.unitPrice, 0.5);
  assert.equal(byWeight.unitLabel, "$8.00/lb");
  const packaged = unitPriceOf(product({ size: "2 lb", price: { regular: 8.0, promo: null } }));
  assert.equal(packaged.unitPrice, 0.25);
});

// ---- live price write-through ---------------------------------------------

test("applyLivePrice creates the row under the LEDGER key, timestamped, not an estimate", () => {
  const cat = { stores: ["marianos"], items: [] };
  const next = applyLivePrice(cat, "pay-less", "Chicken Breast (boneless)", product({ size: "48 oz", price: { regular: 11.49, promo: null } }), "2026-08-19");
  const row = next.items.find((i) => i.id === "chicken-breast");
  assert.ok(row, "row id is canonicalFood, the one ledger key");
  assert.deepEqual(row.prices["pay-less"], { price: 11.49, size: "48 oz", at: "2026-08-19" });
  assert.deepEqual(next.stores, ["marianos", "pay-less"], "new store joins the roster");
  assert.equal(cat.items.length, 0, "input never mutated");
});

test("applyLivePrice: weight-sold products store as per lb so itemCost weighs them", () => {
  const cat = { stores: [], items: [] };
  const next = applyLivePrice(cat, "pay-less", "ground beef", product({ soldBy: "WEIGHT", size: "1 lb", price: { regular: 5.99, promo: null } }), "2026-08-19");
  assert.equal(next.items[0].prices["pay-less"].size, "per lb");
});

test("applyLivePrice updates an existing fuzzy-matched legacy row instead of duplicating", () => {
  const cat = {
    stores: ["pay-less"],
    items: [{ id: "oats-old-slug", name: "rolled oats", prices: { "pay-less": { price: 3.0, size: "32 oz", estimate: true } } }],
  };
  const next = applyLivePrice(cat, "pay-less", "rolled oats", product({ description: "Rolled Oats", size: "42 oz", price: { regular: 3.49, promo: null }, categories: ["Breakfast"] }), "2026-08-19");
  assert.equal(next.items.length, 1);
  assert.deepEqual(next.items[0].prices["pay-less"], { price: 3.49, size: "42 oz", at: "2026-08-19" }, "estimate flag gone, timestamp on");
});

// ---- staleness -------------------------------------------------------------

test("staleness: timestamped prices age out, un-timestamped rows never flag", () => {
  assert.equal(priceAgeDays({ at: "2026-08-01" }, "2026-08-19"), 18);
  assert.equal(isStalePrice({ at: "2026-08-01" }, "2026-08-19"), 18 > STALE_PRICE_DAYS);
  assert.equal(isStalePrice({ at: "2026-08-10" }, "2026-08-19"), false);
  assert.equal(isStalePrice({ price: 3 }, "2026-08-19"), false, "legacy rows are estimate-governed");
  assert.equal(isStalePrice(undefined, "2026-08-19"), false);
});

// ---- swap classes + allergen screen ---------------------------------------

test("swapClassFor: same canonical food is a form swap, a different food changes the dish", () => {
  assert.equal(swapClassFor("Oats (large container)", "rolled oats"), "form");
  assert.equal(swapClassFor("salmon", "tilapia"), "dish");
});

test("allergenHits screens the OUTPUT product, space-insensitively", () => {
  const cups = product({ description: "Reese's Peanut Butter Cups", categories: ["Candy"] });
  assert.deepEqual(allergenHits(cups, ["peanut", "shellfish"]), ["peanut"]);
  assert.deepEqual(allergenHits(product(), ["peanut"]), []);
  const hidden = product({ description: "Thai Sauce", categories: ["Pea Nut Free? No: Peanut Sauce"] });
  assert.deepEqual(allergenHits(hidden, ["peanut"]), ["peanut"], "categories are screened too");
});

test("rankCandidates: the section gate keeps a drink out of a produce row", () => {
  const rows = [
    { upc: "g", description: "Gatorade Zero Lime Cucumber Sports Drink", brand: "Gatorade", categories: ["Beverages"], size: "28 fl oz", soldBy: "UNIT", price: { regular: 2.99, promo: null }, stock: "HIGH", aisle: "" },
    { upc: "c", description: "Cucumber", brand: "", categories: ["Produce"], size: "each", soldBy: "UNIT", price: { regular: 0.79, promo: null }, stock: "HIGH", aisle: "" },
  ];
  const ranked = rankCandidates(rows, "cucumber", [], "produce");
  assert.deepEqual(ranked.map((r) => r.upc), ["c"]);
  const ungated = rankCandidates(rows, "cucumber", [], "");
  assert.ok(ungated.some((r) => r.upc === "c"), "no section still finds the real cucumber");
  assert.ok(!ungated.some((r) => r.upc === "g"), "sports drink is FORM-denied even ungated");
});
