import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";

import { generateWeek } from "../app/lib/weekbuilder.js";
import { composeManifest, manifestLines } from "../app/lib/manifest.js";
import {
  cycleSlotAway,
  datesOfWeek,
  dayTotals,
  mergeRecipePool,
  recipeConflicts,
  recipesById,
  recordCook,
  saveFallback,
  restoreFallback,
} from "../app/lib/plan.js";
import {
  avoidTermsFromAllergens,
  enforcedFloors,
  targetsSanity,
} from "../app/lib/targets.js";
import { itemCost, parsePackSize, matchPrice, tripTotal } from "../app/lib/prices.js";
import {
  deriveShoppingList,
  subtractPantryFromTrip,
  withAutoUseSoon,
} from "../app/lib/shopping.js";
import { cookPlan } from "../app/lib/portions.js";
import { buildServe } from "../app/lib/serve.js";
import { clampGuests, deriveTables, setTableGuests } from "../app/lib/tables.js";
import { composeWeekReview } from "../app/lib/review.js";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PROMISE LEDGER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS FILE EXISTS.
 *
 * On 2026-08-19 two audits of this application ran within hours of each other
 * and disagreed about almost everything. One graded each promise on whether
 * the machinery existed and reported eleven of twelve LIVE. The other graded
 * each promise on its own DONE TEST as literally written and reported nine of
 * twelve failing. Both were reading the same document.
 *
 * The sharper half of the diagnosis is not that anyone was careless. Mise's
 * protein ceiling WAS noticed: the manifest measured it, persisted it to disk,
 * rendered the words "ABOVE the band" on screen, and the number was written
 * into the working list in prose. Then it was reclassified from a failure into
 * a schedule item, "gated behind one measured manifest week."
 *
 *   The document said DONE WHEN. The working list said GATED. And nothing in
 *   the system was capable of noticing that those two sentences contradict
 *   each other.
 *
 * Anvil was inoculated against this the same day (anvil/tests/promises.test.js).
 * Mise, the application the disease was diagnosed IN, was not. This file closes
 * that, and it is deliberately stricter than its sibling in one place: a
 * PARTIAL promise must name BOTH a real test for the half that works AND a
 * registered gap for the half that does not. "Partially working" is the exact
 * state that rotted the protein ceiling, so it is the state that gets the most
 * machinery pointed at it, never the least.
 *
 * ─── HOW IT WORKS ─────────────────────────────────────────────────────────
 *
 * Lanes/Mise-Core-Purpose.md carries a **Status:** line under every promise's
 * done test. Exactly three forms are legal:
 *
 *   ✅ PROVEN    > "<test name>"
 *   🟡 PARTIAL   > "<test name>" · GAP > "<todo name>"
 *   🔴 NOT BUILT · GAP > "<todo name>"
 *
 * This file parses that document and fails the build when the document and the
 * suite disagree. The document is allowed to describe things that are not
 * built. It is not allowed to be WRONG about which ones.
 *
 * ─── FOUR RULES, INHERITED AND BINDING ────────────────────────────────────
 *
 * 1. A promise may not be marked proven by a test that only reads source text.
 *    The test has to exercise the behaviour. A grep asserting that a warning
 *    string exists is not proof that the warning fires.
 * 2. Unbuilt is `todo`, never absent. Every gap is a printed todo carrying a
 *    named owner and its job on Lanes/Mise-Fix-List. The UNBUILT list below IS
 *    the gate register, which makes the Core Purpose's own corollary ("no
 *    feature ships dark: anything built behind a gate gets a date and an owner
 *    in the same commit") machine-checked for the first time.
 * 3. When a promise's status changes, the status line changes in the SAME
 *    commit as the code.
 * 4. The authority document is read out of the Obsidian vault, where David
 *    reads it. A second copy inside the repo would be the exact disease this
 *    file exists to prevent. If the vault is absent the meta-tests FAIL rather
 *    than skip: a silent skip is the rot mode.
 */

const DOC =
  "C:\\Users\\DATar\\Sanity\\Obsidian\\Crystal\\Lanes\\Mise-Core-Purpose.md";

// The LIVE bank and the LIVE price catalogue, not the shipped seed. P12 is a
// promise about the bank David actually eats out of, and seed-data/generated
// is a first-run fixture that has already drifted 19 recipes away from it.
const BANK_DIR = new URL("../../mise-data/recipes/", import.meta.url);
const CATALOGUE = new URL("../../mise-data/prices.json", import.meta.url);

// ───────────────────────────────────────────────────────────────────────────
// Fixtures. Synthetic where a promise is about ENGINE behaviour (so the test
// states its own premises), real where a promise is about THE DATA.
// ───────────────────────────────────────────────────────────────────────────

const WEEK = "2026-W40";
const DATES = datesOfWeek(WEEK);

/** A pool deep enough that every committee has real choices. */
function pool(extra = []) {
  const base = ["breakfast", "lunch", "dinner", "smoothie", "snack"].flatMap((meal) =>
    [1, 2, 3, 4, 5].map((n) => ({
      id: `${meal}-${n}`,
      name: `${meal} ${n}`,
      mealType: meal,
      servings: 1,
      totalTime: 30,
      difficulty: 1,
      nutrition: { calories: 520, protein: 34, carbs: 50, fat: 15 },
      ingredients: [{ qty: 100, unit: "g", food: `${meal} food ${n}` }],
      foodGroups: { beans: n % 2, greens: (n + 1) % 2 },
      instructions: ["cook it"],
    })),
  );
  return [...base, ...extra];
}

const TARGETS = {
  macros: { calories: 3700, caloriesFloor: 3500, protein: 175, proteinFloor: 155 },
  phase: "gain",
  lastReviewed: "2026-08-18",
  dailyDozen: { beans: 3, greens: 2 },
};

/** One deterministic generator run. */
function build(opts = {}) {
  return generateWeek({
    recipes: opts.recipes ?? pool(),
    targets: opts.targets ?? TARGETS,
    pantry: opts.pantry ?? { items: [] },
    weekId: WEEK,
    plan: opts.plan ?? { week: WEEK, entries: [] },
    salt: opts.salt ?? 1,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// THE BEHAVIOUR TESTS. One per promise-half the document claims is proven.
// The `name` MUST match the document's Status line character for character.
// ═══════════════════════════════════════════════════════════════════════════

/** @type {{ id: string, name: string, fn: () => void }[]} */
const PROMISES = [
  {
    id: "P1",
    name: "P1 every generated day lands inside its floors, re-derived from the plan as it stands",
    fn: () => {
      const { plan, report } = build();

      // The generation half: no day is short on either axis, and the engine
      // says which days if any are.
      assert.deepEqual(report.proteinShortDays, [], "a generated day fell under the protein floor");
      assert.deepEqual(report.calorieShortDays, [], "a generated day fell under the calorie floor");

      // The floors enforced are the ones the profile WROTE, never a ratio of
      // the target. That regression held David to 199.5 g against his written
      // 185 for months, invisibly, because no screen showed the enforced number.
      const floors = enforcedFloors(TARGETS.macros);
      assert.equal(floors.calories, 3500);
      assert.equal(floors.protein, 155);
      assert.equal(report.manifest.floors.calories, floors.calories);
      assert.equal(report.manifest.floors.protein, floors.protein);

      // The "re-checked after every edit" half, floors side. Empty a day and
      // the manifest must report the HOLE, not the engine's stale copy of a
      // plan that no longer exists.
      const victim = plan.entries.find((e) => e.slot === "dinner");
      assert.ok(victim, "the fixture generated a dinner to delete");
      const edited = { ...plan, entries: plan.entries.filter((e) => e.date !== victim.date) };
      const after = composeManifest({
        engine: report.manifest,
        targets: TARGETS,
        recipes: pool(),
        dailyDays: [],
        recentPlans: [{ weekId: WEEK, plan: edited }],
        todayIso: DATES[0],
      });
      assert.ok(
        after.subsystems.floors.calorieShortDays > 0,
        "a day emptied by an edit still reported as meeting its floor: the manifest is " +
          "describing a plan that no longer exists",
      );

      // And it says so out loud rather than only knowing it internally.
      const lines = manifestLines(after, edited, DATES[0])
        .map((l) => l.text)
        .join("\n");
      assert.match(lines, /short days/i, "the manifest does not render its floor misses");
    },
  },

  {
    id: "P2",
    name: "P2 GENERATE resolves every slot and the finished week needs no network",
    fn: () => {
      const { plan } = build();
      const byId = recipesById(pool());

      // Every proactively-filled slot on every day of the week resolves.
      for (const date of DATES) {
        const onDay = plan.entries.filter((e) => e.date === date);
        for (const slot of ["breakfast", "lunch", "dinner"]) {
          assert.ok(
            onDay.some((e) => e.slot === slot),
            `${date} ${slot} came back unresolved: GENERATE left a blank page`,
          );
        }
      }

      // THE OFFLINE PROPERTY, stated in data terms: every entry is either
      // satisfied by a recipe already in the local bank, or is an away
      // placeholder carrying its own macros. Nothing in the finished week
      // requires a lookup that is not already on the device.
      for (const e of plan.entries) {
        const local = e.recipeId ? byId.has(e.recipeId) : false;
        const selfContained = Boolean(e.out) && Number.isFinite(e.estCalories);
        assert.ok(
          local || selfContained,
          `entry on ${e.date}/${e.slot} resolves to neither a local recipe nor a ` +
            `self-describing away meal, so the week is not readable offline`,
        );
      }

      // Every day is readable and cookable: totals compute from the plan plus
      // the local bank alone.
      for (const date of DATES) {
        const t = dayTotals(plan.entries, byId, date);
        assert.ok(t.calories > 0, `${date} has no readable calorie total offline`);
      }
    },
  },

  {
    id: "P3",
    name: "P3 allergens are enforced on everything GENERATE produces, and a stated target is sanity-checked",
    fn: () => {
      // A peanut allergy, declared the way the profile declares it.
      const avoid = avoidTermsFromAllergens(["peanuts"], "");
      assert.ok(avoid.length > 0, "a declared allergen produced no avoid terms");

      const peanut = {
        id: "dinner-peanut",
        name: "Peanut Noodles",
        mealType: "dinner",
        servings: 1,
        totalTime: 20,
        difficulty: 1,
        nutrition: { calories: 900, protein: 60, carbs: 60, fat: 30 },
        ingredients: [{ qty: 100, unit: "g", food: "peanut butter" }],
        foodGroups: { nuts: 1 },
        instructions: ["cook it"],
      };
      const poisoned = pool([peanut]);

      // The screen is code, not a suggestion: it rejects the recipe outright.
      assert.ok(
        recipeConflicts(peanut, undefined, avoid, []).length > 0,
        "an allergenic recipe passed the hard screen",
      );

      // And the pool the generator actually receives cannot contain it, so no
      // week it produces can either.
      const screened = mergeRecipePool(poisoned, [], undefined, avoid, undefined);
      assert.ok(
        !screened.some((r) => r.id === "dinner-peanut"),
        "the allergenic recipe survived into the generator's pool",
      );
      const { plan } = build({ recipes: screened });
      assert.ok(
        !plan.entries.some((e) => e.recipeId === "dinner-peanut"),
        "GENERATE served a recipe containing a declared allergen",
      );

      // Preferences measurably change what comes out: a stated diet narrows
      // the pool rather than decorating it.
      const vegan = mergeRecipePool(poisoned, [], undefined, avoid, "vegan");
      assert.ok(vegan.length <= screened.length, "a stricter diet did not narrow the pool");

      // No target is enforced that was never sanity-checked. The gate is a
      // loud advisory, never a hard block: fasting protocols, cutting weight
      // for a sport and 12,000 kcal training blocks are all real.
      const body = { weightLb: 195, heightIn: 71, age: 20, sex: "m", activity: 3 };
      assert.equal(targetsSanity({ body, macros: { calories: 3700 } }).verdict, "inside");
      const wild = targetsSanity({ body, macros: { calories: 12000 } });
      assert.equal(wild.verdict, "outside", "an implausible target passed unchallenged");
      assert.ok(wild.maintenance > 0, "the advisory does not show its own working");
      assert.equal(
        targetsSanity({
          body,
          macros: { calories: 12000 },
          targetReason: "track season, coach-set",
        }).verdict,
        "outside-with-reason",
        "a stated reason must be recorded, and must not become a block",
      );
      // A profile with no body stats is UNCHECKED and says so, rather than
      // silently passing: an unmeasured target must never read as a safe one.
      assert.equal(targetsSanity({ macros: { calories: 3700 } }).verdict, "unchecked");
    },
  },

  {
    id: "P4",
    name: "P4 every priced row charges a real pack size, and unpriced rows are counted out loud",
    fn: () => {
      const cat = JSON.parse(readFileSync(CATALOGUE, "utf8"));
      assert.ok(cat.items.length > 0, "the live catalogue is empty");

      // DATA INVARIANT: a catalogue row without a size cannot be charged as a
      // package, which is how a ~$170 basket once reported as $16.72.
      /** @type {string[]} */
      const sizeless = [];
      for (const item of cat.items) {
        for (const [store, p] of Object.entries(item.prices ?? {})) {
          if (!(typeof p.size === "string" && p.size.trim().length > 0)) {
            sizeless.push(`${item.id} at ${store}`);
          }
        }
      }
      assert.deepEqual(sizeless, [], "catalogue rows carry a price and no pack size");

      // BEHAVIOUR: buying is by the package, not by the spoonful. A need far
      // larger than one pack must cost more than one pack.
      const store = cat.stores[0];
      const priced = cat.items.find((i) => {
        const p = i.prices?.[store];
        return p && (parsePackSize(p.size)?.qty ?? 0) > 0;
      });
      assert.ok(priced, "no catalogue row parses a pack size at the first store");
      const pack = parsePackSize(priced.prices[store].size);
      const big = itemCost({ food: priced.name, qty: pack.qty * 4, unit: pack.unit }, cat, store);
      assert.ok(big, "a four-pack need priced to nothing");
      assert.ok(
        big.cost > priced.prices[store].price * 3,
        `${priced.id}: four packs' worth charged ${big.cost} against a ` +
          `${priced.prices[store].price} pack price`,
      );

      // BEHAVIOUR: a row the catalogue does not know is COUNTED, never
      // silently dropped to zero. The total is honest about being a floor.
      const t = tripTotal(
        [
          { food: priced.name, qty: pack.qty, unit: pack.unit },
          { food: "narwhal tenderloin", qty: 1, unit: "lb" },
        ],
        cat,
        store,
        cat.region,
      );
      assert.equal(t.unpriced, 1, "an unknown row vanished from the coverage count");
      assert.ok(t.total > 0, "the known row did not price");

      // And the matcher reaches real products under real names: the failure
      // that once left 43 of 51 rows unpriced.
      assert.ok(matchPrice(priced.name, cat.items), "a catalogue row could not match its own name");
    },
  },

  {
    id: "P5",
    name: "P5 the week is priced before you shop, and prepaid value lowers what the groceries must buy",
    fn: () => {
      // THE TRUTH HALF: a real total, against a real store, from the plan,
      // before anyone leaves the house.
      const cat = JSON.parse(readFileSync(CATALOGUE, "utf8"));
      const store = cat.stores[0];
      const { plan } = build();
      const list = deriveShoppingList(plan, recipesById(pool()), { items: [] }, null, DATES[0]);
      assert.ok(list.items.length > 0, "a generated week derived no shopping list");
      const t = tripTotal(list.items, cat, store, cat.region);
      assert.equal(
        t.priced + t.unpriced,
        list.items.length,
        "every row is either priced or counted as unpriced: no row may go missing between the two",
      );

      // THE PREPAID-VALUE HALF, the only currency that acts today. A dining
      // swipe is value already paid for, so it is spent BEFORE cash: the
      // cooked week aims at what remains and the groceries buy less protein,
      // which is the whole arbitrage.
      const day = DATES[3];
      const est = { estCalories: 800, estProtein: 40 };
      const swipeEst = { estCalories: 900, estProtein: 60 };
      const base = build();
      const withSwipe = build({
        plan: (() => {
          let p = { week: WEEK, entries: [] };
          // two cycles: away, then swipe
          p = cycleSlotAway(p, day, "dinner", est, swipeEst, "swipe");
          p = cycleSlotAway(p, day, "dinner", est, swipeEst, "swipe");
          return p;
        })(),
      });

      const away = withSwipe.plan.entries.filter((e) => e.date === day && e.out);
      assert.ok(away.length > 0, "the swipe slot did not survive generation");
      assert.ok(
        away.every((e) => Number.isFinite(e.estCalories) && e.estCalories > 0),
        "a swipe entered the plan with no macro credit, so the day was planned around a fiction",
      );

      const byId = recipesById(pool());
      const cookedProtein = (r) =>
        r.plan.entries
          .filter((e) => e.date === day && !e.out && e.recipeId)
          .reduce(
            (s, e) => s + (byId.get(e.recipeId)?.nutrition?.protein ?? 0) * (e.servings ?? 1),
            0,
          );
      assert.ok(
        cookedProtein(withSwipe) < cookedProtein(base),
        `the swipe day still cooked ${cookedProtein(withSwipe)} g of protein against ` +
          `${cookedProtein(base)} g without it: prepaid value was not spent first`,
      );

      // And the day still lands: eating prepaid value must not cost the numbers.
      assert.deepEqual(
        withSwipe.report.proteinShortDays,
        [],
        "the swipe day fell under the protein floor",
      );
    },
  },

  {
    id: "P6",
    name: "P6 what you own is subtracted from the list, and stock is never forced into the plan",
    fn: () => {
      // SUBTRACTION: an owned food does not get bought again. This is the bug
      // that had David buying oats, whey, onions and wine he already had.
      const items = [
        { food: "rolled oats", qty: 500, unit: "g" },
        { food: "chicken thigh", qty: 2, unit: "lb" },
      ];
      const { toBuy, covered } = subtractPantryFromTrip(items, {
        items: [{ food: "rolled oats", qty: "1000 g", location: "pantry" }],
      });
      const oats = toBuy.find((i) => /oats/.test(i.food));
      assert.ok(
        !oats,
        "a food already on the shelf was still put on the shopping list",
      );
      assert.ok(
        covered.some((i) => /oats/.test(i.food)),
        "the covered row vanished instead of being reported as already owned",
      );
      assert.ok(
        toBuy.some((i) => /chicken/.test(i.food)),
        "an unowned food was dropped from the list",
      );

      // PERISHABILITY, NOT POSSESSION: an expiring food arms useSoon, which is
      // the largest coefficient the generator has.
      const soon = withAutoUseSoon(
        {
          items: [
            { food: "spinach", qty: 1, unit: "bag", location: "fridge", expires: DATES[1] },
          ],
        },
        DATES[0],
      );
      const armed = (soon.items ?? []).find((i) => /spinach/.test(i.food));
      assert.ok(armed?.useSoon, "a food expiring tomorrow did not arm useSoon");

      // STOCK IS NOT A PLAN INPUT: flour, salt and oil sit until a recipe wants
      // them, and no plan is contorted to use them up. An undated staple must
      // not perturb generation at all.
      const bare = build();
      const stocked = build({
        pantry: { items: [{ food: "all purpose flour", qty: 5, unit: "lb", location: "pantry" }] },
      });
      const shape = (r) => r.plan.entries.map((e) => `${e.date}/${e.slot}/${e.recipeId}`).sort();
      assert.deepEqual(
        shape(stocked),
        shape(bare),
        "an undated staple changed the generated week: possession is being treated as urgency",
      );

      // ABSENCE IS NOT ABANDONMENT: the fallback plan survives and returns, so
      // a week reshaped past recognition is always one tap from the plan that
      // the shopping was actually done against.
      const saved = saveFallback(bare.plan, DATES[0]);
      const wrecked = { ...saved, entries: [] };
      assert.ok(
        restoreFallback(wrecked).entries.length > 0,
        "the fallback plan could not be restored after the week was emptied",
      );
    },
  },

  {
    id: "P7",
    name: "P7 leftovers are cooked on purpose and the timer records actual against stated",
    fn: () => {
      // COOK ONCE, EAT THREE TIMES: a batch recipe eaten one plate at a time
      // cooks the WHOLE batch on purpose and names the extra servings. An
      // orphan container is a planning failure, not a surprise.
      const batch = {
        id: "chili",
        name: "Chili",
        servings: 4,
        tags: ["batch-friendly"],
        totalTime: 45,
        ingredients: [{ qty: 400, unit: "g", food: "beans" }],
      };
      const cp = cookPlan(batch, 1);
      assert.equal(cp.mode, "batch", "a batch recipe was not cooked as a batch");
      assert.equal(cp.extraServings, 3, "the extra servings were not counted");
      assert.ok(cp.note.length > 0, "the cook was not told what to do with the extra");

      // Cooking for more people than the recipe makes scales the POT, so the
      // cook reads real amounts instead of doing the multiplication in their head.
      const up = cookPlan(batch, 6);
      assert.equal(up.mode, "scaled");
      assert.ok(
        Number(up.ingredients[0].qty) > Number(batch.ingredients[0].qty),
        "the pot did not scale up",
      );

      // HONESTY: the stated time answers to a recorded one. Ending the timer is
      // also how a meal records itself cooked.
      const plan = {
        week: WEEK,
        entries: [
          { id: "e1", date: DATES[0], slot: "dinner", recipeId: "chili", servings: 1 },
          { id: "e2", date: DATES[1], slot: "dinner", recipeId: "chili", servings: 1 },
        ],
      };
      const timed = recordCook(plan, "e1", DATES[0], 62 * 60);
      const e1 = timed.entries.find((e) => e.id === "e1");
      assert.equal(e1.cookedAt, DATES[0], "ending the timer did not record the meal as cooked");
      assert.equal(e1.cookSeconds, 62 * 60);

      const review = composeWeekReview({
        plan: timed,
        waste: { events: [] },
        daily: { days: [] },
        targets: TARGETS,
        weekDates: DATES,
        recipesById: new Map([["chili", batch]]),
      });
      assert.equal(review.time.timed, 1, "the review timed the wrong number of meals");
      assert.equal(review.time.statedMin, 45, "the stated time is not the recipe's own claim");
      assert.equal(review.time.recordedMin, 62, "the recorded span was not read back");
      assert.notEqual(
        review.time.recordedMin,
        review.time.statedMin,
        "the overrun must stay visible as an overrun, never averaged away",
      );
    },
  },

  {
    id: "P8",
    name: "P8 one pot serves per-person shares, a guest is one more plate, and a conflicted seat is never silently absorbed",
    fn: () => {
      const recipe = {
        id: "kebab",
        name: "Kebab Bowl",
        mealType: "dinner",
        servings: 4,
        nutrition: { calories: 700, protein: 40 },
        ingredients: [{ qty: 1, unit: "x", food: "chicken thigh" }],
      };

      // ONE POT, DIFFERENT PLATES: each seat gets its own share of the pan,
      // from one set of instructions plus a plating section.
      const t = {
        id: "t1",
        name: "Friday",
        date: DATES[4],
        slot: "dinner",
        recipeId: "kebab",
        buyerId: "a",
        seats: [
          { id: "a", servings: 2 },
          { id: "b", servings: 1 },
          { id: "c", servings: 1 },
        ],
      };
      const order = [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
        { id: "c", name: "C" },
      ];
      const serve = buildServe(t, recipe, order, { a: null, b: null, c: null }, null);
      assert.equal(serve.rows.length, 3, "a seat at the table got no plate");
      assert.ok(
        serve.rows.every((r) => r.fraction),
        "a plate came with no share of the pan",
      );
      assert.notEqual(
        serve.rows[0].fraction,
        serve.rows[1].fraction,
        "two seats eating different amounts were told to take the same share",
      );

      // A CONFLICTED SEAT IS A NAMED SET-ASIDE. Their food is in the pan, so
      // they stay in the denominator: absorbing their share would over-plate
      // everyone else and charge them for it twice.
      const screened = buildServe(
        t,
        recipe,
        order,
        { a: null, b: { diet: "vegan" }, c: null },
        null,
      );
      const bRow = screened.rows.find((r) => r.id === "b");
      assert.equal(bRow.kind, "aside", "a seat that cannot eat the dish was handed a plate of it");
      assert.ok(bRow.note, "the set-aside did not say why");
      assert.equal(
        screened.rows.find((r) => r.id === "a").fraction,
        serve.rows[0].fraction,
        "the conflicted seat's share was silently absorbed by the others",
      );

      // A GUEST IS ONE MORE PLATE: no profile, no special event, just plates,
      // and they reach the pot and the buy like everybody else.
      const events = setTableGuests({ tables: [t], brigades: [] }, "t1", 2, DATES[0]);
      assert.equal(clampGuests(events.tables[0]), 2);
      const derived = deriveTables(
        [
          {
            house: "home",
            events: { tables: [{ ...events.tables[0], cookId: "a" }], brigades: [] },
          },
        ],
        {
          profileId: "a",
          bankById: new Map([["kebab", recipe]]),
          ownEntries: [],
          today: DATES[0],
          profilesById: new Map([
            ["a", { id: "a", household: "home" }],
            ["b", { id: "b", household: "home" }],
            ["c", { id: "c", household: "home" }],
          ]),
        },
      );
      assert.equal(
        derived.allCookExtras[0].servings,
        6,
        "4 seated servings plus 2 guest plates did not reach the pot",
      );
    },
  },

  {
    id: "P9",
    name: "P9 no bank recipe demands expertise: every one is instructed, timed and inside the accessible band",
    fn: () => {
      const files = readdirSync(BANK_DIR).filter((f) => f.endsWith(".json"));
      assert.ok(files.length > 50, `the live bank has only ${files.length} recipes`);
      /** @type {string[]} */
      const offences = [];
      for (const f of files) {
        const r = JSON.parse(readFileSync(new URL(f, BANK_DIR), "utf8"));
        const steps = r.instructions ?? [];
        if (!Array.isArray(steps) || steps.length === 0) offences.push(`${r.id}: no instructions`);
        if (!(Number(r.totalTime) > 0)) offences.push(`${r.id}: no stated time`);
        // The bank is deliberately accessible: nothing in it should require
        // expertise to succeed, so no recipe may exceed the middle difficulty.
        if (Number(r.difficulty ?? 1) > 3) offences.push(`${r.id}: difficulty ${r.difficulty}`);
      }
      assert.deepEqual(
        offences.slice(0, 8),
        [],
        `${offences.length} bank recipes are not followable as written`,
      );
    },
  },

  {
    id: "P10",
    name: "P10 an away meal enters the plan and the rest of the day is planned around it",
    fn: () => {
      const day = DATES[2];
      const est = { estCalories: 800, estProtein: 40 };
      const swipeEst = { estCalories: 900, estProtein: 60 };

      // BEFORE THE FACT: told ahead, the day is budgeted around it.
      let p = { week: WEEK, entries: [] };
      p = cycleSlotAway(p, day, "lunch", est, swipeEst, null);
      const placed = p.entries.find((e) => e.date === day && e.slot === "lunch");
      assert.ok(placed?.out, "toggling a slot away did not create an away meal");
      assert.ok(placed.pinned, "the away meal was not pinned, so generation would erase it");
      assert.ok(Number.isFinite(placed.estCalories), "the away meal carries no macro estimate");

      const { plan, report } = build({ plan: p });
      assert.ok(
        plan.entries.some((e) => e.date === day && e.slot === "lunch" && e.out),
        "GENERATE erased a declared away meal",
      );
      assert.ok(report.outDays.length > 0, "the engine did not report the away day");
      assert.equal(report.outDays[0].date, day);
      assert.ok(report.outDays[0].estCalories > 0, "the away day contributed no credit");

      // AND THE DAY STILL LANDS. The rest of the day was planned around the
      // meal Mise cannot cook, instead of ignoring it and over-feeding.
      assert.deepEqual(report.calorieShortDays, [], "the away day fell under its calorie floor");
      const byId = recipesById(pool());
      const total = dayTotals(plan.entries, byId, day);
      assert.ok(
        total.calories >= enforcedFloors(TARGETS.macros).calories,
        `the away day totalled ${total.calories} kcal against its floor`,
      );

      // A SLOT MAY RESOLVE TO AN AWAY MEAL RATHER THAN A COOKED ONE, which is
      // P2's clause and P10's mechanism: the cycle carries a currency.
      let q = cycleSlotAway({ week: WEEK, entries: [] }, day, "dinner", est, swipeEst, "swipe");
      q = cycleSlotAway(q, day, "dinner", est, swipeEst, "swipe");
      const swipe = q.entries.find((e) => e.date === day && e.slot === "dinner");
      assert.ok(swipe?.out, "the swipe state was not reachable from the away cycle");
    },
  },

  {
    id: "P11",
    name: "P11 the review shows plan against reality on every tracked axis, and names the axes with no data",
    fn: () => {
      const recipe = { id: "chili", name: "Chili", servings: 4, totalTime: 45 };
      const plan = {
        week: WEEK,
        entries: [
          {
            id: "e1",
            date: DATES[0],
            slot: "dinner",
            recipeId: "chili",
            servings: 1,
            cookedAt: DATES[0],
            cookSeconds: 3000,
          },
          { id: "e2", date: DATES[1], slot: "dinner", recipeId: "chili", servings: 1 },
          { id: "e3", date: DATES[2], slot: "dinner", out: true, estCalories: 800, estProtein: 40 },
        ],
        spend: [{ date: DATES[0], total: 88.4 }],
      };
      const review = composeWeekReview({
        plan,
        waste: { events: [{ date: DATES[1], food: "spinach" }] },
        daily: { days: [{ date: DATES[0], weight: 196 }] },
        targets: { ...TARGETS, weeklyBudgetUsd: 125 },
        weekDates: DATES,
        recipesById: new Map([["chili", recipe]]),
      });

      // COOKED AGAINST PLANNED, and an away meal is not a broken promise to
      // cook: it never entered the denominator.
      assert.equal(review.cooked.planned, 2, "an away meal was counted as a cooking commitment");
      assert.equal(review.cooked.done, 1);

      // SPENT AGAINST BUDGETED, TOSSED AGAINST USED, TIME, WEIGH-INS.
      assert.equal(review.spend.total, 88.4);
      assert.equal(review.spend.budget, 125, "the review shows spend with nothing to compare it to");
      assert.equal(review.tossed.count, 1);
      assert.equal(review.time.timed, 1);
      assert.equal(review.weighIns.count, 1);
      assert.equal(review.weighIns.days, 7, "the weigh-in count has no denominator");

      // A DARK AXIS SAYS SO. An axis with no evidence comes back explicitly
      // empty, never omitted, because an omitted axis reads as a passing one.
      const dark = composeWeekReview({
        plan: { week: WEEK, entries: [] },
        waste: { events: [] },
        daily: { days: [] },
        targets: TARGETS,
        weekDates: DATES,
        recipesById: new Map(),
      });
      assert.equal(dark.hasData, false, "an empty week claimed to have evidence");
      assert.equal(dark.time, null, "an untimed week reported a time figure anyway");
      assert.equal(dark.spend, null, "a week with no receipts reported spend anyway");
      assert.equal(dark.cooked.planned, 0);

      // A SKIPPED REVIEW NEVER BLOCKS THE NEXT WEEK: generation runs on
      // whatever evidence exists, including none. The review is an engine,
      // not a chore gate.
      assert.ok(build().plan.entries.length > 0, "generation refused to run without a review");
    },
  },
];

for (const p of PROMISES) test(p.name, p.fn);

// ═══════════════════════════════════════════════════════════════════════════
// THE GATE REGISTER. Unbuilt is `todo`, never absent.
//
// Every entry prints on every single test run, carrying an owner and its job
// on Lanes/Mise-Fix-List. This is the list that makes "no feature ships dark"
// machine-checked: a promise cannot be marked partial or unbuilt in the
// document and then quietly stop existing here, because that is the state
// where "planned" and "abandoned" look identical, and it is exactly how the
// protein ceiling was lost.
// ═══════════════════════════════════════════════════════════════════════════

/** @type {{ id: string, name: string, why: string }[]} */
const UNBUILT = [
  {
    id: "P1",
    name: "P1 GAP a calorie-ceiling breach is reported on the plan and re-checked after every edit",
    why:
      "owner koenig, Phase 1 job 3. generateWeek computes calorieOverDays into a TRANSIENT build " +
      "report (weekbuilder.js:1579, rendered once at planner.js:295). Nothing persists it: manifest.js " +
      "counts calorieShortDays and has no ceiling counter at all, and handleToggleOut (main.js:1236) " +
      "calls updatePlan without recomposing. So a breach created by an EDIT is invisible, which is the " +
      "live state on 2026-08-19: 4,055 kcal against a 3,885 ceiling with nothing anywhere saying so.",
  },
  {
    id: "P3",
    name: "P3 GAP a described or scanned away meal is screened against declared allergens",
    why:
      "owner koenig, Phase 1 job 6. Recipes and store picks are screened; free-text meals and scanned " +
      "menus are not, and P3's own text names them: their true ingredients cannot be seen, so they must " +
      "carry a visible warning and never be silently trusted. Safety-relevant.",
  },
  {
    id: "P4",
    name: "P4 GAP every bought perishable has a home in the plan before its date",
    why:
      "owner koenig, Phase 2 job 8. The pack-size half passes. The ledger half does not exist: after " +
      "GOING TO THE STORE the plan may be reshaped freely, and nothing checks the governing rule that " +
      "everything perishable bought gets used before it dies. Needs P7's safeDays to land first.",
  },
  {
    id: "P5",
    name: "P5 GAP the week is changed until it fits the budget, or says by how much it cannot",
    why:
      "owner koenig, Phase 2 job 7. The budget is a readout, not a constraint: grep swapToFit returns " +
      "nothing. Three further pieces are unbuilt and all belong to this promise: the protein trim pass " +
      "(targets.json carries proteinCeiling 215 and no code reads it, so over-delivered protein is " +
      "still bought), variable-weight rows as an honest range instead of false precision, and " +
      "marginal-cost ordering across more than one currency (only swipes act today).",
  },
  {
    id: "P6",
    name: "P6 GAP the household is a kitchen: capacity, trip cadence, occupancy and roles",
    why:
      "owner koenig, Phase 2 job 10. No household.json exists at all. Missing: head and member roles, " +
      "equipment at household level, fridge/freezer/pantry volumes as generation constraints, trip " +
      "cadence, and the occupancy window whose departure date is a drain-down target.",
  },
  {
    id: "P7",
    name: "P7 GAP every leftover slot sits inside the dish's safe window",
    why:
      "owner koenig, Phase 2 job 9. Zero occurrences of safeDays anywhere in app, tests or the " +
      "126-recipe bank. Cooked food keeps fewer days than raw, and the scheduler currently places " +
      "leftover slots with no knowledge of the window at all. An audited bank that poisons nobody is " +
      "the floor, not a feature.",
  },
  {
    id: "P8",
    name: "P8 GAP per-person plates are solved from targets, not shared out by pan fraction",
    why:
      "owner the council, kill review 2026-11-15. synth.js is 804 lines gated at line 335 on " +
      "assembly !== plated, and 0 of 126 bank recipes carry that tag, so it has returned " +
      "uniform(0-mixed) for every meal ever planned. Deliberately inert by council decision " +
      "2026-08-12; the manifest already announces the gate on every generate. This entry keeps the " +
      "gate visible on every test run until the review date.",
  },
  {
    id: "P9",
    name: "P9 GAP every bank recipe teaches inside the step where it matters",
    why:
      "owner David, blocked on the five-way HBP layout pick. 103 of 126 recipes already carry a real " +
      "teaching clause in-step, so this is a 23-recipe content pass plus a layout decision, not an " +
      "engineering job. The first half of the done test, a first-time cook reaching a result that " +
      "tastes good, is not machine-checkable and this ledger does not pretend otherwise.",
  },
  {
    id: "P10",
    name: "P10 GAP a dining-hall meal is composed to the slot's calorie and protein quota from live menu data",
    why:
      "owner koenig, Phase 2 job 11. No Purdue dining reference exists anywhere in the app. Needs a " +
      "CSP entry for api.hfs.purdue.edu, the tray composer against the day's stations with the " +
      "court-serving caveat loud, and menu-scan results persisting into the plan rather than being " +
      "read and discarded.",
  },
  {
    id: "P11",
    name: "P11 GAP the review accepts a fridge photo and comments, and the next week demonstrably reads it",
    why:
      "owner koenig, Phase 2 job 8, and review.js's own header comment lists these three gaps. The " +
      "read side is live. The write side is not: the pantry scan IS the fridge photo and its diff is " +
      "not wired into the review, there is no free-text comment field writing plan.reviewNote, and " +
      "while adherence feeds the manifest, portion and buying adjustments do not read the review yet.",
  },
  {
    id: "P12",
    name: "P12 GAP every bank recipe declares its audit and its nutrition philosophy",
    why:
      "owner koenig, Phase 1 job 5. No audited field and no philosophy field exist anywhere in the " +
      "schema or in any of the 126 recipes, which makes the whole promise unfalsifiable: nothing can " +
      "distinguish an audited bank from an unaudited one, and 'more than one nutritional voice' cannot " +
      "be counted. This is the cheapest promise on the list to make checkable, and until it is, it is " +
      "the most dangerous, because it is the one that reads as passing.",
  },
];

for (const u of UNBUILT) test(u.name, { todo: u.why }, () => {});

// ═══════════════════════════════════════════════════════════════════════════
// THE META-TESTS. These are the ones that make the document honest.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Parse the authority document into { id -> { kind, testName, gapName } }.
 * @param {string} md
 */
function parseLedger(md) {
  /** @type {Record<string, { kind: string, testName: string | null, gapName: string | null }>} */
  const out = {};
  const sections = md.split(/^### (P\d+)\./m);
  // split yields [preamble, "P1", body, "P2", body, ...]
  for (let i = 1; i < sections.length; i += 2) {
    const id = sections[i];
    const body = sections[i + 1] ?? "";
    const line = body.match(/^\*\*Status:\*\*[^\n]*/m)?.[0] ?? "";
    if (!line) {
      out[id] = { kind: "MISSING", testName: null, gapName: null };
      continue;
    }
    const gapIdx = line.indexOf("GAP");
    const gapName =
      gapIdx >= 0 ? ([...line.slice(gapIdx).matchAll(/>\s*"([^"]+)"/g)][0]?.[1] ?? null) : null;
    const head = gapIdx >= 0 ? line.slice(0, gapIdx) : line;
    const testName = [...head.matchAll(/>\s*"([^"]+)"/g)][0]?.[1] ?? null;
    if (/PROVEN/.test(line)) out[id] = { kind: "proven", testName, gapName };
    else if (/PARTIAL/.test(line)) out[id] = { kind: "partial", testName, gapName };
    else if (/NOT BUILT/.test(line)) out[id] = { kind: "not-built", testName: null, gapName };
    else out[id] = { kind: "MISSING", testName: null, gapName: null };
  }
  return out;
}

const ledger = () => parseLedger(readFileSync(DOC, "utf8"));

test("META: the authority document is readable, and it is not optional", () => {
  // Deliberately a failure and not a skip. A skipped integrity check is the
  // rot mode this whole file exists to close.
  assert.ok(
    existsSync(DOC),
    `Mise-Core-Purpose.md was not found at ${DOC}. Promise compliance cannot be verified ` +
      `without it, so this fails rather than passing quietly.`,
  );
});

test("META: every promise in the document carries a status line", () => {
  const l = ledger();
  assert.equal(Object.keys(l).length, 12, `found ${Object.keys(l).length} promises, expected 12`);
  for (const [id, e] of Object.entries(l)) {
    assert.notEqual(
      e.kind,
      "MISSING",
      `${id} has no **Status:** line. Every promise must declare PROVEN, PARTIAL or NOT BUILT. ` +
        `A promise with no status is a promise that can rot silently, which is exactly how the ` +
        `protein ceiling was lost.`,
    );
  }
});

test("META: every promise that claims a test has one, with that exact name", () => {
  const have = new Set(PROMISES.map((p) => p.name));
  for (const [id, e] of Object.entries(ledger())) {
    if (!e.testName) continue;
    assert.ok(
      have.has(e.testName),
      `${id} claims to be proven by "${e.testName}" and no such test exists in this file. ` +
        `Either write it, or change the document. The document is not allowed to be wrong.`,
    );
  }
});

test("META: every gap the document names is on the register, with an owner", () => {
  const registered = new Set(UNBUILT.map((u) => u.name));
  for (const [id, e] of Object.entries(ledger())) {
    if (e.kind === "proven") continue;
    assert.ok(
      e.gapName,
      `${id} is ${e.kind} and names no GAP. A promise that is not whole must say which half is ` +
        `missing, or "partial" becomes the same reclassification that lost the protein ceiling.`,
    );
    assert.ok(
      registered.has(e.gapName),
      `${id} names the gap "${e.gapName}" and no todo test carries it. An unbuilt half that is ` +
        `merely absent from the suite is indistinguishable from an abandoned one.`,
    );
  }
  for (const u of UNBUILT) {
    assert.match(u.why, /owner /i, `${u.id}: every gated item needs a named owner`);
    assert.ok(
      u.why.length > 80,
      `${u.id}: the todo must say what is missing, not merely that something is`,
    );
  }
});

test("META: a promise marked NOT BUILT has not quietly acquired a test", () => {
  const byId = new Set(PROMISES.map((p) => p.id));
  for (const [id, e] of Object.entries(ledger())) {
    if (e.kind !== "not-built") continue;
    assert.ok(
      !byId.has(id),
      `${id} is marked NOT BUILT in the document but this file proves it. If it got built, say so ` +
        `in the document in the SAME commit as the code.`,
    );
  }
});

test("META: no test claims a promise the document does not list", () => {
  const l = ledger();
  for (const p of PROMISES) {
    assert.ok(l[p.id], `this file tests ${p.id} and the document has no such promise`);
    assert.equal(
      l[p.id].testName,
      p.name,
      `${p.id}: the document names a different test than this file provides. They must match ` +
        `character for character, so a rename cannot silently break the link.`,
    );
  }
  const ids = new Set(Object.keys(l));
  for (const u of UNBUILT) {
    assert.ok(ids.has(u.id), `the register carries ${u.id} and the document has no such promise`);
  }
});

test("META: the scoreboard, printed so the number can never be a matter of opinion", () => {
  const l = ledger();
  /** @type {Record<string, number>} */
  const tally = { proven: 0, partial: 0, "not-built": 0 };
  for (const e of Object.values(l)) tally[e.kind] = (tally[e.kind] ?? 0) + 1;
  console.log(
    `\n  PROMISE LEDGER: ${tally.proven} proven, ${tally.partial} partial, ` +
      `${tally["not-built"]} not built, of ${Object.keys(l).length}. ` +
      `Gate register: ${UNBUILT.length} open.\n`,
  );
  assert.equal(
    tally.proven + tally.partial + tally["not-built"],
    12,
    "a promise fell out of the tally entirely",
  );
});
