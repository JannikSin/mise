import test from "node:test";
import assert from "node:assert/strict";
import { parseRoute } from "../app/lib/router.js";

test("#/ and #/today are PERMANENT aliases for the merged Plan tab", () => {
  // Plan absorbed Cook and Home retired (2026-07-25), but the Worker pushes
  // ntfy notifications deep-linking to #/today and the family have bookmarks.
  // These aliases are load-bearing forever, not a migration step.
  assert.deepEqual(parseRoute(""), { view: "plan" });
  assert.deepEqual(parseRoute("#/"), { view: "plan" });
  assert.deepEqual(parseRoute("#"), { view: "plan" });
  assert.deepEqual(parseRoute("#/today"), { view: "plan" });
  assert.deepEqual(parseRoute("#/home"), { view: "plan" });
});

test("top-level views", () => {
  assert.deepEqual(parseRoute("#/cookbook"), { view: "cookbook" });
  assert.deepEqual(parseRoute("#/system"), { view: "system" });
  assert.deepEqual(parseRoute("#/plan"), { view: "plan" });
  assert.deepEqual(parseRoute("#/list"), { view: "list" });
  assert.deepEqual(parseRoute("#/remedies"), { view: "remedies" });
  assert.deepEqual(parseRoute("#/menu"), { view: "menu" });
  assert.deepEqual(parseRoute("#/dinner"), { view: "dinner" });
  assert.deepEqual(parseRoute("#/tables"), { view: "tables" });
  assert.deepEqual(parseRoute("#/annotate"), { view: "annotate" });
});

test("removed routes fall back to the Plan tab", () => {
  assert.deepEqual(parseRoute("#/quiz"), { view: "plan" });
});

test("the retired fitness routes land on Plan, not on nothing", () => {
  // Train and Vitals left for anvil on 2026-08-18. A year of bookmarks, home
  // screen shortcuts and old deep links still say #/train, and a dead route
  // renders a blank tab that looks exactly like a broken app.
  assert.deepEqual(parseRoute("#/train"), { view: "plan" });
  assert.deepEqual(parseRoute("#/vitals"), { view: "plan" });
});

test("recipe detail carries the id, and old cook-mode URLs land on the recipe", () => {
  // Cook Mode removed 2026-08-19 (David: "get rid of that entirely"); the
  // /cook suffix survives in bookmarks and muscle memory, so it aliases
  assert.deepEqual(parseRoute("#/recipe/beef-bulgogi-rice-bowl"), {
    view: "recipe",
    id: "beef-bulgogi-rice-bowl",
  });
  assert.deepEqual(parseRoute("#/recipe/beef-bulgogi-rice-bowl/cook"), {
    view: "recipe",
    id: "beef-bulgogi-rice-bowl",
  });
});

test("ids are URL-decoded", () => {
  assert.deepEqual(parseRoute("#/recipe/a%20b"), { view: "recipe", id: "a b" });
});

test("?entry= plan-entry id is carried into recipe routes (old cook URLs included)", () => {
  assert.deepEqual(parseRoute("#/recipe/x/cook?from=today&servings=2&entry=abc123"), {
    view: "recipe",
    id: "x",
    from: "today",
    servings: 2,
    entry: "abc123",
  });
  assert.equal(parseRoute("#/recipe/x?from=today").entry, undefined);
});

test("?from= origin is carried on recipe and cook routes, omitted when absent", () => {
  assert.deepEqual(parseRoute("#/recipe/x?from=today"), {
    view: "recipe",
    id: "x",
    from: "today",
  });
  assert.deepEqual(parseRoute("#/recipe/x/cook?from=remedies"), {
    view: "recipe",
    id: "x",
    from: "remedies",
  });
  assert.deepEqual(parseRoute("#/recipe/x?from="), { view: "recipe", id: "x" });
});

test("unknown routes fall back to plan", () => {
  assert.deepEqual(parseRoute("#/nope"), { view: "plan" });
  assert.deepEqual(parseRoute("#/recipe"), { view: "plan" });
});
