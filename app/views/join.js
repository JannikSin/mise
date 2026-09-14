import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { ProfileGateView } from "./profile-gate.js";
import { claimInvite, inviteStatus } from "../lib/worker.js";

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
 * @param {{ code: string, house?: string }} props
 */
export function JoinView({ code, house = "" }) {
  const [state, setState] = useState(
    /** @type {{ kind: "form" } | { kind: "busy" } | { kind: "done", id: string, name: string, house: string } | { kind: "error", message: string }} */ ({
      kind: "form",
    }),
  );
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
  return html`<${ProfileGateView}
    invite=${{ code, house }}
    busy=${state.kind === "busy"}
    onInviteSubmit=${async (
      /** @type {Record<string, any>} */ entry,
      /** @type {Record<string, any>} */ targets,
    ) => {
      setState({ kind: "busy" });
      try {
        const r = await claimInvite(code, entry, targets);
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
