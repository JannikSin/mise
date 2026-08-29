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
  buildDinnerWeekRequest,
  validateDinnerWeek,
  WEEK_MEAL_SLOTS,
  hitsAvoid,
  screenTailorAvoid,
  specialAvoidHits,
  buildNotifications,
  isoWeekIdOf,
  buildAskRequest,
  parseAskResponse,
  sanitizeAskContext,
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

// --- multi-photo receipts (David, 2026-08-10) -----------------------------
// A long till roll does not fit in one frame. Several overlapping photos of
// ONE receipt travel in ONE request so the model can read the strip as a
// continuous list; reading them separately and de-duplicating afterwards
// cannot work, because a receipt legitimately prints the same item twice.

test("buildReceiptRequest carries every photo in one request, in order", () => {
  const req = buildReceiptRequest({
    images: [
      { image: "top", mediaType: "image/jpeg" },
      { image: "middle", mediaType: "image/jpeg" },
      { image: "bottom", mediaType: "image/png" },
    ],
    model: "claude-sonnet-5",
  });
  const content = req.messages[0].content;
  const imgs = content.filter((/** @type {any} */ c) => c.type === "image");
  assert.equal(req.messages.length, 1, "one request, never one per photo");
  assert.deepEqual(
    imgs.map((/** @type {any} */ i) => i.source.data),
    ["top", "middle", "bottom"],
    "order is the receipt's own order, top to bottom",
  );
  assert.equal(imgs[2].source.media_type, "image/png", "per-photo media type is kept");
  // each frame is labelled, so "in order" is actionable rather than assumed
  const labels = content
    .filter((/** @type {any} */ c) => c.type === "text" && /^Photo \d+ of \d+:$/.test(c.text))
    .map((/** @type {any} */ c) => c.text);
  assert.deepEqual(labels, ["Photo 1 of 3:", "Photo 2 of 3:", "Photo 3 of 3:"]);
});

test("a multi-photo receipt is told about the overlap; a single photo is not", () => {
  const many = buildReceiptRequest({
    images: [
      { image: "a", mediaType: "image/jpeg" },
      { image: "b", mediaType: "image/jpeg" },
    ],
    model: "m",
  });
  const manyText = many.messages[0].content
    .filter((/** @type {any} */ c) => c.type === "text")
    .map((/** @type {any} */ c) => c.text)
    .join(" ");
  assert.match(manyText, /OVERLAP/i, "the overlap is stated, not hoped for");
  assert.match(manyText, /EXACTLY ONCE/i, "and so is the do-not-double-count rule");
  assert.match(manyText, /2 photos/, "the count is interpolated, not left as a placeholder");
  assert.ok(!manyText.includes("%N%"), "no unreplaced placeholder reaches the model");
  // the same instruction must NOT fire on a single photo: telling a model to
  // watch for repeats it cannot see invites it to drop a real duplicate line
  const one = buildReceiptRequest({ image: "a", mediaType: "image/jpeg", model: "m" });
  const oneText = one.messages[0].content
    .filter((/** @type {any} */ c) => c.type === "text")
    .map((/** @type {any} */ c) => c.text)
    .join(" ");
  assert.ok(!/OVERLAP/i.test(oneText));
  assert.ok(!/^Photo /m.test(oneText), "a single photo is not labelled 1 of 1");
});

test("more photos get more output room", () => {
  const one = buildReceiptRequest({ image: "a", mediaType: "image/jpeg", model: "m" });
  const many = buildReceiptRequest({
    images: [
      { image: "a", mediaType: "image/jpeg" },
      { image: "b", mediaType: "image/jpeg" },
    ],
    model: "m",
  });
  assert.ok(many.max_tokens > one.max_tokens, "a 3-frame receipt is many more lines");
});

test("buildReceiptRequest refuses to build a request with no photo", () => {
  assert.throws(() => buildReceiptRequest({ model: "m" }), /no receipt photo/);
  assert.throws(() => buildReceiptRequest({ images: [], model: "m" }), /no receipt photo/);
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
  // no portionGrams sent → 0 (unknown), never NaN/undefined
  assert.equal(out.seats.david.portionGrams, 0);
});

test("validateTailor: portionGrams rounds, clamps to a sane plate, junk becomes 0", () => {
  const out = validateTailor(
    {
      seats: [
        { id: "a", portionGrams: 449.6, plate: ["x"], estCalories: 1, estProtein: 1 },
        { id: "b", portionGrams: 99999, plate: ["x"], estCalories: 1, estProtein: 1 },
        { id: "c", portionGrams: -5, plate: ["x"], estCalories: 1, estProtein: 1 },
        { id: "d", portionGrams: "450", plate: ["x"], estCalories: 1, estProtein: 1 },
      ],
      cook: [],
    },
    ["a", "b", "c", "d"],
  );
  assert.equal(out.seats.a.portionGrams, 450);
  assert.equal(out.seats.b.portionGrams, 3000, "clamped to a single-plate ceiling");
  assert.equal(out.seats.c.portionGrams, 0);
  assert.equal(out.seats.d.portionGrams, 0, "a string is junk, not parsed");
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

test("buildDinnerWeekRequest lists the meals, cuisine and people, and forces the tool", () => {
  const req = buildDinnerWeekRequest({
    meals: [
      { date: "2026-08-10", slot: "breakfast" },
      { date: "2026-08-10", slot: "dinner" },
    ],
    cuisine: "italian",
    note: "mom home Mon-Wed only",
    people: sanitizePeople([
      { id: "david", name: "David", goal: "gain", calories: 3700, protein: 210 },
    ]),
    candidates: [
      { id: "r1", name: "Lentil ragu", calories: 700, protein: 35, cuisine: "italian", meal: "dinner" },
    ],
    model: "m",
  });
  assert.equal(req.tool_choice.name, "record_dinner_week");
  const text = req.messages[0].content[0].text;
  assert.match(text, /2026-08-10 breakfast, 2026-08-10 dinner/);
  assert.match(text, /italian/);
  assert.match(text, /mom home Mon-Wed only/);
  assert.match(req.system, /\[david\]/);
  assert.match(req.system, /r1: Lentil ragu \(dinner, /);
});

test("buildDinnerWeekRequest carries attendance so an away day plans no plate", () => {
  const req = buildDinnerWeekRequest({
    meals: [
      { date: "2026-08-13", slot: "dinner" },
      { date: "2026-08-14", slot: "dinner" },
    ],
    cuisine: "",
    note: "",
    away: { mom: ["2026-08-13", "2026-08-14"] },
    people: sanitizePeople([
      { id: "david", name: "David", goal: "gain", calories: 3700, protein: 210 },
      { id: "mom", name: "Mom", goal: "loss", calories: 1500, protein: 100 },
    ]),
    candidates: [],
    model: "m",
  });
  const text = req.messages[0].content[0].text;
  assert.match(text, /\[mom\] is NOT at the table on 2026-08-13, 2026-08-14/);
  assert.match(text, /no plate those days/);
});

test("a date|slot away entry empties ONE meal, not the day (a dining swipe)", () => {
  // 2026-08-28 plenum: the week run takes the runner off just the lunch pot
  // when a swipe covers it — dinner that same day still gets their plate
  const req = buildDinnerWeekRequest({
    meals: [
      { date: "2026-08-31", slot: "lunch" },
      { date: "2026-08-31", slot: "dinner" },
    ],
    cuisine: "",
    note: "",
    away: { david: ["2026-08-31|lunch"] },
    people: sanitizePeople([
      { id: "david", name: "David", goal: "gain", calories: 3700, protein: 210 },
      { id: "mom", name: "Mom", goal: "loss", calories: 1500, protein: 100 },
    ]),
    candidates: [],
    model: "m",
  });
  const text = req.messages[0].content[0].text;
  assert.match(text, /\[david\] is NOT at lunch on 2026-08-31/);
  assert.match(text, /no lunch plate that day/);
  assert.doesNotMatch(text, /\[david\] is NOT at the table/);
});

test("a covered entry makes the model aim at the REMAINDER of the day (plenum r2)", () => {
  // measured on the real W36: without this the model wrote 1,400 kcal
  // breakfasts because it balanced whole days over two cooked meals, then
  // the swipe and the fixed smoothie landed on top — 266 g days vs 190
  const req = buildDinnerWeekRequest({
    meals: [
      { date: "2026-08-31", slot: "breakfast" },
      { date: "2026-08-31", slot: "dinner" },
    ],
    cuisine: "",
    note: "",
    covered: {
      david: { calories: 1902, protein: 116, note: "a dining-hall lunch and a fixed smoothie" },
    },
    people: sanitizePeople([
      { id: "david", name: "David", goal: "gain", calories: 3700, protein: 190 },
    ]),
    candidates: [],
    model: "m",
  });
  const text = req.messages[0].content[0].text;
  assert.match(text, /\[david\] already eats ~1902 kcal \/ ~116 g protein each day/);
  assert.match(text, /a dining-hall lunch and a fixed smoothie/);
  // 3700-1902 and 190-116, computed FOR the model, not left to it
  assert.match(text, /aim at roughly 1798 kcal \/ 74 g protein a day/);
  assert.match(req.system, /MINUS that amount/);
});

test("smoothie and snack are plannable week slots the tool schema accepts", () => {
  // 2026-08-28 plenum: a brigade sharing its smoothies was silently dropped
  // by the old breakfast/lunch/dinner enum
  assert.deepEqual(WEEK_MEAL_SLOTS, ["breakfast", "lunch", "dinner", "smoothie", "snack"]);
  const req = buildDinnerWeekRequest({
    meals: [{ date: "2026-08-31", slot: "smoothie" }],
    cuisine: "",
    note: "",
    people: sanitizePeople([
      { id: "david", name: "David", goal: "gain", calories: 3700, protein: 210 },
    ]),
    candidates: [
      { id: "s1", name: "PB banana smoothie", calories: 600, protein: 40, cuisine: "", meal: "smoothie" },
    ],
    model: "m",
  });
  assert.match(req.messages[0].content[0].text, /2026-08-31 smoothie/);
  assert.deepEqual(
    req.tools[0].input_schema.properties.nights.items.properties.slot.enum,
    WEEK_MEAL_SLOTS,
  );
  assert.match(req.system, /smoothie slot gets a blended drink/);
});

test("validateDinnerWeek: one decision per requested date+slot, junk meals dropped, order kept", () => {
  const meals = [
    { date: "2026-08-10", slot: "breakfast" },
    { date: "2026-08-10", slot: "dinner" },
    { date: "2026-08-11", slot: "dinner" },
    { date: "2026-08-12", slot: "dinner" },
  ];
  const good = (date, slot, pick) => ({
    date,
    slot,
    pickRecipeId: pick,
    plates: [{ id: "david", note: "450 g of the dish", estCalories: 1100, estProtein: 50 }],
    why: "fits",
  });
  const out = validateDinnerWeek(
    {
      nights: [
        good("2026-08-11", "dinner", "b"), // out of order — result re-sorts to request order
        good("2026-08-10", "breakfast", "a"),
        // absent slot defaults to dinner (pre-slot tool shape still validates)
        { ...good("2026-08-10", "dinner", "b"), slot: undefined },
        good("2026-08-10", "dinner", "a"), // duplicate date+slot ignored
        good("2026-08-10", "snack", "a"), // slot never requested
        good("2026-08-30", "dinner", "a"), // date never requested
        { date: "2026-08-12", slot: "dinner", pickRecipeId: "nope", plates: [], why: "" }, // unknown pick
        "junk",
      ],
    },
    ["a", "b"],
    ["david"],
    meals,
  );
  assert.deepEqual(
    out.map((n) => [n.date, n.slot, n.pickRecipeId]),
    [
      ["2026-08-10", "breakfast", "a"],
      ["2026-08-10", "dinner", "b"],
      ["2026-08-11", "dinner", "b"],
    ],
  );
  assert.equal(out[0].plates[0].note, "450 g of the dish");
});

test("validateDinnerWeek returns [] for junk input", () => {
  const meals = [{ date: "2026-08-10", slot: "dinner" }];
  assert.deepEqual(validateDinnerWeek(null, ["a"], ["p"], meals), []);
  assert.deepEqual(validateDinnerWeek({ nights: "x" }, ["a"], ["p"], meals), []);
});

test("specialAvoidHits screens name and instructions, not only ingredients", () => {
  const people = [{ name: "Mom", avoid: ["peanut"] }];
  assert.equal(
    specialAvoidHits({ ingredients: [{ food: "tofu" }] }, people).length,
    0,
    "clean special passes",
  );
  assert.equal(
    specialAvoidHits(
      {
        name: "Stir fry",
        ingredients: [{ food: "tofu" }],
        instructions: [{ step: 1, text: "garnish with crushed peanuts" }],
      },
      people,
    ).length,
    1,
    "an avoided food in the instructions is as real as an ingredient row",
  );
});

test("validateDinnerDecision clamps runaway macros before they reach stored files", () => {
  const d = validateDinnerDecision(
    {
      pickRecipeId: "",
      special: {
        name: "Big Bowl",
        servings: 2,
        totalTime: 20,
        ingredients: [
          { qty: 1, unit: "x", food: "a" },
          { qty: 1, unit: "x", food: "b" },
        ],
        instructions: ["one", "two"],
        nutrition: { calories: 1e300, protein: 99999, carbs: 10, fat: 10 },
      },
      plates: [{ id: "p", note: "x", estCalories: 1e300, estProtein: -5 }],
      why: "",
    },
    [],
    ["p"],
  );
  assert.ok(d);
  assert.equal(d.special.nutrition.calories, 5000);
  assert.equal(d.special.nutrition.protein, 500);
  assert.equal(d.plates[0].estCalories, 6000);
  assert.equal(d.plates[0].estProtein, 0);
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

test("hitsAvoid matches case-insensitively and returns the offending terms", () => {
  assert.deepEqual(hitsAvoid("add Cilantro-lime rice", ["cilantro", "onion"]), ["cilantro"]);
  assert.deepEqual(hitsAvoid("plain rice", ["cilantro"]), []);
  assert.deepEqual(hitsAvoid("anything", []), []);
});

test("screenTailorAvoid drops plate lines hitting the seat's own avoid list, code-enforced", () => {
  const out = screenTailorAvoid(
    {
      seats: {
        david: { plate: ["add onion relish", "extra tofu"], estCalories: 1000, estProtein: 60 },
        mom: { plate: ["skip the bread"], estCalories: 400, estProtein: 30 },
      },
      cook: ["one pot"],
    },
    [
      { id: "david", avoid: ["onion"] },
      { id: "mom", avoid: [] },
    ],
  );
  assert.deepEqual(out.seats.david.plate, ["extra tofu"], "onion line refused for david");
  assert.deepEqual(out.seats.mom.plate, ["skip the bread"]);
  assert.deepEqual(out.cook, ["one pot"]);
});

test("screenTailorAvoid drops a seat left with no clean lines", () => {
  const out = screenTailorAvoid(
    { seats: { david: { plate: ["add peanut sauce"], estCalories: 1, estProtein: 1 } }, cook: [] },
    [{ id: "david", avoid: ["peanut"] }],
  );
  assert.deepEqual(out.seats, {});
});

test("specialAvoidHits refuses a special whose ingredients hit any participant's list", () => {
  const special = {
    ingredients: [
      { qty: 1, unit: "x", food: "chickpeas" },
      { qty: 1, unit: "tbsp", food: "peanut butter" },
    ],
  };
  assert.deepEqual(
    specialAvoidHits(special, [
      { name: "David", avoid: [] },
      { name: "Laurie", avoid: ["peanut"] },
    ]),
    ["Laurie: peanut"],
  );
  assert.deepEqual(specialAvoidHits(special, [{ name: "David", avoid: ["onion"] }]), []);
});

test("isoWeekIdOf matches the app's ISO week math", () => {
  assert.equal(isoWeekIdOf("2026-07-23"), "2026-W30");
  assert.equal(isoWeekIdOf("2026-01-01"), "2026-W01");
  assert.equal(isoWeekIdOf("2027-01-01"), "2026-W53");
});

const NOTIF_BASE = {
  weekday: "Thu",
  dateIso: "2026-07-23",
  shopping: null,
  daily: null,
  recipeName: (id) => ({ "lentil-bolognese": "Lentil Bolognese" })[id] ?? id,
};
const PLAN_SHOPPED = {
  week: "2026-W30",
  shoppedAt: "2026-07-22",
  entries: [
    { id: "a", date: "2026-07-23", slot: "dinner", recipeId: "lentil-bolognese", servings: 1 },
    { id: "b", date: "2026-07-23", slot: "breakfast", recipeId: "lentil-bolognese", servings: 1 },
  ],
};

test("cook reminder fires at the slot hour for a shopped, uncooked meal", () => {
  const out = buildNotifications({ ...NOTIF_BASE, hour: 17, plan: PLAN_SHOPPED });
  assert.equal(out.length, 1);
  assert.equal(out[0].title, "Cook dinner");
  assert.match(out[0].body, /Lentil Bolognese/);
});

test("no cook reminder without the receipt confirmation (shoppedAt absent)", () => {
  const plan = { ...PLAN_SHOPPED };
  delete plan.shoppedAt;
  assert.deepEqual(buildNotifications({ ...NOTIF_BASE, hour: 17, plan }), []);
});

test("no cook reminder once the meal is marked cooked, or for OUT slots", () => {
  const cooked = {
    ...PLAN_SHOPPED,
    entries: [{ ...PLAN_SHOPPED.entries[0], cookedAt: "2026-07-23" }],
  };
  assert.deepEqual(buildNotifications({ ...NOTIF_BASE, hour: 17, plan: cooked }), []);
  const out = {
    ...PLAN_SHOPPED,
    entries: [{ id: "o", date: "2026-07-23", slot: "dinner", out: true, servings: 1 }],
  };
  assert.deepEqual(buildNotifications({ ...NOTIF_BASE, hour: 17, plan: out }), []);
});

test("a table dinner reminds even without shoppedAt (someone else shopped)", () => {
  const plan = {
    week: "2026-W30",
    entries: [
      {
        id: "t",
        date: "2026-07-23",
        slot: "dinner",
        table: "t1",
        freeText: "F Family dinner",
        servings: 1,
      },
    ],
  };
  const out = buildNotifications({ ...NOTIF_BASE, hour: 17, plan });
  assert.equal(out.length, 1);
  assert.match(out[0].body, /Family dinner/);
});

test("7am names the day's meals, and stays silent when there are none", () => {
  // the "Log: ..." nag retired 2026-08-09 — personal tracking lives in
  // Crystal, so mornings carry meals or nothing
  const out = buildNotifications({ ...NOTIF_BASE, hour: 7, plan: PLAN_SHOPPED });
  assert.equal(out.length, 1);
  assert.ok(!/Log:/.test(out[0].body), "no log nag");
  assert.match(out[0].body, /Tonight: Lentil Bolognese/);
  assert.deepEqual(
    buildNotifications({ ...NOTIF_BASE, hour: 7, plan: null }),
    [],
    "no meals, no morning notification",
  );
});

test("Saturday store nag fires only when unshopped with open items", () => {
  const shopping = {
    items: [
      { id: "x", checked: false },
      { id: "y", checked: true },
    ],
  };
  const plan = { week: "2026-W30", entries: [] };
  const out = buildNotifications({ ...NOTIF_BASE, weekday: "Sat", hour: 10, plan, shopping });
  assert.equal(out.length, 1);
  assert.match(out[0].body, /1 items/);
  assert.deepEqual(
    buildNotifications({ ...NOTIF_BASE, weekday: "Sat", hour: 10, plan: PLAN_SHOPPED, shopping }),
    [],
    "shopped week gets no store nag",
  );
});

test("Sunday sends the batch reminder at 10", () => {
  const out = buildNotifications({ ...NOTIF_BASE, weekday: "Sun", hour: 10, plan: null });
  assert.equal(out.length, 1);
  assert.equal(out[0].title, "Batch day");
});

test("evening catch-up covers only uncooked meals — the log nag retired to Crystal", () => {
  // no plan, nothing uncooked → silence (previously this hour nagged the log)
  assert.deepEqual(buildNotifications({ ...NOTIF_BASE, hour: 20, plan: null }), []);
  const out = buildNotifications({ ...NOTIF_BASE, hour: 20, plan: PLAN_SHOPPED });
  assert.equal(out.length, 1);
  assert.match(out[0].body, /2 planned meals not marked cooked/);
  assert.ok(!/Not logged yet/.test(out[0].body));
  const cooked = {
    ...PLAN_SHOPPED,
    entries: [{ ...PLAN_SHOPPED.entries[0], cookedAt: "2026-07-23" }],
  };
  assert.deepEqual(buildNotifications({ ...NOTIF_BASE, hour: 20, plan: cooked }), []);
});

test("/ask: request grounds in the sanitized snapshot, response is plain text", () => {
  const ctx = sanitizeAskContext({
    name: "David",
    targets: "3700 kcal / 210g protein daily",
    dinners: ["2026-08-04 Baked salmon — cook Laurie, groceries David | batch prep: none"],
    kitchen: Array.from({ length: 100 }, (_, i) => `item ${i}`),
    junk: { nested: "dropped" },
    notes: 42,
  });
  assert.equal(ctx.kitchen.length, 60, "lists cap");
  assert.equal(ctx.notes, undefined, "non-strings drop");
  assert.ok(!("junk" in ctx), "unknown keys drop");
  const req = buildAskRequest({
    messages: [{ role: "user", content: "how do I batch-cook the chicken?" }],
    context: ctx,
    model: "claude-sonnet-5",
  });
  assert.ok(req.system.includes("Live snapshot"));
  assert.ok(req.system.includes("Baked salmon"));
  assert.equal(req.messages.length, 1);
  assert.ok(!req.tools, "freeform text, no tools");
  const parsed = parseAskResponse({ content: [{ type: "text", text: "Sear then bake at 400F." }] });
  assert.equal(parsed.reply, "Sear then bake at 400F.");
  assert.ok(parseAskResponse({}).reply.length > 0, "empty response degrades honestly");
});
