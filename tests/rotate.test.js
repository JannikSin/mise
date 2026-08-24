// Variety without moving the macros (David 2026-08-24): the bowl and the
// smoothie are eaten every single day, which is right nutritionally and is
// exactly how a person gets bored.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { rotateComponents, rotates, rotationLine } from "../app/lib/rotate.js";

const BANK = new URL("../../mise-data/recipes/", import.meta.url);
const load = (id) => JSON.parse(readFileSync(new URL(`${id}.json`, BANK), "utf8"));

const ROT = {
  perDay: 2,
  keep: [{ food: "whey", qty: 1, unit: "scoop", calories: 120, protein: 24 }],
  pool: [
    { food: "berries", qty: 1, unit: "cup", calories: 70, protein: 1 },
    { food: "banana", qty: 1, unit: "each", calories: 105, protein: 1 },
    { food: "flax", qty: 1, unit: "tbsp", calories: 37, protein: 1 },
    { food: "chia", qty: 1, unit: "tbsp", calories: 58, protein: 2 },
  ],
  target: { calories: 250, protein: 26 },
  tolerance: { calories: 80, protein: 3 },
};

test("the KEEP items are in every single day", () => {
  for (const d of ["2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03"]) {
    const c = rotateComponents(ROT, d);
    assert.ok(c.picks.some((p) => p.food === "whey"), `${d} lost the whey`);
    assert.equal(c.kept.length, 1);
  }
});

test("exactly perDay items rotate, never more", () => {
  const c = rotateComponents(ROT, "2026-08-31");
  assert.equal(c.rotated.length, 2);
  assert.equal(c.picks.length, 3, "keep + rotated");
});

test("the same day always gives the same bowl", () => {
  // a re-render must not reshuffle somebody's breakfast
  const a = rotateComponents(ROT, "2026-09-01");
  const b = rotateComponents(ROT, "2026-09-01");
  assert.deepEqual(
    a.rotated.map((x) => x.food),
    b.rotated.map((x) => x.food),
  );
});

test("DIFFERENT days genuinely differ, or this feature does nothing", () => {
  const seen = new Set();
  for (const d of ["2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"]) {
    seen.add(rotateComponents(ROT, d).rotated.map((x) => x.food).sort().join("|"));
  }
  assert.ok(seen.size > 1, "every day picked the identical set");
});

test("MACROS ARE A CONSTRAINT: a set outside tolerance is rejected", () => {
  for (const d of ["2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"]) {
    const c = rotateComponents(ROT, d);
    assert.ok(c.withinTolerance, `${d} drifted: ${JSON.stringify(c.macros)}`);
    assert.ok(Math.abs(c.macros.protein - 26) <= 3, `${d} protein ${c.macros.protein}`);
  }
});

test("an impossible tolerance FAILS HONESTLY instead of drifting quietly", () => {
  const c = rotateComponents({ ...ROT, tolerance: { protein: 0, calories: 0 } }, "2026-08-31");
  assert.equal(c.withinTolerance, false, "it must say so");
  assert.ok(c.picks.length > 0, "and still return the closest bowl, not nothing");
});

test("the macros returned are the REAL ones, not the recipe's headline", () => {
  const c = rotateComponents(ROT, "2026-08-31");
  const sum = c.picks.reduce((a, p) => a + (p.protein ?? 0), 0);
  assert.equal(c.macros.protein, sum);
});

test("a recipe with no rotation behaves exactly as before", () => {
  assert.equal(rotates({}), false);
  assert.equal(rotates(null), false);
  assert.equal(rotates({ rotation: { pool: [], perDay: 7 } }), false);
  const c = rotateComponents({ keep: ROT.keep }, "2026-08-31");
  assert.deepEqual(c.rotated, []);
  assert.equal(c.picks.length, 1);
  assert.equal(c.withinTolerance, true);
});

test("perDay larger than the pool takes the whole pool, never undefined entries", () => {
  const c = rotateComponents({ ...ROT, perDay: 99 }, "2026-08-31");
  assert.equal(c.rotated.length, ROT.pool.length);
  assert.ok(c.picks.every((p) => p && p.food));
});

test("THE LIVE BOWL AND SMOOTHIE rotate, and hold their macros all week", () => {
  for (const id of ["berry-walnut-greek-yogurt-bowl", "berry-greens-protein-smoothie"]) {
    const r = load(id);
    assert.ok(rotates(r), `${id} lost its rotation block`);
    assert.equal(r.rotation.perDay, 7, `${id} should rotate 7 of its pool`);
    assert.ok(r.rotation.pool.length >= 10, `${id} pool is only ${r.rotation.pool.length}`);
    // whey is the spine of both and must never rotate out
    assert.ok(
      r.rotation.keep.some((k) => /whey/i.test(k.food)),
      `${id} must keep the protein powder every day`,
    );
    for (const d of ["2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"]) {
      const c = rotateComponents(r.rotation, d);
      assert.ok(c.withinTolerance, `${id} on ${d}: ${JSON.stringify(c.macros)}`);
    }
  }
});

test("rotationLine says what is in it today and what it comes to", () => {
  const line = rotationLine(rotateComponents(ROT, "2026-08-31"));
  assert.match(line, /today:/);
  assert.match(line, /kcal/);
  assert.match(line, /g$/);
});
