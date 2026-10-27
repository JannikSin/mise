// Mise 2.0, plan section 5 (ENG 9): the storage seam is real only if nothing
// in the app can reach GitHub around it. Exactly one module in app/ imports
// github.js: the GitHub adapter. Everything else goes through backend.js, or
// takes the GitHub-only helpers (token, data repo) from the adapter.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

/** @param {string} dir @returns {string[]} */
function jsFiles(dir) {
  return readdirSync(root + dir).flatMap((f) => {
    const rel = `${dir}/${f}`;
    if (statSync(root + rel).isDirectory()) return jsFiles(rel);
    return f.endsWith(".js") ? [rel] : [];
  });
}

// static `from "...github.js"`, dynamic `import("...github.js")`, and a bare
// side-effect `import "...github.js"`
const IMPORTS_GITHUB = /(?:from\s*|import\s*\(\s*|import\s+)["'][^"']*\bgithub\.js["']/;

test("only app/lib/backend/github-adapter.js imports github.js", () => {
  const importers = jsFiles("app").filter((f) =>
    IMPORTS_GITHUB.test(readFileSync(root + f, "utf8")),
  );
  assert.deepEqual(importers, ["app/lib/backend/github-adapter.js"]);
});

test("the guard's pattern catches every import form (negative control)", () => {
  for (const src of [
    'import { readFile } from "./github.js";',
    "import { x } from '../lib/github.js'",
    'const m = await import("./lib/github.js");',
    'import "./github.js";',
  ]) {
    assert.ok(IMPORTS_GITHUB.test(src), src);
  }
  assert.ok(!IMPORTS_GITHUB.test('import { backend } from "./backend.js";'));
  assert.ok(!IMPORTS_GITHUB.test("// the github.js Contents API"));
});

test("store.js reaches storage only through the seam", () => {
  const src = readFileSync(root + "app/lib/store.js", "utf8");
  assert.match(src, /from "\.\/backend\.js"/);
  for (const name of ["readFile(", "writeFile(", "listDir(", "dataBranch("]) {
    assert.ok(!src.includes(name), `store.js still calls ${name}`);
  }
});
