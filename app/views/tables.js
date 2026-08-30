import { html } from "htm/preact";
import { tokenBroken } from "../lib/github.js";
import { useEffect, useState } from "preact/hooks";
import { datesOfWeek, recipesById, SLOT_KEYS, SLOT_META } from "../lib/plan.js";
import { parseLocalIso } from "../lib/dates.js";
import { SERVINGS_MIN, SERVINGS_MAX, resolveHead } from "../lib/tables.js";

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
 *   onSetHead?: (house: string, tableId: string, headId: string) => void,
 *   onSetGuests?: (house: string, tableId: string, guests: number) => void,
 *   liveSynthFor?: (t: import("../lib/tables.js").TableEvent) => { synthMode: string } | null,
 *   missingPlanWarning?: (t: import("../lib/tables.js").TableEvent) => string | null,
 *   onPatchSeat: (house: string, tableId: string, patch: Partial<import("../lib/tables.js").Seat>) => void,
 *   onSameForEveryone?: (house: string, tableId: string, same: boolean) => void,
 *   onSeatScreen: (recipeId: string) => Promise<Record<string, string[]>>,
 *   onTailorTable: (house: string, tableId: string) => Promise<void>,
 *   scoreboard: { id: string, name: string, emoji: string, score: number, cooked: { done: number, total: number }, shopped: boolean }[],
 *   weekId: string,
 *   onCreateBrigade: (b: { name: string, memberIds: string[], slots: string[], cookId?: string, from: string, until: string }) => void,
 *   onRemoveBrigade: (id: string) => void,
 *   onRunBrigade: (id: string, week: string, regenerate?: boolean) => Promise<{ made: number, thin: { slot: string, available: number }[], report?: { date: string, seatId: string, kcal: number, protein: number, dayKcal: number, dayProtein: number, share?: number, status: string }[], swiped?: { date: string, slot: string }[], assumed?: { id: string, slot: string }[] }>,
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
  onSetHead = undefined,
  onSetGuests = undefined,
  liveSynthFor = undefined,
  missingPlanWarning = undefined,
  onPatchSeat,
  onSameForEveryone,
  onSeatScreen,
  onTailorTable,
  scoreboard,
  weekId,
  onCreateBrigade,
  onRemoveBrigade,
  onRunBrigade,
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
  // THE INSTRUMENT (spec §12): how much the engine is actually doing this
  // week, derived LIVE at render (never from frozen pots — pots only exist
  // on solved tables, so a pot census flatters the engine). Aggregate
  // counts only: this is a shared surface. With zero tagged recipes it
  // reads "0 tailored", which is the line's whole job — it must be able to
  // say, plainly, that the engine is doing nothing.
  const synthCounts = liveSynthFor
    ? myTables.reduce(
        (acc, { t }) => {
          const solved = liveSynthFor(t)?.synthMode === "solved";
          return {
            tailored: acc.tailored + (solved ? 1 : 0),
            uniform: acc.uniform + (solved ? 0 : 1),
          };
        },
        { tailored: 0, uniform: 0 },
      )
    : null;
  const conflictIds = new Set((tableConflicts ?? []).map((c) => c.table.id));
  const collisionIds = new Set((tableCollisions ?? []).map((t) => t.id));
  const nameOf = (/** @type {string} */ id) =>
    (profiles ?? []).find((p) => p.id === id)?.name ?? id;
  const tokenBlocked = !hasToken || tokenBroken(repo?.auth);

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

  // TAILORING IS THE DEFAULT, not a button (David, 2026-08-10: "the norm
  // should be following exactly what you should be doing"). Every upcoming
  // shared table in my house tailors itself once, unless somebody explicitly
  // said everyone eats the same tonight.
  //
  // Three guards, because this spends an AI call and runs inside a render
  // effect: ONE table at a time (tailorBusy), never the same table twice
  // (`tried`, which also absorbs failures so a broken table cannot retry
  // forever), and never while the token is missing. A table that fails keeps
  // its manual button, so nothing becomes unreachable.
  const [tried, setTried] = useState(/** @type {Record<string, boolean>} */ ({}));
  useEffect(() => {
    if (tokenBlocked || tailorBusy) return;
    // ONE DEVICE PER TABLE. Four family phones open the app and would each
    // auto-tailor the same 21 tables: four times the AI spend, and four
    // concurrent writes racing on one table's tailor block. The effective
    // cook owns it — the same rule cookOf uses everywhere else, so every
    // device agrees on the owner without talking to each other, and a skipped
    // cook hands the job to the first present seat rather than stranding it.
    const ownsTailoring = (/** @type {any} */ t) => {
      const live = (t.seats ?? []).filter((/** @type {any} */ sx) => sx.status !== "skipped");
      const namedOk = live.some((/** @type {any} */ sx) => sx.id === t.cookId);
      return (namedOk ? t.cookId : live[0]?.id) === me;
    };
    const next = myTables.find(
      ({ house, t }) =>
        house === myHouse &&
        !t.tailor &&
        !t.sameForEveryone &&
        !tried[t.id] &&
        (t.seats ?? []).some((sx) => sx.status !== "skipped") &&
        ownsTailoring(t),
    );
    if (!next) return;
    setTried((cur) => ({ ...cur, [next.t.id]: true }));
    void runTailor(next.house, next.t.id);
  });

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
  // the run's result, one line per fact — a 7-day 2-person report as a single
  // semicolon-joined sentence was an unreadable wall on a phone (Final Gate)
  const [brigadeNote, setBrigadeNote] = useState(/** @type {string[]} */ ([]));

  /** @param {Partial<import("../lib/tables.js").Brigade>} [seed] renew path: prefill from the ended record */
  const openBrigadeForm = (seed) => {
    const until = new Date(`${todayIso}T12:00:00`);
    until.setDate(until.getDate() + 27); // the lib caps a brigade at four weeks
    setBrigadeForm({
      name: seed?.name ?? "",
      memberIds:
        seed?.memberIds?.filter((id) => houseMates.some((p) => p.id === id)) ??
        houseMates.filter((p) => p.id === me).map((p) => p.id),
      slots: seed?.slots ?? ["dinner"],
      cookId: seed?.cookId ?? me,
      rotateCooks: Boolean(seed?.rotateCooks),
      from: todayIso,
      until: until.toISOString().slice(0, 10),
    });
    setBrigadeNote([]);
  };

  const toggleIn = (/** @type {string[]} */ list, /** @type {string} */ value) =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  const submitBrigade = () => {
    if (!brigadeForm) return;
    if (brigadeForm.memberIds.length < 2) {
      setBrigadeNote([
        "Standing dinners need at least two people — that is what makes them shared.",
      ]);
      return;
    }
    if (brigadeForm.slots.length === 0) {
      setBrigadeNote(["Pick at least one meal to share."]);
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
    setBrigadeNote([]);
    try {
      const { made, thin, report, swiped, assumed, outOfRange, from, until } =
        /** @type {any} */ (await onRunBrigade(id, weekId, regenerate));
      const nameOf = (/** @type {string} */ pid) =>
        (profiles ?? []).find((p) => p.id === pid)?.name ?? pid;
      /** @type {string[]} */
      const lines = [];
      if (outOfRange) {
        lines.push(
          `This brigade runs ${from} to ${until}, and the Plan tab is on a different week. Flip Plan to a week inside that span, then SET THIS WEEK — nothing was set just now.`,
        );
        setBrigadeNote(lines);
        setBrigadeBusy(null);
        return;
      }
      const short = thin
        .filter((/** @type {any} */ t) => t.available === 0)
        .map((/** @type {any} */ t) => t.slot);
      if (short.length > 0 && made === 0) {
        lines.push(
          `No ${short.join(" or ")} works for everyone in this brigade. Nothing was set. Widen the bank or check the avoid lists.`,
        );
        setBrigadeNote(lines);
        setBrigadeBusy(null);
        return;
      }
      if (made === 0) {
        lines.push("This week is already set. Use PICK DIFFERENT MEALS to change it.");
        setBrigadeNote(lines);
        setBrigadeBusy(null);
        return;
      }
      const range = `${parseLocalIso(datesOfWeek(weekId)[0] ?? todayIso).toLocaleDateString([], { month: "short", day: "numeric" })} – ${parseLocalIso(datesOfWeek(weekId)[6] ?? todayIso).toLocaleDateString([], { month: "short", day: "numeric" })}`;
      lines.push(`Set ${made} ${made === 1 ? "meal" : "meals"} for ${range}.`);
      // THE DAY REPORT (P1, 2026-08-30): the composer's per-seat verdicts,
      // one line per fact. These are PLANNED numbers from recipe estimates —
      // arithmetic the app guarantees, never a measurement of what anyone
      // eats — and a miss names its DIRECTION, because too much and too
      // little demand opposite reactions.
      const rows = /** @type {{ date: string, seatId: string, dayKcal: number, dayProtein: number, share?: number, status: string }[]} */ (
        report ?? []
      );
      const offBand = rows.filter((r) => r.status !== "band");
      if (rows.length > 0 && offBand.length === 0) {
        lines.push(
          "Every planned day lands in everyone's calorie and protein band (planned from recipe estimates).",
        );
      }
      const wordFor = (/** @type {string} */ status) =>
        status === "floor"
          ? "under target but above their own minimum"
          : status === "over"
            ? "over — even the smallest plates exceed their ceiling"
            : status === "no-targets"
              ? "no targets on file — seated at standard portions"
              : "short — the shared menu cannot reach their target";
      const SHOWN = 6;
      for (const r of offBand.slice(0, SHOWN)) {
        const scope = (r.share ?? 1) < 0.95 ? "planned brigade meals" : "planned";
        lines.push(
          r.status === "no-targets"
            ? `${nameOf(r.seatId)}: ${wordFor(r.status)}.`
            : `${nameOf(r.seatId)} ${r.date.slice(5)}: ~${r.dayKcal} kcal / ${r.dayProtein} g ${scope} (${wordFor(r.status)}).`,
        );
      }
      if (offBand.length > SHOWN) lines.push(`…and ${offBand.length - SHOWN} more like these.`);
      if ((swiped ?? []).length > 0) {
        lines.push(
          `🎫 Your ${swiped.length} swipe ${swiped.length === 1 ? "lunch is" : "lunches are"} on your plan — 🍽 PICK MY TRAY on the Plan tab plans each plate.`,
        );
      }
      for (const a of assumed ?? []) {
        lines.push(
          `🎫 Assumes ${nameOf(a.id)}'s daily swipe ${a.slot} — their day lands once they run their own GENERATE, which places the swipes on their plan.`,
        );
      }
      const tight = thin.filter((/** @type {any} */ t) => t.available > 0);
      if (tight.length > 0) {
        lines.push(
          `Only ${tight
            .map(
              (/** @type {any} */ t) =>
                `${t.available} ${t.slot} ${t.available === 1 ? "recipe" : "recipes"}`,
            )
            .join(", ")} suit everyone, so the week repeats itself.`,
        );
      }
      setBrigadeNote(lines);
    } catch {
      setBrigadeNote([
        "Could not set the week — something failed while composing it. Try again; if it keeps failing, check SYS for a sync problem.",
      ]);
    }
    setBrigadeBusy(null);
  };

  // the ACTIVE brigade: the standing arrangement SET THIS WEEK runs for.
  // Since 2026-08-30 (monolith) this is THE week engine — deterministic
  // picks sized by the day composer, offline, no model in the loop.
  const activeBrigade =
    ((houseEvents ?? []).find((h) => h.house === myHouse)?.events?.brigades ?? [])
      .filter((b) => (b.until ?? "9999-12-31") >= todayIso)
      // two overlapping brigades (one expiring today): the longest-running
      // one owns the week run
      .sort((a, b) => (b.until ?? "").localeCompare(a.until ?? ""))[0] ?? null;
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
        ${tokenBroken(repo?.auth) ? "fix it in Settings" : "connect it in Settings"}
      </p>`
    }
    ${
      myTables.length === 0 &&
      !tableForm &&
      html`<p class="hint">
        no upcoming tables. To plan the whole week: SET WHO COOKS creates the standing
        arrangement, then SET THIS WEEK fills every shared meal to each person's calorie and
        protein numbers. For one meal, set a table below or talk it out on
        <a href="#/dinner">tonight's dinner</a>.
      </p>`
    }
    ${
      // David-facing diagnostic (the §12 instrument's visible edge): gated
      // by the scoreboard capability so family phones never see engine
      // jargon; label says "upcoming" because myTables is not week-bounded
      showScoreboard &&
      synthCounts &&
      myTables.length > 0 &&
      html`<p class="hint" role="status">
        plates engine, upcoming: ${synthCounts.tailored} tailored · ${synthCounts.uniform} uniform
      </p>`
    }
    ${myTables.map(({ house, t }) => {
      const mySeat = (t.seats ?? []).find((s) => s.id === me);
      const skipped = mySeat?.status === "skipped";
      const conflicted = conflictIds.has(t.id);
      // EFFECTIVE cook, mirroring lib cookOf: a skipped named cook hands the
      // role to the first present seat (David 2026-08-09), and the card must
      // show who actually cooks, not the original rota name
      const namedOk = (t.seats ?? []).some((s) => s.id === t.cookId && s.status !== "skipped");
      const cookShown = /** @type {string} */ (
        namedOk
          ? t.cookId
          : ((t.seats ?? []).find((s) => s.status !== "skipped")?.id ?? t.cookId ?? "")
      );
      const headId = resolveHead(t, profiles ?? []);
      const planWarn = !t.buyerId && missingPlanWarning ? missingPlanWarning(t) : null;
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
              👨‍🍳 <strong>${nameOf(cookShown)}${cookShown === me ? " (you)" : ""}</strong> cooks${
                cookShown !== t.cookId
                  ? html`<span class="hint"> (${nameOf(t.cookId)} is out)</span>`
                  : ""
              }
            </div>`
          }
          ${
            // the HEAD (spec §9): one named person whose plate decisions win
            // for this table. Resolution chain lives in resolveHead; only a
            // human tap ever writes headId (B5). Shown as "<name>'s table",
            // David's register, not a title. The second line tells a
            // non-head where the REDO PLATES button went, instead of
            // letting it silently vanish on them.
            headId &&
            html`<div class="d">
              🪑 <strong>${nameOf(headId)}${headId === me ? " (you)" : ""}</strong>'s table
              ${
                headId !== me &&
                mySeat &&
                !t.sameForEveryone &&
                (t.tailor || tailorErr[t.id]) &&
                html`<span class="hint"> · only ${nameOf(headId)} can redo these plates</span>`
              }
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
            ${
              // NO SERVING COUNTS (David, 2026-08-10). "David ×2.5 · Mom ×0.75
              // · cook total ×9.75" reads as "am I eating two and a half
              // servings?" and "am I cooking nine servings?", neither of which
              // means anything to a person. A serving is a denominator for the
              // macros, not an amount anybody should eat. Say WHO is eating;
              // each person's actual plate is the tailored line below.
              (t.seats ?? [])
                .map((s) => `${nameOf(s.id)}${s.status === "skipped" ? " (out)" : ""}`)
                .join(" · ")
            }
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
            // R6: only a CONFIGURED seat whose plan never synced to this
            // device warns, anchored to the claim about to happen — an
            // unconfigured seat is a normal plate and stays silent
            planWarn && html`<div class="d num redflag" role="status">⚠ ${planWarn}</div>`
          }
          ${
            // the stacked all-four-people plate list is DELETED (spec §7.4:
            // "the stacked list on the table card — audience: nobody"). The
            // cook sees every plate on the SERVE STEP, the last step of Cook
            // Mode; each person sees their own line on their own plan. One
            // quiet line says the plates exist and where they live now.
            t.tailor &&
            !t.sameForEveryone &&
            html`<div class="d hint" role="status">
              ✨ plates are set: the cook sees them on the serve step, yours is on your plan
            </div>`
          }
          ${
            tailorErr[t.id] &&
            html`<div class="d num redflag" role="status">${tailorErr[t.id]}</div>`
          }
          ${
            t.sameForEveryone &&
            html`<div class="d hint">🍲 everyone eats the same tonight — no per-person plates</div>`
          }
          <div class="actions wrap">
            ${
              // tailoring runs by itself now; this button only exists to RETRY
              // a table that failed, or to redo one after a seat changed
              // the head's control (spec §9): only the person who sets this
              // table redoes its plates — absent for everyone else, not greyed
              mySeat &&
              headId === me &&
              !t.sameForEveryone &&
              (t.tailor || tailorErr[t.id] || tailorBusy === t.id) &&
              html`<button
                class="secondary"
                disabled=${
                  tailorBusy === t.id ||
                  tokenBlocked ||
                  (t.seats ?? []).every((s) => s.status === "skipped")
                }
                onClick=${() => runTailor(house, t.id)}
              >
                ${tailorBusy === t.id ? "TAILORING…" : "✨ REDO PLATES"}
              </button>`
            }
            ${
              // any seated person can take the table (spec §9): one tap, the
              // card's own line names who has it, no confirmation ceremony
              mySeat &&
              onSetHead &&
              headId !== me &&
              house === myHouse &&
              html`<button class="secondary" onClick=${() => onSetHead(house, t.id, me)}>
                🪑 I'LL SET THE PLATES
              </button>`
            }
            ${
              // A GUEST IS ONE MORE PLATE (7.4, canon P8): the same pot with
              // extra plates on a sensible default — the tap adds one, long
              // context lives in the card line the count renders on
              mySeat &&
              house === myHouse &&
              onSetGuests &&
              html`<button
                class="secondary"
                aria-label="Add a guest plate to ${t.name || "this table"} (currently ${/** @type {any} */ (t).guests ?? 0})"
                onClick=${() => onSetGuests(house, t.id, (/** @type {any} */ (t).guests ?? 0) + 1)}
              >
                ➕ GUEST PLATE${/** @type {any} */ (t).guests ? ` (${/** @type {any} */ (t).guests})` : ""}
              </button>`
            }
            ${
              mySeat &&
              house === myHouse &&
              onSetGuests &&
              (/** @type {any} */ (t).guests ?? 0) > 0 &&
              html`<button
                class="secondary"
                aria-label="Remove a guest plate from ${t.name || "this table"}"
                onClick=${() => onSetGuests(house, t.id, (/** @type {any} */ (t).guests ?? 0) - 1)}
              >
                ➖ GUEST
              </button>`
            }
            ${
              // the EXCEPTION now takes the tap, not the rule
              mySeat &&
              house === myHouse &&
              onSameForEveryone &&
              html`<button
                class="secondary"
                onClick=${() => onSameForEveryone(house, t.id, !t.sameForEveryone)}
              >
                ${t.sameForEveryone ? "✨ TAILOR IT AFTER ALL" : "🍲 SAME FOR EVERYONE"}
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

      <div class="actions">
        <a class="secondary linkbtn" href="#/ask"
          >💬 ask anything — cooking, the plan, the list →</a
        >
      </div>

      <h2 class="block-title">Family dinners</h2>
      <p class="hint">
        every shared meal coming up, with the cook named. One pot, everyone's own portion; money
        from finished dinners settles on the List tab.
      </p>
      ${
        // the week's cook rota at the TOP of the page (David, 2026-08-09:
        // "is it clear who cooks each day?") — one glance, not a scroll past
        // 21 meal cards to the brigade card
        activeBrigade &&
        activeBrigade.rotateCooks &&
        html`<p class="hint" role="note">
          👨‍🍳
          ${(() => {
            const out = [];
            const start = new Date(`${todayIso}T12:00:00`);
            for (let i = 0; i < 7; i++) {
              const d = new Date(start);
              d.setDate(d.getDate() + i);
              const iso = d.toISOString().slice(0, 10);
              if (iso < activeBrigade.from || iso > activeBrigade.until) continue;
              const off = Math.round((Date.parse(iso) - Date.parse(activeBrigade.from)) / 86400000);
              const ids = activeBrigade.memberIds;
              const id = ids[((off % ids.length) + ids.length) % ids.length];
              const p = (profiles ?? []).find((x) => x.id === id);
              out.push(
                `${d.toLocaleDateString([], { weekday: "short" })} ${p?.name ?? id}${id === me ? " (you)" : ""}`,
              );
            }
            return out.join(" · ");
          })()}
        </p>`
      }
      ${dinnerBlock}
      ${
        // the household competition: same yardstick for everyone (cooked
        // confirmations + the receipt), numbers not judgment. The daily
        // check-in retired 2026-08-09 (David: personal tracking lives in
        // Crystal, not the family app), so logs left the score with it.
        showScoreboard &&
        (scoreboard ?? []).length > 0 &&
        html`<div class="tile">
          <div class="k">🏆 THIS WEEK · household scoreboard</div>
          ${scoreboard.map(
            (r, i) => html`
              <div class="d num" key=${r.id}>
                ${i === 0 && r.score > 0 ? "👑" : `${i + 1}.`} ${r.emoji} ${r.name}
                <b> ${r.score}</b> · cooked ${r.cooked.done}/${r.cooked.total} ·
                ${r.shopped ? "🧾 shopped" : "no receipt yet"}
              </div>
            `,
          )}
          <div class="hint">
            score = 70% meals confirmed cooked + 30% receipt scanned, over days already finished.
            Tap COOKED after cooking and it climbs.
          </div>
        </div>`
      }
      ${
        !tableForm
          ? html`<div class="actions">
              <button class="secondary" onClick=${openTableForm}>+ SET A TABLE</button>
              <button
                class="secondary"
                aria-label="Create a guest profile"
                onClick=${() => (location.hash = "#/guest")}
              >
                🛎 NEW GUEST PROFILE
              </button>
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
              ${
                // housemates first, then guesthouse members labeled as
                // guests (spec §6: seatable from any house; cook and buyer
                // stay in-house, which cookOf already enforces)
                [...(profiles ?? [])]
                  .sort(
                    (a, b) =>
                      (a.household === "guesthouse" ? 1 : 0) -
                      (b.household === "guesthouse" ? 1 : 0),
                  )
                  .map((p) => {
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
                      ${p.emoji ?? ""} ${p.name ?? p.id}${
                        p.household === "guesthouse"
                          ? html` <span class="hint">(guest)</span>`
                          : ""
                      }
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
        // rule planBrigadeWeek (compose.js) uses.
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
        // an ENDED arrangement must say so and offer renewal — live SET
        // buttons on an expired brigade sent mom "flip Plan to that week"
        // advice about a week that no longer exists (Final Gate Usability)
        if (b.until < todayIso) {
          return html`
            <div class="tile" key=${b.id}>
              <div class="k">${b.name}</div>
              <div class="sub">${names.join(" · ")}</div>
              <div class="sub">
                ended
                ${" "}${parseLocalIso(b.until).toLocaleDateString([], { month: "short", day: "numeric" })}
                — renew it to keep planning shared weeks
              </div>
              <div class="actions">
                <button class="primary" onClick=${() => openBrigadeForm(b)}>
                  RENEW (same people and meals)
                </button>
                <button class="secondary" onClick=${() => onRemoveBrigade(b.id)}>REMOVE</button>
              </div>
            </div>
          `;
        }
        const weekDates = datesOfWeek(weekId);
        // the subtitle must never promise a range the tap cannot set: a
        // brigade starting next week shows its start date instead of a
        // confident range that would dead-end in outOfRange
        const overlaps = weekDates.some((d) => d >= b.from && d <= b.until);
        const range = overlaps
          ? `${parseLocalIso(weekDates[0] ?? todayIso).toLocaleDateString([], { month: "short", day: "numeric" })} – ${parseLocalIso(weekDates[6] ?? todayIso).toLocaleDateString([], { month: "short", day: "numeric" })}`
          : `starts ${parseLocalIso(b.from).toLocaleDateString([], { month: "short", day: "numeric" })} — flip Plan to that week`;
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
                <small>${range} · every plate sized to each person's numbers</small>
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
      ${
        brigadeNote.length > 0 &&
        html`<div class="tile buffer" role="status">
          ${brigadeNote.map((line, i) => html`<p class="hint" key=${i}>${line}</p>`)}
        </div>`
      }
      ${
        !brigadeForm
          ? html`<div class="actions">
              <button class="secondary" onClick=${() => openBrigadeForm()}>
                + SET WHO COOKS
                <small>the standing arrangement — SET THIS WEEK then plans the whole week</small>
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
                      nights (the HOUSEHOLD list still merges it into one trip).
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
      ${
        // bottom of the page on purpose (David, 2026-08-09): the daily
        // check-offs moved to Crystal; remedies stay in Mise because they
        // cook from the pantry, but they don't lead the family page
        html`<div class="actions wrap">
          <a class="secondary linkbtn remedy" href="#/remedies">feeling off? → remedies</a>
        </div>`
      }
    </div>
  `;
}
