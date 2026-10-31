// gate20 Realist R3: the two switch-morning shells come from one tool, and a
// shell can never point at a placeholder project.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeShell } from "../tools/make-shell.mjs";
import { backendChoice } from "../app/lib/backend/config.js";

const HTML = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const REAL = { url: "https://abcdefghijklmnop.supabase.co" };

/** @param {string} html */
const metaOf = (html, /** @type {string} */ name) =>
  new RegExp(`<meta name="${name}" content="([^"]*)" />`).exec(html)?.[1] ?? null;

test("the committed index.html is the plain 1.x shell", () => {
  assert.equal(metaOf(HTML, "mise-backend"), null);
  assert.equal(metaOf(HTML, "mise-move"), null);
  assert.equal(makeShell(HTML, "plain"), HTML);
});

test("shell A: GitHub with the freeze control; shell B: Supabase with the project in the CSP", () => {
  const a = makeShell(HTML, "move");
  assert.equal(metaOf(a, "mise-move"), "on");
  assert.equal(metaOf(a, "mise-backend"), null);
  const b = makeShell(a, "supabase", REAL);
  assert.equal(metaOf(b, "mise-backend"), "supabase");
  assert.equal(metaOf(b, "mise-move"), null, "B drops the freeze control");
  assert.match(b, /connect-src 'self' https:\/\/abcdefghijklmnop\.supabase\.co /);
  assert.equal((b.match(/supabase\.co/g) ?? []).length, 1);
  assert.equal(makeShell(b, "supabase", REAL), b, "idempotent");
  assert.equal(makeShell(b, "plain"), HTML, "and back");
});

test("the app reads shell B's meta as Supabase", () => {
  const b = makeShell(HTML, "supabase", REAL);
  const g = /** @type {any} */ (globalThis);
  const saved = g.document;
  g.document = { querySelector: (/** @type {string} */ sel) => (sel.includes("mise-backend") && metaOf(b, "mise-backend") ? { getAttribute: () => metaOf(b, "mise-backend") } : null) };
  try {
    assert.equal(backendChoice(), "supabase");
  } finally {
    g.document = saved;
  }
});

test("a placeholder project is refused", () => {
  assert.throws(() => makeShell(HTML, "supabase", { url: "https://YOUR-PROJECT.supabase.co" }), /placeholder/);
  assert.throws(() => makeShell(HTML, "supabase", null), /placeholder/);
});
