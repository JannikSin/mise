// Mise 2.0 (plan section 4.1): the top-level keys a plate card may carry, for
// the Worker's weekly privacy probe. MIRROR of PLATE_FIELDS in
// app/lib/plate-fields.js (the DB lane's file, the source of truth);
// tests/worker-plate-keys.test.js fails the build when the two differ, so
// this copy can never drift quietly. Kept here because the Worker bundle
// should not reach into the app tree.

export const PLATE_KEYS = Object.freeze([
  "diet",
  "allergens",
  "allergensFreeText",
  "allergenExceptions",
  "avoidIngredients",
  "avoidRecipes",
  "dislikeIngredients",
  "cuisinePrefs",
  "fixedSlots",
  "skipSlots",
  "mealSlots",
  "slotAvoid",
  "breakfastStyle",
  "snackStyle",
  "snackPortable",
  "dinnerAnchor",
  "phase",
  "weeklyBudgetUsd",
  "macros",
  "currencies",
]);
