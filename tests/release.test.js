import test from "node:test";
import assert from "node:assert/strict";
import { RELEASES, VERSION, versionLabel } from "../app/lib/release.js";

// THE RULE (David, 2026-10-05): every promotion from next to live bumps the
// version and adds its notes. The changelog must stay a clean ladder.
test("releases run newest first, one step at a time, down to v1", () => {
  assert.equal(RELEASES.at(-1)?.version, 1);
  RELEASES.forEach((r, i) => {
    if (i > 0) assert.equal(r.version, RELEASES[i - 1].version - 1, `v${r.version} out of order`);
    assert.ok(r.notes.length > 0, `v${r.version} has no notes`);
  });
  assert.equal(VERSION, RELEASES[0].version);
});

test("only the top release may be undated; every shipped one carries its day", () => {
  RELEASES.slice(1).forEach((r) => assert.match(r.date, /^\d{4}-\d\d-\d\d$/, `v${r.version}`));
  assert.match(RELEASES[0].date, /^(\d{4}-\d\d-\d\d)?$/);
});

test("the sandbox says -next, live says the plain number", () => {
  assert.equal(versionLabel("sandbox"), `v${VERSION}-next`);
  assert.equal(versionLabel("main"), `v${VERSION}`);
});
