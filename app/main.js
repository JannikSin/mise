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
import { PlannerView } from "./views/planner.js";
import { ShoppingView } from "./views/shopping.js";
import { FitnessView } from "./views/fitness.js";
import { RemediesView } from "./views/remedies.js";
import { upsertDay } from "./lib/fitness.js";
import {
  deriveShoppingList,
  applyJustBought,
  ownItemToPantry,
  sectionOf,
  slug,
} from "./lib/shopping.js";
import {
  addEntry,
  removeEntryById,
  moveEntry,
  normalizePlan,
  recipesById,
  shiftWeek,
  togglePinById,
  setPlanLocked,
  mergeRecipePool,
  SLOT_KEYS,
} from "./lib/plan.js";
import { generateWeek } from "./lib/weekbuilder.js";

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
    /** @type {{ view: string, id?: string, from?: string }} */ ({ view: "home" }),
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
      mergeRecipePool(bankRecipes, ownRecipes, targets?.phase, targets?.avoidIngredients, targets?.diet),
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

  useEffect(() => {
    let alive = true;
    const load = () => {
      read("shopping.json").then((s) => {
        if (!alive) return;
        if (s) setShopping(/** @type {any} */ (s));
        setListLoaded(true);
      });
      read("pantry.json").then((p) => {
        if (alive && p) setPantry(p);
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
    void write("pantry.json", next);
  }, []);

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
        const others = p.profiles.filter((pr) => pr.id !== me);
        if (others.length === 0) return;
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

  const handleBuildList = useCallback(() => {
    const byId = recipesById(recipesRef.current);
    updateShopping(
      deriveShoppingList(
        /** @type {import("./lib/plan.js").Plan} */ (planRef.current),
        byId,
        pantryRef.current,
        shoppingRef.current,
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
  const LOCK_CONFIRM = "This week is locked — you've shopped for it. Change this meal anyway?";

  const handleDrop = useCallback(
    (/** @type {string} */ date, /** @type {string} */ slot, /** @type {DOMStringMap} */ drag) => {
      const p = /** @type {import("./lib/plan.js").Plan} */ (planRef.current);
      if (p.locked && !window.confirm(LOCK_CONFIRM)) return;
      if (drag.drag === "recipe" && drag.recipe) {
        updatePlan(addEntry(p, date, slot, { recipeId: drag.recipe, servings: 1 }));
      } else if (drag.drag === "text" && drag.text) {
        updatePlan(addEntry(p, date, slot, { freeText: drag.text, servings: 1 }));
      } else if (drag.drag === "move" && drag.id) {
        const src = p.entries.find((e) => e.id === drag.id);
        if (!src || (src.date === date && src.slot === slot)) return;
        updatePlan(moveEntry(p, drag.id, date, slot));
      }
    },
    [updatePlan],
  );

  const handleRemove = useCallback(
    (/** @type {string} */ id) => {
      const p = /** @type {import("./lib/plan.js").Plan} */ (planRef.current);
      if (p.locked && !window.confirm(LOCK_CONFIRM)) return;
      updatePlan(removeEntryById(p, id));
    },
    [updatePlan],
  );

  const handleTogglePin = useCallback(
    (/** @type {string} */ id) => {
      updatePlan(togglePinById(/** @type {import("./lib/plan.js").Plan} */ (planRef.current), id));
    },
    [updatePlan],
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
      pantry: pantryRef.current,
      weekId: weekRef.current,
      plan: /** @type {import("./lib/plan.js").Plan} */ (planRef.current),
      salt: bs.salt,
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
      ),
    );
  }, [updatePlan, updateShopping]);

  useEffect(() => {
    // a new week means a fresh build state and report
    buildStateRef.current = { salt: 0 };
    setBuildReport(null);
  }, [weekId]);

  const handlePlanAdd = useCallback(
    (/** @type {Record<string, any>} */ recipe, /** @type {string} */ date) => {
      const p = /** @type {import("./lib/plan.js").Plan} */ (planRef.current);
      if (p.locked && !window.confirm(LOCK_CONFIRM)) return null;
      const slot = SLOT_KEYS.includes(recipe.mealType) ? recipe.mealType : "dinner";
      updatePlan(addEntry(p, date, slot, { recipeId: recipe.id, servings: 1 }));
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

  const testWrite = () => {
    const device = /iPhone|iPad/.test(navigator.userAgent) ? "iphone" : "laptop";
    void write("meta.json", {
      schemaVersion: 1,
      lastWrite: { device, at: new Date().toISOString() },
    });
  };

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
      <span class="sync ${effectiveOnline ? "" : "off"}">
        ${
          effectiveOnline
            ? sync.lastSyncAt
              ? `SYNCED ${formatSyncTime(sync.lastSyncAt)}`
              : "ONLINE"
            : "OFFLINE"
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
      html`<${TodayView} recipes=${recipes} plan=${plan} hasToken=${hasToken} loading=${loading} />`
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
        hasToken=${hasToken}
        loading=${loading}
        weekId=${weekId}
        onWeek=${handleWeekNav}
        onDropInto=${handleDrop}
        onRemove=${handleRemove}
        onTogglePin=${handleTogglePin}
        onGenerateWeek=${handleGenerateWeek}
        buildReport=${buildReport}
        rebuilt=${buildReport !== null}
      />`
    }
    ${
      route.view === "recipe" &&
      html`<${RecipeView} recipe=${recipeById(route.id)} loading=${loading} from=${route.from} />`
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
      />`
    }
    ${
      route.view === "remedies" &&
      html`<${RemediesView} recipes=${recipes} hasToken=${hasToken} repo=${repo} />`
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
