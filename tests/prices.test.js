import test from "node:test";
import assert from "node:assert/strict";
import {
  matchPrice,
  itemCost,
  tripTotal,
  rankStores,
  taxRateFor,
  applyReceipt,
  storeSlugFromReceipt,
  parsePackSize,
} from "../app/lib/prices.js";

const CATALOGUE = {
  stores: ["trader-joes", "marianos"],
  items: [
    {
      id: "black-beans-can",
      name: "black beans (can)",
      prices: {
        "trader-joes": { price: 0.99, size: "15.5 oz" },
        marianos: { price: 0.99, size: "15.25 oz", estimate: true },
      },
    },
    {
      id: "olive-oil-evoo",
      name: "extra virgin olive oil",
      prices: { "trader-joes": { price: 10.99, size: "1 L" } },
    },
    {
      id: "salt-fine",
      name: "fine salt",
      prices: { "trader-joes": { price: 1.99, size: "26.5 oz" } },
    },
    {
      id: "peanut-butter-no-salt",
      name: "peanut butter, no salt added",
      prices: { "trader-joes": { price: 2.49, size: "16 oz" } },
    },
    {
      id: "sweet-potatoes",
      name: "sweet potatoes",
      prices: {
        "trader-joes": { price: 0.99, size: "each" },
        marianos: { price: 1.29, size: "per lb", estimate: true },
      },
    },
  ],
};

test("matchPrice matches by word overlap, id slug is a synonym channel", () => {
  assert.equal(matchPrice("black beans (15 oz can)", CATALOGUE.items)?.id, "black-beans-can");
  // "olive oil (500 ml)" only matches via the id's olive-oil words, not the full EVOO name
  assert.equal(matchPrice("olive oil (500 ml)", CATALOGUE.items)?.id, "olive-oil-evoo");
  // stop words dropped: "no salt added" PB must not steal the plain salt row
  assert.equal(matchPrice("fine salt", CATALOGUE.items)?.id, "salt-fine");
  assert.equal(
    matchPrice("peanut butter, no salt added (jar)", CATALOGUE.items)?.id,
    "peanut-butter-no-salt",
  );
  assert.equal(matchPrice("dragon fruit", CATALOGUE.items), null);
});

test("itemCost multiplies counted units and per-lb prices, packages otherwise", () => {
  assert.deepEqual(
    itemCost({ food: "black beans (15 oz can)", qty: 2, unit: "cans" }, CATALOGUE, "trader-joes"),
    {
      cost: 1.98,
      estimate: false,
      size: "15.5 oz",
      packs: 2,
    },
  );
  // each × qty
  assert.equal(
    itemCost({ food: "sweet potatoes", qty: 3, unit: "each" }, CATALOGUE, "trader-joes")?.cost,
    2.97,
  );
  // per-lb catalogue price × lb qty
  assert.equal(
    itemCost({ food: "sweet potatoes", qty: 1.5, unit: "lb" }, CATALOGUE, "marianos")?.cost,
    1.94,
  );
  // one counted thing against a packaged size: one package
  assert.equal(
    itemCost({ food: "olive oil (500 ml)", qty: 1, unit: "each" }, CATALOGUE, "trader-joes")?.cost,
    10.99,
  );
  // store not stocking the item
  assert.equal(
    itemCost({ food: "olive oil (500 ml)", qty: 1, unit: "each" }, CATALOGUE, "marianos"),
    null,
  );
});

test("tripTotal sums priced rows, applies regional grocery tax, counts unpriced honestly", () => {
  const items = [
    { food: "black beans (15 oz can)", qty: 2, unit: "cans" },
    { food: "olive oil (500 ml)", qty: 1, unit: "each" },
    { food: "dragon fruit", qty: 1, unit: "each" },
  ];
  const t = tripTotal(items, CATALOGUE, "trader-joes", { country: "USA", state: "IL" });
  assert.equal(t.subtotal, 12.97);
  assert.equal(t.tax, 0.13); // IL 1%
  assert.equal(t.total, 13.1);
  assert.equal(t.priced, 2);
  assert.equal(t.unpriced, 1);
});

test("taxRateFor: absent region and exempt states are 0, non-USA is 0", () => {
  assert.equal(taxRateFor(undefined), 0);
  assert.equal(taxRateFor({ country: "USA", state: "IN" }), 0);
  assert.equal(taxRateFor({ country: "USA", state: "IL" }), 0.01);
  assert.equal(taxRateFor({ country: "France", state: "IL" }), 0);
});

test("rankStores only compares stores matching the best coverage", () => {
  const items = [
    { food: "black beans (15 oz can)", qty: 2, unit: "cans" },
    { food: "olive oil (500 ml)", qty: 1, unit: "each" },
  ];
  const ranked = rankStores(items, CATALOGUE, { country: "USA", state: "IL" });
  // marianos prices only 1 of 2 rows -> excluded, TJ (2 rows) wins by coverage
  assert.deepEqual(
    ranked.map((r) => r.store),
    ["trader-joes"],
  );
});

test("storeSlugFromReceipt maps printed store names, null when unknown", () => {
  const known = ["trader-joes", "marianos", "jewel-osco", "costco"];
  assert.equal(storeSlugFromReceipt("TRADER JOE'S #703", known), "trader-joes");
  assert.equal(storeSlugFromReceipt("Mariano's Fresh Market", known), "marianos");
  assert.equal(storeSlugFromReceipt("JEWEL OSCO", known), "jewel-osco");
  assert.equal(storeSlugFromReceipt("Whole Foods", known), null);
  assert.equal(storeSlugFromReceipt("", known), null);
});

test("applyReceipt confirms matched prices AND learns unknown foods, but not till junk", () => {
  const cat = {
    stores: ["trader-joes"],
    items: [
      {
        id: "black-beans-can",
        name: "black beans (can)",
        prices: { "trader-joes": { price: 0.99, size: "15 oz", estimate: true } },
      },
      {
        id: "olive-oil-evoo",
        name: "extra virgin olive oil",
        prices: { "trader-joes": { price: 10.99, size: "1 L" } },
      },
    ],
  };
  const lines = [
    { name: "black beans", price: 1.09, size: "15.5 oz" },
    { name: "mystery artisan cheese", price: 6.5, size: "" },
  ];
  const { catalogue, applied, added, unmatched } = applyReceipt(
    cat,
    "trader-joes",
    lines,
    "2026-07-19",
  );
  // matched line: price updated, size updated, estimate flag GONE (confirmed)
  const beans = catalogue.items.find((i) => i.id === "black-beans-can");
  assert.equal(beans.prices["trader-joes"].price, 1.09);
  assert.equal(beans.prices["trader-joes"].size, "15.5 oz");
  assert.equal(beans.prices["trader-joes"].estimate, undefined);
  // CHANGED 2026-08-17. This used to assert that an unmatched line never
  // invents a catalogue row. That rule capped the catalogue at 24 items
  // against 30-to-50-line receipts, so almost every scan was read, priced
  // and thrown away, which is why David scanned for weeks and saw nothing
  // improve. Names reaching here are already decoded and user-approved, so
  // a food we do not know is a food worth learning.
  assert.equal(catalogue.items.length, 3);
  const learned = catalogue.items.find((i) => i.id === "mystery-artisan-cheese");
  assert.equal(learned.prices["trader-joes"].price, 6.5);
  assert.deepEqual(
    applied.map((a) => a.matchedId),
    ["black-beans-can"],
  );
  assert.deepEqual(
    added.map((a) => a.name),
    ["mystery artisan cheese"],
  );
  assert.deepEqual(unmatched, []);
  assert.equal(catalogue.updated, "2026-07-19");
  // original catalogue not mutated
  assert.equal(cat.items[0].prices["trader-joes"].price, 0.99);
});

test("applyReceipt refuses till junk, so the catalogue never learns SUBTOTAL", () => {
  const cat = { stores: ["marianos"], items: [] };
  const lines = [
    { name: "SUBTOTAL", price: 41.2, size: "" },
    { name: "VISA DEBIT", price: 41.2, size: "" },
    { name: "TAX", price: 1.15, size: "" },
    { name: "12", price: 2.0, size: "" },
    { name: "ok", price: 1.0, size: "" },
    { name: "roma tomato", price: 1.69, size: "1 lb" },
  ];
  const { catalogue, added, unmatched } = applyReceipt(cat, "marianos", lines, "2026-08-17");
  assert.deepEqual(
    added.map((a) => a.id),
    ["roma-tomato"],
  );
  assert.equal(catalogue.items.length, 1);
  assert.equal(unmatched.length, 5);
});

// ---- pack-size math (fix list 0.2, council 2026-08-18) ----------------------

const PACK_CATALOGUE = {
  stores: ["marianos"],
  items: [
    {
      id: "firm-tofu",
      name: "firm tofu",
      prices: { marianos: { price: 2.19, size: "14 oz" } },
    },
    {
      id: "baby-spinach",
      name: "baby spinach",
      prices: { marianos: { price: 2.99, size: "5 oz" } },
    },
    {
      id: "eggs",
      name: "eggs",
      prices: { marianos: { price: 3.29, size: "dozen" } },
    },
    {
      id: "chicken-breast",
      name: "chicken breast",
      prices: { marianos: { price: 2.99, size: "per lb" } },
    },
    {
      id: "bananas",
      name: "bananas",
      prices: { marianos: { price: 3.69, size: "5.35 lb @ 0.69/lb" } },
    },
  ],
};

test("itemCost charges whole packages, never one package for a bulk need", () => {
  // 2.3 kg of tofu against a 14 oz block is 6 blocks (the $16.72 bug was 1)
  const tofu = itemCost({ food: "firm tofu", qty: 2.3, unit: "kg" }, PACK_CATALOGUE, "marianos");
  assert.equal(tofu?.packs, 6);
  assert.equal(tofu?.cost, 13.14);
  assert.equal(tofu?.estimate, false);
  // 37.25 cups of spinach crosses dimensions via the food's cup weight: 8 bags
  const spin = itemCost(
    { food: "baby spinach", qty: 37.25, unit: "cup" },
    PACK_CATALOGUE,
    "marianos",
  );
  assert.equal(spin?.packs, 8);
  assert.equal(spin?.cost, 23.92);
});

test("itemCost: counted rows respect multi-count packages (dozen, ct)", () => {
  const eggs = itemCost({ food: "eggs", qty: 24, unit: "eggs" }, PACK_CATALOGUE, "marianos");
  assert.equal(eggs?.packs, 2);
  assert.equal(eggs?.cost, 6.58);
});

test("itemCost: per-lb pays what it weighs in any mass unit", () => {
  const kg = itemCost({ food: "chicken breast", qty: 1, unit: "kg" }, PACK_CATALOGUE, "marianos");
  assert.equal(kg?.cost, 6.59); // 2.2046 lb x 2.99
});

test("itemCost: an unconvertible need falls back to one package, flagged estimate", () => {
  // "splash" is no known unit and tofu has no per-splash weight: one package,
  // and the row must self-label as an estimate rather than read as exact
  const c = itemCost({ food: "firm tofu", qty: 2, unit: "splash" }, PACK_CATALOGUE, "marianos");
  assert.equal(c?.cost, 2.19);
  assert.equal(c?.estimate, true, "silent precision is the bug; the fallback must self-label");
});

test("matchPrice: plural stem finds bananas from banana and back", () => {
  assert.equal(matchPrice("banana", PACK_CATALOGUE.items)?.id, "bananas");
  assert.equal(matchPrice("bananas", PACK_CATALOGUE.items)?.id, "bananas");
});

test("parsePackSize reads the live catalogue's shapes", () => {
  assert.deepEqual(parsePackSize("32 oz"), { qty: 32, unit: "oz" });
  assert.deepEqual(parsePackSize("2 x 28 oz"), { qty: 56, unit: "oz" });
  assert.deepEqual(parsePackSize("dozen, cage-free"), { qty: 12, unit: "each" });
  assert.deepEqual(parsePackSize("24 ct cage-free"), { qty: 24, unit: "each" });
  assert.deepEqual(parsePackSize("sleeve of ~5 heads"), { qty: 5, unit: "each" });
  assert.deepEqual(parsePackSize("5.35 lb @ 0.69/lb"), { qty: 5.35, unit: "lb" });
  assert.deepEqual(parsePackSize("2 @ 0.79"), { qty: 2, unit: "each" });
  assert.deepEqual(parsePackSize("1 L"), { qty: 1, unit: "l" });
  assert.equal(parsePackSize("per lb"), null);
  assert.equal(parsePackSize(undefined), null);
});
