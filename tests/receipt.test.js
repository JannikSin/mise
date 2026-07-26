import test from "node:test";
import assert from "node:assert/strict";
import { expandTillName, decodeReceiptLine, shopScore } from "../app/lib/receipt.js";

test("expandTillName strips pack sizes and brand noise, expands the shorthand", () => {
  assert.equal(expandTillName("BLDMD ALMND 16OZ"), "almonds");
  assert.equal(expandTillName("GRND BF 1LB"), "beef");
  assert.equal(expandTillName("ORG BRCLI CROWNS"), "organic broccoli crowns");
  assert.equal(expandTillName("CHKN BRST 2.4 LB"), "chicken brst");
});

test("THE ALMOND BUG: the list decides, not the brand's reputation", () => {
  // David, 2026-07-26. Blue Diamond is famous for almond milk, so reading the
  // abbreviation cold gives the wrong answer. His list said almonds and never
  // said almond milk, so the answer was on the list the whole time.
  const expected = ["sliced almonds", "baby spinach", "greek yogurt"];
  const got = decodeReceiptLine("BLDMD ALMND 16OZ", expected);
  assert.equal(got.food, "sliced almonds");
  assert.equal(got.source, "list");
  assert.equal(got.confident, true);

  // and if almond MILK really had been on the list, it wins instead
  const milk = decodeReceiptLine("BLDMD ALMND MLK 64OZ", ["almond milk", "baby spinach"]);
  assert.equal(milk.food, "almond milk");
});

test("a line matching nothing on the list still decodes as far as it honestly can", () => {
  const got = decodeReceiptLine("SHRMP 12OZ", ["baby spinach"]);
  assert.equal(got.food, "shrimp");
  assert.equal(got.source, "expanded", "expanded, but not claimed as a list match");
});

test("unreadable till text is returned untouched rather than invented", () => {
  const got = decodeReceiptLine("#4 F", ["baby spinach"]);
  assert.equal(got.source, "raw");
  assert.equal(got.confident, false);
});

test("shopScore says what was bought, missed and extra, not just a number", () => {
  const list = [{ food: "sliced almonds" }, { food: "baby spinach" }, { food: "greek yogurt" }];
  const lines = [{ name: "sliced almonds" }, { name: "baby spinach" }, { name: "ice cream" }];
  const s = shopScore(lines, list);
  assert.equal(s.score, 67, "2 of the 3 things the week needed");
  assert.deepEqual(s.missed, ["greek yogurt"]);
  assert.deepEqual(s.extra, ["ice cream"]);
  assert.equal(s.bought.length, 2);
});

test("shopScore counts a food once however many lines it took", () => {
  const list = [{ food: "baby spinach" }];
  const s = shopScore([{ name: "baby spinach" }, { name: "spinach" }], list);
  assert.equal(s.score, 100);
  assert.equal(s.bought.length, 1);
});

test("an empty list scores zero rather than dividing by nothing", () => {
  assert.equal(shopScore([{ name: "x" }], []).score, 0);
});
