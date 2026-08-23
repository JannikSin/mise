import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";

import { generateWeek } from "../app/lib/weekbuilder.js";
import { composeManifest, manifestLines, remanifest } from "../app/lib/manifest.js";
import {
  buffetMacroEstimate,
  cycleSlotAway,
  datesOfWeek,
  dayBought,
  dayTotals,
  mergeRecipePool,
  recipeConflicts,
  recipesById,
  recordCook,
  saveFallback,
  restoreFallback,
  SWIPE_TEXT,
} from "../app/lib/plan.js";
import {
  avoidTermsFromAllergens,
  enforcedCeilings,
  enforcedFloors,
  targetsSanity,
} from "../app/lib/targets.js";
import { itemCost, parsePackSize, matchPrice, tripTotal } from "../app/lib/prices.js";
import { aisleOf, mergeIdentity } from "../app/lib/ingredients.js";
import {
  deriveShoppingList,
  isPreparedFood,
  subtractPantryFromTrip,
  withAutoUseSoon,
} from "../app/lib/shopping.js";
import { cookPlan, leftoverLedger } from "../app/lib/portions.js";
import { perishableCoverage } from "../app/lib/coverage.js";
import {
  capacityCheck,
  coldLoad,
  drainDownDate,
  membersWithRole,
  normalizeHousehold,
  setMemberRoles,
} from "../app/lib/household.js";
import { priceWeek, swapToFit } from "../app/lib/budget.js";
import { rankAgreement, scoreRecipe, scoreWeek, validateBundle } from "../app/lib/philosophy.js";
import { buildServe } from "../app/lib/serve.js";
import {
  clampGuests,
  deriveTables,
  setTableGuests,
  guestSeats,
  GUEST_TARGETS,
  slotShareFor,
} from "../app/lib/tables.js";
import { partOf, synthesize } from "../app/lib/synth.js";
import { composeWeekReview } from "../app/lib/review.js";
import { setReviewNote, untrustedForAutoPlan } from "../app/lib/plan.js";
import { screenMenuReport, unconfirmedReason } from "../app/lib/annotate.js";
import { composeTray, itemsForMeal, parseItem } from "../app/lib/dininghall.js";

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
const PHILOSOPHIES = new URL("../../mise-data/philosophies/", import.meta.url);

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
    name: "P1 every day lands inside its floors and under its ceiling, re-derived from the plan as it stands",
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

      // THE CEILING HALF. This is the one that was failing on live data: the
      // generator computed calorieOverDays into a transient build report, so a
      // breach created by an EDIT was invisible. On 2026-08-19 the real week
      // sat at 4,055 kcal against a 3,885 ceiling and no screen said so.
      const ceilings = enforcedCeilings(TARGETS.macros);
      const gorged = {
        ...plan,
        entries: [
          ...plan.entries,
          { id: "extra", date: DATES[0], slot: "snack", recipeId: "snack-1", servings: 6 },
        ],
      };
      const over = remanifest(after, {
        plan: gorged,
        targets: TARGETS,
        recipes: pool(),
        dailyDays: [],
        todayIso: DATES[0],
      });
      assert.equal(
        over.subsystems.floors.calorieCeiling,
        Math.round(ceilings.calories),
        "the reported ceiling is not the one the trim pass enforces",
      );
      assert.ok(
        over.subsystems.floors.calorieOverDays > 0,
        "a day pushed over the calorie ceiling by an edit reported no overage",
      );
      assert.match(
        manifestLines(over, gorged, DATES[0])
          .map((l) => l.text)
          .join("\n"),
        /OVER the \d+ kcal ceiling on \d+ day/,
        "the breach was counted internally and never rendered",
      );

      // AND AN ABSENT CEILING SAYS SO. This profile writes no protein ceiling,
      // and P5 calls unconstrained over-delivery a budget leak, so the absence
      // has to be visible rather than merely absent.
      assert.equal(over.subsystems.floors.proteinCeiling, null);
      assert.equal(over.subsystems.floors.proteinOverDays, null);
      assert.match(
        manifestLines(over, gorged, DATES[0])
          .map((l) => l.text)
          .join("\n"),
        /no protein ceiling set/,
      );
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
    name: "P3 allergens are enforced on everything Mise recommends, including what it cannot see inside",
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

      // MEALS MISE CANNOT SEE INSIDE. P3 names this case in its own text: a
      // scanned menu's true ingredients are invisible, so it is screened and
      // never silently trusted. The Worker caps each diner's avoid list at 20
      // terms, so the screen has to run again on the CLIENT, untruncated.
      const facts = [{ id: "d1", name: "Dee", avoid: ["peanuts"] }];
      const menu = screenMenuReport(
        {
          diners: [
            {
              name: "Dee",
              picks: [
                { item: "Pad Thai", why: "peanut sauce, high protein", estCalories: 800 },
                { item: "Grilled chicken", why: "lean", estCalories: 500 },
              ],
              skip: [],
            },
          ],
        },
        facts,
      );
      assert.equal(menu[0].flagged.length, 1, "an allergenic dish stayed in the order");
      assert.equal(menu[0].flagged[0].pick.item, "Pad Thai");
      assert.ok(menu[0].flagged[0].hits.length > 0, "the flag did not say what it found");
      assert.deepEqual(
        menu[0].picks.map((p) => p.item),
        ["Grilled chicken"],
        "a safe dish was lost, or an unsafe one presented as an order",
      );

      // A CLEAN SCREEN IS NOT A CLEARANCE. Anyone with a declared avoid list
      // gets the caution even when nothing was flagged, because Mise read the
      // menu's words, not the kitchen.
      assert.match(String(menu[0].caution), /not the kitchen/);
      const nothingDeclared = screenMenuReport(
        { diners: [{ name: "Sam", picks: [{ item: "Pad Thai" }], skip: [] }] },
        [{ id: "s", name: "Sam", avoid: [] }],
      );
      assert.equal(
        nothingDeclared[0].caution,
        null,
        "a warning that always fires is noise: nothing declared means nothing to caution about",
      );
      assert.equal(nothingDeclared[0].flagged.length, 0);

      // AND IT FAILS CLOSED. A diner whose targets could not be read is
      // UNCONFIRMED, and an unread profile must never screen as allergy-free.
      assert.match(
        unconfirmedReason([{ name: "Dee", unconfirmed: true }]),
        /could not be read/,
        "an unreadable profile did not stop the scan",
      );
      assert.equal(unconfirmedReason([{ name: "Dee" }]), "");

      // AND NO ENGINE ASSUMES A DEFAULT PERSON. Until 2026-08-19 the generator
      // read `?? 210` / `?? 3400`, David's own targets, so an unreadable
      // profile did not fail: it silently produced HIS week for somebody else.
      for (const t of [null, {}, { macros: {} }, { macros: { protein: 175 } }]) {
        assert.throws(
          () =>
            // deliberately NOT through build(): its `?? TARGETS` default is
            // itself a fallback person, and this is the one test that must
            // reach the engine with nothing
            generateWeek({
              recipes: pool(),
              targets: t,
              pantry: { items: [] },
              weekId: WEEK,
              plan: { week: WEEK, entries: [] },
              salt: 1,
            }),
          /no calorie and protein target/,
          `GENERATE invented a default person for targets ${JSON.stringify(t)}`,
        );
      }
    },
  },

  {
    id: "P4",
    name: "P4 every row is a real pack at a real store, and every bought perishable has a meal before its date",
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

      // THE LEDGER HALF. Shopping locks the INGREDIENTS, never the plan, and
      // the one governing rule is that everything perishable you bought gets
      // used before it dies. So the plan may be reshaped freely after the
      // shop, as long as every bought perishable still has a meal to go to.
      const soup = {
        id: "soup",
        name: "Spinach Soup",
        mealType: "dinner",
        servings: 2,
        nutrition: { calories: 400, protein: 20 },
        ingredients: [{ qty: 200, unit: "g", food: "spinach" }],
      };
      const other = { ...soup, id: "other", name: "Rice Bowl", ingredients: [{ qty: 100, unit: "g", food: "rice" }] };
      const pantry = {
        items: [
          { id: "p1", food: "spinach", qty: "200 g", location: "fridge", expires: DATES[2] },
        ],
      };
      const covered = perishableCoverage(
        { week: WEEK, entries: [{ id: "e", date: DATES[1], slot: "dinner", recipeId: "soup", servings: 1 }] },
        [soup, other],
        pantry,
        DATES[0],
      );
      assert.equal(covered.checked, 1, "the bought perishable was not even examined");
      assert.deepEqual(covered.gaps, [], "a perishable with a meal before its date was called homeless");

      // RESHAPE THE WEEK and the watch fires: the meal that ate the spinach
      // is gone, so the spinach now dies in the fridge and the app says so
      // BEFORE it happens rather than writing it off afterwards.
      const reshaped = perishableCoverage(
        { week: WEEK, entries: [{ id: "e", date: DATES[1], slot: "dinner", recipeId: "other", servings: 1 }] },
        [soup, other],
        pantry,
        DATES[0],
      );
      assert.equal(reshaped.gaps.length, 1, "a bought perishable lost its home and nothing noticed");
      assert.equal(reshaped.gaps[0].food, "spinach");
      assert.equal(reshaped.gaps[0].goodUntil, DATES[2]);

      // A MEAL AFTER THE DATE IS NOT A HOME. Cooking it on Friday does not
      // save food that dies on Wednesday.
      const tooLate = perishableCoverage(
        { week: WEEK, entries: [{ id: "e", date: DATES[5], slot: "dinner", recipeId: "soup", servings: 1 }] },
        [soup, other],
        pantry,
        DATES[0],
      );
      assert.equal(tooLate.gaps.length, 1, "a meal scheduled after the expiry counted as a home");

      // AND STOCK IS NOT A COUNTDOWN. A freezer row is backup protein, not a
      // clock, so it is never nagged about.
      const frozen = perishableCoverage(
        { week: WEEK, entries: [] },
        [soup],
        { items: [{ id: "f", food: "spinach", qty: "200 g", location: "freezer", expires: DATES[2] }] },
        DATES[0],
      );
      assert.deepEqual(frozen.gaps, [], "a freezer row was treated as expiring food");
    },
  },

  {
    id: "P5",
    name: "P5 the week is changed until it fits the budget, priced honestly, and prepaid value is spent first",
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

      // A JUDGMENT CALL, recorded rather than made quietly, because a quiet
      // narrowing is exactly how the protein ceiling was lost. P5 says value
      // already paid for is spent first, "the seven weekly swipes before a
      // dollar, the gift card expiring Friday before the debit card", and only
      // SWIPES are consumed by anything today. The done test's own qualifier
      // decides it: "whenever the plan CAN LEGALLY USE IT." A swipe is the only
      // currency a meal plan can spend, because it buys a specific meal at a
      // specific hall. A gift card is spent at the till by a person, and a plan
      // that pretended to spend it would be inventing a transaction. Ordering
      // ACROSS currencies becomes a real promise the day a second one can be
      // spent by the plan; it is on Mise-Later, not hidden in a passing test.
      //
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

      // THE PROTEIN CEILING. P5 calls over-delivered protein a budget leak,
      // because protein is the expensive macro and grams above the number are
      // bought for nothing. David ratified 215 g on 2026-08-19; until this
      // pass landed, targets.json carried the ceiling and no code read it, so
      // the data was ahead of the engine and nothing could tell.
      const headroom = { ...TARGETS.macros, caloriesFloor: 3000 };
      const unlimited = build({ targets: { ...TARGETS, macros: headroom } });
      const capped = build({
        targets: { ...TARGETS, macros: { ...headroom, proteinCeiling: 190 } },
      });
      const avgProtein = (r) =>
        DATES.reduce((s, d) => s + dayTotals(r.plan.entries, byId, d).protein, 0) / DATES.length;
      assert.ok(
        avgProtein(capped) < avgProtein(unlimited),
        `a written protein ceiling changed nothing: ${avgProtein(capped)} g vs ` +
          `${avgProtein(unlimited)} g unconstrained`,
      );
      // and it bought that saving without breaking anything the person agreed to
      assert.deepEqual(capped.report.proteinShortDays, [], "the trim broke the protein floor");
      assert.deepEqual(capped.report.calorieShortDays, [], "the trim broke the calorie floor");

      // AN ABSENT CEILING IS NEVER INVENTED. A number nobody chose would
      // silently start taking food off every profile in the app.
      assert.deepEqual(
        unlimited.report.proteinOverDays,
        [],
        "a profile with no written ceiling was measured against one anyway",
      );
      // A day the trim cannot fit without breaking a floor is REPORTED over,
      // never fudged. That is the honesty rule doing the work the trim cannot.
      const impossible = build({
        targets: { ...TARGETS, macros: { ...TARGETS.macros, proteinCeiling: 60 } },
      });
      assert.ok(
        impossible.report.proteinOverDays.length > 0,
        "an unreachable ceiling reported as met, which is the quiet miss P1 forbids",
      );
      assert.deepEqual(
        impossible.report.proteinShortDays,
        [],
        "chasing an unreachable ceiling broke the floor underneath it",
      );

      // THE BUDGET AS A CONSTRAINT, not a readout. Canon: "Generate the week,
      // price every row, and if the total is over the number, Mise CHANGES the
      // week... until it fits or the app says plainly that it cannot and by how
      // much." Until 2026-08-19 `grep swapToFit` returned nothing at all.
      const dear = { id: "dinner-dear", name: "Dear", mealType: "dinner", servings: 1, totalTime: 20,
        difficulty: 1, instructions: ["cook"], foodGroups: {},
        nutrition: { calories: 700, protein: 45, carbs: 50, fat: 20 },
        ingredients: [{ qty: 1, unit: "lb", food: "gold leaf" }] };
      const cheap = { ...dear, id: "dinner-cheap", name: "Cheap",
        ingredients: [{ qty: 1, unit: "lb", food: "rolled oats" }] };
      const priceBook = {
        region: { country: "USA", state: "IL" },
        stores: ["s"],
        items: [
          { id: "gold-leaf", name: "gold leaf", prices: { s: { price: 90, size: "1 lb" } } },
          { id: "rolled-oats", name: "rolled oats", prices: { s: { price: 3, size: "1 lb" } } },
        ],
      };
      const week = {
        week: WEEK,
        entries: [{ id: "d1", date: DATES[1], slot: "dinner", recipeId: "dinner-dear", servings: 1 }],
      };
      const shared = {
        recipes: [dear, cheap],
        recipesById: new Map([[dear.id, dear], [cheap.id, cheap]]),
        pantry: { items: [] },
        catalogue: priceBook,
        store: "s",
        region: priceBook.region,
        // 700 kcal of dinner has to sit under the day ceiling, or the fit
        // pass correctly refuses every swap and the fixture proves nothing
        targets: { macros: { calories: 900, caloriesFloor: 600, protein: 40, proteinFloor: 40 } },
      };
      const dearPrice = priceWeek(week, shared.recipesById, shared.pantry, priceBook, "s", priceBook.region);
      assert.ok(dearPrice.eaten > 50, "the fixture week did not price as expensive");

      const fit = swapToFit({ ...shared, plan: week, budgetUsd: 20 });
      assert.equal(fit.fits, true, `the week did not reach the budget: ${fit.reason}`);
      assert.equal(fit.swaps.length, 1, "the fit changed the wrong number of meals");
      assert.equal(fit.swaps[0].to, "Cheap");
      assert.ok(fit.eaten < fit.startedAt, "the swap did not actually reduce the bill");
      assert.ok(fit.eaten <= 20);

      // IT NEVER BUYS THE BUDGET WITH A BROKEN PROMISE. Raise the floor above
      // what the cheap meal delivers and the swap becomes illegal, so the week
      // stays expensive and SAYS SO with the number.
      const held = swapToFit({
        ...shared,
        plan: week,
        budgetUsd: 20,
        recipes: [dear, { ...cheap, nutrition: { calories: 300, protein: 10, carbs: 20, fat: 5 } }],
        recipesById: new Map([
          [dear.id, dear],
          [cheap.id, { ...cheap, nutrition: { calories: 300, protein: 10, carbs: 20, fat: 5 } }],
        ]),
      });
      assert.equal(held.fits, false, "a swap that starves the day was allowed to buy the budget");
      assert.equal(held.swaps.length, 0);
      assert.ok(held.over > 0, "the shortfall was not quantified");
      assert.match(held.reason, /over/, "the failure did not say how far short it fell");

      // AND NO BUDGET IS NOT OVER BUDGET. A profile that never set a number
      // is not silently given one, which is the invented-person bug in
      // another costume.
      const none = swapToFit({ ...shared, plan: week, budgetUsd: 0 });
      assert.equal(none.ran, false);
      assert.equal(none.fits, true);
      assert.equal(none.swaps.length, 0);

      // A VERIFIED TOTAL IS NOT A FALSE-PRECISE ONE. "Variable-weight items
      // make the estimate a range, and the app says so. '$48 to $53,' never a
      // false-precision point." A per-pound row is whatever the tray weighs.
      const byWeight = {
        region: { country: "USA", state: "IL" },
        stores: ["s"],
        items: [
          { id: "chicken-thigh", name: "chicken thigh", prices: { s: { price: 2.5, size: "per lb" } } },
          { id: "rolled-oats", name: "rolled oats", prices: { s: { price: 3, size: "32 oz" } } },
        ],
      };
      const mixed = tripTotal(
        [
          { food: "chicken thigh", qty: 2, unit: "lb" },
          { food: "rolled oats", qty: 32, unit: "oz" },
        ],
        byWeight,
        "s",
        byWeight.region,
      );
      assert.equal(mixed.variableRows, 1, "a per-pound row was not recognised as variable weight");
      assert.ok(mixed.low < mixed.total && mixed.total < mixed.high, "the total quoted no range");
      // and ONLY the weighed row widens it: a trolley of packaged goods still
      // quotes to the cent, which is the honest asymmetry
      const packagedOnly = tripTotal(
        [{ food: "rolled oats", qty: 32, unit: "oz" }],
        byWeight,
        "s",
        byWeight.region,
      );
      assert.equal(packagedOnly.variableRows, 0);
      assert.equal(packagedOnly.low, packagedOnly.total);
      assert.equal(packagedOnly.high, packagedOnly.total);
    },
  },

  {
    id: "P6",
    name: "P6 the kitchen knows what it owns, what it holds, and the day it empties",
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

      // THE HOUSEHOLD IS THE KITCHEN. No household.json existed before
      // 2026-08-19, so none of the four clauses below could be true of
      // anything. Every field stays optional: a kitchen that has declared
      // nothing behaves exactly as the app did before the file existed.
      const empty = normalizeHousehold(null);
      assert.equal(empty.headId, null);
      assert.equal(empty.equipment, null, "an undeclared kitchen must filter nothing");
      assert.equal(drainDownDate(empty), null, "a home with no departure date got one");
      assert.equal(
        capacityCheck(empty, coldLoad([], () => null)).checked,
        false,
        "an undeclared kitchen was measured against a capacity it never stated",
      );

      // ROLES ARE ENFORCED IN CODE, not in a screen, because a rule only a
      // screen enforces is a rule two devices can disagree about.
      const house = normalizeHousehold({
        headId: "david",
        members: [{ id: "david", roles: ["cook", "shopper"] }],
        capacityL: { fridge: 100 },
        occupancy: { until: DATES[4] },
      });
      const refused = setMemberRoles(house, "roommate", "roommate", ["cook"]);
      assert.equal(refused.changed, false, "somebody who is not the head reassigned a role");
      assert.match(refused.reason, /head of the household/);
      assert.deepEqual(refused.household, house, "a refused write must be a no-op");
      const allowed = setMemberRoles(house, "david", "roommate", ["shopper", "nonsense"]);
      assert.equal(allowed.changed, true);
      assert.deepEqual(membersWithRole(allowed.household, "shopper"), ["david", "roommate"]);
      assert.deepEqual(
        allowed.household.members.find((m) => m.id === "roommate").roles,
        ["shopper"],
        "an unknown role was stored rather than dropped",
      );
      // a household with no head yet is not locked: the first writer becomes it
      assert.equal(setMemberRoles(empty, "anyone", "anyone", ["cook"]).changed, true);

      // A GENERATED WEEK FITS THE COLD STORAGE IT WILL LIVE IN.
      const grams = (/** @type {string} */ _f, /** @type {number} */ q, /** @type {string} */ u) =>
        u === "kg" ? q * 1000 : u === "g" ? q : null;
      const load = coldLoad(
        [
          { food: "chicken", qty: "80 kg", location: "fridge" },
          { food: "peas", qty: "1 kg", location: "freezer" },
          { food: "mystery", qty: "", location: "fridge" },
        ],
        grams,
      );
      assert.equal(load.fridge, 80, "eighty kilos of cold food did not read as eighty litres");
      assert.equal(load.unknownRows, 1, "an unmeasurable row vanished instead of being counted");
      const tight = capacityCheck(house, load);
      assert.equal(tight.checked, true);
      assert.equal(tight.fits, false, "80 L of food fitted a 100 L fridge that packs at 55%");
      assert.equal(tight.over[0].where, "fridge");
      assert.ok(tight.over[0].byL > 0, "the overflow was not quantified");
      // and it REPORTS rather than refuses: the plan is still the person's
      assert.ok(build().plan.entries.length > 0, "a full fridge blocked generation");

      // A DEPARTURE DATE IS A DRAIN-DOWN TARGET. A food's real deadline is the
      // earlier of its own date and the day the kitchen empties, so food that
      // outlives the lease has no home even though its own date is fine.
      assert.equal(drainDownDate(house), DATES[4]);
      const soupR = {
        id: "soup",
        name: "Soup",
        mealType: "dinner",
        servings: 2,
        nutrition: { calories: 400, protein: 20 },
        ingredients: [{ qty: 200, unit: "g", food: "spinach" }],
      };
      const shelf = {
        items: [{ id: "p", food: "spinach", qty: "200 g", location: "fridge", expires: DATES[6] }],
      };
      const eatenAfterLeaving = [
        { id: "e", date: DATES[5], slot: "dinner", recipeId: "soup", servings: 1 },
      ];
      assert.deepEqual(
        perishableCoverage({ week: WEEK, entries: eatenAfterLeaving }, [soupR], shelf, DATES[0]).gaps,
        [],
        "with no departure date, a meal before the food's own date is a home",
      );
      const leaving = perishableCoverage(
        { week: WEEK, entries: eatenAfterLeaving },
        [soupR],
        shelf,
        DATES[0],
        DATES[4],
      );
      assert.equal(leaving.gaps.length, 1, "food that outlives the lease was called covered");
      assert.equal(leaving.gaps[0].goodUntil, DATES[4], "the deadline did not move to the departure");
      assert.equal(leaving.gaps[0].leaving, true, "the reason for the earlier deadline was not said");

      // and generation stops planning past the day the kitchen empties
      const packed = build({ salt: 3 });
      const draining = generateWeek({
        recipes: pool(),
        targets: TARGETS,
        pantry: { items: [] },
        weekId: WEEK,
        plan: { week: WEEK, entries: [] },
        salt: 3,
        drainDownIso: DATES[4],
      });
      assert.ok(
        draining.plan.entries.every((e) => e.date <= DATES[4]),
        "meals were planned for days after the kitchen empties",
      );
      assert.ok(
        packed.plan.entries.some((e) => e.date > DATES[4]),
        "the control week was already short",
      );
      assert.equal(draining.report.manifest.household.daysAfterDeparture, 2);
    },
  },

  {
    id: "P7",
    name: "P7 leftovers are cooked on purpose, eaten inside their safe window, and the timer records actual against stated",
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

      // WHICH LATER SLOT EATS IT. Until 2026-08-19 the batch note told the
      // cook "the plan has already scheduled it as leftovers" and nothing
      // anywhere linked the pot to the slot, so the promise had nothing to
      // answer to and the safe-window clause had nothing to check.
      const chili = { ...batch, safeDays: 4, servings: 4 };
      const bank = new Map([["chili", chili]]);
      const week = {
        week: WEEK,
        entries: [
          { id: "a", date: DATES[0], slot: "dinner", recipeId: "chili", servings: 2 },
          { id: "b", date: DATES[1], slot: "lunch", recipeId: "chili", servings: 1 },
          { id: "c", date: DATES[3], slot: "lunch", recipeId: "chili", servings: 1 },
        ],
      };
      const led = leftoverLedger(week, bank);
      assert.equal(led.cooks.length, 1, "one 4-serving pot should feed all three slots");
      assert.equal(led.cooks[0].date, DATES[0], "the pot is cooked at the first slot");
      assert.equal(led.cooks[0].makes, 4, "the batch is cooked whole, not scaled to one plate");
      assert.deepEqual(
        led.cooks[0].eats.map((e) => `${e.date}/${e.slot}/${e.servings}`),
        [`${DATES[0]}/dinner/2`, `${DATES[1]}/lunch/1`, `${DATES[3]}/lunch/1`],
        "the plan does not state which later slots eat the pot",
      );
      assert.deepEqual(led.orphans, [], "the pot was fully claimed, so nothing is orphaned");
      assert.deepEqual(led.reCooked, [], "nothing was scheduled outside the safe window");

      // THE SAFE WINDOW BINDS. Cooked food keeps fewer days than raw, so a
      // slot past the dish's window starts a NEW cook rather than serving
      // five-day-old chili and calling it thrift. An audited bank that
      // poisons nobody is the floor, not a feature.
      const late = leftoverLedger(
        {
          week: WEEK,
          entries: [
            { id: "a", date: DATES[0], slot: "dinner", recipeId: "chili", servings: 1 },
            { id: "b", date: DATES[6], slot: "lunch", recipeId: "chili", servings: 1 },
          ],
        },
        bank,
      );
      assert.equal(late.cooks.length, 2, "a slot six days later ate from a four-day-old pot");
      assert.equal(late.reCooked.length, 1, "the window breach was not reported");
      assert.equal(late.reCooked[0].sinceCook, 6);
      assert.equal(late.reCooked[0].safeDays, 4);

      // AN UNKNOWN WINDOW IS A SHORT WINDOW, never an unlimited one.
      const noField = leftoverLedger(
        {
          week: WEEK,
          entries: [
            { id: "a", date: DATES[0], slot: "dinner", recipeId: "x", servings: 1 },
            { id: "b", date: DATES[5], slot: "lunch", recipeId: "x", servings: 1 },
          ],
        },
        new Map([["x", { id: "x", name: "X", servings: 4, tags: ["batch-friendly"] }]]),
      );
      assert.equal(noField.reCooked.length, 1, "a recipe with no safeDays was treated as keeping forever");

      // AND NO ORPHAN CONTAINERS on a real generated week. Measured across
      // five salts on the live bank: every unclaimed remainder is a fraction
      // of a serving, which is the arithmetic of fractional plates, never a
      // container of food nobody eats.
      const files = readdirSync(BANK_DIR).filter((f) => f.endsWith(".json"));
      const liveBank = files.map((f) => JSON.parse(readFileSync(new URL(f, BANK_DIR), "utf8")));
      for (const r of liveBank) {
        assert.ok(
          Number(r.safeDays) > 0,
          `${r.id}: no safeDays, so its leftovers have no window at all`,
        );
      }
    },
  },

  {
    id: "P8",
    name: "P8 one pot, per-person plates solved from each person's own targets, guests included",
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

      // ─────────────────────────────────────────────────────────────────
      // SOLVED PLATES. Everything above this line held while the engine was
      // parked: shares of a pan, which is the fallback, not the promise. The
      // promise is "per-person plates that MEET EACH PERSON'S TARGETS", and
      // that needs the transform to actually run.
      // ─────────────────────────────────────────────────────────────────
      const dish = {
        id: "bowl",
        name: "Rice Bowl",
        mealType: "dinner",
        servings: 4,
        assembly: "plated",
        nutrition: { calories: 700, protein: 45 },
        ingredients: [
          { qty: 800, unit: "g", food: "chicken thigh" },
          { qty: 600, unit: "g", food: "brown rice" },
          { qty: 400, unit: "g", food: "broccoli" },
          { qty: 2, unit: "tbsp", food: "olive oil" },
        ],
        instructions: ["Cook the rice.", "Sear the chicken.", "Steam the broccoli."],
      };
      // two real people who eat very differently out of one pot
      const gain = {
        phase: "gain",
        mealSlots: ["breakfast", "lunch", "dinner"],
        macros: { calories: 3700, protein: 175 },
      };
      const loss = {
        phase: "loss",
        mealSlots: ["breakfast", "lunch", "dinner"],
        macros: { calories: 1500, protein: 110 },
      };
      const share = slotShareFor(gain, "dinner");

      // SEATS SIZED FROM TARGETS, then plates SOLVED on top: two different
      // jobs. Servings decide how much of the pot is yours; the transform
      // decides what that portion is made of.
      const sv = (t) => Math.round(((t.macros.calories * share) / dish.nutrition.calories) * 4) / 4;
      const table = {
        id: "t2",
        date: DATES[4],
        slot: "dinner",
        recipeId: "bowl",
        guests: 2,
        seats: [
          {
            id: "big",
            servings: sv(gain),
            rawServings: (gain.macros.calories * share) / dish.nutrition.calories,
          },
          {
            id: "small",
            servings: sv(loss),
            rawServings: (loss.macros.calories * share) / dish.nutrition.calories,
          },
        ],
      };
      const withGuests = [...table.seats, ...guestSeats(table)];
      assert.equal(withGuests.length, 4, "two guests did not become two seats");
      const targetsById = new Map();
      /** @type {Record<string, number>} */
      const shares = {};
      for (const st of withGuests) {
        const own = st.guest ? GUEST_TARGETS : st.id === "big" ? gain : loss;
        targetsById.set(st.id, own);
        shares[st.id] = slotShareFor(own, "dinner");
      }
      const syn = synthesize({ recipe: dish, seats: withGuests, targetsById, slotShares: shares });
      assert.equal(syn.synthMode, "solved", "the engine did not run on a tagged dish");

      // EACH PLATE MEETS ITS OWN PERSON'S TARGET. An unclamped solve is
      // exact by construction; a clamped one must REPORT the gap rather than
      // claim the target (P1's honesty rule, living inside P8).
      for (const st of withGuests) {
        const r = syn.bySeat[st.id];
        const own = targetsById.get(st.id);
        if (r.hit) {
          assert.equal(
            r.hit.targetCalories,
            Math.round(own.macros.calories * shares[st.id]),
            `${st.id}: the report aimed at the wrong number`,
          );
          assert.equal(
            r.hit.targetProtein,
            Math.round(own.macros.protein * shares[st.id]),
            `${st.id}: the report aimed at the wrong protein`,
          );
        } else {
          // no gap reported means the solve landed clean. VERIFY that; never
          // read the absence of a complaint as evidence of success.
          const got = syn.rows.find((x) => x.food === "chicken thigh")?.perSeat?.[st.id] ?? 0;
          assert.ok(got > 0, `${st.id}: a solved plate carried no protein at all`);
        }
      }

      // AND THE PLATES DIFFER IN THE RIGHT DIRECTION: the gain-phase seat
      // takes more protein than the loss-phase one. That is the whole point
      // of one pot.
      const chicken = syn.rows.find((x) => x.food === "chicken thigh");
      assert.ok(
        chicken.perSeat.big > chicken.perSeat.small,
        "the bigger eater was given less protein than the smaller one",
      );

      // ONE SET OF INSTRUCTIONS PLUS A PLATING SECTION, exactly as the done
      // test words it: the shared steps are untouched, and the per-person
      // amounts live in a separate section built from the solve.
      const plated = buildServe(
        table,
        dish,
        [
          { id: "big", name: "Big" },
          { id: "small", name: "Small" },
        ],
        { big: null, small: null },
        syn,
      );
      assert.equal(dish.instructions.length, 3, "the shared instructions were rewritten per person");
      assert.equal(plated.rows.length, 4, "the plating section lost a seat");
      for (const row of plated.rows) {
        assert.ok(row.lines?.length > 0, `${row.name}: a solved table rendered no plate lines`);
        assert.ok(
          row.lines.some((l) => /chicken thigh/.test(l)),
          `${row.name}: the plate line never says how much of the protein to serve`,
        );
      }
      assert.ok(
        plated.rows[0].lines.join() !== plated.rows[1].lines.join(),
        "two people with different targets were handed identical plates",
      );

      // PLATES FOR GUESTS WHO HAVE NO PROFILE, which the done test names
      // explicitly. Solved against the written-down default, counted in the
      // denominator, and rendered like anyone else.
      const guestRows = plated.rows.filter((row) => row.id.startsWith("guest-"));
      assert.equal(guestRows.length, 2, "a guest at the table got no plate");
      assert.ok(guestRows[0].lines.length > 0, "the guest plate had no amounts on it");
      assert.equal(syn.bySeat["guest-01"].synthMode, "solved", "a guest plate was never solved");
      assert.deepEqual(
        buildServe(table, dish, [], {}, syn).rows.map((row) => row.id),
        ["guest-01", "guest-02"],
        "guest plates only appear when a household happens to be there too",
      );

      // THE ROLLOUT STAYS REVERSIBLE. Untagged is bit-identical to the day
      // before the engine woke up: every multiplier 1, rung 0-mixed.
      const untagged = synthesize({
        recipe: { ...dish, assembly: undefined },
        seats: withGuests,
        targetsById,
        slotShares: shares,
      });
      assert.equal(untagged.synthMode, "uniform");
      for (const st of withGuests) {
        assert.equal(untagged.bySeat[st.id].rung, "0-mixed");
        assert.equal(untagged.bySeat[st.id].alpha, 1);
        assert.equal(untagged.bySeat[st.id].beta, 1);
      }

      // ─────────────────────────────────────────────────────────────────
      // AND THE REAL BANK. A fixture proves the engine works; only the bank
      // proves it works on David's food. Every recipe carrying the tag must
      // SOLVE: a tagged dish that degrades to "this dish is one thing
      // nutritionally" is a promise made and quietly withdrawn.
      // ─────────────────────────────────────────────────────────────────
      const bankFiles = readdirSync(BANK_DIR).filter((f) => f.endsWith(".json"));
      const tagged = bankFiles
        .map((f) => JSON.parse(readFileSync(new URL(f, BANK_DIR), "utf8")))
        .filter((r) => r.assembly === "plated");
      assert.ok(tagged.length > 0, "not one bank recipe is plated: the engine is still dark");
      /** @type {string[]} */
      const broken = [];
      for (const r of tagged) {
        const out = synthesize({
          recipe: r,
          seats: [{ id: "one", servings: 1, rawServings: 1 }],
          targetsById: new Map([["one", gain]]),
          slotShares: { one: slotShareFor(gain, r.mealType) },
        });
        if (out.synthMode !== "solved") broken.push(`${r.id}: ${out.bySeat.one?.rung ?? "refused"}`);
        // every row the engine MOVES needs a gram bridge and a macro, or the
        // whole recipe fails closed. Flavor rows never move and never need
        // one, which is why the keyword list is load-bearing.
        for (const ing of r.ingredients ?? []) {
          if (partOf(ing) === "flavor") continue;
          const moved = out.rows?.find((x) => x.food === ing.food);
          if (!moved || !(moved.qty > 0)) broken.push(`${r.id}: ${ing.food} never reached a plate`);
        }
      }
      assert.deepEqual(broken.slice(0, 6), [], `${broken.length} tagged recipes cannot be plated`);
      console.log(
        `\n  PLATED SET: ${tagged.length} of ${bankFiles.length} bank recipes tailor per person\n`,
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
    name: "P10 an away meal enters the plan, the day re-balances, and a hall tray is composed to quota",
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

      // THE DINING HALL. Nothing in the app referenced Purdue dining at all
      // until 2026-08-19, so this half of the promise had no code behind it:
      // an away meal could be declared and the day rebalanced around a flat
      // estimate, but the meal itself could not be BUILT.
      //
      // The payload shape below is the real one, taken from a live response of
      // api.hfs.purdue.edu on 2026-08-19. The test does not hit the network,
      // because a promise that only passes when a dining hall is serving is not
      // a promise anybody can rely on.
      const menuDay = {
        Location: "Earhart",
        Meals: [
          {
            Type: "Dinner",
            Stations: [
              {
                Name: "Grill",
                Items: [
                  {
                    ID: "chicken",
                    Name: "Halal Chicken Breast",
                    IsVegetarian: false,
                    NutritionReady: true,
                    Allergens: [{ Name: "Milk", Value: false }],
                  },
                  {
                    ID: "bun",
                    Name: "Hamburger Bun",
                    IsVegetarian: true,
                    NutritionReady: true,
                    // Purdue lists these separately and both map to one preset
                    Allergens: [
                      { Name: "Gluten", Value: true },
                      { Name: "Wheat", Value: true },
                    ],
                  },
                ],
              },
            ],
          },
          { Type: "Breakfast", Stations: [] },
        ],
      };
      const listed = itemsForMeal(menuDay, "Dinner");
      assert.equal(listed.length, 2, "the day's dinner items did not flatten out of the stations");
      assert.equal(listed[0].station, "Grill");
      assert.deepEqual(listed[1].allergens, ["gluten", "wheat"]);
      assert.deepEqual(itemsForMeal(menuDay, "Lunch"), [], "a meal not served returned items anyway");

      const item = parseItem({
        ID: "chicken",
        Name: "Halal Chicken Breast",
        Allergens: [{ Name: "Milk", Value: false }],
        Nutrition: [
          { Name: "Serving Size", LabelValue: "3 oz" },
          { Name: "Calories", Value: 121.6, LabelValue: "122" },
          { Name: "Protein", Value: 26.3, LabelValue: "26g" },
        ],
      });
      assert.equal(item.protein, 26.3);
      assert.equal(item.servingSize, "3 oz");
      // AN ITEM WITH NO PUBLISHED NUMBERS IS NOT A FREE ONE. null must never
      // be read as zero, or a tray silently counts food it cannot see.
      assert.equal(parseItem({ ID: "x", Name: "Mystery", Nutrition: [] }), null);

      // COMPOSED TO A STATED CALORIE AND PROTEIN QUOTA.
      const menu = [
        { id: "chicken", name: "Halal Chicken Breast", calories: 122, protein: 26, allergens: [] },
        { id: "rice", name: "Brown Rice", calories: 210, protein: 5, allergens: [] },
        { id: "bun", name: "Hamburger Bun", calories: 150, protein: 5, allergens: ["gluten", "wheat"] },
        { id: "mystery", name: "Mystery Bake", calories: NaN, protein: NaN, allergens: [] },
      ];
      const tray = composeTray(menu, { calories: 700, protein: 50 });
      assert.equal(tray.meets.protein, true, `the tray missed its protein quota: ${tray.protein} g`);
      assert.equal(tray.meets.calories, true, `the tray missed its calorie quota: ${tray.calories}`);
      assert.ok(
        tray.picks.some((p) => p.name === "Halal Chicken Breast"),
        "the densest protein on the line was not on the tray",
      );
      // the item the hall published no numbers for is EXCLUDED and said so,
      // never quietly counted as nothing
      assert.ok(
        tray.excluded.some((e) => e.name === "Mystery Bake"),
        "an item with no published numbers vanished instead of being named",
      );

      // P3'S OBLIGATION, RECORDED ON THIS PROMISE WHEN THE MENU SCREEN
      // SHIPPED: a composed tray is screened against declared allergens. The
      // hall's own per-item table is better data than a photographed menu.
      const safe = composeTray(menu, { calories: 700, protein: 50 }, {
        avoidAllergens: ["gluten"],
      });
      assert.ok(
        !safe.picks.some((p) => p.name === "Hamburger Bun"),
        "a tray was built with something the person avoids on it",
      );
      const bun = safe.excluded.find((e) => e.name === "Hamburger Bun");
      assert.deepEqual(bun.because, ["gluten"], "one reason was reported twice for one item");

      // AND THE COURT-SERVING CAVEAT IS LOUD. A dining court portion is
      // whatever the server puts on the plate, so a tray quoted to the calorie
      // would imply precision that does not exist.
      assert.match(tray.caution, /whatever the server puts on the plate/);

      // OVERSHOOT IS THE RIGHT DIRECTION HERE, and it is the one place in Mise
      // where that is true: the meal is already paid for, so the marginal cost
      // of another scoop of the expensive macro is zero.
      assert.ok(tray.protein >= 50);
    },
  },

  {
    id: "P12",
    name: "P12 the bank is audited, nothing enters the plan unaudited, and more than one nutrition philosophy ranks it",
    fn: () => {
      const files = readdirSync(BANK_DIR).filter((f) => f.endsWith(".json"));
      /** @type {string[]} */
      const offences = [];
      /** @type {Record<string, number>} */
      const voices = {};
      let audited = 0;
      for (const f of files) {
        const r = JSON.parse(readFileSync(new URL(f, BANK_DIR), "utf8"));

        // DECLARED, ALWAYS. `null` is legal and means "never audited". ABSENT
        // is not, because absent is the state the promise rotted in: nothing
        // could confirm or refute it, and an unfalsifiable promise reads as a
        // passing one.
        if (!("audited" in r)) {
          offences.push(`${r.id}: no audited field at all`);
          continue;
        }
        if (r.audited === null) continue;

        // NO RUBBER STAMPS. An audit claim must cite a real quote from this
        // recipe's own record, so a person can check it in ten seconds.
        const a = r.audited;
        if (!a.standard) offences.push(`${r.id}: audited with no standard named`);
        if (!a.on) offences.push(`${r.id}: audited with no date`);
        if (!a.by) offences.push(`${r.id}: audited by nobody`);
        if (typeof a.evidence !== "string" || a.evidence.trim().length < 15) {
          offences.push(`${r.id}: claims an audit and cites no evidence`);
        }
        audited++;
        voices[a.standard] = (voices[a.standard] ?? 0) + 1;

        // NUTRIENT DATA ON ENTRY. P12's own rule for the bank's growth, and
        // it is checkable today: the macros Mise actually enforces.
        for (const k of ["calories", "protein", "carbs", "fat"]) {
          if (!Number.isFinite(r.nutrition?.[k])) offences.push(`${r.id}: nutrition.${k} missing`);
        }
        if (!r.nutrition?.method) offences.push(`${r.id}: nutrition with no stated method`);
      }
      assert.deepEqual(offences.slice(0, 8), [], `${offences.length} bank recipes break the rule`);

      // THE MEASUREMENT, printed rather than asserted, because this is the
      // number the promise is failing ON and it must be visible every run.
      // The done test wants ALL of them audited in more than one nutritional
      // voice; the gap test below owns the distance.
      console.log(
        `\n  BANK AUDIT: ${audited} of ${files.length} recipes audited, ` +
          `voices: ${JSON.stringify(voices)}\n`,
      );
      // EVERY ONE OF THEM. The promise says "every recipe in the bank is
      // audited", and until 2026-08-19 that half was simply failing: 88 of
      // 126. It is a count, so it is checkable, so it gets checked rather
      // than printed and hoped over.
      assert.equal(
        audited,
        files.length,
        `${files.length - audited} bank recipes carry no audit at all`,
      );

      // ONE ID, ONE RECIPE. Found while auditing 2026-08-19: two files
      // claimed the id greek-lemon-chicken-orzo-soup, because a write to the
      // wrong filename had overwritten the Doner-Style Kebab Bowl with the
      // soup's contents. Which recipe wins depended on directory read order,
      // and mom's profile still held a personal variant pointing at an id
      // the shared bank no longer had. A bank that cannot say what is in it
      // cannot vouch for what is in it.
      /** @type {Map<string, string>} */
      const seenIds = new Map();
      /** @type {string[]} */
      const idFaults = [];
      for (const f of files) {
        const r = JSON.parse(readFileSync(new URL(f, BANK_DIR), "utf8"));
        if (seenIds.has(r.id)) idFaults.push(`${r.id}: claimed by ${seenIds.get(r.id)} and ${f}`);
        seenIds.set(r.id, f);
        if (f !== `${r.id}.json`) idFaults.push(`${f} holds a recipe whose id is ${r.id}`);
      }
      assert.deepEqual(idFaults, [], "the bank cannot say which file is which recipe");

      // NONE EVER ENTERED UNAUDITED, which is the clause the count alone
      // cannot prove. A recipe brought in mid-week through the annotator is
      // a guest of the plan: usable in the week that imported it, never
      // chosen by GENERATE, and promoted "only through this audit". That
      // last word used to be decorative — `promoted: true` was the whole
      // gate, so one hand-set boolean walked an unaudited recipe into the
      // generator. Both conditions now.
      const imported = { id: "guest-dish", tags: ["hbp-annotated"], nutrition: { calories: 500 } };
      assert.equal(untrustedForAutoPlan(imported), true, "an imported recipe was auto-plannable on arrival");
      assert.equal(
        untrustedForAutoPlan({ ...imported, promoted: true }),
        true,
        "a promotion flag alone walked an unaudited recipe into GENERATE",
      );
      assert.equal(
        untrustedForAutoPlan({
          ...imported,
          promoted: true,
          audited: { standard: "greger", on: "2026-08-19", by: "x", evidence: "checked" },
        }),
        false,
        "a promoted AND audited recipe is a member of the bank and must be selectable",
      );

      assert.ok(audited > 0, "not one recipe in the bank carries an audit");

      // ── SECOND CLAUSE: more than one nutrition philosophy is represented ──
      // The bar is the council's own (2026-08-22, five isolated seats), and
      // it is deliberately falsifiable, because authoring a second FILE is
      // not evidence of a second VOICE:
      //
      //   A second bundle counts only if it RE-RANKS THE BANK: Spearman rho
      //   below 0.8, and at least 15 recipes crossing the pass/fail line.
      //
      // Two bundles agreeing at rho 0.9 would be one philosophy wearing two
      // labels, however different their prose.
      assert.ok(existsSync(PHILOSOPHIES), "no philosophies/ directory in the data repo");
      const bundles = readdirSync(PHILOSOPHIES)
        .filter((f) => f.endsWith(".json"))
        .map((f) => JSON.parse(readFileSync(new URL(f, PHILOSOPHIES), "utf8")));
      assert.ok(bundles.length >= 2, `P12 needs more than one philosophy, found ${bundles.length}`);
      // a bundle naming a fact the engine cannot compute is REFUSED, never
      // silently scored zero
      for (const b of bundles) {
        assert.deepEqual(validateBundle(b), [], `bundle "${b.id}" is not scoreable`);
      }
      const bankRecipes = files.map((f) => JSON.parse(readFileSync(new URL(f, BANK_DIR), "utf8")));
      const [pa, pb] = bundles;
      const { rho, crossings, n } = rankAgreement(pa, pb, bankRecipes);
      assert.equal(n, bankRecipes.length);
      assert.ok(
        rho < 0.8,
        `"${pa.id}" and "${pb.id}" rank the bank at rho ${rho}; below 0.8 required or they are one voice`,
      );
      assert.ok(
        crossings >= 15,
        `only ${crossings} recipes cross the pass line between "${pa.id}" and "${pb.id}"; 15 required`,
      );
      // they disagree in the DIRECTION the philosophies claim: the
      // food-quality voice declines to score where protein came from, so a
      // clean whole-food animal dish must rank higher under it
      const animalWhole = bankRecipes.find(
        (r) => r.id === "sheet-pan-lemon-chicken-broccoli-cauliflower",
      );
      if (animalWhole) {
        const plantVoice = bundles.find((x) => x.weights?.plantProteinShare);
        const qualityVoice = bundles.find((x) => !x.weights?.plantProteinShare);
        assert.ok(plantVoice && qualityVoice, "expected one plant-weighted and one quality bundle");
        assert.ok(
          scoreRecipe(qualityVoice, animalWhole).score > scoreRecipe(plantVoice, animalWhole).score,
          "a whole-food animal dish must score higher under the voice that ignores protein source",
        );
      }
      // and a philosophy can express a WEEK-shaped floor, which the per-day
      // food-group machinery structurally cannot. Two seats independently
      // called this the tell that the engine truly holds no philosophy.
      const withFloor = bundles.find((x) => Number(x.weekFloors?.distinctPlantSpecies) > 0);
      assert.ok(withFloor, "no bundle expresses a week-level floor");
      const wideWeek = scoreWeek(withFloor, bankRecipes.slice(0, 40));
      const narrowWeek = scoreWeek(withFloor, bankRecipes.slice(0, 2));
      assert.ok(wideWeek.distinctPlantSpecies > narrowWeek.distinctPlantSpecies);
      assert.equal(narrowWeek.meets.distinctPlantSpecies, false, "two recipes cannot meet the floor");
      assert.equal(wideWeek.meets.distinctPlantSpecies, true, "forty recipes must");
    },
  },
  {
    id: "P11",
    name: "P11 the review shows plan against reality, takes your own words, and the next week reads it",
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

      // WHAT IS ACTUALLY LEFT. The pantry scan IS the fridge photograph in
      // this app, so the honest reading of that clause is what the last scan
      // says is still on the shelf, named rather than counted.
      const withShelf = composeWeekReview({
        plan,
        waste: { events: [] },
        daily: { days: [] },
        targets: TARGETS,
        weekDates: DATES,
        recipesById: new Map([["chili", recipe]]),
        pantry: {
          items: [
            { id: "s1", food: "spinach", qty: "1 bag", location: "fridge", expires: DATES[3] },
            { id: "s2", food: "peas", qty: "1 bag", location: "freezer", expires: DATES[3] },
          ],
        },
      });
      assert.equal(withShelf.stillOnShelf.rows, 1, "a freezer row was counted as fridge leftovers");
      assert.deepEqual(withShelf.stillOnShelf.foods, ["spinach"]);
      assert.equal(withShelf.stillOnShelf.scanned, true);
      assert.equal(dark.stillOnShelf.scanned, false, "a never-scanned shelf claimed to be empty");

      // YOUR OWN COMMENTS, IN PLAIN WORDS, and never parsed.
      const noted = setReviewNote(plan, "was not hungry Tuesday, ate it for lunch Wednesday");
      assert.match(noted.reviewNote, /not hungry Tuesday/);
      assert.equal(
        composeWeekReview({
          plan: noted,
          waste: { events: [] },
          daily: { days: [] },
          targets: TARGETS,
          weekDates: DATES,
          recipesById: new Map([["chili", recipe]]),
        }).note,
        "was not hungry Tuesday, ate it for lunch Wednesday",
      );
      assert.equal(setReviewNote(noted, "   ").reviewNote, undefined, "an emptied note did not clear");

      // AND THE NEXT WEEK DEMONSTRABLY READS IT. This is the clause the whole
      // promise turns on and the one that was missing: the review REPORTED and
      // nothing consumed it. Evidence in, different week out.
      //
      // The pool here is deliberately flat, every dinner identical but for its
      // id and its food, so last week's evidence is the ONLY thing that can
      // separate them. On the real bank a food-group need routinely outweighs
      // this signal, and that is correct: measured evidence steers the week, it
      // does not get to starve it.
      const flat = ["breakfast", "lunch", "dinner", "smoothie", "snack"].flatMap((meal) =>
        [1, 2, 3, 4, 5].map((n) => ({
          id: `${meal}-${n}`,
          name: `${meal} ${n}`,
          mealType: meal,
          servings: 1,
          totalTime: 30,
          difficulty: 1,
          nutrition: { calories: 520, protein: 34, carbs: 50, fat: 15 },
          ingredients: [{ qty: 100, unit: "g", food: `${meal} food ${n}` }],
          foodGroups: { beans: 1, greens: 1 },
          instructions: ["cook it"],
        })),
      );
      const flatById = recipesById(flat);
      const runFlat = (/** @type {any} */ rev) =>
        generateWeek({
          recipes: flat,
          targets: TARGETS,
          pantry: { items: [] },
          weekId: WEEK,
          plan: { week: WEEK, entries: [] },
          salt: 7,
          review: rev,
        });
      const base = runFlat(null);
      const victim = base.plan.entries.find((e) => e.slot === "dinner" && e.recipeId);
      assert.ok(victim, "the fixture generated no dinner to learn from");
      const before = base.plan.entries.filter((e) => e.recipeId === victim.recipeId).length;
      assert.ok(before > 0);

      // a prior week where that meal was planned four times and never cooked
      const priorWeek = {
        week: WEEK,
        entries: DATES.slice(0, 4).map((d, i) => ({
          id: `p${i}`,
          date: d,
          slot: "dinner",
          recipeId: victim.recipeId,
          servings: 1,
        })),
      };
      const victimFood = String(flatById.get(victim.recipeId).ingredients[0].food);
      const lastWeek = composeWeekReview({
        plan: priorWeek,
        waste: { events: [{ date: DATES[0], food: victimFood }] },
        daily: { days: [] },
        targets: TARGETS,
        weekDates: DATES,
        recipesById: flatById,
      });
      assert.ok(
        lastWeek.signals.skippedRecipeIds.includes(victim.recipeId),
        "a planned meal that was never cooked produced no signal",
      );
      assert.deepEqual(lastWeek.signals.tossedFoods, [victimFood]);

      const taught = runFlat(lastWeek);
      const after = taught.plan.entries.filter((e) => e.recipeId === victim.recipeId).length;
      assert.ok(
        after < before,
        `the review changed nothing: ${victim.recipeId} appeared ${before} times before and ` +
          `${after} times after being reported uncooked`,
      );

      // and the loop announces itself, because an engine that reports nothing
      // is this codebase's named failure mode
      assert.equal(taught.report.manifest.review.read, true);
      assert.equal(taught.report.manifest.review.skippedRecipes, 1);
      assert.equal(taught.report.manifest.review.tossedFoods, 1);
      assert.equal(build().report.manifest.review.read, false, "a week with no review claimed one");
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
    id: "P9",
    name: "P9 GAP every bank recipe teaches inside the step where it matters",
    why:
      "owner David, blocked on the five-way HBP layout pick. 103 of 126 recipes already carry a real " +
      "teaching clause in-step, so this is a 23-recipe content pass plus a layout decision, not an " +
      "engineering job. The first half of the done test, a first-time cook reaching a result that " +
      "tastes good, is not machine-checkable and this ledger does not pretend otherwise.",
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

// ───────────────────────────────────────────────────────────────────────────
// THE PROTEIN OVERSHOOT (2026-08-23, session quake). Against the LIVE bank
// and David's LIVE profile, because this was never an engine bug in the
// abstract: it was this bank, at this calorie target, with these swipes.
//
// Before this work, on 5 salts of a real week: 234 g/day bought, 34 of 35
// days over his ratified 215 g ceiling, and every swipe scenario reported
// 35 of 35 — WORSE than using no swipes at all, because the ceiling was
// being charged for buffet protein nobody paid for.
// ───────────────────────────────────────────────────────────────────────────

const LIVE_PROFILE = new URL("../../mise-data/profile/targets.json", import.meta.url);
const MOM_PROFILE = new URL("../../mise-data/profiles/mom/profile/targets.json", import.meta.url);
const LIVE_WEEK = "2026-W35";
const LIVE_DATES = datesOfWeek(LIVE_WEEK);
const SALTS = [0, 1, 2, 3, 4];

function liveBank() {
  return readdirSync(BANK_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(new URL(f, BANK_DIR), "utf8")));
}

/** Swipe pins for a slot. `pinned: true` is REQUIRED — generateWeek filters
 *  on it, so an out entry without it is silently cleared and the run looks
 *  byte-identical to a no-swipe run. This cost a whole measurement pass. */
function swipePins(recipes, slot, dates) {
  return dates.map((date) => ({
    date,
    slot,
    out: true,
    pinned: true,
    freeText: SWIPE_TEXT,
    currency: "swipes",
    ...buffetMacroEstimate(recipes, slot),
  }));
}

function liveRun(recipes, targets, pins, salt) {
  const { plan } = generateWeek({
    recipes,
    targets,
    pantry: {},
    weekId: LIVE_WEEK,
    plan: { week: LIVE_WEEK, entries: pins },
    salt,
    today: LIVE_DATES[0],
  });
  return plan;
}

test("the protein CEILING is measured on what the list BOUGHT, not what he ate", () => {
  const recipes = liveBank();
  const targets = JSON.parse(readFileSync(LIVE_PROFILE, "utf8"));
  const byId = new Map(recipes.map((r) => [r.id, r]));
  const plan = liveRun(recipes, targets, swipePins(recipes, "dinner", LIVE_DATES), 0);
  const d = LIVE_DATES[3];
  const eaten = dayTotals(plan.entries, byId, d).protein;
  const bought = dayBought(plan.entries, byId, d);
  // the swipe's grams are real food and cost nothing: they must show up in
  // what he EATS and be absent from what he BUYS
  assert.ok(eaten > bought, `a swipe day must eat more than it buys (${eaten} vs ${bought})`);
  assert.ok(bought > 0, "the cooked meals still cost something");
});

test("no day is over the protein ceiling, with swipes or without", () => {
  const recipes = liveBank();
  const targets = JSON.parse(readFileSync(LIVE_PROFILE, "utf8"));
  const byId = new Map(recipes.map((r) => [r.id, r]));
  const ceiling = enforcedCeilings(targets.macros).protein;
  assert.equal(ceiling, 215, "David ratified 215 g on 2026-08-19");

  const scenarios = [
    ["no swipes", []],
    ["7 lunch swipes", swipePins(recipes, "lunch", LIVE_DATES)],
    ["7 dinner swipes", swipePins(recipes, "dinner", LIVE_DATES)],
  ];
  for (const [label, pins] of scenarios) {
    const over = [];
    for (const salt of SALTS) {
      const plan = liveRun(recipes, targets, pins, salt);
      for (const d of LIVE_DATES) {
        const bought = dayBought(plan.entries, byId, d);
        if (bought > ceiling) over.push(`${label} salt${salt} ${d} ${Math.round(bought)}g`);
      }
    }
    assert.deepEqual(over, [], `${label}: days over the ${ceiling} g bought-ceiling`);
  }
});

test("the fix did not trade an overshoot for an undershoot", () => {
  const recipes = liveBank();
  const targets = JSON.parse(readFileSync(LIVE_PROFILE, "utf8"));
  const byId = new Map(recipes.map((r) => [r.id, r]));
  const floors = enforcedFloors(targets.macros);
  // the ratified floor, not the derived 155 that the deleted proteinFloor
  // key used to produce (council 2026-08-19: "protein IS the floor now")
  assert.equal(floors.protein, 180, "an absent proteinFloor derives `protein`");

  const misses = [];
  for (const pins of [[], swipePins(recipes, "lunch", LIVE_DATES)]) {
    for (const salt of SALTS) {
      const plan = liveRun(recipes, targets, pins, salt);
      for (const d of LIVE_DATES) {
        const t = dayTotals(plan.entries, byId, d);
        // the FLOOR reads what he EATS: a swipe genuinely feeds him
        if (t.protein < floors.protein) misses.push(`${d} protein ${Math.round(t.protein)}`);
        if (t.calories < floors.calories) misses.push(`${d} kcal ${Math.round(t.calories)}`);
      }
    }
  }
  assert.deepEqual(misses, [], "days below a floor after the ceiling work");
});

test("mom's bug stays fixed: dense picks, and no calorie overshoot to reach protein", () => {
  if (!existsSync(MOM_PROFILE)) return; // her profile is optional in a clone
  const recipes = liveBank();
  const targets = JSON.parse(readFileSync(MOM_PROFILE, "utf8"));
  const byId = new Map(recipes.map((r) => [r.id, r]));
  const floors = enforcedFloors(targets.macros);
  const ceiling = enforcedCeilings(targets.macros).calories;

  const bad = [];
  for (const salt of SALTS) {
    const plan = liveRun(recipes, targets, [], salt);
    for (const d of LIVE_DATES) {
      const t = dayTotals(plan.entries, byId, d);
      // the original bug: reaching her protein required extra calories, and
      // the top-up added them until her day ran over its own ceiling. She sat
      // at 1,722 kcal/day against a 1,627 ceiling on 23 of 35 days.
      if (t.protein < floors.protein) bad.push(`${d} protein ${Math.round(t.protein)}`);
      if (t.calories > ceiling) bad.push(`${d} kcal ${Math.round(t.calories)} > ${ceiling}`);
    }
  }
  assert.deepEqual(bad, [], "a loss-phase profile must hit protein without overshooting calories");
});

test("the budget pass never makes the protein bill worse", () => {
  const recipes = liveBank();
  const targets = JSON.parse(readFileSync(LIVE_PROFILE, "utf8"));
  const byId = new Map(recipes.map((r) => [r.id, r]));
  const catalogue = JSON.parse(readFileSync(CATALOGUE, "utf8"));
  const weekProtein = (p) =>
    LIVE_DATES.reduce((s, d) => s + dayBought(p.entries, byId, d), 0);

  for (const salt of [0, 1]) {
    const gen = liveRun(recipes, targets, [], salt);
    const before = weekProtein(gen);
    const out = swapToFit({
      plan: gen,
      recipes,
      recipesById: byId,
      pantry: {},
      catalogue,
      store: "pay-less",
      region: catalogue.region,
      budgetUsd: 100,
      targets,
      fromDate: LIVE_DATES[0],
      today: LIVE_DATES[0],
      bankById: byId,
    });
    // it used to walk TOWARD protein (1,661 g to 1,701 g across 20 swaps),
    // because cheap-per-calorie food in this bank is protein-dense
    assert.ok(
      weekProtein(out.plan) <= before + 0.01,
      `salt${salt}: swapToFit raised bought protein ${before} -> ${weekProtein(out.plan)}`,
    );
  }
});

// ───────────────────────────────────────────────────────────────────────────
// P4: EVERY ROW IS A THING YOU CAN PUT IN A TROLLEY. Five bugs read off the
// real 2026-W35 list (2026-08-23). Each is a row that was arithmetically
// correct and useless at a shelf, which is precisely the failure P4 names.
// ───────────────────────────────────────────────────────────────────────────

test("a leftover never becomes a shopping row", () => {
  // "cooked chicken x1" appeared on the real list: a pantry leftover marked
  // `low` re-entering the buy list. No store sells it, and a row nobody can
  // shop reads as protein already covered.
  assert.equal(isPreparedFood("cooked chicken"), true);
  assert.equal(isPreparedFood("leftover chili"), true);
  assert.equal(isPreparedFood("roasted vegetables"), true);
  // narrow on purpose: a false positive silently drops real food off the list
  assert.equal(isPreparedFood("chicken breast"), false);
  assert.equal(isPreparedFood("baby spinach"), false);

  const pantry = {
    items: [
      { id: "cooked-chicken", food: "cooked chicken", state: "low" },
      { id: "avocado", food: "avocado", state: "low" },
    ],
  };
  const list = deriveShoppingList(
    { week: WEEK, entries: [] },
    new Map(),
    pantry,
    null,
    undefined,
    undefined,
    new Map(),
  );
  const foods = list.items.map((i) => String(i.food).toLowerCase());
  assert.ok(!foods.includes("cooked chicken"), "a leftover is not purchasable");
  assert.ok(foods.includes("avocado"), "a real food running low still gets bought");
});

test("an aisle is a walking order, so broth is not meat and flaxseed is not either", () => {
  // both were real misfilings: "chicken broth" matched `chicken`, "ground
  // flaxseed" matched a bare `ground`, and "low-sodium vegetable broth"
  // matched `vegetables?` and landed in PRODUCE.
  assert.equal(aisleOf("chicken broth"), "canned");
  assert.equal(aisleOf("low-sodium vegetable broth"), "canned");
  assert.equal(aisleOf("ground flaxseed"), "snacks");
  assert.equal(aisleOf("ground cinnamon"), "spices");
  // and the ground meats must still be meat, which is why `ground` could not
  // simply be deleted without checking each one
  for (const m of ["ground beef", "ground turkey", "ground pork", "minced lamb"]) {
    assert.equal(aisleOf(m), "meat", m);
  }
});

test("one food is one row, whatever unit the recipe wrote it in", () => {
  // `red lentils` was in no unit table, so mergeIdentity fell back to
  // `${key}-${unit}` and 150 g from one recipe plus 1 cup from another became
  // two rows and two bags bought.
  const inGrams = mergeIdentity("red lentils", "g");
  const inCups = mergeIdentity("red lentils", "cup");
  assert.equal(inGrams.id, inCups.id, "same food, one row");
});

test("quantities are shelf-sized, not just arithmetically right", () => {
  // the real list said "baby spinach 23 1/4 cup" and "ground flaxseed 22 tbsp".
  // Both true, both unusable: nobody sells spinach by the cup.
  const spinach = mergeIdentity("baby spinach", "cup").qty(19.5);
  assert.equal(spinach?.unit, "g");
  assert.ok(spinach && spinach.qty > 400, `expected a weight, got ${spinach?.qty}`);
  const flax = mergeIdentity("ground flaxseed", "tbsp").qty(31.25);
  assert.equal(flax?.unit, "g");
  assert.ok(flax && flax.qty > 150, `expected a weight, got ${flax?.qty}`);
});

test("a trim can never leave a day under its calorie floor (P1)", () => {
  // The top-up runs BEFORE both trims, so nothing could put back calories a
  // trim removed. Invisible while the generator over-delivered (days sat at
  // 3,600-3,700 and no trim reached the floor); picking to a protein target
  // instead of past it lands days near the floor, and the first real week
  // generated on David's device came back with TWO days under 3,500 kcal and
  // `snackServingsAdded: 0`. Step 4.65 restores the floor after the trims.
  //
  // The review signals are the point of this fixture, not decoration: they
  // are what the live app passes and what the first harness did not, and
  // 19 penalised recipes is what pushed the week into the corner of the bank
  // where the floor became reachable.
  const recipes = liveBank();
  const targets = JSON.parse(readFileSync(LIVE_PROFILE, "utf8"));
  const byId = new Map(recipes.map((r) => [r.id, r]));
  const floors = enforcedFloors(targets.macros);
  const ceiling = enforcedCeilings(targets.macros).protein;

  const skipped = recipes.slice(0, 19).map((r) => r.id);
  const tossed = [...new Set(recipes.flatMap((r) => (r.ingredients ?? []).map((i) => i.food)))]
    .filter(Boolean)
    .slice(0, 18);
  const review = { signals: { tossedFoods: tossed, skippedRecipeIds: skipped } };

  const bad = [];
  for (const salt of SALTS) {
    const { plan } = generateWeek({
      recipes,
      targets,
      pantry: {},
      weekId: LIVE_WEEK,
      plan: { week: LIVE_WEEK, entries: [] },
      salt,
      today: LIVE_DATES[0],
      recentRecipeIds: skipped,
      review,
    });
    for (const d of LIVE_DATES) {
      const t = dayTotals(plan.entries, byId, d);
      if (t.calories < floors.calories) bad.push(`${d} kcal ${Math.round(t.calories)}`);
      if (t.protein < floors.protein) bad.push(`${d} protein ${Math.round(t.protein)}`);
      // and restoring the floor must not hand the money back: the restore
      // runs in lean mode precisely so it cannot re-inflate the protein bill
      const b = dayBought(plan.entries, byId, d);
      if (b > ceiling) bad.push(`${d} bought ${Math.round(b)} over ${ceiling}`);
    }
  }
  assert.deepEqual(bad, [], "a penalised week still lands inside every bound");
});
