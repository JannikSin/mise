#!/usr/bin/env node
/**
 * Mise PostToolUse hook: format -> lint -> typecheck on every Edit/Write,
 * plus a schema-drift check for data files (self-healing: feeds gaps back
 * to the session, never halts it).
 *
 * Design constraints:
 * - Must no-op fast and silently when dev tooling isn't installed yet
 *   (pre-scaffolding sessions) or when the file isn't project source.
 * - Invokes tool JS entrypoints directly with node (no npx, no shell) so
 *   behavior is identical from cmd, PowerShell, and Git Bash.
 * - Exit 0 = silent pass. Exit 2 = feedback to Claude via stderr (for
 *   PostToolUse this is non-blocking; the model fixes and moves on).
 */
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, relative, isAbsolute } from "node:path";

const projectDir = process.cwd();

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return null;
  }
}

const input = readStdin();
const filePath = input?.tool_input?.file_path;
if (!filePath) process.exit(0);

const abs = resolve(filePath);
const rel = relative(projectDir, abs).replaceAll("\\", "/");
// Outside the project, or in a path we deliberately leave alone.
if (rel.startsWith("..") || isAbsolute(rel)) process.exit(0);
const SKIP = /^(\.claude\/|mockups\/|node_modules\/|vendor\/|claude-config\/)/;
if (SKIP.test(rel)) process.exit(0);

const feedback = [];

function bin(rel_) {
  const p = resolve(projectDir, "node_modules", ...rel_.split("/"));
  return existsSync(p) ? p : null;
}

function run(entry, args) {
  const r = spawnSync(process.execPath, [entry, ...args], {
    cwd: projectDir,
    encoding: "utf8",
    timeout: 90_000,
  });
  return r;
}

const isJs = /\.(js|mjs)$/.test(rel);
const isFormattable = /\.(js|mjs|css|html|json)$/.test(rel);

// 1. Prettier --write (auto-fix, never complains)
const prettier = bin("prettier/bin/prettier.cjs");
if (prettier && isFormattable && existsSync(abs)) {
  run(prettier, ["--write", "--log-level", "warn", abs]);
}

// 2. ESLint --fix (auto-fix what it can, report the rest)
const eslint = bin("eslint/bin/eslint.js");
if (eslint && isJs && existsSync(abs)) {
  const r = run(eslint, ["--fix", "--no-warn-ignored", abs]);
  if (r.status !== 0 && (r.stdout || r.stderr)) {
    feedback.push(`ESLint issues in ${rel}:\n${(r.stdout || r.stderr).slice(0, 2000)}`);
  }
}

// 3. tsc --checkJs project-wide (JSDoc types; jsconfig.json defines scope)
const tsc = bin("typescript/bin/tsc");
if (tsc && isJs && existsSync(resolve(projectDir, "jsconfig.json"))) {
  const r = run(tsc, ["--noEmit", "-p", "jsconfig.json"]);
  if (r.status !== 0 && r.stdout) {
    feedback.push(`Type errors (tsc --checkJs):\n${r.stdout.slice(0, 3000)}`);
  }
}

// 4. Schema drift check (schema-guard-lite): data-file keys must appear in
//    docs/SCHEMAS.md. Full schema-guard agent still runs before commits.
const schemasPath = resolve(projectDir, "docs", "SCHEMAS.md");
const isDataFile = /^(seed-data|fixtures|data)\/.*\.json$/.test(rel);
if (isDataFile && existsSync(schemasPath) && existsSync(abs)) {
  try {
    const doc = readFileSync(schemasPath, "utf8");
    const keys = new Set();
    (function collect(v) {
      if (Array.isArray(v)) v.forEach(collect);
      else if (v && typeof v === "object")
        for (const k of Object.keys(v)) {
          keys.add(k);
          collect(v[k]);
        }
    })(JSON.parse(readFileSync(abs, "utf8")));
    const missing = [...keys].filter((k) => !doc.includes(k));
    if (missing.length) {
      feedback.push(
        `Schema drift: ${rel} uses field(s) not found in docs/SCHEMAS.md: ` +
          `${missing.join(", ")}. Update docs/SCHEMAS.md in this same change ` +
          `(CLAUDE.md Part 2, rule 4), or fix the field name if it's a typo. ` +
          `Run the schema-guard agent if unsure.`
      );
    }
  } catch {
    /* unparseable JSON is the linters' problem, not ours */
  }
}

if (feedback.length) {
  process.stderr.write(feedback.join("\n\n"));
  process.exit(2); // PostToolUse: non-blocking feedback to the model
}
process.exit(0);
