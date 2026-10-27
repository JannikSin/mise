// Mise 2.0 G2: one logical snapshot of the database as a single JSON document.
// It is the one data format the G2 tools share:
//   - the nightly backup (.github/workflows/mise-backup.yml runs SNAPSHOT_SQL
//     through psql as the read-only `mise_backup` role and encrypts the output
//     with age; the plaintext never reaches the log);
//   - the reverse export (tools/export-from-supabase.mjs turns a snapshot back
//     into the mise-data file layout, the rollback path);
//   - the restore (tools/restore-backup.mjs turns a snapshot into one SQL
//     script that refills a project);
//   - the person export (tools/export-person.mjs).
// So the rollback and the restore read the same bytes the backup writes, and
// the PGlite drill runs the exact SQL the Action runs.
//
// "pg_dump style": every row of every table, data only, ordered by primary
// key. The schema is not in the snapshot: it is supabase/migrations/, in git.
// The snapshot records each table's column list so a restore into a project
// on a different schema refuses instead of silently dropping a column.
//
// Public code, no names. A snapshot holds personal data: it is encrypted at
// rest (age) and never printed. `summarize` gives counts only.

import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";
import { Buffer } from "node:buffer";

/** Every table the snapshot carries, in restore order (parents first), with its sort key. */
export const SNAPSHOT_TABLES = /** @type {const} */ ([
  ["public.households", "id"],
  ["public.profiles", "id"],
  ["public.memberships", "profile_id, household_id"],
  ["public.admins", "user_id"],
  ["public.roster_rev", "one"],
  ["public.recipes", "id"],
  ["public.docs", "path"],
  ["public.plates", "profile_id"],
  ["public.guest_grants", "guest_profile, host_household"],
  ["public.invites", "code_hash"],
  ["public.guest_logins", "profile_id"],
  ["public.ai_usage", "user_id, day"],
  ["private.settings", "key"],
  ["private.pending_links", "email"],
  ["private.guard_terms", "term, hidden_from"],
]);

export const SNAPSHOT_FORMAT = "mise-backup/1";

/** @param {string} table schema.name @returns {[string, string]} */
function split(table) {
  const [schema, name] = table.split(".");
  return [String(schema), String(name)];
}

/**
 * One SELECT that returns the whole snapshot as one text value (column
 * `snapshot`). Read-only: safe to run as `mise_backup`.
 * @returns {string}
 */
export function snapshotSql() {
  const cols = SNAPSHOT_TABLES.map(([t]) => {
    const [s, n] = split(t);
    return `'${t}', (select coalesce(jsonb_agg(c.column_name::text order by c.ordinal_position), '[]'::jsonb)
      from information_schema.columns c where c.table_schema = '${s}' and c.table_name = '${n}')`;
  });
  const rows = SNAPSHOT_TABLES.map(
    ([t, key]) =>
      `'${t}', (select coalesce(jsonb_agg(to_jsonb(r) order by ${key
        .split(", ")
        .map((k) => `r.${k}`)
        .join(", ")}), '[]'::jsonb) from ${t} r)`,
  );
  return `-- Mise 2.0 snapshot (tools/db-snapshot.mjs). Read-only. Output: one JSON document.
select jsonb_build_object(
  'format', '${SNAPSHOT_FORMAT}',
  'taken_at', now(),
  'columns', jsonb_build_object(
    ${cols.join(",\n    ")}),
  'tables', jsonb_build_object(
    ${rows.join(",\n    ")})
)::text as snapshot;
`;
}

/**
 * @typedef {{ format: string, taken_at: string, columns: Record<string, string[]>, tables: Record<string, any[]> }} Snapshot
 */

/**
 * Parse and check a snapshot. Throws on anything that is not a whole one.
 * @param {string} text
 * @returns {Snapshot}
 */
export function parseSnapshot(text) {
  /** @type {any} */
  let s;
  try {
    s = JSON.parse(text);
  } catch {
    throw new Error("the snapshot is not JSON (was it decrypted?)");
  }
  if (s?.format !== SNAPSHOT_FORMAT) throw new Error(`the snapshot format is not ${SNAPSHOT_FORMAT}`);
  for (const [t] of SNAPSHOT_TABLES) {
    if (!Array.isArray(s.tables?.[t])) throw new Error(`the snapshot has no ${t} table`);
    if (!Array.isArray(s.columns?.[t]) || s.columns[t].length === 0) throw new Error(`the snapshot has no column list for ${t}`);
  }
  return s;
}

/**
 * Take a snapshot through any client with `query(sql)` (PGlite in the drill;
 * the Action uses psql with the same SQL).
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} client
 * @returns {Promise<Snapshot>}
 */
export async function takeSnapshot(client) {
  const r = await client.query(snapshotSql());
  return parseSnapshot(String(r.rows[0].snapshot));
}

/** Counts per table, never data. @param {Snapshot} s @returns {Record<string, number>} */
export function summarize(s) {
  return Object.fromEntries(SNAPSHOT_TABLES.map(([t]) => [t, s.tables[t]?.length ?? 0]));
}

/**
 * The snapshot's rows in the shapes the file tools need.
 * @param {Snapshot} s
 */
export function indexSnapshot(s) {
  const t = s.tables;
  /** @type {Map<string, string>} */
  const houseSlug = new Map(t["public.households"]?.map((h) => [h.id, h.slug]));
  /** @type {Map<string, any>} */
  const profileById = new Map(t["public.profiles"]?.map((p) => [p.id, p]));
  /** @type {Record<string, string>} */
  const settings = Object.fromEntries((t["private.settings"] ?? []).map((r) => [r.key, r.value]));
  return { houseSlug, profileById, settings, docs: t["public.docs"] ?? [], recipes: t["public.recipes"] ?? [], plates: t["public.plates"] ?? [] };
}

/** @param {string[]} argv */
async function main(argv) {
  const cmd = argv[0];
  if (cmd === "sql") {
    process.stdout.write(snapshotSql());
    return;
  }
  if (cmd === "tables") {
    // the table names, one per line, for the Action's own counts check (fix
    // loop 2 C3: the plaintext is never read by public code)
    process.stdout.write(SNAPSHOT_TABLES.map(([t]) => `${t}
`).join(""));
    return;
  }
  if (cmd === "check") {
    // reads a snapshot on stdin, prints counts only (the Action's sanity step)
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    const s = parseSnapshot(Buffer.concat(chunks).toString("utf8"));
    const counts = summarize(s);
    if (!counts["public.profiles"] || !counts["public.docs"]) throw new Error("the snapshot is empty");
    for (const [k, n] of Object.entries(counts)) console.log(`${k} ${n}`);
    return;
  }
  console.log("usage: node tools/db-snapshot.mjs sql | tables | check < snapshot.json");
  process.exit(2);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(String(e?.message ?? e));
    process.exit(1);
  });
}
