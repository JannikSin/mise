import test from "node:test";
import assert from "node:assert/strict";

// github.js reads localStorage for the token at call time: stub the boundary
// before import, same pattern as github-token.test.js.
/** @type {Map<string, string>} */
const kv = new Map();
globalThis.localStorage = /** @type {any} */ ({
  getItem: (/** @type {string} */ k) => kv.get(k) ?? null,
  setItem: (/** @type {string} */ k, /** @type {string} */ v) => kv.set(k, String(v)),
  removeItem: (/** @type {string} */ k) => kv.delete(k),
});
kv.set("mise.pat", "t");

const g = /** @type {any} */ (globalThis);
const setOrigin = (/** @type {string | null} */ origin, /** @type {string | null} */ meta) => {
  if (origin === null) {
    delete g.location;
    delete g.document;
    return;
  }
  g.location = { origin };
  g.document = {
    querySelector: (/** @type {string} */ sel) =>
      sel.includes("mise-data-branch") && meta !== null ? { getAttribute: () => meta } : null,
  };
};

const { dataBranch, contentsUrl, writeFile } = await import("../app/lib/github.js");

test("the data branch is a function of ORIGIN, then the committed meta (release train)", () => {
  setOrigin(null, null);
  assert.equal(
    dataBranch(),
    "main",
    "outside a browser: the default branch, as every caller expects",
  );
  setOrigin("https://janniksin.github.io", "main");
  assert.equal(dataBranch(), "main");
  setOrigin("https://janniksin.github.io", "sandbox");
  assert.equal(dataBranch(), "main", "the live origin is main whatever a meta says");
  setOrigin("https://mise-next.pages.dev", "sandbox");
  assert.equal(dataBranch(), "sandbox");
  setOrigin("https://mise-next.pages.dev", "main");
  assert.equal(dataBranch(), null, "a sandbox shell without its swapped meta gets no branch");
  setOrigin("https://mise-next.pages.dev", null);
  assert.equal(dataBranch(), null);
  setOrigin("http://127.0.0.1:8378", "main");
  assert.equal(dataBranch(), null, "a dev server never writes live data by default");
  setOrigin("https://evil-mise-next.pages.dev", "sandbox");
  assert.equal(dataBranch(), null);
  setOrigin(null, null);
});

test("the live URL and PUT body are byte-identical to before the train; the sandbox names its branch; an unknown origin refuses", async () => {
  setOrigin("https://janniksin.github.io", "main");
  assert.ok(!contentsUrl("pantry.json").includes("?ref="));
  /** @type {any[]} */
  const calls = [];
  g.fetch = async (/** @type {string} */ url, /** @type {any} */ init) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, json: async () => ({ content: { sha: "new" } }) };
  };
  await writeFile("pantry.json", { items: [] }, "old");
  assert.ok(!("branch" in calls[0].body), "live PUT carries no branch key");
  assert.ok(!calls[0].url.includes("?ref="));

  setOrigin("https://mise-next.pages.dev", "sandbox");
  assert.ok(contentsUrl("pantry.json").endsWith("?ref=sandbox"));
  await writeFile("pantry.json", { items: [] }, "old");
  assert.equal(calls[1].body.branch, "sandbox");
  assert.ok(calls[1].url.includes("?ref=sandbox"));

  setOrigin("http://127.0.0.1:8378", "main");
  await assert.rejects(() => writeFile("pantry.json", { items: [] }, "old"), /writes are refused/);
  assert.equal(calls.length, 2, "the refusal happens before any request");
  setOrigin(null, null);
  delete g.fetch;
});
