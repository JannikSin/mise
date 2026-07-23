import test from "node:test";
import assert from "node:assert/strict";
import {
  corsFor,
  buildScanRequest,
  buildReceiptRequest,
  buildRemedyRequest,
  parseToolUse,
  validateScanItems,
  validateReceiptItems,
  buildOnboardRequest,
  parseOnboardResponse,
  validateOnboardProfile,
  validateProtocol,
  allowRequest,
  sanitizePeople,
  buildMenuRequest,
  validateMenuReport,
  buildTailorRequest,
  validateTailor,
  buildDinnerRequest,
  parseDinnerResponse,
  validateDinnerDecision,
} from "../worker/src/lib.js";

test("corsFor allows only the app origins", () => {
  const prod = corsFor("https://janniksin.github.io");
  assert.equal(prod && prod["Access-Control-Allow-Origin"], "https://janniksin.github.io");
  const dev = corsFor("http://127.0.0.1:8378");
  assert.equal(dev && dev["Access-Control-Allow-Origin"], "http://127.0.0.1:8378");
  assert.equal(corsFor("https://evil.example"), null);
  assert.equal(corsFor(null), null);
});

test("buildScanRequest forces the record_items tool with the image attached", () => {
  const req = buildScanRequest({ image: "AAAA", mediaType: "image/jpeg", model: "m" });
  assert.equal(req.model, "m");
  assert.equal(req.tool_choice.name, "record_items");
  const img = req.messages[0].content.find((c) => c.type === "image");
  assert.equal(img.source.data, "AAAA");
  assert.equal(img.source.media_type, "image/jpeg");
  const schema = req.tools[0].input_schema;
  assert.ok(schema.properties.items, "items array in tool schema");
});

test("buildRemedyRequest forces the record_protocol tool and carries the text", () => {
  const req = buildRemedyRequest({ text: "scratchy throat and tired", model: "m" });
  assert.equal(req.tool_choice.name, "record_protocol");
  assert.match(JSON.stringify(req.messages), /scratchy throat/);
  assert.match(req.system, /not a doctor|not medical/i);
});

test("parseToolUse pulls the forced tool input out of an Anthropic response", () => {
  const resp = {
    content: [
      { type: "text", text: "thinking..." },
      { type: "tool_use", name: "record_items", input: { items: [{ name: "eggs" }] } },
    ],
  };
  assert.deepEqual(parseToolUse(resp, "record_items"), { items: [{ name: "eggs" }] });
  assert.equal(parseToolUse(resp, "record_protocol"), null);
  assert.equal(parseToolUse({}, "record_items"), null);
});

test("validateScanItems sanitizes: trims names, defaults kind, drops junk, caps at 60", () => {
  const items = validateScanItems({
    items: [
      { name: "  Eggs ", kind: "perishable", qty: "12" },
      { name: "Rice", kind: "staple" },
      { name: "Mystery", kind: "weird-kind" },
      { name: "" },
      { name: 42 },
      "not-an-object",
      { name: "x".repeat(300), kind: "staple", qty: "y".repeat(300) },
    ],
  });
  assert.equal(items.length, 4);
  assert.deepEqual(items[0], { name: "Eggs", kind: "perishable", qty: "12" });
  assert.deepEqual(items[1], { name: "Rice", kind: "staple", qty: "" });
  assert.equal(items[2].kind, "perishable", "unknown kind defaults to perishable");
  assert.ok(items[3].name.length <= 80, "name capped");
  assert.ok(items[3].qty.length <= 40, "qty capped");
});

test("validateScanItems caps the list length", () => {
  const many = { items: Array.from({ length: 100 }, (_, i) => ({ name: `item ${i}` })) };
  assert.equal(validateScanItems(many).length, 60);
});

test("allowRequest: caps requests per key per window, then resets", () => {
  const state = new Map();
  const t0 = 1_000_000;
  for (let i = 0; i < 30; i++) {
    assert.equal(allowRequest(state, "k", t0 + i), true, `request ${i} allowed`);
  }
  assert.equal(allowRequest(state, "k", t0 + 31), false, "31st inside window blocked");
  assert.equal(allowRequest(state, "other", t0 + 32), true, "other key unaffected");
  assert.equal(allowRequest(state, "k", t0 + 10 * 60 * 1000 + 1), true, "new window resets");
});

test("validateProtocol keeps only string arrays under the caps", () => {
  const p = validateProtocol({
    teas: ["ginger tea", 42, "honey lemon"],
    foods: "not-an-array",
    avoid: [],
    notes: Array.from({ length: 30 }, (_, i) => `note ${i}`),
  });
  assert.deepEqual(p.teas, ["ginger tea", "honey lemon"]);
  assert.deepEqual(p.foods, []);
  assert.deepEqual(p.avoid, []);
  assert.equal(p.notes.length, 12, "notes capped");
});

test("buildReceiptRequest forces the record_receipt tool with the image", () => {
  const req = buildReceiptRequest({
    image: "abc",
    mediaType: "image/jpeg",
    model: "claude-sonnet-5",
  });
  assert.equal(req.tool_choice.name, "record_receipt");
  assert.equal(req.messages[0].content[0].source.data, "abc");
});

test("validateReceiptItems keeps priced food lines, drops junk and non-positive prices", () => {
  const out = validateReceiptItems({
    store: "  TRADER JOE'S #703  ",
    items: [
      { name: "black beans", price: 1.09, size: "15.5 oz" },
      { name: "bananas", price: 0.23 },
      { name: "coupon", price: -2 }, // discount line dropped
      { name: "", price: 5 }, // no name dropped
      { name: "tax", price: 0 }, // zero price dropped
      { junk: true },
    ],
  });
  assert.equal(out.store, "TRADER JOE'S #703");
  assert.deepEqual(out.items, [
    { name: "black beans", price: 1.09, size: "15.5 oz" },
    { name: "bananas", price: 0.23, size: "" },
  ]);
});

test("buildOnboardRequest primes the system with known survey answers, maps roles", () => {
  const req = buildOnboardRequest({
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ],
    survey: { name: "Sam", goal: "gain" },
    model: "claude-sonnet-5",
  });
  assert.ok(req.system.includes("Sam"), "survey folded into system");
  assert.equal(req.tools[0].name, "record_profile");
  assert.equal(req.messages[1].role, "assistant");
});

test("parseOnboardResponse returns text as reply, tool call as profile", () => {
  // a question turn
  const q = parseOnboardResponse({ content: [{ type: "text", text: "What's your goal?" }] });
  assert.equal(q.reply, "What's your goal?");
  assert.equal(q.profile, null);
  // a finished turn with a valid profile
  const done = parseOnboardResponse({
    content: [
      {
        type: "tool_use",
        name: "record_profile",
        input: {
          name: "Sam",
          emoji: "🏃",
          sex: "m",
          age: 30,
          heightFt: 5,
          heightIn: 10,
          weightLb: 170,
          activity: 3,
          goal: "maintain",
        },
      },
    ],
  });
  assert.equal(done.reply, "");
  assert.equal(done.profile.name, "Sam");
  assert.equal(done.profile.activity, 3);
  assert.equal(done.profile.leftoverTolerance, "some"); // default applied
});

test("sanitizePeople caps strings, numbers, lists; drops nameless and non-objects", () => {
  const people = sanitizePeople([
    {
      id: "david",
      name: "  David ",
      goal: "gain",
      calories: 3700.4,
      protein: 210,
      diet: "omnivore",
      avoid: ["onion", 42, "  shallot "],
      say: "something spicy",
    },
    { name: "" }, // nameless dropped
    "junk",
    { name: "x".repeat(100), calories: -5, protein: "lots" },
  ]);
  assert.equal(people.length, 2);
  assert.equal(people[0].name, "David");
  assert.equal(people[0].calories, 3700);
  assert.deepEqual(people[0].avoid, ["onion", "shallot"]);
  assert.ok(people[1].name.length <= 40);
  assert.equal(people[1].calories, 0, "non-positive calories zeroed");
  assert.equal(people[1].protein, 0, "non-number protein zeroed");
});

test("sanitizePeople caps the list at 8", () => {
  const many = sanitizePeople(Array.from({ length: 12 }, (_, i) => ({ name: `p${i}` })));
  assert.equal(many.length, 8);
});

test("buildMenuRequest forces record_menu with the image and every diner line", () => {
  const req = buildMenuRequest({
    image: "IMG",
    mediaType: "image/jpeg",
    diners: sanitizePeople([
      { name: "David", goal: "gain", calories: 3700, protein: 210 },
      { name: "Mom", goal: "loss", calories: 1500, protein: 100, avoid: ["cilantro"] },
    ]),
    model: "m",
  });
  assert.equal(req.tool_choice.name, "record_menu");
  assert.equal(req.messages[0].content[0].source.data, "IMG");
  const text = req.messages[0].content[1].text;
  assert.match(text, /David: goal gain/);
  assert.match(text, /never serve: cilantro/);
});

test("validateMenuReport caps picks at 3 per diner and sanitizes numbers", () => {
  const out = validateMenuReport({
    diners: [
      {
        name: "David",
        picks: [
          { item: "Steak burrito", why: "protein dense", estCalories: 1100.6, estProtein: 55 },
          { item: "Chicken bowl", why: "backup", estCalories: 900, estProtein: 60 },
          { item: "c", why: "", estCalories: 1, estProtein: 1 },
          { item: "d", why: "", estCalories: 1, estProtein: 1 },
        ],
        skip: ["churros", 42],
      },
      { name: "", picks: [], skip: [] }, // nameless dropped
    ],
    notes: ["split a guac", "n2", "n3", "n4"],
  });
  assert.equal(out.diners.length, 1);
  assert.equal(out.diners[0].picks.length, 3);
  assert.equal(out.diners[0].picks[0].estCalories, 1101);
  assert.deepEqual(out.diners[0].skip, ["churros"]);
  assert.equal(out.notes.length, 3, "notes capped");
});

test("buildTailorRequest carries the dish, macros and seat ids", () => {
  const req = buildTailorRequest({
    recipe: {
      name: "Lentil bolognese",
      servings: 4,
      calories: 620,
      protein: 32,
      carbs: 80,
      fat: 14,
      ingredients: ["lentils", "pasta", "tomatoes"],
    },
    seats: sanitizePeople([
      { id: "david", name: "David", goal: "gain", calories: 3700, protein: 210 },
      { id: "mom", name: "Mom", goal: "loss", calories: 1500, protein: 100 },
    ]),
    model: "m",
  });
  assert.equal(req.tool_choice.name, "record_tailor");
  const text = req.messages[0].content[0].text;
  assert.match(text, /Lentil bolognese/);
  assert.match(text, /\[david\]/);
  assert.match(text, /\[mom\]/);
});

test("validateTailor keeps only allowed seat ids and drops empty plates", () => {
  const out = validateTailor(
    {
      seats: [
        {
          id: "david",
          plate: ["add 100g extra tofu", " skip nothing "],
          estCalories: 950.2,
          estProtein: 58,
        },
        { id: "mom", plate: [], estCalories: 400, estProtein: 30 }, // empty plate dropped
        { id: "intruder", plate: ["poison"], estCalories: 1, estProtein: 1 }, // not at the table
        { id: "david", plate: ["dupe"], estCalories: 1, estProtein: 1 }, // dupe ignored
      ],
      cook: ["hold the bread back", 42, "plate mom's without pasta"],
    },
    ["david", "mom"],
  );
  assert.deepEqual(Object.keys(out.seats), ["david"]);
  assert.equal(out.seats.david.estCalories, 950);
  assert.deepEqual(out.seats.david.plate, ["add 100g extra tofu", "skip nothing"]);
  assert.deepEqual(out.cook, ["hold the bread back", "plate mom's without pasta"]);
});

test("buildDinnerRequest folds people, asks and candidates into the system", () => {
  const req = buildDinnerRequest({
    messages: [{ role: "user", content: "what's for dinner" }],
    people: sanitizePeople([
      {
        id: "david",
        name: "David",
        goal: "gain",
        calories: 3700,
        protein: 210,
        say: "something spicy",
      },
    ]),
    candidates: [
      {
        id: "chana-masala-brown-rice",
        name: "Chana Masala",
        calories: 700,
        protein: 30,
        cuisine: "indian",
      },
    ],
    model: "m",
  });
  assert.match(req.system, /tonight's ask: "something spicy"/);
  assert.match(req.system, /chana-masala-brown-rice/);
  assert.equal(req.tools[0].name, "record_dinner");
});

test("parseDinnerResponse: text is reply, a valid pick is a decision", () => {
  const q = parseDinnerResponse(
    { content: [{ type: "text", text: "Spice level?" }] },
    ["a"],
    ["david"],
  );
  assert.equal(q.reply, "Spice level?");
  assert.equal(q.decision, null);
  const done = parseDinnerResponse(
    {
      content: [
        {
          type: "tool_use",
          name: "record_dinner",
          input: {
            pickRecipeId: "a",
            plates: [{ id: "david", note: "extra rice", estCalories: 1100, estProtein: 50 }],
            why: "spicy and on target",
          },
        },
      ],
    },
    ["a"],
    ["david"],
  );
  assert.equal(done.decision.pickRecipeId, "a");
  assert.equal(done.decision.plates[0].note, "extra rice");
});

test("validateDinnerDecision rejects an unknown pick with no special", () => {
  assert.equal(
    validateDinnerDecision({ pickRecipeId: "nope", plates: [], why: "" }, ["a"], []),
    null,
  );
});

test("validateDinnerDecision accepts a complete special meal and normalizes it", () => {
  const d = validateDinnerDecision(
    {
      pickRecipeId: "",
      special: {
        name: "Harissa Chickpea Skillet",
        description: "Smoky, spicy, one pan.",
        servings: 2.4,
        totalTime: 25,
        ingredients: [
          { qty: 400, unit: "g", food: "chickpeas" },
          { qty: 2, unit: "tbsp", food: "harissa" },
          { qty: 0, unit: "g", food: "dropped" }, // zero qty dropped
        ],
        instructions: ["Sauté the harissa.", "Add chickpeas, simmer."],
        nutrition: { calories: 650, protein: 28, carbs: 70, fat: 22 },
        foodGroups: { beans: 2, junkKey: 3, greens: -1 },
      },
      plates: [
        { id: "david", note: "double portion", estCalories: 1300, estProtein: 56 },
        { id: "ghost", note: "x", estCalories: 1, estProtein: 1 }, // unknown person dropped
      ],
      why: "nobody's bank pick fit the spice ask",
    },
    ["a"],
    ["david"],
  );
  assert.ok(d);
  assert.equal(d.pickRecipeId, "");
  assert.equal(d.special.servings, 2, "servings rounded");
  assert.equal(d.special.ingredients.length, 2, "zero-qty ingredient dropped");
  assert.equal(d.special.instructions[1].step, 2, "instructions numbered");
  assert.equal(d.special.nutrition.method, "estimated");
  assert.deepEqual(
    d.special.foodGroups,
    { beans: 2, method: "estimated" },
    "junk keys and negatives dropped",
  );
  assert.equal(d.plates.length, 1);
});

test("validateDinnerDecision rejects an incomplete special (too few instructions)", () => {
  assert.equal(
    validateDinnerDecision(
      {
        pickRecipeId: "",
        special: {
          name: "X",
          servings: 2,
          totalTime: 20,
          ingredients: [
            { qty: 1, unit: "x", food: "a" },
            { qty: 1, unit: "x", food: "b" },
          ],
          instructions: ["only one step"],
          nutrition: { calories: 1, protein: 1, carbs: 1, fat: 1 },
        },
        plates: [],
        why: "",
      },
      [],
      [],
    ),
    null,
  );
});

test("validateOnboardProfile rejects incomplete required fields", () => {
  // missing weight -> null (not done yet)
  assert.equal(
    validateOnboardProfile({
      name: "X",
      sex: "m",
      age: 30,
      heightFt: 5,
      heightIn: 10,
      activity: 2,
      goal: "gain",
    }),
    null,
  );
  // bad goal -> null
  assert.equal(
    validateOnboardProfile({
      name: "X",
      sex: "m",
      age: 30,
      heightFt: 5,
      heightIn: 10,
      weightLb: 170,
      activity: 2,
      goal: "bulk",
    }),
    null,
  );
});
