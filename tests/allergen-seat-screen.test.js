// The seat screen and the tree-nut review (terrigen nut list, 2026-10-27;
// P8 plates). Synthetic recipes only. Coconut is not a tree nut (FDA allergen
// guidance, January 2025), so the nuts chip leaves it alone. The seat screen
// (recipeConflicts, app/lib/plan.js, off limits to the 2.0 allergen lane until
// the 1.96 rebase) never reads optional rows or a rotating recipe's add-ins,
// so an optional almond garnish and a rotating walnut topping pass a nut
// allergy today: a todo with a named owner, the exact change in
// ~/.claude/fleet/terrigen-lane-allergen.md.
import test from "node:test";
import assert from "node:assert/strict";
import { targetsFromQuestionnaire } from "../app/lib/targets.js";
import { recipeConflicts } from "../app/lib/plan.js";

const Q = /** @type {any} */ ({ sex: "f", age: 30, heightFt: 5, heightIn: 6, weightLb: 150, activity: 2, goal: "maintain" });
/** guest-a: an ordinary nut allergy. */
const nutAllergic = targetsFromQuestionnaire(Q, "2026-10-27", { allergens: ["nuts"] });
/** @param {string[]} foods */
const rec = (...foods) => ({ id: "r", ingredients: foods.map((food) => ({ qty: 1, unit: "cup", food })) });
/** @param {any} t @param {Record<string, any>} r */
const refused = (t, r) => recipeConflicts(r, t.diet, t.avoidIngredients, t.avoidRecipes).length > 0;

test("coconut is not a tree nut (FDA, January 2025): coconut milk passes a nut allergy", () => {
  assert.equal(refused(nutAllergic, rec("coconut milk", "shredded coconut", "rice")), false);
});

test(
  "the seat screen counts optional rows and rotating add-ins",
  { todo: "OWNER terrigen: 1.96 rebase, plan.js recipeConflicts reads optional rows and rotation.keep/pool (terrigen-lane-allergen.md)" },
  () => {
    const garnish = { id: "g", ingredients: [{ food: "chicken thighs" }, { food: "slivered almonds", optional: true }] };
    const bowl = { id: "b", ingredients: [{ food: "greek yogurt" }], rotation: { perDay: 1, keep: [{ food: "greek yogurt" }], pool: [{ food: "walnuts" }, { food: "blueberries" }] } };
    assert.ok(refused(nutAllergic, garnish), "optional garnish");
    assert.ok(refused(nutAllergic, bowl), "rotating add-in");
  },
);
