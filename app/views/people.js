import { html } from "htm/preact";
import { useState } from "preact/hooks";
import { datesOfWeek } from "../lib/plan.js";
import { parseLocalIso } from "../lib/dates.js";

/**
 * PEOPLE (David, 2026-10-16): "instead of table call it people ... you should
 * have all the people that have profiles on here ... within a certain group
 * ... click on a profile and then link it to yourself, so like if you're
 * roommates ... this could also be where you could add guests to the meal ...
 * really it's just dinner, so there's seven options". Serves P8 (one pot,
 * everyone's own plate; a guest scales that day's batch, decision 0014) and
 * P3 (each person brings their own profile: the invite link is how a new
 * person fills one in on their own phone).
 *
 * Groups are households, the app's real "who lives together" field, named the
 * way the house is named. Your own house is first.
 * @param {{
 *   profiles: Record<string, any>[],
 *   me: string,
 *   todayIso: string,
 *   weekId: string,
 *   nextWeekId: string,
 *   kitchenMemberIds: string[],
 *   dinnerGuests: Record<string, string[]>,
 *   onAddToDinner?: (date: string, profileId: string) => Promise<{ note: string, retry: boolean }>,
 *   onRemoveFromDinner?: (date: string, profileId: string) => void,
 *   onLinkRoommate?: (profileId: string) => Promise<string>,
 *   onInviteLink?: (kind: "member" | "guest") => Promise<string>
 * }} props
 */
export function PeopleSection({
  profiles,
  me,
  todayIso,
  weekId,
  nextWeekId,
  kitchenMemberIds,
  dinnerGuests,
  onAddToDinner = undefined,
  onRemoveFromDinner = undefined,
  onLinkRoommate = undefined,
  onInviteLink = undefined,
}) {
  const [open, setOpen] = useState(/** @type {string | null} */ (null));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState(/** @type {string} */ (""));
  // the add that could not run its allergy check (D-01, 10/18): one tap redoes it
  const [retry, setRetry] = useState(/** @type {null | { id: string, dates: string[] }} */ (null));
  const myHouse = /** @type {string} */ (
    (profiles ?? []).find((p) => p.id === me)?.household ?? "home"
  );
  /** @type {Map<string, Record<string, any>[]>} */
  const groups = new Map();
  for (const p of profiles ?? []) {
    const h = /** @type {string} */ (p.household ?? "home");
    groups.set(h, [...(groups.get(h) ?? []), p]);
  }
  const order = [...groups.keys()].sort((a, b) =>
    a === myHouse ? -1 : b === myHouse ? 1 : a.localeCompare(b),
  );
  const houseName = (/** @type {string} */ h) =>
    h === myHouse ? `${h[0]?.toUpperCase() ?? ""}${h.slice(1)} · your kitchen` : `${h[0]?.toUpperCase() ?? ""}${h.slice(1)}`;
  // the next seven dinners from today: the rest of this week, then next week
  const days = [...datesOfWeek(weekId), ...datesOfWeek(nextWeekId)]
    .filter((d) => d >= todayIso)
    .slice(0, 7);
  const dayLabel = (/** @type {string} */ d) =>
    parseLocalIso(d).toLocaleDateString([], { weekday: "short", month: "numeric", day: "numeric" });
  const run = async (/** @type {() => Promise<string | null>} */ fn) => {
    setBusy(true);
    setNote("");
    setRetry(null);
    try {
      setNote((await fn()) ?? "");
    } catch (e) {
      setNote(e instanceof Error ? e.message : "that did not work");
    } finally {
      setBusy(false);
    }
  };
  // one at a time: each add runs the plate screen and its own write, and
  // says why if a dinner refuses them
  const seat = (/** @type {string} */ id, /** @type {string[]} */ dates) =>
    run(async () => {
      if (!onAddToDinner) return null;
      const notes = [];
      const again = [];
      for (const d of dates) {
        const r = await onAddToDinner(d, id);
        notes.push(r.note);
        if (r.retry) again.push(d);
      }
      if (again.length > 0) setRetry({ id, dates: again });
      return notes.filter(Boolean).join(" · ");
    });
  const share = async (/** @type {"member" | "guest"} */ kind) => {
    if (!onInviteLink) return;
    await run(async () => {
      const url = await onInviteLink(kind);
      setInvite(url);
      const nav = /** @type {any} */ (navigator);
      try {
        if (typeof nav.share === "function") {
          await nav.share({ title: "Join my Mise kitchen", url });
          return "link ready to send";
        }
        await nav.clipboard.writeText(url);
        return "link copied";
      } catch {
        return "copy the link below";
      }
    });
  };

  return html`
    <div class="people">
      ${order.map(
        (h) => html`
          <h2 class="block-title" key=${`h-${h}`}>${houseName(h)}</h2>
          <div class="slots" key=${`g-${h}`}>
            ${(groups.get(h) ?? []).map((p) => {
              const isMe = p.id === me;
              const inKitchen = kitchenMemberIds.includes(p.id);
              const isOpen = open === p.id;
              const seatedOn = days.filter((d) => (dinnerGuests[d] ?? []).includes(p.id));
              // the dinners they picked on their invite form (2026-10-18), still ahead and not seated
              const asked = /** @type {string[]} */ (
                Array.isArray(p.wantsDinners) ? p.wantsDinners : []
              ).filter((d) => days.includes(d) && !seatedOn.includes(d));
              // picked nights past the seven shown here: named, seatable once they come into view
              const askedLater = /** @type {string[]} */ (
                Array.isArray(p.wantsDinners) ? p.wantsDinners : []
              ).filter((d) => d > (days[days.length - 1] ?? ""));
              return html`
                <div class="tile person" key=${p.id}>
                  <button
                    class="personrow"
                    aria-expanded=${isOpen}
                    disabled=${isMe}
                    onClick=${() => {
                      setOpen(isOpen ? null : p.id);
                      setNote("");
                    }}
                  >
                    <span class="n">${p.emoji ?? ""} ${p.name ?? p.id}${isMe ? " (you)" : ""}</span>
                    <span class="hint">
                      ${
                        inKitchen
                          ? "eats from your kitchen"
                          : seatedOn.length > 0
                            ? `guest at dinner ${seatedOn.map(dayLabel).join(", ")}`
                            : asked.length > 0
                              ? `can come ${asked.map(dayLabel).join(", ")}`
                              : ""
                      }
                    </span>
                  </button>
                  ${
                    isOpen &&
                    html`<div class="personpanel">
                      ${
                        !inKitchen &&
                        onAddToDinner &&
                        html`<div class="sub">Add to a dinner</div>
                          <div class="chips wrapchips">
                            ${days.map((d) => {
                              const on = seatedOn.includes(d);
                              // the nights they asked for are marked, so the
                              // right chips are the obvious ones (shrike item 20)
                              const wanted = !on && asked.includes(d);
                              return html`<button
                                key=${d}
                                class=${on ? "chip on" : wanted ? "chip asked" : "chip"}
                                aria-pressed=${on}
                                aria-label=${`${dayLabel(d)}${on ? ", at this dinner" : wanted ? ", the night they asked for" : ""}`}
                                disabled=${busy}
                                onClick=${() =>
                                  on
                                    ? run(async () => {
                                        onRemoveFromDinner?.(d, p.id);
                                        return `${p.name ?? p.id} is off ${dayLabel(d)}'s dinner`;
                                      })
                                    : seat(p.id, [d])}
                              >
                                ${dayLabel(d)}${wanted ? " · asked" : ""}
                              </button>`;
                            })}
                          </div>
                          ${
                            asked.length > 0 &&
                            html`<div class="actions">
                              <button
                                class="secondary"
                                disabled=${busy}
                                onClick=${() => seat(p.id, asked)}
                              >
                                ADD THEM TO THEIR NIGHTS
                                <small>${asked.map(dayLabel).join(", ")}</small>
                              </button>
                            </div>`
                          }
                          ${
                            askedLater.length > 0 &&
                            html`<p class="hint">
                              Also asked for ${askedLater.map(dayLabel).join(", ")}; those show up
                              here once they are in the next seven days.
                            </p>`
                          }
                          <p class="hint">
                            Their plate comes from their own profile and the dinner is cooked
                            bigger by that much. Tap a day again to take them off.
                          </p>`
                      }
                      ${
                        !inKitchen &&
                        h !== myHouse &&
                        onLinkRoommate &&
                        html`<div class="actions">
                          <button
                            class="secondary"
                            disabled=${busy}
                            onClick=${() => run(() => onLinkRoommate(p.id))}
                          >
                            LINK AS ROOMMATE
                            <small>every shared meal, every day, from your kitchen</small>
                          </button>
                        </div>`
                      }
                      ${
                        inKitchen &&
                        html`<p class="hint">
                          Eats every shared meal from your kitchen. Change who is in the kitchen
                          with EDIT below.
                        </p>`
                      }
                      ${note && html`<p class="hint" role="status">${note}</p>`}
                      ${
                        retry &&
                        retry.id === p.id &&
                        html`<div class="actions">
                          <button
                            class="primary"
                            disabled=${busy}
                            onClick=${() => seat(p.id, retry.dates)}
                          >
                            TRY AGAIN
                            <small>${retry.dates.map(dayLabel).join(", ")}</small>
                          </button>
                        </div>`
                      }
                    </div>`
                  }
                </div>
              `;
            })}
          </div>
        `,
      )}
      ${
        onInviteLink &&
        html`<h2 class="block-title">Someone new</h2>
          <div class="actions">
            <button class="secondary" disabled=${busy} onClick=${() => share("member")}>
              INVITE A ROOMMATE
              <small>they fill in their own profile on their phone</small>
            </button>
            <button class="secondary" disabled=${busy} onClick=${() => share("guest")}>
              INVITE A GUEST
              <small>then add them to a dinner here</small>
            </button>
          </div>
          ${
            invite &&
            html`<div class="token-form">
              <input
                aria-label="Invite link"
                readonly
                value=${invite}
                onFocus=${(/** @type {any} */ e) => e.currentTarget.select()}
              />
            </div>`
          }
          ${!open && note && html`<p class="hint" role="status">${note}</p>`}
          <p class="hint">One person, one link, good for seven days.</p>`
      }
    </div>
  `;
}
