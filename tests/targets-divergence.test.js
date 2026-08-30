// THE TARGETS PAIR MAY NEVER DISAGREE (Historian, tribunal 2026-08-30).
//
// Second occurrence of this bug class: scorch (2026-08-29) wrote David's
// ordered fixes — proteinAim 190, the fixed-breakfast removal — ONLY to the
// legacy mirror `fitness/targets.json`, while the app reads the canonical
// `profile/targets.json` first (store.js readTargetsOf). The engine kept
// aiming at the 215 ceiling with a pinned breakfast for a full day, and
// nothing said so. (First occurrence: "210 g protein live in 5 places",
// DOCTRINE Article 5.) The mirror exists only for Anvil and Mise is the sole
// writer of both (writeTargetsOf), so the pair being byte-identical is an
// invariant, not a hope — this test is the armor the incident demanded.
//
// Reads REAL data, read-only, same precedent as equipment.test.js. Skips
// cleanly on a machine without the data checkout.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DATA = join(import.meta.dirname, "..", "..", "mise-data");

const PAIRS = [
  ["profile/targets.json", "fitness/targets.json"],
  ["profiles/elliot/profile/targets.json", "profiles/elliot/fitness/targets.json"],
  ["profiles/mom/profile/targets.json", "profiles/mom/fitness/targets.json"],
  ["profiles/dad/profile/targets.json", "profiles/dad/fitness/targets.json"],
  ["profiles/laurie/profile/targets.json", "profiles/laurie/fitness/targets.json"],
];

test("canonical and legacy targets never diverge (the scorch 08-29 incident)", (t) => {
  if (!existsSync(DATA)) return t.skip("mise-data checkout not present");
  let checked = 0;
  for (const [canonical, legacy] of PAIRS) {
    const cPath = join(DATA, canonical);
    const lPath = join(DATA, legacy);
    if (!existsSync(cPath) || !existsSync(lPath)) continue; // a profile may hold only one
    const c = JSON.parse(readFileSync(cPath, "utf8"));
    const l = JSON.parse(readFileSync(lPath, "utf8"));
    assert.deepEqual(
      c,
      l,
      `${canonical} and ${legacy} disagree — a session wrote one file of the pair. ` +
        `Every targets write goes through writeTargetsOf (store.js), which mirrors; ` +
        `hand edits must touch BOTH files identically.`,
    );
    checked++;
  }
  assert.ok(checked >= 1, "at least one pair exists to check");
});
