// Kroger cart push (David, 2026-08-22: "as long as you put it in the cart, I
// will place the order"). The security-critical part is the signed state: it
// is the ONLY thing standing between the one unauthenticated GET route this
// Worker serves and an open redirect.
import test from "node:test";
import assert from "node:assert/strict";
import {
  ALLOWED_RETURN_ORIGINS,
  cartLinkStart,
  krogerCartConfigured,
  normalizeCartItems,
  verifyState,
} from "../worker/src/kroger.js";

const ENV = {
  KROGER_CLIENT_ID: "cid",
  KROGER_CLIENT_SECRET: "secret",
  KROGER_REDIRECT_URI: "https://w.example/kroger/cart/callback",
  KROGER_STATE_SECRET: "a-long-random-state-secret",
};
const RETURN_TO = "https://janniksin.github.io/mise/";

test("krogerCartConfigured needs the cart-specific config, not just the products keys", () => {
  assert.equal(krogerCartConfigured(ENV), true);
  assert.equal(krogerCartConfigured({ KROGER_CLIENT_ID: "c", KROGER_CLIENT_SECRET: "s" }), false);
  assert.equal(krogerCartConfigured({ ...ENV, KROGER_STATE_SECRET: "" }), false);
  assert.equal(krogerCartConfigured({}), false);
});

test("the consent URL asks for cart.basic:write and carries our redirect", async () => {
  const { url } = await cartLinkStart(ENV, RETURN_TO);
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, "https://api.kroger.com/v1/connect/oauth2/authorize");
  assert.equal(u.searchParams.get("scope"), "cart.basic:write");
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.get("client_id"), "cid");
  assert.equal(u.searchParams.get("redirect_uri"), ENV.KROGER_REDIRECT_URI);
  assert.ok(u.searchParams.get("state"), "a state is always minted");
});

test("a state we minted verifies, and yields the return-to we started with", async () => {
  const { state } = await cartLinkStart(ENV, RETURN_TO);
  assert.equal(await verifyState(state, ENV, ALLOWED_RETURN_ORIGINS), RETURN_TO);
});

test("a TAMPERED state is refused — this is the open-redirect defence", async () => {
  const { state } = await cartLinkStart(ENV, RETURN_TO);
  const parts = state.split(".");
  const sig = parts.pop();
  // flip one hex character of the signature
  const bad = [...parts, (sig[0] === "a" ? "b" : "a") + sig.slice(1)].join(".");
  assert.equal(await verifyState(bad, ENV, ALLOWED_RETURN_ORIGINS), null);
});

test("a state signed with a DIFFERENT secret is refused", async () => {
  const { state } = await cartLinkStart({ ...ENV, KROGER_STATE_SECRET: "attacker" }, RETURN_TO);
  assert.equal(await verifyState(state, ENV, ALLOWED_RETURN_ORIGINS), null);
});

test("a hand-rolled state pointing somewhere else is refused even in shape", async () => {
  const evil = `${Date.now()}.nonce.https://evil.example/steal.deadbeef`;
  assert.equal(await verifyState(evil, ENV, ALLOWED_RETURN_ORIGINS), null);
  assert.equal(await verifyState("", ENV, ALLOWED_RETURN_ORIGINS), null);
  assert.equal(await verifyState("a.b.c", ENV, ALLOWED_RETURN_ORIGINS), null);
});

test("a STALE state is refused: a consent hand-off is minutes, not forever", async () => {
  const { state } = await cartLinkStart(ENV, RETURN_TO);
  const real = Date.now;
  try {
    Date.now = () => real() + 11 * 60 * 1000;
    assert.equal(await verifyState(state, ENV, ALLOWED_RETURN_ORIGINS), null);
  } finally {
    Date.now = real;
  }
});

test("a validly signed state may still not redirect off our own origins", async () => {
  // the signature is genuine; only the destination is wrong. Belt and braces:
  // /kroger/cart/link also refuses a foreign returnTo before signing anything.
  const { state } = await cartLinkStart(ENV, "https://evil.example/x");
  assert.equal(await verifyState(state, ENV, ALLOWED_RETURN_ORIGINS), null);
});

test("normalizeCartItems keeps real UPCs and drops everything else", () => {
  const out = normalizeCartItems([
    { upc: "0001111041700", quantity: 2 },
    { upc: "12345678", quantity: 1 },
    { upc: "abc", quantity: 1 },
    { upc: "", quantity: 1 },
    { upc: "123", quantity: 1 },
    null,
  ]);
  assert.deepEqual(
    out.map((i) => i.upc),
    ["0001111041700", "12345678"],
  );
});

test("modality defaults to PICKUP, which is the whole point of this feature", () => {
  const [a, b, c] = normalizeCartItems([
    { upc: "0001111041700" },
    { upc: "0001111041701", modality: "DELIVERY" },
    { upc: "0001111041702", modality: "nonsense" },
  ]);
  assert.equal(a.modality, "PICKUP");
  assert.equal(b.modality, "DELIVERY");
  assert.equal(c.modality, "PICKUP");
});

test("quantities are clamped rather than trusted", () => {
  const out = normalizeCartItems([
    { upc: "0001111041700", quantity: 0 },
    { upc: "0001111041701", quantity: -5 },
    { upc: "0001111041702", quantity: 999 },
    { upc: "0001111041703", quantity: 2.6 },
    { upc: "0001111041704", quantity: "junk" },
  ]);
  assert.deepEqual(
    out.map((i) => i.quantity),
    [1, 1, 99, 3, 1],
  );
});

test("a runaway list is capped, so one bad call cannot dump 5000 rows", () => {
  const many = Array.from({ length: 300 }, (_, i) => ({
    upc: String(10000000 + i).padStart(13, "0"),
    quantity: 1,
  }));
  assert.equal(normalizeCartItems(many).length, 100);
});

test("junk input yields an empty list, never a throw", () => {
  assert.deepEqual(normalizeCartItems(null), []);
  assert.deepEqual(normalizeCartItems("nope"), []);
  assert.deepEqual(normalizeCartItems(undefined), []);
});
