#!/usr/bin/env node
// Mise 2.0 G2: restore a database snapshot (a decrypted nightly backup, or
// one taken by hand) into a project. Plan section 6: after the 30-day
// rollback window the way back is a restore from the backup; the restore
// drill runs on the sandbox (steps below), and here against PGlite.
//
//   age -d -i <your age key file> mise-YYYY-MM-DD.json.age > snapshot.json
//   node tools/restore-backup.mjs --snapshot snapshot.json --admins <slug>                (dry run: counts, verify)
//   node tools/restore-backup.mjs --snapshot snapshot.json --admins <slug> --drill        (restore into a local PGlite and verify, no network)
//   node tools/restore-backup.mjs --snapshot snapshot.json --admins <slug> --sql restore.sql [--wipe]
//   psql "<the project's postgres connection string>" -X -v ON_ERROR_STOP=1 -f restore.sql
//
// The script is ONE transaction. It refuses, before changing anything, when
// the target's tables have different columns from the snapshot's (apply the
// same supabase/migrations/ first), or when the target already holds data and
// --wipe was not given. Triggers are off while the rows go in
// (session_replication_role = replica), so every rev, doc_id, legacy_sha,
// content_hash and timestamp comes back exactly. Then the accounts: a user id
// the target project does not have (a NEW project) is cleared, and each person
// is linked again the first time they sign in with a confirmed email (their
// invite email is in pending_links). Last, the row counts are checked inside
// the transaction; a mismatch rolls everything back.
//
// SANDBOX DRILL (Mon 11/2 or later, once the sandbox exists; David at the laptop):
//   1. Take a snapshot of the sandbox: psql "<sandbox postgres URL>" -X -q -At
//      -v ON_ERROR_STOP=1 -f <(node tools/db-snapshot.mjs sql) > before.json
//   2. node tools/restore-backup.mjs --snapshot before.json --admins <admin slug> --drill   (local check first)
//   3. node tools/restore-backup.mjs --snapshot before.json --admins <admin slug> --sql restore.sql --wipe
//   4. psql "<sandbox postgres URL>" -X -v ON_ERROR_STOP=1 -f restore.sql
//   5. Take a second snapshot (after.json, as in 1), then
//      node tools/restore-backup.mjs --snapshot before.json --compare after.json
//      must print "identical".
//   6. Sign in on Mise NEXT and open a week; then run the probes
//      (tools/probe-reach.mjs via the migration's verify, or the Worker's
//      weekly probe by hand).
//   7. Delete before.json, after.json and restore.sql (they hold the data).
// The same steps against a NEW empty project prove the from-nothing case;
// there step 5 names profiles.user_id and admins as the only differences
// until people sign in again.
//
// Before any script is written (fix loop 2, N7), the snapshot itself is
// checked, because age encrypts to a PUBLIC key and anyone can make a valid
// encrypted file: every `admins` row must belong to a profile named in the
// pinned admin list given on the command line (--admins <slug>[,<slug>]),
// every pinned admin who has an account in the snapshot must be an admin, the
// `admin_profile` setting must be a pinned admin, and every plate must equal
// plateOf(the person's canonical targets row, or the mirror when there is
// none), with one plate per person who has targets. Anything else refuses.
//
// Output is counts only.
import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { SNAPSHOT_TABLES, parseSnapshot, summarize, takeSnapshot } from "./db-snapshot.mjs";
import { contentHash } from "./migrate-to-supabase.mjs";
import { plateOf } from "../app/lib/plate-of.js";

/** @param {string} s @param {string} tag */
const dollar = (s, tag) => {
  if (s.includes(tag)) throw new Error("the snapshot contains the quoting tag; run again");
  return `${tag}${s}${tag}`;
};
/** @param {string} s a plain identifier or short text */
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * Check a snapshot before restoring it (fix loop 2, N7). Returns the
 * problems, counts only (never a slug or a row); empty when it may be restored.
 * @param {import("./db-snapshot.mjs").Snapshot} snap
 * @param {string[]} admins the pinned admin slugs
 * @returns {string[]}
 */
export function verifySnapshot(snap, admins) {
  const t = snap.tables;
  const pinned = new Set(admins.map(String));
  /** @type {string[]} */
  const out = [];
  if (!pinned.size) out.push("the pinned admin list is empty");
  const profiles = t["public.profiles"] ?? [];
  const slugOfUser = new Map(profiles.filter((p) => p.user_id).map((p) => [p.user_id, p.slug]));
  const adminSlugs = (t["public.admins"] ?? []).map((a) => slugOfUser.get(a.user_id) ?? null);
  const notPinned = adminSlugs.filter((s) => s === null || !pinned.has(s)).length;
  if (notPinned) out.push(`${notPinned} admins row(s) are not a pinned admin`);
  const missing = profiles.filter((p) => pinned.has(p.slug) && p.user_id && !adminSlugs.includes(p.slug)).length;
  if (missing) out.push(`${missing} pinned admin(s) with an account are not an admin in the snapshot`);
  const setting = (t["private.settings"] ?? []).find((r) => r.key === "admin_profile")?.value;
  if (!pinned.has(setting)) out.push("the admin_profile setting is not a pinned admin");
  const targets = (t["public.docs"] ?? []).filter((d) => d.kind === "targets" && d.profile_id);
  const plates = t["public.plates"] ?? [];
  const bad = plates.filter((p) => {
    const mine = targets.filter((d) => d.profile_id === p.profile_id);
    const src = mine.find((d) => String(d.path).endsWith("profile/targets.json")) ?? mine[0];
    return !src || contentHash(p.data) !== contentHash(plateOf(src.data));
  }).length;
  if (bad) out.push(`${bad} plate(s) are not plateOf the canonical targets row`);
  const noPlate = [...new Set(targets.map((d) => d.profile_id))].filter((id) => !plates.some((p) => p.profile_id === id)).length;
  if (noPlate) out.push(`${noPlate} person(s) with targets have no plate`);
  return out;
}

/**
 * The restore script for a snapshot. Refuses a snapshot verifySnapshot finds
 * a problem in.
 * @param {import("./db-snapshot.mjs").Snapshot} snap
 * @param {{ admins: string[], wipe?: boolean, tag?: string }} opts
 * @returns {string}
 */
export function restoreSql(snap, opts) {
  if (!Array.isArray(opts?.admins)) throw new Error("mise_restore_verify: the pinned admin list is required (--admins <slug>[,<slug>])");
  const problems = verifySnapshot(snap, opts.admins);
  if (problems.length) throw new Error(`mise_restore_verify: ${problems.join("; ")}`);
  const tag = opts.tag ?? `$mise_${randomBytes(6).toString("hex")}$`;
  const tables = SNAPSHOT_TABLES.map(([t]) => t);
  const out = [];
  out.push("-- Mise 2.0 restore (tools/restore-backup.mjs). One transaction. Holds personal data: delete after use.");
  out.push("begin;");
  // the target's schema must match the snapshot's
  const colChecks = tables.map((t) => {
    const [s, n] = t.split(".");
    const want = JSON.stringify(snap.columns[t]);
    return `  if (select coalesce(jsonb_agg(c.column_name::text order by c.ordinal_position), '[]'::jsonb)
        from information_schema.columns c where c.table_schema = ${lit(String(s))} and c.table_name = ${lit(String(n))})
     is distinct from ${lit(want)}::jsonb then raise exception 'mise_restore_schema: % has other columns than the snapshot', ${lit(t)}; end if;`;
  });
  out.push(`do $check$ begin\n${colChecks.join("\n")}\nend $check$;`);
  if (opts.wipe) {
    out.push(`truncate ${tables.join(", ")};`);
  } else {
    const any = tables.filter((t) => t !== "public.roster_rev").map((t) => `exists (select 1 from ${t})`).join(" or ");
    out.push(`do $check$ begin if ${any} then raise exception 'mise_restore_not_empty: the target holds data (use --wipe)'; end if; end $check$;`);
    out.push("delete from public.roster_rev;");
  }
  out.push("set local session_replication_role = replica;");
  for (const t of tables) {
    const rows = snap.tables[t] ?? [];
    if (!rows.length) continue;
    out.push(`insert into ${t} select * from jsonb_populate_recordset(null::${t}, ${dollar(JSON.stringify(rows), tag)}::jsonb);`);
  }
  out.push("set local session_replication_role = origin;");
  // accounts the target does not have
  out.push(`update public.profiles p set user_id = null where p.user_id is not null and not exists (select 1 from auth.users u where u.id = p.user_id);
delete from public.admins a where not exists (select 1 from auth.users u where u.id = a.user_id);
update public.profiles pr set user_id = u.id from private.pending_links l join auth.users u on lower(u.email) = l.email
 where pr.id = l.profile_id and pr.user_id is null and u.email_confirmed_at is not null;
insert into public.admins select p.user_id from public.profiles p join private.settings s on s.key = 'admin_profile' and s.value = p.slug
 where p.user_id is not null on conflict do nothing;`);
  // the counts
  const counts = summarize(snap);
  const countChecks = tables
    .filter((t) => t !== "public.admins")
    .map((t) => `  if (select count(*) from ${t}) <> ${Number(counts[t])} then raise exception 'mise_restore_count: %', ${lit(t)}; end if;`);
  out.push(`do $check$ begin\n${countChecks.join("\n")}\nend $check$;`);
  out.push("commit;");
  return out.join("\n") + "\n";
}

/**
 * Which tables differ between two snapshots (row data, order by key).
 * @param {import("./db-snapshot.mjs").Snapshot} a @param {import("./db-snapshot.mjs").Snapshot} b
 * @returns {string[]}
 */
export function compareSnapshots(a, b) {
  return SNAPSHOT_TABLES.map(([t]) => t).filter(
    (t) => JSON.stringify(a.tables[t]) !== JSON.stringify(b.tables[t]) || JSON.stringify(a.columns[t]) !== JSON.stringify(b.columns[t]),
  );
}

/**
 * Restore into a fresh local PGlite stand-in (the migrations applied) and
 * compare. No network. Returns the tables that differ (an empty list, or
 * profiles and admins when the snapshot had linked accounts: the stand-in has
 * no auth users).
 * @param {import("./db-snapshot.mjs").Snapshot} snap
 * @param {string[]} admins the pinned admin slugs
 */
export async function drill(snap, admins) {
  const sql = restoreSql(snap, { admins });
  const { openStandin } = await import("./pglite-standin.mjs");
  const db = await openStandin();
  try {
    await db.exec(sql);
    const back = await takeSnapshot(db);
    return compareSnapshots(snap, back);
  } finally {
    await db.close();
  }
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
  if (typeof a.snapshot !== "string") {
    console.log("usage: node tools/restore-backup.mjs --snapshot <snapshot.json> --admins <slug>[,<slug>] [--drill | --sql <out.sql> [--wipe] | --compare <other.json>]");
    process.exit(2);
  }
  const snap = parseSnapshot(readFileSync(a.snapshot, "utf8"));
  if (typeof a.compare === "string") {
    const diff = compareSnapshots(snap, parseSnapshot(readFileSync(a.compare, "utf8")));
    console.log(diff.length ? `differ: ${diff.join(", ")}` : "identical");
    if (diff.length) process.exit(1);
    return;
  }
  for (const [t, n] of Object.entries(summarize(snap))) console.log(`${t} ${n}`);
  if (typeof a.admins !== "string") {
    console.error("REFUSED: give the pinned admin list, --admins <slug>[,<slug>]");
    process.exit(2);
  }
  const admins = a.admins.split(",").map((x) => x.trim()).filter(Boolean);
  const problems = verifySnapshot(snap, admins);
  if (problems.length) {
    console.error(`REFUSED: the snapshot does not verify: ${problems.join("; ")}`);
    process.exit(1);
  }
  console.log("snapshot verified: admins match the pinned list, every plate is plateOf its canonical targets");
  if (a.drill) {
    const diff = await drill(snap, admins);
    const linked = diff.every((t) => t === "public.profiles" || t === "public.admins");
    console.log(diff.length === 0 ? "drill ok: restored and identical" : linked ? `drill ok: identical except ${diff.join(", ")} (no accounts in the local stand-in)` : `DRILL FAILED: ${diff.join(", ")}`);
    if (!linked) process.exit(1);
    return;
  }
  if (typeof a.sql === "string") {
    writeFileSync(a.sql, restoreSql(snap, { admins, wipe: a.wipe === true }), { mode: 0o600 });
    console.log(`wrote the restore script${a.wipe ? " (it WIPES the target first)" : ""}; run it with psql, then delete it`);
    return;
  }
  console.log("dry run: add --drill, or --sql <file>");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => {
    console.error(String(e?.message ?? e).split("\n")[0]);
    process.exit(1);
  });
}
