import test from "node:test";
import assert from "node:assert/strict";
import {
  sundayTwoPotsOn,
  twoPotSplit,
  validBrigade,
  deriveTables,
} from "../app/lib/tables.js";
import { planBrigadeWeek } from "../app/lib/compose.js";
import {
  freshProteinOk,
  freshMeatFor,
  meatPhrase,
  splitSteps,
  freshSundayLines,
  freshNightLines,
} from "../app/lib/cadence.js";

// THE TWO SUNDAY POTS (David, 2026-10-25): Fri and Sat each their own dish;
// Sunday cooks meal A (Sun and Mon) and preps meal B (Tue to Thu), all but
// the meat.

const dish = (id, food, extra = {}) => ({
  id,
  name: id,
  mealType: "dinner",
  servings: 4,
  safeDays: 4,
  tags: ["batch-friendly"],
  nutrition: { calories: 600, protein: 40 },
  ingredients: [
    { qty: 600, unit: "g", food, note: extra.note ?? "" },
    { qty: 300, unit: "g", food: "brown rice" },
  ],
  instructions: [
    { step: 1, text: "Cook the rice." },
    { step: 2, text: `Brown the ${food} in a hot pan.` },
    { step: 3, text: "Whisk the sauce." },
  ],
  ...extra,
});

const BANK = new Map(
  [
    dish("beef-bowl", "ground beef"),
    dish("turkey-bowl", "ground turkey"),
    dish("chicken-strips", "chicken breast", { note: "sliced thin" }),
    dish("whole-thigh-bake", "chicken thighs", { note: "left whole", tags: ["dump-and-bake"] }),
    dish("rotisserie-pasta", "rotisserie chicken"),
    dish("pork-stew", "pork shoulder", { note: "in big chunks", safeDays: 4 }),
    dish("beef-chili", "ground beef", { tags: ["one-pot"] }),
  ].map((r) => [r.id, r]),
);

const PROFILES = new Map([
  ["david", { id: "david", household: "wayne" }],
  ["elliot", { id: "elliot", household: "wayne" }],
]);
const TARGETS = new Map([
  ["david", { macros: { calories: 3700, protein: 190 }, mealSlots: ["breakfast", "lunch", "dinner"] }],
  ["elliot", { macros: { calories: 2400 }, mealSlots: ["breakfast", "lunch", "dinner"] }],
]);
const WEEK = [
  "2026-11-01",
  "2026-11-02",
  "2026-11-03",
  "2026-11-04",
  "2026-11-05",
  "2026-11-06",
  "2026-11-07",
];
// his live rule, as saved (households/wayne/events.json, id 20974b9d)
const LIVE = {
  id: "20974b9d",
  name: "Wayne kitchen",
  memberIds: ["david", "elliot"],
  slots: ["dinner"],
  cookId: "david",
  rotateCooks: true,
  from: "2026-10-13",
  until: "2026-11-09",
  cookDays: [0, 5, 6],
  batches: [{ cookDay: 0, feeds: [1, 2, 3, 4] }],
  dinnerMeat: true,
};
const ctx = (over = {}) => ({
  dates: WEEK,
  today: "2026-11-01",
  calendarToday: "2026-11-01",
  house: "wayne",
  profilesById: PROFILES,
  targetsById: TARGETS,
  plansById: new Map(),
  bankById: BANK,
  keepSet: true,
  ...over,
});
// the app's own defaulting step (main.js handleRunBrigade)
const asPlanned = (b) => ({ ...b, sundayBatch: b.sundayBatch !== false, sundayTwoPots: sundayTwoPotsOn(b) });
const dinners = (events) =>
  events.tables.filter((t) => t.slot === "dinner").sort((a, b) => a.date.localeCompare(b.date));

test("two pots is the default for a Sun, Fri, Sat rule; one pot and picked nights stay choosable", () => {
  assert.equal(sundayTwoPotsOn(LIVE), true);
  assert.equal(sundayTwoPotsOn({ ...LIVE, sundayTwoPots: false }), false);
  assert.equal(sundayTwoPotsOn({ ...LIVE, sundayBatch: false }), false);
  assert.deepEqual(twoPotSplit([0, 5, 6]), { a: [1], b: [2, 3, 4] });
  assert.deepEqual(twoPotSplit([0, 4, 5, 6]), { a: [1], b: [2, 3] });
  // two nights after Sunday is one pot's job; no Sunday cook, no Sunday pots
  assert.equal(twoPotSplit([0, 3, 5]), null);
  assert.equal(twoPotSplit([5, 6]), null);
  // B never runs past Thursday, day 4 from Sunday
  assert.deepEqual(twoPotSplit([0, 6]), { a: [1], b: [2, 3, 4] });
  assert.equal(validBrigade({ ...LIVE, sundayTwoPots: "yes" }), false);
  assert.equal(validBrigade({ ...LIVE, meatDaily: 1 }), false);
  assert.equal(validBrigade({ ...LIVE, sundayTwoPots: false, meatDaily: true }), true);
});

test("his live rule plans A Sun and Mon, B Tue to Thu from a fresh-meat dish, Fri and Sat their own", () => {
  for (let salt = 0; salt < 6; salt++) {
    const { events, nights } = planBrigadeWeek({ tables: [] }, asPlanned({ ...LIVE, salt }), ctx());
    const d = dinners(events);
    assert.equal(d.length, 7, `salt ${salt}`);
    const [sun, mon, tue, wed, thu, fri, sat] = d;
    assert.ok(!sun.leftoverOf && !sun.preparedOn, "Sunday cooks A");
    assert.equal(mon.leftoverOf, sun.id, "Monday eats A");
    assert.equal(tue.preparedOn, "2026-11-01", "B is prepped Sunday");
    assert.equal(tue.proteinFresh, "once", "B's meat is cooked Tuesday by default");
    assert.ok(freshProteinOk(BANK.get(tue.recipeId)), `salt ${salt}: ${tue.recipeId} cooks its meat fresh`);
    assert.notEqual(tue.recipeId, sun.recipeId, "two different Sunday dishes");
    assert.equal(wed.leftoverOf, tue.id);
    assert.equal(thu.leftoverOf, tue.id);
    for (const t of [fri, sat]) assert.ok(!t.leftoverOf && !t.preparedOn, `${t.date} cooks its own`);
    assert.notEqual(fri.recipeId, sat.recipeId);
    assert.deepEqual(nights.uncovered, []);
  }
});

test("meat each day is a rule setting; one pot for Mon to Thu is still the 1.95 week", () => {
  const daily = planBrigadeWeek({ tables: [] }, asPlanned({ ...LIVE, meatDaily: true }), ctx());
  assert.equal(dinners(daily.events)[2].proteinFresh, "daily");
  const one = planBrigadeWeek({ tables: [] }, asPlanned({ ...LIVE, sundayTwoPots: false }), ctx());
  const d = dinners(one.events);
  for (const t of d.slice(1, 5)) assert.equal(t.leftoverOf, d[0].id, `${t.date} eats Sunday's one pot`);
  assert.ok(d.every((t) => !t.proteinFresh));
});

test("SET MY WEEK keeps a set meal B, and a Sunday already cooked stays", () => {
  const first = planBrigadeWeek({ tables: [] }, asPlanned(LIVE), ctx());
  const again = planBrigadeWeek(first.events, asPlanned(LIVE), ctx());
  assert.deepEqual(
    dinners(again.events).map((t) => [t.date, t.recipeId, t.proteinFresh ?? null]),
    dinners(first.events).map((t) => [t.date, t.recipeId, t.proteinFresh ?? null]),
  );
  assert.equal(again.made, 0);
});

test("no fresh-meat dish passing everyone: B is cooked whole on Sunday, and said", () => {
  const bank = new Map(
    [dish("pork-stew", "pork shoulder", { note: "in big chunks" }), dish("beef-cheeks", "beef cheeks"), dish("rotisserie-pasta", "rotisserie chicken")].map((r) => [r.id, r]),
  );
  const { events, notes } = planBrigadeWeek({ tables: [] }, asPlanned(LIVE), ctx({ bankById: bank }));
  const tue = dinners(events)[2];
  assert.equal(tue.preparedOn, "2026-11-01");
  assert.equal(tue.proteinFresh, undefined);
  assert.ok(notes.some((n) => /cooked whole on Sunday/.test(n)), notes.join(" | "));
});

test("allergy screening still fails closed for meal B", () => {
  const targets = new Map([
    ["david", { ...TARGETS.get("david"), avoidIngredients: ["beef", "turkey"] }],
    ["elliot", TARGETS.get("elliot")],
  ]);
  const { events } = planBrigadeWeek({ tables: [] }, asPlanned(LIVE), ctx({ targetsById: targets }));
  for (const t of dinners(events)) {
    const food = BANK.get(t.recipeId).ingredients[0].food;
    assert.ok(!/beef|turkey/.test(food), `${t.date} served ${t.recipeId} to someone avoiding it`);
  }
});

test("which dishes can cook their meat later: fast cuts yes; whole, slow, precooked, baked-in no", () => {
  assert.equal(freshProteinOk(BANK.get("beef-bowl")), true);
  assert.equal(freshProteinOk(BANK.get("chicken-strips")), true);
  assert.equal(freshProteinOk(BANK.get("beef-chili")), true);
  assert.equal(freshProteinOk(BANK.get("whole-thigh-bake")), false);
  assert.equal(freshProteinOk(BANK.get("rotisserie-pasta")), false);
  assert.equal(freshProteinOk(BANK.get("pork-stew")), false);
  assert.equal(freshProteinOk(dish("x", "chicken breast")), false, "a whole breast is not 15 minutes");
  assert.equal(freshProteinOk(dish("x", "salmon fillet")), false);
  assert.equal(freshProteinOk(dish("x", "shrimp")), true);
  assert.equal(freshProteinOk(dish("x", "ground beef", { safeDays: 2 })), false, "the rest must hold");
  assert.equal(freshProteinOk(dish("x", "eggplant", { note: "diced" })), false, "eggplant is not egg");
  // a recipe's own tag wins either way
  assert.equal(freshProteinOk(dish("x", "pork shoulder", { freshProtein: true })), true);
  assert.equal(freshProteinOk(dish("x", "ground beef", { freshProtein: false })), false);
});

test("the night's meat scales to its plates, and Sunday's steps are the ones that skip the meat", () => {
  const r = BANK.get("beef-bowl");
  assert.deepEqual(freshMeatFor(r, 2), [{ food: "ground beef", qty: 300, unit: "g" }]);
  assert.equal(meatPhrase(freshMeatFor(r, 2.5)), "375 g ground beef");
  assert.deepEqual(splitSteps(r), {
    sunday: ["Cook the rice.", "Whisk the sauce."],
    night: ["Brown the ground beef in a hot pan."],
  });
});

test("the cards' safety lines: freeze later meat Sunday, cool fast, Thursday's rice to the freezer, 160 F and 165 F", () => {
  const sun = freshSundayLines(["Tue", "Wed", "Thu"], false).join(" ");
  assert.match(sun, /freeze Wed and Thu's/i);
  assert.match(sun, /within 2 hours, rice within 1 hour/);
  assert.match(sun, /Freeze Thu's rice or noodles/);
  const once = freshSundayLines(["Tue", "Wed", "Thu"], true).join(" ");
  assert.match(once, /fridge for Tue/);
  assert.match(once, /bought before Sunday, freeze it/);
  const meat = [{ food: "ground beef", qty: 300, unit: "g" }];
  const tue = freshNightLines({ meat, once: false, first: true, tomorrow: "Wed" }).join(" ");
  assert.match(tue, /300 g ground beef/);
  assert.match(tue, /160 F/);
  assert.match(tue, /165 F/);
  assert.match(tue, /move Wed's meat from the freezer to the fridge/);
  const wedDaily = freshNightLines({ meat, once: false, first: false, tomorrow: "Thu", tomorrowIsLast: true }).join(" ");
  assert.match(wedDaily, /move Thu's meat and rice/);
  const tueOnce = freshNightLines({ meat, once: true, first: true, laterNames: ["Wed", "Thu"], tomorrow: "Wed" }).join(" ");
  assert.match(tueOnce, /Cook all the meat tonight: 300 g ground beef, for tonight, Wed and Thu/);
  assert.match(tueOnce, /keeps 3 to 4 days/);
  const wedOnce = freshNightLines({ meat: [], once: true, first: false, tomorrow: "Thu", tomorrowIsLast: true }).join(" ");
  assert.match(wedOnce, /Reheat the meat and the rest/);
  assert.match(wedOnce, /move Thu's rice or noodles/);
});

test("the derived plan rows carry meal B's meat for that night", () => {
  const { events } = planBrigadeWeek({ tables: [] }, asPlanned({ ...LIVE, meatDaily: true }), ctx());
  const { entries } = deriveTables([{ house: "wayne", events }], {
    profileId: "david",
    ownEntries: [],
    diet: undefined,
    avoid: [],
    avoidRecipes: [],
    bankById: BANK,
    today: "2026-11-01",
    profilesById: PROFILES,
  });
  const byDate = new Map(entries.filter((e) => e.slot === "dinner").map((e) => [e.date, e]));
  for (const d of ["2026-11-03", "2026-11-04", "2026-11-05"]) {
    const e = byDate.get(d);
    assert.equal(e.proteinFresh, "daily", d);
    assert.ok(e.freshMeat?.[0]?.qty > 0, `${d} names its meat`);
  }
  assert.equal(byDate.get("2026-11-02").proteinFresh, undefined);
});

test("the Plan rows read: Sunday preps B all but the meat, Tuesday cooks it, Wed and Thu reheat", async () => {
  const { cookLine } = await import("../app/lib/plan.js");
  const { mealBLines, mealBSundayLines } = await import("../app/lib/cadence.js");
  const day = (iso) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(`${iso}T12:00:00`).getDay()];
  const { events } = planBrigadeWeek({ tables: [] }, asPlanned(LIVE), ctx());
  const { entries } = deriveTables([{ house: "wayne", events }], {
    profileId: "david",
    ownEntries: [],
    avoid: [],
    avoidRecipes: [],
    bankById: BANK,
    today: "2026-11-01",
    profilesById: PROFILES,
  });
  const at = (d) => entries.find((e) => e.slot === "dinner" && e.date === d);
  const sun = at("2026-11-01");
  assert.match(cookLine(sun, "david", day), /plus the batch for Tue: .*, all but the meat/);
  const sunLines = mealBSundayLines(sun.batchAlongside, day).join(" ");
  assert.match(sunLines, /keep it in the fridge for Tue/);
  assert.match(sunLines, /Freeze Thu's rice or noodles/);
  assert.match(cookLine(at("2026-11-03"), "david", day), /Sun prep, cook the meat tonight/);
  const tue = mealBLines(at("2026-11-03"), day).join(" ");
  assert.match(tue, /Cook all the meat tonight: \d+ g ground (beef|turkey)|Cook all the meat tonight: \d+ g chicken/);
  assert.match(cookLine(at("2026-11-04"), "david", day), /Sun prep and Tue's meat, reheat/);
  assert.match(mealBLines(at("2026-11-04"), day).join(" "), /move Thu's rice or noodles/);
  assert.match(mealBLines(at("2026-11-05"), day).join(" "), /Reheat the meat and the rest/);
  assert.deepEqual(mealBLines(at("2026-11-02"), day), []);
  for (const e of entries) for (const l of mealBLines(e, day)) assert.ok(!l.includes("—"), l);
});
