// Mise 2.0 fix loop 1, item 14: the vendored supabase-js is the pinned
// upstream bundle byte for byte, plus two export lines; it is in the service
// worker's shell; and it loads as one ES module with createClient.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";

const FILE = new URL("../vendor/supabase-js/supabase.esm.js", import.meta.url);

test("the bundle inside matches the sha256 its header pins, and only the exports are added", () => {
  const src = readFileSync(FILE, "utf8");
  const lines = src.split("\n");
  const header = lines.slice(0, 6).join("\n");
  assert.match(header, /@supabase\/supabase-js 2\.117\.3/);
  const pinned = /sha256 ([0-9a-f]{64})/.exec(header)?.[1];
  assert.ok(pinned, "the header pins a sha256");
  const tailAt = src.lastIndexOf("\nexport const createClient = supabase.createClient;");
  const bundle = src.slice(header.length + 1, tailAt);
  assert.equal(createHash("sha256").update(bundle).digest("hex"), pinned);
  assert.equal(src.slice(tailAt), "\nexport const createClient = supabase.createClient;\nexport default supabase;\n");
  assert.ok(existsSync(new URL("../vendor/supabase-js/LICENSE", import.meta.url)));
  assert.match(readFileSync(new URL("../vendor/supabase-js/LICENSE", import.meta.url), "utf8"), /MIT License/);
});

test("it loads as one ES module and exposes createClient", async () => {
  const m = await import("../vendor/supabase-js/supabase.esm.js");
  assert.equal(typeof m.createClient, "function");
  assert.equal(m.default.createClient, m.createClient);
});

test("sw.js caches it, and VERSIONS.md records the pin", () => {
  assert.match(readFileSync(new URL("../sw.js", import.meta.url), "utf8"), /"\.\/vendor\/supabase-js\/supabase\.esm\.js"/);
  assert.match(readFileSync(new URL("../vendor/VERSIONS.md", import.meta.url), "utf8"), /supabase-js\/supabase\.esm\.js \| @supabase\/supabase-js \| 2\.117\.3/);
});
