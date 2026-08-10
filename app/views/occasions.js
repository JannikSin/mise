import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import {
  PRESETS,
  presetById,
  occasionFromPreset,
  datesOf,
  summarize,
  shiftIso,
} from "../lib/occasions.js";
import { recipesById } from "../lib/plan.js";
import { parseLocalIso } from "../lib/dates.js";

/** Which shelf of occasion-only food a day is drawing from, for the swap picker. */
const SHELVES = [
  { tag: "clear-liquid", label: "clear liquids" },
  { tag: "low-residue", label: "low residue" },
  { tag: "soft", label: "soft food" },
];

/** @param {string} iso */
function prettyDay(iso) {
  const d = parseLocalIso(iso);
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

/**
 * OCCASIONS — dated overrides that take days off the generator.
 *
 * Deliberately not a tab. This is a screen you visit a handful of times a
 * year, reached from Settings, and it announces itself on the Plan tab once
 * an occasion is actually running (David: "hidden-ish, but not awful to
 * find"). Everything on it is editable before you commit it, because the
 * whole point of the feature is that a new situation must not require a
 * developer.
 *
 * @param {{
 *   occasions: import("../lib/occasions.js").Occasion[],
 *   profiles: { id: string, name: string, emoji?: string }[],
 *   me: string,
 *   recipes: Record<string, any>[],
 *   todayIso: string,
 *   busy?: boolean,
 *   onScreen: (profileId: string, recipeIds: string[]) => Promise<Record<string, string[]>>,
 *   onApply: (occasion: import("../lib/occasions.js").Occasion) => void,
 *   onRemove: (occasion: import("../lib/occasions.js").Occasion) => void
 * }} props
 */
export function OccasionsView({
  occasions,
  profiles,
  me,
  recipes,
  todayIso,
  busy,
  onScreen,
  onApply,
  onRemove,
}) {
  const [draft, setDraft] = useState(
    /** @type {import("../lib/occasions.js").Occasion | null} */ (null),
  );
  const [presetId, setPresetId] = useState("");
  const [who, setWho] = useState(me);
  const [anchor, setAnchor] = useState(shiftIso(todayIso, 7));
  const [acknowledged, setAcknowledged] = useState(false);
  const [openDay, setOpenDay] = useState("");
  const [adding, setAdding] = useState("");
  // recipeId -> why it conflicts with the OCCASION OWNER's diet/allergens.
  // Screened against their file, never the device owner's: the picker above
  // was filtered through whoever is holding the phone.
  const [conflicts, setConflicts] = useState(/** @type {Record<string, string[]>} */ ({}));

  const byId = recipesById(recipes);
  const nameOf = (/** @type {string} */ id) => profiles.find((p) => p.id === id)?.name ?? id;

  // the occasion-only bank, split by shelf, for the swap and add pickers
  const shelfFood = (/** @type {string} */ tag) =>
    recipes.filter((r) => (r.tags ?? []).includes("occasion-only") && (r.tags ?? []).includes(tag));

  /** Which shelf a day is on, inferred from what is already placed there. */
  const shelfOf = (/** @type {Record<string, any>} */ day) => {
    for (const item of day.items) {
      const r = item.recipeId ? byId.get(item.recipeId) : null;
      const hit = SHELVES.find((s) => (r?.tags ?? []).includes(s.tag));
      if (hit) return hit.tag;
    }
    return "low-residue";
  };

  const build = () => {
    const preset = presetById(presetId);
    if (!preset) return;
    setDraft(occasionFromPreset(preset, anchor, who, { createdAt: new Date().toISOString() }));
    setAcknowledged(false);
    setOpenDay("");
    setConflicts({});
  };

  // re-screen whenever the draft's food or owner changes: dropping the
  // offending line must actually clear the block, or the gate is a wall
  const draftRecipeIds = draft
    ? datesOf(draft)
        .flatMap((d) => draft.days[d]?.items ?? [])
        .map((/** @type {any} */ i) => i.recipeId)
        .filter(Boolean)
        .join(",")
    : "";
  useEffect(() => {
    if (!draft) {
      setConflicts({});
      return;
    }
    let alive = true;
    onScreen(draft.profileId, draftRecipeIds ? draftRecipeIds.split(",") : []).then((c) => {
      if (alive) setConflicts(c ?? {});
    });
    return () => {
      alive = false;
    };
  }, [draftRecipeIds, draft?.profileId]);

  const blocked = Object.keys(conflicts).length > 0;

  /** Edit one day of the draft in place. @param {string} date @param {(d: any) => any} fn */
  const editDay = (/** @type {string} */ date, /** @type {(d: any) => any} */ fn) =>
    setDraft((cur) =>
      cur ? /** @type {any} */ ({ ...cur, days: { ...cur.days, [date]: fn(cur.days[date]) } }) : cur,
    );

  const dropItem = (/** @type {string} */ date, /** @type {number} */ idx) =>
    editDay(date, (d) => ({
      ...d,
      items: d.items.filter((/** @type {any} */ _, /** @type {number} */ i) => i !== idx),
    }));

  const addItem = (
    /** @type {string} */ date,
    /** @type {string} */ recipeId,
    /** @type {string} */ slot,
  ) => {
    editDay(date, (d) => ({ ...d, items: [...d.items, { slot, recipeId, servings: 1 }] }));
    setAdding("");
  };

  const sorted = [...(occasions ?? [])].sort((a, b) =>
    String(a.from).localeCompare(String(b.from)),
  );
  const live = sorted.filter((o) => o.to >= todayIso);
  const done = sorted.filter((o) => o.to < todayIso);
  const preset = presetById(presetId);

  /** @param {import("../lib/occasions.js").Occasion} o @param {boolean} past */
  const card = (o, past) => html`
    <div class="slot ${past ? "muted" : ""}" key=${o.id}>
      <div class="slotlink">
        <span class="name">${o.emoji} ${o.name}</span>
        <span class="m">${nameOf(o.profileId)} · ${summarize(o)}</span>
      </div>
      ${
        o.from <= todayIso &&
        o.to >= todayIso &&
        html`<p class="hint"><b>Running now.</b> ${o.days[todayIso]?.label ?? "between days"}</p>`
      }
      <button class="chip" onClick=${() => onRemove(o)} disabled=${busy}>REMOVE</button>
    </div>
  `;

  return html`
    <div class="view">
      <a class="backlink" href="#/system">← SETTINGS</a>
      <div class="hero"><h1>Occasions</h1></div>
      <p class="hint">
        Days the app should stop planning for and just follow a script: a medical prep, a holiday,
        travel, a race. The week generator hands off completely on those days, and whoever the
        occasion belongs to comes off every shared table while it runs.
      </p>

      ${
        live.length > 0 &&
        html`
          <h2 class="block-title">Coming up</h2>
          <div class="slots">${live.map((o) => card(o, false))}</div>
        `
      }

      <h2 class="block-title">Add one</h2>
      <div class="chips wrapchips" role="group" aria-label="Occasion type">
        ${PRESETS.map(
          (p) => html`
            <button
              class="chip ${presetId === p.id ? "on" : ""}"
              aria-pressed=${presetId === p.id}
              onClick=${() => {
                setPresetId(p.id);
                setDraft(null);
              }}
            >
              ${p.emoji} ${p.name}
            </button>
          `,
        )}
      </div>
      ${preset && html`<p class="hint">${preset.blurb}</p>`}
      ${
        preset &&
        html`
          <div class="token-form">
            <label>
              <span class="m">Who</span>
              <select
                value=${who}
                onInput=${(/** @type {any} */ e) => {
                  setWho(e.currentTarget.value);
                  setDraft(null);
                }}
              >
                ${profiles.map((p) => html`<option value=${p.id}>${p.name}</option>`)}
              </select>
            </label>
            <label>
              <span class="m">${preset.anchorLabel}</span>
              <input
                type="date"
                value=${anchor}
                onInput=${(/** @type {any} */ e) => {
                  setAnchor(e.currentTarget.value);
                  setDraft(null);
                }}
              />
            </label>
            <button class="primary" onClick=${build} disabled=${!anchor}>PREVIEW</button>
          </div>
        `
      }
      ${
        draft &&
        html`
          <h2 class="block-title">${draft.emoji} ${draft.name} — ${summarize(draft)}</h2>
          <p class="hint">
            ${nameOf(draft.profileId)}. Every day below replaces whatever is planned. Change
            anything you want before you apply it: drop a line, add one from the same shelf.
          </p>

          ${
            draft.disclaimer &&
            html`
              <div class="warnbox" role="note">
                <p><b>Read this.</b> ${draft.disclaimer}</p>
                <label class="chip ${acknowledged ? "on" : ""}">
                  <input
                    type="checkbox"
                    checked=${acknowledged}
                    onInput=${(/** @type {any} */ e) => setAcknowledged(e.currentTarget.checked)}
                  />
                  I have the letter and this matches it
                </label>
              </div>
            `
          }

          <div class="slots">
            ${datesOf(draft).map((date) => {
              const day = draft.days[date];
              if (!day) return null;
              const shelf = shelfOf(day);
              const open = openDay === date;
              return html`
                <div class="slot" key=${date}>
                  <button
                    class="slotlink"
                    onClick=${() => setOpenDay(open ? "" : date)}
                    aria-expanded=${open}
                  >
                    <span class="name">${prettyDay(date)} · ${day.label}</span>
                    <span class="m">${day.items.length} lines ${open ? "▾" : "▸"}</span>
                  </button>
                  ${day.note && html`<p class="hint">${day.note}</p>`}
                  ${
                    open &&
                    html`
                      <ul class="protolist">
                        ${day.items.map((/** @type {any} */ item, /** @type {number} */ idx) => {
                          const r = item.recipeId ? byId.get(item.recipeId) : null;
                          return html`
                            <li key=${`${date}-${idx}`}>
                              <span class="m">${item.slot}</span>
                              ${" "}${r ? r.name : item.freeText}
                              ${
                                r &&
                                html`<span class="m num">
                                  · ${r.nutrition?.calories ?? 0} kcal</span
                                >`
                              }
                              ${item.note && html`<span class="hint"> ${item.note}</span>`}
                              <button class="chip" onClick=${() => dropItem(date, idx)}>×</button>
                              ${
                                item.recipeId &&
                                conflicts[item.recipeId] &&
                                html`<p class="hint scanerr">
                                  ${nameOf(draft.profileId)} cannot eat this:
                                  ${(conflicts[item.recipeId] ?? []).join(", ")}. Drop it.
                                </p>`
                              }
                            </li>
                          `;
                        })}
                      </ul>
                      ${
                        adding === date
                          ? html`
                              <div class="chips wrapchips">
                                ${shelfFood(shelf).map(
                                  (r) => html`
                                    <button
                                      class="chip"
                                      key=${r.id}
                                      onClick=${() => addItem(date, r.id, r.mealType ?? "snack")}
                                    >
                                      + ${r.name}
                                    </button>
                                  `,
                                )}
                                <button class="chip" onClick=${() => setAdding("")}>cancel</button>
                              </div>
                              <p class="hint">
                                Only ${SHELVES.find((s) => s.tag === shelf)?.label} show here. That
                                is deliberate: this day has rules.
                              </p>
                            `
                          : html`<button class="chip" onClick=${() => setAdding(date)}>
                              + ADD A LINE
                            </button>`
                      }
                    `
                  }
                </div>
              `;
            })}
          </div>

          <label class="chip ${draft.offTables ? "on" : ""}">
            <input
              type="checkbox"
              checked=${draft.offTables}
              onInput=${(/** @type {any} */ e) =>
                setDraft({ ...draft, offTables: e.currentTarget.checked })}
            />
            take ${nameOf(draft.profileId)} off shared tables these days
          </label>

          <button
            class="primary"
            disabled=${busy || blocked || (Boolean(draft.disclaimer) && !acknowledged)}
            onClick=${() => {
              onApply(draft);
              setDraft(null);
              setPresetId("");
            }}
          >
            ${busy ? "APPLYING…" : "APPLY THIS"}
          </button>
          ${
            blocked &&
            html`<p class="hint scanerr">
              ${Object.keys(conflicts).length} line${Object.keys(conflicts).length === 1 ? "" : "s"}
              above conflict with ${nameOf(draft.profileId)}'s own diet or allergen list. Open the
              day and drop them. This one does not get a tick-box override.
            </p>`
          }
          ${
            Boolean(draft.disclaimer) &&
            !acknowledged &&
            html`<p class="hint">tick the box above first.</p>`
          }
        `
      }
      ${
        done.length > 0 &&
        html`
          <h2 class="block-title">Past</h2>
          <div class="slots">${done.slice(-5).map((o) => card(o, true))}</div>
        `
      }
    </div>
  `;
}
