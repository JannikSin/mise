import test from "node:test";
import assert from "node:assert/strict";
import { musicUrl, pickForRecipe, pickForTraining } from "../app/lib/music.js";

test("musicUrl builds an Apple Music search link, encoded", () => {
  const u = musicUrl("city pop");
  assert.equal(u, "https://music.apple.com/us/search?term=city%20pop");
  assert.ok(u.startsWith("https://music.apple.com/"));
});

test("a recipe's theme comes from its food, and leads the list", () => {
  const korean = { name: "Chicken bulgogi rice bowl", ingredients: [{ food: "gochujang" }] };
  assert.equal(pickForRecipe(korean, 0).id, "citypop");
  // cycling walks the themed picks first, then the house rotation
  assert.equal(pickForRecipe(korean, 1).id, "kpop");
  assert.equal(pickForRecipe(korean, 2).id, "jazz");
});

test("an unthemed recipe still always gets something", () => {
  const plain = { name: "Breakfast plate", ingredients: [{ food: "eggs" }] };
  const p = pickForRecipe(plain, 0);
  assert.ok(p.label.length > 0);
  assert.ok(p.url.startsWith("https://music.apple.com/"));
});

test("picks never search the FOOD, which returns songs named after it", () => {
  // the whole reason terms are genres and moods: "korean bbq" in Apple Music
  // returns tracks literally called Korean BBQ, which is useless to cook to
  const korean = { name: "Korean BBQ bowl", ingredients: [{ food: "kimchi" }] };
  for (let n = 0; n < 8; n++) {
    const term = pickForRecipe(korean, n).term.toLowerCase();
    assert.ok(!/bbq|kimchi|bulgogi|recipe/.test(term), `term "${term}" searches the food`);
  }
});

test("cycling wraps and is stable, never random", () => {
  const r = { name: "Pasta carbonara", ingredients: [{ food: "parmesan" }] };
  const first = pickForRecipe(r, 0).id;
  const many = Array.from({ length: 40 }, (_, i) => pickForRecipe(r, i).id);
  assert.equal(new Set(many).size, 7); // 2 themed + 5 house, no duplicates in a cycle
  assert.equal(pickForRecipe(r, 7).id, first); // wraps back to the start
  assert.equal(pickForRecipe(r, 0).id, first); // and asking again gives the same answer
  assert.equal(pickForRecipe(r, -1).id, pickForRecipe(r, 6).id); // negative is safe
});

test("training picks are their own list and always resolve", () => {
  for (let n = 0; n < 6; n++) {
    const p = pickForTraining(n);
    assert.ok(p.url.startsWith("https://music.apple.com/us/search?term="));
    assert.ok(p.label.length > 0);
  }
  assert.equal(pickForTraining(0).id, pickForTraining(4).id);
});
