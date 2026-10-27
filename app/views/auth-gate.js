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
 * @param {{ length: number, key(i: number): string | null, getItem(k: string): string | null } | null} storage
 */
export function hasPersistedSession(storage) {
  if (!storage) return false;
  try {
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i) ?? "";
      if (!/^sb-[a-z0-9]+-auth-token$/.test(k)) continue;
      const v = JSON.parse(storage.getItem(k) ?? "null");
      if (v && (typeof v.refresh_token === "string" || typeof v.access_token === "string"))
        return true;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Should the gate render instead of the app, and on which screen?
 * null = boot as before (always on the GitHub backend).
 * @param {{ backend: "github" | "supabase", hash: string, storage: any }} a
 * @returns {null | "setpw" | "signin"}
 */
export function authGateWanted(a) {
  if (a.backend !== "supabase") return null;
  if (authLinkFrom(a.hash)) return "setpw";
  // the token was spent on this phone, the password is not saved yet: back to
  // the password step while the session lasts, else sign in
  if (verifiedLinkFrom(a.hash)) return hasPersistedSession(a.storage) ? "setpw" : "signin";
  // guest pages are the Worker's name-and-passkey flow, not an account
  if (/^#\/(join|status|me)(\/|\?|$)/.test(String(a.hash ?? ""))) return null;
  return hasPersistedSession(a.storage) ? null : "signin";
}

/**
 * What is wrong with a new password, in plain words; "" when it is fine.
 * @param {string} pw
 * @param {string} again
 */
export function passwordProblem(pw, again) {
  if (pw.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (pw.trim() !== pw) return "Leave out spaces at the start and end.";
  if (pw !== again) return "The two passwords are not the same.";
  return "";
}

/**
 * A supabase-js error as one plain sentence. Never echoes the server's text,
 * which can name the account or the project.
 * @param {any} error
 * @param {"signin" | "link" | "password" | "reset"} where
 */
export function authErrorText(error, where) {
  const status = Number(error?.status ?? 0);
  const code = String(error?.code ?? "");
  const msg = String(error?.message ?? "");
  if (/fetch|network|offline/i.test(msg) || status === 0) {
    return "No signal. Signing in needs a connection the first time.";
  }
  if (
    status === 429 ||
    code === "over_request_rate_limit" ||
    code === "over_email_send_rate_limit"
  ) {
    return "Too many tries. Wait a few minutes, then try again.";
  }
  if (where === "signin") {
    if (code === "email_not_confirmed") return "Open the invite email first and set your password.";
    return "That email and password don't match. Check them, or reset your password below.";
  }
  if (where === "link") {
    return "This link has expired or was already used. Ask for a new one.";
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
 * @returns {Promise<{ verified: boolean, note: string, done: boolean }>}
 */
export async function setPasswordStep(a) {
  /** @param {Promise<any>} p */
  const settle = (p) =>
    p.catch((/** @type {any} */ e) => /** @type {{ data?: any, error?: any }} */ ({ error: e }));
  let verified = a.verified;
  if (!verified) {
    if (!a.link?.tokenHash) return { verified, note: authErrorText({ status: 400 }, "link"), done: false };
    // E6: the token is spent HERE, on the tap, never on page load
    const v = await settle(a.auth.verifyOtp({ token_hash: a.link.tokenHash, type: a.link.type }));
    if (v?.error || !v?.data?.session) {
      return { verified, note: authErrorText(v?.error ?? { status: 400 }, "link"), done: false };
    }
    verified = true;
    // the token is spent: out of the address bar and history NOW, not at the end
    a.replaceHash(verifiedHash(a.link.type));
  }
  const u = await settle(a.auth.updateUser({ password: a.password }));
  if (u?.error) {
    const t = authErrorText(u.error, "password");
    return {
      verified,
      note: /^No signal/.test(t) ? "No signal. You are still signed in on this phone. Try again." : t,
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
 * WHERE YOUR DATA LIVES. Plain words, no names (the code is public).
 * @param {{ onDone: () => void, again?: boolean }} props
 */
export function DataNotice({ onDone, again = false }) {
  return html`<div class="tile auth-notice">
    <div class="k">Where your data lives</div>
    <ul class="auth-points">
      <li>
        Your account and your Mise data are kept in a private database run for this kitchen by its
        admin, on Supabase, a hosted database service.
      </li>
      <li>
        <b>People you cook with see your plate card</b>: your diet, allergies, the foods and dishes
        you avoid, your meal times, and your calorie and protein targets. They need it to cook for
        you and keep a dish safe for you. Those numbers hint at your size and goals.
      </li>
      <li>
        <b>Only you and the admin see your full profile</b>: weight, height, age, goals,
        supplements, stores and anything else you enter about yourself.
      </li>
      <li>Your plans, shopping list and occasions are shared with your household.</li>
      <li>
        When you use a scan or ask a question, the photo or text goes to an AI service to be
        answered. Mise does not keep it unless you save the result.
      </li>
      <li>
        Ask the admin any time to export or delete your data. A guest's access ends when their
        host's invitation does.
      </li>
      <li>An allergy check helps; it does not replace reading the label.</li>
    </ul>
    <div class="actions">
      <button class="ask" onClick=${onDone}>${again ? "BACK" : "I UNDERSTAND"}</button>
    </div>
  </div>`;
}

/**
 * The gate. `start` is authGateWanted()'s answer; `auth` the client (null
 * means this build has no sign-in wired, said plainly rather than a blank).
 * @param {{
 *   auth: AuthLike | null,
 *   start: "signin" | "setpw",
 *   link?: { tokenHash?: string, type: "invite" | "recovery", verified?: boolean } | null,
 *   onSignedIn?: () => void,
 *   storage?: any,
 *   redirectTo?: string,
 *   replaceHash?: (hash: string) => void,
 * }} props
 */
export function AuthGateView({
  auth,
  start,
  link = null,
  onSignedIn = () => location.reload(),
  storage = safeStorage(),
  redirectTo = undefined,
  replaceHash = replaceHashInHistory,
}) {
  const [screen, setScreen] = useState(
    /** @type {"notice" | "signin" | "setpw" | "reset" | "done"} */ (
      noticeSeen(storage) ? start : "notice"
    ),
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [showNotice, setShowNotice] = useState(false);
  const [verified, setVerified] = useState(Boolean(link?.verified));

  const head = html`<div class="hero">
    <h1>Mise<span>.</span></h1>
    <div class="sub">
      ${
        start !== "setpw"
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
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const signIn = () =>
    run(async () => {
      const r = await auth
        .signInWithPassword({ email: email.trim(), password })
        .catch((/** @type {any} */ e) => /** @type {{ data?: any, error?: any }} */ ({ error: e }));
      if (r?.error || !r?.data?.session) {
        setPassword("");
        setNote(authErrorText(r?.error ?? {}, "signin"));
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
      setNote("If that email has an account, a reset link is on its way. It works once.");
    });

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const notice = html`<p class="hint">
    <button class="linktext" onClick=${() => setShowNotice(true)}>Where your data lives</button>
  </p>`;

  if (screen === "done") {
    return html`<div class="view auth-gate">
      ${head}
      <div class="tile">
        <div class="k">Password set</div>
        <p class="hint" role="status">
          You are signed in on this phone. Next time, sign in with your email and this password.
        </p>
        <div class="actions">
          <button class="ask" onClick=${onSignedIn}>OPEN MISE</button>
        </div>
      </div>
    </div>`;
  }

  if (screen === "setpw") {
    const problem = password || again ? passwordProblem(password, again) : "";
    return html`<div class="view auth-gate">
      ${head}
      <div class="tile">
        <div class="k">
          ${link?.type === "recovery" ? "Choose a new password" : "Choose your password"}
        </div>
        <p class="hint">
          At least ${MIN_PASSWORD} characters. You will use it with your email to sign in.
        </p>
        <div class="pin-form">
          <input
            type="password"
            aria-label="New password"
            placeholder="new password"
            autocomplete="new-password"
            value=${password}
            onInput=${(/** @type {any} */ e) => setPassword(e.currentTarget.value)}
          />
          <input
            type="password"
            aria-label="New password again"
            placeholder="the same password again"
            autocomplete="new-password"
            value=${again}
            onInput=${(/** @type {any} */ e) => setAgain(e.currentTarget.value)}
          />
        </div>
        ${problem && password.length > 0 && again.length > 0 && html`<p class="hint">${problem}</p>`}
        ${note && html`<p class="hint auth-note" role="alert">${note}</p>`}
        <div class="actions">
          <button
            class="ask"
            disabled=${busy || Boolean(passwordProblem(password, again))}
            onClick=${setNewPassword}
          >
            ${busy ? "SAVING…" : "SET PASSWORD"}
          </button>
        </div>
        ${!link && html`<p class="hint">This page opens from the link in your invite or reset email.</p>`}
      </div>
      ${notice}
    </div>`;
  }

  if (screen === "reset") {
    return html`<div class="view auth-gate">
      ${head}
      <div class="tile">
        <div class="k">Reset your password</div>
        <p class="hint">We email you a link. Open it on this phone to choose a new password.</p>
        <div class="pin-form">
          <input
            type="email"
            aria-label="Email"
            placeholder="email"
            autocomplete="email"
            inputmode="email"
            value=${email}
            onInput=${(/** @type {any} */ e) => setEmail(e.currentTarget.value)}
          />
        </div>
        ${note && html`<p class="hint auth-note" role="status">${note}</p>`}
        <div class="actions">
          <button class="ask" disabled=${busy || !emailOk} onClick=${sendReset}>
            ${busy ? "SENDING…" : "SEND RESET LINK"}
          </button>
          <button
            class="secondary"
            onClick=${() => {
              setNote("");
              setScreen("signin");
            }}
          >
            BACK
          </button>
        </div>
      </div>
    </div>`;
  }

  return html`<div class="view auth-gate">
    ${head}
    <div class="tile">
      <div class="k">Sign in</div>
      <div class="pin-form">
        <input
          type="email"
          aria-label="Email"
          placeholder="email"
          autocomplete="username"
          inputmode="email"
          value=${email}
          onInput=${(/** @type {any} */ e) => setEmail(e.currentTarget.value)}
        />
        <input
          type="password"
          aria-label="Password"
          placeholder="password"
          autocomplete="current-password"
          value=${password}
          onInput=${(/** @type {any} */ e) => setPassword(e.currentTarget.value)}
          onKeyDown=${(/** @type {any} */ e) => {
            if (e.key === "Enter" && emailOk && password && !busy) void signIn();
          }}
        />
      </div>
      ${note && html`<p class="hint auth-note" role="alert">${note}</p>`}
      <div class="actions">
        <button class="ask" disabled=${busy || !emailOk || !password} onClick=${signIn}>
          ${busy ? "SIGNING IN…" : "SIGN IN"}
        </button>
        <button
          class="secondary"
          onClick=${() => {
            setNote("");
            setScreen("reset");
          }}
        >
          FORGOT PASSWORD
        </button>
      </div>
      <p class="hint">New here? Open the invite email the admin sent you to set your password.</p>
    </div>
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
 * @param {{ start: "signin" | "setpw" }} props
 */
export function AuthGateRoot({ start }) {
  const spent = verifiedLinkFrom(location.hash);
  return html`<${AuthGateView}
    auth=${authClient()}
    start=${start}
    link=${authLinkFrom(location.hash) ?? (spent && { type: spent.type, verified: true })}
    redirectTo=${resetRedirect(location.origin, location.pathname)}
  />`;
}
