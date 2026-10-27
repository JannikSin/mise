// Mise 2.0, seam fix loop 2, item 4 (ENG 2 N3; P4 store): only the
// switch-morning shell (`<meta name="mise-move" content="on">`, moveOn())
// reads freeze.json. Every other GitHub-lane flush makes exactly the
// requests 1.95 made: an empty queue sends nothing, a write sends its PUT.
import test from "node:test";
import assert from "node:assert/strict";
import { idb, kv } from "./helpers/fake-browser.js";
import { fakeGithubLane } from "./helpers/fake-github-lane.js";

const { installBackend } = await import("../app/lib/backend.js");
const { write, flushNow, resetFileChecks } = await import("../app/lib/store.js");

/** a GitHub lane that logs every request it is asked to make */
function countingLane() {
  const lane = fakeGithubLane();
  /** @type {string[]} */
  const log = [];
  const b = /** @type {any} */ ({ ...lane.backend });
  for (const op of ["read", "write", "list", "readMeta"]) {
    const real = /** @type {any} */ (lane.backend)[op];
    b[op] = async (/** @type {string} */ path, /** @type {any[]} */ ...rest) => {
      log.push(`${op} ${path}`);
      return real(path, ...rest);
    };
  }
  return { b, log, lane };
}

/** @param {boolean} on */
function moveShell(on) {
  /** @type {any} */ (globalThis).document = on
    ? {
        querySelector: (/** @type {string} */ s) =>
          s === 'meta[name="mise-move"]' ? { getAttribute: () => "on" } : null,
      }
    : undefined;
}

test("a committed shell's flush never asks for freeze.json", async () => {
  idb.clear();
  kv.clear();
  resetFileChecks();
  moveShell(false);
  const { b, log } = countingLane();
  installBackend(b);
  await flushNow({ timeoutMs: 1000 });
  assert.deepEqual(log, [], "an empty queue sends nothing");
  await write("shopping.json", { items: ["rice"] }, { raw: true });
  await flushNow({ timeoutMs: 1000 });
  await flushNow({ timeoutMs: 1000 });
  assert.deepEqual(log, ["write shopping.json"], "the PUT, and nothing else");
  installBackend(null);
});

test("the switch-morning shell reads the freeze before it pushes", async () => {
  idb.clear();
  kv.clear();
  resetFileChecks();
  moveShell(true);
  const { b, log } = countingLane();
  installBackend(b);
  await write("shopping.json", { items: ["rice"] }, { raw: true });
  await flushNow({ timeoutMs: 1000 });
  assert.ok(log.includes("read freeze.json"), JSON.stringify(log));
  assert.ok(log.indexOf("read freeze.json") < log.indexOf("write shopping.json"));
  moveShell(false);
  installBackend(null);
});
