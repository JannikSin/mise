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
//   node tools/bank-scrub.mjs <mise-data dir> --out <dir outside this repo> [--people <people.local.json>] [--exclude <slug>]... [--apply]
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
// MATCHING IS THE GUARD'S OWN (fix loop 1, Red Team R2, Engineer F2, F17,
// F18): tools/name-guard.mjs, the one module the migration gate and the
// database's private.guard_hit twin share. It reads decoded strings (a name
// after a newline is found), folds accents and lookalikes (a name written
// with a diaeresis matches its plain spelling), and matches whole words with
// plurals. "Still names someone" below is that guard's own answer with the
// migration's exact call, so 0 here means the migration's scrub gate passes.
// With --people <people.local.json> the terms also include the migration's
// list (every guard term, every non-admin person's extra names).
//
// WHAT IT MAY EDIT. Only free text that names a dish or tells its story:
// `name`, `notes`, `description` (top level) and `instructions[].text`. A hit
// anywhere else (ingredients, allergens, tags, nutrition, the id, the file
// name, any other field) is listed for a hand review and never touched, so
// the allergy screen keeps every food word. A hit is also review-only, in any
// field, when the word is a food word (a person called Ginger or Sage), when
// it is 2 letters, or when the guard still sees a name the tool cannot place.
// In instructions a dedication ("with X") is never dropped, only replaced, so
// a cooking step keeps its sense.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep, parse as parsePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fold, guardHits, termWords, TermError } from "./name-guard.mjs";
import { knownFoods } from "../app/lib/ingredients.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BANK_DIRS = ["recipes", "recipes-staging"];
/** the only top-level fields the tool rewrites (plus instructions[].text) */
const AUTO_TOP = new Set(["name", "notes", "description"]);
/** food words that are also given names; the ingredient table adds the rest */
const EXTRA_FOOD_WORDS = [
  "sage", "rose", "clementine", "rosemary", "saffron", "jasmine", "candy",
  "kale", "bean", "cinnamon", "nutmeg", "pepper", "olive", "ginger", "basil",
  "honey", "cherry", "berry", "juniper", "poppy", "plum", "peach", "fig",
  "mint", "thyme", "barley", "rye", "maple", "hazel", "acorn", "date",
];

/** every word of every food the app knows, folded; a name in it is review-only */
export const FOOD_WORDS = new Set(
  [...knownFoods().flatMap((f) => fold(f).split(/[^a-z]+/)), ...EXTRA_FOOD_WORDS].filter(
    (w) => w.length >= 2,
  ),
);

/**
 * The words to look for, from the clone's roster (and, with `people`, the
 * migration's people.local.json: every guard term and every non-admin
 * person's extra names). Raw names go through name-guard's termWords, so a
 * term is folded and split exactly as the guard does it. A word shared with
 * the admin (a family surname) STAYS a term: the migration's gate refuses it
 * too. A name that cannot be folded to a to z is listed by FIELD in
 * `unusable`, never by value.
 * @param {{ profiles?: any[] } | null} roster profiles.json
 * @param {string[]} profileDirs folder names under profiles/
 * @param {{ exclude?: string[], people?: any }} [o]
 * @returns {{ words: string[], unusable: string[] }}
 */
export function buildTermSet(roster, profileDirs, o = {}) {
  const exclude = new Set((o.exclude ?? []).map((s) => s.toLowerCase()));
  const list = Array.isArray(roster?.profiles) ? roster.profiles : [];
  const skipped = new Set(
    list
      .filter((p) => p?.admin === true || exclude.has(String(p?.id ?? "").toLowerCase()))
      .map((p) => String(p.id).toLowerCase()),
  );
  for (const s of exclude) skipped.add(s);
  /** @type {Set<string>} */
  const words = new Set();
  /** @type {string[]} */
  const unusable = [];
  /** @param {unknown} raw @param {string} field */
  const add = (raw, field) => {
    if (raw == null || String(raw).trim() === "") return;
    try {
      for (const w of termWords(String(raw))) words.add(w);
    } catch (e) {
      if (e instanceof TermError) unusable.push(field);
      else throw e;
    }
  };
  // a slug is a name with digits and hyphens: its letter runs are the words
  const slugText = (/** @type {string} */ s) => s.replace(/[0-9_]+/g, " ");
  list.forEach((p, i) => {
    const id = String(p?.id ?? "").toLowerCase();
    if (skipped.has(id)) return;
    add(slugText(id), `profiles.json profiles[${i}].id`);
    add(p?.name, `profiles.json profiles[${i}].name`);
    add(p?.family, `profiles.json profiles[${i}].family`);
  });
  profileDirs.forEach((d, i) => {
    if (!skipped.has(d.toLowerCase())) add(slugText(d), `profiles/ folder ${i + 1}`);
  });
  const people = o.people;
  if (people) {
    /** @type {any[]} */ (people.guardTerms ?? []).forEach((g, i) =>
      add(g?.term, `people guardTerms[${i}].term`),
    );
    /** @type {any[]} */ (people.people ?? []).forEach((p, i) => {
      if (p?.slug === people.admin) return;
      /** @type {unknown[]} */ (p?.names ?? []).forEach((n, j) =>
        add(n, `people people[${i}].names[${j}]`),
      );
    });
  }
  return { words: [...words].sort(), unusable };
}

/**
 * The term words only.
 * @param {{ profiles?: any[] } | null} roster
 * @param {string[]} profileDirs
 * @param {{ exclude?: string[], people?: any }} [o]
 */
export function buildTerms(roster, profileDirs, o = {}) {
  return buildTermSet(roster, profileDirs, o).words;
}

// one word of text: letters, marks, digits and the invisible characters the
// guard's fold drops (so a zero-width space cannot split a name in two)
const TOKEN = /[\p{L}\p{M}\p{N}\u00ad\u200b-\u200f\u2060-\u2064\ufeff]+/gu;

/** @param {string} tok @param {string[]} terms @returns {string | null} the term it is */
function tokenTerm(tok, terms) {
  const f = fold(tok);
  for (const t of terms) if (new RegExp(`^${t}(s|es)?[0-9]*$`).test(f)) return t;
  return null;
}

/**
 * Does this text carry the term as a whole word (the guard's rule)?
 * @param {string} text
 * @param {string} term a raw name or word
 */
export function hasWord(text, term) {
  try {
    return guardHits(String(text), [term]) > 0;
  } catch (e) {
    if (e instanceof TermError) return false;
    throw e;
  }
}

/**
 * The term words found in one string, one entry per hit.
 * @param {string} s @param {string[]} terms
 */
export function wordsIn(s, terms) {
  /** @type {string[]} */
  const out = [];
  for (const m of String(s).matchAll(TOKEN)) {
    const t = tokenTerm(m[0], terms);
    if (t) out.push(t);
  }
  return out;
}

/**
 * Rewrite one string so it names no one: a possessive ("X's ") and, outside
 * instructions, a dedication ("for X", "from X", "by X", "with X") are
 * dropped; any other mention becomes "a friend". Matching is token by token on
 * the folded text, so an accented spelling is found in place.
 * @param {string} s
 * @param {string[]} terms term words
 * @param {{ keepDedication?: boolean }} [o]
 */
export function scrubString(s, terms, o = {}) {
  /** @type {{ start: number, end: number }[]} */
  const hits = [];
  for (const m of String(s).matchAll(TOKEN)) {
    const start = /** @type {number} */ (m.index);
    if (tokenTerm(m[0], terms)) hits.push({ start, end: start + m[0].length });
  }
  if (hits.length === 0) return s;
  let out = "";
  let at = 0;
  for (const h of hits) {
    const before = s.slice(at, h.start);
    let end = h.end;
    const poss = /^['\u2019]s(\s+|$)/i.exec(s.slice(end));
    const ded = o.keepDedication ? null : /(^|\s)(for|from|by|with)\s+$/i.exec(before);
    if (poss) {
      end += poss[0].length;
      out += before;
    } else if (ded) {
      out += before.slice(0, ded.index);
    } else {
      out += `${before}a friend`;
    }
    at = end;
  }
  out += s.slice(at);
  out = out
    .replace(/a friend(\s+a friend)+/g, "a friend")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;:!?)])/g, "$1")
    .trim();
  if (out !== s && /^[a-z]/.test(out) && /^[A-Z]/.test(s))
    out = out[0].toUpperCase() + out.slice(1);
  return out;
}

/** @param {string} word @returns {string | null} why the tool may not edit it */
function reviewReason(word) {
  if (FOOD_WORDS.has(word)) return "food word";
  if (word.length < 3) return "short name";
  return null;
}

/**
 * Propose an edit for one recipe. Only `name`, `notes`, `description` and
 * `instructions[].text` are ever rewritten; every other hit is listed in
 * `review` with its field and why.
 * @param {Record<string, any>} recipe
 * @param {string[]} terms term words (buildTermSet().words)
 */
export function proposeEdit(recipe, terms) {
  /** @type {{ at: string, before: string, after: string | null }[]} */
  const changes = [];
  /** @type {{ at: string, word: string, why: string }[]} */
  const review = [];
  /** @type {string[]} */
  const manual = [];
  /** @param {string} at @returns {"free" | "steps" | null} */
  const editable = (at) => {
    if (AUTO_TOP.has(at.split(/[.[]/)[0] ?? "")) return "free";
    if (/^instructions\[\d+\]\.text$/.test(at)) return "steps";
    return null;
  };
  /**
   * @param {any} v
   * @param {string} at
   * @returns {any}
   */
  const walk = (v, at) => {
    if (typeof v === "string") {
      const found = [...new Set(wordsIn(v, terms))];
      if (found.length === 0) return v;
      if (at === "id") {
        manual.push("id");
        for (const w of found) review.push({ at, word: w, why: "the id (plans point at it)" });
        return v;
      }
      const kind = editable(at);
      const stop = found
        .map((w) => ({ w, why: kind ? reviewReason(w) : "a field the tool never edits" }))
        .filter((b) => b.why);
      if (stop.length) {
        for (const b of stop) review.push({ at, word: b.w, why: /** @type {string} */ (b.why) });
        return v;
      }
      const after = scrubString(v, terms, { keepDedication: kind === "steps" });
      changes.push({ at, before: v, after });
      return after;
    }
    if (Array.isArray(v)) {
      v.forEach((e, i) => {
        const n = v[i + 1];
        if (typeof e === "string" && typeof n === "string") {
          const joined = new Set(wordsIn(e + n, terms));
          for (const w of [...wordsIn(e, terms), ...wordsIn(n, terms)]) joined.delete(w);
          for (const w of joined)
            review.push({ at: `${at}[${i}..${i + 1}]`, word: w, why: "split across two list items" });
        }
      });
      return v.map((x, i) => walk(x, `${at}[${i}]`));
    }
    if (v && typeof v === "object") {
      /** @type {Record<string, any>} */
      const out = {};
      for (const [k, x] of Object.entries(v)) {
        const kat = at ? `${at}.${k}` : k;
        for (const w of new Set(wordsIn(k, terms)))
          review.push({ at: kat, word: w, why: "a key names someone" });
        out[k] = walk(x, kat);
      }
      return out;
    }
    return v;
  };
  const proposed = walk(recipe, "");
  return { proposed, changes, review, manual };
}

/** @param {any} d */
const idOf = (d) => (d && typeof d === "object" && typeof d.id === "string" ? d.id : null);

/**
 * Scan a bank. Pure over its inputs so the tests feed it synthetic files.
 * Counting and the residual use name-guard's guardHits with the recipe id, the
 * migration gate's exact call, so "0 still name someone" means the gate passes.
 * @param {{ path: string, data: any }[]} files bank files (path relative to the clone)
 * @param {string[]} terms term words
 */
export function scanBank(files, terms) {
  let hits = 0;
  let nearMisses = 0;
  /** @type {{ path: string, terms: string[], changes: any[], review: any[], manual: string[], proposed: any }[]} */
  const flagged = [];
  for (const f of files) {
    const per = terms.map((t) => guardHits(f.data, [t], idOf(f.data)));
    const n = per.reduce((a, b) => a + b, 0);
    hits += n;
    const plain = JSON.stringify(f.data).toLowerCase();
    nearMisses += terms.filter((t, i) => per[i] === 0 && plain.includes(t)).length;
    const nameHit = terms.length > 0 && guardHits(parsePath(f.path).name, terms) > 0;
    if (n === 0 && !nameHit) continue;
    const e = proposeEdit(f.data, terms);
    if (nameHit) {
      e.manual.push("file name");
      e.review.push({ at: "(file name)", word: "", why: "the file name names someone" });
    }
    // the guard is the judge: a name it still sees after the proposal that
    // the tool did not place goes to review, never silently passed
    const left = terms.length ? guardHits({ ...e.proposed, id: "" }, terms) : 0;
    const placed = e.review.filter((r) => r.at !== "id" && r.at !== "(file name)").length;
    if (left > 0 && placed === 0)
      e.review.push({
        at: "(whole file)",
        word: "",
        why: "the guard still sees a name the tool could not place",
      });
    flagged.push({ path: f.path, terms: terms.filter((_t, i) => per[i] > 0), ...e });
  }
  // after the proposal, does the migration's gate still refuse this file?
  const residual = flagged.filter((x) => guardHits(x.proposed, terms, idOf(x.proposed)) > 0).length;
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
 * The nearest folder at or above `p` that holds a .git (any working copy of
 * any repository), or null. The report names people, so it may never land
 * where a later `git add -A` could publish it (Red Team R3).
 * @param {string} p
 * @returns {string | null}
 */
export function gitAbove(p) {
  let d = resolve(p);
  for (;;) {
    if (existsSync(join(d, ".git"))) return d;
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

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
  let peopleFile = "";
  /** @type {string[]} */
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") out = argv[++i] ?? "";
    else if (a === "--exclude") exclude.push(argv[++i] ?? "");
    else if (a === "--apply") apply = true;
    else if (a === "--people") peopleFile = argv[++i] ?? "";
    else rest.push(String(a));
  }
  const dataDir = rest[0] ? resolve(rest[0]) : "";
  if (!dataDir || !out) {
    log(
      "usage: node tools/bank-scrub.mjs <mise-data dir> --out <dir outside this repo> [--people <people.local.json>] [--exclude <slug>]... [--apply]",
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
  if (gitAbove(outDir)) {
    log("refused: --out is inside a git working copy (a .git at or above it); pick a private folder that is in no repository");
    return 2;
  }
  const roster = JSON.parse(readFileSync(join(dataDir, "profiles.json"), "utf8"));
  const profileDirs = existsSync(join(dataDir, "profiles"))
    ? readdirSync(join(dataDir, "profiles")).filter((n) =>
        statSync(join(dataDir, "profiles", n)).isDirectory(),
      )
    : [];
  const people = peopleFile ? JSON.parse(readFileSync(resolve(peopleFile), "utf8")) : undefined;
  const { words: terms, unusable } = buildTermSet(roster, profileDirs, { exclude, people });
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
      lines.push(`- \`${c.at}\`: ${JSON.stringify(c.before)} -> ${JSON.stringify(c.after)}`);
    }
    if (f.review.length) {
      lines.push("", "Hand review (the tool did not touch these):");
      for (const v of f.review) lines.push(`- \`${v.at}\`${v.word ? ` "${v.word}"` : ""}: ${v.why}`);
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
  const manual = r.flagged.filter((f) => f.manual.length > 0 || f.review.length > 0).length;
  log(
    `bank-scrub: ${r.scanned} bank files scanned, ${terms.length} terms, ${r.hits} whole-word hits in ${r.flagged.length} files, ${r.nearMisses} substring-only near misses, ${r.flagged.reduce((n, f) => n + f.changes.length, 0)} proposed edits, ${manual} files need a hand review, ${r.residual} files still name someone after the proposal`,
  );
  if (unusable.length)
    log(
      `${unusable.length} name(s) could not be read as plain letters a to z, so they are NOT searched; write them in Latin letters: ${unusable.join("; ")}`,
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
