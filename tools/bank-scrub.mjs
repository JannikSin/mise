#!/usr/bin/env node
// BANK SCRUB (Mise 2.0, plan section 6 step 1 and decision 3; P12 bank).
// The shared recipe bank must name no one: on Supabase every account reads
// it, and the migration refuses to run while any bank recipe carries a
// person's name (the whole-word guard, plan section 4.2 guard_hit).
//
// This tool finds those names in a LOCAL mise-data clone and proposes edits.
// It is public code, so it knows no names: they are read AT RUN TIME from
// that clone's own roster (profiles.json: each profile's name, its id, its
// family) and its profiles/ folders. The admin's own profile is left out by
// default (admin: true), as is any slug passed with --exclude.
//
//   node tools/bank-scrub.mjs <mise-data dir> --out <dir outside this repo> [--exclude <slug>]... [--apply]
//
// - DRY RUN BY DEFAULT: writes a private report (report.md, hits.json) and
//   the proposed recipe files (proposed/<path>) into --out. Nothing in the
//   data clone changes.
// - --apply copies the proposed files over the clone's recipes, after you
//   have read the report. Committing and pushing the clone stays yours.
// - stdout is COUNTS ONLY: never a name, a term, a recipe title or a path
//   inside the clone. The report in --out is the only place names appear,
//   and --out must be outside this repository.
//
// Matching is the database's own rule: case-insensitive, whole word, where
// a word boundary is anything but a-z and 0-9. So "cardamom" never matches a
// person called "Carda", and the count of substring-only near misses is
// reported so the difference is visible.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BANK_DIRS = ["recipes", "recipes-staging"];
/** a term the guard can hold: plan section 4.2 guard_terms check */
const TERM_RE = /^[a-z0-9-]{2,40}$/;

/**
 * The terms to look for, from the clone's own roster. Each profile gives its
 * id, every word of its name (3 letters or more, so initials do not match
 * everything), and its family slug.
 * @param {{ profiles?: any[] } | null} roster profiles.json
 * @param {string[]} profileDirs folder names under profiles/
 * @param {{ exclude?: string[] }} [o]
 * @returns {string[]} lowercased, unique, sorted
 */
export function buildTerms(roster, profileDirs, o = {}) {
  const exclude = new Set((o.exclude ?? []).map((s) => s.toLowerCase()));
  const list = Array.isArray(roster?.profiles) ? roster.profiles : [];
  const skipped = new Set(
    list
      .filter((p) => p?.admin === true || exclude.has(String(p?.id ?? "").toLowerCase()))
      .map((p) => String(p.id).toLowerCase()),
  );
  for (const s of exclude) skipped.add(s);
  /** @type {Set<string>} */
  const terms = new Set();
  const add = (/** @type {unknown} */ t) => {
    const v = String(t ?? "")
      .toLowerCase()
      .trim();
    if (TERM_RE.test(v) && v.length >= 3) terms.add(v);
  };
  /** words of the skipped profiles, so the admin's own name is never a term */
  const keep = new Set();
  for (const p of list) {
    if (!skipped.has(String(p?.id ?? "").toLowerCase())) continue;
    keep.add(String(p.id).toLowerCase());
    for (const w of String(p?.name ?? "")
      .toLowerCase()
      .split(/[^a-z0-9-]+/))
      if (w) keep.add(w);
  }
  for (const p of list) {
    const id = String(p?.id ?? "").toLowerCase();
    if (skipped.has(id)) continue;
    add(id);
    for (const w of String(p?.name ?? "")
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .split(/[^A-Za-z0-9-]+/))
      add(w);
    if (p?.family) add(p.family);
  }
  for (const d of profileDirs) if (!skipped.has(d.toLowerCase())) add(d);
  for (const k of keep) terms.delete(k);
  return [...terms].sort();
}

/** @param {string} term */
const wordRe = (term) =>
  new RegExp(`(^|[^a-z0-9])${term.replace(/[-]/g, "\\-")}(?=[^a-z0-9]|$)`, "i");

/**
 * Does this text carry the term as a whole word (the database's rule)?
 * @param {string} text
 * @param {string} term
 */
export function hasWord(text, term) {
  return wordRe(term).test(String(text).toLowerCase());
}

/**
 * Rewrite one string so it names no one: a possessive ("X's ") and a
 * dedication ("for X", "from X", "by X") are dropped, any other mention
 * becomes "a friend".
 * @param {string} s
 * @param {string[]} terms
 */
export function scrubString(s, terms) {
  let out = s;
  for (const t of terms) {
    const w = t.replace(/[-]/g, "\\-");
    out = out
      .replace(new RegExp(`(^|[^A-Za-z0-9])${w}['’]s\\s+`, "gi"), "$1")
      .replace(new RegExp(`\\s*\\b(?:for|from|by|with)\\s+${w}(?=[^A-Za-z0-9]|$)`, "gi"), "")
      .replace(new RegExp(`(^|[^A-Za-z0-9])${w}(?=[^A-Za-z0-9]|$)`, "gi"), "$1a friend");
  }
  out = out
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;:!?)])/g, "$1")
    .trim();
  if (out !== s && /^[a-z]/.test(out) && /^[A-Z]/.test(s))
    out = out[0].toUpperCase() + out.slice(1);
  return out;
}

/**
 * Walk a recipe, scrub every string, drop a name-carrying tag. Returns the
 * proposed recipe and what changed; `manual` lists what a tool must not
 * rename (the id: plans point at it).
 * @param {Record<string, any>} recipe
 * @param {string[]} terms
 */
export function proposeEdit(recipe, terms) {
  /** @type {{ at: string, before: string, after: string | null }[]} */
  const changes = [];
  /** @type {string[]} */
  const manual = [];
  const hit = (/** @type {string} */ s) => terms.filter((t) => hasWord(s, t));
  /**
   * @param {any} v
   * @param {string} at
   * @returns {any}
   */
  const walk = (v, at) => {
    if (typeof v === "string") {
      if (hit(v).length === 0) return v;
      if (at === "id") {
        manual.push("id");
        return v;
      }
      const after = scrubString(v, terms);
      changes.push({ at, before: v, after });
      return after;
    }
    if (Array.isArray(v)) {
      const keepTags = at.endsWith("tags");
      /** @type {any[]} */
      const out = [];
      v.forEach((x, i) => {
        if (keepTags && typeof x === "string" && hit(x).length > 0) {
          changes.push({ at: `${at}[${i}]`, before: x, after: null });
          return;
        }
        out.push(walk(x, `${at}[${i}]`));
      });
      return out;
    }
    if (v && typeof v === "object") {
      /** @type {Record<string, any>} */
      const out = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x, at ? `${at}.${k}` : k);
      return out;
    }
    return v;
  };
  const proposed = walk(recipe, "");
  return { proposed, changes, manual };
}

/**
 * Scan a bank. Pure over its inputs so the tests feed it synthetic files.
 * @param {{ path: string, data: any }[]} files bank files (path relative to the clone)
 * @param {string[]} terms
 */
export function scanBank(files, terms) {
  let hits = 0;
  let nearMisses = 0;
  /** @type {{ path: string, terms: string[], changes: any[], manual: string[], proposed: any }[]} */
  const flagged = [];
  for (const f of files) {
    const text = JSON.stringify(f.data).toLowerCase();
    const found = terms.filter((t) => hasWord(text, t));
    nearMisses += terms.filter((t) => !found.includes(t) && text.includes(t)).length;
    for (const t of found) {
      const g = new RegExp(`(^|[^a-z0-9])${t.replace(/[-]/g, "\\-")}(?=[^a-z0-9]|$)`, "g");
      hits += (text.match(g) ?? []).length;
    }
    const fileHit = found.length > 0 || terms.some((t) => hasWord(f.path.toLowerCase(), t));
    if (!fileHit) continue;
    const e = proposeEdit(f.data, terms);
    if (terms.some((t) => hasWord(f.path.toLowerCase(), t)) && !e.manual.includes("file name"))
      e.manual.push("file name");
    flagged.push({ path: f.path, terms: found, ...e });
  }
  // after the proposal, does anything but the id still name someone?
  const residual = flagged.filter((x) =>
    terms.some((t) => hasWord(JSON.stringify({ ...x.proposed, id: "" }), t)),
  ).length;
  return { scanned: files.length, hits, nearMisses, flagged, residual };
}

/** @param {string} dir */
function readBank(dir) {
  /** @type {{ path: string, data: any }[]} */
  const out = [];
  for (const b of BANK_DIRS) {
    const d = join(dir, b);
    if (!existsSync(d)) continue;
    for (const name of readdirSync(d)
      .filter((n) => n.endsWith(".json"))
      .sort()) {
      try {
        out.push({ path: `${b}/${name}`, data: JSON.parse(readFileSync(join(d, name), "utf8")) });
      } catch {
        // an unreadable file is the data repo's problem, not a name; skipped
      }
    }
  }
  return out;
}

/** @param {string} p @param {string} root */
const inside = (p, root) => {
  const r = relative(root, p);
  return r === "" || (!r.startsWith("..") && !r.startsWith(sep) && !/^[A-Za-z]:/.test(r));
};

/**
 * @param {string[]} argv
 * @param {{ log?: (s: string) => void, repoRoot?: string }} [io]
 * @returns {number} exit code
 */
export function main(argv, io = {}) {
  const log = io.log ?? ((s) => console.log(s));
  const repoRoot = io.repoRoot ?? REPO_ROOT;
  /** @type {string[]} */
  const exclude = [];
  let out = "";
  let apply = false;
  /** @type {string[]} */
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") out = argv[++i] ?? "";
    else if (a === "--exclude") exclude.push(argv[++i] ?? "");
    else if (a === "--apply") apply = true;
    else rest.push(String(a));
  }
  const dataDir = rest[0] ? resolve(rest[0]) : "";
  if (!dataDir || !out) {
    log(
      "usage: node tools/bank-scrub.mjs <mise-data dir> --out <dir outside this repo> [--exclude <slug>]... [--apply]",
    );
    return 2;
  }
  const outDir = resolve(out);
  if (!existsSync(join(dataDir, "profiles.json")) || !statSync(dataDir).isDirectory()) {
    log("refused: that folder has no profiles.json, so it is not a mise-data clone");
    return 2;
  }
  if (inside(outDir, repoRoot) || inside(dataDir, repoRoot)) {
    log("refused: the report and the data must both live outside this public repository");
    return 2;
  }
  const roster = JSON.parse(readFileSync(join(dataDir, "profiles.json"), "utf8"));
  const profileDirs = existsSync(join(dataDir, "profiles"))
    ? readdirSync(join(dataDir, "profiles")).filter((n) =>
        statSync(join(dataDir, "profiles", n)).isDirectory(),
      )
    : [];
  const terms = buildTerms(roster, profileDirs, { exclude });
  const files = readBank(dataDir);
  const r = scanBank(files, terms);

  mkdirSync(join(outDir, "proposed"), { recursive: true });
  const lines = [
    "# Bank scrub report (PRIVATE: names people; never commit or share)",
    "",
    `Clone: ${dataDir}`,
    `Terms: ${terms.length} (${terms.join(", ")})`,
    `Scanned ${r.scanned} bank files; ${r.hits} whole-word hits in ${r.flagged.length} files; ${r.nearMisses} substring-only near misses (not names).`,
    "",
  ];
  for (const f of r.flagged) {
    lines.push(`## ${f.path}`, "", `Names: ${f.terms.join(", ") || "(file name only)"}`);
    if (f.manual.length)
      lines.push(
        `Needs a hand rename: ${f.manual.join(", ")} (plans point at the id; rename it with the app, not here)`,
      );
    for (const c of f.changes) {
      lines.push(
        `- \`${c.at}\`: ${JSON.stringify(c.before)} -> ${c.after === null ? "(tag removed)" : JSON.stringify(c.after)}`,
      );
    }
    lines.push("");
    const dest = join(outDir, "proposed", f.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, `${JSON.stringify(f.proposed, null, 2)}\n`);
  }
  writeFileSync(join(outDir, "report.md"), `${lines.join("\n")}\n`);
  writeFileSync(
    join(outDir, "hits.json"),
    `${JSON.stringify({ terms, flagged: r.flagged.map(({ proposed: _p, ...x }) => x) }, null, 2)}\n`,
  );

  let applied = 0;
  if (apply) {
    for (const f of r.flagged) {
      if (f.changes.length === 0) continue;
      writeFileSync(join(dataDir, f.path), `${JSON.stringify(f.proposed, null, 2)}\n`);
      applied++;
    }
  }
  const manual = r.flagged.filter((f) => f.manual.length > 0).length;
  log(
    `bank-scrub: ${r.scanned} bank files scanned, ${terms.length} terms, ${r.hits} whole-word hits in ${r.flagged.length} files, ${r.nearMisses} substring-only near misses, ${r.flagged.reduce((n, f) => n + f.changes.length, 0)} proposed edits, ${manual} files need a hand rename, ${r.residual} files still name someone after the proposal`,
  );
  log(
    apply
      ? `applied: ${applied} files rewritten in the clone (review with git diff, then commit)`
      : "dry run: nothing in the clone changed; read report.md in the --out folder",
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
