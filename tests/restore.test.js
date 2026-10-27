// Mise 2.0 G2: the restore drill against PGlite (the plan wants it on the
// sandbox, which does not exist yet; the sandbox steps are in the header of
// tools/restore-backup.mjs). Backup, wipe, restore, verify: every row comes
// back exactly, revs and shas included, and the policies still decide.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { asRole, asUser, errorOf, freshDb, SKIP } from "./_pglite.js";
import { planMigration, runMigration } from "../tools/migrate-to-supabase.mjs";
import { takeSnapshot, SNAPSHOT_TABLES } from "../tools/db-snapshot.mjs";
import { restoreSql, compareSnapshots, drill } from "../tools/restore-backup.mjs";
import { PEOPLE, writeSnapshot } from "./_snapshot.js";

const ADMINS = ["owner-1"];
const TOOL = fileURLToPath(new URL("../tools/restore-backup.mjs", import.meta.url));

/** A migrated stand-in with every table holding rows, and real edits (rev > 1). */
async function lived() {
  const db = await freshDb();
  await runMigration(db, planMigration(writeSnapshot(), PEOPLE));
  await db.exec("insert into auth.users (email, email_confirmed_at) values ('owner-1@example.invalid', now()), ('mate-1@example.invalid', now())");
  const uid = Object.fromEntries((await db.query("select slug, user_id from public.profiles where user_id is not null")).rows.map((/** @type {any} */ r) => [r.slug, r.user_id]));
  for (const rev of [1, 2]) {
    await asUser(db, uid["mate-1"], () => db.query("select public.write_doc('profiles/mate-1/shopping.json', $1::jsonb, $2)", [JSON.stringify({ items: [{ n: rev }] }), rev]));
  }
  await asRole(db, "service_role", async () => {
    await db.query("select svc.mint_invite($1, 'code-a', 'house-w', now() + interval '1 day')", [uid["owner-1"]]);
    const g = (await db.query("select svc.claim_guest('code-a', 'guest-9', '{\"name\":\"Guest Nine\"}', '{\"diet\":\"vegan\"}', '2999-01-01') id")).rows[0].id;
    await db.query("select svc.guest_login_add($1, 'guest nine', 's', 'h')", [g]);
    await db.query("select svc.ai_count($1)", [uid["mate-1"]]);
  });
  return { db, uid };
}

test("drill: backup, wipe, restore, verify, on the same project", { skip: SKIP }, async () => {
  const { db, uid } = await lived();
  const before = await takeSnapshot(db);
  for (const [t] of SNAPSHOT_TABLES) assert.ok((before.tables[t] ?? []).length > 0, `${t} has rows for the drill`);
  const seenBefore = await asUser(db, uid["mate-1"], () => db.query("select path, rev from public.docs order by path"));
  // wipe and restore in one script
  await db.exec(restoreSql(before, { admins: ADMINS, wipe: true }));
  const after = await takeSnapshot(db);
  assert.deepEqual(compareSnapshots(before, after), []);
  assert.equal((await db.query("select rev from public.docs where path = 'profiles/mate-1/shopping.json'")).rows[0].rev, 3, "revs come back, triggers were off");
  // the policies still decide exactly as before
  const seenAfter = await asUser(db, uid["mate-1"], () => db.query("select path, rev from public.docs order by path"));
  assert.deepEqual(seenAfter.rows, seenBefore.rows);
  assert.equal((await asUser(db, uid["mate-1"], () => errorOf(() => db.query("select public.write_doc('profiles/mate-1/shopping.json', '{}'::jsonb, 3)")))), null);
  await db.close();
});

test("drill: into a NEW project, accounts relink on the first confirmed sign-in", { skip: SKIP }, async () => {
  const { db } = await lived();
  const snap = await takeSnapshot(db);
  await db.close();
  assert.deepEqual(await drill(snap, ADMINS), ["public.profiles", "public.admins"], "only the account links differ");
  const fresh = await freshDb();
  await fresh.exec(restoreSql(snap, { admins: ADMINS }));
  assert.equal((await fresh.query("select count(*)::int n from public.profiles where user_id is not null")).rows[0].n, 0);
  await fresh.exec("insert into auth.users (email, email_confirmed_at) values ('owner-1@example.invalid', now())");
  assert.equal((await fresh.query("select count(*)::int n from public.admins")).rows[0].n, 1, "the admin is the admin again");
  await fresh.close();
});

test("refusals: a target holding data, and a target on another schema; nothing changes", { skip: SKIP }, async () => {
  const { db } = await lived();
  const snap = await takeSnapshot(db);
  assert.match(String((await errorOf(() => db.exec(restoreSql(snap, { admins: ADMINS }))))?.message), /mise_restore_not_empty/);
  await db.exec("rollback");
  await db.exec("alter table public.docs add column extra text");
  assert.match(String((await errorOf(() => db.exec(restoreSql(snap, { admins: ADMINS, wipe: true }))))?.message), /mise_restore_schema/);
  await db.exec("rollback").catch(() => {});
  assert.equal((await db.query("select count(*)::int n from public.docs")).rows[0].n, (snap.tables["public.docs"] ?? []).length, "the wipe rolled back");
  await db.close();
});

test("negative control: the compare catches one changed rev, and a restore with the triggers on cannot run", { skip: SKIP }, async () => {
  const { db } = await lived();
  const snap = await takeSnapshot(db);
  await db.exec(restoreSql(snap, { admins: ADMINS, wipe: true }));
  await db.exec("update public.docs set data = data where path = 'shopping.json'");
  assert.deepEqual(compareSnapshots(snap, await takeSnapshot(db)), ["public.docs"]);
  const on = restoreSql(snap, { admins: ADMINS, wipe: true }).replace("set local session_replication_role = replica;", "");
  assert.ok(await errorOf(() => db.exec(on)), "with the triggers on, the server re-derives rows and refuses");
  await db.exec("rollback");
  await db.close();
});

test("CLI: dry run counts only; --drill passes; --compare says identical", { skip: SKIP }, async () => {
  const { db } = await lived();
  const snap = await takeSnapshot(db);
  await db.close();
  const dir = mkdtempSync(path.join(tmpdir(), "mise-restore-"));
  const f = path.join(dir, "snapshot.json");
  writeFileSync(f, JSON.stringify(snap));
  const dry = spawnSync(process.execPath, [TOOL, "--snapshot", f, "--admins", "owner-1"], { encoding: "utf8" });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /dry run/);
  for (const w of ["owner-1", "mate-1", "house-w", "example.invalid", "Guest Nine"]) assert.equal(dry.stdout.includes(w), false, w);
  const d = spawnSync(process.execPath, [TOOL, "--snapshot", f, "--drill", "--admins", "owner-1"], { encoding: "utf8" });
  assert.equal(d.status, 0, d.stderr);
  assert.match(d.stdout, /drill ok/);
  const c = spawnSync(process.execPath, [TOOL, "--snapshot", f, "--compare", f], { encoding: "utf8" });
  assert.match(c.stdout, /identical/);
  const out = path.join(dir, "restore.sql");
  const s = spawnSync(process.execPath, [TOOL, "--snapshot", f, "--sql", out, "--wipe", "--admins", "owner-1"], { encoding: "utf8" });
  assert.equal(s.status, 0, s.stderr);
  assert.match(s.stdout, /WIPES/);
});
