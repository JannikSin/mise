// Mise 2.0 db fix loop 3 (Engineer review of the db slice,
// terrigen-db-fixlist-3.md): the reviewer's probes as regression cases.
// Made-up people and words only.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, unlinkSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { freshDb, SKIP } from "./_pglite.js";
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
