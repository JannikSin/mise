import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { ProfileGateView } from "./profile-gate.js";
import { claimInvite, guestLogin, guestMe, inviteStatus } from "../lib/worker.js";
import { localIsoDate, parseLocalIso } from "../lib/dates.js";

// JOIN BY LINK (guesthouse spec §8, David 2026-09-14: "more onboarding
// planning and implementation"). The host taps "invite by link" on a day's
// WHO row; the invitee opens the link on THEIR phone, fills the same
// questionnaire every profile fills, and the Worker writes the profile for
// them. No token ever leaves the host's device, the invitee's device never
// signs in, and the code in the link is single-use.
//
// After joining, the same code opens a read-only STATUS page: the upcoming
// meals they are seated at, with their plate. Nothing else on this device can
// read the kitchen's data, which is the point.

// The code is a bearer credential for one person's meal schedule, and on
// janniksin.github.io localStorage is shared with David's other apps, so it
// is NOT stored anywhere on the device: the link itself carries it, and a
// home-screen bookmark of the status page keeps the URL (security review
// 2026-09-14, M5).

/**
 * @param {{ code: string, house?: string, member?: boolean, onSignedIn?: (session: string) => void }} props
 */
export function JoinView({ code, house = "", member = false, onSignedIn = undefined }) {
  const [state, setState] = useState(
    /** @type {{ kind: "form" } | { kind: "busy" } | { kind: "done", id: string, name: string, house: string } | { kind: "error", message: string }} */ ({
      kind: "form",
    }),
  );
  // WHICH DINNERS CAN YOU MAKE (David, 2026-10-18: "just give me the form and
  // I'll give it to them"). The guest picks; the host seats them with one tap
  // on People, and that tap runs the allergy screen. Optional.
  const [dinners, setDinners] = useState(/** @type {string[]} */ ([]));
  // SIGN UP sets a login (v1.6, David 2026-10-18: "set your login name +
  // passkey"), so next time the guest types it instead of needing the link
  const [loginName, setLoginName] = useState("");
  const [pin, setPin] = useState("");
  const nextDinners = Array.from({ length: 14 }, (_, n) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return localIsoDate(d);
  });
  if (!code) {
    return html`<div class="view">
      <div class="hero">
        <h1>Mise<span>.</span></h1>
      </div>
      <p class="hint">This link is missing its code. Ask whoever invited you to send it again.</p>
    </div>`;
  }
  if (state.kind === "done") {
    return html`<div class="view">
      <div class="hero">
        <h1>Mise<span>.</span></h1>
        <div class="sub">you're in</div>
      </div>
      <div class="tile">
        <div class="k">${state.name}</div>
        <p class="hint">
          Your profile is saved and
          ${state.house === "guesthouse" ? "you can be seated at any table" : `you are a member of the ${state.house} kitchen`}.
          The cook sees your numbers and allergies the moment they add you to a meal.
          ${dinners.length > 0
            ? ` We told the cook you could come ${dinners.length} night${dinners.length === 1 ? "" : "s"}; they confirm it.`
            : ""}
        </p>
        <div class="actions">
          <a class="ask linkbtn" href=${`#/status?code=${encodeURIComponent(code)}`}>
            SEE MY UPCOMING MEALS
          </a>
        </div>
        <p class="hint">
          Add this page to your home screen: the same link shows your meals and your plate whenever
          you open it.
        </p>
      </div>
    </div>`;
  }
  if (state.kind === "error") {
    return html`<div class="view">
      <div class="hero">
        <h1>Mise<span>.</span></h1>
      </div>
      <div class="tile">
        <p class="hint scanerr">${state.message}</p>
        <div class="actions">
          <button class="secondary" onClick=${() => setState({ kind: "form" })}>TRY AGAIN</button>
        </div>
      </div>
    </div>`;
  }
  const loginTile = html`<div class="tile">
    <div class="k">Your login</div>
    <p class="hint">
      What you'll type next time to see your meals. A name only you would use, and 4 digits.
    </p>
    <div class="token-form">
      <input
        aria-label="Login name"
        placeholder="login name (e.g. Sam K)"
        autocomplete="username"
        value=${loginName}
        onInput=${(/** @type {any} */ e) => setLoginName(e.currentTarget.value)}
      />
      <input
        aria-label="4-digit passkey"
        placeholder="4-digit passkey"
        inputmode="numeric"
        maxlength="4"
        autocomplete="new-password"
        value=${pin}
        onInput=${(/** @type {any} */ e) => setPin(e.currentTarget.value.replace(/\D/g, "").slice(0, 4))}
      />
    </div>
  </div>`;
  const dinnerPicker = !member
      ? html`<div class="tile">
          <div class="k">Which dinners could you come to?</div>
          <div class="chips wrapchips" role="group" aria-label="Dinners you could come to">
            ${nextDinners.map((d) => {
              const on = dinners.includes(d);
              return html`<button
                key=${d}
                class=${on ? "chip on" : "chip"}
                aria-pressed=${on}
                onClick=${() => setDinners(on ? dinners.filter((x) => x !== d) : [...dinners, d])}
              >
                ${parseLocalIso(d).toLocaleDateString([], {
                  weekday: "short",
                  month: "numeric",
                  day: "numeric",
                })}
              </button>`;
            })}
          </div>
          <p class="hint">Optional. Tap every night that works, then fill in your profile below.</p>
        </div>`
      : null;
  return html`<${ProfileGateView}
    invite=${{ code, house: member ? house : "guesthouse" }}
    lead=${html`${loginTile}${dinnerPicker}`}
    busy=${state.kind === "busy"}
    onInviteSubmit=${async (
      /** @type {Record<string, any>} */ entry,
      /** @type {Record<string, any>} */ targets,
    ) => {
      if (loginName.trim().length < 2 || !/^\d{4}$/.test(pin)) {
        setState({ kind: "error", message: "Set a login name and a 4-digit passkey at the top first." });
        return;
      }
      setState({ kind: "busy" });
      try {
        const r = await claimInvite(code, entry, targets, dinners, { name: loginName.trim(), pin });
        if (r.session && onSignedIn) {
          onSignedIn(r.session);
          return;
        }
        setState({ kind: "done", id: r.id, name: r.name, house: r.house });
      } catch (e) {
        setState({ kind: "error", message: e instanceof Error ? e.message : "could not save" });
      }
    }}
  />`;
}

/**
 * @param {{ code: string }} props
 */
export function StatusView({ code }) {
  const [data, setData] = useState(
    /** @type {null | { state: string, name?: string, house?: string, rows?: { date: string, slot: string, dish: string, servings: number, plate: string[], cook: string }[], error?: string }} */ (
      null
    ),
  );
  useEffect(() => {
    let alive = true;
    if (!code) return;
    inviteStatus(code)
      .then((r) => alive && setData(r))
      .catch(
        (e) =>
          alive &&
          setData({ state: "error", error: e instanceof Error ? e.message : "could not load" }),
      );
    return () => {
      alive = false;
    };
  }, [code]);
  const day = (/** @type {string} */ iso) =>
    new Date(`${iso}T12:00:00`).toLocaleDateString([], {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  return html`<div class="view">
    <div class="hero">
      <h1>Mise<span>.</span></h1>
      <div class="sub">${data?.name ? `${data.name}'s meals` : "your meals"}</div>
    </div>
    ${!code && html`<p class="hint">This link is missing its code.</p>`}
    ${code && !data && html`<p class="hint">loading…</p>`}
    ${data?.state === "error" && html`<p class="hint scanerr">${data.error}</p>`}
    ${
      data?.state === "unclaimed" &&
      html`<div class="tile">
        <p class="hint">This invite has not been used yet.</p>
        <div class="actions">
          <a class="ask linkbtn" href=${`#/join?code=${encodeURIComponent(code)}`}
            >FILL IN MY PROFILE</a
          >
        </div>
      </div>`
    }
    ${
      data?.state === "claimed" &&
      html`<div>
        ${
          (data.rows ?? []).length === 0
            ? html`<p class="hint">
                Nothing on the calendar for you in the next two weeks yet. When
                ${data.house ?? "the kitchen"} seats you at a meal, it shows up here.
              </p>`
            : (data.rows ?? []).map(
                (r) =>
                  html`<div class="tile" key=${`${r.date}-${r.slot}`}>
                    <div class="row">
                      <span class="k">${day(r.date)} · ${r.slot}</span>
                      <span class="status">${r.cook ? `${r.cook} cooks` : ""}</span>
                    </div>
                    <div class="d">${r.dish}</div>
                    ${
                    r.plate.length > 0
                      ? r.plate.map(
                          (line, i) => html`<div class="serve-line" key=${i}>${line}</div>`,
                        )
                      : html`<div class="hint">
                          your plate: ${r.servings} serving${r.servings === 1 ? "" : "s"}
                        </div>`
                  }
                  </div>`,
              )
        }
        <p class="hint">Read-only, and only your own seats. Reload to refresh.</p>
      </div>`
    }
  </div>`;
}

// ---- the guest's side (v1.6, P8 + P3) ------------------------------------
// David, 2026-10-18: "Welcome to Mise ... LOG IN or SIGN UP ... even seeing
// other people's names isn't preferable." No screen here lists anyone. Once
// in, a guest sees only their own upcoming meals and those recipes; the host
// adds them to dinners from his own phone.

const dayLabel = (/** @type {string} */ iso) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

/**
 * @param {{ code: string, member?: boolean, onSignedIn: (session: string) => void }} props
 */
export function WelcomeView({ code, member = false, onSignedIn }) {
  const [mode, setMode] = useState(/** @type {"choose" | "login" | "signup"} */ ("choose"));
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  if (mode === "signup" && code) {
    return html`<${JoinView} code=${code} member=${member} onSignedIn=${onSignedIn} />`;
  }
  const logIn = async () => {
    setBusy(true);
    setNote("");
    try {
      const r = await guestLogin(name.trim(), pin);
      onSignedIn(r.session);
    } catch (e) {
      setNote(e instanceof Error ? e.message : "that did not work");
    } finally {
      setBusy(false);
    }
  };
  return html`<div class="view">
    <div class="hero">
      <h1>Mise<span>.</span></h1>
      <div class="sub">Welcome to Mise</div>
    </div>
    ${
      mode === "choose" &&
      html`<div class="tile">
        <p class="hint">
          ${code
            ? "This is a guest link. New here? Sign up once. Been here before? Log in."
            : "Log in with the name and passkey you set when you signed up."}
        </p>
        <div class="actions">
          <button class="ask" onClick=${() => setMode("login")}>LOG IN</button>
          ${code && html`<button class="secondary" onClick=${() => setMode("signup")}>SIGN UP</button>`}
        </div>
        ${!code && html`<p class="hint">To sign up, open the link your host sent you.</p>`}
      </div>`
    }
    ${
      mode === "login" &&
      html`<div class="tile">
        <div class="k">Log in</div>
        <div class="token-form">
          <input
            aria-label="Login name"
            placeholder="login name"
            autocomplete="username"
            value=${name}
            onInput=${(/** @type {any} */ e) => setName(e.currentTarget.value)}
          />
          <input
            aria-label="4-digit passkey"
            placeholder="4-digit passkey"
            type="password"
            inputmode="numeric"
            maxlength="4"
            autocomplete="current-password"
            value=${pin}
            onInput=${(/** @type {any} */ e) => setPin(e.currentTarget.value.replace(/\D/g, "").slice(0, 4))}
          />
        </div>
        <div class="actions">
          <button
            class="ask"
            disabled=${busy || name.trim().length < 2 || pin.length !== 4}
            onClick=${logIn}
          >
            ${busy ? "LOGGING IN…" : "LOG IN"}
          </button>
          <button class="secondary" onClick=${() => setMode("choose")}>BACK</button>
        </div>
        ${note && html`<p class="hint scanerr" role="status">${note}</p>`}
      </div>`
    }
  </div>`;
}

/**
 * @param {{ session: string, onSignOut: () => void }} props
 */
export function GuestHomeView({ session, onSignOut }) {
  const [data, setData] = useState(/** @type {null | Awaited<ReturnType<typeof guestMe>>} */ (null));
  const [error, setError] = useState("");
  const [open, setOpen] = useState(/** @type {string | null} */ (null));
  useEffect(() => {
    let alive = true;
    guestMe(session)
      .then((r) => alive && setData(r))
      .catch((e) => {
        if (!alive) return;
        const msg = e instanceof Error ? e.message : "could not load";
        // a removed login or an expired session goes back to Welcome
        if (/signed out/.test(msg)) onSignOut();
        else setError(msg);
      });
    return () => {
      alive = false;
    };
  }, [session]);
  return html`<div class="view">
    <div class="hero">
      <h1>Mise<span>.</span></h1>
      <div class="sub">${data?.name ? `${data.name}'s meals` : "your meals"}</div>
    </div>
    ${!data && !error && html`<p class="hint">loading…</p>`}
    ${error && html`<p class="hint scanerr">${error}</p>`}
    ${
      data &&
      (data.rows.length === 0
        ? html`<p class="hint">
            Nothing on the calendar for you yet. When your host adds you to a meal, it shows up
            here.
          </p>`
        : data.rows.map((r) => {
            const key = `${r.date}-${r.slot}`;
            const recipe = data.recipes?.[r.recipeId];
            const isOpen = open === key;
            return html`<div class="tile" key=${key}>
              <button
                class="personrow"
                aria-expanded=${isOpen}
                onClick=${() => setOpen(isOpen ? null : key)}
              >
                <span class="k">${dayLabel(r.date)} · ${r.slot}</span>
                <span class="status">${r.cook ? `${r.cook} cooks` : ""}</span>
              </button>
              <div class="d">${r.dish}</div>
              ${
                r.plate.length > 0
                  ? r.plate.map((line, i) => html`<div class="serve-line" key=${i}>${line}</div>`)
                  : html`<div class="hint">
                      your plate: ${r.servings} serving${r.servings === 1 ? "" : "s"}
                    </div>`
              }
              ${
                isOpen &&
                recipe &&
                html`<div class="personpanel">
                  <div class="sub">Ingredients (makes ${recipe.servings})</div>
                  ${recipe.ingredients.map(
                    (i, n) =>
                      html`<div class="hint" key=${n}>
                        ${i.qty ?? ""} ${i.unit} ${i.food}${i.note ? `, ${i.note}` : ""}
                      </div>`,
                  )}
                  <div class="sub">Steps</div>
                  ${recipe.steps.map((s, n) => html`<p class="hint" key=${n}>${n + 1}. ${s}</p>`)}
                </div>`
              }
              ${!recipe && html`<p class="hint">tap for the recipe when your host has one in Mise</p>`}
            </div>`;
          }))
    }
    <div class="actions">
      <button class="secondary" onClick=${onSignOut}>SIGN OUT</button>
    </div>
    <p class="hint">Only your own meals. Reload to refresh.</p>
  </div>`;
}
