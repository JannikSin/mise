#!/usr/bin/env node
// Mise 2.0 G1: mise-data snapshot -> the Supabase database (plan section 6).
// Public code: it holds no person's name. Everything personal comes from two
// local inputs on David's laptop:
//   --snapshot <dir>   a local mise-data clone (read only, never fetched)
//   --people <file>    people.local.json (shape below)
//
// people.local.json:
//   {
//     "rootProfile": "<slug whose files sit at the repo root>",
//     "admin": "<slug of the admin>",
//     "houses": ["<house slug>", ...],
//     "people": [
//       { "slug": "...", "email": "...", "kind": "member" | "guest",
//         "houses": ["<house>", ...],            // members: one or more
//         "home": "<house>",                     // optional, default profiles.json household or houses[0]
//         "entitled": true,                      // AI routes allowed
//         "grants": [{ "house": "...", "until": "YYYY-MM-DD" }],   // guests
//         "names": ["<word>", ...] }             // extra words for the bank scrub
//     ],
//     "guardTerms": [{ "term": "<word>", "hiddenFrom": "<house>" }]
//   }
//
// Steps: 1 preflight (classify every file, the admin diff gate, the bank scrub
// gate, the audience-aware name guard, sha-256 per file, the freeze marker on
// --final); 2 houses, profiles, memberships, the admin, guest grants (no auth
// users: pending_links holds the invite emails); 3 guard_terms; 4 docs and
// recipes with their git blob sha; 5 plates (made by the trigger); 6 verify,
// all inside one transaction that is rolled back unless every check passes.
//
// Output is counts only unless --show-paths: a path can carry a slug, and
// slugs are names.
//
// Targets: `--target pglite` runs into a fresh in-memory PGlite stand-in (the
// local rehearsal, no network). `sandbox` and `live` are not wired yet: the
// database client for them is the owner's call (see NEEDS DAVID in the fleet
// notes). `runMigration` takes any client with `query(sql, params)`.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { docScope, audienceOf, BadPathError } from "../app/lib/doc-scope.js";
import { plateOf } from "../app/lib/plate-of.js";
import { PLATE_FIELDS, PLATE_SAFETY_FIELDS } from "../app/lib/plate-fields.js";
import { isFrozen } from "../app/lib/freeze.js";
import { guardHits as nameGuardHits, guardPath, termWords, TermError } from "./name-guard.mjs";

/** @typedef {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[], affectedRows?: number }> }} Client */

/** Files the migration leaves behind, by rule (plan section 6, step 4). */
export const SKIP_RULES = /** @type {[string, RegExp][]} */ ([
  ["server-only", /^(meta|invites|guests)\.json$/],
  ["github-lane", /^(fitness|health)\//],
  ["workouts-activities", /^profiles\/[^/]+\/fitness\/(workouts|activities)\.json$/],
  ["health-files", /^profiles\/[^/]+\/health\//],
]);
export const BANK = /^(recipes|recipes-staging)\/([a-z0-9][a-z0-9-]{0,150})\.json$/;
export const ROOT_SHARED = /^(prices|pins)\.json$/;
/** fix loop 2 N5: a term hitting more than this share of the bank stops for review. */
export const TERM_LOAD_SHARE = 0.05;
export const DISPLAY_DROPPED = ["id", "household", "family", "admin", "passkey", "adminKey"];

/** @param {unknown} v @returns {unknown} keys sorted, for a stable hash */
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, canonical(/** @type {any} */ (v)[k])]),
    );
  }
  return v;
}
/** @param {unknown} v */
export function contentHash(v) {
  return createHash("sha256").update(JSON.stringify(canonical(v))).digest("hex");
}
/** The git blob sha of a file's bytes (what the GitHub Contents API calls sha). @param {Buffer} bytes */
export function gitBlobSha(bytes) {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

/**
 * The name guard, the same test as private.guard_hit (tools/name-guard.mjs:
 * decoded strings and keys, folded, plurals; fix loop 1 F1).
 * @param {unknown} data @param {string[]} terms @param {string | null} [extra] a path or an id
 * @returns {number} hits
 */
export function guardHits(data, terms, extra = null) {
  return nameGuardHits(data, terms, extra);
}

/** @param {string} dir @param {string} [base] @returns {string[]} repo-relative POSIX paths */
export function walk(dir, base = dir) {
  /** @type {string[]} */
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === ".git") continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, base));
    else out.push(path.relative(base, p).split(path.sep).join("/"));
  }
  return out.sort();
}

class GateError extends Error {
  /** @param {string} gate @param {string} message @param {string[]} [paths] */
  constructor(gate, message, paths = []) {
    super(`${gate}: ${message}`);
    this.gate = gate;
    this.paths = paths;
  }
}
export { GateError };

/**
 * Step 1: read and classify the snapshot, and run every gate that needs no
 * database. Throws GateError naming the gate; never writes.
 * @param {string} snapshotDir
 * @param {any} people parsed people.local.json
 * @param {{ final?: boolean, freezeFile?: string, reviewedTermLoad?: boolean }} [opts]
 */
export function planMigration(snapshotDir, people, opts = {}) {
  const files = walk(snapshotDir);
  /** @type {Record<string, string>} */
  const sha256 = {};
  /** @type {Map<string, { bytes: Buffer, data: any }>} */
  const read = new Map();
  /** @type {string[]} */
  const unparsable = [];
  for (const f of files) {
    const bytes = readFileSync(path.join(snapshotDir, f));
    sha256[f] = createHash("sha256").update(bytes).digest("hex");
    if (!f.endsWith(".json")) continue;
    try {
      read.set(f, { bytes, data: JSON.parse(bytes.toString("utf8")) });
    } catch {
      unparsable.push(f);
    }
  }
  if (unparsable.length) throw new GateError("parse", `${unparsable.length} file(s) are not valid JSON`, unparsable);

  if (opts.final) {
    const marker = opts.freezeFile ?? "freeze.json";
    if (!files.includes(marker)) throw new GateError("freeze", `the final run needs the freeze marker ${marker} in the snapshot`);
    // worker fix loop 1, item 16 (Engineer F6b): after an UNFREEZE the file is
    // still there with frozen false; only an explicit frozen true passes
    if (!isFrozen(read.get(marker)?.data)) {
      throw new GateError("freeze", `the freeze marker ${marker} does not say frozen: true; freeze in Settings, wait 10 minutes, take a fresh snapshot`);
    }
  }

  // the people file
  const houses = /** @type {string[]} */ (people?.houses ?? []);
  const list = /** @type {any[]} */ (people?.people ?? []);
  const slugs = list.map((p) => String(p.slug));
  const bySlug = new Map(list.map((p) => [String(p.slug), p]));
  if (!bySlug.has(people?.admin)) throw new GateError("people", "the admin is not in the people list");
  if (!bySlug.has(people?.rootProfile)) throw new GateError("people", "the root profile is not in the people list");
  for (const p of list) {
    for (const h of [...(p.houses ?? []), ...(p.grants ?? []).map((/** @type {any} */ g) => g.house)]) {
      if (!houses.includes(h)) throw new GateError("people", "a person names a house that is not in the houses list");
    }
  }

  // the roster and the admin diff gate
  const roster = read.get("profiles.json")?.data;
  if (!roster || !Array.isArray(roster.profiles)) throw new GateError("roster", "profiles.json is missing or has no profiles array");
  const rosterIds = roster.profiles.map((/** @type {any} */ r) => String(r.id));
  const notInPeople = rosterIds.filter((/** @type {string} */ id) => !bySlug.has(id));
  const notInRoster = slugs.filter((s) => !rosterIds.includes(s));
  if (notInPeople.length || notInRoster.length) {
    throw new GateError("people", `${notInPeople.length} roster row(s) missing from people.local.json, ${notInRoster.length} person(s) missing from profiles.json`, [...notInPeople, ...notInRoster]);
  }
  const rosterAdmins = roster.profiles.filter((/** @type {any} */ r) => r.admin === true).map((/** @type {any} */ r) => String(r.id));
  if (rosterAdmins.length !== 1 || rosterAdmins[0] !== people.admin) {
    throw new GateError("admin", "profiles.json's admin flag does not name exactly the admin in people.local.json");
  }

  /** @param {string} s */
  const housesOf = (s) => /** @type {string[]} */ (bySlug.get(s)?.houses ?? []);
  /** @param {string} s */
  const plateHouses = (s) => [...housesOf(s), ...(bySlug.get(s)?.grants ?? []).map((/** @type {any} */ g) => String(g.house))];
  const world = { households: houses, profiles: slugs, rootProfile: String(people.rootProfile) };
  // fix loop 2 C1: every term and name folded exactly as the text is, split
  // into words; one that is not plain a to z after folding stops the run
  // (the message names the field, never the value)
  /** @param {unknown} raw @param {string} field */
  const wordsOf = (raw, field) => {
    try {
      return termWords(String(raw ?? ""));
    } catch (e) {
      if (e instanceof TermError) throw new GateError("terms", `${field} is not plain letters a to z after folding (or has no word of 2 letters); write it in Latin letters`);
      throw e;
    }
  };
  const guardWords = /** @type {any[]} */ (people.guardTerms ?? []).flatMap((g, i) =>
    wordsOf(g?.term, `guardTerms[${i}].term`).map((term) => ({ term, hiddenFrom: String(g.hiddenFrom) })),
  );
  const allTerms = [...new Set(guardWords.map((g) => g.term))];
  /** @param {string[] | null} aud */
  const termsFor = (aud) => (aud === null ? allTerms : [...new Set(guardWords.filter((g) => aud.includes(g.hiddenFrom)).map((g) => g.term))]);

  // classify every file
  /** @type {{ id: string, staging: boolean, data: any, sha: string, path: string }[]} */
  const recipes = [];
  /** @type {{ path: string, kind: string, data: any, sha: string, profile: string | null, household: string | null, copy?: boolean }[]} */
  const docs = [];
  /** @type {Record<string, number>} */
  const skipped = {};
  /** @type {string[]} */
  const unmapped = [];
  /** @type {string[]} */
  const badBank = [];
  const skip = (/** @type {string} */ why) => (skipped[why] = (skipped[why] ?? 0) + 1);
  for (const f of files) {
    if (!f.endsWith(".json")) {
      skip("not-json");
      continue;
    }
    if (f === "profiles.json") continue;
    if (opts.freezeFile ? f === opts.freezeFile : f === "freeze.json") {
      skip("freeze-marker");
      continue;
    }
    const rule = SKIP_RULES.find(([, re]) => re.test(f));
    if (rule) {
      skip(rule[0]);
      continue;
    }
    const entry = /** @type {{ bytes: Buffer, data: any }} */ (read.get(f));
    const bank = BANK.exec(f);
    if (bank) {
      if (entry.data?.id !== bank[2]) badBank.push(f);
      recipes.push({ id: String(bank[2]), staging: bank[1] === "recipes-staging", data: entry.data, sha: gitBlobSha(entry.bytes), path: f });
      continue;
    }
    if (ROOT_SHARED.test(f)) {
      // per-house prices and pins: each house without its own file gets a copy
      for (const h of houses) {
        const p = `households/${h}/${f}`;
        if (!read.has(p)) docs.push({ path: p, kind: f.replace(".json", ""), data: entry.data, sha: gitBlobSha(entry.bytes), profile: null, household: h, copy: true });
      }
      continue;
    }
    try {
      const s = docScope(f, world);
      docs.push({ path: f, kind: s.kind, data: entry.data, sha: gitBlobSha(entry.bytes), profile: s.profile, household: s.household });
    } catch (e) {
      if (!(e instanceof BadPathError)) throw e;
      unmapped.push(f);
    }
  }
  if (badBank.length) throw new GateError("bank", `${badBank.length} bank file(s) carry an id that is not their file name`, badBank);
  if (unmapped.length) throw new GateError("unmapped", `${unmapped.length} file(s) have no home in the database and no skip rule`, unmapped);

  // shadow duplicates: an own recipe identical to the bank copy of the same id
  const bankById = new Map(recipes.filter((r) => !r.staging).map((r) => [r.id, r]));
  const kept = docs.filter((d) => {
    if (d.kind !== "own_recipe") return true;
    const twin = bankById.get(String(d.data?.id));
    if (twin && contentHash(twin.data) === contentHash(d.data)) {
      skip("shadow-duplicate");
      return false;
    }
    return true;
  });

  // fix loop 2 N5: how many bank recipes each term and name hits (counts
  // only, labelled by field, never the term or the recipe). A term that hits
  // more than 5% of the bank is a common word as well as a name (a surname
  // such as a food word) and would refuse most writes: stop for review. One
  // recipe is never a common word.
  /** @type {{ field: string, recipes: number }[]} */
  const termLoad = [];
  /** @param {string} field @param {string[]} words */
  const load = (field, words) => termLoad.push({ field, recipes: recipes.filter((r) => words.some((w) => guardHits(r.data, [w], r.id) > 0)).length });
  /** @type {any[]} */ (people.guardTerms ?? []).forEach((g, i) => load(`guardTerms[${i}]`, wordsOf(g?.term, `guardTerms[${i}].term`)));
  list.forEach((p, i) => {
    if (p.slug !== people.admin) /** @type {unknown[]} */ (p.names ?? []).forEach((n, j) => load(`people[${i}].names[${j}]`, wordsOf(n, `people[${i}].names[${j}]`)));
  });
  const wide = termLoad.filter((t) => t.recipes > 1 && t.recipes > TERM_LOAD_SHARE * recipes.length);
  if (wide.length && !opts.reviewedTermLoad) {
    throw new GateError(
      "term-load",
      `${wide.length} term(s) each hit more than ${TERM_LOAD_SHARE * 100}% of the ${recipes.length} bank recipes: a common word as well as a name; review them, then rerun with --reviewed-term-load`,
      termLoad.map((t) => `${t.field}: ${t.recipes} of ${recipes.length} bank recipe(s)`),
    );
  }

  // the bank scrub gate (plan section 6 step 1, decision 3): no person's
  // name on any shared recipe, staging included
  const scrubTerms = [
    ...allTerms,
    ...list.flatMap((p, i) => (p.slug === people.admin ? [] : /** @type {unknown[]} */ (p.names ?? []).flatMap((n, j) => wordsOf(n, `people[${i}].names[${j}]`)))),
  ];
  const named = recipes.filter((r) => guardHits(r.data, scrubTerms, r.id) > 0);
  if (named.length) {
    const hits = named.reduce((a, r) => a + guardHits(r.data, scrubTerms, r.id), 0);
    throw new GateError("scrub", `${named.length} bank recipe(s) carry a person's name (${hits} hit(s)); run the bank scrub first`, named.map((r) => r.path));
  }

  // the audience-aware name guard, before any write (the database runs it
  // again on every row)
  /** @type {string[]} */
  const guarded = [];
  for (const d of kept) {
    const aud = d.kind === "global" ? null : audienceOf(d, housesOf);
    if ((aud !== null || d.kind === "global") && guardHits(d.data, termsFor(aud), guardPath(d.path)) > 0) guarded.push(d.path);
    if (d.kind === "targets" && d.profile && guardHits(plateOf(d.data), termsFor(plateHouses(d.profile))) > 0) guarded.push(d.path);
  }
  // F5: the roster's display fields reach every house that can see the row
  for (const r of roster.profiles) {
    const display = Object.fromEntries(Object.entries(r).filter(([k]) => !DISPLAY_DROPPED.includes(k)));
    if (guardHits(display, termsFor(plateHouses(String(r.id)))) > 0) guarded.push("profiles.json");
  }
  if (guarded.length) throw new GateError("name-guard", `${guarded.length} file(s) would show a name to a house it is hidden from`, guarded);

  // F2: a mirror that disagrees with its canonical file on a safety key is a
  // stale copy; the plate follows the canonical file, but refuse so David
  // looks (counts only)
  /** @type {string[]} */
  const split = [];
  for (const c of kept.filter((d) => d.kind === "targets" && d.path.endsWith("profile/targets.json"))) {
    const m = kept.find((d) => d.kind === "targets" && d.profile === c.profile && d.path.endsWith("fitness/targets.json"));
    if (!m) continue;
    const pick = (/** @type {any} */ t) => Object.fromEntries(PLATE_SAFETY_FIELDS.map((k) => [k, t?.[k] ?? null]));
    if (contentHash(pick(c.data)) !== contentHash(pick(m.data))) split.push(m.path);
  }
  if (split.length) throw new GateError("targets-mirror", `${split.length} person(s) have a fitness/targets.json mirror that disagrees with profile/targets.json on a safety key (diet, allergies, avoids)`, split);

  // canonical targets before the mirror, so the plate carries the canonical sha
  kept.sort((a, b) => Number(/fitness\/targets\.json$/.test(a.path)) - Number(/fitness\/targets\.json$/.test(b.path)));

  /** @type {Record<string, number>} */
  const kinds = {};
  for (const d of kept) kinds[d.kind] = (kinds[d.kind] ?? 0) + 1;
  return { people, guardWords, termLoad, roster: roster.profiles, recipes, docs: kept, skipped, kinds, sha256, fileCount: files.length };
}

/** @typedef {ReturnType<typeof planMigration>} MigrationPlan */

/**
 * Steps 2 to 6 in one transaction. Rolls back on any failure, and when
 * `opts.rollback` is set (a rehearsal that leaves nothing behind).
 * @param {Client} client a superuser connection (the migration key)
 * @param {MigrationPlan} plan
 * @param {{ rollback?: boolean, overwriteEdits?: boolean }} [opts]
 */
export async function runMigration(client, plan, opts = {}) {
  const q = (/** @type {string} */ sql, /** @type {unknown[]} */ params = []) => client.query(sql, params);
  const { people } = plan;
  const list = /** @type {any[]} */ (people.people);
  await q("begin");
  try {
    // a re-run after phones have written would erase their work
    const edited = (await q("select (select count(*) from public.docs where rev > 1) + (select count(*) from public.recipes where rev > 1) as n")).rows[0].n;
    if (Number(edited) > 0 && !opts.overwriteEdits) {
      throw new GateError("edited", `${edited} row(s) were edited after the last migration; refusing to overwrite them`);
    }
    const strangers = (await q("select count(*)::int as n from public.profiles where kind <> 'probe' and not (slug = any ($1::text[]))", [list.map((p) => p.slug)])).rows[0].n;
    if (strangers > 0) throw new GateError("people", `${strangers} profile(s) in the database are not in people.local.json`);

    await q("insert into private.settings values ('root_profile', $1), ('admin_profile', $2) on conflict (key) do update set value = excluded.value", [people.rootProfile, people.admin]);
    // G2: which house rows are copies of a root file, so the reverse export
    // (tools/export-from-supabase.mjs) can put the root file back
    const copies = plan.docs.filter((d) => d.copy).map((d) => d.path);
    await q("insert into private.settings values ('root_copies', $1) on conflict (key) do update set value = excluded.value", [JSON.stringify(copies)]);

    // step 2: houses, profiles, memberships, grants
    for (const h of people.houses) await q("insert into public.households (slug) values ($1) on conflict (slug) do nothing", [h]);
    /** @type {Map<string, string>} */
    const houseId = new Map((await q("select slug, id from public.households")).rows.map((r) => [r.slug, r.id]));
    const rosterById = new Map(plan.roster.map((/** @type {any} */ r, /** @type {number} */ i) => [String(r.id), { row: r, order: i + 1 }]));
    for (const p of list) {
      const r = /** @type {{ row: any, order: number }} */ (rosterById.get(p.slug));
      const display = Object.fromEntries(Object.entries(r.row).filter(([k]) => !DISPLAY_DROPPED.includes(k)));
      const memberHouses = p.kind === "guest" ? [] : /** @type {string[]} */ (p.houses ?? []);
      const home = p.home ?? (memberHouses.includes(r.row.household ?? "home") ? (r.row.household ?? "home") : memberHouses[0]);
      await q(
        `insert into public.profiles (slug, kind, home_household, family, roster, entitled, sort_order)
         values ($1, $2, $3, $4, $5::jsonb, $6, $7)
         on conflict (slug) do update set kind = excluded.kind, home_household = excluded.home_household,
           family = excluded.family, roster = excluded.roster, entitled = excluded.entitled,
           sort_order = excluded.sort_order, updated_at = now()`,
        [p.slug, p.kind === "guest" ? "guest" : "member", home ? houseId.get(home) : null, r.row.family ?? null, JSON.stringify(display), p.entitled === true, r.order],
      );
    }
    /** @type {Map<string, string>} */
    const profileId = new Map((await q("select slug, id from public.profiles")).rows.map((r) => [r.slug, r.id]));
    const managed = list.map((p) => profileId.get(p.slug));
    await q("delete from public.memberships where profile_id = any ($1::uuid[])", [managed]);
    await q("delete from public.guest_grants where guest_profile = any ($1::uuid[])", [managed]);
    for (const p of list) {
      for (const h of p.kind === "guest" ? [] : p.houses ?? []) {
        await q("insert into public.memberships values ($1, $2)", [profileId.get(p.slug), houseId.get(h)]);
      }
      for (const g of p.grants ?? []) {
        await q("insert into public.guest_grants values ($1, $2, $3::date)", [profileId.get(p.slug), houseId.get(g.house), g.until]);
      }
    }
    // no auth users are created: pending links, then any user an earlier
    // invite already made is linked again
    await q("delete from private.pending_links");
    for (const p of list) {
      if (p.email) await q("insert into private.pending_links values (lower($1), $2)", [p.email, profileId.get(p.slug)]);
    }
    await q(`update public.profiles pr set user_id = u.id from private.pending_links l join auth.users u on lower(u.email) = l.email
             where pr.id = l.profile_id and pr.user_id is distinct from u.id and u.email_confirmed_at is not null`);
    await q("delete from public.admins");
    await q("insert into public.admins select user_id from public.profiles where slug = $1 and user_id is not null", [people.admin]);
    await q("update public.roster_rev set rev = rev + 1");

    // step 3: guard terms
    await q("delete from private.guard_terms");
    for (const g of plan.guardWords) {
      await q("insert into private.guard_terms values ($1, $2) on conflict do nothing", [g.term, houseId.get(g.hiddenFrom)]);
    }

    // steps 4 and 5: the data, fresh (plates come back through the trigger)
    await q("delete from public.plates");
    await q("delete from public.docs");
    await q("delete from public.recipes");
    for (const r of plan.recipes) {
      await q("insert into public.recipes (id, data, staging, legacy_sha) values ($1, $2::jsonb, $3, $4)", [r.id, JSON.stringify(r.data), r.staging, r.sha]);
    }
    for (const d of plan.docs) {
      await q("insert into public.docs (path, data, legacy_sha) values ($1, $2::jsonb, $3)", [d.path, JSON.stringify(d.data), d.sha]);
    }

    // step 6: verify
    const checks = await verify(client, plan);
    const failed = checks.filter((c) => !c.ok);
    if (failed.length) throw new GateError("verify", `${failed.length} check(s) failed: ${failed.map((c) => c.check).join(", ")}`);
    await q(opts.rollback ? "rollback" : "commit");
    return { committed: !opts.rollback, checks };
  } catch (e) {
    await q("rollback");
    throw e;
  }
}

/**
 * Every row equals its file; counts per kind; one plate per person with
 * targets, plate keys within PLATE_FIELDS, the plate's sha the canonical file's.
 * @param {Client} client @param {MigrationPlan} plan
 * @returns {Promise<{ check: string, ok: boolean, detail: string }[]>}
 */
export async function verify(client, plan) {
  const docs = (await client.query("select path, kind, data, legacy_sha from public.docs")).rows;
  const recipes = (await client.query("select id, data, staging, legacy_sha from public.recipes")).rows;
  const plates = (await client.query("select p.slug, pl.data, pl.legacy_sha from public.plates pl join public.profiles p on p.id = pl.profile_id")).rows;
  const docByPath = new Map(docs.map((d) => [d.path, d]));
  const recById = new Map(recipes.map((r) => [r.id, r]));
  /** @type {{ check: string, ok: boolean, detail: string }[]} */
  const out = [];
  const add = (/** @type {string} */ check, /** @type {number} */ bad, /** @type {string} */ detail) => out.push({ check, ok: bad === 0, detail });

  const docMismatch = plan.docs.filter((d) => {
    const row = docByPath.get(d.path);
    return !row || contentHash(row.data) !== contentHash(d.data) || row.legacy_sha !== d.sha || row.kind !== d.kind;
  }).length;
  add("docs equal their files", docMismatch, `${plan.docs.length} files, ${docMismatch} mismatched`);
  add("no extra docs rows", docs.length - plan.docs.length, `${docs.length} rows for ${plan.docs.length} files`);
  /** @type {Record<string, number>} */
  const kinds = {};
  for (const d of docs) kinds[d.kind] = (kinds[d.kind] ?? 0) + 1;
  const kindBad = Object.keys({ ...kinds, ...plan.kinds }).filter((k) => kinds[k] !== plan.kinds[k]).length;
  add("counts per kind", kindBad, Object.entries(plan.kinds).map(([k, n]) => `${k} ${n}`).join(", "));
  const recMismatch = plan.recipes.filter((r) => {
    const row = recById.get(r.id);
    return !row || row.staging !== r.staging || contentHash(row.data) !== contentHash(r.data) || row.legacy_sha !== r.sha;
  }).length;
  add("bank equals its files", recMismatch + Math.abs(recipes.length - plan.recipes.length), `${plan.recipes.length} recipes`);

  const withTargets = [...new Set(plan.docs.filter((d) => d.kind === "targets").map((d) => d.profile))];
  add("one plate per person with targets", Math.abs(plates.length - withTargets.length) + withTargets.filter((s) => !plates.some((p) => p.slug === s)).length, `${plates.length} plates`);
  add("plate keys within PLATE_FIELDS", plates.filter((p) => Object.keys(p.data).some((k) => !PLATE_FIELDS.includes(k))).length, "");
  const shaBad = plates.filter((p) => {
    const canon = plan.docs.find((d) => d.kind === "targets" && d.profile === p.slug && d.path.endsWith("profile/targets.json"));
    return canon ? p.legacy_sha !== canon.sha : false;
  }).length;
  add("plate sha is the canonical file's", shaBad, "");
  // F2: every plate is plateOf(the canonical file), or of the mirror when the
  // person has no canonical file
  const plateBad = plates.filter((p) => {
    const mine = plan.docs.filter((d) => d.kind === "targets" && d.profile === p.slug);
    const src = mine.find((d) => d.path.endsWith("profile/targets.json")) ?? mine[0];
    return !src || contentHash(p.data) !== contentHash(plateOf(src.data));
  }).length;
  add("plate equals plateOf(canonical)", plateBad, "");
  return out;
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

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.snapshot || !a.people) {
    console.log("usage: node tools/migrate-to-supabase.mjs --snapshot <mise-data dir> --people <people.local.json> [--dry-run] [--final] [--reviewed-term-load] [--target pglite] [--rollback] [--show-paths] [--manifest <out.json>]");
    process.exit(2);
  }
  const snapshot = String(a.snapshot);
  if (!existsSync(snapshot)) throw new Error("the snapshot directory does not exist");
  const people = JSON.parse(readFileSync(String(a.people), "utf8"));
  let plan;
  try {
    plan = planMigration(snapshot, people, {
      final: a.final === true,
      freezeFile: typeof a["freeze-file"] === "string" ? a["freeze-file"] : undefined,
      reviewedTermLoad: a["reviewed-term-load"] === true,
    });
  } catch (e) {
    if (e instanceof GateError) {
      console.error(`REFUSED ${e.message}`);
      // the term-load lines are counts by field, never a term: always shown
      if (a["show-paths"] || e.gate === "term-load") for (const p of e.paths) console.error(`  ${p}`);
      process.exit(1);
    }
    throw e;
  }
  console.log(`preflight ok: ${plan.fileCount} files, ${plan.recipes.length} bank recipes, ${plan.docs.length} docs`);
  console.log(`  kinds: ${Object.entries(plan.kinds).map(([k, n]) => `${k} ${n}`).join(", ")}`);
  console.log(`  bank recipes hit per term: ${plan.termLoad.map((t) => `${t.field} ${t.recipes}`).join(", ") || "no terms"}`);
  console.log(`  skipped: ${Object.entries(plan.skipped).map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`);
  if (typeof a.manifest === "string") writeFileSync(a.manifest, JSON.stringify(plan.sha256, null, 2));
  if (a["dry-run"]) return;
  const target = a.target ?? "pglite";
  if (target !== "pglite") {
    console.error(`target ${target} is not wired yet: the owner chooses the database client for the real projects`);
    process.exit(2);
  }
  const { openStandin } = await import("./pglite-standin.mjs");
  const db = await openStandin();
  try {
    const out = await runMigration(db, plan, { rollback: a.rollback === true });
    for (const c of out.checks) console.log(`  ${c.ok ? "ok  " : "FAIL"} ${c.check}${c.detail ? `: ${c.detail}` : ""}`);
    console.log(out.committed ? "migrated into the local PGlite stand-in (discarded on exit)" : "rehearsed and rolled back");
  } catch (e) {
    if (e instanceof GateError) {
      console.error(`REFUSED ${e.message}`);
      process.exit(1);
    }
    // a database refusal (name guard, bad path) names no row
    console.error(`REFUSED by the database: ${String(/** @type {any} */ (e)?.message ?? e).split("\n")[0]}`);
    process.exit(1);
  } finally {
    await db.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => {
    console.error(String(e?.message ?? e));
    process.exit(1);
  });
}
