import test from "node:test";
import assert from "node:assert/strict";
import {
  applyScanItems,
  parsePantryDictation,
  readPantryNote,
  markPantryOut,
  outMatches,
  appendPantryNote,
  PANTRY_NOTES_KEPT,
  frameTimes,
  mergeFridgeWalk,
} from "../app/lib/scan.js";

const PANTRY = {
  staples: [
    { id: "rice", name: "Rice", section: "dry-goods", onHand: false, runningLow: true },
    { id: "cayenne", name: "Cayenne", section: "spices", onHand: true, runningLow: false },
  ],
  perishables: [{ food: "half cabbage", qty: "0.5 head", added: "2026-07-04", useSoon: true }],
};

test("staple item refreshes an existing staple instead of duplicating", () => {
  const next = applyScanItems(PANTRY, [{ name: "rice", kind: "staple", qty: "" }], "2026-07-06");
  const rice = next.staples.filter((s) => s.id === "rice");
  assert.equal(rice.length, 1);
  assert.equal(rice[0].onHand, true, "seen in the photo = on hand");
  assert.equal(rice[0].runningLow, false, "seen = not running low");
});

test("new staple is added with a derived id and section", () => {
  const next = applyScanItems(
    PANTRY,
    [{ name: "Olive Oil", kind: "staple", qty: "" }],
    "2026-07-06",
  );
  const oil = next.staples.find((s) => s.id === "olive-oil");
  assert.ok(oil);
  assert.equal(oil.name, "Olive Oil");
  assert.equal(oil.section, "condiments"); // cooking oils shelve with the vinegars
  assert.equal(oil.onHand, true);
  assert.equal(oil.runningLow, false);
});

test("new perishable lands with today's date; existing one is not duplicated", () => {
  const next = applyScanItems(
    PANTRY,
    [
      { name: "Half Cabbage", kind: "perishable", qty: "0.5 head" },
      { name: "milk", kind: "perishable", qty: "1L" },
    ],
    "2026-07-06",
  );
  assert.equal(next.perishables.filter((p) => p.food.toLowerCase() === "half cabbage").length, 1);
  const milk = next.perishables.find((p) => p.food === "milk");
  assert.ok(typeof milk.id === "string" && milk.id.length > 0); // P1: stable id at creation
  const rest = { ...milk };
  delete rest.id;
  // one-pantry: tracked rows are healed at write time — an unplaced scan row
  // lands in "unsorted", the location no sweep ever touches
  assert.deepEqual(rest, {
    food: "milk",
    qty: "1L",
    added: "2026-07-06",
    useSoon: false,
    location: "unsorted",
    group: "dairy",
  });
});

test("does not mutate the input pantry and tolerates missing arrays", () => {
  const before = JSON.stringify(PANTRY);
  applyScanItems(PANTRY, [{ name: "x", kind: "staple", qty: "" }], "2026-07-06");
  assert.equal(JSON.stringify(PANTRY), before);
  const next = applyScanItems({}, [{ name: "milk", kind: "perishable", qty: "" }], "2026-07-06");
  assert.equal(next.perishables.length, 1);
  assert.deepEqual(next.staples, []);
});

test("a scan with a location lands the new perishables on that shelf", () => {
  const next = applyScanItems(
    PANTRY,
    [{ name: "greek yogurt", kind: "perishable", qty: "500 g" }],
    "2026-07-06",
    "fridge",
  );
  const row = next.perishables.find((p) => p.food === "greek yogurt");
  assert.equal(row.location, "fridge");
});

test("a scan without a location lands in unsorted, which no sweep ever touches", () => {
  const next = applyScanItems(
    PANTRY,
    [{ name: "greek yogurt", kind: "perishable", qty: "500 g" }],
    "2026-07-06",
  );
  const row = next.perishables.find((p) => p.food === "greek yogurt");
  // the safety property behind the old "legacy shape" contract survives:
  // an unplaced row is quarantined where a location sweep cannot delete it
  assert.equal(row.location, "unsorted");
});

test("SHELF-AWARE refresh (Tribunal B3): a fridge scan never rewrites the freezer's pack", () => {
  const pantry = {
    staples: [],
    perishables: [
      { id: "z1", food: "chicken thigh", qty: "1 kg", added: "2026-07-10", location: "freezer" },
    ],
  };
  const next = applyScanItems(
    pantry,
    [{ name: "chicken thigh", kind: "perishable", qty: "500 g" }],
    "2026-08-01",
    "fridge",
  );
  const freezer = next.perishables.find((p) => p.id === "z1");
  assert.equal(freezer.qty, "1 kg", "freezer row untouched");
  assert.equal(freezer.added, "2026-07-10", "no expiry laundering");
  const fridge = next.perishables.find((p) => p.location === "fridge");
  assert.equal(fridge.qty, "500 g", "the fridge gets its own new row");
  // and a SECOND fridge photo refreshes the fridge row instead of duplicating
  const again = applyScanItems(
    next,
    [{ name: "chicken thigh", kind: "perishable", qty: "700 g" }],
    "2026-08-01",
    "fridge",
  );
  assert.equal(again.perishables.filter((p) => p.food === "chicken thigh").length, 2);
  assert.equal(again.perishables.find((p) => p.location === "fridge").qty, "700 g");
});

// ---- SAY WHAT YOU HAVE (David, 2026-09-06) ------------------------------------

test("parsePantryDictation reads a spoken run-through into pantry rows", () => {
  const rows = parsePantryDictation(
    "um so I have soy sauce, sesame oil and I've got 2 lbs chicken thighs, a dozen eggs, frozen berries. running low on rice, we're out of milk, also some walnuts",
  );
  const by = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.deepEqual(Object.keys(by).sort(), [
    "chicken thighs",
    "eggs",
    "frozen berries",
    "rice",
    "sesame oil",
    "soy sauce",
    "walnuts",
  ]);
  assert.equal(by["soy sauce"].kind, "staple");
  assert.equal(by["soy sauce"].state, undefined, "plenty by default");
  assert.equal(by["chicken thighs"].kind, "fresh");
  assert.equal(by["chicken thighs"].location, "fridge");
  assert.equal(by["chicken thighs"].qty, "2 lbs");
  assert.equal(by["eggs"].qty, "1 dozen");
  assert.equal(by["frozen berries"].location, "freezer");
  assert.equal(by["rice"].state, "low", "'running low on' marks it low");
  assert.ok(!("milk" in by), "'out of' adds nothing");
  assert.equal(by["walnuts"].kind, "staple");
  assert.equal(by["chicken thighs"].kind, "fresh");
  assert.equal(by["eggs"].location, "fridge");
});

test("parsePantryDictation: one item per line works too, duplicates collapse, bare articles are not quantities", () => {
  const rows = parsePantryDictation(
    "Olive oil\nolive oil\na spinach\n3 cans black beans\nhalf a bag of quinoa",
  );
  assert.deepEqual(
    rows.map((r) => [r.name, r.qty, r.kind]),
    [
      ["olive oil", "", "staple"],
      ["spinach", "", "fresh"],
      // a count is inventory since 2026-09-06: counted rows are dated rows
      ["black beans", "3 cans", "fresh"],
      ["quinoa", "0.5 bag", "fresh"],
    ],
  );
});

test("a dictated 'low on' staple lands LOW through applyScanItems, never plenty", () => {
  const next = applyScanItems(
    PANTRY,
    [{ name: "rice", kind: "staple", qty: "", state: "low" }],
    "2026-07-06",
  );
  const rice = next.staples.find((s) => s.id === "rice");
  assert.equal(rice.runningLow, true);
  assert.equal(rice.onHand, false, "the legacy mirror reads LOW as not-on-hand, by design");
});

test("parsePantryDictation splits a run-on at the next quantity (David's 2026-09-06 dictation)", () => {
  const rows = parsePantryDictation(
    "cottage cheese two bricks of sharp cheddar cheese, milk a huge thing of soy sauce about a container of basil pesto, what I think is kale, we, there’s lots of rice, boy Scout popcorn a huge thing of Chia seeds a huge thing of whey protein powder",
  );
  assert.deepEqual(
    rows.map((r) => [r.name, r.qty]),
    [
      ["cottage cheese", ""],
      ["sharp cheddar cheese", "2 bricks"],
      ["milk", ""],
      ["soy sauce", ""],
      ["basil pesto", "1 container"],
      ["kale", ""],
      ["rice", ""],
      ["boy Scout popcorn", ""],
      ["chia seeds", ""],
      ["whey protein powder", ""],
    ],
  );
});

test("a dictated COUNT is inventory: it lands as a countable dated row, cans on the pantry shelf", () => {
  const rows = parsePantryDictation(
    "5 lemons, 6 cans of coconut milk, 3 tubs of greek yogurt, a dozen eggs, soy sauce",
  );
  const by = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.equal(by["lemons"].kind, "fresh", "a count is never a bare PLENTY");
  assert.equal(by["lemons"].location, "pantry");
  assert.equal(
    by["coconut milk"].location,
    "pantry",
    "cans are not fridge food whatever is inside",
  );
  assert.equal(by["greek yogurt"].location, "fridge");
  assert.equal(by["soy sauce"].kind, "staple");
  const next = applyScanItems({ items: [] }, rows, "2026-09-06", "pantry");
  const row = (/** @type {string} */ f) => next.items.find((it) => it.food === f);
  assert.equal(row("lemons").qty, "5 each");
  assert.equal(row("lemons").said, "5");
  assert.equal(row("greek yogurt").qty, "2721 g");
  assert.equal(row("greek yogurt").said, "3 tubs");
  assert.equal(row("eggs").qty, "12 each");
  assert.equal(row("coconut milk").qty, "6 can");
});

test("a dictated COUNT retires the bare PLENTY assertion for the same food (David, 2026-09-07)", () => {
  const before = { items: [{ id: "eggs", food: "eggs", section: "dairy", state: "plenty" }] };
  const next = applyScanItems(before, parsePantryDictation("a dozen eggs"), "2026-09-07", "fridge");
  const eggs = next.items.filter((i) => i.food === "eggs");
  assert.equal(eggs.length, 1);
  assert.equal(eggs[0].qty, "12 each");
});

// WALK THE FRIDGE (David, 2026-10-18: "record a video, roll it past all the
// shelves inside the fridge, and narrate everything")
test("frame times sit in the middle of even slices, never at the ends, and a clip with no length gives none", () => {
  assert.deepEqual(frameTimes(16), [1, 3, 5, 7, 9, 11, 13, 15]);
  assert.deepEqual(frameTimes(Infinity), [], "a clip with no readable length is said, not guessed");
  assert.deepEqual(frameTimes(0), []);
  assert.equal(frameTimes(60, 40).length, 12, "capped: a walk is a handful of scans, not forty");
});

test("a walk merges frames by food keeping the larger amount, and his words win", () => {
  const frames = [
    [
      { name: "eggs", kind: "fresh", qty: "6" },
      { name: "milk", kind: "fresh", qty: "" },
    ],
    [
      { name: "Eggs", kind: "fresh", qty: "12" },
      { name: "soy sauce", kind: "staple", qty: "" },
    ],
  ];
  const out = mergeFridgeWalk(frames, "half a gallon of milk, running low on rice");
  const by = Object.fromEntries(out.map((r) => [r.name.toLowerCase(), r]));
  assert.equal(by.eggs?.qty, "12", "the same carton in two frames is one row, the larger count");
  assert.equal(out.filter((r) => r.name.toLowerCase() === "eggs").length, 1);
  assert.match(String(by.milk?.qty), /gallon/, "what he said beats a frame that saw no amount");
  assert.equal(by.milk?.location, "fridge");
  assert.equal(by["soy sauce"]?.kind, "staple");
  assert.equal(by.rice?.state, "low", "a food only said is added, with how he said it");
});

test("his amount wins over a frame's when both name one", () => {
  const out = mergeFridgeWalk(
    [[{ name: "chicken thighs", kind: "fresh", qty: "4 lbs" }]],
    "2 lbs chicken thighs",
  );
  assert.equal(out.length, 1);
  assert.match(out[0]?.qty ?? "", /^2/);
});

test("a frame that fails is skipped and counted; only all failing fails the walk", async () => {
  const { scanFrames } = await import("../app/lib/worker.js");
  const frames = [new Blob(["a"]), new Blob(["b"]), new Blob(["c"])];
  let n = 0;
  const flaky = async () => {
    n++;
    if (n === 2) throw new Error("blurry");
    return [{ name: "eggs", kind: "fresh", qty: "6" }];
  };
  const r = await scanFrames(frames, undefined, flaky);
  assert.equal(r.failed, 1);
  assert.equal(r.items.length, 3);
  await assert.rejects(
    scanFrames(frames, undefined, async () => {
      throw new Error("no connection");
    }),
    /no connection/,
  );
});

// ---- I-06: VOICE NOTE LIMITS (post-mortem 10/18, failure 2) --------------------
// David's 7:02 pm phrases, as the phone's dictation wrote them.
const NOTE_1018 =
  "okay so there is pasta there's rice there's flat seed, um we need more vanilla extract. one other stuff, it's about it. that's it in the fridge in the freezer. we're out of milk and I think we have figs and dates and protein powder, running low on olive oil. there's zorblax";

test("a voice note never saves filler or run-on fragments as pantry items", () => {
  const { items } = readPantryNote(NOTE_1018, ["Rolled oats"]);
  assert.deepEqual(items.map((i) => i.name).sort(), [
    "dates",
    "figs",
    "olive oil",
    "pasta",
    "protein powder",
    "rice",
    "vanilla extract",
  ]);
  for (const junk of ["there is", "there's", "one", "other stuff", "it's about it"]) {
    assert.ok(!items.some((i) => i.name === junk), `"${junk}" is not a food`);
  }
  assert.ok(!items.some((i) => /fridge|freezer|there/.test(i.name)));
  assert.deepEqual(readPantryNote("there is. one. other stuff. it's about it.").items, []);
});

test("'we need more X' marks X LOW, never PLENTY", () => {
  const { items } = readPantryNote(NOTE_1018);
  const vanilla = items.find((i) => i.name === "vanilla extract");
  assert.equal(vanilla?.state, "low");
  for (const said of [
    "we need more rice",
    "need rice",
    "running low on rice",
    "rice is almost gone",
  ]) {
    assert.equal(readPantryNote(said).items[0]?.state, "low", said);
  }
});

test("'out of X' is only a suggestion: nothing is added, nothing is changed by the note", () => {
  const note = readPantryNote("we're out of milk, no more eggs, used up the flour");
  assert.deepEqual(note.items, []);
  assert.deepEqual(note.outs.map((o) => o.name).sort(), ["eggs", "flour", "milk"]);
  const before = { items: [{ id: "milk", food: "milk", state: "plenty" }] };
  const next = applyScanItems(before, note.items, "2026-10-24");
  assert.equal(next.items.length, 1, "no row added or removed");
  assert.equal(next.items[0].state, "plenty", "the milk row is exactly as it was");
});

test("tapping MARK OUT is the only thing that takes a food off: a counted row leaves, a shelf row loses its state", () => {
  const pantry = {
    items: [
      { id: "milk", food: "milk", qty: "1 each", date: "2026-10-20" },
      { id: "rice", food: "rice", state: "plenty" },
      { id: "oil", food: "olive oil", state: "plenty" },
    ],
  };
  assert.equal(outMatches(pantry, "milk"), true);
  assert.equal(
    outMatches(pantry, "saffron"),
    false,
    "nothing to change for a food not on the shelves",
  );
  const next = markPantryOut(pantry, "rice");
  assert.equal(next.items.find((i) => i.food === "rice")?.state, undefined);
  assert.ok(
    next.items.some((i) => i.food === "olive oil" && i.state === "plenty"),
    "others untouched",
  );
  assert.equal(pantry.items.find((i) => i.food === "rice")?.state, "plenty", "input untouched");
});

test("a word the reader cannot place is 'not sure', never saved as PLENTY, with a close guess when there is one", () => {
  const { items, unsure } = readPantryNote(NOTE_1018);
  assert.ok(!items.some((i) => /flat|seed|zorblax/.test(i.name)));
  const flat = unsure.find((u) => u.name === "flat seed");
  assert.equal(flat?.guess, "flaxseed");
  assert.ok(unsure.some((u) => u.name === "zorblax" && !u.guess));
});

test("a food the pantry already holds is saved under its own name, so oats updates 'Rolled oats'", () => {
  const { items } = readPantryNote("we have oats and quinoa", ["Rolled oats"]);
  assert.ok(items.some((i) => i.name === "Rolled oats"));
  assert.equal(items.length, 2);
});

test("his raw words are kept exactly as said, beside what was saved", () => {
  const note = readPantryNote(NOTE_1018);
  assert.equal(note.said, NOTE_1018);
  const file = appendPantryNote(
    null,
    {
      said: note.said,
      saved: note.items.map((i) => ({ food: i.name })),
      unsure: note.unsure.map((u) => u.name),
      outs: note.outs.map((o) => ({ name: o.name, marked: false })),
      by: "david",
    },
    new Date("2026-10-24T00:02:00Z"),
  );
  assert.equal(file.notes.length, 1);
  assert.equal(file.notes[0].said, NOTE_1018);
  assert.deepEqual(file.notes[0].unsure, ["flat seed", "zorblax"]);
  assert.equal(file.notes[0].outs[0].name, "milk");
  const again = appendPantryNote(
    file,
    { said: "x", saved: [], unsure: [], outs: [], by: "david" },
    new Date("2026-10-24T00:03:00Z"),
  );
  assert.equal(again.notes.length, 2, "notes accumulate, newest last");
  let f = again;
  for (let i = 0; i < PANTRY_NOTES_KEPT + 5; i++) {
    f = appendPantryNote(
      f,
      { said: `n${i}`, saved: [], unsure: [], outs: [] },
      new Date(2026, 9, 25, 0, i),
    );
  }
  assert.equal(f.notes.length, PANTRY_NOTES_KEPT, "only the newest are kept");
});

test("'out of X and Y' keeps every listed food out, and a new cue ends it (Tribunal Engineer, 1.95)", () => {
  for (const said of ["we are out of eggs and butter", "out of eggs, butter", "we're out of eggs and butter"]) {
    const r = readPantryNote(said, []);
    assert.deepEqual(r.outs.map((o) => o.name).sort(), ["butter", "eggs"], said);
    assert.equal(r.items.length, 0, `${said}: nothing saved as in stock`);
  }
  const mixed = readPantryNote("out of eggs but we have butter", []);
  assert.deepEqual(mixed.outs.map((o) => o.name), ["eggs"]);
  assert.deepEqual(mixed.items.map((i) => i.name), ["butter"]);
  const low = readPantryNote("out of eggs and need more milk", []);
  assert.deepEqual(low.outs.map((o) => o.name), ["eggs"]);
  assert.equal(low.items.find((i) => i.name === "milk")?.state, "low");
});

test("'we used all the rice' is an out suggestion, never rice saved PLENTY (Tribunal Final Gate, 1.95)", () => {
  for (const said of [
    "we used all the rice",
    "we used up all the rice",
    "used all of the rice",
    "we finished the rice",
    "we finished all the rice",
    "we ate all the rice",
  ]) {
    const r = readPantryNote(said, []);
    assert.deepEqual(r.outs.map((o) => o.name), ["rice"], said);
    assert.equal(r.items.length, 0, `${said}: nothing saved`);
  }
});

test("'not sure about pnut butter' is not sure, never a saved staple (Tribunal Final Gate, 1.95)", () => {
  const r = readPantryNote("not sure about pnut butter", []);
  assert.equal(r.items.length, 0);
  assert.equal(r.unsure.length, 1);
  assert.equal(r.unsure[0]?.name, "pnut butter");
  assert.equal(r.unsure[0]?.guess, "peanut butter");
  const bare = readPantryNote("there's pnut butter", []);
  assert.equal(bare.items.length, 0, "a glued unknown head word is never saved");
  assert.equal(bare.unsure[0]?.guess, "peanut butter");
});

test("'flat seed rice' saves rice alone and doubts 'flat seed' with its close guess (Tribunal Final Gate, 1.95)", () => {
  const r = readPantryNote("there's flat seed rice", []);
  assert.deepEqual(r.items.map((i) => i.name), ["rice"]);
  const flat = r.unsure.find((u) => u.name === "flat seed");
  assert.ok(flat, "flat seed is not sure");
  assert.match(String(flat?.guess), /flax/);
});

test("a hedged food is only ever not sure, never saved (Tribunal Final Gate, 1.95)", () => {
  for (const said of [
    "maybe rice",
    "I don't know if we have rice",
    "not sure if we have rice",
    "I'm not sure about rice",
  ]) {
    const r = readPantryNote(said, []);
    assert.equal(r.items.length, 0, `${said}: nothing saved`);
    assert.deepEqual(r.unsure.map((u) => u.name), ["rice"], said);
  }
  const joined = readPantryNote("maybe rice and beans, there's pasta", []);
  assert.deepEqual(joined.items.map((i) => i.name), ["pasta"]);
  assert.deepEqual(joined.unsure.map((u) => u.name).sort(), ["beans", "rice"]);
});

test("a count of zero is an out suggestion and never zeroes an existing row (Tribunal Final Gate, 1.95)", () => {
  for (const said of ["I have 0 eggs", "zero milk", "we have no eggs left", "none of the eggs"]) {
    const r = readPantryNote(said, []);
    assert.equal(r.items.length, 0, `${said}: no row, so no qty 0`);
    assert.equal(r.outs.length, 1, said);
  }
  assert.deepEqual(readPantryNote("I have 0 eggs", []).outs, [{ name: "eggs" }]);
  const withEggs = { staples: [], perishables: [{ food: "eggs", qty: "6", added: "2026-10-20" }] };
  const r = readPantryNote("I have 0 eggs", []);
  const after = applyScanItems(withEggs, r.items, "2026-10-24");
  assert.match(String(after.perishables?.[0]?.qty), /^6\b/, "his eggs row is untouched");
  assert.equal(readPantryNote("I have 10 eggs", []).items[0]?.qty, "10", "ten is still a count");
});

test("after 'out of', a stated count or 'still have' is a have, and shopping verbs are not part of the food (Tribunal Final Gate, 1.95 loop 2)", () => {
  const k = ["apples", "eggs", "butter", "beans", "greek yogurt", "spinach"];
  const a = readPantryNote("out of eggs and 3 apples", k);
  assert.deepEqual(a.outs.map((o) => o.name), ["eggs"]);
  assert.equal(a.items.find((i) => i.name === "apples")?.qty, "3");
  const b = readPantryNote("out of eggs, 2 cans of beans", k);
  assert.deepEqual(b.outs.map((o) => o.name), ["eggs"]);
  assert.ok(b.items.some((i) => i.name === "beans"));
  const c = readPantryNote("out of eggs and still have butter", k);
  assert.deepEqual(c.outs.map((o) => o.name), ["eggs"]);
  assert.ok(c.items.some((i) => i.name === "butter"));
  for (const said of ["I picked up greek yogurt", "just bought greek yogurt", "we brought home greek yogurt"]) {
    assert.deepEqual(readPantryNote(said, k).items.map((i) => i.name), ["greek yogurt"], said);
  }
});

test("a carried 'out of' stops at anything said as a have or a count, and 'got rid of' is an out (Tribunal Final Gate, 1.95 loop 3)", () => {
  const k = ["eggs", "milk", "rice", "beans", "onion", "apples", "butter", "chicken"];
  const cases = [
    ["we are out of milk and have eggs", ["milk"], ["eggs"]],
    ["out of rice, have beans", ["rice"], ["beans"]],
    ["out of eggs, got milk", ["eggs"], ["milk"]],
    ["out of eggs and we still have butter", ["eggs"], ["butter"]],
    ["out of eggs and just bought milk", ["eggs"], ["milk"]],
    ["out of eggs and a bag of rice", ["eggs"], ["rice"]],
    ["out of eggs and an onion", ["eggs"], ["onion"]],
    ["out of eggs and some apples", ["eggs"], ["apples"]],
    ["got rid of the milk", ["milk"], []],
  ];
  for (const [said, outs, items] of cases) {
    const r = readPantryNote(said, k);
    assert.deepEqual(r.outs.map((o) => o.name), outs, `${said}: outs`);
    assert.deepEqual(r.items.map((i) => i.name), items, `${said}: items`);
  }
  for (const said of ["bought a dozen eggs", "bought 2 lbs chicken"]) {
    assert.deepEqual(readPantryNote(said, k).unsure, [], `${said}: the verb is not a Not sure chip`);
  }
});
