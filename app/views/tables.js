import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { recipesById, SLOT_KEYS, SLOT_META } from "../lib/plan.js";
import { parseLocalIso } from "../lib/dates.js";
import { SERVINGS_MIN, SERVINGS_MAX } from "../lib/tables.js";
import { CheckInView } from "./checkin.js";

const SLOTS = SLOT_KEYS.map((key) => ({ key, ...(SLOT_META[key] ?? { label: key, full: key }) }));

/**
 * Tables tab: every shared meal I'm part of, managed in one place (moved off
 * the top of Plan, where a mid-week table used to hijack the feed). Lists
 * today-onward tables across every relevant house, hosts the create form and
 * the AI plate-tailoring. Plan keeps only the read-only derived entries in
 * its day grid. This tab is the seed of the future group tab.
 * @param {{
 *   houseEvents: { house: string, events: import("../lib/tables.js").HouseEvents }[],
 *   profiles: Record<string, any>[],
 *   me: string,
 *   todayIso: string,
 *   hasToken: boolean,
 *   repo: Record<string, any> | null,
 *   tableConflicts: { table: import("../lib/tables.js").TableEvent, reasons: string[] }[],
 *   tableCollisions: import("../lib/tables.js").TableEvent[],
 *   bankRecipes: Record<string, any>[],
 *   onCreateTable: (t: { name: string, date: string, slot: string, recipeId: string, seats: import("../lib/tables.js").Seat[] }) => void,
 *   onRemoveTable: (house: string, id: string) => void,
 *   onSetBuyer?: (house: string, tableId: string, buyerId: string | null) => void,
 *   onPatchSeat: (house: string, tableId: string, patch: Partial<import("../lib/tables.js").Seat>) => void,
 *   onSeatScreen: (recipeId: string) => Promise<Record<string, string[]>>,
 *   onTailorTable: (house: string, tableId: string) => Promise<void>,
 *   scoreboard: { id: string, name: string, emoji: string, score: number, cooked: { done: number, total: number }, logged: { done: number, total: number }, shopped: boolean }[],
 *   weekId: string,
 *   onCreateBrigade: (b: { name: string, memberIds: string[], slots: string[], cookId?: string, from: string, until: string }) => void,
 *   onRemoveBrigade: (id: string) => void,
 *   onRunBrigade: (id: string, week: string, regenerate?: boolean) => Promise<{ made: number, thin: { slot: string, available: number }[] }>,
 *   checkIn: Record<string, any>,
 *   showCheckIn?: boolean,
 *   showScoreboard?: boolean
 * }} props
 */
export function TablesView({
  houseEvents,
  profiles,
  me,
  todayIso,
  hasToken,
  repo,
  tableConflicts,
  tableCollisions,
  bankRecipes,
  onCreateTable,
  onRemoveTable,
  onSetBuyer = undefined,
  onPatchSeat,
  onSeatScreen,
  onTailorTable,
  scoreboard,
  weekId,
  onCreateBrigade,
  onRemoveBrigade,
  onRunBrigade,
  checkIn,
  showCheckIn = true,
  showScoreboard = true,
}) {
  const byId = recipesById(bankRecipes ?? []);
  const myHouse = /** @type {string} */ (
    (profiles ?? []).find((p) => p.id === me)?.household ?? "home"
  );
  // every upcoming table relevant to me: I'm seated, or it's at my house.
  // Past tables are the money ledger's business, not this list's.
  const myTables = (houseEvents ?? [])
    .flatMap(({ house, events }) =>
      events.tables
        .filter(
          (t) =>
            typeof t.date === "string" &&
            t.date >= todayIso &&
            (house === myHouse || (t.seats ?? []).some((s) => s.id === me)),
        )
        .map((t) => ({ house, t })),
    )
    .sort((a, b) => a.t.date.localeCompare(b.t.date) || a.t.slot.localeCompare(b.t.slot));
  const conflictIds = new Set((tableConflicts ?? []).map((c) => c.table.id));
  const collisionIds = new Set((tableCollisions ?? []).map((t) => t.id));
  const nameOf = (/** @type {string} */ id) =>
    (profiles ?? []).find((p) => p.id === id)?.name ?? id;
  const tokenBlocked = !hasToken || repo?.auth === "invalid";

  // AI plate-tailoring per table: busy flag + last error, keyed by table id
  const [tailorBusy, setTailorBusy] = useState(/** @type {string | null} */ (null));
  const [tailorErr, setTailorErr] = useState(/** @type {Record<string, string>} */ ({}));
  const runTailor = async (/** @type {string} */ house, /** @type {string} */ tableId) => {
    if (tailorBusy) return;
    setTailorBusy(tableId);
    setTailorErr({ ...tailorErr, [tableId]: "" });
    try {
      await onTailorTable(house, tableId);
    } catch (err) {
      setTailorErr({
        ...tailorErr,
        [tableId]: err instanceof Error ? err.message : "tailoring failed — try again",
      });
    }
    setTailorBusy(null);
  };

  // BRIGADE state. A brigade is a standing table: people who live together
  // and eat the same meals. Only same-house profiles can be members, which is
  // enforced in the lib as well — this just keeps the picker honest.
  const houseMates = (profiles ?? []).filter((p) => (p.household ?? "home") === myHouse);
  const myBrigades = (houseEvents ?? []).find((h) => h.house === myHouse)?.events?.brigades ?? [];
  const [brigadeForm, setBrigadeForm] = useState(
    /** @type {null | { name: string, memberIds: string[], slots: string[], cookId: string, rotateCooks: boolean, from: string, until: string }} */ (
      null
    ),
  );
  const [brigadeBusy, setBrigadeBusy] = useState(/** @type {string | null} */ (null));
  const [brigadeNote, setBrigadeNote] = useState(/** @type {string} */ (""));

  const openBrigadeForm = () => {
    const until = new Date(`${todayIso}T12:00:00`);
    until.setDate(until.getDate() + 27); // the lib caps a brigade at four weeks
    setBrigadeForm({
      name: "",
      memberIds: houseMates.filter((p) => p.id === me).map((p) => p.id),
      slots: ["dinner"],
      cookId: me,
      rotateCooks: false,
      from: todayIso,
      until: until.toISOString().slice(0, 10),
    });
    setBrigadeNote("");
  };

  const toggleIn = (/** @type {string[]} */ list, /** @type {string} */ value) =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  const submitBrigade = () => {
    if (!brigadeForm) return;
    if (brigadeForm.memberIds.length < 2) {
      setBrigadeNote("Standing dinners need at least two people — that is what makes them shared.");
      return;
    }
    if (brigadeForm.slots.length === 0) {
      setBrigadeNote("Pick at least one meal to share.");
      return;
    }
    // members stored in the picker's display order, so the rotation cycles
    // exactly the way the chip row reads — toggling someone off and on can't
    // silently reshuffle who cooks which night
    const orderedMembers = houseMates
      .map((p) => p.id)
      .filter((id) => brigadeForm.memberIds.includes(id));
    onCreateBrigade({
      name: brigadeForm.name.trim() || "Brigade",
      memberIds: orderedMembers,
      slots: brigadeForm.slots,
      cookId: orderedMembers.includes(brigadeForm.cookId) ? brigadeForm.cookId : orderedMembers[0],
      ...(brigadeForm.rotateCooks ? { rotateCooks: true } : {}),
      from: brigadeForm.from,
      until: brigadeForm.until,
    });
    setBrigadeForm(null);
  };

  const runBrigade = async (/** @type {string} */ id, /** @type {boolean} */ regenerate) => {
    setBrigadeBusy(id);
    setBrigadeNote("");
    try {
      const { made, thin, outOfRange, from, until } = /** @type {any} */ (
        await onRunBrigade(id, weekId, regenerate)
      );
      const short = thin
        .filter((/** @type {any} */ t) => t.available === 0)
        .map((/** @type {any} */ t) => t.slot);
      const tight = thin.filter((/** @type {any} */ t) => t.available > 0);
      setBrigadeNote(
        outOfRange
          ? `This brigade runs ${from} to ${until}, and the Plan tab is on a different week. Flip Plan to that week, then SET THIS WEEK — nothing was set just now.`
          : short.length > 0
            ? `No ${short.join(" or ")} works for everyone in this brigade. Nothing was set. Widen the bank or check the avoid lists.`
            : tight.length > 0
              ? `Set ${made} ${made === 1 ? "meal" : "meals"}. Only ${tight
                  .map(
                    (/** @type {any} */ t) =>
                      `${t.available} ${t.slot} ${t.available === 1 ? "recipe" : "recipes"}`,
                  )
                  .join(", ")} suit everyone, so the week repeats itself.`
              : made > 0
                ? `Set ${made} ${made === 1 ? "meal" : "meals"} for this week.`
                : "This week is already set. Use PICK DIFFERENT MEALS to change it.",
      );
    } catch {
      setBrigadeNote("Could not set the week. Check the connection and try again.");
    }
    setBrigadeBusy(null);
  };

  // CREATE TABLE form state
  const [tableForm, setTableForm] = useState(
    /** @type {null | { name: string, date: string, slot: string, recipeId: string, seats: Record<string, { in: boolean, servings: number }> }} */ (
      null
    ),
  );
  const [seatWarnings, setSeatWarnings] = useState(/** @type {Record<string, string[]>} */ ({}));
  const openTableForm = () => {
    /** @type {Record<string, { in: boolean, servings: number }>} */
    const seats = {};
    for (const p of profiles ?? []) seats[p.id] = { in: p.id === me, servings: 1 };
    const bank = bankRecipes ?? [];
    const firstDinner = bank.find((r) => r.mealType === "dinner");
    setSeatWarnings({});
    setTableForm({
      name: "",
      date: todayIso,
      slot: "dinner",
      recipeId: firstDinner?.id ?? bank[0]?.id ?? "",
      seats,
    });
  };
  useEffect(() => {
    if (!tableForm?.recipeId) return;
    setSeatWarnings({});
    void onSeatScreen(tableForm.recipeId).then(setSeatWarnings);
  }, [tableForm?.recipeId]);
  const submitTable = () => {
    if (!tableForm || !tableForm.recipeId || !tableForm.date) return;
    if (tableForm.date < todayIso) return; // past tables can't be set
    const seats = Object.entries(tableForm.seats)
      .filter(([, v]) => v.in)
      .map(([id, v]) => ({ id, servings: v.servings }));
    if (seats.length === 0) return;
    onCreateTable({
      name: tableForm.name.trim() || "Table",
      date: tableForm.date,
      slot: tableForm.slot,
      recipeId: tableForm.recipeId,
      seats,
    });
    setTableForm(null);
  };

  // the family dinners, hoisted so they render at the TOP of the page
  const dinnerBlock = html`
    ${
      tokenBlocked &&
      myTables.length > 0 &&
      html`<p class="hint">
        ✨ plate tailoring needs the token —
        ${repo?.auth === "invalid" ? "renew it in Settings" : "connect it in Settings"}
      </p>`
    }
    ${
      myTables.length === 0 &&
      !tableForm &&
      html`<p class="hint">
        no upcoming tables — set one below, or talk it out on
        <a href="#/dinner">tonight's dinner</a>.
      </p>`
    }
    ${myTables.map(({ house, t }) => {
      const mySeat = (t.seats ?? []).find((s) => s.id === me);
      const skipped = mySeat?.status === "skipped";
      const conflicted = conflictIds.has(t.id);
      return html`
        <div class="tile tablecard ${skipped ? "skipped" : ""}" key=${t.id}>
          <div class="k">
            🍽 ${t.name} ·
            ${`${parseLocalIso(t.date).toLocaleDateString([], {
              weekday: "short",
              month: "short",
              day: "numeric",
            })} ${SLOT_META[t.slot]?.label ?? t.slot}`}
            · ${byId.get(t.recipeId)?.name ?? t.recipeId}
            ${house !== myHouse && html` · at ${house}`}
          </div>
          ${
            t.cookId &&
            html`<div class="d">
              👨‍🍳 <strong>${nameOf(t.cookId)}${t.cookId === me ? " (you)" : ""}</strong> cooks
            </div>`
          }
          ${
            // GROCERY CLAIM: cooking and buying are separate jobs now.
            // Nobody's list carries this dinner until someone claims it.
            t.buyerId
              ? html`<div class="d">
                  🛒 <strong>${nameOf(t.buyerId)}${t.buyerId === me ? " (you)" : ""}</strong>
                  buys the groceries
                </div>`
              : html`<div class="d hint">🛒 nobody has claimed the groceries yet</div>`
          }
          <div class="d num">
            ${(t.seats ?? [])
              .map((s) => `${nameOf(s.id)} ×${s.servings}${s.status === "skipped" ? " (out)" : ""}`)
              .join(" · ")}
            · cook total
            ×${(t.seats ?? [])
              .filter((s) => s.status !== "skipped")
              .reduce((sum, s) => sum + (Number(s.servings) || 0), 0)}
          </div>
          ${
            conflicted &&
            html`<div class="d num redflag">
              ⚠ conflicts with your diet list — not added to your plan
            </div>`
          }
          ${
            collisionIds.has(t.id) &&
            html`<div class="d num redflag">
              your ${SLOT_META[t.slot]?.full ?? t.slot} that day is pinned or marked OUT — unpin or
              clear it to sit at this table
            </div>`
          }
          ${
            t.tailor &&
            html`<div class="d" role="status">
              ${Object.entries(t.tailor.seats ?? {}).map(
                  ([sid, notes]) => html`
                    <div class="d" key=${sid}>
                      ✨ ${nameOf(sid)}: ${notes.plate.join(" · ")}
                      <span class="num"> · ~${notes.estCalories} kcal · ${notes.estProtein}P</span>
                    </div>
                  `,
                )}
              ${(t.tailor.cook ?? []).map(
                  (/** @type {string} */ c) => html`<div class="hint" key=${c}>👨‍🍳 ${c}</div>`,
                )}
            </div>`
          }
          ${
            tailorErr[t.id] &&
            html`<div class="d num redflag" role="status">${tailorErr[t.id]}</div>`
          }
          <div class="actions wrap">
            ${
              mySeat &&
              html`<button
                class="secondary"
                disabled=${
                    tailorBusy === t.id ||
                    tokenBlocked ||
                    (t.seats ?? []).every((s) => s.status === "skipped")
                  }
                onClick=${() => runTailor(house, t.id)}
              >
                ${
                    tailorBusy === t.id
                      ? "TAILORING…"
                      : t.tailor
                        ? "✨ RE-TAILOR"
                        : "✨ TAILOR PLATES"
                  }
              </button>`
            }
            ${
              house === myHouse &&
              !t.buyerId &&
              onSetBuyer &&
              html`<button class="primary" onClick=${() => onSetBuyer(house, t.id, me)}>
                🛒 I'LL BUY THIS
              </button>`
            }
            ${
              t.buyerId === me &&
              onSetBuyer &&
              html`<button class="secondary" onClick=${() => onSetBuyer(house, t.id, null)}>
                RELEASE — NOT BUYING
              </button>`
            }
            ${
              mySeat &&
              html`<button
                class="secondary"
                onClick=${() => onPatchSeat(house, t.id, { status: skipped ? "in" : "skipped" })}
              >
                ${skipped ? "REJOIN" : "SKIP MINE"}
              </button>`
            }
            ${
              house === myHouse &&
              html`<button class="secondary" onClick=${() => onRemoveTable(house, t.id)}>
                CANCEL TABLE
              </button>`
            }
          </div>
        </div>
      `;
    })}
  `;

  return html`
    <div class="view">
      <div class="hero">
        <h1>Today<span>.</span></h1>
        <div class="sub">what's for dinner, who's cooking</div>
      </div>

      <h2 class="block-title">Family dinners</h2>
      <p class="hint">
        every shared meal coming up, with the cook named. One pot, everyone's own portion; money
        from finished dinners settles on the List tab.
      </p>
      ${dinnerBlock}
      ${
        // the morning check-in and the household scoreboard sit BELOW the
        // dinners (David, 2026-08-03: the page opens on the family meals) and
        // render only for profiles whose capabilities include them — the
        // family default is the dinners and nothing else
        showCheckIn && html`<${CheckInView} ...${checkIn} />`
      }
      ${
        // the household competition: same yardstick for everyone (cooked
        // confirmations, receipt, daily logs), numbers not judgment
        showScoreboard &&
        (scoreboard ?? []).length > 0 &&
        html`<div class="tile">
          <div class="k">🏆 THIS WEEK · household scoreboard</div>
          ${scoreboard.map(
            (r, i) => html`
              <div class="d num" key=${r.id}>
                ${i === 0 && r.score > 0 ? "👑" : `${i + 1}.`} ${r.emoji} ${r.name}
                <b> ${r.score}</b> · cooked ${r.cooked.done}/${r.cooked.total} · logged${" "}
                ${r.logged.done}/${r.logged.total} · ${r.shopped ? "🧾 shopped" : "no receipt yet"}
              </div>
            `,
          )}
          <div class="hint">
            score = 50% meals confirmed cooked + 30% daily logs + 20% receipt scanned, over days
            already finished. Tap COOKED after cooking and it climbs.
          </div>
        </div>`
      }
      ${
        !tableForm
          ? html`<div class="actions">
              <button class="secondary" onClick=${openTableForm}>+ SET A TABLE</button>
            </div>`
          : html`<div class="tile tableform">
              <div class="k">Set a table</div>
              <input
                aria-label="Table name"
                placeholder="e.g. family dinner"
                value=${tableForm.name}
                onInput=${(/** @type {any} */ e) =>
                  setTableForm({ ...tableForm, name: e.currentTarget.value })}
              />
              <div class="row">
                <input
                  type="date"
                  aria-label="Day"
                  min=${todayIso}
                  max=${`${Number(todayIso.slice(0, 4)) + 1}${todayIso.slice(4)}`}
                  value=${tableForm.date}
                  onInput=${(/** @type {any} */ e) =>
                    setTableForm({ ...tableForm, date: e.currentTarget.value })}
                />
                <select
                  aria-label="Meal slot"
                  value=${tableForm.slot}
                  onInput=${(/** @type {any} */ e) =>
                    setTableForm({ ...tableForm, slot: e.currentTarget.value })}
                >
                  ${SLOTS.map(({ key, full }) => html`<option value=${key}>${full}</option>`)}
                </select>
              </div>
              <select
                aria-label="Recipe everyone shares"
                value=${tableForm.recipeId}
                onInput=${(/** @type {any} */ e) =>
                  setTableForm({ ...tableForm, recipeId: e.currentTarget.value })}
              >
                ${
                  /* bank only: a table on someone's personal recipe variant
                     has no honest macros for the other seats */
                  (bankRecipes ?? []).map((r) => html`<option value=${r.id}>${r.name}</option>`)
                }
              </select>
              ${(profiles ?? []).map((p) => {
                const seat = tableForm.seats[p.id] ?? { in: false, servings: 1 };
                const warns = seatWarnings[p.id] ?? [];
                return html`
                  <div class="row" key=${p.id}>
                    <label class="tickarea">
                      <input
                        type="checkbox"
                        checked=${seat.in}
                        onInput=${(/** @type {any} */ e) =>
                          setTableForm({
                            ...tableForm,
                            seats: {
                              ...tableForm.seats,
                              [p.id]: { ...seat, in: e.currentTarget.checked },
                            },
                          })}
                      />
                      ${p.emoji ?? ""} ${p.name ?? p.id}
                      ${
                        seat.in &&
                        warns.length > 0 &&
                        html`<span class="usesoon">⚠ ${warns.join(", ")}</span>`
                      }
                    </label>
                    ${
                      seat.in &&
                      html`<input
                          class="num seatservings"
                          type="number"
                          min=${SERVINGS_MIN}
                          max=${SERVINGS_MAX}
                          step="0.5"
                          aria-label="Servings for ${p.name ?? p.id}"
                          value=${seat.servings}
                          onInput=${(/** @type {any} */ e) =>
                            setTableForm({
                              ...tableForm,
                              seats: {
                                ...tableForm.seats,
                                [p.id]: { ...seat, servings: Number(e.currentTarget.value) || 1 },
                              },
                            })}
                        /><span class="hint num">servings</span>`
                    }
                  </div>
                `;
              })}
              <div class="actions">
                <button class="secondary" onClick=${() => setTableForm(null)}>CANCEL</button>
                <button class="primary" onClick=${submitTable}>SET TABLE</button>
              </div>
            </div>`
      }
      ${
        // the block explains itself only when it has content or is being
        // created — an empty jargon heading taught nothing (council 2026-08-02)
        (myBrigades.length > 0 || brigadeForm) &&
        html`<h2 class="block-title">Who cooks (standing dinners)</h2>
          <p class="hint">
            Two or more people in this house eating the same meals, each at their own portion. Set
            it once, then run it every week.
          </p>`
      }
      ${myBrigades.map((b) => {
        const names = b.memberIds.map((id) => {
          const p = (profiles ?? []).find((x) => x.id === id);
          return `${p?.emoji ?? ""} ${p?.name ?? id}`.trim();
        });
        const cook = (profiles ?? []).find((p) => p.id === b.cookId);
        // the next few nights' cooks, so "take turns" is a schedule someone
        // can actually read, not a mystery (Tribunal U1). Same date-offset
        // rule materializeBrigade uses.
        const rotation = [];
        if (b.rotateCooks && b.memberIds.length > 0) {
          const start = new Date(`${todayIso}T12:00:00`); // noon: UTC slice can't day-shift
          for (let i = 0; i < 7 && rotation.length < 4; i++) {
            const d = new Date(start);
            d.setDate(d.getDate() + i);
            const iso = d.toISOString().slice(0, 10);
            if (iso < b.from || iso > b.until) continue;
            const off = Math.round((Date.parse(iso) - Date.parse(b.from)) / 86400000);
            const id =
              b.memberIds[((off % b.memberIds.length) + b.memberIds.length) % b.memberIds.length];
            const p = (profiles ?? []).find((x) => x.id === id);
            rotation.push(
              `${d.toLocaleDateString([], { weekday: "short" })} ${p?.name ?? id}${id === me ? " (you)" : ""}`,
            );
          }
        }
        return html`
          <div class="tile" key=${b.id}>
            <div class="k">${b.name}</div>
            <div class="sub">${names.join(" · ")}</div>
            <div class="sub">
              ${b.slots.map((s) => SLOT_META[s]?.full ?? s).join(", ")} · through
              ${" "}${parseLocalIso(b.until).toLocaleDateString([], { month: "short", day: "numeric" })}
              ${
                b.rotateCooks
                  ? html` · cooks take turns`
                  : cook
                    ? html` · ${cook.name ?? cook.id} shops`
                    : ""
              }
            </div>
            <div class="sub">${rotation.length > 0 && html`👨‍🍳 ${rotation.join(" · ")}`}</div>
            <div class="actions">
              <button
                class="primary"
                disabled=${brigadeBusy === b.id}
                onClick=${() => runBrigade(b.id, false)}
              >
                ${brigadeBusy === b.id ? "SETTING…" : "SET THIS WEEK"}
              </button>
              <button
                class="secondary"
                disabled=${brigadeBusy === b.id}
                onClick=${() => runBrigade(b.id, true)}
              >
                PICK DIFFERENT MEALS
              </button>
              <button class="secondary" onClick=${() => onRemoveBrigade(b.id)}>END</button>
            </div>
          </div>
        `;
      })}
      ${brigadeNote && html`<p class="hint" role="status">${brigadeNote}</p>`}
      ${
        !brigadeForm
          ? html`<div class="actions">
              <button class="secondary" onClick=${openBrigadeForm}>
                + SET WHO COOKS (standing dinners)
              </button>
            </div>`
          : html`<div class="tile tableform">
              <div class="k">Set who cooks</div>
              <input
                aria-label="Brigade name"
                placeholder="e.g. Mom + Laurie"
                value=${brigadeForm.name}
                onInput=${(/** @type {any} */ e) =>
                  setBrigadeForm({ ...brigadeForm, name: e.currentTarget.value })}
              />
              <div class="sub">Who is in it</div>
              <div class="chips">
                ${houseMates.map(
                  (p) => html`
                    <button
                      key=${p.id}
                      class=${brigadeForm.memberIds.includes(p.id) ? "chip on" : "chip"}
                      aria-pressed=${brigadeForm.memberIds.includes(p.id)}
                      onClick=${() =>
                        setBrigadeForm({
                          ...brigadeForm,
                          memberIds: toggleIn(brigadeForm.memberIds, p.id),
                        })}
                    >
                      ${p.emoji ?? ""} ${p.name ?? p.id}
                    </button>
                  `,
                )}
              </div>
              <div class="sub">Which meals they share</div>
              <div class="chips">
                ${SLOTS.map(
                  (s) => html`
                    <button
                      key=${s.key}
                      class=${brigadeForm.slots.includes(s.key) ? "chip on" : "chip"}
                      aria-pressed=${brigadeForm.slots.includes(s.key)}
                      onClick=${() =>
                        setBrigadeForm({
                          ...brigadeForm,
                          slots: toggleIn(brigadeForm.slots, s.key),
                        })}
                    >
                      ${s.full}
                    </button>
                  `,
                )}
              </div>
              <div class="sub">Who cooks and shops</div>
              <div class="chips">
                <button
                  class=${brigadeForm.rotateCooks ? "chip on" : "chip"}
                  aria-pressed=${brigadeForm.rotateCooks}
                  onClick=${() =>
                    setBrigadeForm({ ...brigadeForm, rotateCooks: !brigadeForm.rotateCooks })}
                >
                  🔄 take turns
                </button>
              </div>
              ${
                brigadeForm.rotateCooks
                  ? html`<p class="hint">
                      The cook rotates day by day in the order people are listed above — with four
                      people over a week, everyone cooks one or two dinners and shops for their own
                      nights (the FAMILY list still merges it into one trip).
                    </p>`
                  : html`<select
                      aria-label="Cook"
                      value=${brigadeForm.cookId}
                      onChange=${(/** @type {any} */ e) =>
                        setBrigadeForm({ ...brigadeForm, cookId: e.currentTarget.value })}
                    >
                      ${brigadeForm.memberIds.map((id) => {
                        const p = (profiles ?? []).find((x) => x.id === id);
                        return html`<option key=${id} value=${id}>${p?.name ?? id}</option>`;
                      })}
                    </select>`
              }
              <div class="row">
                <input
                  type="date"
                  aria-label="Starts"
                  min=${todayIso}
                  value=${brigadeForm.from}
                  onInput=${(/** @type {any} */ e) =>
                    setBrigadeForm({ ...brigadeForm, from: e.currentTarget.value })}
                />
                <input
                  type="date"
                  aria-label="Ends"
                  min=${brigadeForm.from}
                  value=${brigadeForm.until}
                  onInput=${(/** @type {any} */ e) =>
                    setBrigadeForm({ ...brigadeForm, until: e.currentTarget.value })}
                />
              </div>
              <p class="hint">
                A brigade runs for up to four weeks, then you renew it. Portions come from each
                person's own targets, so one pot serves different plates.
              </p>
              <div class="actions">
                <button class="secondary" onClick=${() => setBrigadeForm(null)}>CANCEL</button>
                <button class="primary" onClick=${submitBrigade}>START</button>
              </div>
            </div>`
      }

      <div class="actions">
        <a class="secondary linkbtn" href="#/dinner">💬 what should dinner be? →</a>
      </div>
    </div>
  `;
}
