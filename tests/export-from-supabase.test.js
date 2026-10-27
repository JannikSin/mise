// Mise 2.0 G2: the reverse export (tools/export-from-supabase.mjs), as a round
// trip on the synthetic snapshot through PGlite: migrate, take a database
// snapshot, export back to files. Merged into the old tree the files come back
// byte for byte; a fresh tree differs only in the four named ways.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { planMigration, runMigration, walk } from "../tools/migrate-to-supabase.mjs";
import { takeSnapshot, snapshotSql, parseSnapshot, SNAPSHOT_TABLES } from "../tools/db-snapshot.mjs";
import { exportInto, orderLike, serialize, managedPath } from "../tools/export-from-supabase.mjs";
import { freshDb, SKIP } from "./_pglite.js";
import { PEOPLE, writeSnapshot } from "./_snapshot.js";

const TOOL = fileURLToPath(new URL("../tools/export-from-supabase.mjs", import.meta.url));

/** Files the migration does not move (plan section 6 step 4), by name in the synthetic snapshot. */
const NOT_MIGRATED = [
  "README.md",
  "meta.json",
  "invites.json",
  "guests.json",
  "fitness/targets.json",
  "fitness/daily.json",
  "health/vitals.json",
  "profiles/mate-1/fitness/workouts.json",
  "profiles/kin-1/health/vitals.json",
  "profiles/mate-1/recipes/soup.json", // the shadow duplicate of recipes/soup.json
];

const tmp = (/** @type {string} */ p) => mkdtempSync(path.join(tmpdir(), p));
const bytes = (/** @type {string} */ dir, /** @type {string} */ p) => readFileSync(path.join(dir, ...p.split("/")));

/** A migrated stand-in and its snapshot. */
async function migrated() {
  const src = writeSnapshot();
  const db = await freshDb();
  await runMigration(db, planMigration(src, PEOPLE));
  return { src, db };
}

/** A copy of the source tree, frozen (the D2 freeze marker), as the rollback target. */
function frozenCopy(/** @type {string} */ src) {
  const dir = tmp("mise-rollback-");
  cpSync(src, dir, { recursive: true });
  writeFileSync(path.join(dir, "freeze.json"), serialize({ frozen: true }));
  return dir;
}

test("orderLike keeps the template's key order, new keys last, values untouched", () => {
  const v = { b: 2, a: { y: 1, x: 2 }, c: [{ q: 1, p: 2 }] };
  const t = { a: { x: 0, y: 0 }, b: 0, c: [{ p: 0 }] };
  assert.equal(JSON.stringify(orderLike(v, t)), '{"a":{"x":2,"y":1},"b":2,"c":[{"p":2,"q":1}]}');
  assert.equal(serialize({ a: 1 }), '{\n  "a": 1\n}\n');
});

test("managedPath: the database owns migrated paths only", () => {
  const world = { households: ["house-w"], profiles: ["owner-1", "mate-1"], rootProfile: "owner-1" };
  for (const p of ["recipes/soup.json", "prices.json", "plans/2026-W40.json", "profiles/mate-1/shopping.json", "households/house-w/events.json"]) {
    assert.equal(managedPath(p, world), true, p);
  }
  for (const p of ["profiles.json", "freeze.json", "meta.json", "fitness/daily.json", "profiles/mate-1/fitness/workouts.json", "README.md", "notes/x.json", "profiles/gone-1/shopping.json"]) {
    assert.equal(managedPath(p, world), false, p);
  }
});

test("the snapshot SQL covers every table in public and private", { skip: SKIP }, async () => {
  const db = await freshDb();
  const all = (await db.query("select table_schema || '.' || table_name as t from information_schema.tables where table_schema in ('public','private') and table_type = 'BASE TABLE' order by 1")).rows.map((/** @type {any} */ r) => r.t);
  assert.deepEqual([...SNAPSHOT_TABLES.map(([t]) => t)].sort(), all);
  const snap = await takeSnapshot(db);
  assert.equal(snap.tables["public.roster_rev"]?.length, 1);
  assert.ok(snap.columns["public.docs"]?.includes("legacy_sha"));
  assert.throws(() => parseSnapshot("age-encryption.org/v1"), /not JSON/);
  assert.throws(() => parseSnapshot(JSON.stringify({ format: "other" })), /format/);
  assert.match(snapshotSql(), /^-- Mise 2.0 snapshot/);
  await db.close();
});

test("round trip, merged into the frozen tree: every file byte for byte, nothing written", { skip: SKIP }, async () => {
  const { src, db } = await migrated();
  const snap = await takeSnapshot(db);
  const dir = frozenCopy(src);
  const rep = exportInto(snap, dir, { write: true, requireFreeze: true });
  assert.deepEqual({ write: rep.write, create: rep.create, removed: rep.removed, conflicts: rep.conflicts }, { write: [], create: [], removed: [], conflicts: [] });
  const files = walk(src);
  assert.deepEqual(walk(dir), [...files, "freeze.json"].sort());
  for (const f of files) assert.ok(bytes(dir, f).equals(bytes(src, f)), f);
  await db.close();
});

test("round trip into a fresh tree: only the four named differences", { skip: SKIP }, async () => {
  const { src, db } = await migrated();
  const snap = await takeSnapshot(db);
  const out = path.join(tmp("mise-fresh-"), "tree");
  exportInto(snap, out, { write: true });
  // 2: exactly the skipped files are absent; 4: no per-house copies appear
  const expected = walk(src).filter((f) => !NOT_MIGRATED.includes(f));
  assert.deepEqual(walk(out), expected);
  assert.equal(existsSync(path.join(out, "households/house-w/prices.json")), false, "a copy folds back into the root file");
  assert.equal(existsSync(path.join(out, "households/house-f/pins.json")), false);
  let identical = 0;
  for (const f of expected) {
    const orig = JSON.parse(bytes(src, f).toString("utf8"));
    const got = JSON.parse(bytes(out, f).toString("utf8"));
    if (f === "profiles.json") {
      // 3: passkey never imported; same rows, same order, same values
      const want = { profiles: orig.profiles.map((/** @type {any} */ r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== "passkey" && k !== "adminKey"))) };
      assert.deepEqual(got, want);
      assert.deepEqual(got.profiles.map((/** @type {any} */ r) => r.id), ["owner-1", "mate-1", "kin-1", "guest-1"]);
      continue;
    }
    assert.deepEqual(got, orig, f);
    // 1: the only byte difference left is key order
    assert.equal(serialize(orderLike(got, orig)), bytes(src, f).toString("utf8"), f);
    if (bytes(out, f).equals(bytes(src, f))) identical++;
  }
  assert.ok(identical > 0);
  await db.close();
});

test("after edits in the database: only the edited files change, in the old key order", { skip: SKIP }, async () => {
  const { src, db } = await migrated();
  await db.exec(`
    update public.docs set data = '{"items":[{"food":"rice","qty":1}]}' where path = 'shopping.json';
    update public.docs set data = '{"pins":["soup"]}' where path = 'households/house-f/pins.json';
    update public.recipes set data = data || '{"time": 20}' where id = 'tea';
    insert into public.docs (path, data) values ('profiles/mate-1/plans/2026-W41.json', '{"week":"2026-W41","entries":[]}');
    delete from public.docs where path = 'occasions.json';
    update public.profiles set roster = roster || '{"name":"Mate Two"}' where slug = 'mate-1';`);
  const snap = await takeSnapshot(db);
  const dir = frozenCopy(src);
  const rep = exportInto(snap, dir, { requireFreeze: true });
  assert.deepEqual(rep.write.sort(), ["profiles.json", "recipes/tea.json", "shopping.json"]);
  assert.deepEqual(rep.create.sort(), ["households/house-f/pins.json", "profiles/mate-1/plans/2026-W41.json"]);
  assert.deepEqual(rep.removed, ["occasions.json"]);
  assert.equal(readFileSync(path.join(dir, "shopping.json"), "utf8"), bytes(src, "shopping.json").toString("utf8"), "a dry run writes nothing");

  exportInto(snap, dir, { write: true, requireFreeze: true });
  assert.equal(existsSync(path.join(dir, "occasions.json")), true, "kept without --prune");
  const tea = readFileSync(path.join(dir, "recipes/tea.json"), "utf8");
  assert.equal(tea, serialize({ id: "tea", name: "Chamomile and cardamom tea", time: 20 }), "old keys in the old order, the new one last");
  const prof = JSON.parse(readFileSync(path.join(dir, "profiles.json"), "utf8"));
  const orig = JSON.parse(bytes(src, "profiles.json").toString("utf8"));
  assert.equal(prof.profiles[1].name, "Mate Two");
  assert.deepEqual(Object.keys(prof.profiles[1]), Object.keys(orig.profiles[1]));
  assert.deepEqual(prof.profiles[0], orig.profiles[0], "an unchanged row keeps its passkey and its bytes");
  for (const f of walk(src).filter((x) => !["profiles.json", "recipes/tea.json", "shopping.json"].includes(x))) {
    assert.ok(bytes(dir, f).equals(bytes(src, f)), f);
  }
  exportInto(snap, dir, { write: true, prune: true, requireFreeze: true });
  assert.equal(existsSync(path.join(dir, "occasions.json")), false, "--prune deletes it");
  // and a second run is a no-op
  const again = exportInto(snap, dir, { requireFreeze: true });
  assert.deepEqual([again.write, again.create, again.removed], [[], [], []]);
  await db.close();
});

test("refusals: no freeze marker, and a file that moved on GitHub after the migration", { skip: SKIP }, async () => {
  const { src, db } = await migrated();
  const snap = await takeSnapshot(db);
  const unfrozen = tmp("mise-unfrozen-");
  cpSync(src, unfrozen, { recursive: true });
  assert.throws(() => exportInto(snap, unfrozen, { requireFreeze: true }), /freeze\.json is not in the target/);
  const dir = frozenCopy(src);
  writeFileSync(path.join(dir, "pantry.json"), serialize({ items: [{ food: "late github write" }] }));
  assert.throws(() => exportInto(snap, dir, { write: true, requireFreeze: true }), /changed on GitHub after the migration/);
  assert.match(readFileSync(path.join(dir, "pantry.json"), "utf8"), /late github write/, "a refusal writes nothing");
  const rep = exportInto(snap, dir, { write: true, requireFreeze: true, preferDatabase: true });
  assert.deepEqual(rep.conflicts, ["pantry.json"]);
  assert.ok(bytes(dir, "pantry.json").equals(bytes(src, "pantry.json")));
  await db.close();
});

test("CLI: dry run by default, counts only, a fresh --out must be empty", { skip: SKIP }, async () => {
  const { src, db } = await migrated();
  const snap = await takeSnapshot(db);
  await db.close();
  const work = tmp("mise-export-cli-");
  const snapFile = path.join(work, "now.json");
  writeFileSync(snapFile, JSON.stringify(snap));
  const dir = frozenCopy(src);
  writeFileSync(path.join(dir, "shopping.json"), serialize({ items: [9] }));
  // the file changed on disk but not in the database: a conflict, refused, names no path
  const r = spawnSync(process.execPath, [TOOL, "--snapshot", snapFile, "--merge-into", dir], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.equal(r.stderr.includes("shopping"), false);
  const ok = spawnSync(process.execPath, [TOOL, "--snapshot", snapFile, "--merge-into", dir, "--prefer-database"], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /would write 1 changed file/);
  assert.match(ok.stdout, /dry run/);
  for (const name of ["owner-1", "mate-1", "kin-1", "guest-1", "house-w", "shopping"]) assert.equal(ok.stdout.includes(name), false, name);
  assert.match(readFileSync(path.join(dir, "shopping.json"), "utf8"), /9/, "dry run");
  const full = tmp("mise-export-full-");
  mkdirSync(path.join(full, "x"));
  const refused = spawnSync(process.execPath, [TOOL, "--snapshot", snapFile, "--out", full, "--write"], { encoding: "utf8" });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /new or empty directory/);
});
