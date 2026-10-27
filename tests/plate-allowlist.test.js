// Mise 2.0 B3: every targets key is classified exactly once, as plate card or
// owner-only, and the SQL projection names exactly the plate list (plan
// section 4.1, N1 / ENG L2-1). An unclassified key fails the build: the
// backstop for a cross-person read the grep did not see.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  PLATE_FIELDS,
  OWNER_ONLY_FIELDS,
  HAND_SET_FIELDS,
  PLATE_CURRENCY_KEYS,
  PLATE_MACROS_DROPPED,
  PLATE_MEAL_SLOT_DROPPED,
} from "../app/lib/plate-fields.js";
import { SURVEY_OWNED, BODY_OWNED, targetsFromQuestionnaire, mergeProfileAnswers } from "../app/lib/targets.js";
import { migrationFiles, freshDb, SKIP } from "./_pglite.js";

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));

/** @param {string} dir @returns {string[]} */
function targetsFixtures(dir) {
  /** @type {string[]} */
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...targetsFixtures(p));
    else if (name === "targets.json") out.push(p);
  }
  return out;
}

/** Every top-level key the app can put in a targets file, from every source. */
function everyKnownKey() {
  /** @type {Map<string, string>} key -> where it came from */
  const keys = new Map();
  const add = (/** @type {Iterable<string>} */ ks, /** @type {string} */ src) => {
    for (const k of ks) if (!keys.has(k)) keys.set(k, src);
  };
  add(SURVEY_OWNED, "SURVEY_OWNED");
  add(HAND_SET_FIELDS, "HAND_SET_FIELDS");
  // what the survey actually writes, every optional answer given
  const prefs = /** @type {any} */ ({
    diet: "vegan",
    allergens: ["peanut"],
    allergensFreeText: "kiwi",
    skipBreakfast: false,
    smoothie: true,
    snackAppetite: "meals",
    maxWeeknightMinutes: 30,
    dislikeIngredients: ["okra"],
    cuisinePrefs: { loved: ["thai"], avoided: [] },
    maxDifficulty: 2,
    equipment: ["blender"],
    breakfastStyle: "savory",
    budget: "tight",
    stores: ["store-a"],
    shopsPerWeek: 2,
    tiredOf: ["rice"],
    state: "IN",
    leftoverTolerance: "lots",
    packsLunch: true,
    lunchMicrowave: true,
    mealsOutPerWeek: 2,
  });
  const q = /** @type {any} */ ({ sex: "f", age: 40, heightFt: 5, heightIn: 6, weightLb: 160, activity: 3, goal: "loss", goalWeightLb: 140 });
  const fresh = targetsFromQuestionnaire(q, "2026-10-27", prefs);
  add(Object.keys(fresh), "targetsFromQuestionnaire");
  const merged = mergeProfileAnswers({ currencies: [] }, fresh, /** @type {any} */ ({
    calories: 2000,
    protein: 130,
    todayIso: "2026-10-27",
    reason: "a stated reason",
    body: { sex: "f" },
    goalDate: "2027-01-01",
  }));
  add(Object.keys(merged), "mergeProfileAnswers");
  for (const f of targetsFixtures(FIXTURES)) add(Object.keys(JSON.parse(readFileSync(f, "utf8"))), path.relative(FIXTURES, f));
  return keys;
}

test("the plate and owner-only lists do not overlap and have no repeats", () => {
  assert.equal(new Set(PLATE_FIELDS).size, PLATE_FIELDS.length);
  assert.equal(new Set(OWNER_ONLY_FIELDS).size, OWNER_ONLY_FIELDS.length);
  for (const k of PLATE_FIELDS) assert.equal(OWNER_ONLY_FIELDS.includes(k), false, k);
});

test("every targets key the app can write is classified", () => {
  const all = [...PLATE_FIELDS, ...OWNER_ONLY_FIELDS];
  for (const [k, src] of everyKnownKey()) assert.ok(all.includes(k), `unclassified targets key "${k}" (from ${src})`);
});

test("the body numbers stay owner-only", () => {
  assert.ok(OWNER_ONLY_FIELDS.includes("body"));
  for (const k of BODY_OWNED) assert.equal(PLATE_FIELDS.includes(k), false, k);
});

test("the SQL plate_of names exactly PLATE_FIELDS and the same trims", () => {
  const sql = migrationFiles()
    .map((m) => m.sql)
    .join("\n");
  // the LAST definition is the one that runs (a later migration may
  // `create or replace` it: allergen exceptions, 2026-10-27)
  const fn = sql.slice(sql.search(/create (or replace )?function private\.plate_of(?![\s\S]*create (or replace )?function private\.plate_of)/));
  const block = /-- PLATE_FIELDS\n([\s\S]*?)-- end PLATE_FIELDS/.exec(fn);
  assert.ok(block, "PLATE_FIELDS block in plate_of");
  const named = [...String(block[1]).matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...named].sort(), [...PLATE_FIELDS].sort());
  const body = fn.slice(0, fn.indexOf("$$;"));
  const currency = /ck in \(([^)]*)\)/.exec(body);
  assert.deepEqual(
    [...String(currency?.[1]).matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]).sort(),
    [...PLATE_CURRENCY_KEYS].sort(),
  );
  for (const k of PLATE_MACROS_DROPPED) assert.ok(body.includes(`e.value - '${k}'`), k);
  for (const k of PLATE_MEAL_SLOT_DROPPED) assert.ok(body.includes(`- '${k}'`), k);
});

test("the running SQL plate_of returns plate keys only, given every known key", { skip: SKIP }, async () => {
  const db = await freshDb();
  const doc = Object.fromEntries([...PLATE_FIELDS, ...OWNER_ONLY_FIELDS, ...everyKnownKey().keys()].map((k) => [k, 1]));
  const plate = (await db.query("select private.plate_of($1::jsonb) as p", [JSON.stringify(doc)])).rows[0].p;
  assert.deepEqual(Object.keys(plate).sort(), [...PLATE_FIELDS].sort());
  await db.close();
});
