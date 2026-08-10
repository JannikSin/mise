import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  PRESETS,
  presetById,
  shiftIso,
  occasionFromPreset,
  occasionEntries,
  applyOccasion,
  clearOccasion,
  datesOf,
  occasionOn,
  tablesToLeave,
  summarize,
} from "../app/lib/occasions.js";
import { generateWeek, generatorEligible } from "../app/lib/weekbuilder.js";
import { dayTotals, recipesById } from "../app/lib/plan.js";

const BANK = fileURLToPath(new URL("../seed-data/generated/recipes/", import.meta.url));
const bank = readdirSync(BANK)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(BANK + f, "utf8")));

test("shiftIso walks dates in both directions and across a month boundary", () => {
  assert.equal(shiftIso("2026-08-14", -3), "2026-08-11");
  assert.equal(shiftIso("2026-08-14", 1), "2026-08-15");
  assert.equal(shiftIso("2026-09-01", -1), "2026-08-31");
  assert.equal(shiftIso("2027-01-01", -1), "2026-12-31");
  assert.equal(shiftIso("2028-03-01", -1), "2028-02-29", "leap year");
});

test("every preset day references a recipe that actually exists in the bank", () => {
  const ids = new Set(bank.map((r) => r.id));
  /** @type {string[]} */
  const missing = [];
  for (const p of PRESETS) {
    for (const d of p.days) {
      for (const item of d.items) {
        if (item.recipeId && !ids.has(item.recipeId)) missing.push(`${p.id}/${item.recipeId}`);
      }
    }
  }
  assert.deepEqual(missing, [], "a preset pointing at a missing recipe is a blank day at the worst possible moment");
});

test("every preset item names a real slot, and every day has at least one item", () => {
  const SLOTS = new Set(["breakfast", "lunch", "dinner", "smoothie", "snack"]);
  for (const p of PRESETS) {
    assert.ok(p.days.length > 0, `${p.id} has no days`);
    for (const d of p.days) {
      assert.ok(d.items.length > 0, `${p.id} offset ${d.offset} is empty`);
      for (const item of d.items) {
        assert.ok(SLOTS.has(item.slot), `${p.id}: bad slot ${item.slot}`);
        assert.ok(
          item.recipeId || item.freeText,
          `${p.id}: an item with neither a recipe nor text renders as a blank row`,
        );
      }
    }
  }
});

test("every medical preset carries a disclaimer", () => {
  for (const p of PRESETS.filter((x) => x.medical)) {
    assert.ok(p.disclaimer && p.disclaimer.length > 40, `${p.id} is medical with no disclaimer`);
  }
});

test("occasion-only recipes can never be auto-planned, promoted or not", () => {
  const occ = bank.filter((r) => (r.tags ?? []).includes("occasion-only"));
  assert.ok(occ.length >= 15, "the occasion bank is present");
  const eligible = new Set(generatorEligible(bank).map((r) => r.id));
  for (const r of occ) assert.ok(!eligible.has(r.id), `${r.id} leaked into the generator pool`);
  // and promotion does not open the gate: apple juice is never a good snack
  const promoted = occ.map((r) => ({ ...r, promoted: true }));
  assert.equal(generatorEligible(promoted).length, 0);
});

test("occasion-only recipes claim zero food groups, so no floor pass reaches for them", () => {
  for (const r of bank.filter((x) => (x.tags ?? []).includes("occasion-only"))) {
    const total = Object.entries(r.foodGroups ?? {})
      .filter(([k]) => k !== "method")
      .reduce((s, [, v]) => s + Number(v || 0), 0);
    assert.equal(total, 0, `${r.id} claims Daily Dozen credit it does not deserve`);
  }
});

test("colonoscopy preset lands its days around the procedure date", () => {
  const o = occasionFromPreset(presetById("colonoscopy"), "2026-08-14", "p2");
  assert.deepEqual(datesOf(o), [
    "2026-08-11",
    "2026-08-12",
    "2026-08-13",
    "2026-08-14",
    "2026-08-15",
  ]);
  assert.equal(o.from, "2026-08-11");
  assert.equal(o.to, "2026-08-15");
  assert.equal(o.days["2026-08-13"].label, "Clear liquids only");
  assert.equal(o.profileId, "p2");
  assert.equal(o.offTables, true, "an occasion takes you off shared tables by default");
});

test("the clear-liquid day carries nothing solid", () => {
  const o = occasionFromPreset(presetById("colonoscopy"), "2026-08-14", "p2");
  const byId = recipesById(bank);
  for (const item of o.days["2026-08-13"].items) {
    if (!item.recipeId) continue;
    const r = byId.get(item.recipeId);
    assert.ok(r, `${item.recipeId} missing`);
    assert.ok(
      (r.tags ?? []).includes("clear-liquid"),
      `${item.recipeId} is on the clear-liquid day but is not tagged clear-liquid`,
    );
  }
});

test("no red, purple or blue food on a clear-liquid day, and the rule travels with it", () => {
  // the one instruction that voids the procedure: dye reads as blood on the
  // camera. Guarded in code, not left to prose somebody may not scroll to.
  // The scan is deliberately on the NAME and the ingredient food names only:
  // notes and descriptions are where the ban is EXPLAINED, so matching them
  // would fail every recipe that does its job.
  const byId = recipesById(bank);
  const BANNED = /\b(red|purple|blue|cherry|beet)\b/i;
  for (const r of bank.filter((x) => (x.tags ?? []).includes("clear-liquid"))) {
    const surface = [r.name, ...(r.ingredients ?? []).map((i) => i.food)].join(" ");
    assert.ok(!BANNED.test(surface), `${r.id} is a banned colour: ${surface}`);
    // and every one of them must SAY so, on the recipe, where the person is
    const advice = [
      ...(r.ingredients ?? []).map((i) => i.note ?? ""),
      ...(r.instructions ?? []).map((i) => i.text),
      ...(r.lessons ?? []),
      r.description,
    ].join(" ");
    assert.match(
      advice,
      /(red|purple|blue|clear|milk|pulp|straw)/i,
      `${r.id} carries no clear-liquid caveat at all`,
    );
  }
  // and the preset's own clear-liquid day only ever places clear-liquid food
  for (const p of PRESETS) {
    for (const d of p.days.filter((x) => /clear liquid/i.test(x.label))) {
      for (const item of d.items.filter((i) => i.recipeId)) {
        assert.ok(
          (byId.get(item.recipeId).tags ?? []).includes("clear-liquid"),
          `${p.id}: ${item.recipeId} is not clear-liquid`,
        );
      }
    }
  }
});

test("applying an occasion replaces the day entirely, not merges into it", () => {
  const o = occasionFromPreset(presetById("colonoscopy"), "2026-08-14", "p2");
  const plan = {
    week: "2026-W33",
    entries: [
      { id: "old-1", date: "2026-08-13", slot: "dinner", recipeId: "turkish-lentil-soup", servings: 1 },
      { id: "keep-1", date: "2026-08-17", slot: "dinner", recipeId: "chicken-piccata", servings: 1 },
    ],
  };
  const next = applyOccasion(plan, o);
  assert.equal(
    next.entries.filter((e) => e.recipeId === "turkish-lentil-soup").length,
    0,
    "a low-residue day with yesterday's lentil soup on it is not a low-residue day",
  );
  assert.ok(next.entries.some((e) => e.id === "keep-1"), "days outside the occasion are untouched");
  assert.ok(next.entries.every((e) => !e.occasion || e.pinned), "every occasion entry is pinned");
});

test("re-applying the same occasion is idempotent (deterministic ids merge, never duplicate)", () => {
  const o = occasionFromPreset(presetById("colonoscopy"), "2026-08-14", "p2");
  const once = applyOccasion({ week: "2026-W33", entries: [] }, o);
  const twice = applyOccasion(once, o);
  assert.deepEqual(
    twice.entries.map((e) => e.id).sort(),
    once.entries.map((e) => e.id).sort(),
  );
  assert.equal(new Set(twice.entries.map((e) => e.id)).size, twice.entries.length, "ids are unique");
});

test("clearing an occasion leaves the days EMPTY, never silently regenerated", () => {
  const o = occasionFromPreset(presetById("colonoscopy"), "2026-08-14", "p2");
  const applied = applyOccasion({ week: "2026-W33", entries: [] }, o);
  const cleared = clearOccasion(applied, o.id);
  assert.equal(cleared.entries.length, 0);
});

test("GENERATE hands off completely on an occasion day", () => {
  const o = occasionFromPreset(presetById("colonoscopy"), "2026-08-14", "p2");
  const base = applyOccasion({ week: "2026-W33", entries: [] }, o);
  const { plan, report } = generateWeek({
    recipes: bank,
    targets: {
      macros: { calories: 1550, caloriesFloor: 1400, protein: 110, proteinFloor: 100 },
      mealSlots: ["breakfast", "lunch", "dinner"],
      dailyDozen: { greens: 2, beans: 3, wholeGrains: 3 },
    },
    pantry: { staples: [], perishables: [] },
    weekId: "2026-W33",
    plan: base,
  });

  const byId = recipesById(bank);
  const clearDay = "2026-08-13";
  const onClearDay = plan.entries.filter((e) => e.date === clearDay);
  // the generator must not have added a single thing to close the 1400 floor
  assert.ok(
    onClearDay.every((e) => e.occasion === o.id),
    "generation put food on a clear-liquid day",
  );
  const totals = dayTotals(plan.entries, byId, clearDay);
  assert.ok(totals.calories < 700, `clear-liquid day is ${totals.calories} kcal, the top-up ran`);

  // and it is REPORTED, not silent
  assert.ok(
    report.occasionDays.some((d) => d.date === clearDay && d.name === "Colonoscopy prep"),
    "held days must be named in the report, never quietly skipped",
  );
  // no false alarm: a held day is not a shortfall
  assert.ok(!report.calorieShortDays.some((d) => d.date === clearDay));
  assert.ok(!report.proteinShortDays.some((d) => d.date === clearDay));

  // days OUTSIDE the occasion still get planned normally
  const free = plan.entries.filter((e) => e.date === "2026-08-16" && !e.occasion);
  assert.ok(free.length > 0, "the rest of the week still generates");
});

test("a hand-placed entry on an occasion day survives GENERATE instead of being cleared", () => {
  const o = occasionFromPreset(presetById("colonoscopy"), "2026-08-14", "p2");
  const base = applyOccasion({ week: "2026-W33", entries: [] }, o);
  base.entries.push({
    id: "mine",
    date: "2026-08-12",
    slot: "snack",
    freeText: "the one thing I actually want",
    servings: 1,
  });
  const { plan } = generateWeek({
    recipes: bank,
    targets: { macros: { calories: 1550, protein: 110 }, mealSlots: ["breakfast", "lunch", "dinner"] },
    pantry: { staples: [], perishables: [] },
    weekId: "2026-W33",
    plan: base,
  });
  assert.ok(plan.entries.some((e) => e.id === "mine"));
});

test("occasionOn finds the owning occasion, and only for the right person", () => {
  const held = occasionFromPreset(presetById("colonoscopy"), "2026-08-14", "p2");
  const dad = occasionFromPreset(presetById("travel"), "2026-08-13", "dad");
  const all = [held, dad];
  assert.equal(occasionOn(all, "2026-08-13", "p2")?.id, held.id);
  assert.equal(occasionOn(all, "2026-08-13", "dad")?.id, dad.id);
  assert.equal(occasionOn(all, "2026-08-13", "david"), null);
  assert.equal(occasionOn(all, "2026-08-20", "p2"), null);
});

test("tablesToLeave names every future table the person is still seated at", () => {
  const held = occasionFromPreset(presetById("colonoscopy"), "2026-08-14", "p2");
  const tables = [
    { id: "t-past", date: "2026-08-11", seats: [{ id: "p2" }, { id: "david" }] },
    { id: "t1", date: "2026-08-13", seats: [{ id: "p2" }, { id: "david" }] },
    { id: "t2", date: "2026-08-14", seats: [{ id: "p2", status: "skipped" }] },
    { id: "t3", date: "2026-08-20", seats: [{ id: "p2" }] },
    { id: "t4", date: "2026-08-13", seats: [{ id: "david" }] },
  ];
  assert.deepEqual(tablesToLeave(tables, [held], "p2", "2026-08-12"), ["t1"]);
  // t-past: before today, history is not rewritten
  // t2: already skipped
  // t3: outside the occasion
  // t4: she was never seated
});

test("an occasion with offTables false leaves every seat alone", () => {
  const holiday = occasionFromPreset(presetById("holiday"), "2026-11-26", "david", {
    offTables: false,
  });
  const tables = [{ id: "t1", date: "2026-11-26", seats: [{ id: "david" }] }];
  assert.deepEqual(tablesToLeave(tables, [holiday], "david", "2026-11-01"), []);
});

test("occasionEntries carry the note through to the plan", () => {
  const o = occasionFromPreset(presetById("colonoscopy"), "2026-08-14", "p2");
  const entries = occasionEntries(o);
  const prep = entries.find((e) => /Bowel prep/.test(e.freeText ?? ""));
  assert.ok(prep, "the prep solution row is placed like any other item");
  assert.equal(prep.pinned, true);
  assert.equal(prep.occasion, o.id);
  assert.match(prep.occasionNote, /straw/);
});

test("summarize reads like a person wrote it", () => {
  const o = occasionFromPreset(presetById("colonoscopy"), "2026-08-14", "p2");
  assert.equal(summarize(o), "5 days, Aug 11 to Aug 15");
  const one = occasionFromPreset(presetById("holiday"), "2026-11-26", "david");
  assert.equal(summarize(one), "Nov 26");
});

// --- repeatable presets (David, 2026-08-10) -------------------------------
// "this weekend my parents are at a friend's lake house" is three travel
// days, not one, and nobody should have to create three occasions to say so.

test("a repeatable preset stretches across the days you ask for", () => {
  const trip = occasionFromPreset(presetById("travel"), "2026-08-14", "p3", { days: 3 });
  assert.deepEqual(datesOf(trip), ["2026-08-14", "2026-08-15", "2026-08-16"]);
  for (const d of datesOf(trip)) assert.equal(trip.days[d].label, "Travelling");
  assert.equal(summarize(trip), "3 days, Aug 14 to Aug 16");
});

test("a fixed-length preset ignores the length — a prep is as long as it is", () => {
  const a = occasionFromPreset(presetById("colonoscopy"), "2026-08-14", "p2");
  const b = occasionFromPreset(presetById("colonoscopy"), "2026-08-14", "p2", { days: 9 });
  assert.deepEqual(datesOf(a), datesOf(b));
});

test("a trip length is clamped, never allowed to eat a year of plans", () => {
  assert.equal(datesOf(occasionFromPreset(presetById("travel"), "2026-08-14", "d", { days: 0 })).length, 1);
  assert.equal(datesOf(occasionFromPreset(presetById("travel"), "2026-08-14", "d", { days: 999 })).length, 30);
  assert.equal(datesOf(occasionFromPreset(presetById("travel"), "2026-08-14", "d", { days: -4 })).length, 1);
});

test("a travel day buys nothing: every item is free text, no recipe", () => {
  // the lake-house case. Nothing is cooked and nothing must reach anyone's
  // shopping list — an entry with a recipeId WOULD be shopped
  // (deriveShoppingList shops every entry that has one).
  for (const id of ["travel", "holiday"]) {
    for (const d of presetById(id).days) {
      for (const item of d.items) {
        assert.ok(!item.recipeId, `${id} would put ${item.recipeId} on the shopping list`);
        assert.ok(item.freeText, `${id} has an item with nothing to show`);
      }
    }
  }
});

test("a prep day DOES shop: its food has real recipes behind it", () => {
  // the mirror of the test above, and the reason both exist: an occasion that
  // feeds you must reach the list, an occasion that excuses you must not.
  const prep = presetById("colonoscopy");
  const lowResidue = prep.days.find((d) => d.label === "Low residue");
  assert.ok(lowResidue.items.every((i) => i.recipeId));
});

test("the custom occasion is a real escape hatch: named, any length, no rules", () => {
  const custom = presetById("custom");
  assert.ok(custom.custom && custom.repeatable, "blank AND stretchable, or it is not an escape hatch");
  const o = occasionFromPreset(custom, "2026-08-14", "p3", { days: 3, name: "  lake house  " });
  assert.equal(o.name, "lake house", "named by the person, trimmed");
  assert.deepEqual(datesOf(o), ["2026-08-14", "2026-08-15", "2026-08-16"]);
  assert.ok(!custom.medical && !custom.disclaimer, "no medical claim on a blank one");
  // and it starts inert: nothing planned, nothing bought
  assert.ok(occasionEntries(o).every((e) => !e.recipeId));
});

test("a blank custom occasion still holds its days against the generator", () => {
  const o = occasionFromPreset(presetById("custom"), "2026-08-12", "david", { days: 2 });
  const base = applyOccasion({ week: "2026-W33", entries: [] }, o);
  const { plan } = generateWeek({
    recipes: bank,
    targets: { macros: { calories: 3700, protein: 210 }, mealSlots: ["breakfast", "lunch", "dinner"] },
    pantry: { staples: [], perishables: [] },
    weekId: "2026-W33",
    plan: base,
  });
  for (const d of ["2026-08-12", "2026-08-13"]) {
    assert.ok(
      plan.entries.filter((e) => e.date === d).every((e) => e.occasion === o.id),
      `${d} was planned despite being held`,
    );
  }
});
