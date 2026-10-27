// Mise 2.0: which targets fields other people may see (plan section 4.1).
// P8 plates, P3 knows-you. A cook needs a person's PLATE CARD to cook for them,
// split a pot and keep a dish safe for them; everything else in their targets
// stays with them and the admin (David's decision 1, 2026-10-27: plate cards
// for everyone, the family house included; full profiles for the admin only).
//
// Plain exported lists, no logic: `private.plate_of` in
// supabase/migrations/20261028090000_b2_writer_plate_roster_svc.sql must name
// exactly PLATE_FIELDS (tests/plate-allowlist.test.js parses it), and
// app/lib/plate-of.js is the JS port. Every targets key must sit in exactly one
// of PLATE_FIELDS and OWNER_ONLY_FIELDS; an unclassified key fails the build.

/** Top-level targets keys that go on the plate card. */
export const PLATE_FIELDS = Object.freeze([
  "diet",
  "allergens",
  "allergensFreeText",
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

/** `macros` keys left off the plate (every other macros key goes on it). */
export const PLATE_MACROS_DROPPED = Object.freeze(["waterLiters"]);

/** The keys a `currencies` item keeps on the plate. */
export const PLATE_CURRENCY_KEYS = Object.freeze([
  "id",
  "unit",
  "perWeek",
  "expires",
  "venue",
  "toGo",
  "preferredSlot",
]);

/** Keys removed from an object item of `mealSlots` on the plate. */
export const PLATE_MEAL_SLOT_DROPPED = Object.freeze(["note", "notes"]);

/** Top-level targets keys only the owner and the admin see. */
export const OWNER_ONLY_FIELDS = Object.freeze([
  "body",
  "goalWeightLb",
  "targetReason",
  "targetOverride",
  "region",
  "state",
  "supplementPlan",
  "priorityStack",
  "nonNegotiables",
  "dailyDozen",
  "sleepHoursTarget",
  "pushupsPerDay",
  "tracks",
  "proteinRule",
  "proteinProvenance",
  "proteinAimProvenance",
  "phaseExit",
  "phaseSince",
  "base",
  "budget",
  "stores",
  "shopsPerWeek",
  "buyDay",
  "lastReviewed",
  "adjustmentRule",
  "avoidIngredientsNote",
  "equipment",
  "maxWeeknightMinutes",
  "maxDifficulty",
  "snackAppetite",
  "mealsOutPerWeek",
  "tiredOf",
  "leftoverTolerance",
  "packsLunch",
  "lunchMicrowave",
  "skipBreakfast",
  "smoothie",
]);

/**
 * Fields the app writes into a targets file by hand outside the survey
 * (app/main.js 367 to 464 at 6ea52d8, the onboarding currencies, and the keys
 * Anvil and the provenance notes share). The allowlist test requires each to
 * be classified.
 */
export const HAND_SET_FIELDS = Object.freeze([
  "equipment",
  "weeklyBudgetUsd",
  "buyDay",
  "mealSlots",
  "skipSlots",
  "fixedSlots",
  "avoidRecipes",
  "currencies",
  "supplementPlan",
  "proteinProvenance",
  "proteinAimProvenance",
]);
