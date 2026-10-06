import test from "node:test";
import assert from "node:assert/strict";
import { RELEASES, LIVE_VERSION, UNRELEASED, versionLabel } from "../app/lib/release.js";

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
