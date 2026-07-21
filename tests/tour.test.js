import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TOUR_STEPS, TOUR_TABS, readTourState, writeTourState } from "../app/lib/tour.js";

const viewsDir = fileURLToPath(new URL("../app/views/", import.meta.url));
const viewSource = readdirSync(viewsDir)
  .filter((f) => f.endsWith(".js"))
  .map((f) => readFileSync(viewsDir + f, "utf8"))
  .join("\n");

test("every tour step has a valid route, a title, and phone-sized text", () => {
  assert.ok(TOUR_STEPS.length >= 12 && TOUR_STEPS.length <= 20, `${TOUR_STEPS.length} steps`);
  for (const s of TOUR_STEPS) {
    assert.ok(s.route in TOUR_TABS, `unknown route ${s.route}`);
    assert.ok(s.title.length > 0 && s.title.length <= 40, `title: ${s.title}`);
    assert.ok(s.text.length > 0 && s.text.length <= 220, `text too long: ${s.title}`);
  }
});

// The zero-dep drift guard (no DOM in node:test): every class token a step's
// selector relies on must appear in view source. A rename that would strand
// a tour step fails here, not silently in a user's hand.
test("every tour selector's class tokens exist in view source", () => {
  for (const s of TOUR_STEPS) {
    const classes = s.selector.match(/\.[a-z-]+/g) ?? [];
    assert.ok(classes.length > 0, `selector has no class tokens: ${s.selector}`);
    for (const c of classes) {
      const name = c.slice(1);
      assert.ok(
        viewSource.includes(name),
        `class "${name}" (step "${s.title}") not found in any view source`,
      );
    }
  }
});

test("tour state round-trips per profile and tolerates junk", () => {
  /** @type {Map<string, string>} */
  const m = new Map();
  const storage = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };

  assert.equal(readTourState("david", storage), null);
  writeTourState("david", { status: "bailed", lastStep: 9 }, storage);
  assert.deepEqual(readTourState("david", storage), { status: "bailed", lastStep: 9 });
  // other profiles are independent
  assert.equal(readTourState("mom", storage), null);
  // junk never throws
  m.set("mise.tour.mom", "{not json");
  assert.equal(readTourState("mom", storage), null);
});
