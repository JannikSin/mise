// HIS RULES, ON HIS KITCHEN (Crystal Lanes/Mise-Decisions; biot's open
// regression item, 2026-11-06). David has given the same answers on 10
// dates: protein 190 g floor and 215 g ceiling on everything eaten that day,
// the swipe lunch included; three home meals a day around the swipe; the
// $100 house trip is a soft cap, never cut food to meet it. These tests plan
// a FRESH week with his real kitchen rule, targets, bank, pantry and prices
// and hold the planner to those answers, so a change that breaks them fails
// here instead of in his week.
//
// The data is private and lives in the mise-data repo, never in this public
// one: set MISE_DATA to a clone, or keep one beside this repo (../mise-data).
// Without it the tests are SKIPPED and say so; they never pass on nothing.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { planBrigadeWeek } from "../app/lib/compose.js";
import {
  normalizeEvents,
  sundayBatchOn,
  sundayTwoPotsOn,
  deriveTables,
} from "../app/lib/tables.js";
import {
  recipeBought,
  kitchenHas,
  deriveShoppingList,
  skipPlentyHeld,
  subtractPantryFromTrip,
} from "../app/lib/shopping.js";
import { itemCost, resolveHomeStore, storeSlugOf, tripTotal } from "../app/lib/prices.js";
import { datesOfWeek, recipesById } from "../app/lib/plan.js";
import { recipeTripCost, recipeTripItems } from "../app/lib/money.js";
import { withSwaps } from "../app/lib/swaps.js";
import {
  LEGACY_TARGETS_PATH,
  TARGETS_PATH,
  pathFor,
  withCurrentAllergenTerms,
} from "../app/lib/store.js";

const DATA = process.env.MISE_DATA ?? path.join(import.meta.dirname, "..", "..", "mise-data");
const HAVE = fs.existsSync(path.join(DATA, "households", "wayne", "events.json"));
const skip = HAVE
  ? false
  : `no mise-data clone at ${DATA} (set MISE_DATA); his-kitchen rules not checked`;

// a week far enough ahead that no table is set yet: a fresh SET MY WEEK
const WEEK = "2026-W47";
const DATES = datesOfWeek(WEEK);
// his numbers, from Mise-Decisions (not read from his targets file, so a
// targets edit that drifts from his answers fails loudly instead of moving
// the goalposts with it)
const DAVID = { proteinFloor: 190, proteinCeiling: 215, swipeKcal: 900, swipeProtein: 70 };

/** @param {string} p */
const J = (p) => JSON.parse(fs.readFileSync(path.join(DATA, p), "utf8"));

/** Plan his kitchen's week exactly as SET MY WEEK does. */
function planHisWeek(
  /** @type {{ snackFirst?: boolean, pantryAdd?: string[], snack?: string[], noSwaps?: boolean, elliotAllergens?: string[] }} */ opts = {},
) {
  const bank = fs
    .readdirSync(path.join(DATA, "recipes"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => J(`recipes/${f}`));
  const bankById = recipesById(bank);
  const profiles = J("profiles.json").profiles;
  const events = normalizeEvents(J("households/wayne/events.json"));
  // the fresh week: drop anything already set inside it
  const inWeek = new Set(DATES);
  events.tables = events.tables.filter((/** @type {any} */ t) => !inWeek.has(t.date));
  // the rule that covers this week (old ones stay in the file, expired)
  let brigade = events.brigades.find(
    (/** @type {any} */ b) =>
      b.memberIds.includes("david") &&
      (!b.from || b.from <= DATES[0]) &&
      (!b.until || b.until >= DATES[DATES.length - 1]),
  );
  assert.ok(brigade, "his kitchen rule");
  if (opts.snackFirst) brigade = { ...brigade, snackFirst: true };
  if (opts.snack)
    brigade = { ...brigade, slotRecipes: { ...brigade.slotRecipes, snack: opts.snack } };
  const tgt = (/** @type {string} */ id) => {
    for (const f of [TARGETS_PATH, LEGACY_TARGETS_PATH].map((p) => pathFor(id, p))) {
      if (fs.existsSync(path.join(DATA, f))) return withCurrentAllergenTerms(J(f));
    }
    return null;
  };

  const targetsById = new Map(brigade.memberIds.map((/** @type {string} */ id) => [id, tgt(id)]));
  // an allergy added the way People > Elliot adds it: the stored chip id,
  // expanded on read exactly like readTargetsOf does
  if (opts.elliotAllergens && targetsById.get("elliot")) {
    const e = targetsById.get("elliot");
    const allergens = [...new Set([...(e.allergens ?? []), ...opts.elliotAllergens])];
    targetsById.set("elliot", withCurrentAllergenTerms({ ...e, allergens }));
  }
  const pantry = J("households/wayne/pantry.json");
  for (const f of opts.pantryAdd ?? []) {
    pantry.items.push({ id: f.replace(/ /g, "-"), food: f, state: "plenty", since: DATES[0] });
  }
  const cat = J("prices.json");
  const store = resolveHomeStore({
    picked: "",
    pickedDecl: "",
    declared: storeSlugOf(targetsById.get("david")?.stores?.[0]),
    stores: cat.stores ?? [],
  });
  const has = kitchenHas(pantry, null);
  const per = new Map();
  const items = new Map();
  for (const r of bank) {
    const c = recipeTripCost(r, cat, store, has);
    if (c && c.priced > 0) per.set(r.id, c.perServing);
    items.set(r.id, recipeTripItems(r, cat, store, has));
  }
  const known = [...per.values()].sort((a, b) => a - b);
  const median = known[Math.floor(known.length / 2)] ?? 0;
  const out = planBrigadeWeek(
    events,
    { ...brigade, sundayBatch: sundayBatchOn(brigade), sundayTwoPots: sundayTwoPotsOn(brigade) },
    {
      dates: DATES,
      today: DATES[0],
      calendarToday: DATES[0],
      house: "wayne",
      profilesById: new Map(profiles.map((/** @type {any} */ p) => [p.id, p])),
      targetsById,
      plansById: new Map(),
      bankById,
      regenerate: false,
      bought: (/** @type {any} */ t) => recipeBought(bankById.get(t.recipeId), pantry, null),
      keepSet: true,
      costOf: (/** @type {string} */ rid) => per.get(rid) ?? median,
      tripItems: (/** @type {string} */ rid) => items.get(rid) ?? [],
      priceNeed: (
        /** @type {string} */ food,
        /** @type {number} */ qty,
        /** @type {string} */ unit,
      ) => itemCost({ food, qty, unit }, cat, store)?.cost ?? 0,
      budgetUsd: 100,
      ...(opts.noSwaps
        ? {}
        : {
            held: (/** @type {string} */ food, /** @type {number} */ grams) => {
              const row = [{ food, qty: grams, unit: "g" }];
              return (
                skipPlentyHeld(row, pantry, DATES[0]).covered.length > 0 ||
                subtractPantryFromTrip(row, pantry).covered.length > 0
              );
            },
          }),
    },
  );
  // the List he would get: his cook extras for the week, pantry subtracted
  const derived = deriveTables([{ house: "wayne", events: out.events }], {
    profileId: "david",
    diet: targetsById.get("david")?.diet,
    avoid: targetsById.get("david")?.avoidIngredients,
    avoidRecipes: targetsById.get("david")?.avoidRecipes,
    bankById,
    ownEntries: [],
    today: DATES[0],
    profilesById: new Map(profiles.map((/** @type {any} */ p) => [p.id, p])),
    myTargets: targetsById.get("david"),
  });
  const listPlan = {
    week: WEEK,
    entries: [
      ...derived.entries.filter((/** @type {any} */ e) => inWeek.has(e.date)),
      ...derived.cookExtras.filter((/** @type {any} */ x) => inWeek.has(x.date)),
    ],
  };
  const list = deriveShoppingList(
    /** @type {any} */ (listPlan),
    bankById,
    pantry,
    null,
    undefined,
    undefined,
    bankById,
  );
  const trip = tripTotal(subtractPantryFromTrip(list.items, pantry).toBuy, cat, store);
  return { out, brigade, trip };
}

test("his kitchen: protein lands 190 to 215 g every day, swipe lunch included", { skip }, () => {
  for (const snackFirst of [false, true]) {
    const { out } = planHisWeek({ snackFirst });
    const days = out.report.filter(
      (/** @type {any} */ r) => r.seatId === "david" && DATES.includes(r.date),
    );
    assert.equal(days.length, 7, `7 days for David (snackFirst ${snackFirst})`);
    for (const d of days) {
      assert.ok(
        d.dayProtein <= DAVID.proteinCeiling,
        `${d.date}: ${d.dayProtein} g is over his 215 g ceiling (snackFirst ${snackFirst}). His words: "no dont have the rpotein over reporting to 270"`,
      );
      assert.ok(
        d.dayProtein >= DAVID.proteinFloor,
        `${d.date}: ${d.dayProtein} g is under his 190 g floor`,
      );
      // the swipe is counted: the day carries the tray on top of the home food
      assert.equal(
        d.dayProtein - d.protein,
        DAVID.swipeProtein,
        `${d.date}: swipe protein counted`,
      );
      assert.equal(d.dayKcal - d.kcal, DAVID.swipeKcal, `${d.date}: swipe calories counted`);
    }
  }
});

test("his kitchen: every seat at the table is in band every day", { skip }, () => {
  const { out } = planHisWeek();
  assert.ok(
    out.report.filter((/** @type {any} */ r) => DATES.includes(r.date)).length >= 14,
    "two seats, seven days planned",
  );
  const bad = out.report.filter(
    (/** @type {any} */ r) => DATES.includes(r.date) && r.status !== "band",
  );
  assert.deepEqual(
    bad.map(
      (/** @type {any} */ r) =>
        `${r.seatId} ${r.date} ${r.status} ${r.dayKcal} kcal ${r.dayProtein} g`,
    ),
    [],
  );
});

test(
  "his kitchen: three home meals a day around the swipe, 21 a week, none cut for money",
  { skip },
  () => {
    const { out, brigade } = planHisWeek();
    const tables = out.events.tables.filter(
      (/** @type {any} */ t) => DATES.includes(t.date) && t.fromBrigade === brigade.id,
    );
    for (const slot of ["breakfast", "snack", "dinner"]) {
      const n = tables.filter((/** @type {any} */ t) => t.slot === slot).length;
      assert.equal(n, 7, `${slot} on all 7 days`);
    }
    assert.equal(tables.length, 21);
    // lunch is the swipe, never a home meal
    assert.equal(tables.filter((/** @type {any} */ t) => t.slot === "lunch").length, 0);
  },
);

test("his kitchen: the trip tripwire, never the $271 kind of week again", { skip }, () => {
  // a SOFT cap (David, 11/6: "it is not a hard hard cap"), so the goal is
  // not asserted as a hard number. This is the tripwire: twice the budget
  // is "significantly over" by any reading, and the 11/6 week was $271.
  for (const opts of [
    {},
    { snackFirst: true, pantryAdd: ["walnuts", "rolled oats", "honey", "baking powder"] },
  ]) {
    const { out, trip } = planHisWeek(opts);
    assert.ok(
      trip.total <= 200,
      `the List for his week is $${trip.total.toFixed(2)} (${JSON.stringify(opts)})`,
    );
    // and when over the $100, the planner says so in words (never silent)
    if (out.budget && out.budget.trip > out.budget.cap + 0.5) {
      assert.ok(
        out.notes.some((/** @type {string} */ n) => /over budget/.test(n)),
        "an over-budget week carries the note",
      );
    }
  }
});

test(
  "his kitchen: with his Costco stock in, the muffin uses his walnuts and dates and the yogurt already bought, still 190 to 215 g",
  { skip },
  () => {
    const costco = [
      "walnuts",
      "almonds",
      "pecans",
      "ground flaxseed",
      "chia seeds",
      "rolled oats",
      "honey",
      "baking powder",
      "dates",
      "granola",
    ];
    const opts = {
      snackFirst: true,
      snack: ["wayne-double-chocolate-protein-muffins"],
      pantryAdd: costco,
    };
    const { out, trip } = planHisWeek(opts);
    const muffin = (out.swaps ?? []).filter(
      (c) => c.recipeId === "wayne-double-chocolate-protein-muffins",
    );
    assert.deepEqual(muffin.map((c) => `${c.swap.from}>${c.swap.to}`).sort(), [
      "almond-butter>walnuts",
      "chocolate-chips>dates",
      "cottage-cheese>greek-yogurt",
    ]);
    for (const d of out.report.filter((r) => r.seatId === "david" && DATES.includes(r.date))) {
      assert.ok(d.dayProtein >= 190 && d.dayProtein <= 215, `${d.date} ${d.dayProtein} g`);
    }
    // and the List is cheaper than the same week without swaps
    const plain = planHisWeek({ ...opts, noSwaps: true });
    assert.ok(
      trip.total < plain.trip.total - 10,
      `$${trip.total.toFixed(2)} vs $${plain.trip.total.toFixed(2)}`,
    );
  },
);

test(
  "his kitchen: no tree nuts for Elliot (David, 11/7), on any plate he is seated at, swaps included",
  { skip },
  () => {
    const nutRe =
      /\b(almond|walnut|pecan|cashew|pistachio|hazelnut|macadamia|pine nut|brazil nut|nut butter|pesto|marzipan|praline|nutella|mixed nut|trail mix)/i;
    const costco = [
      "walnuts",
      "almonds",
      "pecans",
      "dates",
      "rolled oats",
      "honey",
      "baking powder",
    ];
    for (const opts of [
      { elliotAllergens: ["nuts"] },
      // his muffin named beside the blueberry one, Costco nuts in the pantry
      {
        elliotAllergens: ["nuts"],
        snackFirst: true,
        snack: ["blueberry-oat-protein-muffins", "wayne-double-chocolate-protein-muffins"],
        pantryAdd: costco,
      },
    ]) {
      const { out } = planHisWeek(opts);
      for (const t of out.events.tables.filter((x) => DATES.includes(x.date))) {
        const seat = (t.seats ?? []).find((s) => s.id === "elliot");
        if (!seat || seat.status === "skipped") continue;
        const recipe = J(`recipes/${t.recipeId}.json`);
        const dish = withSwaps(recipe, t.swaps) ?? recipe;
        const nutty = (dish.ingredients ?? []).filter(
          (i) => !i.optional && nutRe.test(String(i.food)),
        );
        assert.deepEqual(
          nutty.map((i) => i.food),
          [],
          `${t.date} ${t.slot} ${t.recipeId} seats Elliot (${JSON.stringify(opts.snack ?? "rule")})`,
        );
      }
      // David still lands 190 to 215 g
      for (const d of out.report.filter((r) => r.seatId === "david" && DATES.includes(r.date))) {
        assert.ok(d.dayProtein >= 190 && d.dayProtein <= 215, `${d.date} ${d.dayProtein} g`);
      }
    }
  },
);
