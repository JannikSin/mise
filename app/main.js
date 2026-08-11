import { html, render } from "htm/preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { checkDataRepo, getToken, setToken, DATA_REPO } from "./lib/github.js";
import {
  initStore,
  write,
  read,
  readMeta,
  readCollection,
  readProfiles,
  activeProfile,
  getSyncStatus,
  onSyncChange,
} from "./lib/store.js";
import { initRouter } from "./lib/router.js";
import { formatSyncTime, isoWeekId, localIsoDate, parseLocalIso, statusDate } from "./lib/dates.js";
import { applyScanItems } from "./lib/scan.js";
import { tailorTable, dinnerWeek } from "./lib/worker.js";
import { ProfileGateView } from "./views/profile-gate.js";
import { CookbookView } from "./views/cookbook.js";
import { RecipeView, CookView } from "./views/recipe.js";
import { RecipePeek } from "./views/recipe-peek.js";
import { SystemView } from "./views/system.js";
import { TourOverlay, TourOffer } from "./views/tour.js";
import { readTourState, writeTourState } from "./lib/tour.js";
import { PlannerView } from "./views/planner.js";
import { ShoppingView } from "./views/shopping.js";
import { FitnessView } from "./views/fitness.js";
import { RemediesView } from "./views/remedies.js";
import { OccasionsView } from "./views/occasions.js";
import { VitalsView } from "./views/vitals.js";
import { MenuView } from "./views/menu.js";
import { DinnerView } from "./views/dinner.js";
import { AskView } from "./views/ask.js";
import { TablesView } from "./views/tables.js";
import { ConfirmModal } from "./views/confirm-modal.js";
import { upsertDay } from "./lib/fitness.js";
import {
  deriveShoppingList,
  applyJustBought,
  householdOthers,
  householdOf,
  pantryPathFor,
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
  sectionOf,
  slug,
} from "./lib/shopping.js";
import { applyReceipt } from "./lib/prices.js";
import { canonicalFood } from "./lib/ingredients.js";
import { cookPlan } from "./lib/portions.js";
import {
  addEntry,
  removeEntryById,
  normalizePlan,
  switchCandidate,
  setEntryRecipe,
  recipesById,
  shiftWeek,
  toggleSlotOut,
  outEntryAt,
  entriesAt,
  slotMacroEstimate,
  datesOfWeek,
  setPlanLocked,
  setPlanShopped,
  toggleEntryCooked,
  mergeRecipePool,
  recipeConflicts,
  SLOT_KEYS,
} from "./lib/plan.js";
import { generateWeek, generatorEligible, poolAdequacy } from "./lib/weekbuilder.js";
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
  addBrigade,
  removeBrigade,
  materializeBrigade,
  setTableTailor,
  setTableSameForEveryone,
  setTableBuyer,
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
import { freezePotString, parsePot } from "./lib/synth.js";
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
  { hash: "#/train", view: "train", icon: "▲", label: "Train" },
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
  const [vitals, setVitals] = useState(
    /** @type {import("./lib/vitals.js").Vitals | null} */ (null),
  );
  const [vitalsLoaded, setVitalsLoaded] = useState(false);

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
      void (async () => {
        const prof = await readProfiles();
        if (!alive) return;
        const path = pantryPathFor(householdOf(prof.profiles, activeProfile()));
        pantryPathRef.current = path;
        let src = /** @type {Record<string, any> | null} */ (await read(path, { raw: true }));
        if (!alive) return;
        if (!src) {
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
        const { pantry: fresh, expired } = expirePerishables(
          normalizePantry(src),
          localIsoDate(new Date()),
        );
        setPantry(fresh);
        if (expired.length > 0) {
          pantryRef.current = fresh;
          void write(path, fresh, { raw: true });
        }
      })();
      // shared price catalogue (data-repo root, never profile-scoped)
      read("prices.json", { raw: true }).then((p) => {
        if (alive && p) setPriceCatalogue(/** @type {any} */ (p));
      });
      // Apple Watch vitals (per-profile, scoped): posted by the phone
      // Shortcuts automation, read-only here. Absent = not connected yet.
      read("health/vitals.json").then((v) => {
        if (!alive) return;
        if (v) setVitals(/** @type {any} */ (v));
        setVitalsLoaded(true);
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

  const updatePlan = useCallback(
    (/** @type {{ week: string, entries: Record<string, any>[] }} */ next) => {
      // the ONE strip point: derived table entries (generateWeek receives
      // the merged viewPlan, whose pinned table entries would otherwise
      // survive into the write) live in events.json, never in a plan file
      const clean = { ...next, entries: stripTableEntries(next.entries) };
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
    // household path once known (B2); legacy per-profile path only in the
    // narrow window before profiles resolve
    if (path) void write(path, next, { raw: true });
    else void write("pantry.json", next);
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
      const gone =
        kind === "staple"
          ? (prev.staples ?? []).find((/** @type {any} */ s) => s.id === key)?.name
          : (prev.perishables ?? []).find((/** @type {any} */ p) => p.id === key)?.food;
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
  // per-profile training gate (profiles.json trainingEnabled, absent = true):
  // hides the Train tab, Home's Train row, and the #/train route
  const [trainingEnabled, setTrainingEnabled] = useState(true);

  useEffect(() => {
    let alive = true;
    const me = activeProfile();
    const load = () => {
      readProfiles().then((p) => {
        const self = p.profiles.find((pr) => pr.id === me);
        if (alive && self?.emoji) setOwnEmoji(self.emoji);
        if (alive) setTrainingEnabled(self?.trainingEnabled !== false);
        // same household only: Laurie's solo-apartment list never mixes
        // into the home EVERYONE trip (and vice versa)
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
            // houseShopped): the FAMILY tab re-derives a person's trip
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
      // it unlocks the week's cook reminders and the eaten tracking
      updatePlan(setPlanShopped(prevPlan, today));
      // the trip is DONE: every row the till confirms (plus anything ticked in
      // the aisle) leaves the list and lands on a shelf. A fully-bought list
      // ends up empty, which is the whole point — the list is a to-do, not a
      // record of what you own.
      // BANK ONCE, FROM THE MERGED TRIP (Tribunal BLOCK, 2026-08-01). The
      // FAMILY tab the shopper walked is everyone's lists SUMMED, minus the
      // shared pantry once; the pantry must gain exactly what that trip
      // bought. Banking from this profile's own rows alone recorded a
      // fraction (or nothing) of the food now physically in the fridge, and
      // fridge-first then re-bought it every week. A row ticked by ANY
      // source counts bought — the FAMILY tick writes through to all.
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
      updatePantry(stocked.pantry);
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
      // name the blast radius and keep an exit: this tap edited other
      // people's lists, banked the shared pantry, and confirmed the week as
      // shopped — undo covers all of it even when no other list changed
      {
        setUndoToast({
          message:
            clearedNames.length > 0
              ? `receipt cleared ${clearedNames.join(", ")}'s list${clearedNames.length === 1 ? "" : "s"} too`
              : "receipt applied — list, pantry and week updated",
          restore: () => {
            updatePlan(prevPlan); // un-confirms shoppedAt — the receipt was a mistake
            updateShopping(prevShopping);
            updatePantry(prevPantry);
            otherListsRef.current = prevOthers;
            setOtherLists(prevOthers);
            for (const o of prevOthers) {
              void write(shoppingPathFor(o.profileId), /** @type {any} */ (o.list), { raw: true });
            }
          },
        });
      }
      const cat = priceCatalogue;
      if (!cat) return;
      const { catalogue: next } = applyReceipt(cat, store, lines, today);
      setPriceCatalogue(next);
      void write("prices.json", /** @type {any} */ (next), { raw: true });
    },
    // updatePlan/planRef are declared later in this component but are
    // identity-stable; referencing them in the body (call time) is safe,
    // only the dep array must not touch them (TDZ at definition time)
    [priceCatalogue, updateShopping, updatePantry],
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
            items: items.map((i) =>
              i.id === itemId
                ? {
                    ...i,
                    checked: false,
                    ...(/** @type {any} */ (i).weekQty
                      ? { qty: /** @type {any} */ (i).weekQty, weekQty: undefined }
                      : {}),
                  }
                : i,
            ),
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

  // fitness data: cached-first, refreshed on sync activity
  const [workouts, setWorkouts] = useState(
    /** @type {{ templates: Record<string, any>[], sessions: Record<string, any>[] }} */ ({
      templates: [],
      sessions: [],
    }),
  );
  const [dailyLog, setDailyLog] = useState(
    /** @type {{ days: Record<string, any>[] }} */ ({ days: [] }),
  );
  const [fitnessLoaded, setFitnessLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () => {
      read("fitness/workouts.json").then((w) => {
        if (!alive) return;
        if (w) setWorkouts(/** @type {any} */ (w));
        setFitnessLoaded(true);
      });
      read("fitness/daily.json").then((d) => {
        if (alive && d) setDailyLog(/** @type {any} */ (d));
      });
      read("fitness/targets.json").then((t) => {
        if (alive && t) setTargets(t);
      });
    };
    load();
    const unsub = onSyncChange(load);
    return () => {
      alive = false;
      unsub();
    };
  }, [hasToken]);

  const workoutsRef = useRef(workouts);
  workoutsRef.current = workouts;
  const dailyRef = useRef(dailyLog);
  dailyRef.current = dailyLog;

  // in-progress workout lives at App level: navigating tabs mid-session
  // must never discard logged sets (reviewer-flagged data-loss risk)
  const [trainDraft, setTrainDraft] = useState(
    /** @type {{ templateId: string | null, session: Record<string, any> | null, inputs: Record<string, { w: string, r: string }> }} */ ({
      templateId: null,
      session: null,
      inputs: {},
    }),
  );

  const handleSaveSession = useCallback((/** @type {Record<string, any>} */ session) => {
    const w = workoutsRef.current;
    // sessions carry a unique id — the merge key — so two same-day sessions
    // (or two devices) can never collapse into each other on a 409 merge
    const withId = session.id ? session : { ...session, id: crypto.randomUUID().slice(0, 8) };
    const next = { ...w, sessions: [...w.sessions, withId] };
    workoutsRef.current = next;
    setWorkouts(next);
    void write("fitness/workouts.json", /** @type {any} */ (next));
  }, []);

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

  // id → recipe map for the shopping view's FAMILY tab, which re-derives a
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
    // A household member's list is a PORTION of the merged FAMILY trip, and
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

  const handleToggleLow = useCallback(
    (/** @type {string} */ id) => {
      const p = pantryRef.current;
      updatePantry({
        ...p,
        staples: (p.staples ?? []).map((/** @type {any} */ s) =>
          s.id === id ? { ...s, runningLow: !s.runningLow } : s,
        ),
      });
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
      const count =
        (prev.perishables ?? []).length + (keepStaples ? 0 : (prev.staples ?? []).length);
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

  // locked week: destructive edits (add/remove/move) ask first, since the
  // meals may already be shopped for; pin/unpin never changes what's cooked
  // so it's left ungated
  const LOCK_CONFIRM = "This week is locked, you've shopped for it. Change this meal anyway?";

  // SWITCH: the meal keeps its slot and its servings and becomes a different
  // recipe. Replaces the old ✕, which could only delete (David, 2026-07-27).
  // A locked week refuses, same as GENERATE: you have bought this food.
  const handleSwitchEntry = useCallback(
    (/** @type {string} */ id) => {
      const p = /** @type {import("./lib/plan.js").Plan} */ (planRef.current);
      if (p.locked) return;
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
      // meal. So a filled slot always asks first; a locked (already shopped)
      // week asks with the sterner wording. Turning OUT back off just
      // empties the slot and never needs a gate.
      const marking = !outEntryAt(p.entries, date, slot);
      if (marking && entriesAt(p.entries, date, slot).length > 0) {
        const msg = p.locked
          ? LOCK_CONFIRM
          : "Eating out instead? The planned meal in this slot will be removed.";
        if (!(await askConfirm(msg))) return;
        p = /** @type {import("./lib/plan.js").Plan} */ (planRef.current);
      }
      const next = toggleSlotOut(p, date, slot, slotMacroEstimate(recipesRef.current, slot));
      updatePlan(next);
      // keep an already-built list truthful: the out meal's ingredients must
      // not linger as things to buy. Locked weeks are exempt (the lock's
      // whole point is a list that stops moving), and an empty list stays
      // empty — toggling OUT never builds a list David didn't ask for.
      if (!p.locked && shoppingRef.current.items.length > 0) {
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

  // "I already have this": open ONE recipe method for the rest of the week,
  // for the nights you cook out of the pantry without a shop.
  const handleToggleLock = useCallback(() => {
    const p = /** @type {import("./lib/plan.js").Plan} */ (planRef.current);
    updatePlan(setPlanLocked(p, !p.locked));
  }, [updatePlan]);

  const handleMarkCooked = useCallback(
    (/** @type {string} */ entryId) => {
      const plan = /** @type {import("./lib/plan.js").Plan} */ (planRef.current);
      const entry = plan.entries.find((e) => e.id === entryId);
      updatePlan(toggleEntryCooked(plan, entryId, localIsoDate(new Date())));
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

  /** Add straight from the cookbook: slot inferred from the recipe's
   *  mealType; returns the slot so the row can confirm where it landed. */
  // week generator: one tap owns the whole week — every unpinned entry is
  // cleared and rebuilt; pinned entries are the only state that needs to
  // survive a RE-ROLL, and they're already in the plan data, not app state
  const [buildReport, setBuildReport] = useState(
    /** @type {import("./lib/weekbuilder.js").WeekReport | null} */ (null),
  );
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  const buildStateRef = useRef({ salt: 0 });

  const handleGenerateWeek = useCallback(() => {
    // body-level guard, not just the disabled button: this is the single
    // most destructive path (clears every unpinned entry + overwrites the
    // shopping list) and the one that caused the shopped-week wipe incident
    if (/** @type {import("./lib/plan.js").Plan} */ (planRef.current).locked) return;
    const bs = buildStateRef.current;
    bs.salt++;
    const result = generateWeek({
      recipes: recipesRef.current,
      targets: targetsRef.current,
      // expiring-soon perishables are auto-flagged useSoon so the committees
      // favor recipes that cook them before they leave on their own
      pantry: withAutoUseSoon(pantryRef.current, localIsoDate(new Date())),
      weekId: weekRef.current,
      // viewPlan: derived table entries enter as pins so the generator
      // plans each member's day around the shared meal
      plan: /** @type {import("./lib/plan.js").Plan} */ (viewPlanRef.current),
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
  }, [updatePlan, updateShopping, me]);

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
    });
    return () => {
      alive = false;
    };
  }, [weekId, hasToken]);

  const handlePlanAdd = useCallback(
    async (/** @type {Record<string, any>} */ recipe, /** @type {string} */ date) => {
      if (
        /** @type {import("./lib/plan.js").Plan} */ (planRef.current).locked &&
        !(await askConfirm(LOCK_CONFIRM))
      )
        return null;
      const p = /** @type {import("./lib/plan.js").Plan} */ (planRef.current);
      const slot = SLOT_KEYS.includes(recipe.mealType) ? recipe.mealType : "dinner";
      // planning real food into an eating-out slot: the placeholder yields
      const out = outEntryAt(p.entries, date, slot);
      const base = out ? removeEntryById(p, out.id) : p;
      updatePlan(addEntry(base, date, slot, { recipeId: recipe.id, servings: 1 }));
      return slot;
    },
    [updatePlan, askConfirm],
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
      grab("fitness/workouts.json"),
      grab("health/vitals.json"),
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
      if (cur.locked) return;
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

  // claim counts for the List's FAMILY tile: upcoming dinners in my house
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
      kitchen: (pantry.perishables ?? []).map(
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
          const path =
            pr.id === "david" ? "fitness/targets.json" : `profiles/${pr.id}/fitness/targets.json`;
          const rec = await readMeta(path, { raw: true }).catch(() => ({
            data: null,
            sha: null,
            dirty: false,
          }));
          map.set(pr.id, rec);
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

  /** Freeze a table's pot per spec 10. Solved-only: null in uniform mode. */
  const potStringFor = async (/** @type {import("./lib/tables.js").TableEvent} */ t) => {
    const recipe = bankRecipesRef.current.find((r) => r.id === t.recipeId);
    if (!recipe || t.sameForEveryone) return null;
    const targetsById = new Map();
    /** @type {Record<string, string>} */
    const shas = {};
    /** @type {Record<string, number>} */
    const slotShares = {};
    for (const s of t.seats ?? []) {
      const rec = houseTargetsRef.current.get(s.id);
      targetsById.set(s.id, /** @type {any} */ (rec?.data ?? null));
      shas[s.id] = rec?.dirty ? "dirty" : (rec?.sha ?? "missing");
      slotShares[s.id] = slotShareFor(/** @type {any} */ (rec?.data), t.slot);
    }
    return freezePotString({
      recipe,
      seats: /** @type {any} */ (t.seats ?? []),
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
    if (route.view !== "cook" || !route.table) return;
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
        const path =
          s.id === "david" ? "fitness/targets.json" : `profiles/${s.id}/fitness/targets.json`;
        const tg = /** @type {any} */ (await read(path, { raw: true }).catch(() => null));
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
      const path =
        profileId === "david"
          ? "fitness/targets.json"
          : `profiles/${profileId}/fitness/targets.json`;
      const t = /** @type {any} */ (await read(path, { raw: true }).catch(() => null));
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
        const path =
          id === "david" ? "fitness/targets.json" : `profiles/${id}/fitness/targets.json`;
        targetsById.set(id, await read(path, { raw: true }).catch(() => null));
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
      const path =
        p.id === "david" ? "fitness/targets.json" : `profiles/${p.id}/fitness/targets.json`;
      const t = /** @type {any} */ (await read(path, { raw: true }).catch(() => null));
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
      const path = id === "david" ? "fitness/targets.json" : `profiles/${id}/fitness/targets.json`;
      const t = /** @type {any} */ (await read(path, { raw: true }).catch(() => null));
      out.push({
        id,
        name: /** @type {string} */ (p?.name ?? id),
        goal: /** @type {string} */ (t?.phase ?? "maintain"),
        calories: /** @type {number} */ (t?.macros?.calories ?? 0),
        protein: /** @type {number} */ (t?.macros?.protein ?? 0),
        diet: /** @type {string} */ (t?.diet ?? "omnivore"),
        avoid: /** @type {string[]} */ (t?.avoidIngredients ?? []),
        // client-side only (the Worker's sanitizePeople drops it): the week
        // planner screens candidate recipes with the full predicate
        avoidRecipes: /** @type {string[]} */ (t?.avoidRecipes ?? []),
      });
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
   * @type {(events: any, decision: Record<string, any>, participantIds: string[], recipeId: string, date: string, slot: string, name: string, today: string, buyerId?: string, brigadeCtx?: { brigade: import("./lib/tables.js").Brigade, servingsFor: (id: string, slot: string, recipeId: string) => number, cookFor: (date: string) => string } | null) => any}
   */
  const tableFromDecision = useCallback(
    (events, decision, participantIds, recipeId, date, slot, name, today, buyerId, brigadeCtx) => {
      const withTable = addTable(
        events,
        {
          name,
          date,
          slot,
          recipeId,
          ...(buyerId ? { buyerId } : {}),
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
  // plans every remaining breakfast/lunch/dinner — the house cooks each slot
  // ONCE, everyone eats the same food, and goals survive through strict
  // per-person portioning. Snacks and smoothies stay personal (not everyone
  // has them). Each meal lands as a real table (seats, plan derivation,
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
    ) => {
      const facts = await handleDinerFacts(participantIds);
      // running AS a brigade: deterministic table ids, the brigade's cook
      // rotation (same date-offset rule materializeBrigade uses), and seats
      // sized from each member's own targets instead of a flat 1
      /** @type {Map<string, Record<string, any> | null>} */
      const targetsById = new Map();
      if (brigade) {
        for (const id of participantIds) {
          const path =
            id === "david" ? "fitness/targets.json" : `profiles/${id}/fitness/targets.json`;
          targetsById.set(
            id,
            /** @type {any} */ (await read(path, { raw: true }).catch(() => null)),
          );
        }
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
      const candidates = bankRecipesRef.current
        .filter((r) => ["breakfast", "lunch", "dinner"].includes(r.mealType))
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
      const { nights, notes } = await dinnerWeek(facts, candidates, meals, cuisine, note, away);
      const today = localIsoDate(new Date());
      const me = activeProfile();
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
      /** @type {{ date: string, slot: string, name: string, why: string }[]} */
      const made = [];
      for (const { n, recipeId } of resolved) {
        // attendance: someone marked away for a date is seated on NONE of
        // that day's tables — portions, plates and the buy shrink with them
        const present = participantIds.filter((id) => !(away[id] ?? []).includes(n.date));
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
      return { made, notes };
    },
    [writeHouseEvents, decisionRecipeId, tableFromDecision, handleDinerFacts],
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
  // header and probe results must never disagree: offline if either says so
  const effectiveOnline = online && (repo ? repo.reachable : true);
  // IDENTITY lookup (allRecipes, not the screened pool): detail pages, peek,
  // and cook mode render what the plan SAYS, including a banned-but-still-
  // planned recipe — bans govern picking, not what an existing entry means
  const recipeById = (/** @type {string | undefined} */ id) => allRecipes.find((r) => r.id === id);

  const loading = recipes.length === 0 && hasToken;

  if (route.view === "cook") {
    // key: hook state (current step) must reset when the recipe changes
    const cookEntry = route.entry ? plan.entries.find((e) => e.id === route.entry) : undefined;
    // a TABLE cook ends on the serve step (spec §7.2). The table renders
    // from live state; the serve model derives from stored seats + whatever
    // seat rules this device has cached (spec §7.1: mass share, deploy 1).
    const cookTable = route.table
      ? houseEvents.flatMap((h) => h.events.tables).find((t) => t.id === route.table)
      : undefined;
    const serve =
      cookTable && !cookTable.sameForEveryone
        ? buildServe(
            cookTable,
            bankRecipes.find((r) => r.id === cookTable.recipeId),
            allProfiles,
            serveRules,
          )
        : null;
    return html`<${CookView}
      key=${route.id}
      recipe=${recipeById(route.id)}
      loading=${loading}
      from=${route.from}
      servings=${route.servings}
      entryId=${cookEntry?.id}
      tableId=${cookTable?.id}
      serve=${serve}
      cooked=${Boolean(cookEntry?.cookedAt || cookTable?.cookedAt)}
      onCooked=${handleMarkCooked}
      onCookedTable=${handleMarkTableCooked}
    />`;
  }

  const now = new Date();
  return html`
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
      />`
    }
    ${
      route.view === "recipe" &&
      html`<${RecipeView}
        recipe=${recipeById(route.id)}
        loading=${loading}
        from=${route.from}
        servings=${route.servings}
        entryId=${route.entry}
        tableId=${route.table}
        unshopped=${!(/** @type {any} */ (plan)?.shoppedAt || houseShopped)}
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
        onToggleLow=${handleToggleLow}
        onOwnItem=${handleOwnItem}
        onScanApprove=${handleScanApprove}
        onToggleLock=${handleToggleLock}
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
      route.view === "remedies" &&
      html`<${RemediesView} recipes=${recipes} hasToken=${hasToken} repo=${repo} />`
    }
    ${
      route.view === "vitals" &&
      html`<${VitalsView} vitals=${vitals} loading=${!vitalsLoaded} hasToken=${hasToken} />`
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
        onPatchSeat=${handlePatchSeat}
        onSeatScreen=${handleSeatScreen}
        onTailorTable=${handleTailorTable}
        onSameForEveryone=${handleSameForEveryone}
        onDinnerWeek=${handleDinnerWeek}
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
      route.view === "train" &&
      !trainingEnabled &&
      html`<div class="view">
        <div class="empty">
          training is disabled in this profile — turn it on in <a href="#/system">SYS</a>
        </div>
      </div>`
    }
    ${
      route.view === "train" &&
      trainingEnabled &&
      html`<${FitnessView}
        workouts=${workouts}
        targets=${targets}
        today=${localIsoDate(new Date())}
        hasToken=${hasToken}
        repo=${repo}
        loading=${!fitnessLoaded}
        draft=${trainDraft}
        onDraft=${setTrainDraft}
        onSaveSession=${handleSaveSession}
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
      />`
    }

    <nav class="tabbar">
      ${TABS.filter((t) => trainingEnabled || t.view !== "train").map(
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
