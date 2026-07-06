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
  assert.deepEqual(parseRoute("#/quiz"), { view: "quiz" });
  assert.deepEqual(parseRoute("#/system"), { view: "system" });
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

test("unknown routes fall back to home", () => {
  assert.deepEqual(parseRoute("#/nope"), { view: "home" });
  assert.deepEqual(parseRoute("#/recipe"), { view: "home" });
});
