// Mise 2.0 fix loop 1, item 13 (Usability seat, exact copy from its report):
// the rules behind the reworked sign-in and account screens. The screens
// themselves are driven at 390 x 844 (tests/e2e/auth-gate.html); these pin
// the words and decisions so a later edit cannot quietly undo them.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  livePasswordHint,
  passwordProblem,
  authErrorText,
  setPasswordStep,
  MIN_PASSWORD,
} from "../app/views/auth-gate.js";
import { REASON_TEXT, friendlyPath } from "../app/views/account-panel.js";

const gateSrc = readFileSync(new URL("../app/views/auth-gate.js", import.meta.url), "utf8");
const panelSrc = readFileSync(new URL("../app/views/account-panel.js", import.meta.url), "utf8");

test("U7: the length rule shows as soon as anything is typed, with the count so far", () => {
  assert.equal(livePasswordHint("", ""), "");
  assert.equal(livePasswordHint("abcdef", ""), `${MIN_PASSWORD} characters or more. So far: 6.`);
  assert.equal(livePasswordHint("long-enough-1", ""), "", "long enough, second box empty: nothing to say yet");
  assert.match(livePasswordHint("long-enough-1", "long-enough"), /two passwords are different/);
  assert.equal(livePasswordHint("long-enough-1", "long-enough-1"), "");
  assert.match(passwordProblem("short", "short"), /So far: 5/);
});

test("U4/U5: a removed or turned-off account is told who to ask, never to reset forever", () => {
  for (const code of ["user_banned", "user_not_found"]) {
    assert.equal(authErrorText({ status: 400, code }, "signin"), "This account is turned off. Ask the person who invited you.");
  }
  assert.match(gateSrc, /Still stuck after\s+a reset\? Ask the person who invited you\./);
  assert.match(gateSrc, /removed: "This account is turned off\. Ask the person who invited you\."/);
});

test("U2: a spent link is 'dead' (the screen gives a way forward); no signal is not", async () => {
  const link = { tokenHash: "pkce_0123456789abcdef", type: /** @type {const} */ ("invite") };
  const auth = /** @type {any} */ ({
    verifyOtp: async () => ({ error: { status: 403, code: "otp_expired" } }),
    updateUser: async () => ({}),
  });
  const r = await setPasswordStep({ auth, link, password: "long-enough-1", verified: false, replaceHash: () => {} });
  assert.equal(r.dead, true);
  const off = /** @type {any} */ ({
    verifyOtp: async () => ({ error: Object.assign(new Error("x"), { name: "AuthRetryableFetchError" }) }),
    updateUser: async () => ({}),
  });
  const n = await setPasswordStep({ auth: off, link, password: "long-enough-1", verified: false, replaceHash: () => {} });
  assert.equal(n.dead, false, "no signal keeps the form: the link may still be good");
  assert.match(gateSrc, /This link no longer works/);
  assert.match(gateSrc, /Ask the person who invited you to send a new one\. If you already set a password, sign in instead\./);
  assert.match(gateSrc, /SEND ME A NEW LINK/);
});

test("U3: every screen with a field is a real form with a submit button and enterkeyhint", () => {
  const forms = [...gateSrc.matchAll(/<form class="tile" onSubmit=/g)].length;
  assert.equal(forms, 3, "sign in, set password, reset");
  assert.equal([...gateSrc.matchAll(/<button type="submit"/g)].length, 3);
  assert.ok(gateSrc.includes('enterkeyhint="go"') && gateSrc.includes('enterkeyhint="next"'));
  assert.equal(/onKeyDown/.test(gateSrc), false, "the form's submit replaces the Enter-key handler");
  assert.equal(/<button(?![^>]*type=)/.test(gateSrc), false, "every button says its type, so none submits by accident");
});

test("U4/U6: the data notice is short, plain, and never says Supabase or I UNDERSTAND", () => {
  const notice = gateSrc.slice(gateSrc.indexOf("export function DataNotice"), gateSrc.indexOf("const REASON_NOTE"));
  assert.equal(/Supabase|I UNDERSTAND|hint at your size/.test(notice), false);
  assert.equal([...notice.matchAll(/<li>/g)].length, 4);
  assert.match(notice, /They never see your weight, height, age or goals\./);
  assert.match(notice, /Always read the label too\./);
  assert.match(notice, /OK, CONTINUE/);
  assert.match(gateSrc, /"Before you start"/);
  assert.equal(/—/.test(gateSrc + panelSrc), false, "no em dash");
});

test("U8/U10/U12: calm reset note with a rest, forgot password as a link, a show-password toggle", () => {
  assert.match(gateSrc, /Check your email\. If that address has an account, a link is on its way\. Open it on this phone\. It can take a few minutes, so look in spam too\./);
  assert.match(gateSrc, /RESET_COOLDOWN_MS = 30_000/);
  assert.match(gateSrc, /class="linktext auth-link"[\s\S]{0,80}Forgot password\?/);
  assert.match(gateSrc, /Show password/);
  const css = readFileSync(new URL("../app/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.auth-gate \.hint \{\s*font-size: 14px;/);
  assert.match(css, /\.auth-gate input \{\s*font-size: 16px;/);
  assert.match(css, /\.auth-gate button:disabled \{\s*opacity: 0\.45;/);
});

test("U13: Settings speaks in plain words: labels for files, the seam's reasons, REMOVE keyed by id", () => {
  assert.equal(friendlyPath("plans/2026-W44.json", "housemate-1"), "Week 44 plan");
  assert.equal(friendlyPath("profiles/housemate-1/profile/targets.json", "housemate-1"), "Your targets");
  assert.equal(friendlyPath("profiles/host-1/profile/targets.json", "housemate-1"), "A profile you do not own");
  assert.equal(friendlyPath("households/house-w/shopping.json", "housemate-1"), "Shopping list");
  assert.equal(friendlyPath("households/house-w/events.json", "housemate-1"), "Shared meals");
  assert.equal(friendlyPath("something/odd.json", "housemate-1"), "A saved change");
  assert.equal(REASON_TEXT.presignin, "Made before sign-in");
  assert.equal(REASON_TEXT.forbidden, "Not allowed for your account");
  assert.equal(REASON_TEXT.name, "Would show a name in another household");
  assert.match(panelSrc, /Changes that didn't save/);
  assert.match(panelSrc, /REMOVE\s*<\/button>/);
  assert.match(panelSrc, /onDiscard\(r\.id \?\? r\.path\)/);
  assert.match(panelSrc, /This is what your phone received from Mise\./);
  assert.equal(/Profile<\/dt>|the database sent this phone|old store/.test(panelSrc), false);
});
