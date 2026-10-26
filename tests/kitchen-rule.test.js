// THE KITCHEN RULE, 2.0 (I-08 and I-14). Made-up people and numbers in a
// Wayne-SHAPED house, never read from real data files.
//
// I-08 (post-mortem 5, 10/18): the rule named Overnight Oats Three Ways,
// which uses peanut butter, and Rowan has a peanut allergy. The planner
// correctly refused it, so breakfast was the other dish all week, and the
// only word of it was "1 is in rotation".
//
// I-14 (talbot P3a, P3d): the live rule cooked Sunday's dinner AND a batch
// for Mon to Thu, so Sunday was two dinners; and the batch's cook read
// differently on David's phone and Rowan's.
import test from "node:test";
import assert from "node:assert/strict";
import { planBrigadeWeek } from "../app/lib/compose.js";
import {
  deriveTables,
  namedSlotLine,
  plateRefusal,
  ruleRecipeCheck,
  sundayBatchOn,
  sundayTwoPotsOn,
  batchesOnSave,
  brigadeTableId,
  validBrigade,
} from "../app/lib/tables.js";
import { cookLine, sameDishEveryDay } from "../app/lib/plan.js";

const recipe = (id, mealType, kcal, protein, extra = {}) => ({
  id,
  name: id,
  mealType,
  effort: "assembly",
  servings: 2,
  tags: [],
  ingredients: [{ qty: 1, unit: "x", food: "food" }],
  nutrition: { calories: kcal, protein },
  ...extra,
});
const meat = (id, food, extra = {}) =>
  recipe(id, "dinner", 850, 55, {
    safeDays: 5,
    tags: ["batch-friendly", "leftover-first"],
    ingredients: [{ qty: 1, unit: "lb", food }],
    ...extra,
  });
const OATS = recipe("overnight-oats-three-ways", "breakfast", 600, 35, {
  name: "Overnight Oats Three Ways",
  ingredients: [
    { qty: 1, unit: "cup", food: "rolled oats" },
    { qty: 2, unit: "tbsp", food: "peanut butter" },
  ],
});
const BALLS = recipe("cocoa-almond-balls", "breakfast", 520, 18, {
  name: "Cocoa Almond Balls",
  ingredients: [{ qty: 3, unit: "tbsp", food: "almond butter" }],
});
const BANK = [
  OATS,
  BALLS,
  recipe("yogurt-bowl", "breakfast", 600, 40, { name: "Yogurt Bowl" }),
  recipe("snk-muffin", "snack", 350, 20),
  recipe("snk-soup", "snack", 300, 25),
  meat("shepherds-pie", "ground beef"),
  meat("turkey-chili", "ground turkey"),
  meat("chicken-curry", "chicken thigh"),
  meat("pork-ragu", "pork shoulder"),
  meat("beef-stew", "beef chuck"),
  meat("chicken-orzo", "chicken breast"),
];
const bankById = new Map(BANK.map((r) => [r.id, r]));

const davidTargets = { macros: { calories: 3700, caloriesFloor: 3500, protein: 190 } };
const rowanTargets = {
  macros: { calories: 2700, caloriesFloor: 2500, protein: 150 },
  allergens: ["peanuts"],
  avoidIngredients: ["peanut"],
};
const PROFILES = new Map([
  ["david", { id: "david", name: "David", household: "wayne" }],
  ["rowan", { id: "rowan", name: "Rowan", household: "wayne" }],
]);
const TARGETS = new Map([
  ["david", davidTargets],
  ["rowan", rowanTargets],
]);
// Sun 10/25 to Sat 10/31 2026
const WEEK = [
  "2026-10-25",
  "2026-10-26",
  "2026-10-27",
  "2026-10-28",
  "2026-10-29",
  "2026-10-30",
  "2026-10-31",
];
const [SUN, MON, TUE, WED, THU] = WEEK;
// THE LIVE RULE'S SHAPE (20974b9d): cook Sun Fri Sat, take turns, and the
// old "Sunday also cooks a batch for Mon to Thu". `from` one day before the
// Sunday, so Sunday is Rowan's turn and Monday is David's, as on 10/18.
const LIVE = {
  id: "wk",
  name: "Wayne kitchen",
  memberIds: ["david", "rowan"],
  slots: ["breakfast", "dinner"],
  cookId: "david",
  rotateCooks: true,
  from: "2026-10-24",
  until: "2026-11-20",
  cookDays: [0, 5, 6],
  batches: [{ cookDay: 0, feeds: [1, 2, 3, 4] }],
};
const ctx = (over = {}) => ({
  dates: WEEK,
  today: SUN,
  house: "wayne",
  profilesById: PROFILES,
  targetsById: TARGETS,
  plansById: new Map(),
  bankById,
  ...over,
});
// what SET MY WEEK hands the planner: the rule with its default applied
// the app's defaulting step, as main.js handleRunBrigade does it (1.96: two
// Sunday pots are the default too, shrike's inverted-test note)
const asTheAppPlans = (/** @type {any} */ rule) => ({
  ...rule,
  sundayBatch: sundayBatchOn(rule),
  sundayTwoPots: sundayTwoPotsOn(rule),
});
// the 1.95 one-pot week, now a choice in the rule (sundayTwoPots: false):
// the I-14 edge cases below pin that choice; the two-pot ones are in cadence.test.js
const asOnePot = (/** @type {any} */ rule) => asTheAppPlans({ ...rule, sundayTwoPots: false });
const dinner = (/** @type {any} */ events, /** @type {string} */ date) =>
  events.tables.find((t) => t.slot === "dinner" && t.date === date);
const phone = (/** @type {any} */ events, /** @type {string} */ me) =>
  deriveTables([{ house: "wayne", events }], {
    profileId: me,
    bankById,
    ownEntries: [],
    today: SUN,
    profilesById: PROFILES,
  }).entries.filter((e) => e.slot === "dinner");
const dayName = (/** @type {string} */ iso) =>
  ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(`${iso}T12:00:00`).getDay()];

// ---------------------------------------------------------------------------
// I-08: the rule form's recipe picks, screened
// ---------------------------------------------------------------------------

const SEATED = [
  { id: "david", name: "David", targets: davidTargets },
  { id: "rowan", name: "Rowan", targets: rowanTargets },
];

test("I-08: in the kitchen rule, a named recipe Rowan cannot eat is greyed with the reason 'Rowan: peanut'", () => {
  const oats = ruleRecipeCheck(OATS, SEATED);
  assert.deepEqual(oats.blocked, ["Rowan: peanut"]);
  assert.deepEqual(oats.unchecked, []);
  const balls = ruleRecipeCheck(BALLS, SEATED);
  assert.deepEqual(balls, { blocked: [], unchecked: [] }, "a dish everyone can eat is not greyed");
});

test("I-08: the rule form greys exactly what the planner's plate screen refuses, never a weaker copy", () => {
  // every recipe, every person: greyed for someone if and only if the plate
  // screen refuses it for them
  const people = [
    ...SEATED,
    { id: "veg", name: "Sam", targets: { diet: "vegetarian", avoidRecipes: ["cocoa-almond-balls"] } },
  ];
  for (const r of BANK) {
    const c = ruleRecipeCheck(r, people);
    for (const p of people) {
      const refused = plateRefusal(r, p.targets).length > 0;
      assert.equal(
        c.blocked.some((b) => b.startsWith(`${p.name}:`)),
        refused,
        `${r.id} for ${p.name}`,
      );
    }
  }
  assert.ok(ruleRecipeCheck(BALLS, people).blocked.includes("Sam: never again"));
  assert.ok(ruleRecipeCheck(bankById.get("shepherds-pie"), people).blocked.includes("Sam: not vegetarian"));
  // and the planner, given the same rule, never puts the greyed dish on Rowan's plate
  const rule = { ...LIVE, slotRecipes: { breakfast: [OATS.id, BALLS.id] } };
  const { events } = planBrigadeWeek({ tables: [] }, asTheAppPlans(rule), ctx());
  const breakfasts = events.tables.filter((t) => t.slot === "breakfast");
  assert.equal(breakfasts.length, 7);
  for (const t of breakfasts) assert.equal(t.recipeId, BALLS.id, `${t.date} is the dish everyone can eat`);
});

test("I-08: fails closed: a profile that cannot be read leaves every recipe not checked, never usable", () => {
  for (const targets of [null, undefined]) {
    const c = ruleRecipeCheck(BALLS, [SEATED[0], { id: "rowan", name: "Rowan", targets }]);
    assert.deepEqual(c.blocked, []);
    assert.deepEqual(c.unchecked, ["Rowan"], "named as not checked");
    assert.ok(plateRefusal(BALLS, targets).length > 0, "the plate screen refuses an unread profile");
  }
  const unread = [SEATED[0], { id: "rowan", name: "Rowan", targets: null }];
  const line = namedSlotLine([BALLS.id], (id) => bankById.get(id), (r) => ruleRecipeCheck(r, unread));
  assert.match(line, /not checked/i);
  assert.doesNotMatch(line, /every day/, "an unchecked dish is not counted as the one left");
});

test("I-08: when one usable recipe is left in a slot, the form says that dish is every day, not '1 is in rotation'", () => {
  const check = (/** @type {any} */ r) => ruleRecipeCheck(r, SEATED);
  const recipeOf = (/** @type {string} */ id) => bankById.get(id);
  assert.equal(
    namedSlotLine([OATS.id, BALLS.id], recipeOf, check),
    "Cocoa Almond Balls every day: add another to vary it.",
  );
  // one named on purpose says it too; two usable say nothing
  assert.equal(namedSlotLine([BALLS.id], recipeOf, check), "Cocoa Almond Balls every day: add another to vary it.");
  assert.equal(namedSlotLine([BALLS.id, "yogurt-bowl"], recipeOf, check), "");
  assert.equal(namedSlotLine([], recipeOf, check), "");
  assert.match(namedSlotLine([OATS.id], recipeOf, check), /None of these passes everyone/);
  // and SET MY WEEK's own note says it in the same words
  const rule = { ...LIVE, slotRecipes: { breakfast: [OATS.id, BALLS.id] } };
  const { notes } = planBrigadeWeek({ tables: [] }, asTheAppPlans(rule), ctx());
  const note = notes.find((n) => n.startsWith("breakfast:"));
  assert.ok(note, notes.join(" | "));
  assert.match(note, /breakfast is Cocoa Almond Balls every day/);
  assert.doesNotMatch(note, /in rotation/);
});

test("I-08: the Plan tab warns when a meal is the same dish every day of the week, and only then", () => {
  const recipeOf = (/** @type {string} */ id) => bankById.get(id);
  const week = (/** @type {(d: string, i: number) => any} */ make) => WEEK.map(make);
  const shared = week((d) => ({ id: `t-${d}`, table: `t-${d}`, date: d, slot: "breakfast", viewRecipeId: BALLS.id, servings: 1 }));
  assert.deepEqual(sameDishEveryDay(shared, WEEK, recipeOf), [
    { slot: "breakfast", recipeId: BALLS.id, name: "Cocoa Almond Balls", days: 7 },
  ]);
  const varied = week((d, i) => ({ id: d, date: d, slot: "breakfast", recipeId: i === 3 ? "yogurt-bowl" : BALLS.id, servings: 1 }));
  assert.deepEqual(sameDishEveryDay(varied, WEEK, recipeOf), [], "one different morning is not every day");
  const fewDays = shared.slice(0, 4);
  assert.deepEqual(sameDishEveryDay(fewDays, WEEK, recipeOf), [], "a half-planned week does not cry wolf");
  const eatOut = [...shared.slice(0, 6), { id: "o", date: WEEK[6], slot: "breakfast", freeText: "out", out: true, servings: 1 }];
  assert.deepEqual(sameDishEveryDay(eatOut, WEEK, recipeOf), []);
  // a real planned week from the oats-and-Rowan rule raises it for breakfast only
  const rule = { ...LIVE, slotRecipes: { breakfast: [OATS.id, BALLS.id] } };
  const { events } = planBrigadeWeek({ tables: [] }, asTheAppPlans(rule), ctx());
  const mine = deriveTables([{ house: "wayne", events }], {
    profileId: "david",
    bankById,
    ownEntries: [],
    today: SUN,
    profilesById: PROFILES,
  }).entries;
  assert.deepEqual(
    sameDishEveryDay(/** @type {any} */ (mine), WEEK, recipeOf).map((r) => `${r.slot}:${r.name}`),
    ["breakfast:Cocoa Almond Balls"],
  );
});

// ---------------------------------------------------------------------------
// I-14 (a): Sunday's dinner is the batch
// ---------------------------------------------------------------------------

test("I-14: the setting is ON for a rule with no saved value, OFF only when saved off, and validated", () => {
  assert.equal(sundayBatchOn(LIVE), true);
  assert.equal(sundayBatchOn({ ...LIVE, sundayBatch: true }), true);
  assert.equal(sundayBatchOn({ ...LIVE, sundayBatch: false }), false);
  assert.equal(validBrigade({ ...LIVE, sundayBatch: false }), true);
  assert.equal(validBrigade({ ...LIVE, sundayBatch: "no" }), false);
});

test("1.96: SET MY WEEK on the live rule plans two Sunday pots: A for Sun and Mon, B prepped Sunday for Tue to Thu", () => {
  const { events, nights } = planBrigadeWeek({ tables: [] }, asTheAppPlans(LIVE), ctx());
  const sun = dinner(events, SUN);
  assert.ok(sun && !sun.leftoverOf && !sun.preparedOn, "Sunday cooks meal A");
  assert.equal(dinner(events, MON).leftoverOf, sun.id, "Monday eats meal A");
  const tue = dinner(events, TUE);
  assert.equal(tue.preparedOn, SUN, "meal B is prepped Sunday");
  assert.notEqual(tue.recipeId, sun.recipeId, "two dishes on Sunday");
  for (const d of [WED, THU]) assert.equal(dinner(events, d).leftoverOf, tue.id, `${d} eats meal B`);
  assert.deepEqual(nights.uncovered, []);
});

test("I-14, now the one-pot choice: with two pots off, Sunday's dinner is the batch pot, and Mon to Thu eat it", () => {
  const { events, nights } = planBrigadeWeek(
    { tables: [] },
    asTheAppPlans({ ...LIVE, sundayTwoPots: false }),
    ctx(),
  );
  const sun = dinner(events, SUN);
  assert.ok(sun && !sun.leftoverOf && !sun.preparedOn, "Sunday cooks its own dinner");
  for (const d of [MON, TUE, WED, THU]) {
    const t = dinner(events, d);
    assert.equal(t.leftoverOf, sun.id, `${d} eats Sunday's pot`);
    assert.equal(t.recipeId, sun.recipeId, `${d} is Sunday's dish`);
  }
  assert.ok(
    !events.tables.some((t) => t.preparedOn),
    "no second dish is cooked on Sunday",
  );
  assert.ok(Number(bankById.get(sun.recipeId)?.safeDays) >= 4, "the pot keeps until Thursday");
  assert.deepEqual(nights.uncovered, []);
});

test("I-14: a rule that saved the setting OFF keeps its second Sunday pot", () => {
  const off = { ...LIVE, sundayBatch: false };
  const { events } = planBrigadeWeek({ tables: [] }, asTheAppPlans(off), ctx());
  const sun = dinner(events, SUN);
  const mon = dinner(events, MON);
  assert.equal(mon.preparedOn, SUN, "Monday's dish is a batch cooked on Sunday");
  assert.notEqual(mon.recipeId, sun.recipeId, "two dishes on Sunday, as that rule asks");
  for (const d of [TUE, WED, THU]) assert.equal(dinner(events, d).leftoverOf, mon.id);
});

test("I-14: a Sunday already set or bought is kept as it is when the setting turns on", () => {
  const before = planBrigadeWeek({ tables: [] }, { ...LIVE, sundayBatch: false }, ctx());
  const was = (/** @type {string} */ d) => dinner(before.events, d);
  for (const run of [
    ctx({ keepSet: true, bought: () => false }), // SET MY WEEK: set meals stay
    ctx({ bought: () => true }), // its food is in the kitchen
  ]) {
    const after = planBrigadeWeek(before.events, asOnePot(LIVE), run);
    for (const d of [SUN, MON, TUE, WED, THU]) {
      const t = dinner(after.events, d);
      assert.equal(t.recipeId, was(d).recipeId, `${d} keeps its dish`);
      assert.equal(t.preparedOn, was(d).preparedOn, `${d} keeps its batch stamp`);
      assert.equal(t.leftoverOf, was(d).leftoverOf, `${d} keeps its pot`);
    }
  }
  // an unbought week re-rolled by PICK DIFFERENT MEALS takes the new shape
  const reroll = planBrigadeWeek(
    before.events,
    asOnePot({ ...LIVE, salt: 1 }),
    ctx({ regenerate: true, bought: () => false }),
  );
  assert.ok(!reroll.events.tables.some((t) => t.preparedOn), "no second Sunday pot");
  assert.equal(dinner(reroll.events, THU).leftoverOf, dinner(reroll.events, SUN).id);
});

// ---------------------------------------------------------------------------
// I-14 (b): both phones, one cook
// ---------------------------------------------------------------------------

/** every dinner card's who-cooks line on one phone, by date */
const linesOn = (/** @type {any} */ events, /** @type {string} */ me) =>
  Object.fromEntries(phone(events, me).map((e) => [e.date, cookLine(e, me, dayName)]));

test("I-14: David's phone and Rowan's compute the same cook for Sunday's dinner pot on every night it feeds", () => {
  for (const rule of [asOnePot(LIVE), { ...LIVE, sundayBatch: false }]) {
    const { events } = planBrigadeWeek({ tables: [] }, rule, ctx());
    const sunCook = dinner(events, SUN).cookId;
    assert.equal(sunCook, "rowan", "Sunday is Rowan's turn in this fixture");
    const david = phone(events, "david");
    const rowan = phone(events, "rowan");
    for (const d of [SUN, MON, TUE, WED, THU]) {
      const a = david.find((e) => e.date === d);
      const b = rowan.find((e) => e.date === d);
      assert.equal(a?.cookId, b?.cookId, `${d}: both phones name one cook`);
      assert.equal(a?.cookId, sunCook, `${d}: the Sunday pot's cook is Sunday's cook`);
    }
    const dl = linesOn(events, "david");
    const el = linesOn(events, "rowan");
    for (const d of [MON, TUE, WED, THU]) {
      assert.match(dl[d], /Rowan cooked it$/, `David's phone, ${d}: ${dl[d]}`);
      assert.match(el[d], /you cooked it$/, `Rowan's phone, ${d}: ${el[d]}`);
    }
  }
});

test("I-14: tables written before the fix (each night credited to its own turn) read the same cook on both phones, and SET MY WEEK repairs them", () => {
  // the 10/18 shape: the Monday batch credited to Monday's turn (David), the
  // leftover nights to their own turns, so David's phone said "you cooked it"
  const { events } = planBrigadeWeek({ tables: [] }, { ...LIVE, sundayBatch: false }, ctx());
  const turn = (/** @type {string} */ d) =>
    Math.round((Date.parse(d) - Date.parse(LIVE.from)) / 86400000) % 2 === 0 ? "david" : "rowan";
  const stale = {
    ...events,
    tables: events.tables.map((t) => (t.slot === "dinner" ? { ...t, cookId: turn(t.date) } : t)),
  };
  assert.equal(dinner(stale, MON).cookId, "david", "the stale batch names Monday's turn");
  const dl = linesOn(stale, "david");
  const el = linesOn(stale, "rowan");
  // Sunday's card no longer credits the batch to Rowan while the batch says David
  assert.match(el[SUN], /^🍳 you cook · David cooks the batch for Mon/, el[SUN]);
  assert.match(dl[SUN], /^🍳 Rowan cooks · you cook the batch for Mon/, dl[SUN]);
  // every night eating the batch names the batch's cook, on both phones
  for (const d of [TUE, WED, THU]) {
    const a = phone(stale, "david").find((e) => e.date === d);
    const b = phone(stale, "rowan").find((e) => e.date === d);
    assert.equal(a?.cookId, "david", `${d} names the pot's cook`);
    assert.equal(b?.cookId, "david", `${d} names the pot's cook on Rowan's phone too`);
  }
  // a plain SET MY WEEK (keeps set meals) credits the batch to Sunday's cook
  const fixed = planBrigadeWeek(stale, { ...LIVE, sundayBatch: false }, ctx({ keepSet: true, bought: () => false }));
  assert.equal(dinner(fixed.events, MON).recipeId, dinner(stale, MON).recipeId, "the set batch dish is kept");
  for (const d of [MON, TUE, WED, THU])
    assert.equal(dinner(fixed.events, d).cookId, "rowan", `${d} credited to Sunday's cook`);
  const again = planBrigadeWeek(fixed.events, { ...LIVE, sundayBatch: false }, ctx({ keepSet: true, bought: () => false }));
  assert.equal(again.made, 0, "and the repaired week is stable");
  assert.equal(
    again.events.tables.find((t) => t.id === brigadeTableId("wk", MON, "dinner"))?.cookId,
    "rowan",
  );
});

// ---------------------------------------------------------------------------
// I-14, Tribunal Final Gate (1.95): Sunday night, and saving an older rule
// ---------------------------------------------------------------------------

test("I-14: SET MY WEEK on Sunday night (after the cutoff, Sunday's dinner never set) still gives Mon to Thu a pot", () => {
  // after 7:30 pm the run plans from Monday; the calendar day is still Sunday
  const run = ctx({ dates: WEEK.slice(1), today: MON, calendarToday: SUN });
  const { events, nights } = planBrigadeWeek({ tables: [] }, asOnePot(LIVE), run);
  const mon = dinner(events, MON);
  assert.ok(mon && !mon.leftoverOf, "Monday is the pot");
  assert.equal(mon.preparedOn, SUN, "cooked tonight, Sunday, as the old batch was");
  for (const d of [TUE, WED, THU]) {
    const t = dinner(events, d);
    assert.equal(t.leftoverOf, mon.id, `${d} eats the Sunday pot`);
    assert.equal(t.recipeId, mon.recipeId);
  }
  assert.deepEqual(nights.uncovered, [], "no night left without a dinner");
});

test("I-14: Sunday night with Sunday's dinner already set keeps Mon to Thu on that Sunday pot", () => {
  const morning = planBrigadeWeek({ tables: [] }, asOnePot(LIVE), ctx());
  const sun = dinner(morning.events, SUN);
  // bought or not: tonight's pot is being cooked tonight
  for (const bought of [() => true, () => false]) {
    const run = ctx({ dates: WEEK.slice(1), today: MON, calendarToday: SUN, keepSet: true, bought });
    const { events, nights } = planBrigadeWeek(morning.events, asOnePot(LIVE), run);
    assert.ok(!events.tables.some((t) => t.preparedOn), "no second Sunday dish appears");
    for (const d of [MON, TUE, WED, THU]) assert.equal(dinner(events, d).leftoverOf, sun.id, `${d}`);
    assert.deepEqual(nights.uncovered, []);
  }
});

test("I-14: SET MY WEEK on Sunday morning is unchanged by the Sunday-night fix", () => {
  for (const run of [ctx(), ctx({ calendarToday: SUN })]) {
    const { events, nights } = planBrigadeWeek({ tables: [] }, asOnePot(LIVE), run);
    const sun = dinner(events, SUN);
    assert.ok(sun && !sun.leftoverOf && !sun.preparedOn, "Sunday cooks its own dinner");
    assert.ok(!events.tables.some((t) => t.preparedOn), "no second dish on Sunday");
    for (const d of [MON, TUE, WED, THU]) assert.equal(dinner(events, d).leftoverOf, sun.id, `${d}`);
    assert.deepEqual(nights.uncovered, []);
  }
});

test("I-14: saving an older rule without touching the Sunday setting keeps its saved batches exactly", () => {
  // a pre-1.95 rule: Sunday also cooks a batch for Tue and Wed
  const old = { ...LIVE, name: "Gotham kitchen", batches: [{ cookDay: 0, feeds: [2, 3] }] };
  const before = JSON.stringify(old.batches);
  // a rename-only save: the form opened ON (no saved value) and stays ON
  const asSaved = { slots: old.slots, cookDays: old.cookDays };
  const renamed = batchesOnSave({ sundayBatch: sundayBatchOn(old), kept: old.batches, ...asSaved }, []);
  assert.equal(JSON.stringify(renamed), before, "byte for byte");
  // turning the setting ON in this edit (the rule opened OFF) drops the second pot
  assert.equal(batchesOnSave({ sundayBatch: true, ...asSaved }, []), undefined);
  // with it OFF, the ticked nights are what is saved, and none ticked is none
  assert.deepEqual(batchesOnSave({ sundayBatch: false, kept: old.batches, ...asSaved }, [1, 4]), [
    { cookDay: 0, feeds: [1, 4] },
  ]);
  assert.equal(batchesOnSave({ sundayBatch: false, ...asSaved }, []), undefined);
});

// ---------------------------------------------------------------------------
// I-14, Tribunal Final Gate (1.95), loop 2: Sunday's set pot on Sunday night,
// a rule with no saved batches, and an edit that removes the Sunday pot
// ---------------------------------------------------------------------------

/** Sunday night after the cutoff: the run plans from Monday, the calendar day is Sunday */
const sundayNight = (/** @type {any} */ over = {}) =>
  ctx({ dates: WEEK.slice(1), today: MON, calendarToday: SUN, ...over });
/** only Sunday's dinner, as SET MY WEEK on Sunday morning left it */
const sundayOnly = () => {
  const morning = planBrigadeWeek({ tables: [] }, asOnePot(LIVE), ctx());
  return {
    full: morning.events,
    sunOnly: {
      ...morning.events,
      tables: morning.events.tables.filter((t) => !(t.slot === "dinner" && t.date !== SUN)),
    },
    sun: dinner(morning.events, SUN),
  };
};

test("I-14: PICK DIFFERENT MEALS on Sunday night with Sunday's dinner set keeps Mon to Thu on Sunday's pot", () => {
  const { full, sun } = sundayOnly();
  for (const bought of [() => true, () => false]) {
    const { events, nights } = planBrigadeWeek(
      full,
      asOnePot({ ...LIVE, salt: 3 }),
      sundayNight({ regenerate: true, bought }),
    );
    assert.ok(!events.tables.some((t) => t.preparedOn), "no second Sunday dish appears");
    for (const d of [MON, TUE, WED, THU]) {
      const t = dinner(events, d);
      assert.equal(t.leftoverOf, sun.id, `${d} eats Sunday's pot`);
      assert.equal(t.recipeId, sun.recipeId, `${d} is Sunday's dish`);
    }
    assert.deepEqual(nights.uncovered, [], "no night is reported uncovered");
  }
});

test("I-14: Sunday night with Sunday's dinner set and Mon to Thu not set yet gives them Sunday's pot", () => {
  const { sunOnly, sun } = sundayOnly();
  for (const over of [{}, { keepSet: true, bought: () => false }, { regenerate: true }]) {
    const { events, nights } = planBrigadeWeek(sunOnly, asOnePot(LIVE), sundayNight(over));
    for (const d of [MON, TUE, WED, THU]) assert.equal(dinner(events, d).leftoverOf, sun.id, `${d}`);
    assert.ok(!events.tables.some((t) => t.preparedOn), "no second Sunday dish appears");
    assert.deepEqual(nights.uncovered, []);
  }
});

test("I-14: a rule saved with the setting ON and no batches still feeds Mon to Thu on Sunday night with Sunday unset", () => {
  const rule = asOnePot({ ...LIVE, batches: undefined });
  const before = JSON.stringify(rule);
  const { events, nights } = planBrigadeWeek({ tables: [] }, rule, sundayNight());
  const mon = dinner(events, MON);
  assert.ok(mon && !mon.leftoverOf, "Monday is the pot");
  assert.equal(mon.preparedOn, SUN, "cooked tonight, Sunday");
  for (const d of [TUE, WED, THU]) assert.equal(dinner(events, d).leftoverOf, mon.id, `${d}`);
  assert.deepEqual(nights.uncovered, []);
  assert.equal(JSON.stringify(rule), before, "the rule itself is not changed");
  assert.equal(rule.batches, undefined, "no batches are written to it");
  // Sunday morning, the same rule: one Sunday pot, no second dish
  const morning = planBrigadeWeek({ tables: [] }, rule, ctx());
  assert.ok(!morning.events.tables.some((t) => t.preparedOn), "no second Sunday dish");
  for (const d of [MON, TUE, WED, THU])
    assert.equal(dinner(morning.events, d).leftoverOf, dinner(morning.events, SUN).id, `${d}`);
});

test("I-14: Sunday morning and mid-week runs plan the same as before the loop 2 fix", () => {
  // Sunday morning, PICK DIFFERENT MEALS: Sunday is in the run and re-rolls
  const { full } = sundayOnly();
  const reroll = planBrigadeWeek(full, asOnePot({ ...LIVE, salt: 5 }), ctx({ regenerate: true }));
  const sun = dinner(reroll.events, SUN);
  for (const d of [MON, TUE, WED, THU]) assert.equal(dinner(reroll.events, d).leftoverOf, sun.id, `${d}`);
  assert.deepEqual(reroll.nights.uncovered, []);
  // mid-week (Wednesday), the week as set: Wed and Thu keep Sunday's pot
  const wed = ctx({ dates: WEEK.slice(3), today: WED, keepSet: true, bought: () => true });
  const mid = planBrigadeWeek(full, asOnePot(LIVE), wed);
  for (const d of [WED, THU]) assert.equal(dinner(mid.events, d).leftoverOf, dinner(full, SUN).id, `${d}`);
  assert.deepEqual(mid.nights.uncovered, []);
  // mid-week with a past Sunday nobody cooked or bought: not a pot, as before
  const { sunOnly } = sundayOnly();
  const unbought = planBrigadeWeek(
    sunOnly,
    asOnePot(LIVE),
    ctx({ dates: WEEK.slice(3), today: WED, bought: () => false }),
  );
  for (const d of [WED, THU])
    assert.notEqual(dinner(unbought.events, d).leftoverOf, dinner(full, SUN).id, `${d} is not fed by it`);
});

test("I-14: an edit that removes Sunday's dinner saves no Sunday batch, even one the rule had", () => {
  const kept = [{ cookDay: 0, feeds: [1, 2, 3, 4] }];
  const on = { sundayBatch: true, kept };
  const base = { slots: ["breakfast", "dinner"], cookDays: [0, 5, 6] };
  assert.deepEqual(batchesOnSave({ ...on, ...base }, []), kept, "an edit that keeps Sunday keeps them");
  assert.equal(batchesOnSave({ ...on, ...base, cookDays: [5, 6] }, []), undefined, "Sunday no longer a cook night");
  assert.equal(batchesOnSave({ ...on, ...base, slots: ["breakfast"] }, []), undefined, "dinner no longer shared");
  assert.equal(
    batchesOnSave({ ...on, ...base, cookDays: [0, 1, 2, 3, 4, 5, 6] }, []),
    undefined,
    "every night a cook night",
  );
  // OFF, the same: no Sunday pot, no ticked nights saved
  assert.equal(batchesOnSave({ sundayBatch: false, ...base, cookDays: [5, 6] }, [1, 2]), undefined);
});

test("a cooked Sunday pot never feeds a night past a later cook night after a mid-week re-roll (Tribunal Final Gate 1.95, loop 3)", () => {
  const rule = { ...LIVE, cookDays: [0, 3], batches: undefined, sundayBatch: false, rotateCooks: false };
  const morning = planBrigadeWeek({ tables: [] }, rule, ctx());
  const sun = dinner(morning.events, SUN);
  assert.ok(sun, "Sunday has a pot");
  const cooked = {
    ...morning.events,
    tables: morning.events.tables.map((t) => (t.id === sun.id ? { ...t, cookedAt: `${SUN}T19:00:00` } : t)),
  };
  const rest = WEEK.slice(4); // Thursday on
  const { events } = planBrigadeWeek(
    cooked,
    rule,
    ctx({ dates: rest, today: THU, calendarToday: THU, regenerate: true, bought: () => false }),
  );
  const thu = dinner(events, THU);
  assert.ok(thu, "Thursday has a dinner");
  assert.notEqual(thu.leftoverOf, sun.id, "Sunday's pot was sized for Mon and Tue and is gone");
});
