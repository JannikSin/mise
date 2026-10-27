import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { FREEZE_PATH, freezeRecord, isFrozen, moveOn } from "../lib/freeze.js";
import { formatSyncTime } from "../lib/dates.js";
import { read, write } from "../lib/store.js";
import { accountSource } from "../lib/session-boot.js";

// SETTINGS, YOUR ACCOUNT (Mise 2.0 D2; plan section 5 "Files that change",
// system.js: account, what this phone can see, freeze; P3 knows-you).
//
//  - YOUR ACCOUNT: who this phone is signed in as, which project, SIGN OUT.
//    Shown only on a Supabase build (an account exists only there).
//  - WHAT THIS PHONE CAN SEE: the houses whose files reach this phone, how
//    many people's plate cards, live guests, and the shared bank. It is read
//    from what the DATABASE returned to this phone (roster()), never from
//    what the phone assumes, so it is a check, not a promise. On a housemate's
//    phone it must say one house (plan section 6, the in-person steps).
//  - CHANGES THE SERVER REFUSED: each queued write the database would not
//    take (not allowed, or it would show a name to another house), with
//    DISCARD. A refused record no longer overrides what the phone reads.
//  - THE MOVE FREEZE: the admin's switch-morning control (lib/freeze.js).
//    Shown to the admin on either backend, because the freeze is taken on
//    the store the kitchen is LEAVING.
//
// The panel is pure: system.js hands it the facts and the two actions.

/**
 * What the roster returned to THIS phone says it can see. Rows are
 * roster() rows: { id, household, family, admin, roster: { guest? } }.
 * @param {{ id?: string, household?: string | null, roster?: Record<string, any> | null }[]} rows
 * @param {string} me the signed-in slug
 * @returns {{ houses: string[], plateCards: number, guests: number }}
 */
export function reachSummary(rows, me) {
  const list = Array.isArray(rows) ? rows : [];
  const houses = [
    ...new Set(
      list
        .map((r) => (typeof r?.household === "string" && r.household ? r.household : null))
        .filter((h) => h !== null),
    ),
  ].sort();
  const others = list.filter((r) => r?.id && r.id !== me);
  const guests = others.filter((r) => r?.roster?.guest === true || r?.household === "guesthouse");
  return {
    houses: /** @type {string[]} */ (houses),
    plateCards: others.length,
    guests: guests.length,
  };
}

/** the seam's REFUSED_REASON words (store.js), plus the held-account case */
const REASON_TEXT = /** @type {Record<string, string>} */ ({
  forbidden: "not allowed",
  name: "would show a name to another house",
  account: "made by another account",
});

/**
 * @param {{
 *   account: { email: string, slug: string, admin: boolean, project: "live" | "sandbox" } | null,
 *   reach: { houses: string[], plateCards: number, guests: number, bank: boolean } | null,
 *   freeze: { frozen: boolean, at: string, by: string } | null,
 *   refused?: { path: string, reason: string, at: number }[],
 *   onDiscard?: (path: string) => Promise<boolean>,
 *   showFreeze?: boolean,
 *   onSignOut?: () => void | Promise<void>,
 *   onFreeze?: (frozen: boolean) => Promise<void>,
 *   askConfirm?: (message: string) => Promise<boolean>,
 * }} props
 */
export function AccountPanel({
  account,
  reach,
  freeze,
  refused = [],
  onDiscard = undefined,
  showFreeze = undefined,
  onSignOut = undefined,
  onFreeze = undefined,
  askConfirm = async (m) => window.confirm(m),
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [armed, setArmed] = useState(false);
  const frozen = isFrozen(freeze);
  const canFreeze = (showFreeze ?? Boolean(account?.admin)) && typeof onFreeze === "function";

  const toggleFreeze = async (/** @type {boolean} */ next) => {
    if (!onFreeze) return;
    setBusy(true);
    setNote("");
    try {
      await onFreeze(next);
      setArmed(false);
      setNote(
        next
          ? "Frozen. Phones hold their changes until you unfreeze."
          : "Unfrozen. Phones send their held changes now.",
      );
    } catch (e) {
      setNote(e instanceof Error ? `Not saved: ${e.message}` : "Not saved. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return html`<section class="account-panel">
    ${
      account &&
      html`<div class="tile">
        <div class="k">Your account</div>
        <dl class="account-facts">
          <dt>Signed in as</dt>
          <dd>${account.email || "this phone's account"}</dd>
          <dt>Profile</dt>
          <dd>${account.slug}${account.admin ? " (admin)" : ""}</dd>
          <dt>Kitchen</dt>
          <dd>${account.project === "sandbox" ? "Mise NEXT (the test kitchen)" : "Mise"}</dd>
        </dl>
        ${
          onSignOut &&
          html`<div class="actions">
            <button
              class="secondary"
              disabled=${busy}
              onClick=${async () => {
              if (
                !(await askConfirm(
                  "Sign out of Mise on this phone? Changes not yet sent stay on the phone until you sign in again.",
                ))
              )
                return;
              await onSignOut();
            }}
            >
              SIGN OUT
            </button>
          </div>`
        }
      </div>`
    }
    ${
      reach &&
      html`<div class="tile">
        <div class="k">What this phone can see</div>
        <ul class="auth-points">
          <li>
            ${
              reach.houses.length === 0
                ? "No house's files."
                : reach.houses.length === 1
                  ? html`The files of one house: <b>${reach.houses[0]}</b>.`
                  : html`The files of ${reach.houses.length}
                    houses:${" "}<b>${reach.houses.join(", ")}</b>.`
            }
          </li>
          <li>
            ${
              reach.plateCards === 0
                ? "No one else's plate card."
                : `The plate cards of ${reach.plateCards} ${reach.plateCards === 1 ? "person" : "people"} you cook with${reach.guests > 0 ? `, ${reach.guests} of them ${reach.guests === 1 ? "a guest" : "guests"}` : ""}.`
            }
          </li>
          <li>
            Your own full
            profile${account?.admin ? ", and as admin, everyone's" : ", and no one else's"}.
          </li>
          ${reach.bank && html`<li>The shared recipe bank (no one's name is in it).</li>`}
        </ul>
        <p class="hint">This is what the database sent this phone, not what the phone assumes.</p>
      </div>`
    }
    ${
      refused.length > 0 &&
      html`<div class="tile warn">
        <div class="k">Changes the server refused</div>
        <p class="hint">
          These were saved on this phone but the kitchen's database would not take them. The phone
          now shows the server's copy. Discard each one once you have checked it.
        </p>
        <ul class="refused-list">
          ${refused.map(
            (r) =>
              html`<li key=${r.path} class="refused-row">
                <span class="refused-path num">${r.path}</span>
                <span class="refused-why">${REASON_TEXT[r.reason] ?? "not accepted"}</span>
                ${
                onDiscard &&
                html`<button
                  class="secondary"
                  disabled=${busy}
                  onClick=${async () => {
                  if (
                    !(await askConfirm(
                      `Discard your unsent change to ${r.path}? The server's copy stays.`,
                    ))
                  )
                    return;
                  setBusy(true);
                  try {
                    await onDiscard(r.path);
                  } finally {
                    setBusy(false);
                  }
                }}
                >
                  DISCARD
                </button>`
              }
              </li>`,
          )}
        </ul>
      </div>`
    }
    ${
      canFreeze &&
      html`<div class=${`tile${frozen ? " warn" : ""}`}>
        <div class="k">Move freeze</div>
        <p class="hint" role="status">
          ${
            frozen
              ? `Frozen since ${formatSyncTime(freeze?.at ?? "")}. Every phone holds its changes; nothing is sent to the old store.`
              : "Not frozen. On the move morning, freeze before the copy is taken, then wait 10 minutes."
          }
        </p>
        ${note && html`<p class="hint auth-note" role="status">${note}</p>`}
        <div class="actions">
          ${
            frozen
              ? html`<button
                  class="secondary"
                  disabled=${busy}
                  onClick=${() => toggleFreeze(false)}
                >
                  ${busy ? "SAVING…" : "UNFREEZE"}
                </button>`
              : armed
                ? html`<button class="ask" disabled=${busy} onClick=${() => toggleFreeze(true)}>
                      ${busy ? "SAVING…" : "YES, FREEZE NOW"}
                    </button>
                    <button class="secondary" disabled=${busy} onClick=${() => setArmed(false)}>
                      CANCEL
                    </button>`
                : html`<button class="secondary" onClick=${() => setArmed(true)}>
                    FREEZE FOR THE MOVE
                  </button>`
          }
        </div>
      </div>`
    }
  </section>`;
}

/**
 * The Settings section: loads the facts and renders AccountPanel. On the
 * GitHub backend (no account source) it renders NOTHING, unless the shell is
 * the switch morning's (freeze.js moveOn) and this is the admin: 1.95 exactly.
 * @param {{ me: string, isAdmin: boolean, askConfirm?: (m: string) => Promise<boolean> }} props
 */
export function AccountSection({ me, isAdmin, askConfirm = undefined }) {
  const src = accountSource();
  const [reach, setReach] = useState(
    /** @type {null | { houses: string[], plateCards: number, guests: number, bank: boolean }} */ (
      null
    ),
  );
  const [refused, setRefused] = useState(
    /** @type {{ path: string, reason: string, at: number }[]} */ ([]),
  );
  const [freeze, setFreeze] = useState(/** @type {any} */ (null));
  const [tick, setTick] = useState(0);
  const admin = src ? src.account.admin : isAdmin;
  // the freeze is the switch morning's, and only on a shell built for it
  const freezeShown = admin && moveOn();
  useEffect(() => {
    let alive = true;
    void (async () => {
      if (src) {
        const rows = await src.roster().catch(() => null);
        if (alive && rows) setReach({ ...reachSummary(rows, src.account.slug), bank: true });
        const ref = await src.refused().catch(() => []);
        if (alive) setRefused(ref);
      }
      if (freezeShown) {
        const f = await read(FREEZE_PATH, { raw: true }).catch(() => null);
        if (alive) setFreeze(f);
      }
    })();
    return () => {
      alive = false;
    };
  }, [tick, freezeShown]);
  if (!src && !freezeShown) return null;
  return html`<${AccountPanel}
    account=${src?.account ?? null}
    reach=${reach}
    freeze=${freeze}
    refused=${refused}
    showFreeze=${freezeShown}
    askConfirm=${askConfirm}
    onSignOut=${
      src
        ? async () => {
            await src.signOut();
            location.reload();
          }
        : undefined
    }
    onDiscard=${
      src
        ? async (/** @type {string} */ path) => {
            const ok = await src.discard(path);
            setTick((t) => t + 1);
            return ok;
          }
        : undefined
    }
    onFreeze=${async (/** @type {boolean} */ frozen) => {
      const rec = freezeRecord(frozen, src?.account.slug ?? me, new Date().toISOString());
      await write(FREEZE_PATH, rec, { raw: true });
      setFreeze(rec);
    }}
  />`;
}
