import test from "node:test";
import assert from "node:assert/strict";
import { mergeFieldWise } from "../app/lib/merge.js";

// 3-way field-wise merge: base = last version both devices knew,
// local = what this device wants to write, remote = what's on GitHub now.

test("keeps a remote-only change", () => {
  const base = { a: 1, b: 2 };
  const local = { a: 1, b: 2 };
  const remote = { a: 1, b: 99 };
  assert.deepEqual(mergeFieldWise(base, local, remote), { a: 1, b: 99 });
});

test("keeps a local-only change", () => {
  const base = { a: 1, b: 2 };
  const local = { a: 5, b: 2 };
  const remote = { a: 1, b: 2 };
  assert.deepEqual(mergeFieldWise(base, local, remote), { a: 5, b: 2 });
});

test("keeps independent changes to different fields from both sides", () => {
  const base = { a: 1, b: 2 };
  const local = { a: 5, b: 2 };
  const remote = { a: 1, b: 99 };
  assert.deepEqual(mergeFieldWise(base, local, remote), { a: 5, b: 99 });
});

test("scalar conflict on the same field: local wins", () => {
  const base = { a: 1 };
  const local = { a: 5 };
  const remote = { a: 9 };
  assert.deepEqual(mergeFieldWise(base, local, remote), { a: 5 });
});

test("identical changes on both sides are not a conflict", () => {
  const base = { a: 1 };
  const local = { a: 7 };
  const remote = { a: 7 };
  assert.deepEqual(mergeFieldWise(base, local, remote), { a: 7 });
});

test("field added locally and different field added remotely: both kept", () => {
  const base = { a: 1 };
  const local = { a: 1, x: "l" };
  const remote = { a: 1, y: "r" };
  assert.deepEqual(mergeFieldWise(base, local, remote), { a: 1, x: "l", y: "r" });
});

test("field deleted locally stays deleted when remote did not touch it", () => {
  const base = { a: 1, gone: true };
  const local = { a: 1 };
  const remote = { a: 1, gone: true };
  assert.deepEqual(mergeFieldWise(base, local, remote), { a: 1 });
});

test("nested objects merge field-wise", () => {
  const base = { supplements: { creatine: false, magnesium: false } };
  const local = { supplements: { creatine: true, magnesium: false } };
  const remote = { supplements: { creatine: false, magnesium: true } };
  assert.deepEqual(mergeFieldWise(base, local, remote), {
    supplements: { creatine: true, magnesium: true },
  });
});

test("arrays of id-keyed objects merge element-wise", () => {
  const base = {
    staples: [
      { id: "cayenne", onHand: true, runningLow: false },
      { id: "rice", onHand: true, runningLow: false },
    ],
  };
  // local marks cayenne running low; remote marks rice not on hand
  const local = {
    staples: [
      { id: "cayenne", onHand: true, runningLow: true },
      { id: "rice", onHand: true, runningLow: false },
    ],
  };
  const remote = {
    staples: [
      { id: "cayenne", onHand: true, runningLow: false },
      { id: "rice", onHand: false, runningLow: false },
    ],
  };
  assert.deepEqual(mergeFieldWise(base, local, remote), {
    staples: [
      { id: "cayenne", onHand: true, runningLow: true },
      { id: "rice", onHand: false, runningLow: false },
    ],
  });
});

test("elements added on each side are unioned", () => {
  const base = { staples: [{ id: "rice", onHand: true }] };
  const local = {
    staples: [
      { id: "rice", onHand: true },
      { id: "oats", onHand: true },
    ],
  };
  const remote = {
    staples: [
      { id: "rice", onHand: true },
      { id: "saffron", onHand: true, premium: true },
    ],
  };
  assert.deepEqual(mergeFieldWise(base, local, remote), {
    staples: [
      { id: "rice", onHand: true },
      { id: "oats", onHand: true },
      { id: "saffron", onHand: true, premium: true },
    ],
  });
});

test("element deleted locally stays deleted", () => {
  const base = {
    staples: [
      { id: "rice", onHand: true },
      { id: "oats", onHand: true },
    ],
  };
  const local = { staples: [{ id: "rice", onHand: true }] };
  const remote = {
    staples: [
      { id: "rice", onHand: true },
      { id: "oats", onHand: true },
    ],
  };
  assert.deepEqual(mergeFieldWise(base, local, remote), {
    staples: [{ id: "rice", onHand: true }],
  });
});

test("plan entries keyed by date+slot merge element-wise", () => {
  const base = { week: "2026-W28", entries: [] };
  const local = {
    week: "2026-W28",
    entries: [{ date: "2026-07-06", slot: "dinner", recipeId: "bulgogi", servings: 2 }],
  };
  const remote = {
    week: "2026-W28",
    entries: [{ date: "2026-07-07", slot: "dinner", freeText: "leftovers", servings: 1 }],
  };
  assert.deepEqual(mergeFieldWise(base, local, remote), {
    week: "2026-W28",
    entries: [
      { date: "2026-07-06", slot: "dinner", recipeId: "bulgogi", servings: 2 },
      { date: "2026-07-07", slot: "dinner", freeText: "leftovers", servings: 1 },
    ],
  });
});

test("delete-vs-edit on a field: the edit wins (local delete, remote edit)", () => {
  const base = { a: 1, note: "old" };
  const local = { a: 1 }; // deleted note
  const remote = { a: 1, note: "updated" }; // edited note
  assert.deepEqual(mergeFieldWise(base, local, remote), { a: 1, note: "updated" });
});

test("delete-vs-edit on a field: the edit wins (remote delete, local edit)", () => {
  const base = { a: 1, note: "old" };
  const local = { a: 1, note: "updated" };
  const remote = { a: 1 };
  assert.deepEqual(mergeFieldWise(base, local, remote), { a: 1, note: "updated" });
});

test("delete-vs-edit on a keyed array element: the edit wins", () => {
  const base = { staples: [{ id: "oats", onHand: true }] };
  const local = { staples: [] }; // deleted oats
  const remote = { staples: [{ id: "oats", onHand: false }] }; // edited oats
  assert.deepEqual(mergeFieldWise(base, local, remote), {
    staples: [{ id: "oats", onHand: false }],
  });
});

test("prototype-polluting keys from remote JSON are dropped, not merged", () => {
  const base = { a: 1 };
  const local = { a: 1 };
  const remote = JSON.parse('{"a": 1, "__proto__": {"polluted": true}, "constructor": {"x": 1}}');
  const merged = mergeFieldWise(base, local, remote);
  assert.equal(Object.getPrototypeOf(merged), Object.prototype);
  assert.equal(/** @type {any} */ (merged).polluted, undefined);
  assert.equal(Object.hasOwn(merged, "constructor"), false);
  assert.deepEqual(merged, { a: 1 });
});

test("arrays without a usable key are treated atomically: local wins on conflict", () => {
  const base = { tags: ["a"] };
  const local = { tags: ["a", "l"] };
  const remote = { tags: ["a", "r"] };
  assert.deepEqual(mergeFieldWise(base, local, remote), { tags: ["a", "l"] });
});
