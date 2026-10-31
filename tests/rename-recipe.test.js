// gate20 Realist R1: the one bank id that names someone is renamed with every
// exact pointer, and nothing that merely contains it.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renameIn, main } from "../tools/rename-recipe.mjs";

const put = (/** @type {string} */ root, /** @type {string} */ p, /** @type {unknown} */ v) => {
  mkdirSync(join(root, p, ".."), { recursive: true });
  writeFileSync(join(root, p), JSON.stringify(v, null, 2) + "\n");
};
const get = (/** @type {string} */ root, /** @type {string} */ p) => JSON.parse(readFileSync(join(root, p), "utf8"));

test("renameIn: exact strings and keys only", () => {
  const r = renameIn({ recipeId: "quill-pie", recipes: ["quill-pie", "quill-pie-2", "a quill-pie note"], byRecipe: { "quill-pie": 1 }, tags: ["quill-pie"] }, "quill-pie", "pie");
  assert.deepEqual(r.value, { recipeId: "pie", recipes: ["pie", "quill-pie-2", "a quill-pie note"], byRecipe: { pie: 1 }, tags: ["quill-pie"] });
  assert.equal(r.n, 3);
  assert.equal(r.other, 1, "a tag is not a recipe pointer");
});

test("the CLI renames the file, its id and every pointer; the dry run changes nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "rename-recipe-"));
  put(root, "profiles.json", { profiles: [{ id: "owner-1" }] });
  put(root, "recipes/quill-pie.json", { id: "quill-pie", name: "Pie" });
  put(root, "recipes/quill-pie-2.json", { id: "quill-pie-2", name: "Pie 2" });
  put(root, "plans/2026-W44.json", { entries: [{ recipeId: "quill-pie" }, { recipeId: "quill-pie-2" }] });
  put(root, "households/house-w/events.json", { tables: [{ recipeId: "quill-pie" }], rule: { slotRecipes: { dinner: ["quill-pie"] } } });
  /** @type {string[]} */
  const lines = [];
  const io = { log: (/** @type {string} */ s) => lines.push(s), repoRoot: "/nonexistent-repo" };
  assert.equal(main([root, "--from", "quill-pie", "--to", "pie"], io), 0);
  assert.ok(existsSync(join(root, "recipes/quill-pie.json")), "dry run");
  assert.match(lines.join("\n"), /3 file\(s\), 4 recipe pointer\(s\) would change, 1 recipe file\(s\) would be renamed/);
  assert.ok(!lines.join("\n").includes("Pie"), "counts only");
  assert.equal(main([root, "--from", "quill-pie", "--to", "pie", "--apply"], io), 0);
  assert.equal(existsSync(join(root, "recipes/quill-pie.json")), false);
  assert.equal(get(root, "recipes/pie.json").id, "pie");
  assert.equal(get(root, "recipes/quill-pie-2.json").id, "quill-pie-2", "a longer id is left alone");
  assert.deepEqual(get(root, "plans/2026-W44.json").entries.map((/** @type {any} */ e) => e.recipeId), ["pie", "quill-pie-2"]);
  assert.deepEqual(get(root, "households/house-w/events.json").rule.slotRecipes.dinner, ["pie"]);
  assert.equal(main([root, "--from", "quill-pie-2", "--to", "pie"], io), 2, "refuses a taken id");
  assert.equal(main([root, "--from", "Bad Id", "--to", "pie"], io), 2);
});

test("a match outside recipe fields (an avoid list) is refused until --everywhere; shadow copies are renamed", () => {
  const root = mkdtempSync(join(tmpdir(), "rename-recipe2-"));
  put(root, "profiles.json", { profiles: [{ id: "owner-1" }] });
  put(root, "recipes/pesto.json", { id: "pesto", name: "Pesto" });
  put(root, "profiles/mate-1/recipes/pesto.json", { id: "pesto", name: "Pesto, mine" });
  put(root, "profiles/mate-1/profile/targets.json", { avoidIngredients: ["pesto"], avoidRecipes: ["pesto"] });
  /** @type {string[]} */
  const lines = [];
  const io = { log: (/** @type {string} */ s) => lines.push(s), repoRoot: "/nonexistent-repo" };
  assert.equal(main([root, "--from", "pesto", "--to", "basil-sauce", "--apply"], io), 2, "refused");
  assert.ok(existsSync(join(root, "recipes/pesto.json")), "nothing renamed on a refusal");
  assert.deepEqual(get(root, "profiles/mate-1/profile/targets.json").avoidIngredients, ["pesto"]);
  assert.equal(main([root, "--from", "pesto", "--to", "basil-sauce", "--apply", "--everywhere"], io), 0);
  assert.ok(existsSync(join(root, "profiles/mate-1/recipes/basil-sauce.json")), "the shadow copy follows");
  assert.equal(existsSync(join(root, "profiles/mate-1/recipes/pesto.json")), false);
});
