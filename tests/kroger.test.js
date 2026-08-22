// Tier 3 Kroger loop: pins, candidate ranking, live price write-through,
// staleness, swap classes, allergen output-screen (fix list 3.1-3.5, PF.3).
import test from "node:test";
import assert from "node:assert/strict";
import {
  aisleLabelsFromPins,
  allergenHits,
  applyLivePrice,
  confirmPin,
  shelfAisle,
  shelfAisleAgeDays,
  isStalePrice,
  locationIdFor,
  normalizePins,
  pinFor,
  priceAgeDays,
  rankCandidates,
  refreshPinFacts,
  setPin,
  swapClassFor,
  unitPriceOf,
  STALE_PRICE_DAYS,
} from "../app/lib/kroger.js";
import { aisleOf } from "../app/lib/ingredients.js";

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

test("3.6: with a known need, cost-to-cover outranks unit price (the 3 lb tray lesson)", () => {
  const rows = [
    product({ upc: "big", description: "Ground Beef Tray", size: "3 lb", price: { regular: 19.95, promo: null }, categories: ["Meat"] }),
    product({ upc: "small", description: "Ground Beef Roll", size: "1 lb", price: { regular: 7.49, promo: null }, categories: ["Meat"] }),
  ];
  const withNeed = rankCandidates(rows, "ground beef", [], "meat", { qty: 450, unit: "g" });
  assert.equal(withNeed[0].upc, "small", "one 1 lb roll covers 450 g for $7.49; the tray costs $19.95");
  assert.equal(withNeed[0].spend, 7.49);
  assert.equal(withNeed[1].spend, 19.95);
  const noNeed = rankCandidates(rows, "ground beef", [], "meat");
  assert.equal(noNeed[0].upc, "big", "without a need, unit price still rules");
});

test("3.6: WEIGHT-sold items cover a need at pay-what-it-weighs", () => {
  const rows = [product({ upc: "w", description: "Chicken Thighs", soldBy: "WEIGHT", size: "1 lb", price: { regular: 1.79, promo: null }, categories: ["Meat"] })];
  const ranked = rankCandidates(rows, "chicken thighs", [], "meat", { qty: 2, unit: "lb" });
  assert.equal(ranked[0].spend, 3.58);
});

// ---- the store's own answer is kept (David, 2026-08-22) --------------------
// `trimProduct` has always returned the per-store aisle, brand and categories
// on every lookup, free. `setPin` used to drop all three, so the list sorted
// by a taxonomy identical for every store on earth while Kroger's real answer
// was thrown away. These lock that shut.

test("setPin keeps the store's aisle, brand and categories", () => {
  const product = {
    upc: "0001",
    description: "Broccoli Crowns",
    brand: "Private Selection",
    categories: ["Produce", "Vegetables"],
    size: "1 lb",
    soldBy: "WEIGHT",
    price: { regular: 2.49, promo: null },
    stock: "HIGH",
    aisle: "PRODUCE",
  };
  const book = setPin(normalizePins(null), "broccoli", "pay-less", product, "2026-08-22", true);
  const pin = pinFor(book, "broccoli", "pay-less");
  assert.equal(pin.aisle, "PRODUCE");
  assert.equal(pin.brand, "Private Selection");
  assert.deepEqual(pin.categories, ["Produce", "Vegetables"]);
  assert.equal(pin.seenAt, "2026-08-22");
  assert.equal(pin.confirmedAt, "2026-08-22");
});

test("a product Kroger gave no aisle for stores no aisle key at all, not an empty string", () => {
  const bare = {
    upc: "0002", description: "Mystery", brand: "", categories: [],
    size: "", soldBy: "", price: { regular: null, promo: null }, stock: "", aisle: "",
  };
  const book = setPin(normalizePins(null), "mystery", "pay-less", bare, "2026-08-22", false);
  const pin = pinFor(book, "mystery", "pay-less");
  assert.ok(!("aisle" in pin), "absent, so a caller must fall back rather than render blank");
  assert.ok(!("brand" in pin));
  assert.equal(pin.provisional, true);
});

test("shelfAisle reads the store's answer, and is empty when there is none", () => {
  const product = {
    upc: "3", description: "d", brand: "", categories: [], size: "", soldBy: "",
    price: { regular: null, promo: null }, stock: "", aisle: "AISLE 12",
  };
  const book = setPin(normalizePins(null), "quinoa", "pay-less", product, "2026-08-22", true);
  assert.equal(shelfAisle(book, "quinoa", "pay-less"), "AISLE 12");
  assert.equal(shelfAisle(book, "quinoa", "marianos"), "", "aisle is per STORE, never shared");
  assert.equal(shelfAisle(book, "nothing-pinned", "pay-less"), "");
  assert.equal(shelfAisle(null, "quinoa", "pay-less"), "");
});

test("shelfAisleAgeDays ages the store data, because a reset moves aisles", () => {
  const product = {
    upc: "4", description: "d", brand: "", categories: [], size: "", soldBy: "",
    price: { regular: null, promo: null }, stock: "", aisle: "AISLE 3",
  };
  const book = setPin(normalizePins(null), "oats", "pay-less", product, "2026-08-01", true);
  assert.equal(shelfAisleAgeDays(book, "oats", "pay-less", "2026-08-22"), 21);
  assert.equal(shelfAisleAgeDays(book, "never-pinned", "pay-less", "2026-08-22"), null);
});

test("confirmPin refreshes seenAt: a human just stood in front of it", () => {
  const product = {
    upc: "5", description: "d", brand: "", categories: [], size: "", soldBy: "",
    price: { regular: null, promo: null }, stock: "", aisle: "AISLE 7",
  };
  let book = setPin(normalizePins(null), "rice", "pay-less", product, "2026-08-01", false);
  book = confirmPin(book, "rice", "pay-less", "2026-08-22");
  const pin = pinFor(book, "rice", "pay-less");
  assert.equal(pin.seenAt, "2026-08-22");
  assert.equal(pin.confirmedAt, "2026-08-22");
  assert.ok(!("provisional" in pin));
});

test("aisleLabelsFromPins derives a store's walk map from what the store said", () => {
  const p = (aisle) => ({
    upc: "x", description: "d", brand: "", categories: [], size: "", soldBy: "",
    price: { regular: null, promo: null }, stock: "", aisle,
  });
  let book = normalizePins(null);
  // three produce foods, all agreeing
  for (const f of ["broccoli", "carrot", "onion"])
    book = setPin(book, f, "pay-less", p("PRODUCE"), "2026-08-22", true);
  const labels = aisleLabelsFromPins(book, "pay-less");
  assert.equal(labels[aisleOf("broccoli")], "PRODUCE");
});

test("a section whose pins disagree gets NO label rather than a misleading one", () => {
  const p = (aisle) => ({
    upc: "x", description: "d", brand: "", categories: [], size: "", soldBy: "",
    price: { regular: null, promo: null }, stock: "", aisle,
  });
  let book = normalizePins(null);
  // four produce foods scattered over four different aisles: nothing dominates
  const scattered = [["broccoli", "A1"], ["carrot", "A2"], ["onion", "A3"], ["tomato", "A4"]];
  for (const [f, a] of scattered) book = setPin(book, f, "pay-less", p(a), "2026-08-22", true);
  const labels = aisleLabelsFromPins(book, "pay-less");
  assert.equal(labels[aisleOf("broccoli")], undefined, "no majority, so no claim");
});

test("the derived map is per store and never borrows another store's layout", () => {
  const p = (aisle) => ({
    upc: "x", description: "d", brand: "", categories: [], size: "", soldBy: "",
    price: { regular: null, promo: null }, stock: "", aisle,
  });
  let book = normalizePins(null);
  book = setPin(book, "quinoa", "marianos", p("AISLE 9"), "2026-08-22", true);
  assert.deepEqual(aisleLabelsFromPins(book, "pay-less"), {}, "Vernon Hills says nothing about West Lafayette");
  assert.equal(aisleLabelsFromPins(book, "marianos")[aisleOf("quinoa")], "AISLE 9");
});

test("the derived map is stable: equal counts break alphabetically, not by insertion order", () => {
  const p = (aisle) => ({
    upc: "x", description: "d", brand: "", categories: [], size: "", soldBy: "",
    price: { regular: null, promo: null }, stock: "", aisle,
  });
  let a = normalizePins(null);
  a = setPin(a, "broccoli", "s", p("ZZZ"), "2026-08-22", true);
  a = setPin(a, "carrot", "s", p("AAA"), "2026-08-22", true);
  let b = normalizePins(null);
  b = setPin(b, "carrot", "s", p("AAA"), "2026-08-22", true);
  b = setPin(b, "broccoli", "s", p("ZZZ"), "2026-08-22", true);
  assert.deepEqual(aisleLabelsFromPins(a, "s", 0.5), aisleLabelsFromPins(b, "s", 0.5));
});

// ---- the weekly refresh backfills store facts onto pins made before this ---

test("refreshPinFacts backfills an aisle onto a pin that never had one", () => {
  const old = {
    upc: "9", description: "Old Name", brand: "", categories: [], size: "12 oz", soldBy: "UNIT",
    price: { regular: 1, promo: null }, stock: "", aisle: "",
  };
  let book = setPin(normalizePins(null), "oats", "pay-less", old, "2026-06-01", true);
  assert.equal(shelfAisle(book, "oats", "pay-less"), "", "starts with nothing, like the 89 real pins");

  const fresh = { ...old, description: "Rolled Oats", aisle: "AISLE 5", brand: "Kroger", categories: ["Breakfast"] };
  book = refreshPinFacts(book, "oats", "pay-less", fresh, "2026-08-22");
  const pin = pinFor(book, "oats", "pay-less");
  assert.equal(pin.aisle, "AISLE 5");
  assert.equal(pin.brand, "Kroger");
  assert.equal(pin.description, "Rolled Oats");
  assert.equal(pin.seenAt, "2026-08-22");
  assert.equal(pin.confirmedAt, "2026-06-01", "a human's confirmation is NOT reset by a refresh");
});

test("refreshPinFacts refuses to touch a pin whose UPC has moved on", () => {
  const a = {
    upc: "AAA", description: "A", brand: "", categories: [], size: "", soldBy: "",
    price: { regular: 1, promo: null }, stock: "", aisle: "AISLE 1",
  };
  const book = setPin(normalizePins(null), "rice", "pay-less", a, "2026-08-01", true);
  const other = { ...a, upc: "BBB", aisle: "AISLE 99" };
  assert.equal(
    refreshPinFacts(book, "rice", "pay-less", other, "2026-08-22"),
    book,
    "a different product is a RE-pin, which needs a person",
  );
});

test("refreshPinFacts leaves a provisional pin provisional", () => {
  const p = {
    upc: "7", description: "d", brand: "", categories: [], size: "", soldBy: "",
    price: { regular: 1, promo: null }, stock: "", aisle: "AISLE 2",
  };
  let book = setPin(normalizePins(null), "beans", "pay-less", p, "2026-08-01", false);
  book = refreshPinFacts(book, "beans", "pay-less", { ...p, aisle: "AISLE 3" }, "2026-08-22");
  const pin = pinFor(book, "beans", "pay-less");
  assert.equal(pin.provisional, true, "still needs a human tap");
  assert.equal(pin.aisle, "AISLE 3", "but the store moved it and we know that");
});

test("refreshPinFacts is a no-op on an unpinned food and on a same-day repeat", () => {
  const p = {
    upc: "8", description: "d", brand: "", categories: [], size: "", soldBy: "",
    price: { regular: 1, promo: null }, stock: "", aisle: "AISLE 4",
  };
  const empty = normalizePins(null);
  assert.equal(refreshPinFacts(empty, "nothing", "pay-less", p, "2026-08-22"), empty);
  const book = setPin(empty, "corn", "pay-less", p, "2026-08-22", true);
  assert.equal(
    refreshPinFacts(book, "corn", "pay-less", p, "2026-08-22"),
    book,
    "nothing moved and we already looked today, so no write",
  );
});
