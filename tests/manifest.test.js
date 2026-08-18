import test from "node:test";
import assert from "node:assert/strict";
import { composeManifest, manifestLines, SUBSYSTEMS } from "../app/lib/manifest.js";
import { generateWeek } from "../app/lib/weekbuilder.js";

// the smallest real generator run: enough recipes that a week can be built
const RECIPES = ["breakfast", "lunch", "dinner", "smoothie", "snack"].flatMap((meal) =>
  [1, 2, 3].map((n) => ({
    id: `${meal}-${n}`,
    name: `${meal} ${n}`,
    mealType: meal,
    servings: 1,
    nutrition: { calories: 500, protein: 30, carbs: 50, fat: 15 },
    ingredients: [{ qty: 100, unit: "g", food: `${meal} food ${n}` }],
    foodGroups: { beans: n % 2 },
  })),
);

const TARGETS = {
  macros: { calories: 3700, caloriesFloor: 3500, protein: 175, proteinFloor: 155 },
  phase: "gain",
  lastReviewed: "2026-08-18",
  dailyDozen: { beans: 3, greens: 2 },
};

function engineReport() {
  const { report } = generateWeek({
    recipes: RECIPES,
    targets: TARGETS,
    pantry: { items: [] },
    weekId: "2026-W40",
    plan: { week: "2026-W40", entries: [] },
    salt: 1,
  });
  return report;
}

test("generateWeek's report carries an engine manifest for every engine subsystem", () => {
  const report = engineReport();
  assert.ok(report.manifest, "report.manifest missing entirely");
  for (const key of ["budget", "useSoon", "philosophy", "macroTopUp", "floors"]) {
    assert.ok(report.manifest[key], `engine subsystem "${key}" reported nothing`);
  }
});

test("THE REGISTRY: every registered subsystem must report, or the build fails here", () => {
  const manifest = composeManifest({
    engine: engineReport().manifest,
    targets: TARGETS,
    recipes: RECIPES,
    dailyDays: [],
    recentPlans: [],
    todayIso: "2026-08-18",
  });
  const lines = manifestLines(manifest);
  assert.equal(lines.length, SUBSYSTEMS.length);
  const missing = lines.filter((l) => l.missing).map((l) => l.key);
  assert.deepEqual(
    missing,
    [],
    `subsystems reporting NOTHING: ${missing.join(", ")} — a silent subsystem is the fifth dark engine`,
  );
  for (const l of lines) {
    assert.ok(l.text.length > 0, `${l.key}: empty detail`);
  }
});

test("manifest says the honest thing when the data is missing", () => {
  const manifest = composeManifest({
    engine: engineReport().manifest,
    targets: TARGETS,
    recipes: RECIPES,
    dailyDays: [],
    recentPlans: [],
    todayIso: "2026-08-18",
  });
  // no weigh-ins: the weight trend announces its starvation, never sits silent
  assert.equal(manifest.subsystems.weightTrend.verdict, "no-data");
  assert.equal(manifest.subsystems.weightTrend.weighIns, 0);
  // no bodyweight: protein line says g/kg is unavailable rather than inventing it
  assert.equal(manifest.subsystems.protein.gPerKg, null);
  assert.match(manifestLines(manifest).find((l) => l.key === "protein")?.text ?? "", /no bodyweight/);
  // no cooked confirmations: adherence says so (Gardner's gate)
  assert.equal(manifest.subsystems.adherence.cookedOverPlanned, "0/0");
  // plating: inert by council, and the manifest keeps saying it
  assert.match(manifest.subsystems.plating.status, /inert by council 2026-08-12/);
  assert.equal(manifest.subsystems.plating.platedRecipes, 0);
});

test("manifest computes g/kg against the Morton band from the latest weigh-in", () => {
  const manifest = composeManifest({
    engine: engineReport().manifest,
    targets: TARGETS,
    recipes: RECIPES,
    dailyDays: [{ date: "2026-08-17", weight: 196 }],
    recentPlans: [],
    todayIso: "2026-08-18",
  });
  // 175 g at 196 lb (88.9 kg) = 1.97 g/kg, inside the Morton band
  assert.equal(manifest.subsystems.protein.gPerKg, 1.97);
  assert.deepEqual(manifest.subsystems.protein.mortonBand, [1.6, 2.2]);
  assert.equal(manifest.subsystems.protein.lastReviewed, "2026-08-18");
});

test("adherence line counts cooked-over-planned across recent weeks", () => {
  const plan = {
    week: "2026-W33",
    entries: [
      { id: "a", date: "2026-08-10", slot: "dinner", recipeId: "r", servings: 1, cookedAt: "x" },
      { id: "b", date: "2026-08-11", slot: "dinner", recipeId: "r", servings: 1 },
    ],
  };
  const manifest = composeManifest({
    engine: engineReport().manifest,
    targets: TARGETS,
    recipes: RECIPES,
    dailyDays: [],
    recentPlans: [{ weekId: "2026-W33", plan }],
    todayIso: "2026-08-18",
  });
  assert.equal(manifest.subsystems.adherence.cookedOverPlanned, "1/2");
});
