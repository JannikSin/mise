// Mise 2.0 G2: the nightly backup. The read-only role reads every row of
// every snapshot table and writes nothing; the workflow files run only in the
// private backup repo, reference secrets by name only, and print no data.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { asRole, errorOf, SKIP } from "./_pglite.js";
import { planMigration, runMigration } from "../tools/migrate-to-supabase.mjs";
import { takeSnapshot, SNAPSHOT_TABLES } from "../tools/db-snapshot.mjs";
import { roleSetup } from "../tools/backup-setup.mjs";
import { freshDb } from "./_pglite.js";
import { PEOPLE, writeSnapshot } from "./_snapshot.js";

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const SNAP_TOOL = fileURLToPath(new URL("../tools/db-snapshot.mjs", import.meta.url));

test("mise_backup reads every row of every snapshot table, and writes nothing", { skip: SKIP }, async () => {
  const db = await freshDb();
  await runMigration(db, planMigration(writeSnapshot(), PEOPLE));
  const full = await takeSnapshot(db);
  const asBackup = await asRole(db, "mise_backup", () => takeSnapshot(db));
  for (const [t] of SNAPSHOT_TABLES) {
    assert.deepEqual(asBackup.tables[t], full.tables[t], t);
    assert.deepEqual(asBackup.columns[t], full.columns[t], t);
  }
  assert.ok((asBackup.tables["public.docs"] ?? []).length > 10);
  for (const sql of [
    "insert into public.docs (path, data) values ('shopping.json', '{}')",
    "update public.docs set data = '{}'",
    "delete from public.recipes",
    "insert into private.settings values ('x', 'y')",
    "select public.write_doc('shopping.json', '{}'::jsonb, 1)",
    "select svc.guard_hits()",
    "select public.roster()",
  ]) {
    const e = await asRole(db, "mise_backup", () => errorOf(() => db.query(sql)));
    assert.match(String(e?.message), /permission denied/, sql);
  }
  await db.close();
});

test("the snapshot check prints counts only and refuses an empty or encrypted file", { skip: SKIP }, async () => {
  const db = await freshDb();
  await runMigration(db, planMigration(writeSnapshot(), PEOPLE));
  const text = JSON.stringify(await takeSnapshot(db));
  await db.close();
  const ok = spawnSync(process.execPath, [SNAP_TOOL, "check"], { input: text, encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^public\.households 2$/m);
  for (const word of ["owner-1", "mate-1", "house-w", "Lentil", "kinword", "example.invalid"]) assert.equal(ok.stdout.includes(word), false, word);
  const enc = spawnSync(process.execPath, [SNAP_TOOL, "check"], { input: "age-encryption.org/v1\n", encoding: "utf8" });
  assert.equal(enc.status, 1);
  const empty = await freshDb();
  const blank = JSON.stringify(await takeSnapshot(empty));
  await empty.close();
  assert.equal(spawnSync(process.execPath, [SNAP_TOOL, "check"], { input: blank, encoding: "utf8" }).status, 1);
  const sql = spawnSync(process.execPath, [SNAP_TOOL, "sql"], { encoding: "utf8" });
  assert.match(sql.stdout, /^-- Mise 2.0 snapshot/);
});

for (const file of [".github/workflows/mise-backup.yml", ".github/workflows/mise-keepalive.yml"]) {
  test(`${file}: runs only in the private backup repo, secrets by name, no data printed`, () => {
    const y = read(file);
    // every job is guarded on the repository name
    const body = y.slice(y.indexOf("\njobs:\n"));
    const jobs = [...body.matchAll(/^ {2}([a-z-]+):\n {4}if: (.+)$/gm)];
    const declared = [...body.matchAll(/^ {2}([a-z-]+):$/gm)].map((m) => m[1]);
    assert.ok(jobs.length >= 1);
    assert.equal(jobs.length, declared.length, "a job without the guard");
    for (const j of jobs) assert.equal(j[2], "github.repository == 'JannikSin/mise-backup'", String(j[1]));
    // secrets only as ${{ secrets.NAME }}, from the known list
    const names = [...y.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]);
    for (const n of names) assert.ok(["MISE_BACKUP_DB_URL", "MISE_BACKUP_AGE_RECIPIENT", "MISE_SANDBOX_DB_URL", "NTFY_TOPIC"].includes(String(n)), String(n));
    // nothing that looks like a real credential
    assert.doesNotMatch(y, /postgres(ql)?:\/\/[^\s"$]+:[^\s"$]+@/);
    assert.doesNotMatch(y, /sb_secret_|sb_publishable_[A-Za-z0-9]{8}|age1[0-9a-z]{20}|eyJhbGci/);
    assert.doesNotMatch(y, /set -x|cat .*plain|tee /);
    assert.match(y, /schedule:/);
    assert.match(y, /if: failure\(\)/);
  });
}

test("the backup workflow: the same snapshot SQL, counts-only check, age, plaintext shredded, a private-repo refusal", () => {
  const y = read(".github/workflows/mise-backup.yml");
  for (const step of [
    'test "$(gh api "repos/${GITHUB_REPOSITORY}" --jq .private)" = "true"',
    "node mise/tools/db-snapshot.mjs sql",
    "node mise/tools/db-snapshot.mjs check",
    'age -r "${AGE_RECIPIENT}"',
    'shred -u "${RUNNER_TEMP}/plain.json"',
    "git ls-remote --exit-code --heads origin backups",
    "date -u -d '30 days ago'",
  ]) {
    assert.ok(y.includes(step), step);
  }
  // the order: encrypt before anything is committed
  assert.ok(y.indexOf("age -r") < y.indexOf("git add -A"));
});

test("backup-setup prints one statement and one connection string, and checks its inputs", () => {
  const r = roleSetup({ ref: "abcdefghijklmnopqrst", poolerHost: "aws-0-us-east-2.pooler.supabase.com", password: "Zm9vYmFyYmF6cXV4cXV1eHh4eHg" });
  assert.equal(r.sql, "alter role mise_backup with login password 'Zm9vYmFyYmF6cXV4cXV1eHh4eHg';");
  assert.equal(r.url, "postgresql://mise_backup.abcdefghijklmnopqrst:Zm9vYmFyYmF6cXV4cXV1eHh4eHg@aws-0-us-east-2.pooler.supabase.com:5432/postgres?sslmode=require");
  assert.throws(() => roleSetup({ ref: "YOUR-PROJECT", poolerHost: "x.pooler.supabase.com" }), /--ref/);
  assert.throws(() => roleSetup({ ref: "abcdefghijklmnopqrst", poolerHost: "db.example.com" }), /--pooler-host/);
  const a = roleSetup({ ref: "abcdefghijklmnopqrst", poolerHost: "x.pooler.supabase.com" });
  const b = roleSetup({ ref: "abcdefghijklmnopqrst", poolerHost: "x.pooler.supabase.com" });
  assert.notEqual(a.sql, b.sql, "a fresh password each run");
});
