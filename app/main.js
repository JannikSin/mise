import { html, render } from "htm/preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { checkDataRepo, getToken, setToken, DATA_REPO } from "./lib/github.js";
import {
  initStore,
  write,
  read,
  readCollection,
  getSyncStatus,
  onSyncChange,
} from "./lib/store.js";
import { initRouter } from "./lib/router.js";
import { formatSyncTime, isoWeekId, statusDate } from "./lib/dates.js";
import { HomeView } from "./views/home.js";
import { QuizView } from "./views/quiz.js";
import { CookbookView } from "./views/cookbook.js";
import { RecipeView, CookView } from "./views/recipe.js";
import { SystemView } from "./views/system.js";
import { PlannerView } from "./views/planner.js";
import { ShoppingView } from "./views/shopping.js";
import { deriveShoppingList, applyJustBought, sectionOf } from "./lib/shopping.js";
import {
  addEntry,
  removeEntryById,
  moveEntry,
  normalizePlan,
  shiftWeek,
  SLOT_KEYS,
} from "./lib/plan.js";

export const APP = { name: "Mise", version: "0.3.0" };

/** @typedef {Awaited<ReturnType<typeof checkDataRepo>>} RepoStatus */

let checkGen = 0;

const TABS = [
  { hash: "#/", view: "home", icon: "◉", label: "Today" },
  { hash: "#/cookbook", view: "cookbook", icon: "▤", label: "Recipes" },
  { hash: "#/plan", view: "plan", icon: "⬒", label: "Plan" },
  { hash: "#/list", view: "list", icon: "☑", label: "List" },
  { hash: "#/system", view: "system", icon: "☰", label: "Sys" },
];

function App() {
  const [route, setRoute] = useState(
    /** @type {{ view: string, id?: string }} */ ({ view: "home" }),
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
  const [useSoonFoods, setUseSoonFoods] = useState(/** @type {string[]} */ ([]));
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

  // recipes + use-soon pantry items: cached-first, refreshed whenever sync
  // activity changes the cache
  useEffect(() => {
    let alive = true;
    const load = () => {
      readCollection("recipes").then((r) => {
        if (alive) setRecipes(r);
      });
      read("pantry.json").then((p) => {
        if (!alive || !p) return;
        const soon = /** @type {any[]} */ (p.perishables ?? [])
          .filter((x) => x.useSoon)
          .map((x) => String(x.food));
        setUseSoonFoods(soon);
      });
    };
    load();
    const unsub = onSyncChange(load);
    return () => {
      alive = false;
      unsub();
    };
  }, [hasToken]);

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

  useEffect(() => {
    read("fitness/targets.json").then((t) => {
      if (t) setTargets(t);
    });
  }, [hasToken]);

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

  const recipesRef = useRef(recipes);
  recipesRef.current = recipes;

  const handleBuildList = useCallback(() => {
    const byId = new Map(recipesRef.current.map((r) => [r.id, r]));
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
      const id =
        food
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "") + "-x"; // unit-aware id scheme, unit "x"
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
    const today = new Date();
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const result = applyJustBought(shoppingRef.current, pantryRef.current, iso);
    updateShopping(result.shopping);
    updatePantry(result.pantry);
  }, [updateShopping, updatePantry]);

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

  // refs keep the drop/remove callbacks identity-stable (so the drag engine's
  // listeners never re-attach mid-gesture) while still seeing fresh state —
  // planRef is also advanced inside updatePlan so back-to-back drops chain
  // correctly even before the next render commits
  const planRef = useRef(plan);
  planRef.current = plan;
  const weekRef = useRef(weekId);
  weekRef.current = weekId;

  const updatePlan = useCallback(
    (/** @type {{ week: string, entries: Record<string, any>[] }} */ next) => {
      planRef.current = next;
      setPlan(next); // optimistic: instant UI, then queue+flush via the store
      void write(`plans/${weekRef.current}.json`, next);
    },
    [],
  );

  const handleDrop = useCallback(
    (/** @type {string} */ date, /** @type {string} */ slot, /** @type {DOMStringMap} */ drag) => {
      const p = /** @type {import("./lib/plan.js").Plan} */ (planRef.current);
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
      updatePlan(
        removeEntryById(/** @type {import("./lib/plan.js").Plan} */ (planRef.current), id),
      );
    },
    [updatePlan],
  );

  /** Add straight from quiz/cookbook: slot inferred from the recipe's
   *  mealType; returns the slot so the row can confirm where it landed. */
  const handlePlanAdd = useCallback(
    (/** @type {Record<string, any>} */ recipe, /** @type {string} */ date) => {
      const slot = SLOT_KEYS.includes(recipe.mealType) ? recipe.mealType : "dinner";
      updatePlan(
        addEntry(/** @type {import("./lib/plan.js").Plan} */ (planRef.current), date, slot, {
          recipeId: recipe.id,
          servings: 1,
        }),
      );
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
    return html`<${CookView} key=${route.id} recipe=${recipeById(route.id)} loading=${loading} />`;
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
      html`<${HomeView} recipes=${recipes} sync=${sync} hasToken=${hasToken} repo=${repo} />`
    }
    ${
      route.view === "quiz" &&
      html`<${QuizView}
        recipes=${recipes}
        useSoonFoods=${useSoonFoods}
        hasToken=${hasToken}
        weekId=${weekId}
        onPlan=${handlePlanAdd}
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
        hasToken=${hasToken}
        loading=${loading}
        weekId=${weekId}
        onWeek=${(/** @type {number} */ d) => setWeekId(shiftWeek(weekId, d))}
        onDropInto=${handleDrop}
        onRemove=${handleRemove}
      />`
    }
    ${
      route.view === "recipe" &&
      html`<${RecipeView} recipe=${recipeById(route.id)} loading=${loading} />`
    }
    ${
      route.view === "list" &&
      html`<${ShoppingView}
        shopping=${shopping}
        pantry=${pantry}
        weekId=${weekId}
        hasToken=${hasToken}
        repo=${repo}
        loading=${!listLoaded}
        onBuild=${handleBuildList}
        onToggleItem=${handleToggleItem}
        onAddManual=${handleAddManual}
        onJustBought=${handleJustBought}
        onToggleLow=${handleToggleLow}
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
  `;
}

const root = document.getElementById("app");
if (root) render(html`<${App} />`, root);
