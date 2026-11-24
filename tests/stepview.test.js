import { test } from "node:test";
import assert from "node:assert/strict";
import { stepView, inlineAmount, hasInlineAmounts } from "../app/lib/stepview.js";

const rows = [
  { food: "soy sauce", qty: 10, unit: "g", measure: "2 tsp" },
  { food: "chicken stock", qty: 480, unit: "g" },
];

test("an inline slot prints the row's amount, with its spoon measure as written", () => {
  const v = stepView({ step: 1, text: "Add {{1}} soy sauce to {{2}} stock." }, rows, {
    asWritten: true,
    hbp: true,
  });
  assert.ok(v.text.startsWith("Add 2 tsp (10 g) soy"), v.text);
  assert.ok(!v.text.includes("{{"), v.text);
  assert.deepEqual(v.notes, []);
});

test("scaled, the slot follows the scaled row and drops the stale spoon measure", () => {
  const scaled = rows.map((r) => ({ ...r, qty: r.qty * 3 }));
  const v = stepView({ step: 1, text: "Add {{1}} soy sauce." }, scaled, {
    asWritten: false,
    hbp: true,
  });
  assert.ok(!v.text.includes("2 tsp"), v.text);
  assert.ok(v.text.includes("30"), v.text);
});

test("a slot with no row prints nothing, never the raw token", () => {
  const v = stepView({ step: 1, text: "Add {{9}} salt." }, rows, { asWritten: true, hbp: false });
  assert.equal(v.text, "Add  salt.");
});

test("notes come from the step's own field first", () => {
  const v = stepView({ step: 1, text: "Stir.", notes: ["Why it matters."] }, rows, {
    asWritten: true,
    hbp: true,
  });
  assert.deepEqual(v.notes, ["Why it matters."]);
});

test("an older HBP save splits its folded notes back out and keeps temperatures in the step", () => {
  const v = stepView(
    {
      step: 1,
      text: "Poach: slide the eggs in. · 74 °C (reheat temp) · Strain the loose white first.",
    },
    rows,
    { asWritten: true, hbp: true },
  );
  assert.equal(v.text, "Poach: slide the eggs in. · 74 °C (reheat temp)");
  assert.deepEqual(v.notes, ["Strain the loose white first."]);
});

test("a bank recipe's text is left alone", () => {
  const v = stepView({ step: 1, text: "Mix a · b" }, rows, { asWritten: true, hbp: false });
  assert.equal(v.text, "Mix a · b");
  assert.equal(inlineAmount(undefined, true), "");
  assert.equal(hasInlineAmounts({ instructions: [{ text: "x {{1}}" }] }), true);
  assert.equal(hasInlineAmounts({ instructions: [{ text: "x" }] }), false);
});
