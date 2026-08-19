import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// A full-screen fixed layer with ordinary pointer events swallows every tap in
// the app. That is fine while something on it can be pressed, and catastrophic
// when nothing can: the page still paints and still scrolls, because the
// compositor owns scrolling, so it reads as "the app is dead" with no error
// anywhere (David, 2026-07-26: "none of the buttons work. i can scroll on the
// plan page but that is it").
//
// The tour did exactly that: its card, and with it the END button, rendered
// only after a step's target element had been measured, so a step whose
// selector resolved to nothing left an invisible blocker with no way out.
//
// This test is the guard. Every blocking full-screen layer must be listed here
// with the control that always gets you off it. Adding a new one fails until
// its escape is named, which is the point: the failure mode is invisible in
// review and obvious here.

// comments stripped first: a rule preceded by one would otherwise carry the
// comment into its "selector" and never match the registry
const css = readFileSync(new URL("../app/styles.css", import.meta.url), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** Selector → the escape that must always render on that layer. */
// .cook left the registry 2026-08-19: Cook Mode is gone (David: "get rid of
// that entirely"), the serve step lives on the recipe page as a normal tile
const KNOWN_BLOCKERS = {
  ".modal-overlay": {
    escape: "CANCEL button, plus an overlay tap and Escape",
    file: "../app/views/confirm-modal.js",
    marker: "onResolve(false)",
  },
  ".peek-overlay": {
    escape: "the ✕ close button, plus a backdrop tap and Escape",
    file: "../app/views/recipe-peek.js",
    marker: "peek-close",
  },
  ".tour": {
    escape: "CLOSE TOUR button, outside the measured-card guard",
    file: "../app/views/tour.js",
    marker: "tour-escape",
  },
};

/** Rules that cover the viewport and still take pointer events. */
function blockingLayers() {
  const out = [];
  for (const block of css.split("}")) {
    const [head, body = ""] = block.split("{");
    if (!body) continue;
    const fixed = /position:\s*fixed/.test(body);
    const full = /inset:\s*0/.test(body);
    const inert = /pointer-events:\s*none/.test(body);
    if (fixed && full && !inert) out.push(head.trim().split(",")[0].trim());
  }
  return out;
}

test("every full-screen blocking layer has an escape that always renders", () => {
  for (const selector of blockingLayers()) {
    const known = KNOWN_BLOCKERS[selector];
    assert.ok(
      known,
      `${selector} covers the viewport and takes taps, but no escape is registered.\n` +
        `Add it to KNOWN_BLOCKERS with the control that always gets a user off it,\n` +
        `or give the layer pointer-events: none. An overlay whose only exit is\n` +
        `behind a conditional can strand the whole app with nothing to press.`,
    );
    const src = readFileSync(new URL(known.file, import.meta.url), "utf8");
    assert.ok(
      src.includes(known.marker),
      `${selector} claims its escape is ${known.escape}, but ${known.file} no longer contains ${known.marker}`,
    );
  }
});

test("the layers we know about are all still accounted for", () => {
  // catches the reverse drift: a layer removed from CSS but still claimed here,
  // which would quietly make this file stop testing anything real
  const found = blockingLayers();
  for (const selector of Object.keys(KNOWN_BLOCKERS)) {
    assert.ok(found.includes(selector), `${selector} is registered but no longer a blocking layer`);
  }
});

test("the tour's escape is not gated on a step resolving", () => {
  // the precise regression: `rect &&` gates the card, and the card used to be
  // the only thing carrying END
  const src = readFileSync(new URL("../app/views/tour.js", import.meta.url), "utf8");
  const escape = src.indexOf("tour-escape");
  const cardGuard = src.indexOf("rect &&");
  assert.ok(escape > 0, "the tour must carry an unconditional escape");
  assert.ok(
    cardGuard === -1 || escape < src.lastIndexOf("tour-card"),
    "the escape must not sit inside the measured-card branch",
  );
});
