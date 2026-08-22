// Neutral food facts, and the traps this codebase has already paid for once.
//
// The P8 unparking found three first-match keyword bugs in an hour: black
// pepper classified as a vegetable, beef broth as beef, rice vinegar as rice,
// green beans as a starch. Every one was a first-match list resolving a
// specific name on a generic substring. This module is longest-match-first
// for that reason, and these tests are the fence around it.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import {
  isAddedSugar,
  isProcessedRedMeat,
  isRefinedGrain,
  isWholeGrain,
  plantSpeciesOf,
  processingTier,
  proteinSourceOf,
} from "../app/lib/foodclass.js";
import { partOf } from "../app/lib/synth.js";

const BANK_DIR = new URL("../../mise-data/recipes/", import.meta.url);

test("THE SUBSTRING TRAP: a specific name always beats a generic one", () => {
  // every pair here is a real food in the live bank whose generic substring
  // would give the wrong answer under a first-match list
  assert.equal(isWholeGrain("whole wheat pasta"), true);
  assert.equal(isRefinedGrain("whole wheat pasta"), false, "'pasta' must not win over 'whole wheat pasta'");
  assert.equal(isRefinedGrain("pasta"), true);

  assert.equal(processingTier("whole grain bread"), 0);
  assert.equal(processingTier("white bread"), 2);

  assert.equal(proteinSourceOf("unsweetened soy milk"), "plant");
  assert.equal(proteinSourceOf("skim milk"), "animal", "'soy milk' must not capture plain milk");

  assert.equal(isWholeGrain("brown rice"), true);
  assert.equal(isRefinedGrain("white rice"), true);
  assert.equal(isWholeGrain("white rice"), false);
});

test("processing tiers land where the comment says they do", () => {
  assert.equal(processingTier("broccoli"), 0);
  assert.equal(processingTier("chicken breast"), 0);
  assert.equal(processingTier("olive oil"), 1);
  assert.equal(processingTier("crushed tomatoes"), 1);
  assert.equal(processingTier("greek yogurt"), 1);
  assert.equal(processingTier("bulgogi marinade"), 2);
  assert.equal(processingTier("sports drink"), 2);
});

test("CONVENIENCE IS NOT PENALISED, which is a stated judgment and not an accident", () => {
  // Gardner's SWAP-MEAT found a NOVA-4 product beating beef on TMAO and LDL,
  // so processing degree is a signal and never a verdict. A broke student's
  // staples must not be scored as junk.
  for (const f of ["frozen mixed vegetables", "black beans", "canned tuna", "extra-firm tofu"]) {
    assert.ok(processingTier(f) <= 1, `${f} should not be tier 2`);
  }
});

test("an unknown food fails OPEN: we do not claim a food is bad because the table has not heard of it", () => {
  assert.equal(processingTier("dragonfruit"), 0);
  assert.equal(processingTier(""), 0);
  assert.equal(proteinSourceOf("dragonfruit"), null);
});

test("added sugar is what was added, not sugar that came inside a fruit", () => {
  assert.equal(isAddedSugar("honey"), true);
  assert.equal(isAddedSugar("maple syrup"), true);
  assert.equal(isAddedSugar("banana"), false);
  assert.equal(isAddedSugar("dates"), false, "a whole fruit is not an added sugar");
});

test("processed red meat is narrower than red meat, deliberately", () => {
  assert.equal(isProcessedRedMeat("bacon"), true);
  assert.equal(isProcessedRedMeat("sliced turkey"), true);
  assert.equal(isProcessedRedMeat("ground beef"), false, "unprocessed red meat carries no such rule");
  assert.equal(isProcessedRedMeat("flank steak"), false);
});

test("plant species collapse preparation words, so variety counts species and not spellings", () => {
  assert.equal(plantSpeciesOf("frozen mixed berries"), plantSpeciesOf("mixed berries"));
  assert.equal(plantSpeciesOf("fresh cilantro"), "cilantro");
  assert.equal(plantSpeciesOf("baby spinach"), "spinach");
  assert.equal(plantSpeciesOf("chicken breast"), null, "an animal is not a plant species");
  assert.equal(plantSpeciesOf("water"), null);
  assert.equal(plantSpeciesOf("chicken broth"), null);
});

test("COVERAGE: the live bank's substantive foods are classified, not silently defaulted", () => {
  // processingTier fails open, which is the right default and also the way a
  // classifier rots unnoticed. This measures how much of the real bank the
  // tables actually SPEAK to, and holds a floor under it, so a bank that
  // grows past the vocabulary announces itself instead of scoring everything
  // as a whole food.
  const foods = new Set();
  for (const f of readdirSync(BANK_DIR).filter((x) => x.endsWith(".json"))) {
    const r = JSON.parse(readFileSync(new URL(f, BANK_DIR), "utf8"));
    for (const i of r.ingredients ?? []) {
      if (partOf(i) === "flavor") continue; // synth.js already owns this call
      const name = String(i?.food ?? "").toLowerCase().trim();
      if (name) foods.add(name);
    }
  }
  assert.ok(foods.size > 100, `expected a real vocabulary, got ${foods.size}`);
  const spoken = [...foods].filter(
    (f) =>
      processingTier(f) > 0 ||
      proteinSourceOf(f) !== null ||
      isWholeGrain(f) ||
      isRefinedGrain(f) ||
      isAddedSugar(f),
  );
  const share = spoken.length / foods.size;
  assert.ok(
    share >= 0.5,
    `the tables speak to only ${(share * 100).toFixed(0)}% of the bank's ${foods.size} substantive foods; ` +
      `below half means most of the bank is scoring as "whole" by default rather than by judgment`,
  );
});
