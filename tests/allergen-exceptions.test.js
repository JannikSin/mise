// Allergen exceptions (P8 plates, P3 knows-you; David's ruling 2026-10-27).
// A synthetic housemate ("housemate-1") with a peanut allergy is off tree nuts
// too, but eats pine nuts and pesto with no nuts but pine nuts in it. One person
// may clear exactly those two terms from the nuts chip for themselves; every
// other nut-allergic person keeps them refused (the default stays
// conservative), and nothing ever clears peanut.
import test from "node:test";
import assert from "node:assert/strict";
import {
  ALLERGEN_EXCEPTIONS,
  ALLERGEN_TERMS,
  allergenExceptionsOf,
  avoidTermsFromAllergens,
  typedAvoidTerms,
  targetsFromQuestionnaire,
  mergeProfileAnswers,
} from "../app/lib/targets.js";
import { withCurrentAllergenTerms } from "../app/lib/store.js";
import { recipeConflicts } from "../app/lib/plan.js";
import { plateOf } from "../app/lib/plate-of.js";
import { PLATE_FIELDS, PLATE_SAFETY_FIELDS } from "../app/lib/plate-fields.js";
import { freshDb, SKIP } from "./_pglite.js";

const Q = /** @type {any} */ ({ sex: "f", age: 30, heightFt: 5, heightIn: 6, weightLb: 150, activity: 2, goal: "maintain" });

/** housemate-1 as the survey writes them: peanuts and nuts, pine nuts and pesto fine. */
const housemate = targetsFromQuestionnaire(Q, "2026-10-27", {
  allergens: ["peanuts", "nuts"],
  allergensFreeText: "tempeh",
  allergenExceptions: { nuts: ["pine nut", "pesto"] },
});
/** guest-a: an ordinary nut allergy, no exceptions. */
const nutAllergic = targetsFromQuestionnaire(Q, "2026-10-27", { allergens: ["nuts"] });

/** @param {string[]} foods */
const rec = (...foods) => ({ id: "r", ingredients: foods.map((food) => ({ qty: 1, unit: "cup", food })) });
/** @param {any} t @param {Record<string, any>} r */
const refused = (t, r) => recipeConflicts(r, t.diet, t.avoidIngredients, t.avoidRecipes).length > 0;

/** housemate-1 as every reader sees them: their own file, and a housemate reading the plate. */
const views = () => [
  ["survey", housemate],
  ["read heal", withCurrentAllergenTerms(housemate)],
  ["plate", withCurrentAllergenTerms(plateOf(housemate))],
];

test("the ruling: almond granola is refused", () => {
  for (const [v, t] of views()) assert.ok(refused(t, rec("almond granola", "greek yogurt")), v);
});

test("the ruling: walnut pesto and cashew pesto are refused", () => {
  for (const [v, t] of views()) {
    assert.ok(refused(t, rec("walnut pesto", "penne")), `walnut pesto, ${v}`);
    assert.ok(refused(t, rec("cashew pesto", "penne")), `cashew pesto, ${v}`);
    assert.ok(refused(t, rec("basil pesto", "walnuts")), `pesto plus a walnut row, ${v}`);
  }
});

test("the ruling: peanut anything is refused", () => {
  for (const [v, t] of views()) {
    for (const f of ["peanut butter", "peanut sauce", "peanut pesto", "roasted peanuts"]) {
      assert.ok(refused(t, rec(f, "rice")), `${f}, ${v}`);
    }
  }
});

test("the ruling: a pine nut salad is allowed", () => {
  for (const [v, t] of views()) assert.equal(refused(t, rec("baby spinach", "pine nuts", "olive oil")), false, v);
});

test("the ruling: basil pesto with pine nuts is allowed, jarred or made at home", () => {
  for (const [v, t] of views()) {
    assert.equal(refused(t, rec("basil pesto", "chicken breast", "pine nuts")), false, `jar, ${v}`);
    assert.equal(refused(t, rec("fresh basil", "pine nuts", "olive oil", "garlic")), false, `home, ${v}`);
    assert.equal(refused(t, rec("basil pesto with pine nuts")), false, `one row, ${v}`);
  }
});

test("default stays conservative: an ordinary nut allergy still refuses pine nuts and pesto", () => {
  for (const t of [nutAllergic, withCurrentAllergenTerms(nutAllergic), withCurrentAllergenTerms(plateOf(nutAllergic))]) {
    assert.ok(refused(t, rec("pine nuts", "baby spinach")));
    assert.ok(refused(t, rec("basil pesto", "penne")));
  }
  assert.equal("allergenExceptions" in nutAllergic, false, "absent = no exceptions");
});

test("an exception can never clear peanut or anything a peanut term covers", () => {
  const peanutTerms = ALLERGEN_TERMS.peanuts ?? [];
  for (const [id, terms] of Object.entries(ALLERGEN_EXCEPTIONS)) {
    assert.notEqual(id, "peanuts");
    for (const x of terms) {
      for (const p of peanutTerms) assert.ok(!x.includes(p) && !p.includes(x), `${x} vs ${p}`);
    }
  }
  const forged = { peanuts: ["peanut"], nuts: ["peanut", "almond", "walnut", "pine nut"], gluten: ["wheat"] };
  assert.deepEqual(allergenExceptionsOf(forged), { nuts: ["pine nut"] });
  const terms = avoidTermsFromAllergens(["peanuts", "nuts"], "", forged);
  for (const must of ["peanut", "almond", "walnut", "cashew", "pesto"]) assert.ok(terms.includes(must), must);
  assert.equal(terms.includes("pine nut"), false);
  for (const junk of [null, "pesto", ["pesto"], 3, { nuts: "pesto" }]) assert.deepEqual(allergenExceptionsOf(junk), {});
});

test("another chip that lists the term keeps it: dairy still refuses pesto", () => {
  const terms = avoidTermsFromAllergens(["nuts", "dairy"], "", { nuts: ["pesto"] });
  assert.ok(terms.includes("pesto"));
});

test("a word the person typed stays; a typed family honours their exceptions", () => {
  const exc = { nuts: ["pine nut", "pesto"] };
  assert.ok(avoidTermsFromAllergens(["nuts"], "pesto", exc).includes("pesto"), "typed pesto stays");
  const fam = typedAvoidTerms("tree nuts", exc);
  assert.ok(fam.includes("almond") && !fam.includes("pine nut") && !fam.includes("pesto"));
  assert.ok(typedAvoidTerms("tree nuts").includes("pine nut"), "no exceptions: the whole family");
  // a stored list that already holds a cleared term keeps it (only ever adds)
  const old = withCurrentAllergenTerms({ allergens: ["nuts"], avoidIngredients: ["pesto"], allergenExceptions: exc });
  assert.ok(old.avoidIngredients.includes("pesto"));
});

test("exceptions are kept only for a chip the person picked, and an edit can clear them", () => {
  const t = targetsFromQuestionnaire(Q, "2026-10-27", { allergens: ["peanuts"], allergenExceptions: { nuts: ["pesto"] } });
  assert.equal("allergenExceptions" in t, false);
  const cleared = mergeProfileAnswers(housemate, nutAllergic, /** @type {any} */ ({ calories: 2000, protein: 120, todayIso: "2026-10-28" }));
  assert.equal("allergenExceptions" in cleared, false);
  assert.ok(cleared.avoidIngredients.includes("pine nut"));
});

test("the plate carries the exceptions, and they are a safety key", () => {
  assert.ok(PLATE_FIELDS.includes("allergenExceptions"));
  assert.ok(PLATE_SAFETY_FIELDS.includes("allergenExceptions"));
  assert.deepEqual(plateOf(housemate).allergenExceptions, { nuts: ["pine nut", "pesto"] });
});

test("SQL: a non-owner adding an exception is loosening; removing one is not", { skip: SKIP }, async () => {
  const db = await freshDb();
  const q = async (/** @type {any} */ a, /** @type {any} */ b) =>
    (await db.query("select private.safety_loosened($1::jsonb, $2::jsonb) as l", [JSON.stringify(a), JSON.stringify(b)])).rows[0].l;
  const base = { allergens: ["nuts"], avoidIngredients: ["almond"] };
  assert.equal(await q(base, { ...base, allergenExceptions: { nuts: ["pesto"] } }), true, "added");
  assert.equal(await q({ ...base, allergenExceptions: { nuts: ["pesto"] } }, { ...base, allergenExceptions: { nuts: ["pesto", "pine nut"] } }), true, "grew");
  assert.equal(await q({ ...base, allergenExceptions: { nuts: ["pesto", "pine nut"] } }, base), false, "removed");
  assert.equal(await q(base, base), false, "same");
  assert.equal(await q(base, { ...base, avoidIngredients: [] }), true, "fix1 rules still hold");
  await db.close();
});
