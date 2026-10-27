#!/usr/bin/env node
// Mise 2.0 G2: one person's data, for them (Lawyer: an export). Works from a
// database snapshot (tools/db-snapshot.mjs), so it needs no live access.
//
//   node tools/export-person.mjs --snapshot now.json --slug <slug> --out <new dir>           (dry run: counts)
//   node tools/export-person.mjs --snapshot now.json --slug <slug> --out <new dir> --write
//
// Writes, in the mise-data layout: every row the person OWNS (targets,
// health, plans, shopping, occasions, pantry, own recipes, at their old
// paths), plus `account.json` (slug, kind, display fields, home house,
// houses, family, guest grants) and `plate.json` (the card others see). Never
// another person's rows, never a house's rows, never an account id.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseSnapshot, indexSnapshot } from "./db-snapshot.mjs";
import { serialize } from "./export-from-supabase.mjs";
import { SLUG, parseArgs } from "./sql-script.mjs";

/**
 * @param {import("./db-snapshot.mjs").Snapshot} snap
 * @param {string} slug
 * @returns {Map<string, unknown>} path -> data
 */
export function personFiles(snap, slug) {
  const ix = indexSnapshot(snap);
  const me = [...ix.profileById.values()].find((p) => p.slug === slug && p.kind !== "probe");
  if (!me) throw new Error("no such person in the snapshot");
  /** @type {Map<string, unknown>} */
  const out = new Map();
  for (const d of ix.docs) if (d.profile_id === me.id) out.set(d.path, d.data);
  const houses = (snap.tables["public.memberships"] ?? []).filter((m) => m.profile_id === me.id).map((m) => ix.houseSlug.get(m.household_id)).sort();
  const grants = (snap.tables["public.guest_grants"] ?? [])
    .filter((g) => g.guest_profile === me.id)
    .map((g) => ({ house: ix.houseSlug.get(g.host_household), until: g.until }));
  out.set("account.json", {
    slug: me.slug,
    kind: me.kind,
    roster: me.roster,
    home: me.home_household ? ix.houseSlug.get(me.home_household) ?? null : null,
    houses,
    family: me.family ?? null,
    grants,
  });
  const plate = ix.plates.find((p) => p.profile_id === me.id);
  if (plate) out.set("plate.json", plate.data);
  return out;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (typeof a.snapshot !== "string" || typeof a.slug !== "string" || !SLUG.test(a.slug) || typeof a.out !== "string") {
    console.log("usage: node tools/export-person.mjs --snapshot <snapshot.json> --slug <slug> --out <new dir> [--write]");
    process.exit(2);
  }
  if (existsSync(a.out) && readdirSync(a.out).length) throw new Error("refused: --out must be a new or empty directory");
  const files = personFiles(parseSnapshot(readFileSync(a.snapshot, "utf8")), a.slug);
  if (!a.write) {
    console.log(`dry run: would write ${files.size} file(s); add --write`);
    return;
  }
  for (const [p, data] of files) {
    const full = path.join(a.out, ...p.split("/"));
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, serialize(data));
  }
  console.log(`wrote ${files.size} file(s)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main();
  } catch (e) {
    console.error(String(/** @type {any} */ (e)?.message ?? e));
    process.exit(1);
  }
}
