import test from "node:test";
import assert from "node:assert/strict";
import { SYMPTOMS, protocolFor } from "../app/lib/remedies.js";

test("expanded symptom set is present", () => {
  const ids = new Set(SYMPTOMS.map((s) => s.id));
  for (const id of ["headache", "muscle-soreness", "poor-sleep", "coming-down-sick"]) {
    assert.ok(ids.has(id), id);
  }
});

test("every symptom has a complete rule", () => {
  assert.ok(SYMPTOMS.length >= 10);
  for (const s of SYMPTOMS) {
    const p = protocolFor([s.id]);
    assert.ok(p, s.id);
    assert.ok(p.notes.length > 0, `${s.id} notes`);
    assert.ok(p.avoid.length > 0, `${s.id} avoid`);
  }
});

test("empty selection returns null", () => {
  assert.equal(protocolFor([]), null);
});

test("combined symptoms merge and dedupe", () => {
  const single = protocolFor(["sore-throat"]);
  const combo = protocolFor(["sore-throat", "congestion"]);
  assert.ok(combo.teas.length >= single.teas.length);
  const uniq = new Set(combo.teas);
  assert.equal(uniq.size, combo.teas.length, "no duplicate teas");
});

test("protocols link to recipes that exist in the seed set", () => {
  const known = new Set([
    "chicken-rice-congee",
    "ginger-honey-lemon-tea",
    "training-smoothie",
    "cottage-cheese-pre-bed",
    "beef-bulgogi-rice-bowl",
    "electrolyte-lemon-salt-drink", // Task 11 sick-day lane
  ]);
  for (const s of SYMPTOMS) {
    const p = protocolFor([s.id]);
    for (const id of p.recipeIds) assert.ok(known.has(id), `${s.id} → ${id}`);
  }
});

test("unknown symptom ids are ignored", () => {
  assert.equal(protocolFor(["martian-flu"]), null);
  const p = protocolFor(["martian-flu", "nausea"]);
  assert.ok(p && p.notes.length > 0);
});
