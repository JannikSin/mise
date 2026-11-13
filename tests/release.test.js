import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RELEASES, LIVE_VERSION, UNRELEASED, versionLabel, PALETTE } from "../app/lib/release.js";

const shipped = RELEASES.filter((r) => r.version !== UNRELEASED);

// THE RULE (David, 2026-10-05): the number is chosen at ship time, sized to the
// improvement, and only ever moves up (as a decimal: 1.1 < 1.15 < 1.5 < 2.0).
test("shipped versions are decimal numbers, newest first, strictly rising, down to 1.0", () => {
  assert.equal(shipped.at(-1)?.version, "1.0");
  shipped.forEach((r, i) => {
    assert.match(r.version, /^\d+\.\d+$/, `"${r.version}" is not a version number`);
    if (i > 0) assert.ok(Number(r.version) < Number(shipped[i - 1].version), `${r.version} out of order`);
    assert.match(r.date, /^\d{4}-\d\d-\d\d$/, `v${r.version} has no ship date`);
    assert.ok(r.notes.length > 0, `v${r.version} has no notes`);
  });
  assert.equal(LIVE_VERSION, shipped[0].version);
});

test("only the top entry may be the unreleased work in progress, undated", () => {
  RELEASES.slice(1).forEach((r) => assert.notEqual(r.version, UNRELEASED));
  if (RELEASES[0].version === UNRELEASED) assert.equal(RELEASES[0].date, "");
});

test("the sandbox shows the live number plus work in progress, never a number of its own", () => {
  assert.equal(versionLabel("sandbox"), `v${LIVE_VERSION} + work in progress`);
  assert.equal(versionLabel("main"), `v${LIVE_VERSION}`);
});

// THE COLOR SET (David, 2026-11-12: "i want each fix to come with a new color
// scheme", then "only for releases").
const css = readFileSync(new URL("../app/styles.css", import.meta.url), "utf8");
const token = (/** @type {string} */ name) => {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css);
  assert.ok(m, `styles.css has no --${name} hex token`);
  return m[1];
};
const luminance = (/** @type {string} */ hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (/** @type {string} */ a, /** @type {string} */ b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test("every release from 1.97 names a color set, never the same as the release before it", () => {
  const from197 = shipped.filter((r) => Number(r.version) >= 1.97);
  assert.ok(from197.length > 0);
  from197.forEach((r) => assert.ok(r.palette, `v${r.version} names no color set`));
  const named = shipped.filter((r) => r.palette);
  for (let i = 0; i + 1 < named.length; i++) {
    assert.notEqual(named[i].palette, named[i + 1].palette, `v${named[i].version} reuses ${named[i].palette}`);
  }
  assert.equal(PALETTE, named[0].palette);
});

test("the colors in styles.css, index.html and the manifest are the newest release's set", () => {
  assert.match(css, new RegExp(`/\\* palette: ${PALETTE} \\*/\\s*:root`), "styles.css is not on the release's color set");
  const bg = token("bg").toLowerCase();
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.ok(html.includes(`<meta name="theme-color" content="${bg}" />`), "index.html theme-color is not --bg");
  const manifest = JSON.parse(readFileSync(new URL("../manifest.webmanifest", import.meta.url), "utf8"));
  assert.equal(manifest.theme_color.toLowerCase(), bg);
  assert.equal(manifest.background_color.toLowerCase(), bg);
});

test("the color set stays readable (WCAG contrast)", () => {
  for (const surface of ["bg", "panel", "panel-2"]) {
    assert.ok(contrast(token("text"), token(surface)) >= 7, `text on ${surface}`);
    assert.ok(contrast(token("dim"), token(surface)) >= 4.5, `dim text on ${surface}`);
    assert.ok(contrast(token("signal"), token(surface)) >= 4.5, `signal on ${surface}`);
    assert.ok(contrast(token("warn"), token(surface)) >= 4.5, `warning on ${surface}`);
  }
  assert.ok(contrast(token("on-signal"), token("signal")) >= 7, "text on a signal button");
  assert.ok(contrast(token("line"), token("bg")) >= 1.5, "card edges are visible");
});
