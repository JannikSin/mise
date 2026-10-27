// Mise 2.0, seam fix loop 2, item 5 (Red Team 2 L3; P4 store): on the
// switch-morning shell a freeze.json read that FAILS holds every queued
// change but the freeze file itself, with a plain status line. A missing
// file still holds nothing (the morning before FREEZE is tapped). The
// freeze is asked every pass, so a phone that cached "not frozen" stops at
// once when FREEZE lands.
import test from "node:test";
import assert from "node:assert/strict";
import { idb, kv } from "./helpers/fake-browser.js";
import { fakeGithubLane } from "./helpers/fake-github-lane.js";

const { installBackend } = await import("../app/lib/backend.js");
const { write, flushNow, resetFileChecks, getSyncStatus } = await import("../app/lib/store.js");

/** @param {boolean} on */
function moveShell(on) {
  /** @type {any} */ (globalThis).document = on
    ? {
        querySelector: (/** @type {string} */ s) =>
          s === 'meta[name="mise-move"]' ? { getAttribute: () => "on" } : null,
      }
    : undefined;
}

/** a GitHub lane whose freeze.json read can be made to fail on its own */
function lane() {
  const l = fakeGithubLane();
  const ctl = { freezeDown: false };
  const real = l.backend.read;
  l.backend = {
    ...l.backend,
    read: async (path) => {
      if (path === "freeze.json" && ctl.freezeDown) throw new Error("can't reach api.github.com");
      return real(path);
    },
  };
  return { l, ctl };
}

test("a failed freeze read holds the queue, says why, and lets it go once read", async () => {
  idb.clear();
  kv.clear();
  resetFileChecks();
  moveShell(true);
  const { l, ctl } = lane();
  ctl.freezeDown = true;
  installBackend(l.backend);
  await write("shopping.json", { items: ["rice"] }, { raw: true });
  const r = await flushNow({ timeoutMs: 1000 });
  assert.equal(l.files.has("shopping.json"), false, "held, fail closed");
  assert.equal(r.landed, false);
  assert.match(String(getSyncStatus().lastError), /couldn't check the move freeze/);
  await flushNow({ timeoutMs: 1000 });
  assert.equal(l.files.has("shopping.json"), false, "still held on the next pass");
  ctl.freezeDown = false;
  const ok = await flushNow({ timeoutMs: 1000 });
  assert.equal(ok.landed, true, JSON.stringify(ok));
  assert.deepEqual(l.files.get("shopping.json")?.data, { items: ["rice"] });
  assert.equal(getSyncStatus().lastError, null);
  moveShell(false);
  installBackend(null);
});

test("a missing freeze file holds nothing, and FREEZE stops the next pass at once", async () => {
  idb.clear();
  kv.clear();
  resetFileChecks();
  moveShell(true);
  const { l } = lane();
  installBackend(l.backend);
  await write("shopping.json", { items: ["rice"] }, { raw: true });
  assert.equal((await flushNow({ timeoutMs: 1000 })).landed, true, "not frozen yet");
  // another phone taps FREEZE; this one learns it on its very next pass
  l.files.set("freeze.json", {
    data: { frozen: true, at: "2026-11-15T09:00:00Z", by: "admin-1" },
    sha: "gitf",
  });
  await write("pantry.json", { items: ["oats"] }, { raw: true });
  await flushNow({ timeoutMs: 1000 });
  assert.equal(l.files.has("pantry.json"), false, "frozen, no 30 s window");
  moveShell(false);
  installBackend(null);
});

test("an UNFREEZE tapped on this phone wins here even while the read fails", async () => {
  idb.clear();
  kv.clear();
  resetFileChecks();
  moveShell(true);
  const { l, ctl } = lane();
  ctl.freezeDown = true;
  installBackend(l.backend);
  await write("freeze.json", { frozen: false, at: "2026-11-15T09:00:00Z", by: "admin-1" }, {
    raw: true,
  });
  await write("shopping.json", { items: ["rice"] }, { raw: true });
  await flushNow({ timeoutMs: 1000 });
  assert.equal(l.files.get("freeze.json")?.data.frozen, false);
  moveShell(false);
  installBackend(null);
});

test("off the switch-morning shell a GitHub outage is 1.95's plain stop, nothing more", async () => {
  idb.clear();
  kv.clear();
  resetFileChecks();
  moveShell(false);
  const { l, ctl } = lane();
  ctl.freezeDown = true;
  installBackend(l.backend);
  await write("shopping.json", { items: ["rice"] }, { raw: true });
  assert.equal((await flushNow({ timeoutMs: 1000 })).landed, true);
  installBackend(null);
});
