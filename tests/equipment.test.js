// What the kitchen can do (P6/P7), and the distinction the whole feature
// rests on: an UNDECLARED kitchen is offered everything, an EMPTY one is
// offered nothing it cannot cook. Collapsing those two silently empties
// somebody's week.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  EQUIPMENT,
  EQUIPMENT_IDS,
  canMake,
  capabilities,
  missingFor,
  normalizeEquipment,
  unlockCounts,
} from "../app/lib/equipment.js";

const BANK_DIR = new URL("../../mise-data/recipes/", import.meta.url);
const bank = () =>
  readdirSync(BANK_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(new URL(f, BANK_DIR), "utf8")));

test("an UNDECLARED kitchen can cook everything: nobody's week changes until they say", () => {
  assert.equal(canMake(null, ["oven", "dutch-oven"]), true);
  assert.equal(canMake(undefined, ["blender"]), true);
  assert.deepEqual(missingFor(null, ["oven"]), []);
});

test("an EMPTY declared kitchen is a different thing and means what it says", () => {
  assert.equal(canMake([], ["stovetop"]), false);
  assert.equal(canMake([], []), true, "a no-cook plate needs nothing");
  assert.deepEqual(missingFor([], ["oven", "pot"]), ["oven", "pot"]);
});

test("A DUTCH OVEN UNLOCKS DUTCH OVEN THINGS, and also counts as a pot", () => {
  // David's exact ask, both directions in one assertion
  assert.equal(canMake(["stovetop", "dutch-oven"], ["stovetop", "dutch-oven"]), true);
  assert.equal(canMake(["stovetop", "dutch-oven"], ["stovetop", "pot"]), true, "it IS a pot");
  assert.equal(canMake(["stovetop", "pot"], ["stovetop", "dutch-oven"]), false, "but a pot is not one");
});

test("substitution is one-directional, because volume is the point", () => {
  assert.equal(canMake(["pot"], ["saucepan"]), true, "a big pot does a small pot's job");
  assert.equal(canMake(["saucepan"], ["pot"]), false, "a saucepan does not do a stockpot's");
  assert.equal(canMake(["wok"], ["skillet"]), true);
  assert.equal(canMake(["toaster-oven"], ["oven"]), true);
});

test("an air fryer is deliberately NOT an oven", () => {
  // the substitution people most want and the one most likely to end with a
  // sheet pan that does not fit
  assert.equal(canMake(["air-fryer"], ["oven"]), false);
  assert.equal(canMake(["air-fryer"], ["sheet-pan"]), false);
});

test("capabilities expands owned items into everything they can do", () => {
  const c = capabilities(["dutch-oven", "wok"]);
  assert.ok(c.has("dutch-oven") && c.has("pot") && c.has("saucepan"));
  assert.ok(c.has("wok") && c.has("skillet"));
  assert.equal(capabilities(null).size, 0);
});

test("normalizeEquipment drops anything the app does not know", () => {
  // a typo must never silently exclude the entire bank
  assert.deepEqual(normalizeEquipment(["oven", "nonsense", "", null, "oven"]), ["oven"]);
  assert.deepEqual(normalizeEquipment("not an array"), []);
  assert.deepEqual(normalizeEquipment(null), []);
});

test("EVERY recipe in the live bank declares only equipment the app knows", () => {
  const unknown = [];
  for (const r of bank()) {
    for (const e of r.equipment ?? []) {
      if (!EQUIPMENT_IDS.has(e)) unknown.push(`${r.id}: ${e}`);
    }
  }
  assert.deepEqual(unknown, [], "a recipe requiring an unknown id can never be cooked by anyone");
});

test("THE FILTER IS NO LONGER INERT: a real dorm kitchen loses real recipes", () => {
  // Until 2026-08-22 not one bank recipe declared equipment, so the filter in
  // weekbuilder ran and excluded nothing, forever. This is the fence around
  // that: if the bank stops declaring, this goes red.
  const b = bank();
  const all = b.filter((r) => canMake(null, r.equipment)).length;
  assert.equal(all, b.length, "undeclared still gets everything");

  const microwaveOnly = b.filter((r) => canMake(["microwave"], r.equipment)).length;
  assert.ok(
    microwaveOnly < b.length / 2,
    `a microwave-only kitchen should lose most of the bank, got ${microwaveOnly}/${b.length}`,
  );
  const dinners = b.filter((r) => r.mealType === "dinner");
  assert.equal(
    dinners.filter((r) => canMake(["microwave"], r.equipment)).length,
    0,
    "no dinner in this bank is cookable with only a microwave, and the app must say so",
  );
});

test("unlockCounts answers 'is this worth buying' with a number", () => {
  const b = bank();
  const dorm = ["stovetop", "skillet", "saucepan", "pot", "microwave", "blender"];
  const u = unlockCounts(dorm, b);
  assert.ok(u.length > 0, "something must be worth adding to a dorm kitchen");
  for (const row of u) {
    assert.ok(row.unlocks > 0, "only things that actually unlock something are offered");
    assert.ok(EQUIPMENT_IDS.has(row.id));
    assert.ok(!dorm.includes(row.id), "never suggest what they already own");
  }
  // and the counts are real: adding the top item must genuinely raise the total
  const before = b.filter((r) => canMake(dorm, r.equipment)).length;
  const after = b.filter((r) => canMake([...dorm, u[0].id], r.equipment)).length;
  assert.equal(after - before, u[0].unlocks);
});

test("the Worker's copy of the vocabulary has not drifted from the app's", () => {
  // The Worker cannot import from app/, so it carries its own list to
  // validate what the onboarding chat records. Two lists that disagree mean
  // the survey can write an id the app will never satisfy.
  const lib = readFileSync(new URL("../worker/src/lib.js", import.meta.url), "utf8");
  const block = lib.slice(lib.indexOf("const EQUIPMENT_IDS = new Set(["));
  const ids = [...block.slice(0, block.indexOf("]);")).matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    ids.sort(),
    [...EQUIPMENT_IDS].sort(),
    "worker/src/lib.js EQUIPMENT_IDS and app/lib/equipment.js EQUIPMENT have drifted",
  );
});

test("every equipment entry has a label a human can act on", () => {
  for (const e of EQUIPMENT) {
    assert.ok(e.id && e.label, `${JSON.stringify(e)} is missing an id or label`);
    assert.notEqual(e.label, e.id, "the UI shows the label, so it must not be a slug");
  }
});
