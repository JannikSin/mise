import test from "node:test";
import assert from "node:assert/strict";
import {
  corsFor,
  buildScanRequest,
  buildReceiptRequest,
  buildRemedyRequest,
  parseToolUse,
  validateScanItems,
  validateReceiptItems,
  buildOnboardRequest,
  parseOnboardResponse,
  validateOnboardProfile,
  validateProtocol,
  allowRequest,
} from "../worker/src/lib.js";

test("corsFor allows only the app origins", () => {
  const prod = corsFor("https://janniksin.github.io");
  assert.equal(prod && prod["Access-Control-Allow-Origin"], "https://janniksin.github.io");
  const dev = corsFor("http://127.0.0.1:8378");
  assert.equal(dev && dev["Access-Control-Allow-Origin"], "http://127.0.0.1:8378");
  assert.equal(corsFor("https://evil.example"), null);
  assert.equal(corsFor(null), null);
});

test("buildScanRequest forces the record_items tool with the image attached", () => {
  const req = buildScanRequest({ image: "AAAA", mediaType: "image/jpeg", model: "m" });
  assert.equal(req.model, "m");
  assert.equal(req.tool_choice.name, "record_items");
  const img = req.messages[0].content.find((c) => c.type === "image");
  assert.equal(img.source.data, "AAAA");
  assert.equal(img.source.media_type, "image/jpeg");
  const schema = req.tools[0].input_schema;
  assert.ok(schema.properties.items, "items array in tool schema");
});

test("buildRemedyRequest forces the record_protocol tool and carries the text", () => {
  const req = buildRemedyRequest({ text: "scratchy throat and tired", model: "m" });
  assert.equal(req.tool_choice.name, "record_protocol");
  assert.match(JSON.stringify(req.messages), /scratchy throat/);
  assert.match(req.system, /not a doctor|not medical/i);
});

test("parseToolUse pulls the forced tool input out of an Anthropic response", () => {
  const resp = {
    content: [
      { type: "text", text: "thinking..." },
      { type: "tool_use", name: "record_items", input: { items: [{ name: "eggs" }] } },
    ],
  };
  assert.deepEqual(parseToolUse(resp, "record_items"), { items: [{ name: "eggs" }] });
  assert.equal(parseToolUse(resp, "record_protocol"), null);
  assert.equal(parseToolUse({}, "record_items"), null);
});

test("validateScanItems sanitizes: trims names, defaults kind, drops junk, caps at 60", () => {
  const items = validateScanItems({
    items: [
      { name: "  Eggs ", kind: "perishable", qty: "12" },
      { name: "Rice", kind: "staple" },
      { name: "Mystery", kind: "weird-kind" },
      { name: "" },
      { name: 42 },
      "not-an-object",
      { name: "x".repeat(300), kind: "staple", qty: "y".repeat(300) },
    ],
  });
  assert.equal(items.length, 4);
  assert.deepEqual(items[0], { name: "Eggs", kind: "perishable", qty: "12" });
  assert.deepEqual(items[1], { name: "Rice", kind: "staple", qty: "" });
  assert.equal(items[2].kind, "perishable", "unknown kind defaults to perishable");
  assert.ok(items[3].name.length <= 80, "name capped");
  assert.ok(items[3].qty.length <= 40, "qty capped");
});

test("validateScanItems caps the list length", () => {
  const many = { items: Array.from({ length: 100 }, (_, i) => ({ name: `item ${i}` })) };
  assert.equal(validateScanItems(many).length, 60);
});

test("allowRequest: caps requests per key per window, then resets", () => {
  const state = new Map();
  const t0 = 1_000_000;
  for (let i = 0; i < 30; i++) {
    assert.equal(allowRequest(state, "k", t0 + i), true, `request ${i} allowed`);
  }
  assert.equal(allowRequest(state, "k", t0 + 31), false, "31st inside window blocked");
  assert.equal(allowRequest(state, "other", t0 + 32), true, "other key unaffected");
  assert.equal(allowRequest(state, "k", t0 + 10 * 60 * 1000 + 1), true, "new window resets");
});

test("validateProtocol keeps only string arrays under the caps", () => {
  const p = validateProtocol({
    teas: ["ginger tea", 42, "honey lemon"],
    foods: "not-an-array",
    avoid: [],
    notes: Array.from({ length: 30 }, (_, i) => `note ${i}`),
  });
  assert.deepEqual(p.teas, ["ginger tea", "honey lemon"]);
  assert.deepEqual(p.foods, []);
  assert.deepEqual(p.avoid, []);
  assert.equal(p.notes.length, 12, "notes capped");
});

test("buildReceiptRequest forces the record_receipt tool with the image", () => {
  const req = buildReceiptRequest({ image: "abc", mediaType: "image/jpeg", model: "claude-sonnet-5" });
  assert.equal(req.tool_choice.name, "record_receipt");
  assert.equal(req.messages[0].content[0].source.data, "abc");
});

test("validateReceiptItems keeps priced food lines, drops junk and non-positive prices", () => {
  const out = validateReceiptItems({
    store: "  TRADER JOE'S #703  ",
    items: [
      { name: "black beans", price: 1.09, size: "15.5 oz" },
      { name: "bananas", price: 0.23 },
      { name: "coupon", price: -2 }, // discount line dropped
      { name: "", price: 5 }, // no name dropped
      { name: "tax", price: 0 }, // zero price dropped
      { junk: true },
    ],
  });
  assert.equal(out.store, "TRADER JOE'S #703");
  assert.deepEqual(
    out.items,
    [
      { name: "black beans", price: 1.09, size: "15.5 oz" },
      { name: "bananas", price: 0.23, size: "" },
    ],
  );
});

test("buildOnboardRequest primes the system with known survey answers, maps roles", () => {
  const req = buildOnboardRequest({
    messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }],
    survey: { name: "Sam", goal: "gain" },
    model: "claude-sonnet-5",
  });
  assert.ok(req.system.includes("Sam"), "survey folded into system");
  assert.equal(req.tools[0].name, "record_profile");
  assert.equal(req.messages[1].role, "assistant");
});

test("parseOnboardResponse returns text as reply, tool call as profile", () => {
  // a question turn
  const q = parseOnboardResponse({ content: [{ type: "text", text: "What's your goal?" }] });
  assert.equal(q.reply, "What's your goal?");
  assert.equal(q.profile, null);
  // a finished turn with a valid profile
  const done = parseOnboardResponse({
    content: [
      {
        type: "tool_use",
        name: "record_profile",
        input: { name: "Sam", emoji: "🏃", sex: "m", age: 30, heightFt: 5, heightIn: 10, weightLb: 170, activity: 3, goal: "maintain" },
      },
    ],
  });
  assert.equal(done.reply, "");
  assert.equal(done.profile.name, "Sam");
  assert.equal(done.profile.activity, 3);
  assert.equal(done.profile.leftoverTolerance, "some"); // default applied
});

test("validateOnboardProfile rejects incomplete required fields", () => {
  // missing weight -> null (not done yet)
  assert.equal(
    validateOnboardProfile({ name: "X", sex: "m", age: 30, heightFt: 5, heightIn: 10, activity: 2, goal: "gain" }),
    null,
  );
  // bad goal -> null
  assert.equal(
    validateOnboardProfile({ name: "X", sex: "m", age: 30, heightFt: 5, heightIn: 10, weightLb: 170, activity: 2, goal: "bulk" }),
    null,
  );
});
