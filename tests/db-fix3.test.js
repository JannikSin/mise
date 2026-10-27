// Mise 2.0 db fix loop 3 (Engineer review of the db slice,
// terrigen-db-fixlist-3.md): the reviewer's probes as regression cases.
// Made-up people and words only.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, unlinkSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { freshDb, asUser, errorOf, SKIP } from "./_pglite.js";
import { world } from "./_world.js";
import { PEOPLE, writeSnapshot } from "./_snapshot.js";
import { planMigration, runMigration, GateError, gitBlobSha, committedBlobs } from "../tools/migrate-to-supabase.mjs";

/** @param {string} dir @param {...string} args */
const git = (dir, ...args) => execFileSync("git", ["-C", dir, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args], { encoding: "utf8", stdio: "pipe" });

/** @param {() => unknown} fn @param {string} gate @param {RegExp} [msg] */
function refuses(fn, gate, msg) {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof GateError, String(e));
    assert.equal(/** @type {GateError} */ (e).gate, gate, String(e));
    if (msg) assert.match(/** @type {GateError} */ (e).message, msg);
    return;
  }
  assert.fail(`gate ${gate} did not refuse`);
}

// ---- item 1 (E1): every sha is the committed blob, never the working-tree bytes

/** A snapshot checked out the way this laptop does it: core.autocrlf=true, so every text file is CRLF on disk. */
function crlfSnapshot() {
  const dir = writeSnapshot();
  git(dir, "config", "core.autocrlf", "true");
  for (const f of git(dir, "ls-files", "-z").split("\0").filter(Boolean)) unlinkSync(path.join(dir, ...f.split("/")));
  git(dir, "checkout", "--", ".");
  return dir;
}

test("E1: on a CRLF working tree every legacy_sha is the committed blob sha (git ls-tree), not the bytes'", () => {
  const dir = crlfSnapshot();
  const disk = readFileSync(path.join(dir, "shopping.json"));
  assert.ok(disk.includes("\r\n"), "the fixture really is CRLF on disk");
  assert.equal(git(dir, "status", "--porcelain"), "", "and the tree is clean");
  const plan = planMigration(dir, PEOPLE);
  const blob = (/** @type {string} */ f) => git(dir, "rev-parse", `HEAD:${f}`).trim();
  let crlfFiles = 0;
  for (const d of plan.docs) {
    assert.equal(d.sha, blob(d.src), d.path);
    if (gitBlobSha(readFileSync(path.join(dir, ...d.src.split("/")))) !== d.sha) crlfFiles++;
  }
  for (const r of plan.recipes) assert.equal(r.sha, blob(r.path), r.path);
  assert.ok(crlfFiles > 0, "the working-tree bytes hash differently, so the old code would have been wrong");
  // the house copies of a root file carry the root file's blob
  const copy = plan.docs.find((d) => d.path === "households/house-w/prices.json");
  assert.equal(copy?.sha, blob("prices.json"));
  assert.deepEqual(Object.keys(plan.blobs).sort(), git(dir, "ls-files", "-z").split("\0").filter(Boolean).sort());
  rmSync(dir, { recursive: true, force: true });
});

test("E1: the snapshot must be a clean clone at origin/main, or nothing is read", () => {
  // not a clone
  const plain = mkdtempSync(path.join(tmpdir(), "mise-plain-"));
  writeFileSync(path.join(plain, "profiles.json"), "{}");
  refuses(() => planMigration(plain, PEOPLE), "git", /not a git clone/);
  // a folder inside a clone
  const outer = writeSnapshot();
  refuses(() => planMigration(path.join(outer, "profiles"), PEOPLE), "git", /inside a clone/);
  // a modified file
  const dirty = writeSnapshot();
  writeFileSync(path.join(dirty, "shopping.json"), '{"items":[1]}\n');
  refuses(() => planMigration(dirty, PEOPLE), "git", /1 uncommitted/);
  // an untracked file, even in a new folder
  const untracked = writeSnapshot();
  mkdirSync(path.join(untracked, "profiles", "mate-1", "plans2"));
  writeFileSync(path.join(untracked, "profiles", "mate-1", "plans2", "x.json"), "{}\n");
  refuses(() => planMigration(untracked, PEOPLE), "git", /untracked/);
  // HEAD ahead of origin/main
  const ahead = writeSnapshot();
  writeFileSync(path.join(ahead, "shopping.json"), '{"items":[2]}\n');
  git(ahead, "commit", "-q", "-am", "local");
  refuses(() => planMigration(ahead, PEOPLE), "git", /not origin\/main/);
  // no origin/main at all
  const noOrigin = writeSnapshot();
  git(noOrigin, "update-ref", "-d", "refs/remotes/origin/main");
  refuses(() => planMigration(noOrigin, PEOPLE), "git", /no origin\/main/);
  // the clean one passes, and the blob map is git's own
  const ok = writeSnapshot();
  const blobs = committedBlobs(ok);
  assert.equal(blobs.get("shopping.json"), git(ok, "rev-parse", "HEAD:shopping.json").trim());
  for (const d of [plain, outer, dirty, untracked, ahead, noOrigin, ok]) rmSync(d, { recursive: true, force: true });
});

test("E1: verify compares every row with the committed blob sha, not the plan's own copy", { skip: SKIP }, async () => {
  const dir = crlfSnapshot();
  const plan = planMigration(dir, PEOPLE);
  const db = await freshDb();
  const out = await runMigration(db, plan, { rollback: true });
  assert.deepEqual(out.checks.filter((c) => !c.ok), []);
  // a plan whose shas came from the CRLF bytes (the old bug) is refused by verify
  const bytesSha = (/** @type {string} */ f) => gitBlobSha(readFileSync(path.join(dir, ...f.split("/"))));
  const wrong = { ...plan, docs: plan.docs.map((d) => ({ ...d, sha: bytesSha(d.src) })), recipes: plan.recipes.map((r) => ({ ...r, sha: bytesSha(r.path) })) };
  await assert.rejects(
    () => runMigration(db, wrong),
    (e) => e instanceof GateError && e.gate === "verify" && /docs equal their files/.test(e.message) && /bank equals its files/.test(e.message) && /plate sha/.test(e.message),
  );
  assert.equal((await db.query("select count(*)::int n from public.docs")).rows[0].n, 0, "rolled back");
  // and the committed run stores the blob shas
  await runMigration(db, plan);
  const row = (await db.query("select legacy_sha from public.docs where path = 'shopping.json'")).rows[0];
  assert.equal(row.legacy_sha, git(dir, "rev-parse", "HEAD:shopping.json").trim());
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---- item 2 (E2): a re-run refuses after any phone or server write, not only rev > 1

/** A migrated stand-in where mate-1 has signed in. */
async function migratedWithMate() {
  const dir = writeSnapshot();
  const plan = planMigration(dir, PEOPLE);
  const db = await freshDb();
  await runMigration(db, plan);
  await db.exec("insert into auth.users (email, email_confirmed_at) values ('mate-1@example.invalid', now())");
  const mate = (await db.query("select user_id from public.profiles where slug = 'mate-1'")).rows[0].user_id;
  return { db, plan, mate, dir };
}

/** @param {any} db @param {any} plan */
async function refusesRerun(db, plan) {
  await assert.rejects(
    () => runMigration(db, plan),
    (e) => e instanceof GateError && e.gate === "edited",
  );
}

test("E2 probe P3: a plan a phone created at rev 1 stops a re-run, and survives it", { skip: SKIP }, async () => {
  const { db, plan, mate, dir } = await migratedWithMate();
  const p = "profiles/mate-1/plans/2026-W44.json";
  const rev = (await asUser(db, mate, () => db.query("select public.write_doc($1, $2::jsonb, null) r", [p, JSON.stringify({ week: "2026-W44", entries: [] })]))).rows[0].r;
  assert.equal(Number(rev), 1, "a new file is rev 1, which the old gate did not count");
  await refusesRerun(db, plan);
  assert.equal((await db.query("select count(*)::int n from public.docs where path = $1", [p])).rows[0].n, 1, "the phone's file is still there");
  // told to overwrite, the re-run goes on (and the file is gone, as asked)
  await runMigration(db, plan, { overwriteEdits: true });
  assert.equal((await db.query("select count(*)::int n from public.docs where path = $1", [p])).rows[0].n, 0);
  // and a clean re-run after that is allowed again
  assert.equal((await runMigration(db, plan)).committed, true);
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("E2: a row the server wrote (no legacy_sha, no writer, rev 1) stops a re-run", { skip: SKIP }, async () => {
  const { db, plan, dir } = await migratedWithMate();
  // the shape svc.claim_guest leaves: inserted by service code, auth.uid() null
  await db.query("insert into public.docs (path, data) values ('profiles/mate-1/plans/2026-W45.json', '{}'::jsonb)");
  const row = (await db.query("select rev, updated_by, legacy_sha from public.docs where path = 'profiles/mate-1/plans/2026-W45.json'")).rows[0];
  assert.deepEqual([Number(row.rev), row.updated_by, row.legacy_sha], [1, null, null]);
  await refusesRerun(db, plan);
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

for (const [table, key] of [["recipes", "id"], ["docs", "path"]]) {
  test(`E2: a ${table} row at rev 1 with a legacy_sha but a writer stops a re-run`, { skip: SKIP }, async () => {
    const { db, plan, dir } = await migratedWithMate();
    // rev 1 and a legacy_sha, so only updated_by marks it. The triggers never
    // leave this shape (an update bumps rev, an insert pins the sha), so the
    // clause is a second lock: reach it with the triggers off (a bulk load, a
    // restore) to prove it holds on its own.
    await db.exec(`alter table public.${table} disable trigger user`);
    await db.query(`update public.${table} set updated_by = gen_random_uuid() where ${key} = (select min(${key}) from public.${table})`);
    await db.exec(`alter table public.${table} enable trigger user`);
    const row = (await db.query(`select rev, legacy_sha, updated_by from public.${table} where updated_by is not null`)).rows[0];
    assert.equal(Number(row.rev), 1);
    assert.ok(row.legacy_sha && row.updated_by, "the row carries both");
    await refusesRerun(db, plan);
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });
}

test("E2: a bank recipe edited on the server (rev 2) stops a re-run", { skip: SKIP }, async () => {
  const { db, plan, dir } = await migratedWithMate();
  await db.query("update public.recipes set data = data || '{\"note\":\"x\"}' where id = (select min(id) from public.recipes)");
  assert.equal((await db.query("select max(rev)::int r from public.recipes")).rows[0].r, 2);
  await refusesRerun(db, plan);
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("E2 probe P3: a roster rename by a member stops a re-run, and the name survives", { skip: SKIP }, async () => {
  const { db, plan, mate, dir } = await migratedWithMate();
  assert.equal((await db.query("select value from private.settings where key = 'roster_rev'")).rows[0].value, String((await db.query("select rev from public.roster_rev")).rows[0].rev), "the migration stores roster_rev");
  const cur = (await asUser(db, mate, () => db.query("select public.roster() r"))).rows[0].r;
  const mine = cur.profiles.find((/** @type {any} */ x) => x.id === "mate-1");
  const next = { profiles: [{ id: "mate-1", ...mine.roster, name: "Mate Renamed", household: mine.household, family: mine.family, admin: mine.admin }] };
  await asUser(db, mate, () => db.query("select public.write_doc('profiles.json', $1::jsonb, $2)", [JSON.stringify(next), cur.rev]));
  // no doc or recipe row moved: only the roster did
  assert.equal((await db.query("select count(*)::int n from public.docs where rev > 1 or updated_by is not null or legacy_sha is null")).rows[0].n, 0);
  await refusesRerun(db, plan);
  assert.equal((await db.query("select roster->>'name' n from public.profiles where slug = 'mate-1'")).rows[0].n, "Mate Renamed");
  await runMigration(db, plan, { overwriteEdits: true });
  assert.equal((await db.query("select roster->>'name' n from public.profiles where slug = 'mate-1'")).rows[0].n, "Mate");
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---- item 3 (E3): no cross-house oracle; write_doc is the only door

/** Probe P1: kin-1 (house-f only) writes into house-w a word hidden from house-w, a plain word, and into a house that does not exist. */
const P1 = [
  ["households/house-w/pantry-notes.json", { note: "with kinword" }],
  ["households/house-w/pantry-notes.json", { note: "with tea" }],
  ["households/house-zz/pantry-notes.json", { note: "with tea" }],
];

test("E3 probe P1, shape 1: direct insert and update are not granted; every probe answers alike", { skip: SKIP }, async () => {
  const { db, uid } = await world();
  for (const [priv, want] of [["SELECT", true], ["INSERT", false], ["UPDATE", false], ["DELETE", false]]) {
    assert.equal((await db.query("select has_table_privilege('authenticated', 'public.docs', $1) h", [priv])).rows[0].h, want, priv);
  }
  for (const [col, priv] of [["path", "INSERT"], ["data", "INSERT"], ["data", "UPDATE"]]) {
    assert.equal((await db.query("select has_column_privilege('authenticated', 'public.docs', $1, $2) h", [col, priv])).rows[0].h, false, `${priv} (${col})`);
  }
  const codes = [];
  for (const [p, data] of P1) {
    const e = await asUser(db, uid["kin-1"], () => errorOf(() => db.query("insert into public.docs (path, data) values ($1, $2)", [p, JSON.stringify(data)])));
    codes.push(e?.code);
  }
  assert.deepEqual(codes, ["42501", "42501", "42501"]);
  // the writer answers alike too
  const viaWriter = [];
  for (const [p, data] of P1) {
    viaWriter.push((await asUser(db, uid["kin-1"], () => errorOf(() => db.query("select public.write_doc($1, $2::jsonb, null)", [p, JSON.stringify(data)]))))?.code);
  }
  assert.deepEqual(viaWriter, ["P0403", "P0403", "P0403"]);
  // a direct update of a row the member CAN write is refused too (it skipped the rev check, E7)
  const own = await asUser(db, uid["mate-1"], () => errorOf(() => db.query("update public.docs set data = '{}' where path = 'profiles/mate-1/shopping.json'")));
  assert.equal(own?.code, "42501");
  // and the door still opens for the people it should: mate-1 creates and edits a house-w file
  const r1 = (await asUser(db, uid["mate-1"], () => db.query("select public.write_doc($1, $2::jsonb, null) r", [P1[1][0], JSON.stringify(P1[1][1])]))).rows[0].r;
  const r2 = (await asUser(db, uid["mate-1"], () => db.query("select public.write_doc($1, $2::jsonb, $3) r", [P1[1][0], '{"note":"with rice"}', r1]))).rows[0].r;
  assert.deepEqual([Number(r1), Number(r2)], [1, 2]);
  // the guard still speaks to a real writer
  assert.equal((await asUser(db, uid["mate-1"], () => errorOf(() => db.query("select public.write_doc($1, $2::jsonb, $3)", [P1[0][0], JSON.stringify(P1[0][1]), r2]))))?.code, "P0422");
  await db.close();
});

test("E3 probe P1, shape 2: should the grant come back, docs_before answers P0403 before the path or the guard speaks", { skip: SKIP }, async () => {
  const { db, uid } = await world();
  await db.exec("grant insert (path, data), update (data) on public.docs to authenticated");
  const codes = [];
  for (const [p, data] of P1) {
    codes.push((await asUser(db, uid["kin-1"], () => errorOf(() => db.query("insert into public.docs (path, data) values ($1, $2)", [p, JSON.stringify(data)]))))?.code);
  }
  assert.deepEqual(codes, ["P0403", "P0403", "P0403"]);
  // an update: RLS hides the row first; with the read and update policies
  // loosened as well, the trigger alone still refuses it
  const upd = "update public.docs set data = '{\"note\":\"x\"}' where path = 'households/house-w/events.json'";
  assert.equal((await asUser(db, uid["kin-1"], () => db.query(upd))).affectedRows, 0);
  await db.exec(`create policy loose on public.docs for update to authenticated using (true) with check (true);
                 create policy loose_read on public.docs for select to authenticated using (true)`);
  assert.equal((await asUser(db, uid["kin-1"], () => errorOf(() => db.query(upd))))?.code, "P0403");
  // a writer who may write it still meets the guard
  assert.equal((await asUser(db, uid["mate-1"], () => errorOf(() => db.query("insert into public.docs (path, data) values ($1, $2)", [P1[0][0], JSON.stringify(P1[0][1])]))))?.code, "P0422");
  // session-less writes (the migration, svc) are exempt from the check and keep their own answers
  assert.equal((await errorOf(() => db.query("insert into public.docs (path, data) values ($1, $2)", [P1[0][0], JSON.stringify(P1[0][1])])))?.code, "P0422");
  assert.match((await errorOf(() => db.query("insert into public.docs (path, data) values ($1, $2)", [P1[2][0], JSON.stringify(P1[2][1])])))?.message ?? "", /mise_bad_path/);
  await db.close();
});
