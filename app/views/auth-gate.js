import { html } from "htm/preact";
import { useState } from "preact/hooks";

// THE ACCOUNT GATE (Mise 2.0, plan sections 1 and 5; P3 knows-you, P8 plates).
// On a Supabase build every member signs in with an email and a password
// they chose themselves from an invite. There is no sign-up (it is off in
// the project), no username and no anonymous session: an account exists
// only because the admin invited it.
//
// Three screens, one file:
//   - WHERE YOUR DATA LIVES, the notice everyone reads once (members,
//     housemates and guests alike; the legal gate's notice, plan section 1);
//   - SIGN IN, email plus password;
//   - SET PASSWORD, opened from an invite or reset email. The link carries a
//     one-time token hash, and verifyOtp runs ONLY when the person taps the
//     button (E6): mail scanners open links, and a token spent on page load
//     would be spent by the scanner.
//
// ON THE GITHUB BACKEND THIS FILE NEVER RENDERS. authGateWanted() answers
// null unless the shell carries `<meta name="mise-backend" content="supabase">`,
// so every 1.9x shell, and this one without that meta, boots exactly as 1.95.
// OWNER schelkin: the Supabase client (vendored supabase-js 2.117.3) is wired
// into `setAuthClientFactory` at integration on wip-2.0, Fri 10/30.

/** the one-time notice, remembered per device (namespaced: the origin is shared) */
const NOTICE_KEY = "mise.dataNotice.v1";
/** the shortest password the gate accepts; the project's own minimum must not be higher */
export const MIN_PASSWORD = 10;

/**
 * The supabase-js v2 `client.auth` surface the gate uses. Anything with these
 * four methods works, which is how the tests and the local harness drive it.
 * @typedef {{
 *   signInWithPassword(a: { email: string, password: string }): Promise<{ data?: any, error?: any }>,
 *   verifyOtp(a: { token_hash: string, type: "invite" | "recovery" }): Promise<{ data?: any, error?: any }>,
 *   updateUser(a: { password: string }): Promise<{ data?: any, error?: any }>,
 *   resetPasswordForEmail(email: string, opts?: { redirectTo?: string }): Promise<{ data?: any, error?: any }>,
 * }} AuthLike
 */

/** @type {(() => AuthLike | null) | null} */
let factory = null;

/**
 * Integration hook: the boot code hands the gate its auth client.
 * @param {(() => AuthLike | null) | null} f
 */
export function setAuthClientFactory(f) {
  factory = f;
}

/** @returns {AuthLike | null} */
export function authClient() {
  try {
    return factory ? factory() : null;
  } catch {
    return null;
  }
}

/**
 * Which backend the SHELL asks for. Same rule as backend/config.js
 * backendChoice() on the seam lane (tests/auth-gate.test.js checks the two
 * agree once both are on one branch): the meta, nothing a user can set.
 * @param {{ querySelector?: (s: string) => any } | undefined} [doc]
 * @returns {"github" | "supabase"}
 */
export function shellBackend(doc = /** @type {any} */ (globalThis).document) {
  const meta =
    doc && typeof doc.querySelector === "function"
      ? String(doc.querySelector('meta[name="mise-backend"]')?.getAttribute("content") ?? "").trim()
      : "";
  return meta === "supabase" ? "supabase" : "github";
}

/**
 * An invite or reset link: `#/set-password?token_hash=...&type=invite|recovery`.
 * @param {string} hash
 * @returns {{ tokenHash: string, type: "invite" | "recovery" } | null}
 */
export function authLinkFrom(hash) {
  const m = String(hash ?? "").match(/^#\/set-password\?(.*)$/);
  if (!m) return null;
  const q = new URLSearchParams(m[1]);
  const tokenHash = q.get("token_hash") ?? "";
  const type = q.get("type");
  if (!/^[A-Za-z0-9_-]{8,256}$/.test(tokenHash)) return null;
  if (type !== "invite" && type !== "recovery") return null;
  return { tokenHash, type };
}

/**
 * After the link's token is spent (fix loop 1, R4, E3, U1) the address bar
 * holds `#/set-password?verified=1&type=...` instead: no token, so a reload
 * or a shared screenshot carries nothing usable, and the phone (which holds
 * the session verifyOtp made) comes back to the password step, signed in.
 * @param {string} hash
 * @returns {{ type: "invite" | "recovery" } | null}
 */
export function verifiedLinkFrom(hash) {
  const m = String(hash ?? "").match(/^#\/set-password\?(.*)$/);
  if (!m) return null;
  const q = new URLSearchParams(m[1]);
  const type = q.get("type");
  if (q.get("verified") !== "1" || q.has("token_hash")) return null;
  if (type !== "invite" && type !== "recovery") return null;
  return { type };
}

/** the hash that replaces a spent link @param {"invite" | "recovery"} type */
export function verifiedHash(type) {
  return `#/set-password?verified=1&type=${type}`;
}

/**
 * E5, the offline predicate: a persisted supabase-js session object counts as
 * signed in, so a phone with no signal still opens its cached week. Only the
 * shape is checked here; the Worker and the database check the token.
 * Only THIS project's key counts (fix loop 1, E15): the origin is shared by
 * several apps, and another app's Supabase session must not skip the gate.
 * @param {{ getItem(k: string): string | null } | null} storage
 * @param {string | null} ref this project's ref (projectRef), null = none
 */
export function hasPersistedSession(storage, ref) {
  if (!storage || !ref || !/^[a-z0-9]+$/.test(ref)) return false;
  try {
    const v = JSON.parse(storage.getItem(`sb-${ref}-auth-token`) ?? "null");
    return Boolean(
      v && (typeof v.refresh_token === "string" || typeof v.access_token === "string"),
    );
  } catch {
    return false;
  }
}

/**
 * The project ref from its URL (`https://<ref>.supabase.co`), the part
 * supabase-js puts in its storage key; null for a placeholder or anything else.
 * @param {string | null | undefined} url
 */
export function projectRef(url) {
  const m = String(url ?? "").match(/^https:\/\/([a-z0-9]{6,40})\.supabase\.co\/?$/);
  return m ? /** @type {string} */ (m[1]) : null;
}

/**
 * What the boot's answer means for the screen (fix loop 1, E5): a stored
 * session that turns out dead ("signed-out": supabase-js could not refresh
 * it; "expired": the database refused it) or a removed account goes back to
 * SIGN IN; the cache is kept. "offline" (no signal) and "signed-in" stay in
 * the app.
 * @param {"signed-in" | "signed-out" | "expired" | "revoked" | "offline"} result
 * @returns {null | { start: "signin", reason: "signed-out" | "expired" | "removed" }}
 */
export function gateAfterBoot(result) {
  if (result === "signed-out" || result === "expired") return { start: "signin", reason: result };
  if (result === "revoked") return { start: "signin", reason: "removed" };
  return null;
}

/**
 * Should the gate render instead of the app, and on which screen?
 * null = boot as before (always on the GitHub backend).
 * @param {{ backend: "github" | "supabase", hash: string, storage: any, ref: string | null }} a
 * @returns {null | "setpw" | "signin"}
 */
export function authGateWanted(a) {
  if (a.backend !== "supabase") return null;
  if (authLinkFrom(a.hash)) return "setpw";
  // the token was spent on this phone, the password is not saved yet: back to
  // the password step while the session lasts, else sign in
  if (verifiedLinkFrom(a.hash)) return hasPersistedSession(a.storage, a.ref) ? "setpw" : "signin";
  // guest pages are the Worker's name-and-passkey flow, not an account
  if (/^#\/(join|status|me)(\/|\?|$)/.test(String(a.hash ?? ""))) return null;
  return hasPersistedSession(a.storage, a.ref) ? null : "signin";
}

/**
 * What is wrong with a new password, in plain words; "" when it is fine.
 * @param {string} pw
 * @param {string} again
 */
export function passwordProblem(pw, again) {
  if (pw.length < MIN_PASSWORD) return `${MIN_PASSWORD} characters or more. So far: ${pw.length}.`;
  if (pw.trim() !== pw) return "Leave out spaces at the start and end.";
  if (pw !== again) return "The two passwords are different. Type the same one in both boxes.";
  return "";
}

/**
 * What to show UNDER the fields while typing (Usability 7): the length rule
 * as soon as anything is typed, the mismatch once the second box has
 * something in it. "" when there is nothing to say yet, or nothing wrong.
 * @param {string} pw
 * @param {string} again
 */
export function livePasswordHint(pw, again) {
  if (!pw && !again) return "";
  const problem = passwordProblem(pw, again);
  if (!problem) return "";
  if (pw.length >= MIN_PASSWORD && pw.trim() === pw && again.length === 0) return "";
  return problem;
}

/**
 * Did the request never reach the server (fix loop 1, E16)? supabase-js
 * names that AuthRetryableFetchError; a raw fetch failure is a TypeError. A
 * status of 0 alone, or an error with nothing in it, is NOT no signal.
 * @param {any} error
 */
export function isNetworkError(error) {
  const name = String(error?.name ?? "");
  if (name === "AuthRetryableFetchError") return true;
  if (error instanceof TypeError || name === "TypeError") return /fetch|network|load failed/i.test(String(error?.message ?? ""));
  return false;
}

/** the words for no signal, on every screen */
export const NO_SIGNAL = "Can't reach Mise. Check your connection and try again.";

/**
 * A supabase-js error as one plain sentence. Never echoes the server's text,
 * which can name the account or the project.
 * @param {any} error
 * @param {"signin" | "link" | "password" | "reset"} where
 */
export function authErrorText(error, where) {
  const status = Number(error?.status ?? 0);
  const code = String(error?.code ?? "");
  if (isNetworkError(error)) return NO_SIGNAL;
  if (
    status === 429 ||
    code === "over_request_rate_limit" ||
    code === "over_email_send_rate_limit"
  ) {
    return "Too many tries. Wait a few minutes, then try again.";
  }
  if (code === "user_banned" || code === "user_not_found") {
    return "This account is turned off. Ask the person who invited you.";
  }
  if (where === "signin") {
    if (code === "email_not_confirmed") return "Open the invite email first and set your password.";
    return "That email and password don't match. Check them, or tap Forgot password.";
  }
  if (where === "link") {
    return "This link no longer works. Links work once.";
  }
  if (where === "password") {
    if (code === "weak_password") return "That password is too easy to guess. Try a longer one.";
    if (code === "same_password") return "Pick a password you have not used here before.";
    return "The password was not saved. Try again.";
  }
  return "The reset email could not be sent. Try again in a few minutes.";
}

/**
 * SET PASSWORD's tap, as a pure step the tests drive (fix loop 1, R4, E3, U1).
 * The token is spent at most ONCE: after a good verifyOtp the caller keeps
 * `verified` and the token leaves the address bar at once, so a retry after a
 * refused or unsent password calls only updateUser.
 * @param {{
 *   auth: AuthLike,
 *   link: { tokenHash?: string, type: "invite" | "recovery" } | null,
 *   password: string,
 *   verified: boolean,
 *   replaceHash: (hash: string) => void,
 * }} a
 * `dead` is true when the link itself no longer works (the gate then shows
 * the way forward instead of the form, Usability 2).
 * @returns {Promise<{ verified: boolean, note: string, done: boolean, dead?: boolean }>}
 */
export async function setPasswordStep(a) {
  /** @param {Promise<any>} p */
  const settle = (p) =>
    p.catch((/** @type {any} */ e) => /** @type {{ data?: any, error?: any }} */ ({ error: e }));
  let verified = a.verified;
  if (!verified) {
    if (!a.link?.tokenHash) {
      return { verified, note: authErrorText({ status: 400 }, "link"), done: false, dead: true };
    }
    // E6: the token is spent HERE, on the tap, never on page load
    const v = await settle(a.auth.verifyOtp({ token_hash: a.link.tokenHash, type: a.link.type }));
    if (v?.error || !v?.data?.session) {
      const network = isNetworkError(v?.error);
      return {
        verified,
        note: authErrorText(v?.error ?? { status: 400 }, "link"),
        done: false,
        dead: !network,
      };
    }
    verified = true;
    // the token is spent: out of the address bar and history NOW, not at the end
    a.replaceHash(verifiedHash(a.link.type));
  }
  const u = await settle(a.auth.updateUser({ password: a.password }));
  if (u?.error) {
    return {
      verified,
      note: isNetworkError(u.error)
        ? "Can't reach Mise. You are still signed in on this phone; try again."
        : authErrorText(u.error, "password"),
      done: false,
    };
  }
  a.replaceHash("#/plan");
  return { verified, note: "", done: true };
}

/** @param {string} hash */
function replaceHashInHistory(hash) {
  try {
    history.replaceState(null, "", `${location.pathname}${location.search}${hash}`);
  } catch {
    // no history API: nothing to replace
  }
}

/** @returns {Storage | null} */
function safeStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** @returns {boolean} */
export function noticeSeen(storage = safeStorage()) {
  try {
    return storage?.getItem(NOTICE_KEY) === "yes";
  } catch {
    return false;
  }
}

function markNoticeSeen(storage = safeStorage()) {
  try {
    storage?.setItem(NOTICE_KEY, "yes");
  } catch {
    // storage refused: the notice shows again next time, which is harmless
  }
}

/**
 * WHERE YOUR DATA LIVES. Plain words, no names (the code is public), four
 * points and a short paragraph (fix loop 1, Usability 5 and 6).
 * @param {{ onDone: () => void, again?: boolean }} props
 */
export function DataNotice({ onDone, again = false }) {
  return html`<div class="tile auth-notice">
    <div class="k">Where your data lives</div>
    <ul class="auth-points">
      <li>
        Your account and Mise data are kept in a private online database. The admin runs it for
        this kitchen.
      </li>
      <li>
        <b>People you cook with see your plate card.</b> That is your diet, allergies, foods you
        avoid, meal times, and how much you eat at a meal. It is how they cook something safe for
        you.
      </li>
      <li>
        <b>They never see your weight, height, age or goals.</b> Only you and the admin can see
        those.
      </li>
      <li>
        When you scan a photo or ask a question, it is sent to an AI to answer. Mise only keeps it
        if you save the answer.
      </li>
    </ul>
    <p class="hint">
      Ask the admin any time to export or delete your data. A guest's access ends when their host's
      invitation does. An allergy check helps. Always read the label too.
    </p>
    <div class="actions">
      <button type="button" class="ask" onClick=${onDone}>${again ? "BACK" : "OK, CONTINUE"}</button>
    </div>
  </div>`;
}

/** what the sign-in screen says when the boot sent the phone back to it */
const REASON_NOTE = /** @type {Record<string, string>} */ ({
  removed: "This account is turned off. Ask the person who invited you.",
  expired: "You were signed out on this phone. Sign in again to keep going.",
  "signed-out": "You were signed out on this phone. Sign in again to keep going.",
});

/** how long SEND RESET LINK rests after a send, so the rate limit is not hit */
const RESET_COOLDOWN_MS = 30_000;

/**
 * The gate. `start` is authGateWanted()'s answer; `auth` the client (null
 * means this build has no sign-in wired, said plainly rather than a blank).
 * Every screen is a real <form> with a submit button, so the keyboard's Go
 * key works and iOS offers to save the password (Usability 3).
 * @param {{
 *   auth: AuthLike | null,
 *   start: "signin" | "setpw",
 *   link?: { tokenHash?: string, type: "invite" | "recovery", verified?: boolean } | null,
 *   reason?: string | null,
 *   onSignedIn?: () => void,
 *   storage?: any,
 *   redirectTo?: string,
 *   replaceHash?: (hash: string) => void,
 *   nowMs?: () => number,
 * }} props
 */
export function AuthGateView({
  auth,
  start,
  link = null,
  reason = null,
  onSignedIn = () => location.reload(),
  storage = safeStorage(),
  redirectTo = undefined,
  replaceHash = replaceHashInHistory,
  nowMs = () => Date.now(),
}) {
  const [screen, setScreen] = useState(
    /** @type {"notice" | "signin" | "setpw" | "dead" | "reset" | "done"} */ (
      noticeSeen(storage) ? start : "notice"
    ),
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [note, setNote] = useState(reason ? (REASON_NOTE[reason] ?? "") : "");
  const [sent, setSent] = useState("");
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);
  const [showNotice, setShowNotice] = useState(false);
  const [verified, setVerified] = useState(Boolean(link?.verified));
  const [restUntil, setRestUntil] = useState(0);

  const head = html`<div class="hero">
    <h1>Mise<span>.</span></h1>
    <div class="sub">
      ${
        screen === "notice"
          ? "Before you start"
          : start !== "setpw"
            ? "Sign in to your kitchen"
            : link?.type === "recovery"
              ? "Reset your password"
              : "Set up your account"
      }
    </div>
  </div>`;

  if (screen === "notice") {
    return html`<div class="view auth-gate">
      ${head}
      <${DataNotice}
        onDone=${() => {
          markNoticeSeen(storage);
          setScreen(start);
        }}
      />
    </div>`;
  }
  if (showNotice) {
    return html`<div class="view auth-gate">
      ${head}
      <${DataNotice} again onDone=${() => setShowNotice(false)} />
    </div>`;
  }
  if (!auth) {
    return html`<div class="view auth-gate">
      ${head}
      <div class="tile">
        <p class="hint" role="status">
          Sign-in is not set up on this version yet. Ask the admin for the current link.
        </p>
      </div>
    </div>`;
  }

  /** @param {() => Promise<void>} fn */
  const run = async (fn) => {
    setBusy(true);
    setNote("");
    setSent("");
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  /** a form's submit, never a page load @param {() => void} fn */
  const submit = (fn) => (/** @type {any} */ e) => {
    e.preventDefault();
    fn();
  };
  const go = (/** @type {"signin" | "reset"} */ s) => {
    setNote("");
    setSent("");
    setScreen(s);
  };

  const signIn = () =>
    run(async () => {
      const r = await auth
        .signInWithPassword({ email: email.trim(), password })
        .catch((/** @type {any} */ e) => /** @type {{ data?: any, error?: any }} */ ({ error: e }));
      if (r?.error || !r?.data?.session) {
        setPassword("");
        setNote(authErrorText(r?.error ?? { status: 400 }, "signin"));
        return;
      }
      onSignedIn();
    });

  const setNewPassword = () =>
    run(async () => {
      const problem = passwordProblem(password, again);
      if (problem) {
        setNote(problem);
        return;
      }
      const r = await setPasswordStep({ auth, link, password, verified, replaceHash });
      setVerified(r.verified);
      if (r.done) setScreen("done");
      else if (r.dead) setScreen("dead");
      else setNote(r.note);
    });

  const sendReset = () =>
    run(async () => {
      const r = await auth
        .resetPasswordForEmail(email.trim(), redirectTo ? { redirectTo } : undefined)
        .catch((/** @type {any} */ e) => /** @type {{ data?: any, error?: any }} */ ({ error: e }));
      if (r?.error) {
        setNote(authErrorText(r.error, "reset"));
        return;
      }
      // the same words whether or not the address has an account
      setSent(
        "Check your email. If that address has an account, a link is on its way. Open it on this phone. It can take a few minutes, so look in spam too.",
      );
      const until = nowMs() + RESET_COOLDOWN_MS;
      setRestUntil(until);
      setTimeout(() => setRestUntil(0), RESET_COOLDOWN_MS);
    });

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const notice = html`<p class="hint">
    <button type="button" class="linktext" onClick=${() => setShowNotice(true)}>
      Where your data lives
    </button>
  </p>`;
  const showToggle = html`<label class="auth-show">
    <input
      type="checkbox"
      checked=${show}
      onChange=${(/** @type {any} */ e) => setShow(e.currentTarget.checked)}
    />
    Show password
  </label>`;
  const errorNote = note && html`<p class="hint auth-note" role="alert">${note}</p>`;

  if (screen === "done") {
    return html`<div class="view auth-gate">
      ${head}
      <div class="tile">
        <div class="k">Password set</div>
        <p class="hint" role="status">
          You are signed in on this phone. Next time, sign in with your email and this password.
        </p>
        <div class="actions">
          <button type="button" class="ask" onClick=${onSignedIn}>OPEN MISE</button>
        </div>
      </div>
    </div>`;
  }

  if (screen === "dead") {
    const recovery = link?.type === "recovery";
    return html`<div class="view auth-gate">
      ${head}
      <div class="tile">
        <div class="k">This link no longer works</div>
        <p class="hint" role="status">
          ${
            recovery
              ? "Links work once. Tap the button to get a new one."
              : "Links work once, and some email apps open them for you first. Ask the person who invited you to send a new one. If you already set a password, sign in instead."
          }
        </p>
        <div class="actions">
          ${
            recovery &&
            html`<button type="button" class="ask" onClick=${() => go("reset")}>
              SEND ME A NEW LINK
            </button>`
          }
          <button type="button" class=${recovery ? "secondary" : "ask"} onClick=${() => go("signin")}>
            SIGN IN
          </button>
        </div>
      </div>
    </div>`;
  }

  if (screen === "setpw") {
    const live = livePasswordHint(password, again);
    const blocked = busy || Boolean(passwordProblem(password, again));
    return html`<div class="view auth-gate">
      ${head}
      <form class="tile" onSubmit=${submit(() => !blocked && void setNewPassword())}>
        <div class="k">
          ${link?.type === "recovery" ? "Choose a new password" : "Choose your password"}
        </div>
        <p class="hint">
          ${MIN_PASSWORD} characters or more. You will use it with your email to sign in.
        </p>
        <div class="pin-form">
          <input
            type=${show ? "text" : "password"}
            aria-label="New password"
            placeholder="new password"
            autocomplete="new-password"
            enterkeyhint="next"
            value=${password}
            onInput=${(/** @type {any} */ e) => setPassword(e.currentTarget.value)}
          />
          <input
            type=${show ? "text" : "password"}
            aria-label="New password again"
            placeholder="the same password again"
            autocomplete="new-password"
            enterkeyhint="go"
            value=${again}
            onInput=${(/** @type {any} */ e) => setAgain(e.currentTarget.value)}
          />
        </div>
        ${showToggle}
        ${live && html`<p class="hint auth-live" role="status">${live}</p>`}
        ${errorNote}
        <div class="actions">
          <button type="submit" class="ask" disabled=${blocked}>
            ${busy ? "SAVING…" : "SET PASSWORD"}
          </button>
        </div>
        ${!link && html`<p class="hint">This page opens from the link in your invite or reset email.</p>`}
      </form>
      ${notice}
    </div>`;
  }

  if (screen === "reset") {
    const resting = restUntil > 0;
    return html`<div class="view auth-gate">
      ${head}
      <form class="tile" onSubmit=${submit(() => emailOk && !busy && !resting && void sendReset())}>
        <div class="k">Reset your password</div>
        <p class="hint">We email you a link. Open it on this phone to choose a new password.</p>
        <div class="pin-form">
          <input
            type="email"
            aria-label="Email"
            placeholder="email"
            autocomplete="email"
            inputmode="email"
            enterkeyhint="go"
            value=${email}
            onInput=${(/** @type {any} */ e) => setEmail(e.currentTarget.value)}
          />
        </div>
        ${sent && html`<p class="hint auth-sent" role="status">${sent}</p>`}
        ${errorNote}
        <div class="actions">
          <button type="submit" class="ask" disabled=${busy || !emailOk || resting}>
            ${busy ? "SENDING…" : "SEND RESET LINK"}
          </button>
        </div>
        <button type="button" class="linktext auth-link" onClick=${() => go("signin")}>
          Back to sign in
        </button>
      </form>
    </div>`;
  }

  return html`<div class="view auth-gate">
    ${head}
    <form class="tile" onSubmit=${submit(() => emailOk && password && !busy && void signIn())}>
      <div class="k">Sign in</div>
      <div class="pin-form">
        <input
          type="email"
          aria-label="Email"
          placeholder="email"
          autocomplete="username"
          inputmode="email"
          enterkeyhint="next"
          value=${email}
          onInput=${(/** @type {any} */ e) => setEmail(e.currentTarget.value)}
        />
        <input
          type=${show ? "text" : "password"}
          aria-label="Password"
          placeholder="password"
          autocomplete="current-password"
          enterkeyhint="go"
          value=${password}
          onInput=${(/** @type {any} */ e) => setPassword(e.currentTarget.value)}
        />
      </div>
      ${showToggle}
      <button type="button" class="linktext auth-link" onClick=${() => go("reset")}>
        Forgot password?
      </button>
      ${errorNote}
      <div class="actions">
        <button type="submit" class="ask" disabled=${busy || !emailOk || !password}>
          ${busy ? "SIGNING IN…" : "SIGN IN"}
        </button>
      </div>
      <p class="hint">
        New here? Open the invite email the admin sent you to set your password. Still stuck after
        a reset? Ask the person who invited you.
      </p>
    </form>
    ${notice}
  </div>`;
}

/**
 * The reset request's redirectTo: the page the app was opened on, without a
 * trailing index.html, so it is exactly the one URL on the project's redirect
 * allowlist (supabase/email-templates/README.md).
 * @param {string} origin @param {string} pathname
 */
export function resetRedirect(origin, pathname) {
  return `${origin}${String(pathname).replace(/index\.html$/, "")}`;
}

/**
 * The boot's entry point on a Supabase shell (main.js).
 * @param {{ start: "signin" | "setpw", reason?: string | null }} props
 */
export function AuthGateRoot({ start, reason = null }) {
  const spent = verifiedLinkFrom(location.hash);
  return html`<${AuthGateView}
    auth=${authClient()}
    start=${start}
    reason=${reason}
    link=${authLinkFrom(location.hash) ?? (spent && { type: spent.type, verified: true })}
    redirectTo=${resetRedirect(location.origin, location.pathname)}
  />`;
}
