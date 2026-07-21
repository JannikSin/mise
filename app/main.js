import { html, render } from "htm/preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { checkDataRepo, getToken, setToken, DATA_REPO } from "./lib/github.js";
import {
  initStore,
  write,
  read,
  readCollection,
  readProfiles,
  activeProfile,
  getSyncStatus,
  onSyncChange,
} from "./lib/store.js";
import { initRouter } from "./lib/router.js";
import { formatSyncTime, isoWeekId, localIsoDate, statusDate } from "./lib/dates.js";
import { applyScanItems } from "./lib/scan.js";
import { HomeView } from "./views/home.js";
import { ProfileGateView } from "./views/profile-gate.js";
import { TodayView } from "./views/today.js";
import { CookbookView } from "./views/cookbook.js";
import { RecipeView, CookView } from "./views/recipe.js";
import { SystemView } from "./views/system.js";
import { TourOverlay, TourOffer } from "./views/tour.js";
import { readTourState, writeTourState } from "./lib/tour.js";
import { PlannerView } from "./views/planner.js";
import { ShoppingView } from "./views/shopping.js";
import { FitnessView } from "./views/fitness.js";
import { RemediesView } from "./views/remedies.js";
import { VitalsView } from "./views/vitals.js";
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
  normalizePantry,
  withAutoUseSoon,
  removeFromPantry,
  sectionOf,
  slug,
} from "./lib/shopping.js";
import { applyReceipt } from "./lib/prices.js";
import {
  addEntry,
  removeEntryById,
  moveEntry,
  normalizePlan,
  recipesById,
  shiftWeek,
  togglePinById,
  toggleSlotOut,
  outEntryAt,
  entriesAt,
  OUT_TEXT,
  slotMacroEstimate,
  setPlanLocked,
  mergeRecipePool,
  SLOT_KEYS,
} from "./lib/plan.js";
import { generateWeek, poolAdequacy } from "./lib/weekbuilder.js";

export const APP = { name: "Mise", version: "0.3.0" };

/** @typedef {Awaited<ReturnType<typeof checkDataRepo>>} RepoStatus */

let checkGen = 0;

const TABS = [
  { hash: "#/", view: "home", icon: "◉", label: "Home" },
  { hash: "#/today", view: "today", icon: "▤", label: "Cook" },
  { hash: "#/plan", view: "plan", icon: "⬒", label: "Plan" },
  { hash: "#/list", view: "list", icon: "☑", label: "List" },
  { hash: "#/train", view: "train", icon: "▲", label: "Train" },
  { hash: "#/system", view: "system", icon: "☰", label: "Sys" },
];

function App() {
  const [route, setRoute] = useState(
    /** @type {{ view: string, id?: string, from?: string, servings?: number }} */ ({
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
  const [weekId, setWeekId] = useState(isoWeekId(new Date()));
  const [plan, setPlan] = useState(
    /** @type {{ week: string, entries: Record<string, any>[] }} */ ({ week: weekId, entries: [] }),
  );
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
      ),
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

  // shopping list + pantry: cached-first, refreshed on sync activity
  const [shopping, setShopping] = useState(
    /** @type {import("./lib/shopping.js").ShoppingList} */ ({ items: [] }),
  );
  const [pantry, setPantry] = useState(
    /** @type {Record<string, any>} */ ({ staples: [], perishables: [] }),
  );

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
        if (s) setShopping(/** @type {any} */ (s));
        setListLoaded(true);
      });
      // pantry is HOUSEHOLD-shared (B2): one kitchen, one fridge, one file at
      // households/<h>/pantry.json. The path derives from profiles.json every
      // load, so moving household in SYS re-points you on the next sync tick
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

  const shoppingRef = useRef(shopping);
  shoppingRef.current = shopping;
  const pantryRef = useRef(pantry);
  pantryRef.current = pantry;
  // resolved households/<h>/pantry.json once profiles load; null until then
  const pantryPathRef = useRef(/** @type {string | null} */ (null));

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

  const [otherLists, setOtherLists] = useState(
    /** @type {{ profileId: string, name: string, emoji: string, list: import("./lib/shopping.js").ShoppingList }[]} */ ([]),
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
            list: /** @type {any} */ (
              (await read(shoppingPathFor(pr.id), { raw: true })) ?? { items: [] }
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
  }, [hasToken]);

  // receipt → catalogue freshness loop: merge the reviewed receipt lines into
  // the shared prices.json (raw, root file) and persist. Real receipt prices
  // overwrite the estimates for that store.
  const handleReceiptApprove = useCallback(
    (
      /** @type {string} */ store,
      /** @type {{ name: string, price: number, size: string }[]} */ lines,
    ) => {
      const cat = priceCatalogue;
      if (!cat) return;
      const { catalogue: next } = applyReceipt(cat, store, lines, localIsoDate(new Date()));
      setPriceCatalogue(next);
      void write("prices.json", /** @type {any} */ (next), { raw: true });
    },
    [priceCatalogue],
  );

  // ticking a combined item buys it for EVERYONE who wants it: write through
  // to every source profile's own list (active via updateShopping, others raw)
  const handleCombinedToggle = useCallback(
    (
      /** @type {string} */ itemId,
      /** @type {{ profileId: string, checked: boolean }[]} */ sources,
    ) => {
      const me = activeProfile();
      const target = !sources.every((s) => s.checked);
      for (const src of sources) {
        if (src.profileId === me) {
          const cur = shoppingRef.current;
          updateShopping({
            ...cur,
            items: cur.items.map((i) => (i.id === itemId ? { ...i, checked: target } : i)),
          });
        } else {
          const entry = otherListsRef.current.find((o) => o.profileId === src.profileId);
          if (!entry) continue;
          const nextList = {
            ...entry.list,
            items: (entry.list.items ?? []).map((i) =>
              i.id === itemId ? { ...i, checked: target } : i,
            ),
          };
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

  const handleBuildList = useCallback(() => {
    const byId = recipesById(recipesRef.current);
    updateShopping(
      deriveShoppingList(
        /** @type {import("./lib/plan.js").Plan} */ (planRef.current),
        byId,
        pantryRef.current,
        shoppingRef.current,
        todayIfCurrentWeek(/** @type {any} */ (planRef.current).week),
      ),
    );
  }, [updateShopping]);

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
    const result = applyJustBought(
      shoppingRef.current,
      pantryRef.current,
      localIsoDate(new Date()),
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
    (/** @type {{ name: string, kind: string, qty: string }[]} */ items) => {
      updatePantry(applyScanItems(pantryRef.current, items, localIsoDate(new Date())));
    },
    [updatePantry],
  );

  // refs keep the drop/remove callbacks identity-stable (so the drag engine's
  // listeners never re-attach mid-gesture) while still seeing fresh state —
  // planRef is also advanced inside updatePlan so back-to-back drops chain
  // correctly even before the next render commits
  const planRef = useRef(plan);
  planRef.current = plan;
  const weekRef = useRef(weekId);
  weekRef.current = weekId;

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

  const updatePlan = useCallback(
    (/** @type {{ week: string, entries: Record<string, any>[] }} */ next) => {
      planRef.current = next;
      setPlan(next); // optimistic: instant UI, then queue+flush via the store
      void write(`plans/${weekRef.current}.json`, next);
    },
    [],
  );

  // locked week: destructive edits (add/remove/move) ask first, since the
  // meals may already be shopped for; pin/unpin never changes what's cooked
  // so it's left ungated
  const LOCK_CONFIRM = "This week is locked, you've shopped for it. Change this meal anyway?";

  const handleDrop = useCallback(
    async (
      /** @type {string} */ date,
      /** @type {string} */ slot,
      /** @type {DOMStringMap} */ drag,
    ) => {
      if (
        /** @type {import("./lib/plan.js").Plan} */ (planRef.current).locked &&
        !(await askConfirm(LOCK_CONFIRM))
      )
        return;
      const p = /** @type {import("./lib/plan.js").Plan} */ (planRef.current);
      // the "eating out" tray chip behaves exactly like the slot's OUT
      // toggle: pinned placeholder, clears the slot, survives re-roll
      if (drag.drag === "text" && drag.text === OUT_TEXT) {
        if (!outEntryAt(p.entries, date, slot)) {
          updatePlan(toggleSlotOut(p, date, slot, slotMacroEstimate(recipesRef.current, slot)));
        }
        return;
      }
      // dropping real food into an eating-out slot means plans changed —
      // the placeholder yields to the meal
      const out = outEntryAt(p.entries, date, slot);
      const base = out ? removeEntryById(p, out.id) : p;
      if (drag.drag === "recipe" && drag.recipe) {
        updatePlan(addEntry(base, date, slot, { recipeId: drag.recipe, servings: 1 }));
      } else if (drag.drag === "text" && drag.text) {
        updatePlan(addEntry(base, date, slot, { freeText: drag.text, servings: 1 }));
      } else if (drag.drag === "move" && drag.id) {
        const src = base.entries.find((e) => e.id === drag.id);
        if (!src || (src.date === date && src.slot === slot)) return;
        updatePlan(moveEntry(base, drag.id, date, slot));
      }
    },
    [updatePlan, askConfirm],
  );

  const handleRemove = useCallback(
    async (/** @type {string} */ id) => {
      if (
        /** @type {import("./lib/plan.js").Plan} */ (planRef.current).locked &&
        !(await askConfirm(LOCK_CONFIRM))
      )
        return;
      updatePlan(
        removeEntryById(/** @type {import("./lib/plan.js").Plan} */ (planRef.current), id),
      );
    },
    [updatePlan, askConfirm],
  );

  const handleTogglePin = useCallback(
    (/** @type {string} */ id) => {
      updatePlan(togglePinById(/** @type {import("./lib/plan.js").Plan} */ (planRef.current), id));
    },
    [updatePlan],
  );

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
            next,
            recipesById(recipesRef.current),
            pantryRef.current,
            shoppingRef.current,
            todayIfCurrentWeek(next.week),
          ),
        );
      }
    },
    [updatePlan, updateShopping, askConfirm],
  );

  const handleToggleLock = useCallback(() => {
    const p = /** @type {import("./lib/plan.js").Plan} */ (planRef.current);
    updatePlan(setPlanLocked(p, !p.locked));
  }, [updatePlan]);

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
      plan: /** @type {import("./lib/plan.js").Plan} */ (planRef.current),
      salt: bs.salt,
      recentRecipeIds: recentRecipeIdsRef.current,
      // day-aware: past days of the current week survive and are not
      // re-planned; a future week is untouched by this (all its dates are
      // ahead of today)
      today: localIsoDate(new Date()),
    });
    updatePlan(result.plan);
    setBuildReport(result.report);
    // 7a: auto-populate the shopping list from the freshly generated plan,
    // not the stale planRef, so List is correct the instant Plan finishes
    updateShopping(
      deriveShoppingList(
        result.plan,
        recipesById(recipesRef.current),
        pantryRef.current,
        shoppingRef.current,
        todayIfCurrentWeek(result.plan.week),
      ),
    );
  }, [updatePlan, updateShopping]);

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

  const recentRecipeIdsRef = useRef(/** @type {string[]} */ ([]));
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

  const publicAlarm = repo?.privacy === "PUBLIC";
  // header and probe results must never disagree: offline if either says so
  const effectiveOnline = online && (repo ? repo.reachable : true);
  const recipeById = (/** @type {string | undefined} */ id) => recipes.find((r) => r.id === id);

  const loading = recipes.length === 0 && hasToken;

  if (route.view === "cook") {
    // key: hook state (current step) must reset when the recipe changes
    return html`<${CookView}
      key=${route.id}
      recipe=${recipeById(route.id)}
      loading=${loading}
      from=${route.from}
      servings=${route.servings}
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
      route.view === "home" &&
      html`<${HomeView}
        recipes=${recipes}
        plan=${plan}
        hasToken=${hasToken}
        repo=${repo}
        daily=${dailyLog}
        targets=${targets}
        workouts=${workouts}
        today=${localIsoDate(now)}
        loading=${!fitnessLoaded}
        trainingEnabled=${trainingEnabled}
        onPatchDay=${handlePatchDay}
      />`
    }
    ${
      route.view === "today" &&
      html`<${TodayView}
        recipes=${recipes}
        plan=${plan}
        nextPlan=${nextPlan}
        daily=${dailyLog}
        pantry=${pantry}
        onPatchDay=${handlePatchDay}
        hasToken=${hasToken}
        loading=${loading}
      />`
    }
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
        plan=${plan}
        targets=${targets}
        poolReport=${recipes.length > 0 ? poolAdequacy(recipes, targets) : null}
        hasToken=${hasToken}
        loading=${loading}
        weekId=${weekId}
        todayIso=${localIsoDate(new Date())}
        onWeek=${handleWeekNav}
        onDropInto=${handleDrop}
        onRemove=${handleRemove}
        onTogglePin=${handleTogglePin}
        onToggleOut=${handleToggleOut}
        onGenerateWeek=${handleGenerateWeek}
        buildReport=${buildReport}
        rebuilt=${buildReport !== null}
      />`
    }
    ${
      route.view === "recipe" &&
      html`<${RecipeView}
        recipe=${recipeById(route.id)}
        loading=${loading}
        from=${route.from}
        servings=${route.servings}
      />`
    }
    ${
      route.view === "list" &&
      html`<${ShoppingView}
        shopping=${shopping}
        pantry=${pantry}
        plan=${plan}
        weekId=${weekId}
        hasToken=${hasToken}
        repo=${repo}
        loading=${!listLoaded}
        onBuild=${handleBuildList}
        onToggleItem=${handleToggleItem}
        onAddManual=${handleAddManual}
        onJustBought=${handleJustBought}
        onToggleLow=${handleToggleLow}
        onOwnItem=${handleOwnItem}
        onScanApprove=${handleScanApprove}
        onToggleLock=${handleToggleLock}
        others=${otherLists}
        ownEmoji=${ownEmoji}
        onCombinedToggle=${handleCombinedToggle}
        shopsPerWeek=${targets?.shopsPerWeek ?? 1}
        prices=${priceCatalogue}
        region=${targets?.region}
        storeSlug=${(targets?.stores?.[0] ?? "")
          .toLowerCase()
          .replace(/'/g, "")
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")}
        onReceiptApprove=${handleReceiptApprove}
        onClearList=${handleClearList}
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

const root = document.getElementById("app");
if (root) {
  // gate: no profile chosen yet (fresh install, or System's "switch
  // profile" cleared the key) — render the chooser instead of the app.
  render(
    localStorage.getItem("mise.activeProfile") ? html`<${App} />` : html`<${ProfileGateView} />`,
    root,
  );
}
