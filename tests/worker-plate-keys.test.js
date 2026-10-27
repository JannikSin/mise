// Mise 2.0 F2: the Worker's weekly probe carries a MIRROR of the plate
// fields (worker/src/plate-keys.js). The source of truth is PLATE_FIELDS in
// app/lib/plate-fields.js, built by the DB lane (plan item B2). Once that
// file exists on the integrated branch, this test fails the build on any
// difference, so the mirror cannot drift quietly.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PLATE_KEYS } from "../worker/src/plate-keys.js";

const SOURCE = fileURLToPath(new URL("../app/lib/plate-fields.js", import.meta.url));

test("the mirror matches the plan's PLATE_FIELDS list (section 4.1)", () => {
  assert.equal(PLATE_KEYS.length, 19);
  assert.equal(new Set(PLATE_KEYS).size, PLATE_KEYS.length);
  for (const owner of ["body", "goalWeightLb", "supplementPlan", "stores", "equipment"]) {
    assert.equal(PLATE_KEYS.includes(owner), false, `${owner} is owner-only`);
  }
});

test(
  "the mirror equals app/lib/plate-fields.js PLATE_FIELDS",
  { todo: existsSync(SOURCE) ? false : "OWNER schelkin: runs once the DB lane's plate-fields.js is merged onto wip-2.0" },
  async () => {
    if (!existsSync(SOURCE)) return;
    const mod = await import("../app/lib/plate-fields.js");
    const src = /** @type {any} */ (mod).PLATE_FIELDS;
    const keys = Array.isArray(src) ? src : Object.keys(src ?? {});
    assert.deepEqual([...keys].sort(), [...PLATE_KEYS].sort());
  },
);
