// Mise 2.0 D2: what Settings says this phone can see, and the move freeze.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { reachSummary } from "../app/views/account-panel.js";
import { FREEZE_PATH, freezeRecord, isFrozen, holdWrite, moveOn } from "../app/lib/freeze.js";

test("reachSummary counts from what roster() returned, never assumes", () => {
  // a Wayne-side phone: its house only, one housemate, one live guest
  const wayne = [
    { id: "housemate-1", household: "house-w" },
    { id: "host-1", household: "house-w" },
    { id: "guest-a", household: "guesthouse", roster: { guest: true } },
  ];
  assert.deepEqual(reachSummary(wayne, "housemate-1"), {
    houses: ["guesthouse", "house-w"],
    plateCards: 2,
    guests: 1,
  });
  // a row whose household the database hid (null) adds no house
  assert.deepEqual(
    reachSummary(
      [
        { id: "x", household: null },
        { id: "me", household: "house-w" },
      ],
      "me",
    ).houses,
    ["house-w"],
  );
  assert.deepEqual(reachSummary(/** @type {any} */ (null), "me"), {
    houses: [],
    plateCards: 0,
    guests: 0,
  });
});

test("the freeze file: only an explicit frozen true holds writes, and UNFREEZE can always land", () => {
  const f = freezeRecord(true, "host-1", "2026-11-15T15:00:00.000Z");
  assert.deepEqual(f, { frozen: true, at: "2026-11-15T15:00:00.000Z", by: "host-1" });
  assert.equal(isFrozen(f), true);
  for (const bad of [null, {}, { frozen: "true" }, { frozen: 1 }, "frozen"])
    assert.equal(isFrozen(bad), false);
  assert.equal(holdWrite(f, "plans/2026-W46.json"), true);
  assert.equal(holdWrite(f, FREEZE_PATH), false);
  assert.equal(holdWrite(freezeRecord(false, "host-1", "x"), "plans/2026-W46.json"), false);
});

test("the freeze control is off on every shell without the move meta, this one included", () => {
  assert.equal(moveOn(undefined), false);
  assert.equal(moveOn({ querySelector: () => null }), false);
  assert.equal(moveOn({ querySelector: () => ({ getAttribute: () => "on" }) }), true);
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.equal(/name="mise-move"/.test(html), false);
});

test("Settings: SWITCH PROFILE is behind canSwitchHere, and the account section is mounted", () => {
  const src = readFileSync(new URL("../app/views/system.js", import.meta.url), "utf8");
  assert.match(
    src,
    /canSwitchHere\(\) &&\s*html`<div class="actions">\s*<button class="secondary" onClick=\$\{switchProfile\}>SWITCH PROFILE/,
  );
  assert.match(src, /<\$\{AccountSection\}/);
});
