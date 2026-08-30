// The build-time repricer: quota arithmetic, the negative cache, and the
// rule that a network failure changes nothing and records nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BYID_CHUNK,
  BYID_MAX_CHUNKS,
  SEARCH_BUDGET,
  MISS_EXPIRY_DAYS,
  isMissed,
  recordMiss,
  repriceList,
  reapplyOps,
} from "../app/lib/repricer.js";
import { applyLivePrice, normalizePins, pinFor, setPin } from "../app/lib/kroger.js";

const TODAY = "2026-08-30";
const STORE = "pay-less";

/** @param {string} food @param {number} n */
const upcOf = (food, n) => String(100000000000 + n);

/** a pin book with `count` pinned foods at pay-less */
function bookWith(count) {
  /** @type {Record<string, Record<string, any>>} */
  const pins = {};
  for (let i = 0; i < count; i++) {
    pins[`food-${i}`] = {
      [STORE]: { upc: upcOf(`food-${i}`, i), description: `food ${i}`, size: "16 oz", soldBy: "UNIT" },
    };
  }
  return normalizePins({
    redList: [],
    stores: { [STORE]: { locationId: "02100824", name: "Pay Less" } },
    pins,
  });
}

/** @param {number} count list rows matching the pinned foods */
function rowsFor(count) {
  return Array.from({ length: count }, (_, i) => ({
    food: `food-${i}`,
    qty: 1,
    unit: "x",
    section: "pantry",
  }));
}

const EMPTY_CAT = { updated: TODAY, stores: [STORE], items: [] };

/** @param {string} upc */
function productFor(upc, over = {}) {
  return {
    upc,
    description: "food",
    brand: "Kroger",
    categories: [],
    size: "16 oz",
    soldBy: "UNIT",
    price: { regular: 2.5, promo: null },
    stock: "HIGH",
    aisle: "4",
    ...over,
  };
}

test("byId runs in chunks of at most BYID_CHUNK and never more than BYID_MAX_CHUNKS calls", async () => {
  /** @type {number[]} */
  const callSizes = [];
  const res = await repriceList({
    items: rowsFor(150),
    pins: bookWith(150),
    prices: EMPTY_CAT,
    store: STORE,
    todayIso: TODAY,
    api: {
      pricesById: async (upcs) => {
        callSizes.push(upcs.length);
        return { products: upcs.map((u) => productFor(u)), failed: [], requested: upcs.length };
      },
      search: async () => [],
    },
  });
  assert.ok(callSizes.length <= BYID_MAX_CHUNKS, `made ${callSizes.length} byId calls`);
  for (const n of callSizes) assert.ok(n <= BYID_CHUNK, `chunk of ${n}`);
  // 150 rows, 120 processable: the overflow is REPORTED, not silently dropped
  assert.equal(res.truncated, 150 - BYID_MAX_CHUNKS * BYID_CHUNK);
  assert.equal(res.refreshed, BYID_MAX_CHUNKS * BYID_CHUNK);
});

test("the worker's requested echo surfaces a server-side truncation", async () => {
  const res = await repriceList({
    items: rowsFor(30),
    pins: bookWith(30),
    prices: EMPTY_CAT,
    store: STORE,
    todayIso: TODAY,
    api: {
      // a worker capping tighter than the client chunk: 30 sent, 10 processed
      pricesById: async (upcs) => ({
        products: upcs.slice(0, 10).map((u) => productFor(u)),
        failed: [],
        requested: 10,
      }),
      search: async () => [],
    },
  });
  assert.equal(res.truncated, 20);
});

test("search budget: at most SEARCH_BUDGET searches, most expensive unpriced rows first", async () => {
  // 14 pinless rows, all estimates: the $14 walnuts must make the cut and
  // two of the $1 staples must be left for a later build
  const cheap = [
    "salt",
    "pepper",
    "flour",
    "sugar",
    "rice",
    "beans",
    "oats",
    "milk",
    "butter",
    "honey",
    "basil",
    "thyme",
    "cumin",
  ];
  const foods = ["walnuts", ...cheap];
  const items = foods.map((food) => ({ food, qty: 1, unit: "x" }));
  const cat = {
    updated: TODAY,
    stores: [STORE],
    items: foods.map((food) => ({
      id: food,
      name: food,
      prices: { [STORE]: { price: food === "walnuts" ? 14 : 1, size: "1 x", estimate: true } },
    })),
  };
  /** @type {string[]} */
  const searched = [];
  await repriceList({
    items,
    pins: normalizePins({ stores: { [STORE]: { locationId: "1" } } }),
    prices: cat,
    store: STORE,
    todayIso: TODAY,
    api: {
      pricesById: async (upcs) => ({ products: [], failed: [], requested: upcs.length }),
      search: async (term) => {
        searched.push(term);
        return [];
      },
    },
  });
  assert.equal(searched.length, SEARCH_BUDGET);
  assert.ok(searched.includes("walnuts"), "most expensive row searched");
  assert.equal(foods.filter((f) => !searched.includes(f)).length, 2);
});

test("an empty search records a miss; a missed food is not searched again until expiry", async () => {
  const pins0 = normalizePins({ stores: { [STORE]: { locationId: "1" } } });
  const item = { food: "unicorn milk", qty: 1, unit: "x" };
  let searches = 0;
  const api = {
    pricesById: async (/** @type {string[]} */ upcs) => ({ products: [], failed: [], requested: upcs.length }),
    search: async () => {
      searches += 1;
      return [];
    },
  };
  const r1 = await repriceList({
    items: [item],
    pins: pins0,
    prices: EMPTY_CAT,
    store: STORE,
    todayIso: TODAY,
    api,
  });
  assert.equal(searches, 1);
  assert.equal(r1.missed, 1);
  assert.ok(isMissed(r1.pins, "unicorn milk", STORE, TODAY));
  // second build the same day: the miss suppresses the search
  await repriceList({ items: [item], pins: r1.pins, prices: EMPTY_CAT, store: STORE, todayIso: TODAY, api });
  assert.equal(searches, 1, "missed food searched again");
  // after expiry the food is eligible again
  assert.equal(isMissed(r1.pins, "unicorn milk", STORE, "2026-10-15"), false);
});

test("a THROWN search is not a miss and leaves the books untouched", async () => {
  const pins0 = normalizePins({ stores: { [STORE]: { locationId: "1" } } });
  const res = await repriceList({
    items: [{ food: "olive oil", qty: 1, unit: "x" }],
    pins: pins0,
    prices: EMPTY_CAT,
    store: STORE,
    todayIso: TODAY,
    api: {
      pricesById: async (upcs) => ({ products: [], failed: [], requested: upcs.length }),
      search: async () => {
        throw new Error("network down");
      },
    },
  });
  assert.equal(res.missed, 0);
  assert.equal(res.pinsChanged, false);
  assert.equal(res.pricesChanged, false);
  assert.equal(isMissed(res.pins, "olive oil", STORE, TODAY), false);
});

test("a thrown byId keeps whatever already landed and stops asking", async () => {
  let calls = 0;
  const res = await repriceList({
    items: rowsFor(80),
    pins: bookWith(80),
    prices: EMPTY_CAT,
    store: STORE,
    todayIso: TODAY,
    api: {
      pricesById: async (upcs) => {
        calls += 1;
        if (calls > 1) throw new Error("429");
        return { products: upcs.map((u) => productFor(u)), failed: [], requested: upcs.length };
      },
      search: async () => {
        throw new Error("should not search after a byId failure");
      },
    },
  });
  assert.equal(calls, 2);
  assert.equal(res.refreshed, BYID_CHUNK);
  assert.equal(res.pricesChanged, true);
});

test("recordMiss prunes expired entries", () => {
  const old = `2026-0${1}-01`; // ~8 months before TODAY, far past expiry
  const pins = normalizePins({
    stores: {},
    misses: { "stale-food": { [STORE]: old }, "fresh-food": { [STORE]: TODAY } },
  });
  const next = recordMiss(pins, "new food", STORE, TODAY);
  assert.equal(next.misses["stale-food"], undefined);
  assert.ok(next.misses["fresh-food"]);
  assert.equal(next.misses["new-food"]?.[STORE] ?? next.misses["new food"]?.[STORE], TODAY);
  assert.ok(MISS_EXPIRY_DAYS === 30);
});

test("normalizePins carries misses through a save round-trip", () => {
  const withMiss = recordMiss(
    normalizePins({ stores: {} }),
    "dill",
    STORE,
    TODAY,
  );
  const roundTripped = normalizePins(JSON.parse(JSON.stringify(withMiss)));
  assert.ok(isMissed(roundTripped, "dill", STORE, TODAY));
});

test("gated-out products are NOT a miss: a stock-out or red-listed brand records nothing", async () => {
  const pins0 = normalizePins({
    redList: ["Acme"],
    stores: { [STORE]: { locationId: "1" } },
  });
  const api = {
    pricesById: async (/** @type {string[]} */ upcs) => ({ products: [], failed: [], requested: upcs.length }),
    search: async (/** @type {string} */ term) =>
      term === "bread"
        ? [productFor("111", { description: "bread", stock: "TEMPORARILY_OUT_OF_STOCK" })]
        : [productFor("222", { description: "milk", brand: "Acme" })],
  };
  const res = await repriceList({
    items: [
      { food: "bread", qty: 1, unit: "x" },
      { food: "milk", qty: 1, unit: "x" },
    ],
    pins: pins0,
    prices: EMPTY_CAT,
    store: STORE,
    todayIso: TODAY,
    api,
  });
  assert.equal(res.missed, 0);
  assert.equal(res.needPick, 2);
  assert.equal(isMissed(res.pins, "bread", STORE, TODAY), false);
  assert.equal(isMissed(res.pins, "milk", STORE, TODAY), false);
});

test("a sizeless pack product is never auto-pinned (it could be pinned but never priced)", async () => {
  const pins0 = normalizePins({ stores: { [STORE]: { locationId: "1" } } });
  const res = await repriceList({
    items: [{ food: "rice", qty: 1, unit: "x" }],
    pins: pins0,
    prices: EMPTY_CAT,
    store: STORE,
    todayIso: TODAY,
    api: {
      pricesById: async (upcs) => ({ products: [], failed: [], requested: upcs.length }),
      search: async () => [productFor("333", { description: "rice", size: "" })],
    },
  });
  assert.equal(res.autoPicked, 0);
  assert.equal(pinFor(res.pins, "rice", STORE), null);
  // products existed, so it is a manual-pick case, not a 30-day miss
  assert.equal(res.missed, 0);
  assert.equal(res.needPick, 1);
});

test("a pin whose UPC the store dropped folds into the search phase and re-pins", async () => {
  const book = bookWith(1); // food-0 pinned with a now-dead UPC
  /** @type {string[]} */
  const searched = [];
  const res = await repriceList({
    items: rowsFor(1),
    pins: book,
    prices: EMPTY_CAT,
    store: STORE,
    todayIso: TODAY,
    api: {
      pricesById: async (upcs) => ({ products: [], failed: upcs, requested: upcs.length }),
      search: async (term) => {
        searched.push(term);
        return [productFor("999", { description: "food 0" })];
      },
    },
  });
  assert.deepEqual(searched, ["food-0"]);
  assert.equal(res.autoPicked, 1);
  assert.equal(pinFor(res.pins, "food-0", STORE)?.upc, "999");
});

test("reapplyOps: a food the user touched mid-run keeps the user's write", () => {
  const base = normalizePins({ stores: { [STORE]: { locationId: "1" } } });
  // the run auto-picked cheap products for two foods
  /** @type {import("../app/lib/repricer.js").RepriceOp[]} */
  const ops = [
    { kind: "pin", food: "salsa", product: productFor("100", { description: "salsa" }) },
    { kind: "pin", food: "tahini", product: productFor("200", { description: "tahini" }) },
    { kind: "miss", food: "dill" },
  ];
  // meanwhile the USER confirmed their own salsa pick, and pinned dill
  let live = setPin(base, "salsa", STORE, productFor("777", { description: "salsa deluxe" }), TODAY, true);
  live = setPin(live, "dill", STORE, productFor("888", { description: "dill" }), TODAY, true);
  const merged = reapplyOps(live, EMPTY_CAT, base, ops, STORE, TODAY);
  // user's salsa survives, untouched tahini lands, dill records no miss
  assert.equal(pinFor(merged.pins, "salsa", STORE)?.upc, "777");
  assert.equal(pinFor(merged.pins, "tahini", STORE)?.upc, "200");
  assert.equal(isMissed(merged.pins, "dill", STORE, TODAY), false);
  assert.equal(merged.pinsChanged, true);
});

test("applyLivePrice refuses a sizeless pack write (P4 guard)", () => {
  const cat = { updated: TODAY, stores: [STORE], items: [] };
  const sizeless = productFor("123", { size: "" });
  assert.equal(applyLivePrice(cat, STORE, "rice", sizeless, TODAY), cat);
  // weight-sold products carry no pack size by nature and still write
  const byWeight = productFor("456", { size: "", soldBy: "WEIGHT" });
  const next = applyLivePrice(cat, STORE, "chicken thighs", byWeight, TODAY);
  assert.notEqual(next, cat);
  assert.equal(next.items[0].prices[STORE].size, "per lb");
});
