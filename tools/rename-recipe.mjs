// RENAME A RECIPE ID (Mise 2.0, gate20 Realist R1; P12 bank). The bank scrub
// never edits an id, because plans, tables, rules and targets point at it,
// and the migration refuses while any bank recipe's id names a person. This
// renames one recipe in a mise-data clone: the file `recipes/<old>.json` (or
// `recipes-staging/`) becomes `<new>.json`, its `id` becomes <new>, and every
// JSON string value or object key anywhere in the clone that is EXACTLY <old>
// becomes <new>. Exact only: a longer id that merely contains <old> is left
// alone, and so is prose. Public code, no names: the ids are typed by David.
//
//   node tools/rename-recipe.mjs <mise-data clone> --from <old id> --to <new id>           (dry run: counts)
//   node tools/rename-recipe.mjs <mise-data clone> --from <old id> --to <new id> --apply
//
// The dry run prints how many files and pointers change, never their content.
// Run it on a branch of the clone and look at `git diff` before pushing.

import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ID = /^[a-z0-9][a-z0-9-]*$/;
const BANK_DIRS = ["recipes", "recipes-staging"];

/**
 * Every exact pointer to `from` in one JSON value, replaced by `to`.
 * @param {unknown} v
 * @param {string} from
 * @param {string} to
 * @returns {{ value: unknown, n: number }}
 */
export function renameIn(v, from, to) {
  if (typeof v === "string") return v === from ? { value: to, n: 1 } : { value: v, n: 0 };
  if (Array.isArray(v)) {
    let n = 0;
    const value = v.map((x) => {
      const r = renameIn(x, from, to);
      n += r.n;
      return r.value;
    });
    return { value, n };
  }
  if (v && typeof v === "object") {
    let n = 0;
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      const r = renameIn(x, from, to);
      n += r.n + (k === from ? 1 : 0);
      out[k === from ? to : k] = r.value;
    }
    return { value: out, n };
  }
  return { value: v, n: 0 };
}

/** @param {string} dir @returns {string[]} every .json file below dir, skipping .git */
function jsonFiles(dir) {
  /** @type {string[]} */
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...jsonFiles(p));
    else if (e.name.endsWith(".json")) out.push(p);
  }
  return out;
}

/**
 * Plan (and with apply, make) the rename in a clone.
 * @param {string} dataDir
 * @param {string} from
 * @param {string} to
 * @param {{ apply?: boolean }} [o]
 * @returns {{ bankFile: string, files: number, pointers: number, unreadable: number }}
 */
export function renameRecipe(dataDir, from, to, o = {}) {
  const bankFile = BANK_DIRS.map((d) => join(d, `${from}.json`)).find((f) => existsSync(join(dataDir, f)));
  if (!bankFile) throw new Error(`no recipe ${from} in recipes/ or recipes-staging/`);
  for (const d of BANK_DIRS)
    if (existsSync(join(dataDir, d, `${to}.json`))) throw new Error(`${to} already exists in ${d}/`);
  let files = 0;
  let pointers = 0;
  let unreadable = 0;
  for (const abs of jsonFiles(dataDir)) {
    const text = readFileSync(abs, "utf8");
    if (!text.includes(from)) continue;
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      unreadable++;
      continue;
    }
    const r = renameIn(data, from, to);
    if (r.n === 0) continue;
    files++;
    pointers += r.n;
    if (o.apply) writeFileSync(abs, JSON.stringify(r.value, null, 2) + (text.endsWith("\n") ? "\n" : ""));
  }
  if (o.apply) renameSync(join(dataDir, bankFile), join(dataDir, dirname(bankFile), `${to}.json`));
  return { bankFile, files, pointers, unreadable };
}

/**
 * @param {string[]} argv
 * @param {{ log?: (s: string) => void, repoRoot?: string }} [io]
 * @returns {number}
 */
export function main(argv, io = {}) {
  const log = io.log ?? ((s) => console.log(s));
  const repoRoot = io.repoRoot ?? REPO_ROOT;
  let from = "";
  let to = "";
  let apply = false;
  /** @type {string[]} */
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--from") from = argv[++i] ?? "";
    else if (a === "--to") to = argv[++i] ?? "";
    else if (a === "--apply") apply = true;
    else rest.push(String(a));
  }
  const dataDir = rest[0] ? resolve(rest[0]) : "";
  if (!dataDir || !from || !to) {
    log("usage: node tools/rename-recipe.mjs <mise-data clone> --from <old id> --to <new id> [--apply]");
    return 2;
  }
  if (!ID.test(from) || !ID.test(to) || from === to) {
    log("refused: both ids must be lowercase letters, digits and hyphens, and differ");
    return 2;
  }
  if (!existsSync(join(dataDir, "profiles.json")) || !statSync(dataDir).isDirectory()) {
    log("refused: that folder has no profiles.json, so it is not a mise-data clone");
    return 2;
  }
  if (!relative(repoRoot, dataDir).startsWith("..")) {
    log("refused: the data must live outside this public repository");
    return 2;
  }
  try {
    const r = renameRecipe(dataDir, from, to, { apply });
    log(
      `rename-recipe: ${r.files} file(s), ${r.pointers} pointer(s) ${apply ? "rewritten" : "would change"}; the recipe file ${apply ? "was" : "would be"} renamed${r.unreadable ? `; ${r.unreadable} unreadable JSON file(s) mention it and were left alone, look at them by hand` : ""}`,
    );
    if (!apply) log("dry run: nothing changed; add --apply, then read git diff in the clone");
    return 0;
  } catch (e) {
    log(`refused: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = main(process.argv.slice(2));
