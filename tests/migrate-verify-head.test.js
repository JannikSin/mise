// gate20 Realist R4: a write that reaches GitHub after the snapshot is caught
// before anyone signs in to Supabase.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyHead, GateError } from "../tools/migrate-to-supabase.mjs";

const git = (/** @type {string} */ dir, /** @type {string[]} */ args) =>
  execFileSync("git", ["-C", dir, "-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

test("verifyHead passes while main is the snapshot's commit, refuses once a late write lands", () => {
  const root = mkdtempSync(join(tmpdir(), "verify-head-"));
  const remote = join(root, "remote.git");
  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", remote]);
  const seed = join(root, "seed");
  execFileSync("git", ["clone", "--quiet", remote, seed], { stdio: "ignore" });
  writeFileSync(join(seed, "profiles.json"), "{}\n");
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "--quiet", "-m", "seed"]);
  git(seed, ["push", "--quiet", "origin", "HEAD:main"]);
  const snap = join(root, "snap");
  execFileSync("git", ["clone", "--quiet", remote, snap], { stdio: "ignore" });
  const head = git(snap, ["rev-parse", "HEAD"]);
  assert.equal(verifyHead(snap, head), head);
  // a phone on a cached 1.96 page writes after the snapshot
  writeFileSync(join(seed, "shopping.json"), '{"items":[1]}\n');
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "--quiet", "-m", "late write"]);
  git(seed, ["push", "--quiet", "origin", "HEAD:main"]);
  assert.throws(() => verifyHead(snap, head), (e) => e instanceof GateError && /moved after the snapshot/.test(e.message));
  assert.throws(() => verifyHead(snap, "not-a-sha"), GateError);
});
