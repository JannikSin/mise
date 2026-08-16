import test from "node:test";
import assert from "node:assert/strict";
import {
  dinerFacts,
  expandAvoid,
  screenTextForDiners,
  unconfirmedReason,
  resultHumanText,
} from "../app/lib/annotate.js";

// The failure this pins (P2 gate2 C1): a failed targets read used to collapse
// into avoid:[] — indistinguishable from a clean profile — so an offline or
// corrupt profile looked allergy-free to every AI surface.

test("a FAILED read is unconfirmed, never a clean empty avoid list", () => {
  const failed = dinerFacts("mom", "Mom", null);
  assert.equal(failed.unconfirmed, true, "null (read/parse failure) must be distinguishable");
  assert.deepEqual(failed.avoid, []);

  const clean = dinerFacts("mom", "Mom", {});
  assert.equal(clean.unconfirmed, false, "a read that succeeded with no restrictions is clean");
  assert.deepEqual(clean.avoid, []);
});

test("a real targets file maps through unchanged", () => {
  const t = {
    phase: "gain",
    macros: { calories: 3700, protein: 210 },
    diet: "omnivore",
    avoidIngredients: ["peanut", "shrimp"],
    avoidRecipes: ["office-lunch-box"],
  };
  assert.deepEqual(dinerFacts("david", "David", t), {
    id: "david",
    name: "David",
    goal: "gain",
    calories: 3700,
    protein: 210,
    diet: "omnivore",
    avoid: ["peanut", "shrimp"],
    avoidRecipes: ["office-lunch-box"],
    unconfirmed: false,
  });
});

// ---- the untruncated client screen (P2 gate2 C2) ---------------------------

test("expandAvoid reaches the derivatives model recall would miss", () => {
  const terms = expandAvoid(["tree nut"]);
  assert.ok(terms.includes("pecan"), "the pecan case from the gate verdict");
  assert.ok(terms.includes("marzipan"));
  assert.ok(expandAvoid(["wheat"]).includes("soy sauce"), "soy sauce is half wheat");
  assert.ok(expandAvoid(["fish"]).includes("worcestershire"));
  assert.deepEqual(expandAvoid([]), []);
});

test("a diner past the Worker's 20-term cap still catches the 21st term (C2)", () => {
  // the Worker's sanitizePeople slices avoid at 20; this screen must not
  const avoid = [...Array.from({ length: 20 }, (_, i) => `filler-${i}`), "pecan"];
  const hits = screenTextForDiners("fold the toasted pecans into the batter", [
    { id: "m", name: "Mom", avoid },
  ]);
  assert.deepEqual(hits, ["Mom: pecan"]);
});

test("the medical-preset expansion catches a derivative in the scanned text", () => {
  const hits = screenTextForDiners("finish with a spoon of tahini", [
    { id: "d", name: "Dana", avoid: ["sesame"] },
  ]);
  assert.equal(hits.length, 1);
  assert.ok(hits[0].startsWith("Dana:"));
  assert.ok(hits[0].includes("tahini"));
});

test("unconfirmedReason refuses the scan for an unread profile (C1), and only then", () => {
  const failed = dinerFacts("mom", "Mom", null);
  const clean = dinerFacts("laurie", "Laurie", {});
  assert.ok(unconfirmedReason([failed, clean]).includes("Mom"));
  assert.equal(unconfirmedReason([clean]), "");
});

// ---- Tribunal final-gate fix: the screen reads HUMAN text (ENG F1) ---------

test("resultHumanText never carries JSON keys: 'nut' must not fire on 'nutrition'", () => {
  const result = {
    title: "Beef Chili",
    ingredients: [{ food: "ground beef", grams: 500 }],
    steps: [
      {
        n: 1,
        title: "Brown",
        text: "Brown the beef hard.",
        notes: ["crust is flavor"],
        temps: [{ label: "done-egg", unit: "C", fromSource: false, value: 71 }],
      },
    ],
    nutrition: { calories: 500, protein: 40, carbs: 30, fat: 20 },
    summary: ["everything in grams"],
    planFit: [],
    allergensFound: [],
  };
  const text = resultHumanText(result);
  assert.ok(!text.includes("nutrition"), "schema keys stay out of the screened text");
  assert.ok(!text.includes("done-egg"), "temp labels stay out too");
  assert.equal(screenTextForDiners(text, [{ id: "m", name: "Mom", avoid: ["nut"] }]).length, 0);
  assert.equal(screenTextForDiners(text, [{ id: "d", name: "Dana", avoid: ["egg"] }]).length, 0);
  // a REAL hit in an ingredient food still fires
  const hits = screenTextForDiners(text, [{ id: "b", name: "Ben", avoid: ["beef"] }]);
  assert.equal(hits.length, 1);
});

test("expandAvoid pushes the canonical alias term: 'eggs' also screens 'egg'", () => {
  assert.ok(expandAvoid(["eggs"]).includes("egg"));
  assert.ok(expandAvoid(["dairy"]).includes("milk"));
  assert.ok(expandAvoid(["milk"]).includes("mozzarella"), "named cheeses are reachable");
});
