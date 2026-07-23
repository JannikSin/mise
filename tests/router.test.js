import test from "node:test";
import assert from "node:assert/strict";
import { parseRoute } from "../app/lib/router.js";

test("empty and #/ map to home", () => {
  assert.deepEqual(parseRoute(""), { view: "home" });
  assert.deepEqual(parseRoute("#/"), { view: "home" });
  assert.deepEqual(parseRoute("#"), { view: "home" });
});

test("top-level views", () => {
  assert.deepEqual(parseRoute("#/cookbook"), { view: "cookbook" });
  assert.deepEqual(parseRoute("#/today"), { view: "today" });
  assert.deepEqual(parseRoute("#/system"), { view: "system" });
  assert.deepEqual(parseRoute("#/plan"), { view: "plan" });
  assert.deepEqual(parseRoute("#/list"), { view: "list" });
  assert.deepEqual(parseRoute("#/train"), { view: "train" });
  assert.deepEqual(parseRoute("#/remedies"), { view: "remedies" });
  assert.deepEqual(parseRoute("#/menu"), { view: "menu" });
  assert.deepEqual(parseRoute("#/dinner"), { view: "dinner" });
  assert.deepEqual(parseRoute("#/tables"), { view: "tables" });
});

test("removed quiz route falls back to home", () => {
  assert.deepEqual(parseRoute("#/quiz"), { view: "home" });
});

test("recipe detail and cook mode carry the id", () => {
  assert.deepEqual(parseRoute("#/recipe/beef-bulgogi-rice-bowl"), {
    view: "recipe",
    id: "beef-bulgogi-rice-bowl",
  });
  assert.deepEqual(parseRoute("#/recipe/beef-bulgogi-rice-bowl/cook"), {
    view: "cook",
    id: "beef-bulgogi-rice-bowl",
  });
});

test("ids are URL-decoded", () => {
  assert.deepEqual(parseRoute("#/recipe/a%20b"), { view: "recipe", id: "a b" });
});

test("?from= origin is carried on recipe and cook routes, omitted when absent", () => {
  assert.deepEqual(parseRoute("#/recipe/x?from=today"), {
    view: "recipe",
    id: "x",
    from: "today",
  });
  assert.deepEqual(parseRoute("#/recipe/x/cook?from=remedies"), {
    view: "cook",
    id: "x",
    from: "remedies",
  });
  assert.deepEqual(parseRoute("#/recipe/x?from="), { view: "recipe", id: "x" });
});

test("unknown routes fall back to home", () => {
  assert.deepEqual(parseRoute("#/nope"), { view: "home" });
  assert.deepEqual(parseRoute("#/recipe"), { view: "home" });
});
