import { html } from "htm/preact";
import { tokenBroken } from "../lib/github.js";
import { useEffect, useState } from "preact/hooks";
import { datesOfWeek, recipesById, shiftWeek, SLOT_KEYS, SLOT_META } from "../lib/plan.js";
import { parseLocalIso, isoWeekId } from "../lib/dates.js";
import {
  SERVINGS_MIN,
  SERVINGS_MAX,
  clampGuests,
  effectiveBuyerOf,
  resolveHead,
  brigadeCovers,
  breakOn,
  namedSlotLine,
  ruleRecipeCheck,
  sundayBatchOn,
  sundayTwoPotsOn,
  twoPotSplit,
  batchesOnSave,
} from "../lib/tables.js";
import { autoPlanEligible } from "../lib/plan.js";
import { brigadeRunLines, cookDaysLabel } from "./brigade-lines.js";
import { isParked } from "../lib/parked.js";
import { PeopleSection } from "./people.js";

/** How long SET TABLE waits on the allergy check before offering TRY AGAIN. */
const SCREEN_TIMEOUT_MS = 15000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** [2, 3, 4] -> "Tue, Wed and Thu" */
const dayList = (/** @type {number[] | undefined} */ ds) => {
  const names = (ds ?? []).map((d) => WEEKDAYS[d] ?? "");
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : (names[0] ?? "");
};
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

/** @param {string} iso @param {number} n */
const plusDays = (iso, n) => {
  const t = new Date(`${iso}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

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
 *   onCreateBrigade: (b: { name: string, memberIds: string[], slots: string[], cookId?: string, from: string, until: string, cookDays?: number[], slotRecipes?: Record<string, string[]> }) => void,
 *   onUpdateBrigade?: (id: string, patch: Record<string, any>) => void,
 *   onRemoveBrigade: (id: string) => void,
 *   onRunBrigade: (id: string, week: string, regenerate?: boolean) => Promise<{ made: number, thin: { slot: string, available: number }[], report?: { date: string, seatId: string, kcal: number, protein: number, dayKcal: number, dayProtein: number, share?: number, status: string }[], swept?: { swaps: number, saved: number }, swiped?: { date: string, slot: string }[], assumed?: { id: string, slot: string }[] }>,
 *   showScoreboard?: boolean,
 *   onAddToDinner?: (date: string, profileId: string) => Promise<{ note: string, retry: boolean }>,
 *   onRemoveFromDinner?: (date: string, profileId: string) => void,
 *   onLinkRoommate?: (profileId: string) => Promise<string>,
 *   onInviteLink?: (kind: "member" | "guest") => Promise<string>,
 *   askConfirm?: (message: string) => Promise<boolean>,
 *   onReadTargets?: (ids: string[]) => Promise<Record<string, any>>
 * }} props `onReadTargets` (2.0, I-08): each id's targets, null when the file
 *   could not be read, so the rule's recipe picks run the plate screen
 */
export function TablesView({
  askConfirm = async (/** @type {string} */ m) => window.confirm(m),
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
  onUpdateBrigade = undefined,
  onRemoveBrigade,
  onRunBrigade,
  showScoreboard = true,
  onAddToDinner = undefined,
  onRemoveFromDinner = undefined,
  onLinkRoommate = undefined,
  onInviteLink = undefined,
  onReadTargets = undefined,
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
    .sort(
      (a, b) =>
        a.t.date.localeCompare(b.t.date) ||
        // meal order within a day (breakfast before smoothie before dinner),
        // not alphabetical; unknown slots sort last
        (SLOT_KEYS.indexOf(a.t.slot) + 1 || 99) - (SLOT_KEYS.indexOf(b.t.slot) + 1 || 99),
    );
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
  const profilesById = new Map((profiles ?? []).map((p) => [p.id, p]));
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
        [tableId]: err instanceof Error ? err.message : "tailoring failed, try again",
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
    /** @type {null | { editId: string | null, name: string, memberIds: string[], slots: string[], cookId: string, rotateCooks: boolean, from: string, until: string, open: boolean, sundayMinutes: string, cookDays: number[], slotRecipes: Record<string, string[]>, batchFeeds: number[], keptBatches?: { cookDay: number, feeds: number[] }[], sundayBatch: boolean, sundayTwoPots: boolean, meatDaily: boolean, dinnerMeat: boolean }} */ (
      null
    ),
  );
  const [brigadeBusy, setBrigadeBusy] = useState(/** @type {string | null} */ (null));
  // the run's result, one line per fact — a 7-day 2-person report as a single
  // semicolon-joined sentence was an unreadable wall on a phone (Final Gate)
  const [brigadeNote, setBrigadeNote] = useState(/** @type {string[]} */ ([]));
  // the rule form as it opened, to tell an edited form from an untouched one
  const [formStart, setFormStart] = useState("");
  // THE RULE'S PEOPLE, SCREENED (2.0, I-08): each member's targets while
  // the form is open, so a named recipe someone cannot eat greys with the
  // reason. Absent = still loading, null = could not be read; both leave the
  // recipe "not checked", never passed.
  const [ruleTargets, setRuleTargets] = useState(/** @type {Record<string, any>} */ ({}));
  const ruleMemberKey = brigadeForm ? [...brigadeForm.memberIds].sort().join(",") : "";
  useEffect(() => {
    if (!ruleMemberKey || !onReadTargets) return;
    let live = true;
    void onReadTargets(ruleMemberKey.split(","))
      .then((got) => {
        if (live) setRuleTargets((cur) => ({ ...cur, ...got }));
      })
      .catch(() => {
        // a failed read leaves everyone unchecked: fails closed
      });
    return () => {
      live = false;
    };
  }, [ruleMemberKey]);

  /**
   * @param {Partial<import("../lib/tables.js").Brigade>} [seed] renew path: prefill from the ended record
   * @param {boolean} [editing] EDIT path (2026-09-05): change the standing rule in place — cook
   *   nights, named breakfasts, who is in it — without ending it and starting another
   */
  const openBrigadeForm = (seed, editing = false) => {
    // the form opens below the card, under the tab bar: bring it up so the
    // tap visibly did something (Tribunal Usability, 2026-10-18)
    setTimeout(
      () => document.getElementById("rule-form")?.scrollIntoView({ behavior: "smooth", block: "start" }),
      60,
    );
    const until = new Date(`${todayIso}T12:00:00`);
    until.setDate(until.getDate() + 27); // the lib caps a brigade at four weeks
    const form = {
      editId: editing && seed?.id ? seed.id : null,
      name: seed?.name ?? "",
      memberIds:
        seed?.memberIds?.filter((id) => houseMates.some((p) => p.id === id)) ??
        houseMates.filter((p) => p.id === me).map((p) => p.id),
      slots: seed?.slots ?? ["dinner"],
      cookId: seed?.cookId ?? me,
      rotateCooks: Boolean(seed?.rotateCooks),
      from: editing && seed?.from ? seed.from : todayIso,
      until: editing && seed?.until ? seed.until : until.toISOString().slice(0, 10),
      // no end date is the default (David, 2026-10-18): any save of the rule
      // keeps it going, paused only for school breaks
      open: seed?.open !== false,
      sundayMinutes: Number(seed?.sundayMinutes) > 0 ? String(seed?.sundayMinutes) : "",
      cookDays:
        Array.isArray(seed?.cookDays) && seed.cookDays.length > 0
          ? [...seed.cookDays]
          : [...ALL_DAYS],
      slotRecipes: { ...(seed?.slotRecipes ?? {}) },
      // ON unless saved off (2.0, I-14); ON, there is no second Sunday pot
      sundayBatch: sundayBatchOn(seed),
      // two Sunday pots unless saved off (David, 2026-10-25); B's meat is
      // cooked once on Tuesday unless he chose each night
      sundayTwoPots: sundayTwoPotsOn(seed),
      meatDaily: /** @type {any} */ (seed)?.meatDaily === true,
      batchFeeds: [...(seed?.batches?.find((b) => b.cookDay === 0)?.feeds ?? [])],
      // a rule that opens ON keeps its saved batches through any save that
      // leaves the setting alone (batchesOnSave): a rename is not an edit of
      // his Sunday pot (Tribunal Final Gate 1.95)
      ...(sundayBatchOn(seed) && Array.isArray(seed?.batches) ? { keptBatches: seed.batches } : {}),
      dinnerMeat: seed?.dinnerMeat === true,
    };
    setBrigadeForm(form);
    setFormStart(JSON.stringify(form));
    setBrigadeNote([]);
  };
  // leaving the rule with unsaved changes asks first (2.0, I-07)
  const cancelBrigadeForm = async () => {
    if (
      brigadeForm &&
      JSON.stringify(brigadeForm) !== formStart &&
      !(await askConfirm("Leave without saving your changes to the rule?"))
    ) {
      return;
    }
    setBrigadeForm(null);
  };

  const toggleIn = (/** @type {string[]} */ list, /** @type {string} */ value) =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  const submitBrigade = () => {
    if (!brigadeForm) return;
    if (brigadeForm.memberIds.length < 1) {
      setBrigadeNote(["Pick who eats: one person is fine, cooking for one is a kitchen too."]);
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
    // cook nights: all seven means "no rule", stored absent; named recipes:
    // only slots that are shared AND have a non-empty list are kept
    const everyNight = ALL_DAYS.every((d) => brigadeForm.cookDays.includes(d));
    // every named id is KEPT, even one this phone's bank doesn't hold yet
    // (audit 2026-10-18: SAVE while the bank was still loading silently
    // deleted his breakfast and snack picks). A recipe that is truly gone
    // costs a "not in the bank" note; a dropped one costs his week.
    const slotRecipes = Object.fromEntries(
      Object.entries(brigadeForm.slotRecipes)
        .map(([slot, ids]) => [slot, [...new Set((ids ?? []).filter((id) => typeof id === "string" && id))]])
        .filter(
          ([slot, ids]) =>
            brigadeForm.slots.includes(/** @type {string} */ (slot)) &&
            Array.isArray(ids) &&
            ids.length > 0,
        ),
    );
    const batchFeeds =
      !brigadeForm.sundayBatch &&
      brigadeForm.slots.includes("dinner") &&
      brigadeForm.cookDays.includes(0) &&
      !everyNight
        ? [...brigadeForm.batchFeeds].filter((d) => !brigadeForm.cookDays.includes(d)).sort()
        : [];
    const batches = batchesOnSave(
      {
        sundayBatch: brigadeForm.sundayBatch,
        kept: brigadeForm.keptBatches,
        slots: brigadeForm.slots,
        cookDays: brigadeForm.cookDays,
      },
      batchFeeds,
    );
    const rule = {
      name: brigadeForm.name.trim() || "Brigade",
      memberIds: orderedMembers,
      slots: brigadeForm.slots,
      cookId: orderedMembers.includes(brigadeForm.cookId) ? brigadeForm.cookId : orderedMembers[0],
      ...(brigadeForm.rotateCooks ? { rotateCooks: true } : {}),
      from: brigadeForm.from,
      // an open rule stores a 28-day window that rolls itself forward
      // (rolledRule); every app version accepts a window that long
      until: brigadeForm.open ? plusDays(brigadeForm.from, 27) : brigadeForm.until,
      // stored either way: an absent `open` is an old rule the app turns on once
      ...(brigadeForm.open ? { open: true, breaks: "purdue" } : { open: false }),
      ...(Number(brigadeForm.sundayMinutes) > 0
        ? { sundayMinutes: Math.min(1440, Math.round(Number(brigadeForm.sundayMinutes))) }
        : {}),
      ...(everyNight || !brigadeForm.slots.includes("dinner")
        ? {}
        : { cookDays: [...brigadeForm.cookDays].sort() }),
      ...(Object.keys(slotRecipes).length > 0 ? { slotRecipes } : {}),
      // the Sunday batch: only nights that are NOT cook nights can eat it
      ...(batches ? { batches } : {}),
      ...(brigadeForm.dinnerMeat && brigadeForm.slots.includes("dinner")
        ? { dinnerMeat: true }
        : {}),
      // only OFF is stored: absent is the default, ON (sundayBatchOn)
      ...(brigadeForm.sundayBatch ? {} : { sundayBatch: false }),
      // the same for two pots: only the one-pot choice is stored
      ...(brigadeForm.sundayBatch && !brigadeForm.sundayTwoPots ? { sundayTwoPots: false } : {}),
      ...(brigadeForm.meatDaily ? { meatDaily: true } : {}),
    };
    if (brigadeForm.editId && onUpdateBrigade) {
      onUpdateBrigade(brigadeForm.editId, {
        ...rule,
        // an unset rule must be REMOVED from the record, not left as it was
        rotateCooks: brigadeForm.rotateCooks ? true : undefined,
        open: brigadeForm.open,
        sundayMinutes:
          Number(brigadeForm.sundayMinutes) > 0
            ? Math.min(1440, Math.round(Number(brigadeForm.sundayMinutes)))
            : undefined,
        breaks: brigadeForm.open ? "purdue" : undefined,
        cookDays: /** @type {any} */ (rule).cookDays ?? undefined,
        slotRecipes: /** @type {any} */ (rule).slotRecipes ?? undefined,
        batches: /** @type {any} */ (rule).batches ?? undefined,
        dinnerMeat: /** @type {any} */ (rule).dinnerMeat ?? undefined,
        sundayBatch: /** @type {any} */ (rule).sundayBatch ?? undefined,
        sundayTwoPots: /** @type {any} */ (rule).sundayTwoPots ?? undefined,
        meatDaily: /** @type {any} */ (rule).meatDaily ?? undefined,
      });
      setBrigadeNote([
        "Saved. SET MY WEEK on the Plan tab fills empty meals from it and swaps any set meal the rule no longer allows.",
      ]);
    } else {
      onCreateBrigade(rule);
    }
    setBrigadeForm(null);
  };

  const runBrigade = async (
    /** @type {string} */ id,
    /** @type {boolean} */ regenerate,
    /** @type {string} */ runWeek = weekId,
  ) => {
    setBrigadeBusy(id);
    setBrigadeNote([]);
    try {
      const result = /** @type {any} */ (await onRunBrigade(id, runWeek, regenerate));
      // ONE wording for both screens (brigade-lines.js): the Plan tab's
      // GENERATE reports the same run the same way
      setBrigadeNote(
        brigadeRunLines(result, {
          runWeek,
          todayIso,
          nameOf: (/** @type {string} */ pid) =>
            (profiles ?? []).find((p) => p.id === pid)?.name ?? pid,
        }),
      );
    } catch {
      setBrigadeNote([
        "Could not set the week, something failed while composing it. Try again; if it keeps failing, check SYS for a sync problem.",
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
  // who is a GUEST at which coming dinner: seated on my kitchen's dinner and
  // not a member of the kitchen (the People tab's day chips read this)
  /** @type {Record<string, string[]>} */
  const dinnerGuests = {};
  for (const t of (houseEvents ?? []).find((h) => h.house === myHouse)?.events?.tables ?? []) {
    // the kitchen's own dinners only: a one-off table's seat cannot be
    // taken off from here (review, 2026-10-16)
    if (t.slot !== "dinner" || !t.fromBrigade || typeof t.date !== "string" || t.date < todayIso)
      continue;
    for (const st of t.seats ?? []) {
      if (st.status === "skipped" || activeBrigade?.memberIds.includes(st.id)) continue;
      dinnerGuests[t.date] = [...new Set([...(dinnerGuests[t.date] ?? []), st.id])];
    }
  }
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
  // the dish the warnings above were screened for: SET TABLE waits for it,
  // and a seat the screen refused (an unread profile included) is left off
  // (Mise 2.0, D-01 follow-up, schelkin 10/23: the warnings used to be
  // advice only, and a tap before they loaded seated everyone unscreened)
  const [screenedFor, setScreenedFor] = useState(/** @type {string | null} */ (null));
  // the check failed or took over 15 seconds: SET TABLE stays shut (fail
  // closed, nothing is seated unscreened) and TRY AGAIN runs the check anew
  // (Tribunal Final Gate, Usability: the button hung on CHECKING ALLERGIES
  // with no way out when the phone had no signal)
  const [screenFailed, setScreenFailed] = useState(false);
  const [screenTry, setScreenTry] = useState(0);
  useEffect(() => {
    if (!tableForm?.recipeId) return;
    const id = tableForm.recipeId;
    let alive = true;
    setSeatWarnings({});
    setScreenedFor(null);
    setScreenFailed(false);
    const timer = setTimeout(() => {
      if (alive) setScreenFailed(true);
    }, SCREEN_TIMEOUT_MS);
    onSeatScreen(id)
      .then((w) => {
        if (!alive) return;
        clearTimeout(timer);
        setSeatWarnings(w);
        setScreenedFor(id);
        setScreenFailed(false);
      })
      .catch(() => {
        if (!alive) return;
        clearTimeout(timer);
        setScreenFailed(true);
      });
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [tableForm?.recipeId, screenTry]);
  const submitTable = () => {
    if (!tableForm || !tableForm.recipeId || !tableForm.date) return;
    if (tableForm.date < todayIso) return; // past tables can't be set
    if (screenedFor !== tableForm.recipeId) return; // the allergy check has not finished
    const seats = Object.entries(tableForm.seats)
      .filter(([id, v]) => v.in && (seatWarnings[id] ?? []).length === 0)
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
        ✨ plate tailoring needs the token,
        ${tokenBroken(repo?.auth) ? "fix it in Settings" : "connect it in Settings"}
      </p>`
    }
    ${
      myTables.length === 0 &&
      !tableForm &&
      html`<p class="hint">
        no upcoming tables. To plan the whole week: SET WHO COOKS creates the standing arrangement,
        then SET THIS WEEK fills every shared meal to each person's calorie and protein numbers. For
        one meal, set a table below or talk it out on
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
    ${myTables.map(({ house, t }, idx) => {
      // one small day header per date, so a 28-table brigade week reads as
      // seven days instead of one undifferentiated pile (David, 2026-08-30)
      const prev = myTables[idx - 1];
      const dayHead =
        !prev || prev.t.date !== t.date
          ? html`<h3 class="block-title">
              ${
                t.date === todayIso
                  ? "Today"
                  : parseLocalIso(t.date).toLocaleDateString([], {
                      weekday: "long",
                      month: "short",
                      day: "numeric",
                    })
              }
            </h3>`
          : "";
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
      const guestCount = clampGuests(t);
      const planWarn = !t.buyerId && missingPlanWarning ? missingPlanWarning(t) : null;
      return html`
        ${dayHead}
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
          ${(() => {
            // GROCERY CLAIM: the ONE rule (effectiveBuyerOf) — an explicit
            // claim, else a brigade table's named cook buys by rule, else
            // nobody. The nag renders only when the buy is genuinely
            // homeless, so 28 brigade tables no longer cry "unclaimed".
            const eb = effectiveBuyerOf(t, house, profilesById);
            return eb
              ? html`<div class="d">
                  🛒 <strong>${nameOf(eb)}${eb === me ? " (you)" : ""}</strong>
                  buys the
                  groceries${!t.buyerId ? html`<span class="hint"> · the brigade's cook</span>` : ""}
                </div>`
              : html`<div class="d hint">🛒 nobody has claimed the groceries yet</div>`;
          })()}
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
              ⚠ conflicts with your diet list, not added to your plan
            </div>`
          }
          ${
            collisionIds.has(t.id) &&
            html`<div class="d num redflag">
              your ${SLOT_META[t.slot]?.full ?? t.slot} that day is pinned or marked OUT, unpin or
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
            html`<div class="d hint">🍲 everyone eats the same tonight, no per-person plates</div>`
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
                aria-label="Add a guest plate to ${t.name || "this table"} (currently ${guestCount})"
                onClick=${() => onSetGuests(house, t.id, guestCount + 1)}
              >
                ➕ GUEST PLATE${guestCount ? ` (${guestCount})` : ""}
              </button>`
            }
            ${
              mySeat &&
              house === myHouse &&
              onSetGuests &&
              guestCount > 0 &&
              html`<button
                class="secondary"
                aria-label="Remove a guest plate from ${t.name || "this table"}"
                onClick=${() => onSetGuests(house, t.id, guestCount - 1)}
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
              !effectiveBuyerOf(t, house, profilesById) &&
              onSetBuyer &&
              html`<button class="primary" onClick=${() => onSetBuyer(house, t.id, me)}>
                🛒 I'LL BUY THIS
              </button>`
            }
            ${
              t.buyerId === me &&
              onSetBuyer &&
              html`<button class="secondary" onClick=${() => onSetBuyer(house, t.id, null)}>
                RELEASE, NOT BUYING
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
        <h1>People<span>.</span></h1>
        <div class="sub">who eats from your kitchen, and who comes to dinner</div>
      </div>

      <${PeopleSection}
        profiles=${profiles}
        me=${me}
        todayIso=${todayIso}
        weekId=${weekId}
        nextWeekId=${shiftWeek(weekId, 1)}
        kitchenMemberIds=${activeBrigade?.memberIds ?? [me]}
        dinnerGuests=${dinnerGuests}
        onAddToDinner=${onAddToDinner}
        onRemoveFromDinner=${onRemoveFromDinner}
        onLinkRoommate=${onLinkRoommate}
        onInviteLink=${onInviteLink}
      />

      ${
        // THE TABLE TAB'S WEEK (decision 0018, David 2026-10-16: "the whole
        // table tab ... I don't ever look at it ... don't show every
        // individual meal"). The meal cards, rota, batch tile, scoreboard and
        // one-off tables stay built behind one parked flag; the week is read
        // on Plan and set by SET MY WEEK.
        !isParked("tableweek") &&
        html`
      <div class="hero">
        <h1>${activeBrigade ? "Table" : "Today"}<span>.</span></h1>
        <div class="sub">
          ${
            // David, 2026-08-30: "it's showing all of the quote-unquote
            // family dinners for the entire week... that's clearly not
            // today". Under a brigade this page IS the week's shared meals,
            // so the page stops calling itself Today.
            activeBrigade
              ? "the week's shared meals, who cooks, what to prep"
              : "what's for dinner, who's cooking"
          }
        </div>
      </div>

      <div class="actions">
        <a class="secondary linkbtn" href="#/ask"
          >💬 ask anything, cooking, the plan, the list →</a
        >
      </div>

      <h2 class="block-title">
        ${activeBrigade ? `${activeBrigade.name}: the week` : "Family dinners"}
      </h2>
      <p class="hint">
        ${
          activeBrigade
            ? "every meal the brigade has set, breakfasts through dinners, grouped by day with the cook named. One pot, everyone's own portion; the cook buys, and money settles on the List tab."
            : "every shared meal coming up, with the cook named. One pot, everyone's own portion; money from finished dinners settles on the List tab."
        }
      </p>
      `
      }
      ${
        !isParked("tableweek") &&
        html`
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
              if (!brigadeCovers(activeBrigade, iso)) continue;
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
      ${
        // BATCH PREP, on the page where David actually looks (2026-08-30:
        // "I need a place to see where I batch prep all these things...
        // I'm looking in today and I don't see anything"). The coming
        // week's make-ahead components, cook-once deduped by recipe; the
        // day-by-day assembly notes stay on PLAN under the week's days
        // (CookBlocks), which this tile signposts.
        activeBrigade &&
        (() => {
          const end = new Date(`${todayIso}T12:00:00`);
          end.setDate(end.getDate() + 7);
          const endIso = end.toISOString().slice(0, 10);
          const seen = new Set();
          const make = [];
          const fresh = [];
          for (const { t } of myTables) {
            if (t.date > endIso) continue;
            const r = byId.get(t.recipeId);
            if (!r || seen.has(r.id)) continue;
            seen.add(r.id);
            const comp = r.batchPrep?.sundayComponent;
            if (comp) make.push({ id: r.id, name: r.name, text: comp });
            else fresh.push(r.name);
          }
          if (make.length === 0 && fresh.length === 0) return "";
          return html`<div class="tile" role="note">
            <div class="k">🍳 Batch prep: make once, eat all week</div>
            ${make.map(
              (m) => html`<div class="d" key=${m.id}><strong>${m.name}</strong>: ${m.text}</div>`,
            )}
            ${
              fresh.length > 0 &&
              html`<p class="hint">Cooked fresh or grabbed, no make-ahead: ${fresh.join(", ")}.</p>`
            }
            <p class="hint">Day-by-day assembly notes live on PLAN, under the week's days.</p>
          </div>`;
        })()
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
                          ${p.emoji ?? ""}
                          ${p.name ?? p.id}${
                            p.household === "guesthouse"
                              ? html` <span class="hint">(guest)</span>`
                              : ""
                          }
                          ${
                            seat.in &&
                            warns.length > 0 &&
                            html`<span class="usesoon">⚠ not seated: ${warns.join(", ")}</span>`
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
                                    [p.id]: {
                                      ...seat,
                                      servings: Number(e.currentTarget.value) || 1,
                                    },
                                  },
                                })}
                            /><span class="hint num">servings</span>`
                        }
                      </div>
                    `;
                  })
              }
              <div class="actions">
                <button class="secondary" onClick=${() => setTableForm(null)}>CANCEL</button>
                <button
                  class="primary"
                  disabled=${screenedFor !== tableForm.recipeId && !screenFailed}
                  onClick=${screenedFor === tableForm.recipeId ? submitTable : () => setScreenTry((n) => n + 1)}
                >
                  ${screenedFor === tableForm.recipeId ? "SET TABLE" : screenFailed ? "TRY AGAIN" : "CHECKING ALLERGIES…"}
                </button>
              </div>
              ${
                screenedFor !== tableForm.recipeId &&
                html`<p class="hint" role="status">
                  ${
                    screenFailed
                      ? "Could not check allergies. Check the phone has signal, then TRY AGAIN."
                      : "Checking everyone's allergies, a few seconds."
                  }
                </p>`
              }
            </div>`
      }
      `
      }
      ${
        // the block explains itself only when it has content or is being
        // created — an empty jargon heading taught nothing (council 2026-08-02)
        (myBrigades.length > 0 || brigadeForm) &&
        html`<h2 class="block-title">Your kitchen's dinners</h2>
          <p class="hint">Who cooks, which nights, and the Sunday batch. SET MY WEEK on Plan uses it.</p>`
      }
      ${(activeBrigade
        ? // a running kitchen hides the ended ones (2026-10-16): two dead
          // "renew it" cards above the live one read as three kitchens
          myBrigades.filter((x) => (x.until ?? "9999-12-31") >= todayIso)
        : myBrigades
      ).map((b) => {
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
            if (!brigadeCovers(b, iso)) continue;
            // a leftover night cooks nothing, so it names no cook (shrike 2026-10-25)
            if ((b.cookDays ?? []).length > 0 && !(b.cookDays ?? []).includes(d.getDay())) continue;
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
                ${" "}${parseLocalIso(b.until).toLocaleDateString([], { month: "short", day: "numeric" })},
               renew it to keep planning shared weeks
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
        // THE SUNDAY TRAP, Table-tab edition (David, 2026-08-30: his re-roll
        // ran on the dying W35 — one upcoming day — burned a salt, and the
        // 28 visible W36 meals never changed). Same rule the List's BUILD
        // learned: these buttons target the week holding MORE upcoming
        // in-span days, viewed week or the next one; ties keep the view.
        const upcomingIn = (/** @type {string} */ w) =>
          datesOfWeek(w).filter((d) => brigadeCovers(b, d) && d >= todayIso).length;
        const dayAfter = parseLocalIso(/** @type {string} */ (datesOfWeek(weekId)[6] ?? todayIso));
        dayAfter.setDate(dayAfter.getDate() + 1);
        const nextWeekId = isoWeekId(dayAfter);
        // 2026-10-13 (David: "can we have it start this week?"): the week on
        // screen is planned from today whenever it has a day left; next week is
        // its own button. The old rule picked whichever week had MORE days
        // left, so a Tuesday-night run silently planned the next Sunday on.
        const thisLeft = upcomingIn(weekId);
        const nextLeft = upcomingIn(nextWeekId);
        const runWeek = thisLeft > 0 ? weekId : nextWeekId;
        const offerNext = thisLeft > 0 && nextLeft > 0;
        const weekDates = datesOfWeek(runWeek);
        // the subtitle must never promise a range the tap cannot set: a
        // brigade starting past next week shows its start date instead of a
        // confident range that would dead-end in outOfRange
        const overlaps = weekDates.some((d) => brigadeCovers(b, d));
        const range = overlaps
          ? `${parseLocalIso([weekDates[0] ?? todayIso, todayIso, b.from].sort()[2] ?? todayIso).toLocaleDateString([], { month: "short", day: "numeric" })} – ${parseLocalIso(weekDates[6] ?? todayIso).toLocaleDateString([], { month: "short", day: "numeric" })}`
          : weekDates.some((d) => breakOn(b, d))
            ? `off this week: ${breakOn(b, weekDates.find((d) => breakOn(b, d)) ?? "")?.why ?? "school break"}`
            : `starts ${parseLocalIso(b.from).toLocaleDateString([], { month: "short", day: "numeric" })}, flip Plan to that week`;
        return html`
          <div class="tile" key=${b.id}>
            <div class="k">${b.name}</div>
            <div class="sub">${names.join(" · ")}</div>
            <div class="sub">
              ${b.slots.map((s) => SLOT_META[s]?.full ?? s).join(", ")} ·
              ${" "}${
                b.open
                  ? `no end date${b.breaks ? ", off for school breaks" : ""}`
                  : `through ${parseLocalIso(b.until).toLocaleDateString([], { month: "short", day: "numeric" })}`
              }
              ${
                b.rotateCooks
                  ? html` · cooks take turns, ${cook?.name ?? "the shopper"} buys`
                  : cook
                    ? html` · ${cook.name ?? cook.id} shops`
                    : ""
              }
            </div>
            ${
              // the standing rules that shape the week (2026-09-05), so a
              // glance says why Tuesday is leftovers and breakfast repeats
              (cookDaysLabel(b.cookDays) || Object.keys(b.slotRecipes ?? {}).length > 0) &&
              html`<div class="sub">
                ${cookDaysLabel(b.cookDays) && html`🍳 cook dinner ${cookDaysLabel(b.cookDays)} · the nights after eat that pot`}
                ${
                  // ON (the default), Sunday's own pot is the batch and a saved
                  // second Sunday pot is not cooked (2.0, I-14)
                  sundayTwoPotsOn(b) && twoPotSplit(b.cookDays) && cookDaysLabel(b.cookDays)
                    ? html`<span>
                        ${` · 🥘 Sunday cooks two pots: one for Sun and ${dayList(twoPotSplit(b.cookDays)?.a)}, one for ${dayList(twoPotSplit(b.cookDays)?.b)} with the meat cooked ${/** @type {any} */ (b).meatDaily ? "each night" : `on ${WEEKDAYS[twoPotSplit(b.cookDays)?.b[0] ?? 2]}`}`}</span
                      >`
                    : sundayBatchOn(b) && (b.cookDays ?? []).includes(0) && cookDaysLabel(b.cookDays)
                      ? html`<span> · 🥘 Sunday dinner is the batch</span>`
                      : ""
                }
                ${(b.batches ?? [])
                  .filter((x) => !(sundayBatchOn(b) && x.cookDay === 0))
                  .map(
                    (x, i) =>
                      html`<span key=${`batch${i}`}>
                        · 🥘 ${WEEKDAYS[x.cookDay]} batch for ${cookDaysLabel(x.feeds)}</span
                      >`,
                  )}
                ${Object.entries(b.slotRecipes ?? {}).map(
                  ([slot, ids]) =>
                    html`<span key=${slot}>
                      ${cookDaysLabel(b.cookDays) ? " · " : ""}${SLOT_META[slot]?.full ?? slot}:
                      only ${" "}${(ids ?? []).map((id) => byId.get(id)?.name ?? id).join(", ")}
                    </span>`,
                )}
              </div>`
            }
            <div class="sub">${rotation.length > 0 && html`👨‍🍳 ${rotation.join(" · ")}`}</div>
            <div class="actions">
              ${
                !isParked("tableweek") &&
                html`<button
                class="primary"
                disabled=${brigadeBusy === b.id}
                onClick=${() => runBrigade(b.id, false, runWeek)}
              >
                ${
                  brigadeBusy === b.id
                    ? "SETTING…"
                    : runWeek === weekId
                      ? "SET THIS WEEK, FROM TODAY"
                      : "SET NEXT WEEK"
                }
                <small>${range} · every plate sized to each person's numbers</small>
              </button>
              ${
                offerNext &&
                html`<button
                  class="secondary"
                  disabled=${brigadeBusy === b.id}
                  onClick=${() => runBrigade(b.id, false, nextWeekId)}
                >
                  SET NEXT WEEK
                </button>`
              }
              <button
                class="secondary"
                disabled=${brigadeBusy === b.id}
                onClick=${() => runBrigade(b.id, true, runWeek)}
              >
                PICK DIFFERENT MEALS
              </button>`
              }
              ${
                onUpdateBrigade &&
                html`<button class="secondary" onClick=${() => openBrigadeForm(b, true)}>
                  EDIT
                </button>`
              }
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
          ? !activeBrigade &&
            html`<div class="actions">
              <button class="secondary" onClick=${() => openBrigadeForm()}>
                + SET WHO COOKS
                <small>the standing arrangement, SET THIS WEEK then plans the whole week</small>
              </button>
            </div>`
          : html`<div
              class="tile tableform"
              id="rule-form"
              data-unsaved=${JSON.stringify(brigadeForm) !== formStart ? "1" : "0"}
            >
              <div class="k">
                ${brigadeForm.editId ? "Change the standing rule" : "Set who cooks"}
              </div>
              <input
                aria-label="Brigade name"
                placeholder="e.g. Mom + Lena"
                value=${brigadeForm.name}
                onInput=${(/** @type {any} */ e) =>
                  setBrigadeForm({ ...brigadeForm, name: e.currentTarget.value })}
              />
              <div class="sub">Who is in it</div>
              <div class="chips wrapchips">
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
              <div class="chips wrapchips">
                ${SLOTS.filter(
                  // no smoothie category any more (2026-10-16), unless already chosen
                  ({ key }) => key !== "smoothie" || brigadeForm.slots.includes(key),
                ).map(
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
              ${
                // COOK NIGHTS (David, 2026-09-05: "i want to only have to cook
                // maybe 3 dinners a week... busy nights are tuesday wednesday
                // thursday"). Tap the nights dinner is cooked; every other
                // night eats leftovers of the nearest pot that is still safe.
                brigadeForm.slots.includes("dinner") &&
                html`<div class="sub">Nights you cook dinner</div>
                  <div class="chips wrapchips">
                    ${ALL_DAYS.map(
                      (d) => html`
                        <button
                          key=${d}
                          class=${brigadeForm.cookDays.includes(d) ? "chip on" : "chip"}
                          aria-pressed=${brigadeForm.cookDays.includes(d)}
                          onClick=${() =>
                            setBrigadeForm({
                              ...brigadeForm,
                              cookDays: brigadeForm.cookDays.includes(d)
                                ? brigadeForm.cookDays.filter((x) => x !== d)
                                : [...brigadeForm.cookDays, d],
                            })}
                        >
                          ${WEEKDAYS[d]}
                        </button>
                      `,
                    )}
                  </div>
                  <p class="hint">
                    ${
                      brigadeForm.cookDays.length === 7
                        ? "Every night cooks fresh. Untap the busy nights and they eat leftovers: the cook night makes a bigger pot, sized for the plates it feeds."
                        : brigadeForm.cookDays.length === 0
                          ? "Pick at least one cook night."
                          : `Cook ${cookDaysLabel([...brigadeForm.cookDays].sort())}. Each other night eats the most recent pot, so a Tuesday cook is Wednesday's dinner; a pot stretches only as far as its dish keeps, and a night no pot can reach cooks after all.`
                    }
                  </p>
                  ${
                    // WHAT SUNDAY COOKS, one of three: TWO POTS (David,
                    // 2026-10-25, the default: A for Sun and Mon, B prepped
                    // all but the meat for Tue to Thu), ONE POT for Mon to
                    // Thu (2.0, I-14), or the 2026-09-24 second pot for the
                    // nights ticked below.
                    brigadeForm.cookDays.includes(0) &&
                    brigadeForm.cookDays.length < 7 &&
                    html`<div class="sub">Sunday cooks</div>
                      <div class="chips wrapchips">
                        ${[
                          { key: "two", label: "Two pots: Sun and Mon, then Tue to Thu", batch: true, two: true },
                          { key: "one", label: "One pot for Mon to Thu", batch: true, two: false },
                          { key: "pick", label: "Pick the nights", batch: false, two: false },
                        ].map((o) => {
                          const on = o.batch
                            ? brigadeForm.sundayBatch && brigadeForm.sundayTwoPots === o.two
                            : !brigadeForm.sundayBatch;
                          return html`<button
                            key=${o.key}
                            class=${on ? "chip on" : "chip"}
                            aria-pressed=${on}
                            onClick=${() =>
                              setBrigadeForm(
                                !o.batch
                                  ? { ...brigadeForm, sundayBatch: false }
                                  : brigadeForm.sundayBatch
                                    ? { ...brigadeForm, sundayTwoPots: o.two }
                                    : {
                                        ...brigadeForm,
                                        sundayBatch: true,
                                        sundayTwoPots: o.two,
                                        // Mon to Thu eat Sunday's cooking, so they do not cook
                                        cookDays: brigadeForm.cookDays.filter((d) => d < 1 || d > 4),
                                        batchFeeds: [],
                                      },
                              )}
                          >
                            ${o.label}
                          </button>`;
                        })}
                      </div>
                      ${
                        brigadeForm.sundayBatch && brigadeForm.sundayTwoPots && twoPotSplit(brigadeForm.cookDays)
                          ? html`<p class="hint">
                                ${`Sunday cooks dinner for Sunday and ${dayList(twoPotSplit(brigadeForm.cookDays)?.a)}, and preps a second dish for ${dayList(twoPotSplit(brigadeForm.cookDays)?.b)}: everything except the meat.`}
                              </p>
                              <div class="sub">The second dish's meat</div>
                              <div class="chips wrapchips">
                                ${[
                                  { daily: false, label: `Cook it once, on ${WEEKDAYS[twoPotSplit(brigadeForm.cookDays)?.b[0] ?? 2]}` },
                                  { daily: true, label: "Cook it each night" },
                                ].map(
                                  (o) => html`<button
                                    key=${String(o.daily)}
                                    class=${brigadeForm.meatDaily === o.daily ? "chip on" : "chip"}
                                    aria-pressed=${brigadeForm.meatDaily === o.daily}
                                    onClick=${() => setBrigadeForm({ ...brigadeForm, meatDaily: o.daily })}
                                  >
                                    ${o.label}
                                  </button>`,
                                )}
                              </div>
                              <p class="hint">
                                ${
                                  brigadeForm.meatDaily
                                    ? "Each night cooks its own meat in about 15 minutes. The later nights' meat waits in the freezer."
                                    : "That night cooks all of the meat in about 15 to 20 minutes; the next nights reheat it."
                                }
                              </p>`
                          : brigadeForm.sundayBatch
                          ? html`<p class="hint">
                              ${(() => {
                                // the nights after Sunday that eat its pot: up
                                // to Thursday, stopping at the first cook night
                                /** @type {number[]} */
                                const fed = [];
                                for (let d = 1; d <= 4 && !brigadeForm.cookDays.includes(d); d++)
                                  fed.push(d);
                                const cooks = [1, 2, 3, 4].filter((d) => brigadeForm.cookDays.includes(d));
                                return fed.length === 0
                                  ? `Monday cooks, so Sunday's pot feeds no other night. Untick ${cookDaysLabel(cooks)} above for Sunday's dinner to be the batch.`
                                  : `Sunday cooks one pot, a dish that keeps and reheats, and ${cookDaysLabel(fed)} eat it. No second dish on Sunday.${cooks.length > 0 ? ` ${cookDaysLabel(cooks)} cook, so the pot stops there.` : ""}`;
                              })()}
                            </p>`
                          : html`<div class="sub">Sunday also cooks a batch for</div>
                              <div class="chips wrapchips">
                                ${ALL_DAYS.filter((d) => !brigadeForm.cookDays.includes(d)).map(
                                  (d) => html`
                                    <button
                                      key=${d}
                                      class=${brigadeForm.batchFeeds.includes(d) ? "chip on" : "chip"}
                                      aria-pressed=${brigadeForm.batchFeeds.includes(d)}
                                      onClick=${() =>
                                        setBrigadeForm({
                                          ...brigadeForm,
                                          batchFeeds: brigadeForm.batchFeeds.includes(d)
                                            ? brigadeForm.batchFeeds.filter((x) => x !== d)
                                            : [...brigadeForm.batchFeeds, d],
                                        })}
                                    >
                                      ${WEEKDAYS[d]}
                                    </button>
                                  `,
                                )}
                              </div>
                              <p class="hint">
                                ${
                                  brigadeForm.batchFeeds.length === 0
                                    ? "Optional. Tap the nights that should eat a second Sunday pot instead of Sunday's dinner."
                                    : `Sunday cooks two dishes: dinner, and a batch for ${cookDaysLabel([...brigadeForm.batchFeeds].sort())} that keeps in the fridge until then.`
                                }
                              </p>`
                      }
                      <label class="row">
                        <span>Sunday cooking: about</span>
                        <input
                          type="number"
                          inputmode="numeric"
                          min="1"
                          max="1440"
                          aria-label="Sunday cooking minutes"
                          value=${brigadeForm.sundayMinutes}
                          onInput=${(/** @type {any} */ e) =>
                            setBrigadeForm({ ...brigadeForm, sundayMinutes: e.currentTarget.value })}
                        />
                        <span>minutes</span>
                      </label>
                      <p class="hint">Rough is fine; tune later. Plan shows the week's Sunday against it.</p>`
                  }
                  <div class="chips wrapchips">
                    <button
                      class=${brigadeForm.dinnerMeat ? "chip on" : "chip"}
                      aria-pressed=${brigadeForm.dinnerMeat}
                      onClick=${() =>
                        setBrigadeForm({ ...brigadeForm, dinnerMeat: !brigadeForm.dinnerMeat })}
                    >
                      Every dinner has meat
                    </button>
                  </div>
                  <p class="hint">
                    ${
                      brigadeForm.dinnerMeat
                        ? "Every dinner is built on chicken, turkey, beef or pork. Fish and bean dinners sit out."
                        : "Optional. Tap it and bean-only, fish and vegetable dinners sit out."
                    }
                  </p>`
              }
              ${
                // NAMED RECIPES per shared slot (David, 2026-09-05: "breakfast
                // should just be variations of greek yogurt bowls"). Optional;
                // nothing ticked = the whole pool. Every member's screens still
                // apply.
                brigadeForm.slots.map((slot) => {
                  const options = (bankRecipes ?? []).filter(
                    (r) => r.mealType === slot && autoPlanEligible(r),
                  );
                  const chosen = brigadeForm.slotRecipes[slot] ?? [];
                  if (options.length === 0) return "";
                  // the plate screen against everyone in the rule (I-08)
                  const seated = brigadeForm.memberIds.map((id) => ({
                    id,
                    name: String((profiles ?? []).find((p) => p.id === id)?.name ?? id),
                    targets: ruleTargets[id],
                  }));
                  const checkOf = (/** @type {Record<string, any>} */ r) => ruleRecipeCheck(r, seated);
                  const slotLine = namedSlotLine(chosen, (id) => byId.get(id), checkOf);
                  return html`<details class="slotonly" key=${slot}>
                    <summary class="sub">
                      Only these ${SLOT_META[slot]?.full?.toLowerCase() ?? slot} recipes
                      <span class="hint">
                        ${chosen.length > 0 ? `${chosen.length} named` : "optional · none = the whole pool"}
                      </span>
                    </summary>
                    <div class="chips wrapchips">
                      ${options.map((r) => {
                        const c = checkOf(r);
                        // greyed, never hidden: a pick already named can
                        // still be unticked, and the reason is in view
                        const why =
                          c.blocked.length > 0
                            ? c.blocked.join(" · ")
                            : c.unchecked.length > 0
                              ? `not checked: ${c.unchecked.join(", ")}`
                              : "";
                        return html`
                          <button
                            key=${r.id}
                            class=${`${chosen.includes(r.id) ? "chip on" : "chip"}${why ? " blocked" : ""}`}
                            aria-pressed=${chosen.includes(r.id)}
                            aria-label=${why ? `${r.name}, ${why}` : undefined}
                            onClick=${() =>
                              setBrigadeForm({
                                ...brigadeForm,
                                slotRecipes: {
                                  ...brigadeForm.slotRecipes,
                                  [slot]: toggleIn(chosen, r.id),
                                },
                              })}
                          >
                            ${r.name}${why && html`<small class="why">${why}</small>`}
                          </button>
                        `;
                      })}
                    </div>
                  </details>
                  ${
                    // outside the fold: one dish every day is said whether
                    // or not the list is open
                    slotLine && html`<p class="hint" role="note" key=${`${slot}-line`}>${slotLine}</p>`
                  }`;
                })
              }
              <div class="sub">Who cooks and shops</div>
              <div class="chips wrapchips">
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
                // ONE LIST, ONE BUYER (David, 2026-10-18): taking turns moves
                // the cooking, never the shopping, so the shopper is picked
                // either way
                brigadeForm.rotateCooks &&
                html`<p class="hint">
                  The cook rotates day by day in the order people are listed above. The shopping
                  does not: one list, bought by the person below.
                </p>`
              }
              <select
                aria-label=${brigadeForm.rotateCooks ? "Who buys" : "Cook"}
                value=${brigadeForm.cookId}
                onChange=${(/** @type {any} */ e) =>
                  setBrigadeForm({ ...brigadeForm, cookId: e.currentTarget.value })}
              >
                ${brigadeForm.memberIds.map((id) => {
                  const p = (profiles ?? []).find((x) => x.id === id);
                  return html`<option key=${id} value=${id}>
                    ${p?.name ?? id}${brigadeForm.rotateCooks ? " buys" : ""}
                  </option>`;
                })}
              </select>
              <label class="row">
                <input
                  type="checkbox"
                  checked=${brigadeForm.open}
                  onChange=${(/** @type {any} */ e) =>
                    setBrigadeForm({ ...brigadeForm, open: e.currentTarget.checked })}
                />
                <span>No end date (off for Thanksgiving and winter break)</span>
              </label>
              <div class="row">
                <input
                  type="date"
                  aria-label="Starts"
                  min=${todayIso}
                  value=${brigadeForm.from}
                  onInput=${(/** @type {any} */ e) =>
                    setBrigadeForm({ ...brigadeForm, from: e.currentTarget.value })}
                />
                ${
                  !brigadeForm.open &&
                  html`<input
                    type="date"
                    aria-label="Ends"
                    min=${brigadeForm.from}
                    value=${brigadeForm.until}
                    onInput=${(/** @type {any} */ e) =>
                      setBrigadeForm({ ...brigadeForm, until: e.currentTarget.value })}
                  />`
                }
              </div>
              <p class="hint">
                ${brigadeForm.open
                  ? "It keeps going until you change it, and pauses for Purdue's Thanksgiving and winter breaks."
                  : "Without that box it runs up to four weeks, then you renew it."}
                Portions come from each person's own targets, so one pot serves different plates.
              </p>
              <div class="actions sticky-save">
                <button class="secondary" onClick=${cancelBrigadeForm}>CANCEL</button>
                <button
                  class="primary"
                  disabled=${brigadeForm.slots.includes("dinner") && brigadeForm.cookDays.length === 0}
                  onClick=${submitBrigade}
                >
                  ${brigadeForm.editId ? "SAVE" : "START"}
                </button>
              </div>
            </div>`
      }

      ${
        !isParked("dinnerchat") &&
        html`<div class="actions">
          <a class="secondary linkbtn" href="#/dinner">💬 what should dinner be? →</a>
        </div>`
      }
      ${
        // bottom of the page on purpose (David, 2026-08-09): the daily
        // check-offs moved to Crystal; remedies stay in Mise because they
        // cook from the pantry, but they don't lead the family page
        !isParked("remedies") &&
        html`<div class="actions wrap">
          <a class="secondary linkbtn remedy" href="#/remedies">feeling off? → remedies</a>
        </div>`
      }
    </div>
  `;
}
