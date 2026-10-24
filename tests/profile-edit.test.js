// YOUR PROFILE, EDITED (v1.8, P3; decision 0013). The survey's answers merge
// into the file; nothing the survey does not own may be lost (Tribunal plan
// gate: a rebuild would erase supplement ids Anvil shares, currencies, ...).
import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeProfileAnswers,
  outsideSafeBand,
  targetsFromQuestionnaire,
  SURVEY_OWNED,
} from "../app/lib/targets.js";
import { writeTargetsOf, TARGETS_PATH, LEGACY_TARGETS_PATH } from "../app/lib/store.js";

const EXISTING = {
  macros: { calories: 3700, caloriesFloor: 3500, protein: 190, proteinAim: 190, proteinCeiling: 215 },
  phase: "gain",
  phaseSince: "2026-10-12",
  diet: "pescatarian",
  allergens: ["peanuts"],
  avoidIngredients: ["peanut", "tempeh"],
  currencies: [{ id: "swipes", estCalories: 900, estProtein: 70 }],
  supplementPlan: [{ id: "creatine", dose: "5 g" }],
  proteinProvenance: "council 2026-10-12",
  targetReason: "gain phase",
  body: { sex: "m", age: 20, heightIn: 73, weightLb: 192.6, activity: 3, goalWeightLb: 215, waistIn: 32 },
  fixedSlots: [{ day: 1, slot: "lunch" }],
  slotAvoid: { snack: ["x"] },
  avoidRecipes: ["r1"],
  lastReviewed: "2026-10-01",
  nonNegotiables: ["sleep"],
  priorityStack: ["Protein"],
  sleepHoursTarget: 7,
  tracks: ["weight"],
  dailyDozen: { beans: 1 },
  mealSlots: ["lunch", "dinner"],
  adjustmentRule: "hand-written",
  somethingUnknown: { keep: true },
};

const fresh = (/** @type {any} */ over = {}) =>
  targetsFromQuestionnaire(
    { sex: "m", age: 20, heightFt: 6, heightIn: 1, weightLb: 193, activity: 3, goal: "gain" },
    "2026-10-18",
    { diet: "omnivore", allergens: ["peanuts"], allergensFreeText: "tempeh", ...over },
  );

test("a re-saved survey keeps every field it does not own", () => {
  const out = mergeProfileAnswers(EXISTING, fresh(), { calories: 3700, protein: 190, todayIso: "2026-10-18" });
  for (const k of ["currencies", "supplementPlan", "proteinProvenance", "targetReason", "fixedSlots", "slotAvoid", "avoidRecipes", "lastReviewed", "nonNegotiables", "priorityStack", "sleepHoursTarget", "tracks", "dailyDozen", "mealSlots", "adjustmentRule", "somethingUnknown"]) {
    assert.deepEqual(out[k], /** @type {any} */ (EXISTING)[k], `${k} survived`);
  }
  assert.deepEqual(out.macros, EXISTING.macros, "floors, aim and ceiling stay; the stated numbers stand");
  assert.equal(out.body.waistIn, 32, "a body key the survey does not ask about stays");
  assert.ok(out.avoidIngredients.includes("tempeh") && out.avoidIngredients.includes("peanut"));
});

test("owned answers change, and an answer back at its default is removed", () => {
  const out = mergeProfileAnswers(EXISTING, fresh(), { calories: 3800, protein: 195, todayIso: "2026-10-18" });
  assert.equal(out.diet, undefined, "omnivore is the default, so the old pescatarian goes");
  assert.equal(out.macros.calories, 3800);
  assert.equal(out.macros.protein, 195);
  for (const k of SURVEY_OWNED) assert.ok(k in out || /** @type {any} */ (fresh())[k] === undefined);
});

test("phaseSince moves only when the phase changes", () => {
  const same = mergeProfileAnswers(EXISTING, fresh(), { calories: 3700, protein: 190, todayIso: "2026-10-18" });
  assert.equal(same.phaseSince, "2026-10-12");
  const lossFresh = targetsFromQuestionnaire(
    { sex: "m", age: 20, heightFt: 6, heightIn: 1, weightLb: 193, activity: 3, goal: "loss" },
    "2026-10-18",
  );
  const moved = mergeProfileAnswers(EXISTING, lossFresh, { calories: 2500, protein: 170, todayIso: "2026-10-18" });
  assert.equal(moved.phase, "loss");
  assert.equal(moved.phaseSince, "2026-10-18");
});

test("a target far from the recommendation needs a reason, and the reason is kept", () => {
  assert.equal(outsideSafeBand(3700, 3300), false);
  assert.equal(outsideSafeBand(12000, 3300), true);
  assert.equal(outsideSafeBand(1500, 3300), true);
  const out = mergeProfileAnswers(EXISTING, fresh(), { calories: 6000, protein: 220, reason: "swim training block", todayIso: "2026-10-18" });
  assert.deepEqual(out.targetOverride, { reason: "swim training block", on: "2026-10-18", calories: 6000 });
});

test("the goal date lands in base; body numbers stay in body, not twice", () => {
  const out = mergeProfileAnswers(EXISTING, fresh(), {
    calories: 3700,
    protein: 190,
    todayIso: "2026-10-18",
    body: { weightLb: 194, heightIn: 73 },
    goalDate: "2027-05-01",
  });
  assert.deepEqual(out.base, { goal: { date: "2027-05-01" } });
  assert.equal(out.body.weightLb, 194);
  assert.equal(out.base.heightIn, undefined);
});

test("SAVE writes both mirrored files identically", async () => {
  /** @type {Record<string, any>} */
  const written = {};
  const merged = mergeProfileAnswers(EXISTING, fresh(), { calories: 3700, protein: 190, todayIso: "2026-10-18" });
  await writeTargetsOf("rowan", merged, async (path, data) => {
    written[path] = data;
  });
  const paths = Object.keys(written);
  assert.equal(paths.length, 2);
  assert.ok(paths.some((p) => p.endsWith(TARGETS_PATH)) && paths.some((p) => p.endsWith(LEGACY_TARGETS_PATH)));
  assert.deepEqual(written[paths[0]], written[paths[1]]);
});

test("Realist 2026-10-18: a save without body numbers leaves body exactly as it was (or absent)", () => {
  const noBody = { ...EXISTING };
  delete (/** @type {any} */ (noBody)).body;
  const out = mergeProfileAnswers(noBody, fresh({ budget: "tight" }), { calories: 2850, protein: 145, todayIso: "2026-10-18" });
  assert.equal(out.body, undefined, "no body numbers given, no body written");
  assert.equal(out.budget, "tight", "the other answers still save");
});
