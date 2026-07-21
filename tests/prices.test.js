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

test("itemCost multiplies counted units and per-lb prices, single price otherwise", () => {
  assert.deepEqual(
    itemCost({ food: "black beans (15 oz can)", qty: 2, unit: "cans" }, CATALOGUE, "trader-joes"),
    {
      cost: 1.98,
      estimate: false,
      size: "15.5 oz",
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
  // non-counted unit, non-per-lb price: one package regardless of qty
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

test("applyReceipt overwrites matched store prices as confirmed, reports unmatched", () => {
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
  const { catalogue, applied, unmatched } = applyReceipt(cat, "trader-joes", lines, "2026-07-19");
  // matched line: price updated, size updated, estimate flag GONE (confirmed)
  const beans = catalogue.items.find((i) => i.id === "black-beans-can");
  assert.equal(beans.prices["trader-joes"].price, 1.09);
  assert.equal(beans.prices["trader-joes"].size, "15.5 oz");
  assert.equal(beans.prices["trader-joes"].estimate, undefined);
  // unmatched line never invents a catalogue row
  assert.equal(catalogue.items.length, 2);
  assert.deepEqual(
    applied.map((a) => a.matchedId),
    ["black-beans-can"],
  );
  assert.deepEqual(
    unmatched.map((u) => u.name),
    ["mystery artisan cheese"],
  );
  assert.equal(catalogue.updated, "2026-07-19");
  // original catalogue not mutated
  assert.equal(cat.items[0].prices["trader-joes"].price, 0.99);
});
