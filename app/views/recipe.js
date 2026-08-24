import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { cookPlan } from "../lib/portions.js";
import { formatRecipeQty } from "../lib/shopping.js";
import { keepAwake } from "../lib/awake.js";
import { untrustedForAutoPlan } from "../lib/plan.js";

// ?from=<key> in the recipe hash → where the backlink returns; unknown or
// absent keys fall back to the cookbook (the historical behavior)
const ORIGINS = /** @type {Record<string, { hash: string, label: string }>} */ ({
  // #/today is a legacy alias kept for recipe URLs bookmarked before Plan
  // absorbed Cook; both land on the merged tab
  plan: { hash: "#/plan", label: "← PLAN" },
  today: { hash: "#/plan", label: "← PLAN" },
  remedies: { hash: "#/remedies", label: "← REMEDIES" },
});
const DEFAULT_ORIGIN = { hash: "#/cookbook", label: "← COOKBOOK" };

/** @param {string | undefined} from */
const originOf = (from) => (from && ORIGINS[from]) || DEFAULT_ORIGIN;

// ---- the cook timer (fix list 7.10, promise P7) ---------------------------
// One timer at a time, persisted in localStorage so a locked phone or a
// reload never loses a running cook. Starting on a different entry replaces
// the running timer (the honest reading of "one pair of hands").

const TIMER_KEY = "mise.cookTimer";
/** @returns {{ entryId: string, startedAt: number, accumulatedMs: number, running: boolean } | null} */
function readTimer() {
  try {
    return JSON.parse(localStorage.getItem(TIMER_KEY) ?? "null");
  } catch {
    return null;
  }
}
/** @param {{ entryId: string, startedAt: number, accumulatedMs: number, running: boolean } | null} t */
function writeTimer(t) {
  try {
    if (t) localStorage.setItem(TIMER_KEY, JSON.stringify(t));
    else localStorage.removeItem(TIMER_KEY);
  } catch {
    // storage blocked: the timer just does not survive a reload
  }
}
/** @param {number} ms */
const clockOf = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/**
 * START / PAUSE / END on a planned entry. END records the span AND marks the
 * meal cooked (the rehomed COOKED write); a cooked entry shows recorded vs
 * stated and takes the "overrun was me" comment the review reads.
 * @param {{ entry: Record<string, any>, statedMinutes?: number, onCooked: (entryId: string, seconds: number) => void, onCookComment?: (entryId: string, text: string) => void }} props
 */
function CookTimer({ entry, statedMinutes, onCooked, onCookComment }) {
  const [timer, setTimer] = useState(readTimer);
  const [, setTick] = useState(0);
  const [comment, setComment] = useState(/** @type {string} */ (entry.cookComment ?? ""));
  const mine = timer != null && timer.entryId === entry.id;
  const running = mine && timer.running;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [running]);
  const elapsedMs = mine
    ? timer.accumulatedMs + (timer.running ? Date.now() - timer.startedAt : 0)
    : 0;
  const start = () => {
    const t = { entryId: entry.id, startedAt: Date.now(), accumulatedMs: 0, running: true };
    writeTimer(t);
    setTimer(t);
  };
  const pause = () => {
    const t = { .../** @type {any} */ (timer), accumulatedMs: elapsedMs, running: false };
    writeTimer(t);
    setTimer(t);
  };
  const resume = () => {
    const t = { .../** @type {any} */ (timer), startedAt: Date.now(), running: true };
    writeTimer(t);
    setTimer(t);
  };
  const end = () => {
    const secs = Math.round(elapsedMs / 1000);
    writeTimer(null);
    setTimer(null);
    onCooked(entry.id, secs);
  };
  if (entry.cookedAt) {
    const took = entry.cookSeconds > 0 ? Math.round(entry.cookSeconds / 60) : null;
    return html`<div class="tile">
      <div class="row">
        <span class="k">COOKED ✓${took != null ? ` · took ${took}m` : ""}${statedMinutes ? ` · plan said ${statedMinutes}m` : ""}</span>
      </div>
      ${
        onCookComment &&
        html`<div class="token-form">
          <input aria-label="Cook note" placeholder="optional note: why it ran long/short (burned the first batch)" value=${comment} onInput=${(/** @type {{ currentTarget: HTMLInputElement }} */ e) => setComment(e.currentTarget.value)} />
          <button class="primary" onClick=${() => onCookComment(entry.id, comment)}>${entry.cookComment ? "UPDATE" : "SAVE"}</button>
        </div>`
      }
    </div>`;
  }
  return html`<div class="tile">
    <div class="row">
      <span class="k">cook timer${statedMinutes ? html` <span class="hint">plan says ${statedMinutes}m</span>` : ""}</span>
      ${mine && html`<span class="status num">${clockOf(elapsedMs)}${running ? "" : " · paused"}</span>`}
    </div>
    <div class="actions">
      ${!mine && html`<button class="primary" onClick=${start}>▶ START${timer != null ? " (replaces the running timer)" : ""}</button>`}
      ${running && html`<button onClick=${pause}>⏸ PAUSE</button>`}
      ${mine && !running && html`<button onClick=${resume}>▶ RESUME</button>`}
      ${mine && html`<button class="primary" onClick=${end}>■ END — SERVED, MARK COOKED</button>`}
    </div>
    <p class="hint">
      START when you begin, END when you serve. Ending records the real time beside the plan's
      promise and marks the meal cooked.
    </p>
  </div>`;
}

/**
 * @param {{ recipe: Record<string, any> | undefined, loading: boolean, from?: string, servings?: number, tableId?: string, tableUnresolved?: boolean, potRows?: { food: string, unit: string, qty: number }[], unshopped?: boolean, onPromote?: (recipe: Record<string, any>) => Promise<void>, entry?: Record<string, any>, onCooked?: (entryId: string, seconds: number) => void, onCookComment?: (entryId: string, text: string) => void, serve?: import("../lib/serve.js").ServeModel | null, tableCooked?: boolean, onCookedTable?: (tableId: string) => void }} props
 */
export function RecipeView({
  recipe,
  loading,
  from,
  servings,
  tableId,
  tableUnresolved = false,
  potRows,
  unshopped = false,
  onPromote,
  entry = undefined,
  onCooked = undefined,
  onCookComment = undefined,
  serve = null,
  tableCooked = false,
  onCookedTable = undefined,
}) {
  const [promoting, setPromoting] = useState(
    /** @type {null | "busy" | "done" | "error"} */ (null),
  );
  const origin = originOf(from);
  // the recipe page holds the screen as well as Cook mode. Reading the steps
  // off THIS page with full hands is exactly when it used to sleep, because
  // only Cook mode ever asked for a lock.
  const [awake, setAwake] = useState(
    /** @type {import("../lib/awake.js").AwakeState} */ ({
      held: false,
      supported: true,
      reason: "",
      via: "none",
    }),
  );
  useEffect(() => keepAwake(setAwake), []);
  if (!recipe)
    return html`<div class="empty">
      ${loading ? "loading…" : "recipe not found"} — <a href=${origin.hash}>go back</a>
    </div>`;
  const n = recipe.nutrition ?? {};
  // portion-aware: cook exactly what the plan says to eat, not the whole
  // recipe (the fix for cooking a serves-2 dish and eating both portions)
  const basePlan = cookPlan(recipe, servings);
  // SOLVED tables (per-person-plates spec §7.5/§11.5): the ingredient
  // column shows TONIGHT'S pot for this table — arithmetic, not AI; same
  // name, same steps, SAME WORDS forever, only the numbers change. So the
  // pot quantities are merged ONTO the recipe's own rows by index, keeping
  // prep notes and pantry marks, and only when every row's food+unit
  // matches — a personal variant of the same id must never render the
  // bank's foods (the potFromBank bug class). Batch recipes keep their
  // save-the-extra note: the leftovers instruction is safety-relevant.
  const plan = (() => {
    const ings = basePlan.ingredients ?? [];
    if (!potRows || potRows.length !== ings.length) return basePlan;
    const merged = ings.map((ing, i) => {
      const p = potRows[i];
      return p && p.food === ing.food && p.unit === ing.unit ? { ...ing, qty: p.qty } : null;
    });
    if (merged.some((x) => x === null)) return basePlan;
    return {
      ...basePlan,
      ingredients: /** @type {Record<string, any>[]} */ (merged),
      mode: basePlan.mode === "batch" ? basePlan.mode : "scaled",
      note: basePlan.mode === "batch" ? basePlan.note : "Amounts for tonight's table.",
    };
  })();
  return html`
    <div class="view detail">
      <a class="backlink" href=${origin.hash}>${origin.label}</a>
      <h1>${recipe.name}</h1>
      <div class="meta num">
        ${recipe.totalTime}m ·${" "}
        ${
          // NO SERVING COUNTS (David, 2026-08-10). "cooking 0.75 of 3" and
          // "makes 9.75 servings" are the app talking to itself. A serving is
          // only a denominator for the macros; it is not an amount of food any
          // particular person should eat, and printing it invites exactly the
          // wrong reading ("am I eating three servings?"). The amounts listed
          // below are already scaled to whoever is cooking, so say WHOSE food
          // this is and let the ingredient list carry the quantity.
          plan.mode === "single"
            ? html`your plate`
            : plan.mode === "scaled"
              ? html`the whole pot`
              : html`makes extra on purpose`
        }
        · ${recipe.effort}
        ${(recipe.purpose ?? []).map((/** @type {string} */ p) => html`<span class="tag ${p}">${p === "pre-activity" ? "pre-act" : p}</span>`)}
        ${
          // provenance (council 2026-07-23): an AI-invented meal never
          // passes itself off as an audited bank recipe
          (recipe.tags ?? []).includes("ai-special") &&
          html`<span class="tag">✨ AI special · estimated macros</span>`
        }
        ${
          (recipe.tags ?? []).includes("hbp-annotated") &&
          html`<span class="tag">📖 scanned recipe · estimated macros</span>`
        }
      </div>
      <p class="hint">${recipe.description}</p>
      ${
        // THE COOK TIMER (fix list 7.10, promise P7): START when you begin,
        // END when you serve — the recorded span is what the stated time
        // answers to, and END IS the COOKED write (PF.2's rehoming). Only a
        // planned entry has somewhere to record, so no entry = no timer.
        entry &&
        onCooked &&
        html`<${CookTimer}
          entry=${entry}
          statedMinutes=${recipe.totalTime}
          onCooked=${onCooked}
          onCookComment=${onCookComment}
        />`
      }
      ${
        // the promotion loop (council 2026-07-23: "AI at the table, never in
        // the plan" means a HUMAN decision, and this button is that decision):
        // an unpromoted AI recipe is choosable but never auto-planned; one tap
        // here lets the week generator and brigades use it
        onPromote &&
        untrustedForAutoPlan(recipe) &&
        html`<div class="actions">
          <button
            class="primary"
            disabled=${promoting === "busy"}
            onClick=${async () => {
              setPromoting("busy");
              try {
                await onPromote(recipe);
                setPromoting("done");
              } catch {
                setPromoting("error");
              }
            }}
          >
            ${promoting === "busy" ? "PROMOTING…" : "LET THE PLANNER USE THIS"}
          </button>
          <p class="hint">
            until then it stays choosable by hand and never auto-planned into anyone's week.
          </p>
          ${promoting === "error" && html`<p class="hint scanerr">could not save, try again</p>`}
        </div>`
      }
      ${
        promoting === "done" &&
        html`<p class="hint" role="status">promoted: the planner can use this recipe now.</p>`
      }

      <div class="macros4">
        <div class="tile">
          <div class="k">kcal</div>
          <div class="v">${n.calories}</div>
        </div>
        <div class="tile">
          <div class="k">Protein</div>
          <div class="v">${n.protein}<small>g</small></div>
        </div>
        <div class="tile">
          <div class="k">Carbs</div>
          <div class="v">${n.carbs}<small>g</small></div>
        </div>
        <div class="tile">
          <div class="k">Fat</div>
          <div class="v">${n.fat}<small>g</small></div>
        </div>
      </div>

      ${
        plan.note &&
        html`<div class="tile portion ${plan.mode}" role="note">
          <div class="k">
            ${
              plan.mode === "batch"
                ? "🍲 batch — save the extra"
                : plan.mode === "single"
                  ? "🍽️ cooking your portion"
                  : plan.mode === "scaled"
                    ? "👨‍🍳 family batch — amounts scaled up"
                    : "portion"
            }
          </div>
          <div class="d">${plan.note}</div>
        </div>`
      }
      ${!awake.held && awake.reason && html`<p class="hint awakewhy">☀ ${awake.reason}</p>`}
      ${
        // THE SERVE TILE (Cook Mode's rehomed last step, David 2026-08-19:
        // "get rid of it entirely", executed once this landed). A shared
        // table's who-gets-what renders HERE, and the COOKED button lives
        // inside the same tile — you still cannot confirm a shared meal
        // without the plate split on screen (spec §7.2's guarantee, one page
        // now). sameForEveryone tables have no split; the button stands
        // alone. The plan-entry COOKED write lives in the timer above.
        // a ?table= that this device cannot resolve (cold open before the
        // events file lands, another house's id) says so HONESTLY instead of
        // asserting "same plate for everyone" over a live no-op button
        // (reviewer catch 2026-08-19)
        tableUnresolved &&
        html`<div class="tile serve">
          <div class="serve-title">SERVE</div>
          <p class="hint">
            this table hasn't synced to this device yet — who-gets-what and the COOKED tap appear
            once it loads (or on the device that set the table up).
          </p>
        </div>`
      }
      ${
        tableId &&
        onCookedTable &&
        html`<div class="tile serve">
          <div class="serve-title">SERVE${serve && serve.rows.length > 0 ? "" : " · same plate for everyone"}</div>
          ${serve && serve.rows.length > 0 && html`<div class="serve-sub">Amounts for tonight's table.</div>`}
          ${(serve?.rows ?? []).map((r) =>
            r.kind === "aside"
              ? html`<div class="serve-seat aside" key=${r.id}>
                  <div class="serve-name">SET ASIDE</div>
                  <div class="serve-line">
                    ${r.name.toUpperCase()}'s portion, ${r.fraction}, set apart${r.note ? ` (${r.note})` : ""}
                  </div>
                </div>`
              : html`<div class="serve-seat" key=${r.id}>
                  <div class="serve-name">${r.name.toUpperCase()}</div>
                  ${
                    r.lines && r.lines.length > 0
                      ? r.lines.map((line, i) => html`<div class="serve-line" key=${i}>${line}</div>`)
                      : html`<div class="serve-line">${r.fraction}</div>`
                  }
                  ${r.note && html`<div class="serve-line hint">${r.note}</div>`}
                </div>`,
          )}
          ${(serve?.cookNotes ?? []).map((c, i) => html`<div class="hint" key=${i}>👨‍🍳 ${c}</div>`)}
          <div class="actions">
            ${
              tableCooked
                ? html`<span class="k">COOKED ✓</span>`
                : html`<button class="primary" onClick=${() => onCookedTable(tableId)}>
                    ■ SERVED — MARK THE TABLE COOKED
                  </button>`
            }
          </div>
        </div>`
      }

      ${
        recipe.batchPrep &&
        html`<div class="tile portion batch" role="note">
          ${
            recipe.batchPrep.sundayComponent &&
            html`<div>
              <div class="k">🍲 BATCH PREP — cook this AHEAD, the steps below assume it's done</div>
              <div class="d">${recipe.batchPrep.sundayComponent}</div>
            </div>`
          }
          ${
            recipe.batchPrep.weekdayAssembly &&
            html`<div>
              <div class="k">Day-of assembly</div>
              <div class="d">${recipe.batchPrep.weekdayAssembly}</div>
            </div>`
          }
        </div>`
      }

      <h2 class="block-title">Ingredients</h2>
      <div>
        ${plan.ingredients.map(
          (/** @type {Record<string, any>} */ i) => html`
            <div class="ing ${i.staple ? "staple" : ""}">
              <span>
                ${i.food}${i.note ? html` <span class="note">— ${i.note}</span>` : ""}
                ${i.staple ? html` <span class="pantry-mark">pantry</span>` : ""}
              </span>
              <span class="q">${formatRecipeQty(i.qty, i.unit)}</span>
            </div>
          `,
        )}
      </div>

      <h2 class="block-title">Steps</h2>
      ${
        // NOT A GATE any more (David, 2026-07-27: "it is not good for people
        // to not be able to access recipes when not given receipt yet cause
        // sometimes we do have the food"). The steps used to wait behind a
        // scanned receipt; now the receipt is a NOTE. The original worry it
        // was built for was real (cooking a week nobody bought), but the
        // failure it actually produced was worse: a locked recipe for food
        // already in the fridge.
        unshopped &&
        html`<p class="hint receiptnote">
          No receipt scanned for this week yet, so nothing here is confirmed bought. Cook it anyway
          if you already have the food. <a href="#/list">scan the receipt →</a>
        </p>`
      }
      <ol class="steps">
        ${(recipe.instructions ?? []).map(
          (/** @type {{ step: number, text: string }} */ s) =>
            html`<li key=${s.step}>${s.text}</li>`,
        )}
      </ol>
    </div>
  `;
}

