#!/usr/bin/env node
// Mise 2.0 G2: the reverse export. A database snapshot back to the mise-data
// file layout, so a rollback to the GitHub build is one script (plan section
// 6, "Switch and rollback", step D).
//
//   psql "<migration connection string>" -X -At -v ON_ERROR_STOP=1 \
//        -f <(node tools/db-snapshot.mjs sql) > now.json
//   node tools/export-from-supabase.mjs --snapshot now.json --merge-into ../mise-data           (dry run)
//   node tools/export-from-supabase.mjs --snapshot now.json --merge-into ../mise-data --write   (writes files)
//   node tools/export-from-supabase.mjs --snapshot now.json --out <empty dir> --write           (a fresh tree)
//
// A decrypted nightly backup is the same snapshot format, so a rollback after
// the database is gone works from the backup.
//
// --merge-into (the rollback): the mise-data clone must hold the freeze
// marker (freeze.json, the D2 freeze), so no phone is still writing to GitHub.
// A file whose data equals its row is left byte for byte as it is. A changed
// file is rewritten the way the app writes (two-space JSON plus a newline),
// with its keys in the order the old file had them, new keys last. Files the
// migration never moved (meta.json, invites.json, guests.json, the root daily
// log, workouts, health files, READMEs, shadow duplicates, freeze.json) are
// never touched. A file the database no longer has is reported, and deleted
// only with --prune. A file that changed on GitHub after the migration while
// its row did not is a CONFLICT: the export refuses unless --prefer-database.
//
// --out (a fresh tree, no old files to copy from): intended differences from
// the original snapshot, all checked by tests/export-from-supabase.test.js:
//   1. key order inside objects is Postgres jsonb order, not the old file's;
//   2. the files the migration skipped are absent (list above);
//   3. profiles.json rows lose passkey and adminKey (never imported), and the
//      keys are id, the display fields, household, family, admin;
//   4. a house copy of root prices.json or pins.json that nobody edited is
//      folded back into the root file instead of written per house.
//
// Output is counts only unless --show-paths: a path can carry a slug.
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { docScope, BadPathError } from "../app/lib/doc-scope.js";
import { SKIP_RULES, BANK, ROOT_SHARED, DISPLAY_DROPPED, contentHash, gitBlobSha, walk } from "./migrate-to-supabase.mjs";
import { parseSnapshot, indexSnapshot } from "./db-snapshot.mjs";

export const FREEZE_MARKER = "freeze.json";

/** The app's own serialization (app/lib/github.js writeFile). @param {unknown} data */
export function serialize(data) {
  return JSON.stringify(data, null, 2) + "\n";
}

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * `value` with its object keys in `template`'s order where the template has
 * them, the rest after in their own order. Values are never changed.
 * @param {unknown} value @param {unknown} template @returns {unknown}
 */
export function orderLike(value, template) {
  if (Array.isArray(value)) return value.map((v, i) => orderLike(v, Array.isArray(template) ? template[i] : undefined));
  if (!isObj(value)) return value;
  const t = isObj(template) ? template : {};
  const keys = [...Object.keys(t).filter((k) => k in value), ...Object.keys(value).filter((k) => !(k in t))];
  return Object.fromEntries(keys.map((k) => [k, orderLike(value[k], t[k])]));
}

/**
 * Is this mise-data path one the migration moves into the database (so the
 * database is its source of truth after the switch)?
 * @param {string} p
 * @param {{ households: string[], profiles: string[], rootProfile: string }} world
 */
export function managedPath(p, world) {
  if (!p.endsWith(".json") || p === "profiles.json" || p === FREEZE_MARKER) return false;
  if (SKIP_RULES.some(([, re]) => re.test(p))) return false;
  if (BANK.test(p) || ROOT_SHARED.test(p)) return true;
  try {
    docScope(p, world);
    return true;
  } catch (e) {
    if (e instanceof BadPathError) return false;
    throw e;
  }
}

/**
 * The profiles.json the snapshot describes. With `old` (the current file),
 * rows the database did not change are kept exactly, 1.95-only keys
 * (passkey, adminKey) are carried, and key order follows the old rows.
 * @param {ReturnType<typeof indexSnapshot>} ix
 * @param {any} [old] the parsed current profiles.json
 * @returns {{ data: any, changedRows: number }}
 */
export function profilesFile(ix, old) {
  const oldRows = new Map((Array.isArray(old?.profiles) ? old.profiles : []).map((/** @type {any} */ r) => [String(r?.id), r]));
  const people = [...ix.profileById.values()]
    .filter((p) => p.kind !== "probe")
    .sort((a, b) => a.sort_order - b.sort_order || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  let changedRows = 0;
  const rows = people.map((p) => {
    const home = p.home_household ? ix.houseSlug.get(p.home_household) ?? null : null;
    const isAdmin = p.slug === ix.settings.admin_profile;
    const prev = oldRows.get(p.slug);
    if (prev) {
      // the values the migration took from this row (DISPLAY_DROPPED aside)
      const display = Object.fromEntries(Object.entries(prev).filter(([k]) => !DISPLAY_DROPPED.includes(k)));
      const same =
        contentHash(display) === contentHash(p.roster ?? {}) &&
        (prev.family ?? null) === (p.family ?? null) &&
        (prev.admin === true) === isAdmin &&
        (prev.household === undefined || prev.household === home);
      if (same) return prev;
    }
    changedRows++;
    /** @type {Record<string, unknown>} */
    const row = { id: p.slug, ...(p.roster ?? {}) };
    // an old row without a household meant "home" to 1.95; the database
    // refuses house moves (patch_roster), so an absent household stays absent
    if (home && (!prev || prev.household !== undefined)) row.household = home;
    if (p.family) row.family = p.family;
    if (isAdmin) row.admin = true;
    if (prev) for (const k of ["passkey", "adminKey"]) if (prev[k] !== undefined) row[k] = prev[k];
    return prev ? orderLike(row, prev) : row;
  });
  return { data: old && isObj(old) ? { ...old, profiles: rows } : { profiles: rows }, changedRows };
}

/**
 * Every file the snapshot holds, as path -> { data, rev, legacySha }.
 * @param {import("./db-snapshot.mjs").Snapshot} snap
 */
export function filesFromSnapshot(snap) {
  const ix = indexSnapshot(snap);
  /** @type {Map<string, { data: unknown, rev: number | null, legacySha: string | null }>} */
  const files = new Map();
  for (const r of ix.recipes) {
    files.set(`${r.staging ? "recipes-staging" : "recipes"}/${r.id}.json`, { data: r.data, rev: Number(r.rev), legacySha: r.legacy_sha ?? null });
  }
  /** @type {string[]} */
  const copies = JSON.parse(ix.settings.root_copies ?? "[]");
  const root = [...ix.profileById.values()].find((p) => p.slug === ix.settings.root_profile);
  const rootHome = root?.home_household ? ix.houseSlug.get(root.home_household) : undefined;
  /** @type {Map<string, any[]>} root file name -> the house rows of that kind */
  const shared = new Map();
  for (const d of ix.docs) {
    const m = /^households\/([^/]+)\/(prices|pins)\.json$/.exec(d.path);
    if (m) {
      const list = shared.get(`${m[2]}.json`) ?? [];
      list.push({ ...d, house: m[1], isCopy: copies.includes(d.path) });
      shared.set(`${m[2]}.json`, list);
      continue;
    }
    files.set(d.path, { data: d.data, rev: Number(d.rev), legacySha: d.legacy_sha ?? null });
  }
  for (const [rootFile, rows] of shared) {
    // the root file comes back from the root profile's home house when that
    // row was a copy of it; else from any copy; else from the home house
    const pick =
      rows.find((r) => r.house === rootHome && r.isCopy) ?? rows.find((r) => r.isCopy) ?? rows.find((r) => r.house === rootHome);
    if (pick) files.set(rootFile, { data: pick.data, rev: Number(pick.rev), legacySha: pick.isCopy ? pick.legacy_sha : null });
    for (const r of rows) {
      // an untouched copy, or the copy that became the root file, is not a house file
      if (r.isCopy && (Number(r.rev) === 1 || r === pick)) continue;
      files.set(r.path, { data: r.data, rev: Number(r.rev), legacySha: r.isCopy ? null : r.legacy_sha ?? null });
    }
  }
  const world = {
    households: [...ix.houseSlug.values()],
    profiles: [...ix.profileById.values()].map((p) => String(p.slug)),
    rootProfile: String(ix.settings.root_profile ?? ""),
  };
  return { ix, files, world };
}

/**
 * @typedef {{ write: string[], create: string[], unchanged: string[], removed: string[], conflicts: string[], profilesChanged: boolean }} ExportReport
 */

/**
 * Compare a snapshot against a mise-data tree and, with `write`, bring the
 * tree in line. Never touches a file the migration does not manage.
 * @param {import("./db-snapshot.mjs").Snapshot} snap
 * @param {string} dir the mise-data clone (or an empty directory for --out)
 * @param {{ write?: boolean, prune?: boolean, preferDatabase?: boolean, requireFreeze?: boolean }} [opts]
 * @returns {ExportReport}
 */
export function exportInto(snap, dir, opts = {}) {
  const { ix, files, world } = filesFromSnapshot(snap);
  const existing = existsSync(dir) ? walk(dir) : [];
  if (opts.requireFreeze && !existing.includes(FREEZE_MARKER)) {
    throw new Error(`refused: ${FREEZE_MARKER} is not in the target, so phones may still be writing to GitHub (freeze first)`);
  }
  const have = new Set(existing);
  /** @type {ExportReport} */
  const rep = { write: [], create: [], unchanged: [], removed: [], conflicts: [], profilesChanged: false };
  /** @type {Map<string, string>} */
  const out = new Map();
  const readBytes = (/** @type {string} */ p) => readFileSync(path.join(dir, ...p.split("/")));
  /** @param {Buffer} b */
  const parse = (b) => {
    try {
      return { ok: true, v: JSON.parse(b.toString("utf8")) };
    } catch {
      return { ok: false, v: undefined };
    }
  };

  for (const [p, f] of files) {
    if (!have.has(p)) {
      rep.create.push(p);
      out.set(p, serialize(f.data));
      continue;
    }
    const bytes = readBytes(p);
    const old = parse(bytes);
    if (old.ok && contentHash(old.v) === contentHash(f.data)) {
      rep.unchanged.push(p);
      continue;
    }
    // the row is as migrated, but the file moved on GitHub since
    if (f.rev === 1 && f.legacySha && gitBlobSha(bytes) !== f.legacySha) rep.conflicts.push(p);
    rep.write.push(p);
    out.set(p, serialize(old.ok ? orderLike(f.data, old.v) : f.data));
  }

  // profiles.json
  const oldProfiles = have.has("profiles.json") ? parse(readBytes("profiles.json")) : { ok: false, v: undefined };
  const prof = profilesFile(ix, oldProfiles.ok ? oldProfiles.v : undefined);
  if (!oldProfiles.ok) {
    rep.create.push("profiles.json");
    out.set("profiles.json", serialize(prof.data));
    rep.profilesChanged = true;
  } else if (contentHash(prof.data) !== contentHash(oldProfiles.v)) {
    rep.write.push("profiles.json");
    out.set("profiles.json", serialize(prof.data));
    rep.profilesChanged = true;
  } else rep.unchanged.push("profiles.json");

  // managed files the database no longer has; a shadow duplicate (an own
  // recipe equal to the bank copy) was never migrated and is not "removed"
  const bank = new Map(ix.recipes.filter((r) => !r.staging).map((r) => [String(r.id), r.data]));
  for (const p of existing) {
    if (files.has(p) || !managedPath(p, world)) continue;
    const own = /^profiles\/[^/]+\/recipes\/([a-z0-9][a-z0-9-]*)\.json$/.exec(p);
    if (own) {
      const o = parse(readBytes(p));
      const twin = bank.get(String(own[1]));
      if (o.ok && twin !== undefined && contentHash(twin) === contentHash(o.v)) continue;
    }
    rep.removed.push(p);
  }

  if (rep.conflicts.length && !opts.preferDatabase) {
    const e = new Error(`refused: ${rep.conflicts.length} file(s) changed on GitHub after the migration while the database kept them as migrated (--prefer-database overrides)`);
    /** @type {any} */ (e).paths = rep.conflicts;
    throw e;
  }
  if (opts.write) {
    for (const [p, text] of out) {
      const full = path.join(dir, ...p.split("/"));
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, text);
    }
    if (opts.prune) for (const p of rep.removed) rmSync(path.join(dir, ...p.split("/")));
  }
  return rep;
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = String(argv[i]);
    if (!k.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      a[k.slice(2)] = next;
      i++;
    } else a[k.slice(2)] = true;
  }
  return a;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  const target = typeof a["merge-into"] === "string" ? a["merge-into"] : typeof a.out === "string" ? a.out : null;
  if (typeof a.snapshot !== "string" || !target) {
    console.log("usage: node tools/export-from-supabase.mjs --snapshot <snapshot.json> (--merge-into <mise-data> | --out <empty dir>) [--write] [--prune] [--prefer-database] [--show-paths]");
    process.exit(2);
  }
  if (typeof a.out === "string" && existsSync(a.out) && readdirSync(a.out).length) {
    console.error("refused: --out must be a new or empty directory (use --merge-into for a clone)");
    process.exit(1);
  }
  const snap = parseSnapshot(readFileSync(a.snapshot, "utf8"));
  /** @type {ExportReport} */
  let rep;
  try {
    rep = exportInto(snap, target, {
      write: a.write === true,
      prune: a.prune === true,
      preferDatabase: a["prefer-database"] === true,
      requireFreeze: typeof a["merge-into"] === "string",
    });
  } catch (e) {
    console.error(String(/** @type {any} */ (e).message));
    if (a["show-paths"]) for (const p of /** @type {any} */ (e).paths ?? []) console.error(`  ${p}`);
    process.exit(1);
  }
  const verb = a.write ? "" : "would ";
  console.log(`${verb}write ${rep.write.length} changed file(s), ${verb}create ${rep.create.length}, ${rep.unchanged.length} unchanged`);
  console.log(`${rep.removed.length} file(s) the database no longer has${rep.removed.length ? (a.prune ? (a.write ? ", deleted" : ", would delete") : ", kept (--prune deletes)") : ""}`);
  if (rep.conflicts.length) console.log(`${rep.conflicts.length} GitHub-side change(s) overwritten by --prefer-database`);
  if (a["show-paths"]) {
    for (const [k, list] of /** @type {[string, string[]][]} */ ([["write", rep.write], ["create", rep.create], ["removed", rep.removed]])) for (const p of list) console.log(`  ${k} ${p}`);
  }
  if (!a.write) console.log("dry run: add --write to write");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main();
  } catch (e) {
    console.error(String(/** @type {any} */ (e)?.message ?? e));
    process.exit(1);
  }
}
