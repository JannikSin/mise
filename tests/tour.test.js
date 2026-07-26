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
// selector relies on must appear where markup actually declares classes — a
// class="..." attribute, or a quoted string literal (conditional classes like
// `past ? "past" : ""`). A bare substring scan would false-pass on English
// words ("ask", "day") living in unrelated prose or identifiers.
test("every tour selector's class tokens are declared in view markup", () => {
  const inClassAttr = (/** @type {string} */ n) =>
    new RegExp(`class="[^"]*\\b${n}\\b`).test(viewSource);
  const asQuotedLiteral = (/** @type {string} */ n) => viewSource.includes(`"${n}"`);
  for (const s of TOUR_STEPS) {
    const classes = s.selector.match(/\.[a-z-]+/g) ?? [];
    assert.ok(classes.length > 0, `selector has no class tokens: ${s.selector}`);
    for (const c of classes) {
      const name = c.slice(1);
      assert.ok(
        inClassAttr(name) || asQuotedLiteral(name),
        `class "${name}" (step "${s.title}") not declared in any view's markup`,
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

test("the tour overlay always renders an escape, even with no card", () => {
  // David, 2026-07-26: the app painted and scrolled but no control worked.
  // .tour is fixed inset:0 and swallows every tap, and the card only renders
  // once a step's target has been MEASURED. A step whose element never
  // resolves therefore left an invisible, inescapable blocker over the whole
  // app. The close button must not depend on rect, the card, or the step.
  const src = readFileSync(new URL("../app/views/tour.js", import.meta.url), "utf8");
  const escape = src.indexOf("tour-escape");
  assert.ok(escape > 0, "the overlay must carry its own way out");

  // it has to sit OUTSIDE the `rect &&` guard that gates the card
  const cardGuard = src.indexOf('rect &&\n        html`<div\n          class="tour-card');
  assert.ok(
    cardGuard === -1 || escape < cardGuard,
    "the escape must render before/independently of the measured-card guard",
  );

  // and it must be styled above the overlay it escapes
  const css = readFileSync(new URL("../app/styles.css", import.meta.url), "utf8");
  const tourZ = Number(css.match(/\.tour \{[^}]*z-index:\s*(\d+)/)?.[1] ?? 0);
  const escZ = Number(css.match(/\.tour-escape \{[^}]*z-index:\s*(\d+)/)?.[1] ?? 0);
  assert.ok(escZ > tourZ, `escape z-index ${escZ} must sit above .tour ${tourZ}`);
});
