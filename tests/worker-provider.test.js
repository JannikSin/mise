// The AI gateway (per-person-plates-design §16.2): provider swap is env
// config; the openai adapter must translate BOTH directions so downstream
// Anthropic-shape parsers never see a provider difference.
import { test } from "node:test";
import assert from "node:assert/strict";
import { callModel, providerConfigured } from "../worker/src/provider.js";

const BODY = {
  model: "claude-sonnet-5",
  max_tokens: 512,
  system: "sys",
  tools: [{ name: "record_thing", description: "d", input_schema: { type: "object" } }],
  tool_choice: { type: "tool", name: "record_thing" },
  messages: [
    { role: "user", content: [{ type: "text", text: "hi" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] },
  ],
};

test("anthropic provider hits the Messages API unchanged", async () => {
  /** @type {any} */ let seen;
  globalThis.fetch = async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), { status: 200 });
  };
  const out = await callModel(BODY, { ANTHROPIC_API_KEY: "k" });
  assert.equal(seen.url, "https://api.anthropic.com/v1/messages");
  assert.equal(seen.init.headers["x-api-key"], "k");
  assert.equal(JSON.parse(seen.init.body).system, "sys");
  assert.equal(out.content[0].text, "ok");
});

test("AI_MODEL overrides the model for any provider", async () => {
  /** @type {any} */ let seen;
  globalThis.fetch = async (url, init) => {
    seen = JSON.parse(init.body);
    return new Response(JSON.stringify({ content: [] }), { status: 200 });
  };
  await callModel(BODY, { ANTHROPIC_API_KEY: "k", AI_MODEL: "claude-opus-5" });
  assert.equal(seen.model, "claude-opus-5");
});

test("openai adapter translates the request out and the response back", async () => {
  /** @type {any} */ let seen;
  globalThis.fetch = async (url, init) => {
    seen = { url, body: JSON.parse(init.body) };
    return new Response(
      JSON.stringify({
        model: "qwen",
        choices: [{
          finish_reason: "tool_calls",
          message: {
            content: "note",
            tool_calls: [{ id: "c1", function: { name: "record_thing", arguments: '{"a":1}' } }],
          },
        }],
      }),
      { status: 200 },
    );
  };
  const out = await callModel(BODY, { AI_PROVIDER: "openai", AI_BASE_URL: "http://mac.local/v1/" });
  assert.equal(seen.url, "http://mac.local/v1/chat/completions");
  assert.equal(seen.body.messages[0].role, "system");
  // image rides as a data-URI part; tool schema moves under function.parameters
  const userParts = seen.body.messages[1].content;
  assert.ok(userParts.some((p) => p.type === "image_url" && p.image_url.url.startsWith("data:image/png;base64,")));
  assert.equal(seen.body.tools[0].function.name, "record_thing");
  assert.deepEqual(seen.body.tool_choice, { type: "function", function: { name: "record_thing" } });
  // response comes back in Anthropic block shape: downstream parsers unchanged
  const tool = out.content.find((b) => b.type === "tool_use" && b.name === "record_thing");
  assert.deepEqual(tool.input, { a: 1 });
  assert.equal(out.stop_reason, "tool_use");
});

test("malformed local-model tool JSON degrades to empty input, never a throw", async () => {
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ id: "c", function: { name: "record_thing", arguments: "{oops" } }] } }] }),
      { status: 200 },
    );
  const out = await callModel(BODY, { AI_PROVIDER: "openai", AI_BASE_URL: "http://x" });
  assert.deepEqual(out.content[0].input, {});
});

test("providerConfigured gates on the ACTIVE provider", () => {
  assert.equal(providerConfigured({ ANTHROPIC_API_KEY: "k" }), true);
  assert.equal(providerConfigured({}), false);
  assert.equal(providerConfigured({ AI_PROVIDER: "openai", AI_BASE_URL: "http://x" }), true);
  assert.equal(providerConfigured({ AI_PROVIDER: "openai" }), false);
});
