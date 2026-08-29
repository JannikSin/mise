import { html, render } from "htm/preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { checkDataRepo, getToken, setToken, DATA_REPO, tokenBroken } from "./lib/github.js";
import {
  initStore,
  write,
  read,
  readCollection,
  readProfiles,
  activeProfile,
  getSyncStatus,
  onSyncChange,
  readTargetsOf,
  readTargetsMetaOf,
  writeTargetsOf,
  pathFor,
} from "./lib/store.js";
import { initRouter } from "./lib/router.js";
import { normalizeEquipment } from "./lib/equipment.js";
import { formatSyncTime, isoWeekId, localIsoDate, parseLocalIso, statusDate } from "./lib/dates.js";
import { applyScanItems } from "./lib/scan.js";
import { dinerFacts } from "./lib/annotate.js";
import { tailorTable, dinnerWeek, krogerConsumeRedirect } from "./lib/worker.js";
import { ProfileGateView } from "./views/profile-gate.js";
import { CookbookView } from "./views/cookbook.js";
import { RecipeView } from "./views/recipe.js";
import { RecipePeek } from "./views/recipe-peek.js";
import { SystemView } from "./views/system.js";
import { HallView } from "./views/hall.js";
import { TourOverlay, TourOffer } from "./views/tour.js";
import { readTourState, writeTourState } from "./lib/tour.js";
import { PlannerView } from "./views/planner.js";
import { ShoppingView } from "./views/shopping.js";
import { RemediesView } from "./views/remedies.js";
import { OccasionsView } from "./views/occasions.js";
import { MenuView } from "./views/menu.js";
import { AnnotateView } from "./views/annotate.js";
import { DinnerView } from "./views/dinner.js";
import { AskView } from "./views/ask.js";
import { TablesView } from "./views/tables.js";
import { ConfirmModal } from "./views/confirm-modal.js";
import { upsertDay } from "./lib/targets.js";
import {
  deriveShoppingList,
  applyJustBought,
  householdOthers,
  householdOf,
  pantryPathFor,
  inheritsLegacyPantry,
  ownItemToPantry,
  expirePerishables,
  mergeProfileLists,
  normalizePantry,
  normalizeShoppingList,
  emptyPantry,
  applySweep,
  substitutionPlan,
  clearReceiptRows,
  consumeForCook,
  PANTRY_LOCATIONS,
  withAutoUseSoon,
  removeFromPantry,
  pantryItems,
  packPantry,
  isDatedItem,
  sectionOf,
  slug,
} from "./lib/shopping.js";
import { applyReceipt, parsePackSize } from "./lib/prices.js";
import { normalizePins } from "./lib/kroger.js";
import { perishableCoverage } from "./lib/coverage.js";
import { composeWeekReview } from "./lib/review.js";
import { appendWaste } from "./lib/waste.js";
import { canonicalFood, toGrams } from "./lib/ingredients.js";
import { cookPlan } from "./lib/portions.js";
import {
  addEntry,
  removeEntryById,
  normalizePlan,
  switchCandidate,
  setEntryRecipe,
  recordCook,
  setCookComment,
  recipesById,
  shiftWeek,
  outEntryAt,
  entriesAt,
  slotMacroEstimate,
  buffetMacroEstimate,
  cycleSlotAway,
  datesOfWeek,
  saveFallback,
  restoreFallback,
  setPlanShopped,
  toggleEntryCooked,
  mergeRecipePool,
  recipeConflicts,
  SLOT_KEYS,
  planSwipes,
  weekRunSwipes,
  dailyCovered,
  leanWeekMenu,
  toggleSwipeEaten,
} from "./lib/plan.js";
import { generateWeek, generatorEligible, poolAdequacy } from "./lib/weekbuilder.js";
import { composeManifest, remanifest } from "./lib/manifest.js";
import { swapToFit } from "./lib/budget.js";
import {
  capacityCheck,
  coldLoad,
  drainDownDate,
  householdPathFor,
  normalizeHousehold,
} from "./lib/household.js";
import { weekAdherence, rankScoreboard } from "./lib/adherence.js";
import {
  normalizeEvents,
  eventsPathFor,
  deriveTables,
  mergeViewPlan,
  stripTableEntries,
  addTable,
  removeTable,
  patchSeat,
  setTableCooked,
  setTablePot,
  slotShareFor,
  guestSeats,
  GUEST_TARGETS,
  addBrigade,
  removeBrigade,
  materializeBrigade,
  setTableTailor,
  setTableSameForEveryone,
  setTableBuyer,
  setTableHead,
  setTableGuests,
  cookOf,
  brigadeTableId,
  seatServingsFor,
} from "./lib/tables.js";
import {
  applyOccasion,
  clearOccasion,
  datesOf as occasionDatesOf,
  shiftIso,
  tablesToLeave,
} from "./lib/occasions.js";
import { buildServe } from "./lib/serve.js";
import { freezePotString, parsePot, synthesize } from "./lib/synth.js";
import {
  normalizeLedger,
  ledgerPathFor,
  ledgerEntryFor,
  recordEntries,
  balancesFor,
  settleBetween,
} from "./lib/money.js";

export const APP = { name: "Mise", version: "0.3.0" };

/** @typedef {Awaited<ReturnType<typeof checkDataRepo>>} RepoStatus */

let checkGen = 0;

// Five tabs (David, 2026-07-25). Home only ever linked to Cook, and Cook and
// Plan showed the same week twice, so Plan absorbed Cook and Home retired.
// CARNET holds everything that is neither planning nor shopping: the daily
// check-in, the scanners, the chatbot, tables and brigades.
const TABS = [
  { hash: "#/plan", view: "plan", icon: "⬒", label: "Plan" },
  { hash: "#/list", view: "list", icon: "☑", label: "List" },
  { hash: "#/tables", view: "tables", icon: "◫", label: "Today" },
  { hash: "#/system", view: "system", icon: "☰", label: "Settings" },
];

function App() {
  // the active profile id. Declared FIRST because half the component reads it
  // and it depends on nothing; when it lived further down, a memo added above
  // it threw "Cannot access 'me' before initialization" and killed the app
  // for anyone whose household list was non-empty (2026-07-26).
  const me = activeProfile() ?? "david";
  const [route, setRoute] = useState(
    /** @type {{ view: string, id?: string, from?: string, servings?: number, entry?: string, table?: string }} */ ({
      view: "home",
    }),
  );
  const [online, setOnline] = useState(navigator.onLine);
  /** @type {[RepoStatus | null, (s: RepoStatus | null) => void]} */
  const [repo, setRepo] = useState(/** @type {RepoStatus | null} */ (null));
  const [hasToken, setHasToken] = useState(Boolean(getToken()));
  const [draft, setDraft] = useState("");
  /** @type {["installing" | "ready" | "failed", (s: "installing" | "ready" | "failed") => void]} */
  const [sw, setSw] = useState(/** @type {"installing" | "ready" | "failed"} */ ("installing"));
  const [sync, setSync] = useState(getSyncStatus());
  const [recipes, setRecipes] = useState(/** @type {Record<string, any>[]} */ ([]));
  // bank+own with no screens — identity lookups only (see the mergeRecipePool effect)
  const [allRecipes, setAllRecipes] = useState(/** @type {Record<string, any>[]} */ ([]));
  const [weekId, setWeekId] = useState(isoWeekId(new Date()));

  const [plan, setPlan] = useState(
    /** @type {{ week: string, entries: Record<string, any>[] }} */ ({ week: weekId, entries: [] }),
  );
  // mirrors of state for identity-stable callbacks. Declared beside the state
  // they track rather than further down: a handler defined ABOVE its ref reads
  // fine to a human and is a temporal dead zone to the engine.
  const planRef = useRef(plan);
  planRef.current = plan;
  const [targets, setTargets] = useState(/** @type {Record<string, any> | null} */ (null));

  // Kroger's consent redirect lands back here with the customer's tokens in
  // the URL FRAGMENT (never sent to a server). Consume it BEFORE the router
  // reads the hash, or the router sees `#kroger_access=...` as a route and
  // the link silently never completes — the exact "built but never called"
  // failure app/lib/synth.js is this repo's standing lesson about.
  const [krogerLinkNote, setKrogerLinkNote] = useState("");
  useEffect(() => {
    const r = krogerConsumeRedirect();
    if (r === "linked") setKrogerLinkNote("Kroger account linked — SEND TO CART is ready on List.");
    else if (r === "error")
      setKrogerLinkNote("Kroger sign-in did not complete. Try LINK KROGER again.");
  }, []);

  // KITCHEN EQUIPMENT (P6/P7). Writes the profile's own targets, so the
  // generator's pool filter and the "what would this unlock" counter both
  // read one declared list. Goes through writeTargetsOf, which writes the
  // canonical path and mirrors the legacy one.
  const handleSaveEquipment = useCallback(async (/** @type {string[]} */ owned) => {
    const me = activeProfile();
    const cur = /** @type {any} */ (await readTargetsOf(me)) ?? {};
    await writeTargetsOf(me, { ...cur, equipment: normalizeEquipment(owned) });
    setTargets(/** @type {any} */ (await readTargetsOf(me)));
  }, []);

  // NEVER SUGGEST THIS AGAIN (P3, P12). David, 2026-08-24, about a recipe the
  // generator kept buying $12 of dates for: "I don't need almond date flax
  // energy bites like what the fuck even is this."
  //
  // `targets.avoidRecipes` has been honoured by the pool filter since the
  // office-lunch-box incident, but NOTHING IN THE APP EVER WROTE IT -- its one
  // entry was put there by hand, which is the standing-rule failure exactly:
  // he could not remove a recipe he disliked without asking someone to edit
  // JSON for him.
  //
  // A toggle, not a delete. The recipe survives, so a hasty tap costs nothing
  // and the same button takes it back off the list.
  const handleAvoidRecipe = useCallback(
    async (/** @type {string} */ id, /** @type {boolean} */ avoid) => {
      const me = activeProfile();
      const cur = /** @type {any} */ (await readTargetsOf(me)) ?? {};
      const list = new Set(Array.isArray(cur.avoidRecipes) ? cur.avoidRecipes : []);
      if (avoid) list.add(id);
      else list.delete(id);
      await writeTargetsOf(me, { ...cur, avoidRecipes: [...list] });
      setTargets(/** @type {any} */ (await readTargetsOf(me)));
    },
    [],
  );

  // A COMPOSED DINING-HALL TRAY GOES ON THE PLAN AS A SWIPE (P10).
  // It is an `out` entry carrying the tray's own estimate, which is what
  // dayTotals already understands: the calories COUNT (he eats them) and the
  // protein counts toward the floor but not toward the money ceiling, because
  // a swipe costs no groceries. That split is the fix quake shipped.
  // A COMPOSED TRAY LANDS ON THE SLOT IT WAS PICKED FOR (P10).
  // Opened from a swipe placeholder, it REPLACES that placeholder's estimate
  // rather than adding a second entry beside it: the placeholder was always a
  // guess standing in for a real tray, and two entries would double-count the
  // day. Opened standalone, it appends to today.
  const handleHallTray = useCallback(
    async (
      /** @type {string} */ mealName,
      /** @type {any} */ tray,
      /** @type {string} */ court,
      /** @type {string} */ forDate,
      /** @type {string} */ forSlot,
    ) => {
      const slot =
        forSlot ||
        (String(mealName).toLowerCase().includes("breakfast")
          ? "breakfast"
          : String(mealName).toLowerCase().includes("dinner")
            ? "dinner"
            : "lunch");
      const date = forDate || localIsoDate(new Date());
      const week = isoWeekId(parseLocalIso(date));
      const path = pathFor(activeProfile(), `plans/${week}.json`);
      const cur = /** @type {any} */ (await read(path, { raw: true }).catch(() => null)) ?? {
        week,
        entries: [],
      };
      const label = `${court} ${mealName}: ${tray.picks.map((/** @type {any} */ p) => p.name).join(", ")}`;
      const est = {
        estCalories: Math.round(tray.calories),
        estProtein: Math.round(tray.protein),
      };
      const existing = (cur.entries ?? []).find(
        (/** @type {any} */ e) => e.date === date && e.slot === slot && e.out,
      );
      const next = existing
        ? {
            ...cur,
            entries: cur.entries.map((/** @type {any} */ e) =>
              e.id === existing.id
                ? { ...e, freeText: label, ...est, eatenAt: localIsoDate(new Date()) }
                : e,
            ),
          }
        : addEntry(cur, date, slot, {
            freeText: label,
            servings: 1,
            out: true,
            ...est,
            eatenAt: localIsoDate(new Date()),
          });
      await write(path, next, { raw: true });
      setKrogerLinkNote(
        `${existing ? "Filled in" : "Added to"} ${slot} on ${date}: ${est.estCalories} kcal, ${est.estProtein} g from ${court}.`,
      );
    },
    [],
  );

  useEffect(() => initRouter(setRoute), []);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) {
      setSw("failed");
      return;
    }
    // P4: when a deploy's new SW takes over (skipWaiting+claim fire
    // controllerchange), reload once so the page never keeps running a
    // half-old module graph — the stale-mix that used to need two hard
    // reloads. Guard: only when a controller existed before (an update,
    // not the very first install) and only once.
    if (navigator.serviceWorker.controller) {
      let reloaded = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (reloaded) return;
        reloaded = true;
        location.reload();
      });
    }
    navigator.serviceWorker
      .register("./sw.js")
      .then(() => navigator.serviceWorker.ready)
      .then(() => setSw("ready"))
      .catch(() => setSw("failed"));
  }, []);

  useEffect(() => {
    initStore();
    return onSyncChange(() => setSync(getSyncStatus()));
  }, []);

  // recipes: cached-first, refreshed whenever sync activity changes the
  // cache. Recipe-bank pilot: every profile's pool = shared bank (root
  // recipes/, phases-filtered) + its own scoped recipes (override by id).
  // For david the two reads are the same directory, so the merge is a no-op.
  const [bankRecipes, setBankRecipes] = useState(/** @type {Record<string, any>[]} */ ([]));
  const [ownRecipes, setOwnRecipes] = useState(/** @type {Record<string, any>[]} */ ([]));
  useEffect(() => {
    let alive = true;
    const load = () => {
      readCollection("recipes", { raw: true }).then((r) => {
        if (alive) setBankRecipes(r);
      });
      if (activeProfile() === "david") {
        setOwnRecipes([]);
      } else {
        readCollection("recipes").then((r) => {
          if (alive) setOwnRecipes(r);
        });
      }
    };
    load();
    const unsub = onSyncChange(load);
    return () => {
      alive = false;
      unsub();
    };
  }, [hasToken]);

  useEffect(() => {
    setRecipes(
      mergeRecipePool(
        bankRecipes,
        ownRecipes,
        targets?.phase,
        targets?.avoidIngredients,
        targets?.diet,
        targets?.avoidRecipes,
      ),
    );
    // IDENTITY pool: bank+own merged with PREFERENCE screens off but SAFETY
    // screens ON. Phase and avoidRecipes govern what is PICKABLE, never what
    // an existing plan entry means — resolving a planned recipe through the
    // fully screened pool made a newly banned recipe silently vanish from
    // the shopping list and hand cook mode a null. But diet/avoidIngredients
    // are allergy-class: a recipe that newly fails them must NOT keep being
    // shopped and cooked through this pool (Red Team R4) — for those, the
    // old vanish-everywhere behavior is the safe direction.
    setAllRecipes(
      mergeRecipePool(bankRecipes, ownRecipes, undefined, targets?.avoidIngredients, targets?.diet),
    );
  }, [bankRecipes, ownRecipes, targets]);

  // this week's plan: cached-first, refreshed on sync activity
  useEffect(() => {
    let alive = true;
    const load = () => {
      read(`plans/${weekId}.json`).then((p) => {
        if (alive) setPlan(normalizePlan(p, weekId));
      });
    };
    load();
    const unsub = onSyncChange(load);
    return () => {
      alive = false;
      unsub();
    };
  }, [weekId, hasToken]);

  // Tables (docs/tables-design.md): every house's events.json, cached-first,
  // refreshed on sync activity. A guest seated at another house's table
  // needs THAT house's file, so all houses load (a tiny in-repo set).
  const [houseEvents, setHouseEvents] = useState(
    /** @type {{ house: string, events: import("./lib/tables.js").HouseEvents }[]} */ ([]),
  );
  const [allProfiles, setAllProfiles] = useState(/** @type {Record<string, any>[]} */ ([]));
  // CAPABILITIES (council 2026-08-02, shaped like targets.tracks): the list
  // of extra surfaces this profile HAS. Absent = everything (David, legacy
  // installs). The family defaults to [] — plan, list, dinners, settings,
  // and nothing else. Values consumed today: "scoreboard", "money"
  // ("checkin" retired 2026-08-09 — tracking lives in Crystal, the value is
  // ignored). Hand-edited in profiles.json; no SYS UI until a second
  // household needs one.
  const myCaps = /** @type {string[] | undefined} */ (
    allProfiles.find((p) => p.id === me)?.capabilities
  );
  const hasCap = (/** @type {string} */ c) => !Array.isArray(myCaps) || myCaps.includes(c);

  const allProfilesRef = useRef(allProfiles);
  allProfilesRef.current = allProfiles;
  useEffect(() => {
    let alive = true;
    const load = () => {
      void (async () => {
        const prof = await readProfiles();
        if (!alive) return;
        setAllProfiles(prof.profiles);
        const houses = [
          ...new Set(prof.profiles.map((p) => /** @type {string} */ (p.household ?? "home"))),
        ];
        const loaded = await Promise.all(
          houses.map(async (house) => ({
            house,
            events: normalizeEvents(
              /** @type {any} */ (
                await read(eventsPathFor(house), { raw: true }).catch(() => null)
              ),
            ),
          })),
        );
        if (alive) setHouseEvents(loaded);
      })();
    };
    load();
    const unsub = onSyncChange(load);
    return () => {
      alive = false;
      unsub();
    };
  }, [hasToken]);

  // shopping list + pantry: cached-first, refreshed on sync activity
  const [shopping, setShopping] = useState(
    /** @type {import("./lib/shopping.js").ShoppingList} */ ({ items: [] }),
  );
  const [pantry, setPantry] = useState(
    /** @type {Record<string, any>} */ ({ staples: [], perishables: [] }),
  );

  const shoppingRef = useRef(shopping);
  shoppingRef.current = shopping;
  const pantryRef = useRef(pantry);
  pantryRef.current = pantry;
  // resolved households/<h>/pantry.json once profiles load; null until then
  const pantryPathRef = useRef(/** @type {string | null} */ (null));

  const [listLoaded, setListLoaded] = useState(false);
  const [priceCatalogue, setPriceCatalogue] = useState(
    /** @type {import("./lib/prices.js").PriceCatalogue | null} */ (null),
  );
  // ingredient→UPC pins per store (data-repo root, fix list 3.2/PF.3): the
  // ledger's identity file. Normalized-empty until pins.json loads/exists.
  const [pins, setPins] = useState(/** @type {import("./lib/kroger.js").PinBook | null} */ (null));

  useEffect(() => {
    let alive = true;
    const load = () => {
      read("shopping.json").then((s) => {
        if (!alive) return;
        // re-key onto the canonical ingredient ids before anything merges or
        // ticks: ids are the 409 merge key across every device in the house
        if (s) setShopping(/** @type {any} */ (normalizeShoppingList(/** @type {any} */ (s))));
        setListLoaded(true);
      });
      // pantry is HOUSEHOLD-shared (B2): one kitchen, one fridge, one file at
      // households/<h>/pantry.json. The path derives from profiles.json every
      // load, so moving household in Settings re-points you on the next sync tick
      // (B3). Pre-B2 per-profile pantries are read as a fallback and seeded
      // into the household file once, so no data is lost and old devices
      // keep limping on the legacy path until they update.
      //
      // THE SEED IS SCOPED TO THE PRE-B2 HOUSEHOLD (David, 2026-08-26). It used
      // to fire for ANY household with no file yet, which made a one-time
      // migration into a permanent trap: moving into the Wayne house created
      // households/wayne/pantry.json by COPYING the old house's legacy pantry,
      // so a kitchen whose shelves were bare reported 52 staples — white rice,
      // oats, whey protein — at "plenty", and the shopping list then refused to
      // buy the things that were not there. A DECLARED HOUSEHOLD IS A NEW
      // KITCHEN AND STARTS EMPTY. Only the undeclared default, which is what a
      // pre-B2 profile resolves to, describes the same kitchen the legacy file
      // did, so only that one inherits it.
      void (async () => {
        const prof = await readProfiles();
        if (!alive) return;
        const house = householdOf(prof.profiles, activeProfile());
        const path = pantryPathFor(house);
        pantryPathRef.current = path;
        let src = /** @type {Record<string, any> | null} */ (await read(path, { raw: true }));
        if (!alive) return;
        if (!src && inheritsLegacyPantry(house)) {
          const legacy = /** @type {Record<string, any> | null} */ (await read("pantry.json"));
          if (!alive) return;
          if (
            legacy &&
            ((legacy.staples ?? []).length > 0 || (legacy.perishables ?? []).length > 0)
          ) {
            src = legacy;
            void write(path, legacy, { raw: true });
          }
        }
        if (!src) return;
        // drop perishables past their shelf life on the way in (a 2-week-old
        // bag of spinach or a week-old chicken breast leaves on its own); if
        // anything expired, persist the trimmed pantry. normalizePantry first:
        // pre-P1 perishables self-heal stable ids (persisted on next write)
        const {
          pantry: fresh,
          expired,
          tossed,
        } = expirePerishables(normalizePantry(src), localIsoDate(new Date()));
        setPantry(fresh);
        if (expired.length > 0) {
          pantryRef.current = fresh;
          void write(path, fresh, { raw: true });
          // the waste ledger (PF.1): expiry is a WRITE-OFF, never a silent
          // delete — P11's tossed-vs-used axis reads these, and the history
          // cannot be backfilled. Sibling file to the household pantry.
          void (async () => {
            const wastePath = path.replace(/pantry\.json$/, "waste.json");
            const prior = /** @type {Record<string, any> | null} */ (
              await read(wastePath, { raw: true })
            );
            await write(wastePath, appendWaste(prior, tossed, localIsoDate(new Date())), {
              raw: true,
            });
          })();
        }
      })();
      // shared price catalogue (data-repo root, never profile-scoped)
      read("prices.json", { raw: true }).then((p) => {
        if (alive && p) setPriceCatalogue(/** @type {any} */ (p));
      });
      // ingredient→UPC pins (data-repo root, shared like the catalogue)
      read("pins.json", { raw: true }).then((p) => {
        if (alive) setPins(normalizePins(p));
      });
    };
    load();
    const unsub = onSyncChange(load);
    return () => {
      alive = false;
      unsub();
    };
  }, [hasToken]);

  // Latest-value refs, declared up here with inert initials and assigned
  // further down where their values exist. They are read ONLY inside
  // callbacks, so the initial value is never observed — and declaring them
  // early is what lets the handlers that read them sit above their sources
  // without a temporal dead zone (2026-07-26).
  const viewPlanRef = useRef(/** @type {any} */ (null));
  const tableDerivedRef = useRef(
    /** @type {any} */ ({
      entries: [],
      conflicts: [],
      collisions: [],
      cookExtras: [],
      allCookExtras: [],
    }),
  );
  const recentRecipeIdsRef = useRef(/** @type {string[]} */ ([]));
  const weekRef = useRef(weekId);
  weekRef.current = weekId;

  // The live inputs the P1 manifest refresh needs. Kept in one box declared
  // here so the single plan-write point below can stay the single write point:
  // targets, recipes and the daily log are all set up hundreds of lines later,
  // and hoisting three pieces of state to satisfy one callback would be the
  // tail wagging the dog. Filled on every render, just below where they exist.
  const manifestInputs = useRef(
    /** @type {{
     *   targets: Record<string, any> | null,
     *   recipes: Record<string, any>[],
     *   dailyDays: Record<string, any>[],
     *   catalogue: Record<string, any> | null,
     *   waste: Record<string, any> | null,
     *   household: ReturnType<typeof normalizeHousehold> | null
     * }} */ ({
      targets: null,
      recipes: [],
      dailyDays: [],
      catalogue: null,
      waste: null,
      household: null,
    }),
  );

  const updatePlan = useCallback(
    (/** @type {{ week: string, entries: Record<string, any>[] }} */ next) => {
      // the ONE strip point: derived table entries (generateWeek receives
      // the merged viewPlan, whose pinned table entries would otherwise
      // survive into the write) live in events.json, never in a plan file
      let clean = { ...next, entries: stripTableEntries(next.entries) };
      // P1, re-checked after EVERY edit (2026-08-19, session koenig). The
      // stored manifest described the week as generated, so any edit after
      // that — an away toggle, a switched meal, a serving change — left the
      // Plan tab reporting a week that no longer existed. Doing this at the
      // one write point rather than in each handler is the point: the next
      // handler somebody adds gets it for free.
      if (/** @type {any} */ (clean).manifest) {
        clean = /** @type {any} */ ({
          ...clean,
          manifest: remanifest(/** @type {any} */ (clean).manifest, {
            plan: clean,
            targets: manifestInputs.current.targets,
            recipes: manifestInputs.current.recipes,
            dailyDays: manifestInputs.current.dailyDays,
            todayIso: localIsoDate(new Date()),
          }),
        });
      }
      planRef.current = clean;
      setPlan(clean); // optimistic: instant UI, then queue+flush via the store
      void write(`plans/${weekRef.current}.json`, clean);
    },
    [],
  );

  const withCookExtras = useCallback((/** @type {import("./lib/plan.js").Plan} */ p) => {
    const weekSet = new Set(datesOfWeek(p.week));
    const extras = tableDerivedRef.current.cookExtras.filter((/** @type {any} */ x) =>
      weekSet.has(x.date),
    );
    return extras.length > 0
      ? {
          ...p,
          entries: [
            ...p.entries,
            .../** @type {any[]} */ (extras.map((/** @type {any} */ x) => ({ ...x }))),
          ],
        }
      : p;
  }, []);

  const updateShopping = useCallback(
    (/** @type {import("./lib/shopping.js").ShoppingList} */ next) => {
      shoppingRef.current = next;
      setShopping(next);
      void write("shopping.json", /** @type {any} */ (next));
    },
    [],
  );

  const updatePantry = useCallback((/** @type {Record<string, any>} */ next) => {
    pantryRef.current = next;
    setPantry(next);
    const path = pantryPathRef.current;
    if (path) {
      void write(path, next, { raw: true });
      return;
    }
    // Profiles have not resolved yet, so the household is not known. This used
    // to fall back to the legacy per-profile `pantry.json`, which since B2 is a
    // DIFFERENT KITCHEN: a scan landing there is lost from this household and
    // injected into another one (David, 2026-08-26). Resolve the household
    // first instead — the read is cache-first, so the write is late by
    // milliseconds rather than misfiled forever.
    void (async () => {
      const prof = await readProfiles();
      const resolved = pantryPathFor(householdOf(prof.profiles, activeProfile()));
      pantryPathRef.current = resolved;
      void write(resolved, next, { raw: true });
    })();
  }, []);

  // in-app confirm (roadmap A2): one modal at the App root replaces every
  // window.confirm. askConfirm(message) resolves true on OK, false on
  // CANCEL/Escape/overlay tap; only one question can be pending at a time
  // (a second ask while one is open auto-cancels the first).
  const [confirmAsk, setConfirmAsk] = useState(
    /** @type {{ message: string, resolve: (ok: boolean) => void } | null} */ (null),
  );
  const askConfirm = useCallback((/** @type {string} */ message) => {
    return new Promise((/** @type {(ok: boolean) => void} */ resolve) => {
      setConfirmAsk((prev) => {
        prev?.resolve(false);
        return { message, resolve };
      });
    });
  }, []);
  const settleConfirm = useCallback((/** @type {boolean} */ ok) => {
    setConfirmAsk((prev) => {
      prev?.resolve(ok);
      return null;
    });
  }, []);

  // undo toast (roadmap G3): destructive actions restore with one tap for
  // 5 seconds instead of interrogating first — more forgiving than a
  // confirm, per the 2026-07-12 Tribunal. One toast at a time; a new one
  // replaces the old (the old restore is simply gone, same as timing out).
  const [undoToast, setUndoToast] = useState(
    /** @type {{ message: string, restore: () => void } | null} */ (null),
  );
  useEffect(() => {
    if (!undoToast) return;
    const t = setTimeout(() => setUndoToast(null), 5000);
    return () => clearTimeout(t);
  }, [undoToast]);

  // hard reset the list: wipe items AND the carried-over ticks/manual adds
  // from the last trip, so BUILD repopulates from a clean slate. No confirm:
  // the undo toast is the safety net (G3 — forgiveness beats interrogation).
  const handleClearList = useCallback(() => {
    const prev = shoppingRef.current;
    if ((prev.items ?? []).length === 0) return;
    updateShopping({ items: [] });
    setUndoToast({ message: "list cleared", restore: () => updateShopping(prev) });
  }, [updateShopping]);

  // remove a pantry entry outright (mis-added chicken, a staple you dropped)
  const handleRemovePantry = useCallback(
    (/** @type {"staple" | "perishable"} */ kind, /** @type {string} */ key) => {
      const prev = pantryRef.current;
      const gone = pantryItems(prev).find((/** @type {any} */ it) => it.id === key)?.food;
      void kind;
      updatePantry(removeFromPantry(prev, kind, key));
      setUndoToast({
        message: `removed ${gone ?? "item"}`,
        restore: () => updatePantry(prev),
      });
    },
    [updatePantry],
  );

  // combined household list: the OTHER profiles' shopping files, read raw
  // (unscoped) so one person can run the whole family's store trip
  /** @type {(id: string) => string} */
  const shoppingPathFor = (id) =>
    id === "david" ? "shopping.json" : `profiles/${id}/shopping.json`;

  // Has ANYONE in the house confirmed groceries for this week? A brigade has
  // one cook and one receipt, so a gate keyed to each profile own plan would
  // hide every instruction from the three people who never scan anything.
  // Read-only, same raw-path pattern as the combined shopping lists.
  const [houseShopped, setHouseShopped] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = () => {
      readProfiles().then(async (p) => {
        if (!alive) return;
        const mates = householdOthers(p.profiles, me);
        for (const pr of mates) {
          const path =
            pr.id === "david" ? `plans/${weekId}.json` : `profiles/${pr.id}/plans/${weekId}.json`;
          const theirs = /** @type {any} */ (await read(path, { raw: true }).catch(() => null));
          if (theirs?.shoppedAt) {
            if (alive) setHouseShopped(true);
            return;
          }
        }
        if (alive) setHouseShopped(false);
      });
    };
    load();
    const unsub = onSyncChange(load);
    return () => {
      alive = false;
      unsub();
    };
  }, [hasToken, weekId]);

  const [otherLists, setOtherLists] = useState(
    /** @type {{ profileId: string, name: string, emoji: string, list: import("./lib/shopping.js").ShoppingList, plan?: import("./lib/plan.js").Plan | null }[]} */ ([]),
  );
  const otherListsRef = useRef(otherLists);
  otherListsRef.current = otherLists;
  const [ownEmoji, setOwnEmoji] = useState("");

  useEffect(() => {
    let alive = true;
    const me = activeProfile();
    const load = () => {
      readProfiles().then((p) => {
        const self = p.profiles.find((pr) => pr.id === me);
        if (alive && self?.emoji) setOwnEmoji(self.emoji);
        // same household only: Laurie's solo-apartment list never mixes
        // into the home HOUSEHOLD trip (and vice versa)
        const others = householdOthers(p.profiles, me);
        if (others.length === 0) {
          if (alive) setOtherLists([]);
          return;
        }
        Promise.all(
          others.map(async (pr) => ({
            profileId: pr.id,
            name: pr.name,
            emoji: pr.emoji,
            // same re-key as our own list: the household merge compares ids
            // across profiles, so both sides must be on the canonical scheme
            list: /** @type {any} */ (
              normalizeShoppingList(
                /** @type {any} */ (
                  (await read(shoppingPathFor(pr.id), { raw: true })) ?? { items: [] }
                ),
              )
            ),
            // their week plan too, read-only (same raw-path pattern as
            // houseShopped): the HOUSEHOLD tab re-derives a person's trip
            // contribution from it when only SOME of their days are shopped
            plan: /** @type {any} */ (
              await read(
                pr.id === "david"
                  ? `plans/${weekId}.json`
                  : `profiles/${pr.id}/plans/${weekId}.json`,
                { raw: true },
              ).catch(() => null)
            ),
          })),
        ).then((ls) => {
          if (alive) setOtherLists(ls);
        });
      });
    };
    load();
    const unsub = onSyncChange(load);
    return () => {
      alive = false;
      unsub();
    };
  }, [hasToken, weekId]);

  // receipt → catalogue freshness loop: merge the reviewed receipt lines into
  // the shared prices.json (raw, root file) and persist. Real receipt prices
  // overwrite the estimates for that store.
  const handleReceiptApprove = useCallback(
    (
      /** @type {string} */ store,
      /** @type {{ name: string, price: number, size: string }[]} */ lines,
    ) => {
      const today = localIsoDate(new Date());
      const me = activeProfile();
      const prevPlan = /** @type {import("./lib/plan.js").Plan} */ (planRef.current);
      // the receipt IS the groceries-bought confirmation (honest-state rule):
      // it unlocks the week's cook reminders and the eaten tracking. Its trip
      // total is the spend leg of the one ledger (PF.3): recorded on the
      // plan, so spent-vs-budgeted stops being estimates-only.
      const tripSpend =
        Math.round(lines.reduce((s, l) => s + (Number(l.price) || 0), 0) * 100) / 100;
      // the receipt IS proof of shopping, so it also guarantees the fallback
      // exists (7.2): a user who skips GOING TO THE STORE and scans straight
      // at the till still gets the shopped plan saved before anything can
      // reshape it (diff review 2026-08-19)
      const shoppedBase = prevPlan.fallback ? prevPlan : saveFallback(prevPlan, today);
      updatePlan(
        setPlanShopped(
          shoppedBase,
          today,
          tripSpend > 0 ? { store, date: today, total: tripSpend } : null,
        ),
      );
      // the trip is DONE: every row the till confirms (plus anything ticked in
      // the aisle) leaves the list and lands on a shelf. A fully-bought list
      // ends up empty, which is the whole point — the list is a to-do, not a
      // record of what you own.
      // BANK ONCE, FROM THE MERGED TRIP (Tribunal BLOCK, 2026-08-01). The
      // HOUSEHOLD tab the shopper walked is everyone's lists SUMMED, minus the
      // shared pantry once; the pantry must gain exactly what that trip
      // bought. Banking from this profile's own rows alone recorded a
      // fraction (or nothing) of the food now physically in the fridge, and
      // fridge-first then re-bought it every week. A row ticked by ANY
      // source counts bought — the HOUSEHOLD tick writes through to all.
      const prevShopping = shoppingRef.current;
      const prevPantry = pantryRef.current;
      const prevOthers = otherListsRef.current;
      // a row counts BOUGHT per source list: till-confirmed, or ticked in
      // that list itself. Merging first and then marking any-source-checked
      // over-banked (Tribunal B2): a row David ticked on his solo tab that
      // the receipt never read would have banked all four portions while
      // three of them stayed on housemates' lists.
      const onReceipt = new Set((lines ?? []).map((l) => canonicalFood(l.name)));
      const boughtOf = (/** @type {import("./lib/shopping.js").ShoppingList} */ list) => ({
        items: (list.items ?? []).filter((i) => i.checked || onReceipt.has(canonicalFood(i.food))),
      });
      const mergedTrip = {
        generatedFrom: prevShopping.generatedFrom,
        items: mergeProfileLists([
          { profileId: me, list: boughtOf(prevShopping) },
          ...prevOthers.map((o) => ({ profileId: o.profileId, list: boughtOf(o.list) })),
        ]).map((i) => ({ ...i, checked: true, manual: false })),
      };
      const stocked = applyJustBought(mergedTrip, prevPantry, today, { fridgeFirst: true });
      // receipt lines NO list carried are still food that entered the kitchen
      // (PF.3: "receipt says bought, pantry says absent" was a live identity
      // hole). Bank them too: a state-tracked pantry item flips to plenty, an
      // unknown food lands as a dated row with the receipt's pack size.
      const listKeys = new Set(mergedTrip.items.map((i) => canonicalFood(i.food)));
      const strayLines = (lines ?? []).filter((l) => !listKeys.has(canonicalFood(l.name)));
      const strayRows = strayLines.map((l, n) => {
        const pack = parsePackSize(l.size);
        return {
          id: `receipt-${today}-${n}`,
          food: l.name,
          qty: pack?.qty ?? 1,
          unit: pack?.unit ?? "each",
          section: sectionOf(l.name),
          checked: true,
          manual: true,
        };
      });
      const banked =
        strayRows.length > 0
          ? applyJustBought({ items: strayRows }, stocked.pantry, today)
          : stocked;
      updatePantry(banked.pantry);
      // every list — mine included — clears the till-confirmed rows the same
      // way; banking already happened once, above, from the merged sum
      const mine = clearReceiptRows(prevShopping, lines);
      if (mine.changed) updateShopping(mine.list);
      let nextOthers = prevOthers;
      /** @type {string[]} */
      const clearedNames = [];
      for (const o of prevOthers) {
        const { list: cleared, changed } = clearReceiptRows(o.list, lines);
        if (!changed) continue;
        clearedNames.push(o.name || o.profileId);
        nextOthers = nextOthers.map((x) =>
          x.profileId === o.profileId ? { ...x, list: cleared } : x,
        );
        void write(shoppingPathFor(o.profileId), /** @type {any} */ (cleared), { raw: true });
      }
      if (nextOthers !== prevOthers) {
        otherListsRef.current = nextOthers;
        setOtherLists(nextOthers);
      }
      // PRICE LEARNING runs before the toast so its outcome can be reported in
      // the same message. It used to run after, and to bail silently when the
      // catalogue had not loaded, so a scan with no signal taught the app
      // nothing while the toast still said "applied". Silence here is exactly
      // why receipts felt like a no-op for weeks.
      let priceNote;
      const cat = priceCatalogue;
      // captured for undo: price learning writes the SHARED prices.json
      // immediately, so the undo tap must put the old catalogue back too — a
      // misread receipt otherwise poisons every household member's totals
      // (diff review, 2026-08-19)
      const prevCat = priceCatalogue;
      let catChanged = false;
      if (!cat) {
        priceNote = " (prices not learned: price list not loaded)";
      } else {
        const {
          catalogue: next,
          applied,
          added,
          unmatched,
        } = applyReceipt(cat, store, lines, today);
        setPriceCatalogue(next);
        catChanged = true;
        void write("prices.json", /** @type {any} */ (next), { raw: true });
        priceNote =
          ` — prices: ${applied.length} updated, ${added.length} new` +
          (unmatched.length ? `, ${unmatched.length} unreadable` : "");
      }
      // name the blast radius and keep an exit: this tap edited other
      // people's lists, banked the shared pantry, and confirmed the week as
      // shopped — undo covers all of it even when no other list changed
      {
        setUndoToast({
          message:
            (clearedNames.length > 0
              ? `receipt cleared ${clearedNames.join(", ")}'s list${clearedNames.length === 1 ? "" : "s"} too`
              : "receipt applied — list, pantry and week updated") + priceNote,
          restore: () => {
            updatePlan(prevPlan); // un-confirms shoppedAt — the receipt was a mistake
            updateShopping(prevShopping);
            updatePantry(prevPantry);
            if (catChanged && prevCat) {
              // the learned prices were already pushed; put the old book back
              setPriceCatalogue(prevCat);
              void write("prices.json", /** @type {any} */ (prevCat), { raw: true });
            }
            otherListsRef.current = prevOthers;
            setOtherLists(prevOthers);
            for (const o of prevOthers) {
              void write(shoppingPathFor(o.profileId), /** @type {any} */ (o.list), { raw: true });
            }
          },
        });
      }
    },
    // updatePlan/planRef are declared later in this component but are
    // identity-stable; referencing them in the body (call time) is safe,
    // only the dep array must not touch them (TDZ at definition time)
    [priceCatalogue, updateShopping, updatePantry],
  );

  // persist the shared pins book / price catalogue (Kroger loop, Tier 3):
  // the shopping view runs the searches, these write the results home
  const handleSavePins = useCallback((/** @type {import("./lib/kroger.js").PinBook} */ next) => {
    setPins(next);
    void write("pins.json", /** @type {any} */ (next), { raw: true });
  }, []);
  const handleSavePrices = useCallback(
    (/** @type {import("./lib/prices.js").PriceCatalogue} */ next) => {
      setPriceCatalogue(next);
      void write("prices.json", /** @type {any} */ (next), { raw: true });
    },
    [],
  );

  // ticking a combined item buys it for EVERYONE who wants it: write through
  // to every source profile's own list (active via updateShopping, others raw).
  // The write carries the SOURCE's qty, not the stored row's: when a member's
  // trip contribution was narrowed to some days, their stored row still holds
  // the whole week's amount, and checking that amount would later bank the
  // unbought remainder into the shared pantry at the receipt step. A row the
  // stored list no longer has (their plan changed after their last build) is
  // appended, so an aisle tick is never a silent no-op.
  const handleCombinedToggle = useCallback(
    (
      /** @type {string} */ itemId,
      /** @type {{ profileId: string, checked: boolean, qty?: number, unit?: string, food?: string, section?: string }[]} */ sources,
    ) => {
      const me = activeProfile();
      const target = !sources.every((s) => s.checked);
      /** @type {(list: import("./lib/shopping.js").ShoppingList, src: (typeof sources)[number]) => import("./lib/shopping.js").ShoppingList} */
      const applyTick = (list, src) => {
        const items = list.items ?? [];
        const has = items.some((i) => i.id === itemId);
        if (!target) {
          // UNTICK only restores: checked off, and the narrowed-tick qty put
          // back from weekQty. It never rewrites amounts or appends rows — a
          // mis-tap must not edit anyone's week.
          return {
            ...list,
            items: items.map((i) => {
              if (i.id !== itemId) return i;
              // statement-level cast: prettier reflows inline casts inside a
              // spread into a shape tsc rejects (broke once, 2026-08-16)
              const weekQty = /** @type {any} */ (i).weekQty;
              return {
                ...i,
                checked: false,
                ...(weekQty ? { qty: weekQty, weekQty: undefined } : {}),
              };
            }),
          };
        }
        return {
          ...list,
          items: has
            ? items.map((i) =>
                i.id === itemId
                  ? {
                      ...i,
                      checked: true,
                      // a narrowed contribution bought LESS than their stored
                      // week row: record the bought amount (so the receipt
                      // banks the truth) and stash the week total in weekQty
                      // for the untick restore
                      ...(src.qty && src.qty < i.qty ? { weekQty: i.qty, qty: src.qty } : {}),
                    }
                  : i,
              )
            : src.qty && src.food
              ? [
                  ...items,
                  {
                    id: itemId,
                    food: src.food,
                    qty: src.qty,
                    unit: src.unit ?? "x",
                    section: src.section ?? sectionOf(src.food),
                    checked: true,
                    manual: false,
                  },
                ]
              : items,
        };
      };
      for (const src of sources) {
        if (src.profileId === me) {
          updateShopping(applyTick(shoppingRef.current, src));
        } else {
          const entry = otherListsRef.current.find((o) => o.profileId === src.profileId);
          if (!entry) continue;
          const nextList = applyTick(entry.list, src);
          const nextOthers = otherListsRef.current.map((o) =>
            o.profileId === src.profileId ? { ...o, list: nextList } : o,
          );
          otherListsRef.current = nextOthers;
          setOtherLists(nextOthers);
          void write(shoppingPathFor(src.profileId), /** @type {any} */ (nextList), { raw: true });
        }
      }
    },
    [updateShopping],
  );

  // The daily check-in row and the calorie targets, cached-first. The lifting
  // half of this block left with the Train tab on 2026-08-18. fitness/daily.json
  // keeps its legacy path and is now SHARED with anvil, which writes sleep,
  // weight and pushups into the same row Mise writes water, supplements and the
  // daily dozen into; both go through the same sha-and-merge path, so a
  // field-wise merge keeps them from clobbering each other.
  const [dailyLog, setDailyLog] = useState(
    /** @type {{ days: Record<string, any>[] }} */ ({ days: [] }),
  );

  useEffect(() => {
    let alive = true;
    const load = () => {
      read("fitness/daily.json").then((d) => {
        if (alive && d) setDailyLog(/** @type {any} */ (d));
      });
      readTargetsOf(activeProfile()).then((t) => {
        if (alive && t) setTargets(/** @type {any} */ (t));
      });
    };
    load();
    const unsub = onSyncChange(load);
    return () => {
      alive = false;
      unsub();
    };
  }, [hasToken]);

  const dailyRef = useRef(dailyLog);
  dailyRef.current = dailyLog;

  const handlePatchDay = useCallback((/** @type {Record<string, any>} */ patch) => {
    const next = upsertDay(/** @type {any} */ (dailyRef.current), localIsoDate(new Date()), patch);
    dailyRef.current = next;
    setDailyLog(next);
    void write("fitness/daily.json", /** @type {any} */ (next));
  }, []);

  const recipesRef = useRef(recipes);
  recipesRef.current = recipes;
  const bankRecipesRef = useRef(bankRecipes);
  bankRecipesRef.current = bankRecipes;
  const allRecipesRef = useRef(allRecipes);
  allRecipesRef.current = allRecipes;

  // id → recipe map for the shopping view's HOUSEHOLD tab, which re-derives a
  // member's partial-week trip contribution with deriveShoppingList. Built
  // from the UNSCREENED shared bank plus my pool: my own diet/avoid screen
  // must not hide a housemate's recipe from THEIR trip derivation. (Their
  // profile-scoped personal recipes can still miss; the view refuses to
  // narrow and says so rather than dropping meals.)
  const recipeIndex = useMemo(
    () => recipesById([...bankRecipes, ...allRecipes]),
    [bankRecipes, allRecipes],
  );

  /**
   * fromDate for deriveShoppingList: only the CURRENT calendar week filters
   * already-eaten days. A past week must derive in full (undefined), or its
   * every entry would be filtered and a stray build from a browsed-back week
   * would wipe the one global shopping list. Future weeks are unaffected
   * either way.
   * @param {string} week
   * @returns {string | undefined}
   */
  const todayIfCurrentWeek = (week) =>
    week === isoWeekId(new Date()) ? localIsoDate(new Date()) : undefined;

  const handleBuildList = useCallback(
    (/** @type {{ dates?: string[], slots?: string[] } | undefined} */ only) => {
      const byId = recipesById(allRecipesRef.current);
      updateShopping(
        deriveShoppingList(
          withCookExtras(/** @type {import("./lib/plan.js").Plan} */ (planRef.current)),
          byId,
          pantryRef.current,
          shoppingRef.current,
          todayIfCurrentWeek(/** @type {any} */ (planRef.current).week),
          only,
          recipesById(bankRecipesRef.current),
        ),
      );
    },
    [updateShopping],
  );

  const handleToggleItem = useCallback(
    (/** @type {string} */ id) => {
      const s = shoppingRef.current;
      updateShopping({
        ...s,
        items: s.items.map((i) => (i.id === id ? { ...i, checked: !i.checked } : i)),
      });
    },
    [updateShopping],
  );

  const handleAddManual = useCallback(
    (/** @type {string} */ food) => {
      const s = shoppingRef.current;
      const id = slug(food) + "-x"; // unit-aware id scheme, unit "x"
      if (s.items.some((i) => i.id === id)) return;
      updateShopping({
        ...s,
        items: [
          ...s.items,
          { id, food, qty: 1, unit: "x", section: sectionOf(food), checked: false, manual: true },
        ],
      });
    },
    [updateShopping],
  );

  const handleJustBought = useCallback(() => {
    // fridgeFirst only when this list IS the rendered trip — a solo profile.
    // A household member's list is a PORTION of the merged HOUSEHOLD trip, and
    // reducing each portion against the same shared stock banks ~nothing
    // (Tribunal BLOCK 2026-08-01); their manual path banks verbatim, and the
    // canonical household flow is the receipt, which banks the merged sum.
    const result = applyJustBought(
      shoppingRef.current,
      pantryRef.current,
      localIsoDate(new Date()),
      { fridgeFirst: otherListsRef.current.length === 0 },
    );
    updateShopping(result.shopping);
    updatePantry(result.pantry);
  }, [updateShopping, updatePantry]);

  const handleOwnItem = useCallback(
    (/** @type {string} */ id) => {
      const result = ownItemToPantry(shoppingRef.current, pantryRef.current, id);
      updateShopping(result.shopping);
      updatePantry(result.pantry);
    },
    [updateShopping, updatePantry],
  );

  // ONE pantry (fix list 1.1): the LOW toggle became a three-state cycle.
  // PLENTY suppresses buying, LOW forces the item onto the list, OUT (no
  // state) means it buys whenever a recipe needs it — the garlic fix.
  const handleCycleState = useCallback(
    (/** @type {string} */ id) => {
      const items = pantryItems(pantryRef.current).map((/** @type {any} */ it) => {
        if (it.id !== id) return it;
        const next = it.state === "plenty" ? "low" : it.state === "low" ? undefined : "plenty";
        const rest = { ...it };
        delete rest.state;
        return next ? { ...rest, state: next } : rest;
      });
      updatePantry(packPantry(items));
    },
    [updatePantry],
  );

  const handleScanApprove = useCallback(
    (
      /** @type {{ name: string, kind: string, qty: string }[]} */ items,
      /** @type {string} */ location,
      /** @type {"sweep" | "add"} */ mode = "sweep",
    ) => {
      const today = localIsoDate(new Date());
      // a scan tagged with a shelf is a SWEEP: those photos are the whole
      // truth about that location, so they replace it. An untagged scan keeps
      // the old additive behaviour. mode "add" (fresh-start wizard's "another
      // photo of the same shelf") is additive but still lands on the shelf —
      // a second fridge photo must extend the first, not erase it.
      updatePantry(
        location && location !== "unsorted" && mode === "sweep"
          ? applySweep(
              pantryRef.current,
              /** @type {any} */ (location),
              items.filter((i) => i.kind !== "staple").map((i) => ({ food: i.name, qty: i.qty })),
              today,
            )
          : applyScanItems(
              pantryRef.current,
              items,
              today,
              location && location !== "unsorted" ? location : undefined,
            ),
      );
    },
    [updatePantry],
  );

  // EMPTY THE PANTRY. The undo toast does not carry here the way it does for
  // the list: the pantry is shared by the whole house, and the toast only
  // exists on the device that pressed the button. So this names the blast
  // radius first, and says where the lasting undo actually is.
  const handleEmptyPantry = useCallback(
    async (/** @type {boolean} */ keepStaples) => {
      const prev = pantryRef.current;
      const all = pantryItems(prev);
      const count = keepStaples ? all.filter(isDatedItem).length : all.length;
      // returns whether the pantry IS empty now (the fresh-start wizard only
      // proceeds on true): already-empty counts as yes, a declined confirm is no
      if (count === 0) return true;
      const house = householdOf(allProfilesRef.current, me);
      const ok = await askConfirm(
        `Delete ${count} ${count === 1 ? "item" : "items"} from the ${house} kitchen record? Everyone in the house sees this. An UNDO button appears for a moment after — past that, rescanning the shelves is how it comes back.`,
      );
      if (!ok) return false;
      updatePantry(emptyPantry(prev, keepStaples));
      setUndoToast({ message: "pantry emptied", restore: () => updatePantry(prev) });
      return true;
    },
    [updatePantry, askConfirm],
  );

  // refs keep the drop/remove callbacks identity-stable (so the drag engine's
  // listeners never re-attach mid-gesture) while still seeing fresh state —
  // planRef is also advanced inside updatePlan so back-to-back drops chain
  // correctly even before the next render commits

  // 7c: auto-advance the week pointer when the calendar rolls into a new
  // ISO week while the app is open — this only changes which week is
  // DISPLAYED, it never writes a plan. Backs off for an hour after a
  // manual week nav (onWeek below) so paging back to check last week isn't
  // yanked forward mid-look.
  const manualNavRef = useRef(0);
  const handleWeekNav = useCallback((/** @type {number} */ delta) => {
    manualNavRef.current = Date.now();
    setWeekId((w) => shiftWeek(w, delta));
  }, []);

  useEffect(() => {
    const BACKOFF_MS = 60 * 60 * 1000;
    const sync = () => {
      if (Date.now() - manualNavRef.current < BACKOFF_MS) return;
      const current = isoWeekId(new Date());
      setWeekId((w) => (w === current ? w : current));
    };
    const id = setInterval(sync, BACKOFF_MS);
    document.addEventListener("visibilitychange", sync);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);

  const targetsRef = useRef(targets);
  targetsRef.current = targets;

  // THE FLUID WEEK (7.2, canon P4): the locked week is abolished. Shopping
  // stores the plan as a FALLBACK and the plan stays freely changeable; the
  // one governing rule — every bought perishable gets used before it dies —
  // is watched by the coverage banner, not by a cage of refusals.

  // SWITCH: the meal keeps its slot and its servings and becomes a different
  // recipe. Replaces the old ✕, which could only delete (David, 2026-07-27).
  // Works on a shopped week too (7.2): the coverage banner is the guard.
  const handleSwitchEntry = useCallback(
    (/** @type {string} */ id) => {
      const p = /** @type {import("./lib/plan.js").Plan} */ (planRef.current);
      const next = switchCandidate(p, id, recipesRef.current);
      if (!next) {
        setUndoToast({
          message: "nothing else fits that slot",
          restore: () => updatePlan(p),
        });
        return;
      }
      updatePlan(setEntryRecipe(p, id, next));
      // one tap replaced a meal: the way back has to be one tap too
      setUndoToast({ message: "switched", restore: () => updatePlan(p) });
    },
    [updatePlan],
  );

  // tapping a planned meal opens it as a card over the plan
  const [peek, setPeek] = useState(
    /** @type {{ recipeId: string, servings?: number, entryId?: string, tableId?: string } | null} */ (
      null
    ),
  );
  const handleOpenEntry = useCallback((/** @type {Record<string, any>} */ entry) => {
    const rid = entry.recipeId ?? entry.viewRecipeId;
    if (!rid) return;
    setPeek({
      recipeId: rid,
      servings: entry.cookTotal ?? entry.servings ?? 1,
      entryId: entry.table ? undefined : entry.id,
      // a table meal carries its table id instead, so Cook Mode can end on
      // the serve step and confirm the TABLE cooked (spec §7.2)
      ...(entry.table ? { tableId: entry.table } : {}),
    });
  }, []);

  const handleToggleOut = useCallback(
    async (/** @type {string} */ date, /** @type {string} */ slot) => {
      let p = /** @type {import("./lib/plan.js").Plan} */ (planRef.current);
      // marking a filled slot OUT deletes its planned meal (pins included) —
      // one 44px tap, and un-toggling brings back an EMPTY slot, not the
      // meal. So a filled slot always asks first. Turning OUT back off just
      // empties the slot and never needs a gate.
      const marking = !outEntryAt(p.entries, date, slot);
      if (marking && entriesAt(p.entries, date, slot).length > 0) {
        if (
          !(await askConfirm("Eating out instead? The planned meal in this slot will be removed."))
        )
          return;
        p = /** @type {import("./lib/plan.js").Plan} */ (planRef.current);
      }
      // 7.11: with a buffet currency on the profile, the away tap cycles
      // planned → OUT → SWIPE (buffet estimates: protein piled where its
      // marginal cost is zero) → empty. Without one, the classic toggle.
      const buffet = (targetsRef.current?.currencies ?? []).find(
        (/** @type {any} */ c) => c.venue === "buffet",
      );
      const next = cycleSlotAway(
        p,
        date,
        slot,
        slotMacroEstimate(recipesRef.current, slot),
        buffetMacroEstimate(recipesRef.current, slot, buffet),
        buffet?.id ?? null,
      );
      updatePlan(next);
      // keep an already-built list truthful: the out meal's ingredients must
      // not linger as things to buy (post-shop the re-derive IS the delta
      // list, 7.2 — bought food already sits in the pantry and subtracts);
      // an empty list stays empty — OUT never builds a list nobody asked for
      if (shoppingRef.current.items.length > 0) {
        updateShopping(
          deriveShoppingList(
            withCookExtras(next),
            recipesById(allRecipesRef.current),
            pantryRef.current,
            shoppingRef.current,
            todayIfCurrentWeek(next.week),
            undefined,
            recipesById(bankRecipesRef.current),
          ),
        );
      }
    },
    [updatePlan, updateShopping, askConfirm],
  );

  // GOING TO THE STORE (7.2): stores the week as the fallback plan — the
  // shape you shopped for, always there to return to. The plan itself stays
  // free. (Replaces the old lock toggle; setPlanLocked is legacy-only.)
  const handleGoingShopping = useCallback(() => {
    const p = /** @type {import("./lib/plan.js").Plan} */ (planRef.current);
    updatePlan(saveFallback(p, localIsoDate(new Date())));
    setUndoToast({
      message: "plan saved as your shopped fallback — the week stays changeable",
      restore: () => updatePlan(p),
    });
  }, [updatePlan]);

  // ↩ back to the shopped plan: cooked meals stay cooked, everything else
  // returns to the fallback's shape
  const handleRestoreFallback = useCallback(async () => {
    const p = /** @type {import("./lib/plan.js").Plan} */ (planRef.current);
    if (!p.fallback) return;
    if (
      !(await askConfirm(
        "Put the week back to the plan you shopped for? Cooked meals stay cooked.",
      ))
    )
      return;
    updatePlan(restoreFallback(/** @type {import("./lib/plan.js").Plan} */ (planRef.current)));
  }, [updatePlan, askConfirm]);

  const handleMarkCooked = useCallback(
    (/** @type {string} */ entryId, /** @type {number} */ seconds = -1) => {
      const plan = /** @type {import("./lib/plan.js").Plan} */ (planRef.current);
      const entry = plan.entries.find((e) => e.id === entryId);
      // the cook timer's END passes its recorded span (7.10) and never
      // un-cooks; Cook Mode's plain tap keeps the old toggle semantics
      updatePlan(
        seconds >= 0
          ? recordCook(plan, entryId, localIsoDate(new Date()), seconds)
          : toggleEntryCooked(plan, entryId, localIsoDate(new Date())),
      );
      // cooking it EATS it (David, 2026-07-26): the meal's ingredients come
      // off the shelves they were put on. Only on the way IN — un-ticking a
      // meal cannot un-cook the food, so nothing is put back.
      if (!entry || entry.cookedAt) return;
      // a batch is bought and cooked ONCE: the leftover days the generator
      // schedules are the same recipe again, and taking its ingredients off
      // the shelf a second time would empty a fridge that is genuinely full
      if (plan.entries.some((e) => e.id !== entryId && e.recipeId === entry.recipeId && e.cookedAt))
        return;
      const recipe = allRecipesRef.current.find((r) => r.id === entry.recipeId);
      if (!recipe) return;
      const { pantry: next, used } = consumeForCook(
        pantryRef.current,
        /** @type {any} */ (cookPlan(recipe, entry.servings).ingredients),
      );
      if (used.length === 0 && next === pantryRef.current) return;
      updatePantry(next);
    },
    [updatePlan, updatePantry],
  );

  // the timer's "overrun was me, not the plan" note (7.10, read by P11)
  const handleCookComment = useCallback(
    (/** @type {string} */ entryId, /** @type {string} */ text) => {
      updatePlan(
        setCookComment(
          /** @type {import("./lib/plan.js").Plan} */ (planRef.current),
          entryId,
          text,
        ),
      );
    },
    [updatePlan],
  );

  /** Add straight from the cookbook: slot inferred from the recipe's
   *  mealType; returns the slot so the row can confirm where it landed. */
  // week generator: one tap owns the whole week — every unpinned entry is
  // cleared and rebuilt; pinned entries are the only state that needs to
  // survive a RE-ROLL, and they're already in the plan data, not app state
  const [buildReport, setBuildReport] = useState(
    /** @type {import("./lib/weekbuilder.js").WeekReport | null} */ (null),
  );
  const buildStateRef = useRef({ salt: 0 });

  const handleGenerateWeek = useCallback(async () => {
    // body-level guard, not just the disabled button: this is the single
    // most destructive path (clears every unpinned entry + overwrites the
    // shopping list) and the one that caused the shopped-week wipe incident.
    // The fluid week (7.2) replaced the flat refusal: a SHOPPED week asks
    // first and snapshots itself as the fallback before being reshaped, so
    // the shape you bought for can never be wiped, only stepped away from.
    // The snapshot is CARRIED onto the generated plan rather than written
    // first: generateWeek reads viewPlanRef (stale until the next render)
    // and the final updatePlan(built) is a full replace, so an interim
    // write would be clobbered a moment later (diff review 2026-08-19).
    /** @type {import("./lib/plan.js").Plan["fallback"]} */
    let carriedFallback;
    {
      const p = /** @type {import("./lib/plan.js").Plan} */ (planRef.current);
      carriedFallback = p.fallback;
      if (p.shoppedAt || p.fallback) {
        const ok = await askConfirm(
          "You've shopped for this week. Regenerating reshapes it — the bought food stays in your pantry, the shopped plan stays saved as your fallback, and the coverage check watches every perishable. Regenerate?",
        );
        if (!ok) return;
        if (!carriedFallback) {
          carriedFallback = saveFallback(p, localIsoDate(new Date())).fallback;
        }
      }
    }
    const bs = buildStateRef.current;
    bs.salt++;
    // P11, the loop: the week being generated reads the week just closed.
    // Composed here rather than passed down from render so GENERATE never
    // depends on which tab happened to be open. Waste events and uncooked
    // planned meals are the only signals, both measured, never stated.
    /** @type {any} */
    let lastReview = null;
    try {
      const prevId = shiftWeek(weekRef.current, -1);
      const prev = /** @type {any} */ (await read(`plans/${prevId}.json`));
      if (prev) {
        lastReview = composeWeekReview({
          plan: prev,
          waste: /** @type {any} */ (manifestInputs.current.waste),
          daily: /** @type {any} */ (dailyRef.current),
          targets: targetsRef.current,
          weekDates: datesOfWeek(prevId),
          recipesById: recipesById(recipesRef.current),
          pantry: pantryRef.current,
        });
      }
    } catch {
      // no readable prior week is a working state, not a failure: a skipped
      // review never blocks the next week (canon P11)
    }
    // BUDGET THE SWIPES BEFORE GENERATING (P5, P10, David 2026-08-24).
    // The arbitrage only pays off on swipes that are IN the plan when the
    // committees run, and nothing ever put one there: a seven-swipe meal
    // plan only worked if he remembered to tap seven slots first, and if he
    // forgot, the week bought protein he had already paid for.
    // One a day, on the currency's preferred slot, up to its weekly
    // allowance, never over a past day or a day already eating away.
    /** @type {import("./lib/plan.js").Plan} */
    let seeded = /** @type {any} */ (viewPlanRef.current);
    {
      const buffet = (targetsRef.current?.currencies ?? []).find(
        (/** @type {any} */ c) => c.venue === "buffet",
      );
      if (buffet?.perWeek > 0) {
        const slot = String(buffet.preferredSlot || "lunch");
        seeded = planSwipes(seeded, datesOfWeek(weekRef.current), {
          perWeek: buffet.perWeek,
          currencyId: buffet.id,
          slot,
          estimate: buffetMacroEstimate(recipesRef.current, slot, buffet),
          today: localIsoDate(new Date()),
        });
      }
    }
    const result = generateWeek({
      recipes: recipesRef.current,
      targets: targetsRef.current,
      review: lastReview,
      drainDownIso: drainDownDate(manifestInputs.current.household ?? normalizeHousehold(null)),
      // expiring-soon perishables are auto-flagged useSoon so the committees
      // favor recipes that cook them before they leave on their own
      pantry: withAutoUseSoon(pantryRef.current, localIsoDate(new Date())),
      weekId: weekRef.current,
      // viewPlan: derived table entries enter as pins so the generator
      // plans each member's day around the shared meal
      plan: seeded,
      salt: bs.salt,
      recentRecipeIds: recentRecipeIdsRef.current,
      // day-aware: past days of the current week survive and are not
      // re-planned; a future week is untouched by this (all its dates are
      // ahead of today)
      today: localIsoDate(new Date()),
    });
    let built = result.plan;
    // AUTO-APPLY substitutions (David, 2026-08-02: "there is no point in
    // saying these are potential swaps if you don't do them"). Still MY week
    // ONLY — the Tribunal veto on writing other people's plans stands;
    // house-wide convergence happens because every phone's own generate does
    // this same pass against the same house lists. One pass, no loop: swaps
    // are computed from the freshly built week, applied, done. Swap targets
    // come from the screened pickable pool, so nothing unsafe can land.
    if (otherListsRef.current.length > 0) {
      try {
        const idById = recipesById(allRecipesRef.current);
        const myList = deriveShoppingList(
          withCookExtras(built),
          idById,
          pantryRef.current,
          null,
          todayIfCurrentWeek(built.week),
          undefined,
          recipesById(bankRecipesRef.current),
        );
        const combined = mergeProfileLists([
          { profileId: me, list: myList },
          ...otherListsRef.current.map((o) => ({ profileId: o.profileId, list: o.list })),
        ]);
        // generatorEligible: an unpromoted ai-special may propose and
        // display, never auto-land in the plan (council 2026-07-23) — the
        // taste-screened pool alone does not enforce that
        const swaps = substitutionPlan(
          combined,
          me,
          built.entries,
          generatorEligible(recipesRef.current),
          recipesById(recipesRef.current),
          { today: localIsoDate(new Date()) },
        );
        if (swaps.length > 0) {
          built = {
            ...built,
            entries: built.entries.map((e) => {
              const s = swaps.find((x) => x.entryId === e.id);
              return s ? { ...e, recipeId: s.toId } : e;
            }),
          };
        }
      } catch {
        // a swap pass that fails leaves the honestly generated week intact
      }
    }
    // SWAP TO FIT (P5, 2026-08-19). The budget is a CONSTRAINT on generation,
    // not a readout: "You review a week that already meets the number." So the
    // week is priced here, against the real store, and changed until it fits
    // or until it can say plainly that it cannot and by how much. Runs LAST,
    // after the house swap pass, so it prices the week David will actually
    // see. Measured on his real bank: about $93/week, and then it stops and
    // says how far short it is rather than pretending.
    /** @type {Record<string, any> | undefined} */
    let fitReport;
    try {
      const cat = manifestInputs.current.catalogue;
      const store = targetsRef.current?.stores?.[0] ?? "";
      const budgetUsd = Number(targetsRef.current?.weeklyBudgetUsd) || 0;
      if (cat && store && budgetUsd > 0) {
        const fit = swapToFit({
          plan: built,
          recipes: generatorEligible(recipesRef.current),
          recipesById: recipesById(recipesRef.current),
          pantry: pantryRef.current,
          catalogue: cat,
          store,
          region: targetsRef.current?.region,
          budgetUsd,
          targets: targetsRef.current,
          fromDate: todayIfCurrentWeek(built.week),
          today: localIsoDate(new Date()),
          bankById: recipesById(bankRecipesRef.current),
        });
        built = /** @type {any} */ (fit.plan);
        fitReport = {
          ran: fit.ran,
          fits: fit.fits,
          budget: fit.budget,
          startedAt: fit.startedAt,
          eaten: fit.eaten,
          over: fit.over,
          swaps: fit.swaps.length,
          reason: fit.reason,
          store,
        };
      } else {
        fitReport = {
          ran: false,
          fits: true,
          swaps: 0,
          reason: !cat
            ? "no price catalogue on this device yet, so the week could not be priced"
            : !store
              ? "no store chosen on this profile, so there is no price to fit to"
              : "no weekly budget set on this profile, so nothing to fit",
        };
      }
    } catch {
      // a fit pass that throws leaves the honestly generated week intact, and
      // says so rather than reporting a fit that never happened
      fitReport = { ran: false, fits: false, swaps: 0, reason: "the fit pass failed to run" };
    }
    // THE GENERATION MANIFEST (fix list 2.5, council 2026-08-18): compose
    // the full subsystem report and persist it ON the plan, so every device
    // sees what every engine did — the structural answer to four engines
    // that shipped dark. Prior weeks load from cache for cooked-over-planned.
    try {
      const today = localIsoDate(new Date());
      const priorIds = [-1, -2, -3].map((d) => shiftWeek(built.week, d));
      const priorPlans = await Promise.all(
        priorIds.map(async (w) => ({
          weekId: w,
          plan: /** @type {Record<string, any> | null} */ (await read(`plans/${w}.json`)),
        })),
      );
      built = {
        ...built,
        manifest: composeManifest({
          engine: {
            ...(result.report.manifest ?? {}),
            swapToFit: fitReport,
            // P6: does the week physically fit the kitchen it will live in?
            // Reports, never refuses: a person whose fridge is genuinely too
            // small needs to know before they shop, not to be told their week
            // is illegal.
            household: (() => {
              const hh = manifestInputs.current.household ?? normalizeHousehold(null);
              const cap = capacityCheck(
                hh,
                coldLoad(pantryItems(pantryRef.current), (food, qty, unit) =>
                  toGrams(qty, unit, canonicalFood(food)),
                ),
              );
              return {
                ...(result.report.manifest?.household ?? {}),
                capacityChecked: cap.checked,
                fits: cap.fits,
                over: cap.over,
                headId: hh.headId,
                members: hh.members.length,
              };
            })(),
          },
          targets: targetsRef.current,
          recipes: recipesRef.current,
          dailyDays: dailyRef.current?.days ?? [],
          recentPlans: [{ weekId: built.week, plan: built }, ...priorPlans],
          todayIso: today,
        }),
      };
    } catch {
      // a manifest that fails to compose must never block the week itself;
      // the planner renders its absence as the failure it is
    }
    // the shopped-plan snapshot rides the SAME write as the generated week —
    // one updatePlan, no interim state for a full-replace to clobber
    if (carriedFallback) built = { ...built, fallback: carriedFallback };
    updatePlan(built); // updatePlan strips derived table entries itself
    setBuildReport(result.report);
    // 7a: auto-populate the shopping list from the freshly generated plan,
    // not the stale planRef, so List is correct the instant Plan finishes
    updateShopping(
      deriveShoppingList(
        withCookExtras(built),
        recipesById(allRecipesRef.current),
        pantryRef.current,
        shoppingRef.current,
        todayIfCurrentWeek(built.week),
        undefined,
        recipesById(bankRecipesRef.current),
      ),
    );
  }, [updatePlan, updateShopping, me, askConfirm]);

  useEffect(() => {
    // a new week means a fresh build state and report
    buildStateRef.current = { salt: 0 };
    setBuildReport(null);
  }, [weekId]);

  // recipes used in the previous two weeks — generation penalizes them so
  // consecutive weeks ROTATE instead of re-picking the same favorites. Loaded
  // per week from the prior plan files; empty (no penalty) when they're absent.
  // next week's plan, read-only: the Today view's Sunday batch block preps
  // for the week AHEAD, so on Sunday it lists next week's components
  const [nextPlan, setNextPlan] = useState(
    /** @type {import("./lib/plan.js").Plan | null} */ (null),
  );
  useEffect(() => {
    let alive = true;
    const nextWeek = shiftWeek(weekId, 1);
    read(`plans/${nextWeek}.json`)
      .catch(() => null)
      .then((p) => {
        if (alive) setNextPlan(normalizePlan(/** @type {any} */ (p), nextWeek));
      });
    return () => {
      alive = false;
    };
  }, [weekId, hasToken]);

  // last week's full plan + the household waste ledger feed the P11 review
  // tile (read side of 7.1) — read-only, absent = the tile stays honest-dark
  const [prevWeekPlan, setPrevWeekPlan] = useState(
    /** @type {import("./lib/plan.js").Plan | null} */ (null),
  );
  const [wasteLog, setWasteLog] = useState(/** @type {Record<string, any> | null} */ (null));
  // THE HOUSEHOLD MODEL (P6). Absent is a working state: a kitchen that has
  // declared nothing behaves exactly as the app did before the file existed.
  const [household, setHousehold] = useState(normalizeHousehold(null));
  useEffect(() => {
    let alive = true;
    const load = () => {
      void read(householdPathFor(householdOf(allProfilesRef.current, me)), { raw: true }).then(
        (h) => {
          if (alive) setHousehold(normalizeHousehold(/** @type {any} */ (h)));
        },
      );
    };
    load();
    const unsub = onSyncChange(load);
    return () => {
      alive = false;
      unsub();
    };
  }, [allProfiles, me]);
  // The live inputs the P1 manifest refresh and the P11 review loop need,
  // filled here because this is the first point in the component where every
  // one of them exists. The box itself is declared beside the plan-write point
  // that consumes it.
  manifestInputs.current = {
    targets,
    recipes,
    dailyDays: dailyLog?.days ?? [],
    catalogue: priceCatalogue,
    waste: wasteLog,
    household,
  };
  useEffect(() => {
    let alive = true;
    const prior = [shiftWeek(weekId, -1), shiftWeek(weekId, -2)];
    Promise.all(prior.map((w) => read(`plans/${w}.json`).catch(() => null))).then((plans) => {
      if (!alive) return;
      const ids = new Set();
      for (const p of plans) {
        for (const e of /** @type {any} */ (p)?.entries ?? []) if (e.recipeId) ids.add(e.recipeId);
      }
      recentRecipeIdsRef.current = [...ids];
      setPrevWeekPlan(/** @type {any} */ (plans[0]) ?? null);
    });
    void (async () => {
      const prof = await readProfiles();
      if (!alive) return;
      const path = pantryPathFor(householdOf(prof.profiles, activeProfile())).replace(
        /pantry\.json$/,
        "waste.json",
      );
      const w = /** @type {Record<string, any> | null} */ (await read(path, { raw: true }));
      if (alive) setWasteLog(w);
    })();
    return () => {
      alive = false;
    };
  }, [weekId, hasToken]);

  const handlePlanAdd = useCallback(
    async (/** @type {Record<string, any>} */ recipe, /** @type {string} */ date) => {
      // fluid week (7.2): adding a meal to a shopped week is a normal edit
      const p = /** @type {import("./lib/plan.js").Plan} */ (planRef.current);
      const slot = SLOT_KEYS.includes(recipe.mealType) ? recipe.mealType : "dinner";
      // planning real food into an eating-out slot: the placeholder yields
      const out = outEntryAt(p.entries, date, slot);
      const base = out ? removeEntryById(p, out.id) : p;
      updatePlan(addEntry(base, date, slot, { recipeId: recipe.id, servings: 1 }));
      return slot;
    },
    [updatePlan],
  );

  // generation guard: a slow older check must never overwrite a newer result
  const runCheck = () => {
    const gen = ++checkGen;
    checkDataRepo().then((r) => {
      if (gen === checkGen) setRepo(r);
    });
  };

  useEffect(runCheck, [hasToken, online]);

  const saveToken = () => {
    if (!draft.trim()) return;
    setToken(draft);
    setDraft("");
    setHasToken(true);
    // re-verify directly: when replacing an invalid token, hasToken is
    // already true, so the effect above would not re-fire
    runCheck();
  };

  // G1 data backup: bundle the active profile's files into one downloadable
  // JSON. Reads go through the normal cached-first store, so the export works
  // offline and never needs its own network path. The shared recipe bank is
  // deliberately excluded — it lives in mise-data's git history; this is the
  // personal-data lifeboat.
  const handleExport = useCallback(async () => {
    const profileId = activeProfile();
    const now = new Date();
    const weekNow = isoWeekId(now);
    /** @type {Record<string, any>} */
    const files = {};
    const grab = async (/** @type {string} */ path, /** @type {any} */ opts = undefined) => {
      files[path] = await read(path, opts).catch(() => null);
    };
    // pantry moved to the household path (B2) — export the live file, and
    // the legacy per-profile one only as a labeled extra if it still exists
    const prof = await readProfiles();
    const hhPantry = pantryPathFor(householdOf(prof.profiles, profileId));
    await Promise.all([
      grab("targets.json"),
      grab(hhPantry, { raw: true }),
      grab("pantry.json"),
      grab("shopping.json"),
      grab("fitness/daily.json"),
      ...[-2, -1, 0, 1].map((d) => grab(`plans/${shiftWeek(weekNow, d)}.json`)),
    ]);
    const ownRecipes = profileId === "david" ? [] : await readCollection("recipes").catch(() => []);
    const payload = {
      app: `${APP.name} ${APP.version}`,
      exportedAt: now.toISOString(),
      profile: profileId,
      files,
      ownRecipes,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `mise-export-${profileId}-${localIsoDate(now)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }, []);

  const testWrite = () => {
    const device = /iPhone|iPad/.test(navigator.userAgent) ? "iphone" : "laptop";
    void write("meta.json", {
      schemaVersion: 1,
      lastWrite: { device, at: new Date().toISOString() },
    });
  };

  // guided tour (docs/tutorial-design.md v3): offered once at a profile's
  // first login on this device, resumable after an interruption, replayable
  // from SYS. Progress persists per step so an app-kill mid-run leaves an
  // honest { bailed, lastStep } record (the bail-point measurement).
  const tourProfileId = activeProfile() ?? "";
  const [tourRecord, setTourRecord] = useState(() =>
    tourProfileId ? readTourState(tourProfileId) : null,
  );
  const [tourOpen, setTourOpen] = useState(/** @type {{ startStep: number } | null} */ (null));
  const [tourOfferHidden, setTourOfferHidden] = useState(false);
  // ANY bailed record offers resume — a lastStep threshold here once wedged
  // the offer shut forever for someone who tapped END on the first step
  const tourResumeStep = tourRecord?.status === "bailed" ? Math.max(1, tourRecord.lastStep) : null;
  const tourOfferVisible =
    Boolean(tourProfileId) &&
    !tourOpen &&
    !tourOfferHidden &&
    (tourRecord === null || tourResumeStep !== null);
  const saveTour = useCallback(
    (/** @type {import("./lib/tour.js").TourState} */ state) => {
      if (!tourProfileId) return;
      writeTourState(tourProfileId, state);
      setTourRecord(state);
    },
    [tourProfileId],
  );
  const handleTourStart = useCallback(() => {
    setTourOfferHidden(true);
    setTourOpen({ startStep: tourResumeStep !== null ? tourResumeStep - 1 : 0 });
  }, [tourResumeStep]);
  const handleTourDismiss = useCallback(() => {
    setTourOfferHidden(true);
    saveTour({ status: "skipped", lastStep: tourRecord?.lastStep ?? 0 });
  }, [saveTour, tourRecord]);
  const handleTourEnd = useCallback(
    (/** @type {"done" | "bailed"} */ status, /** @type {number} */ lastStep) => {
      setTourOpen(null);
      setTourOfferHidden(true); // ended by hand: don't re-offer this session
      saveTour({ status, lastStep });
    },
    [saveTour],
  );
  const handleTourProgress = useCallback(
    (/** @type {number} */ step) => saveTour({ status: "bailed", lastStep: step + 1 }),
    [saveTour],
  );
  const handleReplayTour = useCallback(() => {
    setTourOfferHidden(true);
    setTourOpen({ startStep: 0 });
  }, []);

  // Tables derivation (the Engineer seam): persisted `plan` state stays
  // PURE; virtual pinned entries exist only in this memo and the viewPlan
  // built from it. Any failure degrades to "no tables", never a broken app.

  // the household list as the view sees it, needed here so SUBSTITUTE can
  // tell which foods only I am buying
  const combinedForSwap = useMemo(
    () =>
      otherLists.length > 0
        ? mergeProfileLists([
            { profileId: me, list: /** @type {any} */ (shopping) },
            ...otherLists.map((o) => ({ profileId: o.profileId, list: o.list })),
          ])
        : [],
    [shopping, otherLists],
  );

  // SUBSTITUTE: swaps proposed against MY week only (Tribunal veto: applying
  // one to another profile plan would write their file from this device, and
  // it would land having passed no diet screen on their phone).
  const substitutions = useMemo(
    () =>
      combinedForSwap.length > 0
        ? substitutionPlan(
            combinedForSwap,
            me,
            plan.entries,
            generatorEligible(recipes),
            recipesById(recipes),
            { today: localIsoDate(new Date()) },
          )
        : [],
    [combinedForSwap, plan.entries, recipes],
  );

  const handleSubstitute = useCallback(
    (/** @type {{ entryId: string, toId: string }[]} */ swaps) => {
      const cur = /** @type {any} */ (planRef.current);
      updatePlan({
        ...cur,
        entries: cur.entries.map((/** @type {any} */ e) => {
          const swap = swaps.find((x) => x.entryId === e.id);
          return swap ? { ...e, recipeId: swap.toId } : e;
        }),
      });
    },
    [updatePlan],
  );

  // claim counts for the List's HOUSEHOLD tile: upcoming dinners in my house
  // with no buyer, and the ones I already claimed
  const dinnerClaims = useMemo(() => {
    const house = allProfiles.find((p) => p.id === me)?.household ?? "home";
    const todayIso = localIsoDate(new Date());
    const tables = (houseEvents.find((h) => h.house === house)?.events?.tables ?? []).filter(
      (t) => typeof t.date === "string" && t.date >= todayIso,
    );
    return {
      unclaimed: tables.filter((t) => !t.buyerId).length,
      mine: tables.filter((t) => t.buyerId === me).length,
    };
  }, [houseEvents, allProfiles, me]);

  const tableDerived = useMemo(() => {
    try {
      const profilesById = new Map(allProfiles.map((p) => [p.id, p]));
      return deriveTables(houseEvents, {
        profileId: me,
        diet: targets?.diet,
        avoid: targets?.avoidIngredients,
        avoidRecipes: targets?.avoidRecipes,
        bankById: recipesById(bankRecipes),
        ownEntries: plan.entries,
        today: localIsoDate(new Date()),
        profilesById,
        myTargets: targets,
      });
    } catch {
      return { entries: [], conflicts: [], collisions: [], cookExtras: [], allCookExtras: [] };
    }
  }, [houseEvents, allProfiles, targets, bankRecipes, plan, me]);
  const merged = useMemo(
    () =>
      mergeViewPlan(
        /** @type {import("./lib/plan.js").Plan} */ (plan),
        tableDerived.entries,
        datesOfWeek(plan.week),
        localIsoDate(new Date()),
      ),
    [plan, tableDerived],
  );
  const viewPlan = merged.plan;

  // compact live snapshot for the ASK chat: enough to ground an answer,
  // small enough to cost pennies. Strings only; the Worker clamps again.
  const askContext = useMemo(() => {
    const bankById = recipesById(bankRecipes);
    const nameOf = (/** @type {string | undefined} */ id) =>
      (id && (bankById.get(id)?.name ?? allRecipes.find((r) => r.id === id)?.name)) || id || "";
    const profName = (/** @type {string | undefined} */ id) =>
      allProfiles.find((p) => p.id === id)?.name ?? id ?? "";
    const todayIso = localIsoDate(new Date());
    const house = allProfiles.find((p) => p.id === me)?.household ?? "home";
    const tables = (houseEvents.find((h) => h.house === house)?.events?.tables ?? []).filter(
      (t) => typeof t.date === "string" && t.date >= todayIso,
    );
    const batchOf = (/** @type {string} */ id) => bankById.get(id)?.batchPrep?.sundayComponent;
    return {
      name: profName(me),
      phase: targets?.phase ?? "",
      targets: `${targets?.macros?.calories ?? "?"} kcal / ${targets?.macros?.protein ?? "?"}g protein daily`,
      today: viewPlan.entries
        .filter((e) => e.date === todayIso)
        .map(
          (e) =>
            `${e.slot}: ${nameOf(e.recipeId ?? /** @type {any} */ (e).viewRecipeId) || e.freeText || "?"} ×${e.servings}`,
        ),
      dinners: tables.map(
        (t) =>
          `${t.date} ${nameOf(t.recipeId)} — cook ${profName(t.cookId)}, groceries ${t.buyerId ? profName(t.buyerId) : "unclaimed"}${batchOf(t.recipeId) ? ` | batch prep: ${batchOf(t.recipeId)}` : ""}`,
      ),
      kitchen: pantryItems(pantry)
        .filter(isDatedItem)
        .map(
          (/** @type {any} */ p) =>
            `${p.food}${p.qty ? ` (${p.qty})` : ""} in ${p.location ?? "pantry"}`,
        ),
      list: (shopping.items ?? []).slice(0, 40).map((i) => i.food),
      notes:
        houseShopped || /** @type {any} */ (plan)?.shoppedAt
          ? "this week's shop is done"
          : "not shopped yet this week",
    };
  }, [
    bankRecipes,
    allRecipes,
    allProfiles,
    houseEvents,
    viewPlan,
    pantry,
    shopping,
    targets,
    plan,
    houseShopped,
    me,
  ]);

  // a table landed AFTER this week was generated: the view displaced a meal
  // but snacks/portions were sized around the old one — say so until re-roll
  const tableStale = merged.displaced;
  viewPlanRef.current = viewPlan;
  tableDerivedRef.current = tableDerived;
  const houseEventsRef = useRef(houseEvents);
  houseEventsRef.current = houseEvents;

  /** the cook's shopping pseudo-entries ride the buffer precedent: augment
   *  the plan at list-derivation time only, never in state. Clamped to the
   *  plan's own week — a table set weeks ahead (now one tap via the Tables
   *  tab's date picker) must not shop its ingredients into THIS trip */

  const myHouseOf = () => {
    const mine = allProfilesRef.current.find((p) => p.id === me);
    return /** @type {string} */ (mine?.household ?? "home");
  };

  const writeHouseEvents = useCallback(
    (/** @type {string} */ house, /** @type {import("./lib/tables.js").HouseEvents} */ next) => {
      setHouseEvents((cur) => [...cur.filter((h) => h.house !== house), { house, events: next }]);
      void write(eventsPathFor(house), /** @type {any} */ (next), { raw: true });
    },
    [],
  );

  // GROCERY CLAIMS (David, 2026-08-03, replacing the manual famdinner rows he
  // rightly stopped trusting): a family dinner rides NOBODY's list until
  // someone claims it. Claiming writes buyerId on the table; the buyer's
  // DERIVED list then carries the batch natively — no manual rows, nothing
  // to corrupt, the receipt clears it like any derived row, and the money
  // ledger bills the buyer.

  /** rebuild MY list against a just-written events state, without waiting a
   *  render for the tableDerived memo to catch up */
  const rebuildListWithEvents = useCallback(
    (
      /** @type {string} */ house,
      /** @type {import("./lib/tables.js").HouseEvents} */ nextEvents,
    ) => {
      try {
        const houses = houseEventsRef.current.map((h) =>
          h.house === house ? { house, events: nextEvents } : h,
        );
        const t = targetsRef.current;
        const derived = deriveTables(houses, {
          profileId: me,
          diet: t?.diet,
          avoid: t?.avoidIngredients,
          avoidRecipes: t?.avoidRecipes,
          bankById: recipesById(bankRecipesRef.current),
          ownEntries: /** @type {any} */ (planRef.current).entries,
          today: localIsoDate(new Date()),
          profilesById: new Map(allProfilesRef.current.map((p) => [p.id, p])),
        });
        const weekSet = new Set(datesOfWeek(weekRef.current));
        const listPlan = {
          .../** @type {any} */ (planRef.current),
          entries: [
            .../** @type {any} */ (planRef.current).entries,
            ...derived.cookExtras.filter((/** @type {any} */ x) => weekSet.has(x.date)),
          ],
        };
        updateShopping(
          deriveShoppingList(
            /** @type {any} */ (listPlan),
            recipesById(allRecipesRef.current),
            pantryRef.current,
            shoppingRef.current,
            todayIfCurrentWeek(/** @type {any} */ (planRef.current).week),
            undefined,
            recipesById(bankRecipesRef.current),
          ),
        );
      } catch {
        // list refresh is a convenience; the next BUILD gets it right
      }
    },
    [updateShopping, me],
  );

  // Every profile's targets IN STATE, cached-first (per-person-plates spec
  // 10 / Engineer H1): deriving plates and freezing pots needs each seated
  // profile's targets synchronously. Reads are intentionally house-wide
  // (spec 8.7); shas ride along for the frozen pot's input fingerprint.
  const [houseTargets, setHouseTargets] = useState(
    /** @type {Map<string, { data: Record<string, any> | null, sha: string | null, dirty: boolean }>} */ (
      new Map()
    ),
  );
  const houseTargetsRef = useRef(houseTargets);
  houseTargetsRef.current = houseTargets;
  useEffect(() => {
    let alive = true;
    const load = () => {
      readProfiles().then(async (p) => {
        const map = new Map();
        for (const pr of p.profiles) {
          map.set(pr.id, await readTargetsMetaOf(pr.id));
        }
        if (alive) setHouseTargets(map);
      });
    };
    load();
    const unsub = onSyncChange(load);
    return () => {
      alive = false;
      unsub();
    };
  }, [hasToken]);

  // sync mirror of weekShoppedFor for RENDER-TIME consumers (serve step,
  // recipe view, credits, instrument): which upcoming weeks are known
  // bought. Fails toward FROZEN while loading — rung 0f's direction.
  const [shoppedWeeks, setShoppedWeeks] = useState(/** @type {Set<string> | null} */ (null));
  const shoppedWeeksRef = useRef(shoppedWeeks);
  shoppedWeeksRef.current = shoppedWeeks;
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const today = localIsoDate(new Date());
      const weeks = new Set([isoWeekId(new Date()), isoWeekId(parseLocalIso(shiftIso(today, 7)))]);
      const out = new Set();
      for (const w of weeks) {
        const p = await readProfiles().catch(() => ({ profiles: [] }));
        for (const pr of p.profiles) {
          const path = pr.id === "david" ? `plans/${w}.json` : `profiles/${pr.id}/plans/${w}.json`;
          const theirs = /** @type {any} */ (await read(path, { raw: true }).catch(() => null));
          if (theirs?.shoppedAt) {
            out.add(w);
            break;
          }
        }
      }
      if (alive) setShoppedWeeks(out);
    };
    void load();
    const unsub = onSyncChange(() => void load());
    return () => {
      alive = false;
      unsub();
    };
  }, [hasToken]);

  /**
   * THE SHOPPED-WEEK FREEZE (David, 2026-08-10): a bought week is
   * untouchable. A table is treated as shopped when its date falls in the
   * current plan week and that plan is marked shopped. Future weeks are
   * unshopped by definition; past dates are frozen by definition.
   */
  const weekShoppedFor = async (/** @type {string} */ date) => {
    const today = localIsoDate(new Date());
    if (date < today) return true;
    // the TABLE's week, for the WHOLE HOUSE (review 2b #3): the shopper is
    // usually not the claimer, and planRef holds whichever week is being
    // VIEWED. Cached-first reads, so instant and offline-correct.
    const week = isoWeekId(parseLocalIso(date));
    const p = await readProfiles().catch(() => ({ profiles: [] }));
    for (const pr of p.profiles) {
      const path =
        pr.id === "david" ? `plans/${week}.json` : `profiles/${pr.id}/plans/${week}.json`;
      const theirs = /** @type {any} */ (await read(path, { raw: true }).catch(() => null));
      if (theirs?.shoppedAt) return true;
    }
    return false;
  };

  /**
   * Live plate solve for one table, from this device's cached targets.
   * Plating always derives LIVE (spec §10: the frozen pot is a contract for
   * money and buying, never for what lands on a plate) so no weekShopped
   * freeze applies here. Null unless the recipe is tagged `plated`.
   * @param {import("./lib/tables.js").TableEvent} t
   */
  const liveSynthFor = (/** @type {import("./lib/tables.js").TableEvent} */ t) => {
    const recipe = bankRecipesRef.current.find((r) => r.id === t.recipeId);
    if (!recipe || recipe.assembly !== "plated" || t.sameForEveryone) return null;
    // rung 0f for render-time consumers: on a BOUGHT week with NO frozen
    // pot, the food in the house is uniform quantities — a solved plate
    // instruction would tell the cook to serve food that was never bought.
    // A valid pot means the buy WAS solved, so solved plates are honest.
    // Unknown (still loading) fails toward frozen.
    if (!parsePot(/** @type {any} */ (t).pot, recipe)) {
      const today = localIsoDate(new Date());
      const wk = isoWeekId(parseLocalIso(t.date));
      const frozen =
        t.date < today || shoppedWeeksRef.current === null || shoppedWeeksRef.current.has(wk);
      if (frozen) return null;
    }
    // GUESTS ARE SEATS (canon P8): "us plus two" is the same pot with two
    // extra plates on the stated default profile. They join here rather than
    // at the view, so the LIVE solve and the FROZEN pot below see the same
    // table — a guest in one and not the other is a buy that does not match
    // the plates.
    const seats = [...(t.seats ?? []), ...guestSeats(t)];
    const targetsById = new Map();
    /** @type {Record<string, number>} */
    const slotShares = {};
    for (const s of seats) {
      const own = /** @type {any} */ (s).guest
        ? GUEST_TARGETS
        : houseTargetsRef.current.get(s.id)?.data;
      targetsById.set(s.id, /** @type {any} */ (own ?? null));
      slotShares[s.id] = slotShareFor(/** @type {any} */ (own), t.slot);
    }
    return synthesize({
      recipe,
      seats: /** @type {any} */ (seats),
      targetsById,
      slotShares,
    });
  };

  /**
   * Claim-time missing-plan warning (spec R6): only a CONFIGURED seat (their
   * profile carries a fitness phase, meaning a plan exists somewhere) whose
   * targets are unreadable or unsynced on THIS device warns. An unconfigured
   * seat is a normal plate, never a warning — that distinction is what keeps
   * the warning from crying wolf into silence.
   * @param {import("./lib/tables.js").TableEvent} t
   * @returns {string | null}
   */
  const missingPlanWarning = (/** @type {import("./lib/tables.js").TableEvent} */ t) => {
    // gated on the ENGINE (Red Team 6): at zero tags a plan affects
    // nothing about this dinner, and a warning about a plan with no effect
    // is the wolf-cry R6 exists to prevent
    const recipe = bankRecipesRef.current.find((r) => r.id === t.recipeId);
    if (!recipe || recipe.assembly !== "plated" || t.sameForEveryone) return null;
    const names = [];
    for (const s of t.seats ?? []) {
      if (s.status === "skipped") continue;
      const prof = allProfilesRef.current.find((p) => p.id === s.id);
      if (!prof?.phase) continue; // unconfigured seat: normal plate, no warning
      const rec = houseTargetsRef.current.get(s.id);
      if (!rec || rec.data === null || rec.dirty) names.push(prof.name ?? s.id);
    }
    if (names.length === 0) return null;
    return names.length === 1
      ? `buying without ${names[0]}'s food plan on this phone`
      : `buying without food plans for ${names.join(" and ")} on this phone`;
  };

  /** Freeze a table's pot per spec 10. Solved-only: null in uniform mode. */
  const potStringFor = async (/** @type {import("./lib/tables.js").TableEvent} */ t) => {
    const recipe = bankRecipesRef.current.find((r) => r.id === t.recipeId);
    if (!recipe || t.sameForEveryone) return null;
    const seats = [...(t.seats ?? []), ...guestSeats(t)];
    const targetsById = new Map();
    /** @type {Record<string, string>} */
    const shas = {};
    /** @type {Record<string, number>} */
    const slotShares = {};
    for (const s of seats) {
      const guest = /** @type {any} */ (s).guest === true;
      const rec = houseTargetsRef.current.get(s.id);
      const own = guest ? GUEST_TARGETS : rec?.data;
      targetsById.set(s.id, /** @type {any} */ (own ?? null));
      // a guest's "targets sha" is the CONSTANT, so the fingerprint changes
      // if the default ever changes and stays stable while it does not
      shas[s.id] = guest ? "guest-default" : rec?.dirty ? "dirty" : (rec?.sha ?? "missing");
      slotShares[s.id] = slotShareFor(/** @type {any} */ (own), t.slot);
    }
    return freezePotString({
      recipe,
      seats: /** @type {any} */ (seats),
      targetsById,
      slotShares,
      weekShopped: await weekShoppedFor(t.date),
      targetShas: shas,
    });
  };

  /** claim (or release) ONE dinner's groceries from its card */
  const handleSetBuyer = useCallback(
    async (
      /** @type {string} */ house,
      /** @type {string} */ tableId,
      /** @type {string | null} */ buyerId,
    ) => {
      if (house !== myHouseOf()) return;
      const cur = houseEventsRef.current.find((h) => h.house === house)?.events;
      if (!cur) return;
      let next = setTableBuyer(cur, tableId, buyerId, localIsoDate(new Date()));
      // THE FREEZE (spec 10): FIRST TRIGGER WINS. A claim freezes a solved
      // pot only when no VALID one exists (a buyer swap must never silently
      // recompute the money contract after groceries may be bought; only
      // REDO PLATES re-freezes, deliberately). A broken or orphaned pot is
      // repaired here, same C5 semantics as the cooked trigger. Releasing
      // the claim drops the pot only while the meal is uncooked. Uniform
      // tables produce null and carry no pot - the inert path.
      const claimed = next.tables.find((x) => x.id === tableId);
      if (claimed) {
        const recipe = bankRecipesRef.current.find((r) => r.id === claimed.recipeId);
        if (buyerId) {
          if (!parsePot(claimed.pot, recipe)) {
            const pot = await potStringFor(claimed);
            if (pot) next = setTablePot(next, tableId, pot, localIsoDate(new Date()));
          }
        } else if (!claimed.cookedAt) {
          next = setTablePot(next, tableId, null, localIsoDate(new Date()));
        }
      }
      writeHouseEvents(house, next);
      rebuildListWithEvents(house, next);
    },
    // writeHouseEvents is declared later in this component but is
    // identity-stable; body (call-time) reference is safe, the dep array
    // must not touch it (TDZ at definition time)
    [rebuildListWithEvents],
  );

  /** name the table's head — written ONLY by this human tap (spec §9/B5) */
  const handleSetHead = useCallback(
    (/** @type {string} */ house, /** @type {string} */ tableId, /** @type {string} */ headId) => {
      if (house !== myHouseOf()) return;
      const cur = houseEventsRef.current.find((h) => h.house === house)?.events;
      if (!cur) return;
      const next = setTableHead(cur, tableId, headId, localIsoDate(new Date()));
      writeHouseEvents(house, next);
    },
    // writeHouseEvents: body-only reference, TDZ — see handleSetBuyer
    [],
  );

  /** a guest is one more plate (7.4, canon P8): whole plates, 0..10 */
  const handleSetGuests = useCallback(
    (/** @type {string} */ house, /** @type {string} */ tableId, /** @type {number} */ guests) => {
      if (house !== myHouseOf()) return;
      const cur = houseEventsRef.current.find((h) => h.house === house)?.events;
      if (!cur) return;
      const next = setTableGuests(cur, tableId, guests, localIsoDate(new Date()));
      writeHouseEvents(house, next);
    },
    // writeHouseEvents: body-only reference, TDZ — see handleSetBuyer
    [],
  );

  /** claim every unclaimed upcoming dinner (true) or release my claims (false) */
  const handleClaimAllDinners = useCallback(
    (/** @type {boolean} */ claim) => {
      const house = myHouseOf();
      const cur = houseEventsRef.current.find((h) => h.house === house)?.events;
      if (!cur) return 0;
      const today = localIsoDate(new Date());
      let n = 0;
      const tables = cur.tables.map((t) => {
        if (typeof t.date !== "string" || t.date < today) return t;
        if (claim && !t.buyerId) {
          n++;
          return { ...t, buyerId: me };
        }
        if (!claim && t.buyerId === me) {
          n++;
          const rest = { ...t };
          delete rest.buyerId;
          return rest;
        }
        return t;
      });
      if (n === 0) return 0;
      const next = { ...cur, tables };
      writeHouseEvents(house, next);
      rebuildListWithEvents(house, next);
      return n;
    },
    // writeHouseEvents: body-only reference, TDZ — see handleSetBuyer
    [rebuildListWithEvents, me],
  );

  // cleanup for the RETIRED manual famdinner rows (pre-claims): they are
  // manual, so nothing else ever regenerates them away
  const handleRemoveDinnerRows = useCallback(() => {
    const cur = shoppingRef.current;
    const items = cur.items.filter((i) => !String(i.id).endsWith("-famdinners"));
    if (items.length !== cur.items.length) updateShopping({ ...cur, items });
  }, [updateShopping]);

  // ---- OCCASIONS: dated overrides that take days off the generator --------
  // Read for EVERY profile in the house, raw, same pattern as the combined
  // shopping lists: one person sets another's colonoscopy prep up on his phone,
  // so the screen has to see and write somebody else's file.
  const [occasions, setOccasions] = useState(
    /** @type {import("./lib/occasions.js").Occasion[]} */ ([]),
  );
  const [occBusy, setOccBusy] = useState(false);
  /** @type {(id: string) => string} */
  const occasionsPathFor = (id) =>
    id === "david" ? "occasions.json" : `profiles/${id}/occasions.json`;

  useEffect(() => {
    let alive = true;
    const load = () => {
      readProfiles().then(async (p) => {
        /** @type {import("./lib/occasions.js").Occasion[]} */
        const all = [];
        for (const pr of p.profiles) {
          const file = /** @type {any} */ (
            await read(occasionsPathFor(pr.id), { raw: true }).catch(() => null)
          );
          for (const o of file?.occasions ?? [])
            // the DIRECTORY is the authority on whose occasion this is
            // (writeOccasion always writes to the owner's path). A stored
            // profileId is ignored: the §8.8 sweep auto-writes shared state
            // from this data, and honoring a spoofed field would let one
            // corrupt file silently skip ANOTHER person's seats
            // household-wide on every device (security review M1).
            all.push({ ...o, profileId: pr.id });
        }
        if (alive) setOccasions(all);
      });
    };
    load();
    const unsub = onSyncChange(load);
    return () => {
      alive = false;
      unsub();
    };
  }, [hasToken]);

  // THE OCCASION SWEEP (per-person-plates-design §8.8): tables materialized
  // AFTER an occasion was applied never met tablesToLeave, so a prep-day
  // seat could quietly come back. Every device re-runs the seat-patch block
  // over its cached occasions at load and on sync — idempotent (already-
  // skipped seats are filtered), and ONLY the seat patch: never
  // writeOccasion/applyOccasion, which drop and regenerate plan entries on
  // the occasion's dates and would wipe recorded days on every app open
  // (Tribunal loop-2 C1).
  useEffect(() => {
    if (occasions.length === 0 || houseEvents.length === 0) return;
    const today = localIsoDate(new Date());
    for (const { house, events } of houseEvents) {
      let next = events;
      let changed = 0;
      for (const o of occasions) {
        if (o.offTables === false) continue;
        for (const tableId of tablesToLeave(next.tables, [o], o.profileId, today)) {
          next = patchSeat(next, tableId, o.profileId, { status: "skipped" }, today);
          changed++;
        }
      }
      if (changed > 0) writeHouseEvents(house, next);
    }
  }, [occasions, houseEvents]);

  // Seat rules for the SERVE STEP (spec §7.1): the cook's device screens
  // every seat with whatever it has cached — cached-first reads, so this is
  // instant when synced and silently rule-less when a seat's file has never
  // reached this phone (the hard screen still protects that person on their
  // own device; this only decides what the cook is told).
  const [serveRules, setServeRules] = useState(
    /** @type {Record<string, { diet?: string, avoidIngredients?: string[], avoidRecipes?: string[] } | null>} */ ({}),
  );
  useEffect(() => {
    // the serve tile lives on the RECIPE route since Cook Mode's removal
    // (2026-08-19). Reviewer catch: this guard still said "cook", a view the
    // router can no longer produce, so serveRules stayed {} forever and
    // every allergen SET-ASIDE row silently degraded to a plain plate line
    // — the exact screen whose job is telling the cook who must not get
    // the dish.
    if (route.view !== "recipe" || !route.table) return;
    const t = houseEventsRef.current
      .flatMap((h) => h.events.tables)
      .find((x) => x.id === route.table);
    if (!t) return;
    let alive = true;
    (async () => {
      /** @type {Record<string, any>} */
      const rules = {};
      // only seats belonging to REAL profiles: a corrupt seat id from the
      // shared events file must not steer a path (security review L1)
      const known = new Set(allProfilesRef.current.map((p) => p.id));
      for (const s of t.seats ?? []) {
        if (!known.has(s.id) || s.status === "skipped") continue;
        const tg = /** @type {any} */ (await readTargetsOf(s.id));
        rules[s.id] = tg
          ? {
              diet: tg.diet,
              avoidIngredients: tg.avoidIngredients,
              avoidRecipes: tg.avoidRecipes,
            }
          : null;
      }
      if (alive) setServeRules(rules);
    })();
    return () => {
      alive = false;
    };
    // houseEvents is a dep on purpose (ui-review B2): on a cold PWA open the
    // effect fires before the events cache loads, finds no table and bails;
    // without the dep it never re-runs and a conflicted seat would render as
    // a plain plate line. Re-runs are cached-first reads, cheap.
  }, [route.view, route.table, houseEvents]);

  // COOKED for a table (spec §7.2): set-once on the table event, the only
  // honest adoption signal the instrument has. No pantry consumption here —
  // batch consumption for shared pots is deploy-2 scope, and guessing at it
  // now would eat food twice once the frozen pot lands.
  const handleMarkTableCooked = useCallback(
    async (/** @type {string} */ tableId) => {
      for (const { house, events } of houseEventsRef.current) {
        const t = events.tables.find((x) => x.id === tableId);
        if (!t) continue;
        const today = localIsoDate(new Date());
        let next = setTableCooked(events, tableId, today, today);
        // second freeze trigger (spec 10): COOKED freezes a solved pot when
        // no VALID one exists. PARSE-AND-VALIDATE the raw field (loop-2 C5)
        // so a malformed, permuted, or orphaned pot (a pot on a table with
        // neither buyer nor cooked stamp, the N5 merge state, checked on
        // the PRE-write table) gets REPAIRED rather than laundered into a
        // legitimate-looking money contract by the cookedAt stamp.
        const recipe = bankRecipesRef.current.find((r) => r.id === t.recipeId);
        const orphan = Boolean(t.pot) && !t.buyerId && !t.cookedAt;
        const stored = next.tables.find((x) => x.id === tableId);
        if (stored && (orphan || !parsePot(stored.pot, recipe))) {
          const pot = await potStringFor(stored);
          next = setTablePot(next, tableId, pot ?? null, today);
        }
        writeHouseEvents(house, next);
        return;
      }
    },
    [writeHouseEvents],
  );

  // MY running (or imminent) occasion, for the Plan tab banner. The screen
  // lives in Settings and is invisible the other 360 days of the year, so on
  // the days it matters it has to announce itself where the food is.
  const occasionBanner = useMemo(() => {
    const today = localIsoDate(new Date());
    const soon = shiftIso(today, 3);
    const mine = occasions
      .filter((o) => o.profileId === me && o.to >= today && o.from <= soon)
      .sort((a, b) => a.from.localeCompare(b.from))[0];
    if (!mine) return null;
    const day = mine.days[today];
    return {
      emoji: mine.emoji,
      name: mine.name,
      when: day
        ? ""
        : ` starts ${parseLocalIso(mine.from).toLocaleDateString([], {
            weekday: "short",
            month: "short",
            day: "numeric",
          })}`,
      label: day ? `Today: ${day.label}.` : "The plan hands off on those days.",
      note: day?.note ?? "",
    };
  }, [occasions, me]);

  /**
   * Write one profile's occasions file and every week plan the occasion
   * touches. An occasion can straddle two ISO weeks (a Sunday procedure
   * with a Thursday prep day does), so the plan write is per week, never
   * "this week" — that assumption is exactly how a prep day goes missing.
   * @param {Record<string, any>} o
   * @param {"apply" | "remove"} mode
   */
  const writeOccasion = useCallback(
    async (
      /** @type {import("./lib/occasions.js").Occasion} */ o,
      /** @type {"apply" | "remove"} */ mode,
    ) => {
      const path = occasionsPathFor(o.profileId);
      const file = /** @type {any} */ (await read(path, { raw: true }).catch(() => null));
      const rest = (file?.occasions ?? []).filter((/** @type {any} */ x) => x.id !== o.id);
      await write(path, { occasions: mode === "apply" ? [...rest, o] : rest }, { raw: true });

      // group the occasion's dates by ISO week, then patch each plan file once
      /** @type {Map<string, string[]>} */
      const weeks = new Map();
      for (const date of occasionDatesOf(o)) {
        const wk = isoWeekId(parseLocalIso(date));
        weeks.set(wk, [...(weeks.get(wk) ?? []), date]);
      }
      for (const wk of weeks.keys()) {
        const planPath =
          o.profileId === "david" ? `plans/${wk}.json` : `profiles/${o.profileId}/plans/${wk}.json`;
        const cur = normalizePlan(
          /** @type {any} */ (await read(planPath, { raw: true }).catch(() => null)),
          wk,
        );
        const next = mode === "apply" ? applyOccasion(cur, o) : clearOccasion(cur, o.id);
        await write(planPath, /** @type {any} */ (next), { raw: true });
      }
    },
    [],
  );

  /**
   * Screen a draft occasion's food against the OCCASION OWNER's diet and
   * avoid list, not the device owner's. This is the whole reason it exists:
   * David builds his mother's prep week on his own phone, so every recipe the
   * picker offered was filtered through HIS allergens. Hers are the ones that
   * matter. Returns recipeId -> reasons, empty when clean.
   * @param {string} profileId
   * @param {string[]} recipeIds
   */
  const handleScreenOccasion = useCallback(
    async (/** @type {string} */ profileId, /** @type {string[]} */ recipeIds) => {
      const t = /** @type {any} */ (await readTargetsOf(profileId));
      const byId = recipesById([...bankRecipesRef.current, ...allRecipesRef.current]);
      /** @type {Record<string, string[]>} */
      const out = {};
      for (const id of new Set(recipeIds)) {
        const r = byId.get(id);
        if (!r) continue;
        const reasons = recipeConflicts(r, t?.diet, t?.avoidIngredients, t?.avoidRecipes);
        if (reasons.length > 0) out[id] = reasons;
      }
      return out;
    },
    [],
  );

  const handleApplyOccasion = useCallback(
    async (/** @type {import("./lib/occasions.js").Occasion} */ o) => {
      setOccBusy(true);
      try {
        await writeOccasion(o, "apply");
        setOccasions((cur) => [...cur.filter((x) => x.id !== o.id), o]);

        // and off the shared tables. A seat somebody cannot eat still sizes
        // the pot and still lands on a shopping list, so leaving it seated
        // would feed the whole house a prep-week portion nobody eats.
        if (o.offTables !== false) {
          const house = myHouseOf();
          const cur = houseEventsRef.current.find((h) => h.house === house)?.events;
          if (cur) {
            const today = localIsoDate(new Date());
            const leaving = tablesToLeave(cur.tables, [o], o.profileId, today);
            let next = cur;
            for (const tableId of leaving) {
              next = patchSeat(next, tableId, o.profileId, { status: "skipped" }, today);
            }
            if (leaving.length > 0) writeHouseEvents(house, next);
          }
        }
      } finally {
        setOccBusy(false);
      }
    },
    [writeOccasion, writeHouseEvents],
  );

  const handleRemoveOccasion = useCallback(
    async (/** @type {import("./lib/occasions.js").Occasion} */ o) => {
      const dayCount = occasionDatesOf(o).length;
      if (
        !(await askConfirm(
          `Remove ${o.name}? ${dayCount === 1 ? "That day comes" : `Those ${dayCount} days come`} back EMPTY, not ` +
            `re-planned: clearing an occasion and planning the days again are two different ` +
            `acts, and doing both at once would silently rewrite a week. Seats already taken ` +
            `off shared tables stay off — un-skipping them here could re-seat somebody who ` +
            `skipped for their own reasons.`,
        ))
      )
        return;
      setOccBusy(true);
      try {
        await writeOccasion(o, "remove");
        setOccasions((cur) => cur.filter((x) => x.id !== o.id));
      } finally {
        setOccBusy(false);
      }
    },
    [writeOccasion, askConfirm],
  );

  const handleCreateTable = useCallback(
    (
      /** @type {{ name: string, date: string, slot: string, recipeId: string, seats: import("./lib/tables.js").Seat[] }} */ t,
    ) => {
      const house = myHouseOf();
      const cur =
        houseEventsRef.current.find((h) => h.house === house)?.events ?? normalizeEvents(null);
      writeHouseEvents(house, addTable(cur, t, localIsoDate(new Date())));
    },
    [writeHouseEvents],
  );

  const handleRemoveTable = useCallback(
    async (/** @type {string} */ house, /** @type {string} */ id) => {
      if (house !== myHouseOf()) return; // amendment 5: foreign houses are read-only
      const cur = houseEventsRef.current.find((h) => h.house === house)?.events;
      if (!cur) return;
      // cancelling a table cancels DINNER FOR THE WHOLE HOUSE, from any
      // seat's phone — a tap that edits three other people's evenings gets a
      // question first (Tribunal U2: "skip mine" is the personal exit)
      const seats = cur.tables.find((t) => t.id === id)?.seats?.length ?? 0;
      if (
        seats > 1 &&
        !(await askConfirm(
          `Cancel this shared dinner for all ${seats} people? To bow out yourself, use SKIP MINE instead.`,
        ))
      )
        return;
      writeHouseEvents(house, removeTable(cur, id, localIsoDate(new Date())));
    },
    [writeHouseEvents, askConfirm],
  );

  const handleSameForEveryone = useCallback(
    (/** @type {string} */ house, /** @type {string} */ tableId, /** @type {boolean} */ same) => {
      const cur = houseEventsRef.current.find((h) => h.house === house)?.events;
      if (!cur) return;
      writeHouseEvents(
        house,
        setTableSameForEveryone(cur, tableId, same, localIsoDate(new Date())),
      );
    },
    [writeHouseEvents],
  );

  const handlePatchSeat = useCallback(
    (
      /** @type {string} */ house,
      /** @type {string} */ tableId,
      /** @type {Partial<import("./lib/tables.js").Seat>} */ patch,
    ) => {
      const cur = houseEventsRef.current.find((h) => h.house === house)?.events;
      if (!cur) return;
      writeHouseEvents(house, patchSeat(cur, tableId, me, patch, localIsoDate(new Date())));
    },
    [writeHouseEvents],
  );

  // ---- brigades (S3): the standing table ---------------------------------
  // Everything a brigade does is done by materializing ordinary tables, so
  // only two things live here: creating/removing the rule, and running the
  // factory. The factory needs every member's targets (portions come from
  // each person's own numbers), and those are per-profile raw reads, so this
  // is async where table creation is not.
  const handleCreateBrigade = useCallback(
    (
      /** @type {{ name: string, memberIds: string[], slots: string[], cookId?: string, from: string, until: string }} */ b,
    ) => {
      const house = myHouseOf();
      const cur =
        houseEventsRef.current.find((h) => h.house === house)?.events ?? normalizeEvents(null);
      writeHouseEvents(house, addBrigade(cur, b, localIsoDate(new Date())));
    },
    [writeHouseEvents],
  );

  const handleRemoveBrigade = useCallback(
    (/** @type {string} */ id) => {
      const house = myHouseOf();
      const cur = houseEventsRef.current.find((h) => h.house === house)?.events;
      if (!cur) return;
      writeHouseEvents(house, removeBrigade(cur, id, localIsoDate(new Date())));
    },
    [writeHouseEvents],
  );

  /**
   * Run a brigade over a week. ANY member may call it: the ids are
   * deterministic, so whoever gets there first fixes the week and a second
   * device's write merges onto the same rows. `cookId` decides who shops,
   * not who is allowed to generate, otherwise everyone else stares at empty
   * dinner slots waiting on the cook.
   */
  const handleRunBrigade = useCallback(
    async (/** @type {string} */ brigadeId, /** @type {string} */ week, regenerate = false) => {
      const house = myHouseOf();
      const cur = houseEventsRef.current.find((h) => h.house === house)?.events;
      const brigade = cur?.brigades?.find((b) => b.id === brigadeId);
      if (!cur || !brigade) return { made: 0, thin: [] };

      /** @type {Map<string, any>} */
      const targetsById = new Map();
      for (const id of brigade.memberIds) {
        targetsById.set(id, await readTargetsOf(id));
      }

      const { events, made, thin } = materializeBrigade(cur, brigade, {
        dates: datesOfWeek(week),
        today: localIsoDate(new Date()),
        house,
        profilesById: new Map(allProfilesRef.current.map((p) => [p.id, p])),
        targetsById,
        bankById: recipesById(bankRecipesRef.current),
        regenerate,
      });
      // write when anything changed — pruning expired tables counts even
      // when no new meal was made
      if (made > 0 || events.tables.length !== cur.tables.length) writeHouseEvents(house, events);
      // zero overlap between the viewed week and the brigade's span is the
      // W31/W32 trap: "made 0" would read as "already set" while nothing was
      // set at all — name the real cause so the view can say it (Realist e)
      const overlap = datesOfWeek(week).filter(
        (d) => d >= brigade.from && d <= brigade.until,
      ).length;
      return { made, thin, outOfRange: overlap === 0, from: brigade.from, until: brigade.until };
    },
    [writeHouseEvents],
  );

  // Tribunal amendment 1a: creation-time diet/avoid screen per prospective
  // seat, reading each profile's own targets (raw paths per SCHEMAS.md)
  const handleSeatScreen = useCallback(async (/** @type {string} */ recipeId) => {
    const recipe = recipesById(bankRecipesRef.current).get(recipeId);
    /** @type {Record<string, string[]>} */
    const out = {};
    if (!recipe) return out;
    for (const p of allProfilesRef.current) {
      const t = /** @type {any} */ (await readTargetsOf(p.id));
      out[p.id] = recipeConflicts(recipe, t?.diet, t?.avoidIngredients, t?.avoidRecipes);
    }
    return out;
  }, []);

  // per-person facts for the AI features (menu scan, tailor, dinner): each
  // profile's goal + targets + diet screen, read from its own targets file
  // (same raw paths as handleSeatScreen)
  const handleDinerFacts = useCallback(async (/** @type {string[]} */ ids) => {
    const out = [];
    for (const id of ids) {
      const p = allProfilesRef.current.find((x) => x.id === id);
      // a failed read maps to unconfirmed:true (fail-closed split, C1) — the
      // null survives, and dinerFacts makes it distinguishable from clean
      const t = /** @type {any} */ (await readTargetsOf(id));
      out.push(dinerFacts(id, /** @type {string} */ (p?.name ?? id), t));
    }
    return out;
  }, []);

  // AI plate-tailoring for a table: one dish, per-seat plating adjustments
  // toward each seat's own targets, persisted on the table so every seat's
  // device shows the same plates
  const handleTailorTable = useCallback(
    async (/** @type {string} */ house, /** @type {string} */ tableId) => {
      const cur = houseEventsRef.current.find((h) => h.house === house)?.events;
      const t = cur?.tables.find((x) => x.id === tableId);
      const recipe = t ? recipesById(bankRecipesRef.current).get(t.recipeId) : null;
      if (!cur || !t || !recipe) throw new Error("table or recipe missing — sync first");
      const live = (t.seats ?? []).filter((s) => s.status !== "skipped");
      if (live.length === 0) throw new Error("everyone skipped this table — nothing to tailor");
      const facts = await handleDinerFacts(live.map((s) => s.id));
      const n = recipe.nutrition ?? {};
      const result = await tailorTable(
        {
          name: recipe.name,
          servings: recipe.servings ?? 1,
          calories: n.calories ?? 0,
          protein: n.protein ?? 0,
          carbs: n.carbs ?? 0,
          fat: n.fat ?? 0,
          // measured, not just named: gram-level plate math needs the real
          // amounts ("300 g chicken thigh"), so the model can weigh honestly
          ingredients: (recipe.ingredients ?? []).map((/** @type {any} */ i) =>
            i.qty ? `${i.qty} ${i.unit ?? "x"} ${i.food}` : String(i.food ?? ""),
          ),
        },
        /** @type {any} */ (
          facts.map((f) => ({
            ...f,
            say: `eats ${live.find((s) => s.id === f.id)?.servings ?? 1} serving(s) of this dish`,
          }))
        ),
      );
      if (Object.keys(result.seats).length === 0)
        throw new Error("no tailoring came back — try again");
      const today = localIsoDate(new Date());
      writeHouseEvents(house, setTableTailor(cur, tableId, { at: today, ...result }, today));
    },
    [writeHouseEvents, handleDinerFacts],
  );

  // the human half of the auto-plan trust fence: one tap sets promoted:true
  // on an AI-written bank recipe (hbp-annotated / ai-special), letting the
  // week generator and brigades use it. Writing the flag IS the audit.
  const handlePromoteRecipe = useCallback(async (/** @type {Record<string, any>} */ recipe) => {
    const promoted = { ...recipe, promoted: true };
    await write(`recipes/${recipe.id}.json`, /** @type {any} */ (promoted), { raw: true });
    setBankRecipes([...bankRecipesRef.current.filter((r) => r.id !== recipe.id), promoted]);
  }, []);

  // one settled dinner decision → the recipe id it lands on. A special meal
  // is first written to the shared bank (tagged ai-special) so the whole
  // table machinery — macros, shopping, everyone's plan — works unchanged.
  const decisionRecipeId = useCallback(
    async (/** @type {Record<string, any>} */ decision, /** @type {string} */ date) => {
      let recipeId = /** @type {string} */ (decision.pickRecipeId || "");
      if (!recipeId && decision.special) {
        const s = decision.special;
        // date-suffixed so two discussions landing on the same generic name
        // ("quick stir-fry") never overwrite each other's recipe
        recipeId = `special-${slug(s.name)}-${date}`;
        const recipe = {
          id: recipeId,
          name: s.name,
          description: s.description || "Special dinner from the household discussion.",
          servings: s.servings,
          totalTime: s.totalTime,
          mealType: "dinner",
          tags: ["ai-special"],
          purpose: ["everyday"],
          effort: s.totalTime <= 15 ? "assembly" : s.totalTime <= 30 ? "cook" : "project",
          ingredients: s.ingredients,
          instructions: s.instructions,
          nutrition: s.nutrition,
          foodGroups: s.foodGroups,
        };
        await write(`recipes/${recipeId}.json`, /** @type {any} */ (recipe), { raw: true });
        setBankRecipes([...bankRecipesRef.current.filter((r) => r.id !== recipeId), recipe]);
      }
      if (!recipeId) throw new Error("the decision names no recipe");
      return recipeId;
    },
    [],
  );

  /**
   * Add one decided shared meal to a house's events: the table plus, when
   * the decision carries per-person plate specs, its tailor block. Pure over
   * `events` so a week of meals composes into ONE events write. `buyerId`
   * pre-claims the groceries (the week runner shops today — 21 I'LL-BUY-THIS
   * taps is not a flow).
   * @type {(events: any, decision: Record<string, any>, participantIds: string[], recipeId: string, date: string, slot: string, name: string, today: string, buyerId?: string, brigadeCtx?: { brigade: import("./lib/tables.js").Brigade, servingsFor: (id: string, slot: string, recipeId: string) => number, cookFor: (date: string) => string } | null, fromWeekRun?: boolean) => any}
   */
  const tableFromDecision = useCallback(
    (events, decision, participantIds, recipeId, date, slot, name, today, buyerId, brigadeCtx, fromWeekRun) => {
      const withTable = addTable(
        events,
        {
          name,
          date,
          slot,
          recipeId,
          ...(buyerId ? { buyerId } : {}),
          // stamped so REPLAN can tell this feature's tables from hand-set
          // ones (plenum r2); validTable is a predicate, the field survives
          ...(fromWeekRun ? { fromWeekRun: true } : {}),
          // run AS the brigade: deterministic id (two offline devices merge
          // onto the same rows), the brigade's rotated cook, and seats sized
          // from each member's own targets — one pot, different plates
          ...(brigadeCtx
            ? {
                id: brigadeTableId(brigadeCtx.brigade.id, date, slot),
                fromBrigade: brigadeCtx.brigade.id,
                cookId: brigadeCtx.cookFor(date),
              }
            : {}),
          seats: participantIds.map((id) => ({
            id,
            servings: brigadeCtx ? brigadeCtx.servingsFor(id, slot, recipeId) : 1,
          })),
        },
        today,
      );
      const newTable = withTable.tables[withTable.tables.length - 1];
      /** @type {Record<string, { plate: string[], estCalories: number, estProtein: number }>} */
      const seats = {};
      for (const p of decision.plates ?? []) {
        // plates only for people actually seated at THIS meal — attendance
        // can exclude someone from a day, and the model may still have
        // written them a plate
        if (p.note && participantIds.includes(p.id))
          seats[p.id] = { plate: [p.note], estCalories: p.estCalories, estProtein: p.estProtein };
      }
      return Object.keys(seats).length > 0 && newTable
        ? setTableTailor(withTable, newTable.id, { at: today, seats, cook: [] }, today)
        : withTable;
    },
    [],
  );

  // dinner-discussion decision → a real table for tonight
  const handleApplyDinner = useCallback(
    async (/** @type {Record<string, any>} */ decision, /** @type {string[]} */ participantIds) => {
      const today = localIsoDate(new Date());
      const recipeId = await decisionRecipeId(decision, today);
      const house = myHouseOf();
      const cur =
        houseEventsRef.current.find((h) => h.house === house)?.events ?? normalizeEvents(null);
      writeHouseEvents(
        house,
        tableFromDecision(
          cur,
          decision,
          participantIds,
          recipeId,
          today,
          "dinner",
          "Tonight's dinner",
          today,
        ),
      );
    },
    [writeHouseEvents, decisionRecipeId, tableFromDecision],
  );

  // WEEK OF MEALS (David, 2026-08-09): pick people + a cuisine, one call
  // plans every remaining picked slot — the house cooks each slot ONCE,
  // everyone eats the same food, and goals survive through strict
  // per-person portioning. Smoothies and snacks are plannable slots too
  // (2026-08-28 plenum); leave their chips off to keep them personal.
  // Each meal lands as a real table (seats, plan derivation,
  // shopping, plate specs) with the groceries pre-claimed by the runner, so
  // the list is buildable and shoppable the same day.
  const handleDinnerWeek = useCallback(
    async (
      /** @type {string[]} */ participantIds,
      /** @type {{ date: string, slot: string }[]} */ meals,
      /** @type {string} */ cuisine,
      /** @type {string} */ note,
      /** @type {Record<string, string[]>} */ away = {},
      /** @type {import("./lib/tables.js").Brigade | null} */ brigade = null,
      useSwipes = true,
      replace = false,
    ) => {
      const today = localIsoDate(new Date());
      const me = activeProfile();
      // every participant's targets, loaded up front: swipe claims and the
      // covered map need them, brigade seat sizing reuses them below
      /** @type {Map<string, Record<string, any> | null>} */
      const targetsById = new Map();
      for (const id of participantIds) {
        targetsById.set(id, /** @type {any} */ (await readTargetsOf(id)));
      }
      const buffetOf = (/** @type {string} */ id) =>
        (targetsById.get(id)?.currencies ?? []).find(
          (/** @type {any} */ c) => c.venue === "buffet" && Number(c.perWeek) > 0,
        );
      // SWIPES BEFORE POTS (P5, P10, David 2026-08-28 plenum; widened round
      // three: "elliot has swipes same as me"). EVERY participant whose own
      // targets carry a buffet currency eats that slot on a swipe: the run
      // takes them off those pots (per-slot away entries) instead of seating
      // them at a cooked meal the swipe already paid for. Only the RUNNER's
      // plan is seeded with swipe entries (the Tribunal veto on writing
      // other people's plans stands); a housemate's own GENERATE places
      // theirs, exactly as 2026-08-24 wired it — the run just leaves their
      // seat empty and says so in the notes.
      /** @type {Record<string, { date: string, slot: string }[]>} */
      const swipersById = {};
      if (useSwipes) {
        for (const id of participantIds) {
          const b = buffetOf(id);
          if (!b) continue;
          const mealsForId = meals.filter((m) => !(away[id] ?? []).includes(m.date));
          // the runner's claim is ledger-aware against their own plan;
          // a housemate's walks the same slot+allowance rules over an
          // empty ledger (their plan is theirs to read on their device)
          const pairs = weekRunSwipes(
            mealsForId,
            /** @type {any} */ (b),
            id === me
              ? /** @type {import("./lib/plan.js").Plan} */ (planRef.current)
              : { week: "", entries: [] },
            today,
          );
          if (pairs.length > 0) swipersById[id] = pairs;
        }
      }
      for (const [id, pairs] of Object.entries(swipersById)) {
        away = { ...away, [id]: [...(away[id] ?? []), ...pairs.map((m) => `${m.date}|${m.slot}`)] };
      }
      const buffet = buffetOf(me);
      const swipePairs = swipersById[me] ?? [];
      const anySwiped = (/** @type {{ date: string, slot: string }} */ m) =>
        Object.values(swipersById).some((ps) =>
          ps.some((s) => s.date === m.date && s.slot === m.slot),
        );
      // the attendance test the whole run shares: a whole-day away entry or
      // this meal's own date|slot entry both empty the seat
      const isAway = (
        /** @type {string} */ id,
        /** @type {string} */ date,
        /** @type {string} */ slot,
      ) => (away[id] ?? []).includes(date) || (away[id] ?? []).includes(`${date}|${slot}`);
      // a meal NOBODY is present for is never cooked: swipe-covered pairs go
      // silently (the swiped report line covers them), a day everyone is
      // away keeps the honest note it always got
      /** @type {string[]} */
      const dropNotes = [];
      const cooked = meals.filter((m) => {
        if (participantIds.some((id) => !isAway(id, m.date, m.slot))) return true;
        if (!anySwiped(m)) dropNotes.push(`${m.date} ${m.slot}: everyone is away — no table set`);
        return false;
      });
      const facts = await handleDinerFacts(participantIds);
      // WHAT EACH DAY ALREADY DELIVERS outside the planned meals (P2, P5,
      // plenum round two: "342 grams instead of the 190 target"). The model
      // balanced whole days over two cooked meals, then the 1,200 kcal swipe
      // and the 702 kcal fixed smoothie landed on top — 4,430 kcal / 266 g
      // days measured on the real W36. Each person's swipe + unplanned
      // fixed-slot delivery is spelled out so plates aim at the remainder.
      const plannedSlots = new Set(cooked.map((m) => m.slot));
      /** @type {Record<string, { calories: number, protein: number, note: string }>} */
      const coveredById = {};
      for (const id of participantIds) {
        const b = buffetOf(id);
        const cov = dailyCovered(
          targetsById.get(id),
          recipesById(bankRecipesRef.current),
          plannedSlots,
          swipersById[id] && b
            ? buffetMacroEstimate(recipesRef.current, String(b.preferredSlot || "lunch"), b)
            : null,
        );
        if (cov) coveredById[id] = cov;
      }
      const brigadeCtx = brigade
        ? {
            brigade,
            servingsFor: (
              /** @type {string} */ id,
              /** @type {string} */ slot,
              /** @type {string} */ recipeId,
            ) =>
              seatServingsFor(
                targetsById.get(id) ?? undefined,
                slot,
                recipesById(bankRecipesRef.current).get(recipeId),
              ),
            cookFor: (/** @type {string} */ date) => {
              const members = brigade.memberIds.filter((id) => participantIds.includes(id));
              if (!brigade.rotateCooks || members.length === 0)
                return members.includes(brigade.cookId ?? "")
                  ? /** @type {string} */ (brigade.cookId)
                  : (members[0] ?? participantIds[0] ?? "david");
              const off = Math.round((Date.parse(date) - Date.parse(brigade.from)) / 86400000);
              return /** @type {string} */ (
                members[((off % members.length) + members.length) % members.length] ?? members[0]
              );
            },
          }
        : null;
      const rawCandidates = bankRecipesRef.current
        // every plannable slot's recipes, smoothies and snacks included
        // (2026-08-28 plenum: a brigade sharing its smoothies found them
        // silently dropped by the old breakfast/lunch/dinner filter)
        .filter((r) => SLOT_KEYS.includes(r.mealType))
        // the model never sees ingredients, so a bank pick that hits ANY
        // participant's diet/avoid screen must never reach it — otherwise the
        // pick derives as a conflict banner on that person's phone and the
        // family eats a table that person's plan refuses (mom's onion
        // shawarma, 2026-08-09). Same predicate the derivation enforces.
        .filter((r) =>
          facts.every(
            (f) => recipeConflicts(r, f.diet, f.avoid, f.avoidRecipes ?? []).length === 0,
          ),
        )
        .map((r) => ({
          id: /** @type {string} */ (r.id),
          name: /** @type {string} */ (r.name),
          calories: /** @type {number} */ (r.nutrition?.calories ?? 0),
          protein: /** @type {number} */ (r.nutrition?.protein ?? 0),
          cuisine: /** @type {string} */ (r.cuisine ?? ""),
          meal: /** @type {string} */ (r.mealType),
        }));
      // THE LEAN MENU SCREEN (2026-08-29 scorch): when a swipe/fixed credit
      // means someone's cooked day must run lean, the too-dense candidates
      // leave the light slots BEFORE the model sees the menu. The prompt's
      // band + LEAN labels measurably did not hold on their own (asked for
      // 100-120 g planned, delivered 139-180); a dish not on the menu
      // cannot be picked. Dinner/lunch keep the full menu (the anchor).
      const { candidates, curated } = leanWeekMenu(rawCandidates, facts, coveredById);
      const { nights, notes } =
        cooked.length > 0
          ? await dinnerWeek(facts, candidates, cooked, cuisine, note, away, coveredById)
          : { nights: [], notes: /** @type {string[]} */ ([]) };
      notes.push(...dropNotes);
      if (curated && cooked.length > 0) {
        notes.push(
          "🥗 lean menu: a swipe/fixed credit already carries most of someone's protein, so breakfast, smoothie and snack were picked from the lean half of the bank; dinner kept the full menu",
        );
      }
      const house = myHouseOf();
      // resolve every recipe (specials write to the bank) BEFORE touching
      // events, then compose all tables synchronously off a FRESH events read
      // — reading events first and awaiting per special leaves a seconds-wide
      // window where another phone's table claim gets clobbered by our write
      /** @type {{ n: Record<string, any>, recipeId: string }[]} */
      const resolved = [];
      for (const n of nights) {
        resolved.push({ n, recipeId: await decisionRecipeId(n, n.date) });
      }
      let cur =
        houseEventsRef.current.find((h) => h.house === house)?.events ?? normalizeEvents(null);
      // REPLAN (plenum r2): replace what a previous week run set, so a run
      // whose plates came out wrong is redone with one tap instead of
      // fourteen CANCELs. Only upcoming tables THIS feature made (stamped
      // fromWeekRun, or the pre-stamp runs' "Family <slot>" naming) and only
      // for the date+slot pairs being replanned; hand-set tables and
      // brigade-materialized tables are never touched.
      if (replace) {
        const wanted = new Set(meals.map((m) => `${m.date}|${m.slot}`));
        cur = {
          ...cur,
          tables: cur.tables.filter(
            (t) =>
              !(
                (/** @type {any} */ (t).fromWeekRun || (t.name ?? "").startsWith("Family ")) &&
                t.date >= today &&
                wanted.has(`${t.date}|${t.slot}`)
              ),
          ),
        };
      }
      /** @type {{ date: string, slot: string, name: string, why: string }[]} */
      const made = [];
      for (const { n, recipeId } of resolved) {
        // attendance: someone marked away for a date is seated on NONE of
        // that day's tables — and a per-slot entry (a dining swipe) empties
        // just that one seat. Portions, plates and the buy shrink with it.
        const present = participantIds.filter(
          (id) => !isAway(id, n.date, /** @type {string} */ (n.slot ?? "dinner")),
        );
        if (present.length === 0) {
          notes.push(`${n.date} ${n.slot ?? "dinner"}: everyone is away — no table set`);
          continue;
        }
        cur = tableFromDecision(
          cur,
          n,
          present,
          recipeId,
          n.date,
          n.slot ?? "dinner",
          brigade ? brigade.name : `Family ${n.slot ?? "dinner"}`,
          today,
          me,
          brigadeCtx,
          true,
        );
        made.push({
          date: n.date,
          slot: /** @type {string} */ (n.slot ?? "dinner"),
          name:
            n.special?.name ??
            bankRecipesRef.current.find((r) => r.id === recipeId)?.name ??
            recipeId,
          why: n.why ?? "",
        });
      }
      if (made.length > 0) writeHouseEvents(house, cur);
      // HONEST BOUNDS CHECK (P1, P5; per-DAY since 2026-08-29 scorch — the
      // avg-only version let a 270 g Monday hide behind a lean Sunday).
      // The model is ASKED for a protein band; the arithmetic is VERIFIED
      // here, and a breach is said in the result instead of discovered
      // later. Both directions: a day over the ceiling wastes money, a day
      // under the floor breaks the one nonnegotiable, and each names its
      // dates so 🔁 REPLACE has a target.
      for (const id of participantIds) {
        const t = targetsById.get(id);
        const floor = Number(t?.macros?.protein) || 0;
        const ceil = Number(t?.macros?.proteinCeiling) || Math.round(floor * 1.15);
        if (!ceil && !floor) continue;
        /** @type {Record<string, number>} */
        const byDate = {};
        for (const { n } of resolved) {
          const slot = /** @type {string} */ (n.slot ?? "dinner");
          if (isAway(id, n.date, slot)) continue;
          const p = (n.plates ?? []).find((/** @type {any} */ x) => x.id === id);
          if (p) byDate[n.date] = (byDate[n.date] ?? 0) + (Number(p.estProtein) || 0);
        }
        if (Object.keys(byDate).length === 0) continue;
        // the covered credit is DATE-AWARE here (reviewer catch 2026-08-29):
        // fixed-slot delivery is daily, but the swipe estimate only lands on
        // the dates this run actually swiped — a flat credit flagged normal
        // non-swipe days over the ceiling and hid real floor misses whenever
        // the allowance covered only part of the planned days
        const covB = buffetOf(id);
        const swipeP =
          swipersById[id] && covB
            ? buffetMacroEstimate(
                recipesRef.current,
                String(covB.preferredSlot || "lunch"),
                covB,
              ).estProtein
            : 0;
        const fixedP = Math.max(0, (coveredById[id]?.protein ?? 0) - swipeP);
        const swipeDates = new Set((swipersById[id] ?? []).map((m) => m.date));
        const covOn = (/** @type {string} */ d) => fixedP + (swipeDates.has(d) ? swipeP : 0);
        const over = Object.entries(byDate)
          .filter(([d, g]) => ceil > 0 && g + covOn(d) > ceil)
          .map(([d, g]) => `${d.slice(5)} ~${Math.round(g + covOn(d))}g`);
        const short = Object.entries(byDate)
          .filter(([d, g]) => floor > 0 && g + covOn(d) < floor)
          .map(([d, g]) => `${d.slice(5)} ~${Math.round(g + covOn(d))}g`);
        const who = allProfilesRef.current.find((p) => p.id === id)?.name ?? id;
        if (over.length > 0) {
          notes.push(
            `⚠ ${who}: ${over.length} ${over.length === 1 ? "day is" : "days are"} over the ${ceil} g ceiling (${over.join(", ")}) — 🔁 REPLACE re-picks leaner`,
          );
        }
        if (short.length > 0) {
          notes.push(
            `⚠ ${who}: ${short.length} ${short.length === 1 ? "day is" : "days are"} under the ${floor} g floor (${short.join(", ")}) — cover it with their own plan or a bigger plate`,
          );
        }
      }
      // the swipes land IN the plan right now — pinned, with the PICK MY
      // TRAY link the planner already puts on every swipe entry — not on
      // some later GENERATE he has to remember (the 2026-08-24 lesson)
      if (swipePairs.length > 0 && buffet) {
        const slot = String(buffet.preferredSlot || "lunch");
        const seeded = planSwipes(
          /** @type {import("./lib/plan.js").Plan} */ (planRef.current),
          swipePairs.map((m) => m.date),
          {
            perWeek: buffet.perWeek,
            currencyId: buffet.id,
            slot,
            estimate: buffetMacroEstimate(recipesRef.current, slot, buffet),
            today,
          },
        );
        if (seeded !== planRef.current) updatePlan(seeded);
      }
      // housemate swipers are off the pots but their plans are their own to
      // write (Tribunal veto): report it so it is never silent — their own
      // GENERATE places the swipe entries on their plan
      const swipedOthers = Object.entries(swipersById)
        .filter(([id]) => id !== me)
        .map(([id, pairs]) => ({
          name: /** @type {string} */ (
            allProfilesRef.current.find((p) => p.id === id)?.name ?? id
          ),
          count: pairs.length,
          slot: pairs[0]?.slot ?? "lunch",
        }));
      return { made, notes, swiped: swipePairs, swipedOthers };
    },
    [writeHouseEvents, decisionRecipeId, tableFromDecision, handleDinerFacts, updatePlan],
  );

  // Adherence scoreboard (David, 2026-07-24): every household member's
  // CURRENT-week score from the same raw files the honest-state features
  // write (plan cookedAt/shoppedAt + daily logs). Same yardstick for
  // everyone — that's what makes the leaderboard a competition. Purely
  // derived, nothing stored.
  const [scoreboard, setScoreboard] = useState(
    /** @type {{ id: string, name: string, emoji: string, score: number, cooked: { done: number, total: number }, shopped: boolean }[]} */ ([]),
  );
  useEffect(() => {
    let alive = true;
    const load = () => {
      void (async () => {
        const prof = await readProfiles();
        if (!alive) return;
        const meNow = activeProfile() ?? "david";
        const myHouse = prof.profiles.find((p) => p.id === meNow)?.household ?? "home";
        const members = prof.profiles.filter((p) => (p.household ?? "home") === myHouse);
        const weekNow = isoWeekId(new Date());
        const todayNow = localIsoDate(new Date());
        const raws = await Promise.all(
          members.map(async (p) => {
            const prefix = p.id === "david" ? "" : `profiles/${p.id}/`;
            const planRaw = await read(`${prefix}plans/${weekNow}.json`, { raw: true }).catch(
              () => null,
            );
            return { p, planRaw };
          }),
        );
        // ONE receipt per house per week is the designed flow — the scanner's
        // shoppedAt credits every housemate's scoreboard, same houseShopped
        // rule the recipe gate already learned (Tribunal U9: a family with
        // one shopper must not cap three people at 80 all week)
        const anyShopped = raws.some((r) => Boolean(/** @type {any} */ (r.planRaw)?.shoppedAt));
        const rows = raws.map(({ p, planRaw }) => {
          const credited =
            anyShopped && planRaw && !(/** @type {any} */ (planRaw).shoppedAt)
              ? { .../** @type {any} */ (planRaw), shoppedAt: todayNow }
              : planRaw;
          return {
            id: /** @type {string} */ (p.id),
            name: /** @type {string} */ (p.name ?? p.id),
            emoji: /** @type {string} */ (p.emoji ?? ""),
            ...weekAdherence({
              plan: /** @type {any} */ (credited),
              weekId: weekNow,
              today: todayNow,
            }),
          };
        });
        if (alive) setScoreboard(rankScoreboard(rows));
      })();
    };
    load();
    const unsub = onSyncChange(load);
    return () => {
      alive = false;
      unsub();
    };
  }, [hasToken]);

  // Money ledger (roadmap M1): my house's who-owes-who from finished
  // tables. The COOK's device records each finished table exactly once
  // (idempotent by table id, id-keyed merge dedupes concurrent recorders).
  const [ledger, setLedger] = useState(normalizeLedger(null));
  const ledgerRef = useRef(ledger);
  ledgerRef.current = ledger;
  useEffect(() => {
    let alive = true;
    const load = () => {
      void (async () => {
        const prof = await readProfiles();
        if (!alive) return;
        const mine = prof.profiles.find((p) => p.id === me);
        const house = /** @type {string} */ (mine?.household ?? "home");
        const raw = /** @type {any} */ (
          await read(ledgerPathFor(house), { raw: true }).catch(() => null)
        );
        if (alive) setLedger(normalizeLedger(raw));
      })();
    };
    load();
    const unsub = onSyncChange(load);
    return () => {
      alive = false;
      unsub();
    };
  }, [hasToken, me]);

  // record finished tables I cooked into the house ledger
  useEffect(() => {
    try {
      const today = localIsoDate(new Date());
      const profilesById = new Map(allProfiles.map((p) => [p.id, p]));
      const myHouse = /** @type {string} */ (profilesById.get(me)?.household ?? "home");
      const bankById = recipesById(bankRecipes);
      /** @type {import("./lib/money.js").LedgerEntry[]} */
      const candidates = [];
      for (const { house, events } of houseEvents) {
        if (house !== myHouse) continue; // v1: my house's ledger only
        for (const t of events.tables) {
          if (typeof t.date !== "string" || t.date >= today) continue; // finished only
          // the PAYER is whoever CLAIMED the groceries (buyerId), falling
          // back to the cook for unclaimed tables — the receipt money came
          // out of the buyer's pocket, and their device records the debt
          const cook = cookOf(t, house, profilesById);
          const payer = /** @type {any} */ (t).buyerId ?? cook?.id;
          if (!payer || payer !== me) continue; // the payer records
          const recipe = bankById.get(t.recipeId);
          if (!recipe) continue;
          const store = priceCatalogue?.stores?.[0] ?? "";
          const entry = ledgerEntryFor(t, me, recipe, priceCatalogue, store, profilesById);
          if (entry) candidates.push(entry);
        }
      }
      if (candidates.length === 0) return;
      const { ledger: next, added } = recordEntries(ledgerRef.current, candidates);
      if (added > 0) {
        setLedger(next);
        void write(ledgerPathFor(myHouse), /** @type {any} */ (next), { raw: true });
      }
    } catch {
      // costing must never break the app; the ledger just waits
    }
  }, [houseEvents, allProfiles, bankRecipes, priceCatalogue, me]);

  const handleSettle = useCallback(
    (/** @type {string} */ other) => {
      const profilesById = new Map(allProfilesRef.current.map((p) => [p.id, p]));
      const myHouse = /** @type {string} */ (profilesById.get(me)?.household ?? "home");
      const next = settleBetween(ledgerRef.current, me, other);
      setLedger(next);
      void write(ledgerPathFor(myHouse), /** @type {any} */ (next), { raw: true });
    },
    [me],
  );

  const moneyBalances = useMemo(() => balancesFor(ledger, me), [ledger, me]);

  const publicAlarm = repo?.privacy === "PUBLIC";
  // A DEAD TOKEN MUST BE LOUD, not a two-word badge in a corner.
  // The statusline already flips to "⚠ n UNSAVED" when a push fails, and that
  // is not enough: you press GENERATE, watch a whole week appear on screen,
  // and nothing tells you it will evaporate on reload. `tokenBroken` covers
  // BOTH failure modes and they need opposite instructions — "invalid" means
  // renew it, "norepo" means the token is fine and its repository access is
  // wrong, and telling someone to renew in the norepo case is the instruction
  // that cost David five tokens on 2026-08-16.
  const syncDead = tokenBroken(repo?.auth);
  // throttling is not a broken token and must not send anyone to regenerate a
  // working one; it says so and gets out of the way
  const syncThrottled = repo?.auth === "throttled";
  // header and probe results must never disagree: offline if either says so
  const effectiveOnline = online && (repo ? repo.reachable : true);
  // IDENTITY lookup (allRecipes, not the screened pool): detail pages, peek,
  // and cook mode render what the plan SAYS, including a banned-but-still-
  // planned recipe — bans govern picking, not what an existing entry means
  const recipeById = (/** @type {string | undefined} */ id) => allRecipes.find((r) => r.id === id);

  const loading = recipes.length === 0 && hasToken;

  // Cook Mode is gone (David 2026-08-19): the recipe page carries the timer
  // (entry COOKED write) and the serve tile (table COOKED write). The serve
  // model derives here exactly as the old cook route did (spec §7.1).
  const routeTable = route.table
    ? houseEvents.flatMap((h) => h.events.tables).find((t) => t.id === route.table)
    : undefined;
  const routeServe =
    routeTable && !routeTable.sameForEveryone
      ? buildServe(
          routeTable,
          bankRecipes.find((r) => r.id === routeTable.recipeId),
          allProfiles,
          serveRules,
          liveSynthFor(routeTable),
        )
      : null;
  // the R6 warning (spec 10 C6): a serve tile reached before anyone claimed
  // the buy is the last honest moment to say a configured seat's plan never
  // synced here
  if (routeServe && routeTable && !routeTable.buyerId && !routeTable.cookedAt) {
    const warn = missingPlanWarning(routeTable);
    if (warn) routeServe.cookNotes = [...routeServe.cookNotes, warn];
  }

  const now = new Date();
  return html`
    ${
      syncDead &&
      html`<div class="banner red">
        ⚠ NOTHING IS SAVING.
        ${
          repo?.auth === "norepo"
            ? html` Your token is valid, but it cannot see ${DATA_REPO.owner}/${DATA_REPO.repo}. Do
              NOT create a new one, that is the one thing that cannot help. Fix its repository
              access: github.com → Settings → Developer settings → Fine-grained tokens → your token
              → Repository access → Only select repositories → ${DATA_REPO.repo}, and Permissions →
              Contents: Read and write.`
            : html` GitHub is rejecting your token. Renew it in SYS: github.com → Settings →
              Developer settings → Fine-grained tokens → your token → Regenerate, then paste the new
              string into SYS.`
        }
        Everything you do still works and is kept on this
        device${sync.pending > 0 ? ` (${sync.pending} waiting)` : ""}, and it will push itself once
        this is fixed. Until then do NOT reinstall the app or change the data repo, because this
        device is the only copy.
      </div>`
    }
    ${
      syncThrottled &&
      html`<div class="banner">
        GitHub is rate-limiting writes right now. Nothing is wrong with your token and there is
        nothing to fix: everything is kept on this
        device${sync.pending > 0 ? ` (${sync.pending} waiting)` : ""} and pushes itself shortly. Do
        NOT regenerate the token.
      </div>`
    }
    ${
      publicAlarm &&
      html`<div class="banner red">
        ⚠ DATA REPO IS PUBLIC — ${DATA_REPO.owner}/${DATA_REPO.repo} is visible to anyone. Make it
        private on GitHub now: Settings → Danger Zone → Change visibility.
      </div>`
    }

    <div class="statusline">
      <span>${statusDate(now)} · WK-${isoWeekId(now).split("-W")[1]}</span>
      <span
        class="sync ${effectiveOnline ? (sync.pending > 0 && sync.lastError ? "warn" : "") : "off"}"
      >
        ${
          // A5: queued-but-failing writes announce themselves here instead of
          // hiding behind a healthy-looking SYNCED/ONLINE label
          !effectiveOnline
            ? sync.pending > 0
              ? `OFFLINE · ${sync.pending} QUEUED`
              : "OFFLINE"
            : sync.pending > 0 && sync.lastError
              ? `⚠ ${sync.pending} UNSAVED`
              : sync.flushing && sync.pending > 0
                ? `SAVING ${sync.pending}…`
                : sync.lastSyncAt
                  ? `SYNCED ${formatSyncTime(sync.lastSyncAt)}`
                  : "ONLINE"
        }
      </span>
    </div>

    ${
      route.view === "cookbook" &&
      html`<${CookbookView}
        recipes=${recipes}
        hasToken=${hasToken}
        weekId=${weekId}
        onPlan=${handlePlanAdd}
      />`
    }
    ${
      route.view === "plan" &&
      html`<${PlannerView}
        recipes=${recipes}
        identityRecipes=${allRecipes}
        plan=${viewPlan}
        targets=${targets}
        poolReport=${recipes.length > 0 ? poolAdequacy(recipes, targets) : null}
        weekId=${weekId}
        todayIso=${localIsoDate(new Date())}
        onWeek=${handleWeekNav}
        onSwitch=${handleSwitchEntry}
        onOpen=${handleOpenEntry}
        onToggleOut=${handleToggleOut}
        onSwipeEaten=${(/** @type {string} */ date, /** @type {string} */ slot) =>
          updatePlan(
            toggleSwipeEaten(
              /** @type {import("./lib/plan.js").Plan} */ (planRef.current),
              date,
              slot,
              localIsoDate(new Date()),
            ),
          )}
        onGenerateWeek=${handleGenerateWeek}
        buildReport=${buildReport}
        rebuilt=${buildReport !== null}
        tableStale=${tableStale}
        tableIssues=${tableDerived.conflicts.length + tableDerived.collisions.length}
        tableConflicts=${tableDerived.conflicts}
        nextPlan=${nextPlan}
        daily=${dailyLog}
        pantry=${pantry}
        onPatchDay=${handlePatchDay}
        occasionBanner=${occasionBanner}
        coverageGaps=${
          // the fluid week's one governing rule (7.2): only meaningful once
          // the week is shopped — before that, nothing bought needs a home
          /** @type {any} */ (plan)?.shoppedAt || /** @type {any} */ (plan)?.fallback
            ? perishableCoverage(
                viewPlan,
                allRecipes,
                pantry,
                localIsoDate(new Date()),
                drainDownDate(household),
              ).gaps
            : []
        }
        onRestoreFallback=${/** @type {any} */ (plan)?.fallback ? handleRestoreFallback : undefined}
        lastWeekReview=${composeWeekReview({
          plan: prevWeekPlan,
          waste: /** @type {any} */ (wasteLog),
          daily: dailyLog,
          targets,
          weekDates: datesOfWeek(shiftWeek(weekId, -1)),
          recipesById: recipesById(allRecipes),
          pantry,
        })}
      />`
    }
    ${
      route.view === "recipe" &&
      html`<${RecipeView}
        recipe=${recipeById(route.id)}
        loading=${loading}
        from=${route.from}
        servings=${route.servings}
        tableId=${routeTable?.id}
        tableUnresolved=${Boolean(route.table && !routeTable)}
        potRows=${(() => {
          // spec 11.5: a solved table's recipe page shows TONIGHT'S pot.
          // Uniform (every untagged dish) renders cookPlan verbatim. Once a
          // pot is FROZEN it is the contract for what was bought (spec 10)
          // and wins over a live re-solve; live covers pre-freeze only.
          const rt = routeTable;
          if (!rt) return undefined;
          const bank = bankRecipes.find((r) => r.id === rt.recipeId);
          const frozen = parsePot(/** @type {any} */ (rt).pot, bank);
          if (frozen) return frozen.rows.map((r) => ({ food: r.food, unit: r.unit, qty: r.qty }));
          const s = liveSynthFor(rt);
          return s?.synthMode === "solved"
            ? s.rows.map((/** @type {any} */ r) => ({ food: r.food, unit: r.unit, qty: r.qty }))
            : undefined;
        })()}
        unshopped=${!(/** @type {any} */ (plan)?.shoppedAt || houseShopped)}
        onPromote=${handlePromoteRecipe}
        avoided=${(targets?.avoidRecipes ?? []).includes(route.id)}
        onAvoid=${handleAvoidRecipe}
        entry=${route.entry ? (plan.entries ?? []).find((e) => e.id === route.entry) : undefined}
        onCooked=${handleMarkCooked}
        onCookComment=${handleCookComment}
        serve=${routeServe}
        tableCooked=${Boolean(routeTable?.cookedAt)}
        onCookedTable=${handleMarkTableCooked}
      />`
    }
    ${
      route.view === "list" &&
      html`<${ShoppingView}
        shopping=${shopping}
        pantry=${pantry}
        plan=${viewPlan}
        weekId=${weekId}
        hasToken=${hasToken}
        repo=${repo}
        loading=${!listLoaded}
        onBuild=${handleBuildList}
        moneyBalances=${hasCap("money") ? moneyBalances : []}
        profiles=${allProfiles}
        onSettle=${handleSettle}
        substitutions=${substitutions}
        onSubstitute=${handleSubstitute}
        onToggleItem=${handleToggleItem}
        onAddManual=${handleAddManual}
        onJustBought=${handleJustBought}
        onToggleLow=${handleCycleState}
        onOwnItem=${handleOwnItem}
        onScanApprove=${handleScanApprove}
        onGoingShopping=${handleGoingShopping}
        others=${otherLists}
        ownEmoji=${ownEmoji}
        recipeIndex=${recipeIndex}
        myPlan=${plan}
        allCookExtras=${tableDerived.allCookExtras}
        tripFromDate=${todayIfCurrentWeek(weekId)}
        onCombinedToggle=${handleCombinedToggle}
        onClaimAllDinners=${handleClaimAllDinners}
        dinnerClaims=${dinnerClaims}
        onRemoveDinnerRows=${handleRemoveDinnerRows}
        shopsPerWeek=${targets?.shopsPerWeek ?? 1}
        houseShopped=${Boolean(/** @type {any} */ (plan)?.shoppedAt) || houseShopped}
        prices=${priceCatalogue}
        pins=${pins}
        onSavePins=${handleSavePins}
        onSavePrices=${handleSavePrices}
        avoid=${targets?.avoidIngredients ?? []}
        weeklyBudgetUsd=${targets?.weeklyBudgetUsd}
        region=${targets?.region}
        storeSlug=${(targets?.stores?.[0] ?? "")
          .toLowerCase()
          .replace(/'/g, "")
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")}
        onReceiptApprove=${handleReceiptApprove}
        onClearList=${handleClearList}
        onEmptyPantry=${handleEmptyPantry}
        pantryLocations=${PANTRY_LOCATIONS}
        onRemovePantry=${handleRemovePantry}
      />`
    }
    ${
      // GUEST PROFILE (guesthouse spec §8, David's yes 2026-08-29): the
      // same questionnaire the gate uses, stamped guesthouse, never a
      // sign-in — hand the phone over, they fill it, the reload lands
      // back on Tables with them seatable
      route.view === "guest" &&
      html`<${ProfileGateView}
        guest
        onDone=${() => {
          location.hash = "#/tables";
          location.reload();
        }}
      />`
    }
    ${
      route.view === "hall" &&
      html`<${HallView}
        targets=${targets}
        onAddToPlan=${handleHallTray}
        forDate=${/** @type {any} */ (route).date ?? ""}
        forMeal=${/** @type {any} */ (route).meal ?? ""}
      />`
    }
    ${
      route.view === "remedies" &&
      html`<${RemediesView} recipes=${recipes} hasToken=${hasToken} repo=${repo} />`
    }
    ${
      route.view === "menu" &&
      html`<${MenuView}
        profiles=${allProfiles}
        me=${me}
        hasToken=${hasToken}
        repo=${repo}
        onDinerFacts=${handleDinerFacts}
      />`
    }
    ${
      route.view === "annotate" &&
      html`<${AnnotateView}
        profiles=${allProfiles}
        me=${me}
        hasToken=${hasToken}
        repo=${repo}
        recipes=${recipes}
        plan=${viewPlan}
        pantry=${pantry}
        targets=${targets}
        onDinerFacts=${handleDinerFacts}
        onSaved=${(/** @type {Record<string, any>} */ recipe) =>
          setBankRecipes([...bankRecipesRef.current.filter((r) => r.id !== recipe.id), recipe])}
      />`
    }
    ${
      route.view === "tables" &&
      html`<${TablesView}
        houseEvents=${houseEvents}
        profiles=${allProfiles}
        me=${me}
        showScoreboard=${hasCap("scoreboard")}
        todayIso=${localIsoDate(new Date())}
        hasToken=${hasToken}
        repo=${repo}
        tableConflicts=${tableDerived.conflicts}
        tableCollisions=${tableDerived.collisions}
        bankRecipes=${bankRecipes}
        onCreateTable=${handleCreateTable}
        onRemoveTable=${handleRemoveTable}
        onSetBuyer=${handleSetBuyer}
        onSetHead=${handleSetHead}
        onSetGuests=${handleSetGuests}
        liveSynthFor=${liveSynthFor}
        missingPlanWarning=${missingPlanWarning}
        onPatchSeat=${handlePatchSeat}
        onSeatScreen=${handleSeatScreen}
        onTailorTable=${handleTailorTable}
        onSameForEveryone=${handleSameForEveryone}
        onDinnerWeek=${handleDinnerWeek}
        swipeCurrency=${(() => {
          // the week form's "my lunches are swipes" chip (P5, P10): the
          // buffet currency on MY profile, with its preferred slot resolved
          const b = (targets?.currencies ?? []).find(
            (/** @type {any} */ c) => c.venue === "buffet" && Number(c.perWeek) > 0,
          );
          return b
            ? {
                name: /** @type {string} */ (b.name ?? "dining swipes"),
                perWeek: Number(b.perWeek),
                slot: String(b.preferredSlot || "lunch"),
              }
            : null;
        })()}
        scoreboard=${scoreboard}
        weekId=${weekId}
        onCreateBrigade=${handleCreateBrigade}
        onRemoveBrigade=${handleRemoveBrigade}
        onRunBrigade=${handleRunBrigade}
      />`
    }
    ${
      route.view === "ask" &&
      html`<${AskView} context=${askContext} hasToken=${hasToken} repo=${repo} />`
    }
    ${
      route.view === "occasions" &&
      html`<${OccasionsView}
        occasions=${occasions}
        profiles=${allProfiles}
        me=${me}
        recipes=${allRecipes}
        todayIso=${localIsoDate(new Date())}
        busy=${occBusy}
        onScreen=${handleScreenOccasion}
        onApply=${handleApplyOccasion}
        onRemove=${handleRemoveOccasion}
      />`
    }
    ${
      route.view === "dinner" &&
      html`<${DinnerView}
        profiles=${allProfiles}
        me=${me}
        bankRecipes=${bankRecipes}
        hasToken=${hasToken}
        repo=${repo}
        onDinerFacts=${handleDinerFacts}
        onApplyDinner=${handleApplyDinner}
      />`
    }
    ${
      route.view === "system" &&
      html`<${SystemView}
        sw=${sw}
        sync=${sync}
        repo=${repo}
        hasToken=${hasToken}
        draft=${draft}
        onDraft=${setDraft}
        onSaveToken=${saveToken}
        onTestWrite=${testWrite}
        onExport=${handleExport}
        onReplayTour=${handleReplayTour}
        tourState=${tourRecord}
        targets=${targets}
        bankRecipes=${bankRecipes}
        onSaveEquipment=${handleSaveEquipment}
      />`
    }

    <nav class="tabbar">
      ${TABS.map(
        (t) => html`
          <a
            class=${route.view === t.view ? "active" : ""}
            aria-current=${route.view === t.view ? "page" : undefined}
            href=${t.hash}
          >
            <span class="i" aria-hidden="true">${t.icon}</span>${t.label}
          </a>
        `,
      )}
    </nav>
    ${confirmAsk && html`<${ConfirmModal} message=${confirmAsk.message} onResolve=${settleConfirm} />`}
    ${
      tourOfferVisible &&
      !loading &&
      html`<${TourOffer}
        resumeStep=${tourResumeStep}
        onStart=${handleTourStart}
        onDismiss=${handleTourDismiss}
      />`
    }
    ${
      tourOpen &&
      html`<${TourOverlay}
        startStep=${tourOpen.startStep}
        onProgress=${handleTourProgress}
        onEnd=${handleTourEnd}
      />`
    }
    ${
      peek &&
      html`<${RecipePeek}
        recipe=${recipeById(peek.recipeId) ?? null}
        servings=${peek.servings}
        entryId=${peek.entryId}
        tableId=${peek.tableId}
        unshopped=${!(/** @type {any} */ (plan)?.shoppedAt || houseShopped)}
        onClose=${() => setPeek(null)}
      />`
    }
    ${
      krogerLinkNote &&
      html`<div class="toast" role="status">
        <span>${krogerLinkNote}</span>
        <button class="toast-undo" onClick=${() => setKrogerLinkNote("")}>OK</button>
      </div>`
    }
    ${
      undoToast &&
      html`<div class="toast" role="status">
        <span>${undoToast.message}</span>
        <button
          class="toast-undo"
          onClick=${() => {
            undoToast.restore();
            setUndoToast(null);
          }}
        >
          UNDO
        </button>
      </div>`
    }
  `;
}

/**
 * ?fresh=1 — the one-tap cure for a wedged install.
 *
 * David, 2026-07-26: after a deploy his phone painted the Plan page but no
 * button responded. That is the signature of a half-updated service worker:
 * the old SW keeps serving some cached modules while the page runs newer
 * ones, so the tree renders and then never wires up. The controllerchange
 * reload above handles the normal case, but if the SW itself is stuck there
 * is nothing on a phone to clear it: no devtools, and the installed PWA has
 * no address bar.
 *
 * So the escape hatch is a URL. Opening the app with ?fresh=1 unregisters
 * every worker, drops every cache, and reloads clean. It runs BEFORE the app
 * renders, and it never touches localStorage, so the token, the profile and
 * every queued write survive.
 */
/**
 * ?notour=1 — drop the guided-tour state for every profile on this device.
 *
 * The tour overlay is a full-screen fixed layer, so a run that gets stuck
 * takes the whole app with it and there is nothing left to tap, including
 * anything that would end the tour. The overlay now always carries its own
 * CLOSE button, but a device already wedged needs a lever from outside, and
 * on a phone the only lever is a URL. Deliberately narrow: this clears the
 * tour keys and nothing else, so the token, profile and queued writes stay.
 */
if (location.search.includes("notour")) {
  for (const k of Object.keys(localStorage)) {
    if (k.startsWith("mise.tour.")) localStorage.removeItem(k);
  }
}

if (location.search.includes("fresh")) {
  const clean = location.href.split("?")[0] + location.hash;
  void (async () => {
    try {
      const regs = await navigator.serviceWorker?.getRegistrations?.();
      for (const r of regs ?? []) await r.unregister();
      for (const k of await caches.keys()) await caches.delete(k);
    } catch {
      // nothing to clear, or the browser refused: reload anyway
    }
    location.replace(clean);
  })();
}

/**
 * Show the error instead of dying quietly.
 *
 * David, 2026-07-26: "none of the buttons work. i can scroll on the plan page
 * but that is it." That is what a throw during re-render looks like from the
 * outside: the last good screen stays painted, scrolling still works because
 * the compositor owns it, and every tap runs a handler that dies on the way
 * back. Nothing on screen says so, and on a phone there is no console to ask.
 *
 * So the app now says so itself. A fixed banner, above everything, carrying
 * the real message and a COPY button, so the failure can be read off the
 * device that actually has it instead of guessed at from another machine.
 */
function showCrash(/** @type {string} */ what, /** @type {any} */ err) {
  const message = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
  let bar = document.getElementById("crashbar");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "crashbar";
    bar.setAttribute("role", "alert");
    bar.style.cssText =
      "position:fixed;left:0;right:0;top:0;z-index:99999;background:#5b1111;color:#fff;" +
      "font:12px/1.4 ui-monospace,monospace;padding:10px 12px;max-height:45vh;overflow:auto;" +
      "white-space:pre-wrap;overscroll-behavior:contain";
    document.body.appendChild(bar);
  }
  const text = `${what}: ${message}`;
  bar.textContent = text;
  const copy = document.createElement("button");
  copy.textContent = "COPY";
  copy.style.cssText =
    "margin-top:8px;padding:6px 12px;background:#fff;color:#000;border:0;border-radius:6px;font:inherit";
  copy.onclick = () => {
    void navigator.clipboard?.writeText(text);
    copy.textContent = "COPIED";
  };
  bar.appendChild(copy);
}

window.addEventListener("error", (e) => showCrash("error", e.error ?? e.message));
window.addEventListener("unhandledrejection", (e) => showCrash("promise", e.reason));

const root = document.getElementById("app");
if (root) {
  // gate: no profile chosen yet (fresh install, or System's "switch
  // profile" cleared the key) — render the chooser instead of the app.
  try {
    render(
      localStorage.getItem("mise.activeProfile") ? html`<${App} />` : html`<${ProfileGateView} />`,
      root,
    );
  } catch (err) {
    showCrash("render", err);
  }
}
