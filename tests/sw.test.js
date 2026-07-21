import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const sw = readFileSync(root + "sw.js", "utf8");

// P4 drift guard: every real app module must be in the SW precache SHELL,
// and the SHELL must not list files that no longer exist. A new view that
// never lands in SHELL silently breaks offline; a deleted file left behind
// makes cache.addAll fail and the whole install reject.
test("sw.js SHELL precache matches the real app files exactly", () => {
  const shellMatch = sw.match(/const SHELL = \[([\s\S]*?)\];/);
  assert.ok(shellMatch, "SHELL array not found in sw.js");
  const listed = [...shellMatch[1].matchAll(/"\.\/(app\/[^"]+)"/g)].map((m) => m[1]).sort();

  const actual = [
    "app/styles.css",
    ...readdirSync(root + "app")
      .filter((f) => f.endsWith(".js"))
      .map((f) => `app/${f}`),
    ...readdirSync(root + "app/lib")
      .filter((f) => f.endsWith(".js"))
      .map((f) => `app/lib/${f}`),
    ...readdirSync(root + "app/views")
      .filter((f) => f.endsWith(".js"))
      .map((f) => `app/views/${f}`),
  ].sort();

  assert.deepEqual(listed, actual);
});

test("sw.js has the auto-bumped CACHE_VERSION marker the pre-commit hook rewrites", () => {
  assert.match(sw, /const CACHE_VERSION = "mise-shell-v\d+"/);
});
