// A synthetic mise-data snapshot for the migration tests (not a test file).
// Made-up people and words only; written to a fresh temp directory per call.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const targets = (/** @type {string} */ diet, extra = {}) => ({
  diet,
  allergens: ["peanut"],
  avoidIngredients: ["peanut"],
  phase: "gain",
  macros: { calories: 2800, protein: 150, waterLiters: 3 },
  mealSlots: ["breakfast", "lunch", "dinner"],
  body: { sex: "f", age: 30, heightIn: 65, weightLb: 140 },
  goalWeightLb: 145,
  ...extra,
});

export const PEOPLE = {
  rootProfile: "owner-1",
  admin: "owner-1",
  houses: ["house-w", "house-f"],
  people: [
    { slug: "owner-1", email: "owner-1@example.invalid", kind: "member", houses: ["house-w", "house-f"], entitled: true },
    { slug: "mate-1", email: "mate-1@example.invalid", kind: "member", houses: ["house-w"], entitled: true },
    { slug: "kin-1", email: "kin-1@example.invalid", kind: "member", houses: ["house-f"], names: ["kinfolkname"] },
    { slug: "guest-1", kind: "guest", grants: [{ house: "house-w", until: "2999-01-01" }] },
  ],
  guardTerms: [
    { term: "kinword", hiddenFrom: "house-w" },
    { term: "mateword", hiddenFrom: "house-f" },
  ],
};

/** @returns {Record<string, unknown>} path -> JSON (or a string for raw files) */
export function snapshotFiles() {
  const soup = { id: "soup", name: "Lentil soup", ingredients: [{ food: "lentils", qty: 200, unit: "g" }] };
  return {
    "profiles.json": {
      profiles: [
        { id: "owner-1", name: "Owner", emoji: "x", admin: true, household: "house-w", passkey: { salt: "s", hash: "h" } },
        { id: "mate-1", name: "Mate", household: "house-w" },
        { id: "kin-1", name: "Kin", household: "house-f", family: "house-f" },
        { id: "guest-1", name: "Guest A" },
      ],
    },
    "recipes/soup.json": soup,
    "recipes/tea.json": { id: "tea", name: "Chamomile and cardamom tea" },
    "recipes-staging/stew.json": { id: "stew", name: "Stew" },
    "philosophies/whole-food.json": { id: "whole-food" },
    "prices.json": { items: [{ food: "lentils", usd: 2 }] },
    "pins.json": { pins: [] },
    "households/house-f/prices.json": { items: [] },
    "households/house-w/events.json": { tables: [] },
    "households/house-w/pantry.json": { items: [] },
    "households/house-w/household.json": { name: "Shared house" },
    "households/house-w/recipes/house-0123456789ab.json": { id: "house-0123456789ab", name: "Special" },
    "households/house-f/events.json": { tables: [{ note: "kinword visits" }] },
    "plans/2026-W40.json": { week: "2026-W40", entries: [] },
    "profile/targets.json": targets("omnivore", { targetReason: "private" }),
    "fitness/targets.json": targets("omnivore", { targetReason: "private" }),
    "fitness/daily.json": { days: [] },
    "health/vitals.json": { readings: [] },
    "shopping.json": { items: [] },
    "occasions.json": { occasions: [] },
    "pantry.json": { items: [] },
    "profiles/mate-1/profile/targets.json": targets("vegetarian"),
    "profiles/mate-1/fitness/targets.json": targets("vegetarian"),
    "profiles/mate-1/fitness/daily.json": { days: [] },
    "profiles/mate-1/fitness/workouts.json": { workouts: [] },
    "profiles/mate-1/plans/2026-W40.json": { week: "2026-W40", entries: [] },
    "profiles/mate-1/shopping.json": { items: [] },
    "profiles/mate-1/recipes/own-dish.json": { id: "own-dish", name: "Own dish" },
    "profiles/mate-1/recipes/soup.json": soup,
    "profiles/kin-1/profile/targets.json": targets("vegan"),
    "profiles/kin-1/fitness/targets.json": targets("vegan"),
    "profiles/kin-1/health/vitals.json": { readings: [] },
    "profiles/kin-1/plans/2026-W40.json": { week: "2026-W40", entries: [{ note: "with kinword" }] },
    "profiles/guest-1/profile/targets.json": targets("pescatarian"),
    "profiles/guest-1/fitness/targets.json": targets("pescatarian"),
    "meta.json": { schemaVersion: 1 },
    "invites.json": { invites: [] },
    "guests.json": { guests: [] },
    "README.md": "synthetic snapshot\n",
  };
}

/**
 * Write a snapshot to a new temp directory.
 * @param {(files: Record<string, unknown>) => void} [edit] change the files first
 * @returns {string} the directory
 */
export function writeSnapshot(edit) {
  const files = snapshotFiles();
  if (edit) edit(files);
  const dir = mkdtempSync(path.join(tmpdir(), "mise-snapshot-"));
  for (const [p, v] of Object.entries(files)) {
    if (v === undefined) continue;
    const full = path.join(dir, ...p.split("/"));
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, typeof v === "string" ? v : JSON.stringify(v, null, 2) + "\n");
  }
  return dir;
}
