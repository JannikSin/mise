// Mise 2.0 G1: tools/migrate-to-supabase.mjs on a synthetic snapshot (plan
// section 6). The gates refuse before any write; the run is one transaction
// that verifies before it commits; a re-run is safe; it never names anyone.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { Buffer } from "node:buffer";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { planMigration, runMigration, GateError, gitBlobSha, guardHits } from "../tools/migrate-to-supabase.mjs";
import { freshDb, SKIP } from "./_pglite.js";
import { PEOPLE, writeSnapshot } from "./_snapshot.js";

const TOOL = fileURLToPath(new URL("../tools/migrate-to-supabase.mjs", import.meta.url));

/** @param {() => unknown} fn @param {string} gate */
function refuses(fn, gate) {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof GateError, String(e));
    assert.equal(/** @type {GateError} */ (e).gate, gate, String(e));
    return /** @type {GateError} */ (e);
  }
  assert.fail(`gate ${gate} did not refuse`);
}

test("git blob sha matches git's own", () => {
  // `printf 'hello\n' | git hash-object --stdin`
  assert.equal(gitBlobSha(Buffer.from("hello\n")), "ce013625030ba8dba906f756967f9e9ca394464a");
});

test("guard hits are whole-word and case-blind", () => {
  assert.equal(guardHits({ a: "Chamomile and CARDAMOM" }, ["cam", "mom"]), 0);
  assert.equal(guardHits({ a: "for Cam, from mom" }, ["cam", "mom"]), 2);
});

test("preflight classifies every file", () => {
  const plan = planMigration(writeSnapshot(), PEOPLE);
  assert.deepEqual(plan.kinds, {
    targets: 7,
    health: 1,
    plan: 3,
    shopping: 2,
    occasions: 1,
    pantry: 2,
    own_recipe: 1,
    events: 2,
    household: 1,
    house_recipe: 1,
    global: 1,
    prices: 2,
    pins: 2,
  });
  assert.deepEqual(plan.skipped, {
    "not-json": 1,
    "server-only": 3,
    "github-lane": 3,
    "workouts-activities": 1,
    "health-files": 1,
    "shadow-duplicate": 1,
  });
  assert.equal(plan.recipes.length, 3);
  assert.equal(Object.keys(plan.sha256).length, plan.fileCount);
  // each house without its own prices file gets the root copy
  assert.ok(plan.docs.some((d) => d.path === "households/house-w/prices.json"));
  assert.equal(plan.docs.filter((d) => d.path === "households/house-f/prices.json").length, 1);
});

test("scrub gate: refuses while any shared recipe carries a person's name", () => {
  for (const [file, word] of [
    ["recipes/soup.json", "Kinword's soup"],
    ["recipes-staging/stew.json", "Mateword stew"],
    ["recipes/tea.json", "kinfolkname tea"],
  ]) {
    const dir = writeSnapshot((f) => {
      f[file] = { ...(/** @type {any} */ (f[file])), name: word };
    });
    const e = refuses(() => planMigration(dir, PEOPLE), "scrub");
    assert.equal(/kinword|mateword|kinfolk/i.test(e.message), false, "the message is counts only");
    assert.deepEqual(e.paths, [file]);
  }
});

test("name guard gate: a family word in a file the shared house reads", () => {
  // the root profile is in both houses, so its plan reaches house-w
  const dir = writeSnapshot((f) => {
    f["plans/2026-W40.json"] = { week: "2026-W40", entries: [{ note: "kinword" }] };
  });
  refuses(() => planMigration(dir, PEOPLE), "name-guard");
  // and on a plate the shared house can see
  const dir2 = writeSnapshot((f) => {
    f["profiles/guest-1/profile/targets.json"] = { diet: "vegan", avoidRecipes: ["kinword-pie"] };
  });
  refuses(() => planMigration(dir2, PEOPLE), "name-guard");
});

test("the other gates: unmapped, bad bank id, unparsable, people, admin, freeze", () => {
  refuses(() => planMigration(writeSnapshot((f) => (f["notes/x.json"] = {})), PEOPLE), "unmapped");
  refuses(() => planMigration(writeSnapshot((f) => (f["recipes/soup.json"] = { id: "other" })), PEOPLE), "bank");
  refuses(() => planMigration(writeSnapshot((f) => (f["shopping.json"] = "{not json")), PEOPLE), "parse");
  refuses(() => planMigration(writeSnapshot(), { ...PEOPLE, people: PEOPLE.people.slice(0, 3) }), "people");
  refuses(() => planMigration(writeSnapshot(), { ...PEOPLE, admin: "mate-1" }), "admin");
  refuses(() => planMigration(writeSnapshot(), PEOPLE, { final: true }), "freeze");
  planMigration(writeSnapshot((f) => (f["freeze.json"] = { frozen: true })), PEOPLE, { final: true });
  // worker fix loop 1, item 16 (E6b): an UNFREEZE leaves the file; it must not pass
  for (const marker of [{ frozen: false, at: "2026-11-01T15:00:00.000Z", by: "host-1" }, {}, { frozen: "true" }]) {
    refuses(() => planMigration(writeSnapshot((f) => (f["freeze.json"] = marker)), PEOPLE, { final: true }), "freeze");
  }
});

test("migration into the stand-in: verified, committed, plates from the canonical file", { skip: SKIP }, async () => {
  const db = await freshDb();
  const plan = planMigration(writeSnapshot(), PEOPLE);
  const out = await runMigration(db, plan);
  assert.equal(out.committed, true);
  assert.deepEqual(out.checks.filter((c) => !c.ok), []);
  const plates = (await db.query("select p.slug, pl.legacy_sha from public.plates pl join public.profiles p on p.id = pl.profile_id order by 1")).rows;
  assert.deepEqual(plates.map((/** @type {any} */ r) => r.slug), ["guest-1", "kin-1", "mate-1", "owner-1"]);
  const canon = plan.docs.find((d) => d.path === "profiles/mate-1/profile/targets.json");
  assert.equal(plates.find((/** @type {any} */ r) => r.slug === "mate-1").legacy_sha, canon?.sha);
  // no auth users made; invite emails waiting; no passkey hash imported
  assert.equal((await db.query("select count(*)::int n from auth.users")).rows[0].n, 0);
  assert.equal((await db.query("select count(*)::int n from private.pending_links")).rows[0].n, 3);
  const roster = (await db.query("select roster from public.profiles where slug = 'owner-1'")).rows[0].roster;
  assert.deepEqual(roster, { name: "Owner", emoji: "x" });
  const fam = (await db.query("select family, h.slug as home from public.profiles p left join public.households h on h.id = p.home_household where p.slug = 'kin-1'")).rows[0];
  assert.deepEqual(fam, { family: "house-f", home: "house-f" });
  await db.close();
});

test("an invite links the person, and the admin becomes admin; a re-run keeps the links", { skip: SKIP }, async () => {
  const db = await freshDb();
  const plan = planMigration(writeSnapshot(), PEOPLE);
  await runMigration(db, plan);
  // fix loop 1 F4: an unconfirmed account links nothing; confirming it links
  await db.exec("insert into auth.users (email) values ('Owner-1@example.invalid'), ('mate-1@example.invalid'), ('stranger@example.invalid')");
  assert.equal((await db.query("select count(*)::int n from public.profiles where user_id is not null")).rows[0].n, 0);
  assert.equal((await db.query("select count(*)::int n from public.admins")).rows[0].n, 0);
  await db.exec("update auth.users set email_confirmed_at = now()");
  const linked = (await db.query("select slug from public.profiles where user_id is not null order by 1")).rows.map((/** @type {any} */ r) => r.slug);
  assert.deepEqual(linked, ["mate-1", "owner-1"]);
  assert.equal((await db.query("select count(*)::int n from public.admins")).rows[0].n, 1);
  // the re-run before anyone edits: same state, links kept
  const again = await runMigration(db, plan);
  assert.equal(again.committed, true);
  assert.equal((await db.query("select count(*)::int n from public.profiles where user_id is not null")).rows[0].n, 2);
  assert.equal((await db.query("select count(*)::int n from public.admins")).rows[0].n, 1);
  await db.close();
});

test("a re-run refuses to overwrite a phone's edit unless told to", { skip: SKIP }, async () => {
  const db = await freshDb();
  const plan = planMigration(writeSnapshot(), PEOPLE);
  await runMigration(db, plan);
  await db.exec(`update public.docs set data = '{"items":[1]}' where path = 'shopping.json'`);
  await assert.rejects(() => runMigration(db, plan), (e) => e instanceof GateError && e.gate === "edited");
  const out = await runMigration(db, plan, { overwriteEdits: true });
  assert.equal(out.committed, true);
  await db.close();
});

test("rollback leaves nothing; the database's own guard stops a run the preflight missed", { skip: SKIP }, async () => {
  const db = await freshDb();
  const plan = planMigration(writeSnapshot(), PEOPLE);
  const out = await runMigration(db, plan, { rollback: true });
  assert.equal(out.committed, false);
  assert.equal((await db.query("select count(*)::int n from public.docs")).rows[0].n, 0);
  // hand the database a plan whose shared-house file names a family word
  const bad = { ...plan, docs: plan.docs.map((d) => (d.path === "households/house-w/events.json" ? { ...d, data: { note: "kinword" } } : d)) };
  await assert.rejects(() => runMigration(db, bad), /mise_name_guard/);
  assert.equal((await db.query("select count(*)::int n from public.profiles")).rows[0].n, 0, "the whole run rolled back");
  await db.close();
});

test("CLI: counts only, never a slug, and a local rehearsal into PGlite", { skip: SKIP }, () => {
  const dir = writeSnapshot();
  const tmp = mkdtempSync(path.join(tmpdir(), "mise-people-"));
  const peopleFile = path.join(tmp, "people.local.json");
  writeFileSync(peopleFile, JSON.stringify(PEOPLE));
  const dry = spawnSync(process.execPath, [TOOL, "--snapshot", dir, "--people", peopleFile, "--dry-run"], { encoding: "utf8" });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /preflight ok/);
  for (const name of ["owner-1", "mate-1", "kin-1", "guest-1", "house-w", "kinword"]) assert.equal(dry.stdout.includes(name), false, name);
  const run = spawnSync(process.execPath, [TOOL, "--snapshot", dir, "--people", peopleFile, "--target", "pglite"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(run.stdout, /FAIL/);
  const live = spawnSync(process.execPath, [TOOL, "--snapshot", dir, "--people", peopleFile, "--target", "live"], { encoding: "utf8" });
  assert.equal(live.status, 2, "the real targets are not wired");
  const bad = writeSnapshot((f) => (f["recipes/soup.json"] = { id: "soup", name: "kinword soup" }));
  const refused = spawnSync(process.execPath, [TOOL, "--snapshot", bad, "--people", peopleFile, "--dry-run"], { encoding: "utf8" });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /REFUSED scrub/);
  assert.equal(refused.stderr.includes("soup"), false, "no path without --show-paths");
  rmSync(tmp, { recursive: true, force: true });
});
