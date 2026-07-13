import { html } from "htm/preact";
import { useRef, useState } from "preact/hooks";
import { scanPhoto } from "../lib/worker.js";

const SECTION_ORDER = ["produce", "meat", "dairy", "dry-goods", "frozen", "spices", "other"];

/**
 * Shopping list + pantry (blueprint §6.4/6.5). Phone-first: big checkbox
 * rows, section grouping, works offline (cache-backed store writes).
 * @param {{
 *   shopping: import("../lib/shopping.js").ShoppingList,
 *   pantry: Record<string, any>,
 *   plan: import("../lib/plan.js").Plan,
 *   weekId: string,
 *   hasToken: boolean,
 *   repo: Record<string, any> | null,
 *   loading: boolean,
 *   onBuild: () => void,
 *   onToggleItem: (id: string) => void,
 *   onAddManual: (food: string) => void,
 *   onJustBought: () => void,
 *   onToggleLow: (id: string) => void,
 *   onOwnItem: (id: string) => void,
 *   onScanApprove: (items: { name: string, kind: string, qty: string }[]) => void,
 *   onToggleLock: () => void
 * }} props
 */
export function ShoppingView({
  shopping,
  pantry,
  plan,
  weekId,
  hasToken,
  repo,
  loading,
  onBuild,
  onToggleItem,
  onAddManual,
  onJustBought,
  onToggleLow,
  onOwnItem,
  onScanApprove,
  onToggleLock,
}) {
  const [tab, setTab] = useState(/** @type {"list" | "pantry"} */ ("list"));
  const [manual, setManual] = useState("");
  // camera scan: null | "busy" | { error } | { items, kept: boolean[] }
  const [scan, setScan] = useState(/** @type {any} */ (null));
  const fileRef = useRef(/** @type {HTMLInputElement | null} */ (null));

  const onPhotoPicked = async (/** @type {{ currentTarget: HTMLInputElement }} */ e) => {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = ""; // same photo re-pickable
    if (!file || scan === "busy") return;
    setScan("busy");
    try {
      const items = await scanPhoto(file);
      setScan(
        items.length === 0
          ? { notice: "no food recognized — try a closer, brighter shot" }
          : { items, kept: items.map(() => true) },
      );
    } catch (err) {
      setScan({ error: err instanceof Error ? err.message : "scan failed" });
    }
  };
  const tokenBlocked = !hasToken || repo?.auth === "invalid";
  const items = shopping.items ?? [];
  const checkedCount = items.filter((i) => i.checked).length;

  const sections = SECTION_ORDER.map((s) => ({
    section: s,
    items: items.filter((i) => i.section === s),
  })).filter((g) => g.items.length > 0);

  return html`
    <div class="view">
      <div class="hero"><h1>List</h1></div>

      <div class="chips" role="group" aria-label="List or pantry">
        <button
          class="chip ${tab === "list" ? "on" : ""}"
          aria-pressed=${tab === "list"}
          onClick=${() => setTab("list")}
        >
          SHOPPING ${items.length ? `(${items.length})` : ""}
        </button>
        <button
          class="chip ${tab === "pantry" ? "on" : ""}"
          aria-pressed=${tab === "pantry"}
          onClick=${() => setTab("pantry")}
        >
          PANTRY
        </button>
      </div>

      ${
        tab === "list" &&
        html`
          <div class="actions wrap">
            <button class="primary" onClick=${onBuild}>BUILD FROM W${weekId.split("-W")[1]}</button>
            ${
              checkedCount > 0 &&
              html`<button class="primary" onClick=${onJustBought}>
                ADD TO PANTRY (${checkedCount}) <span aria-hidden="true">→</span>
              </button>`
            }
            <button
              class="secondary lockbtn ${plan?.locked ? "on" : ""}"
              aria-pressed=${Boolean(plan?.locked)}
              aria-label=${
                plan?.locked
                  ? "Unlock the week — allow the plan to change again"
                  : "Going to the store — lock this week's plan so it can't silently change"
              }
              onClick=${onToggleLock}
            >
              ${plan?.locked ? "🔓 UNLOCK WEEK" : "🛒 GOING TO THE STORE"}
            </button>
          </div>
          <p class="hint">
            Aggregates the week's plan, drops pantry staples, groups by aisle. Rebuilt lists keep
            your ticks and manual items. Tick = got it / have enough this week. P+ = already own it
            — moves it to your permanent pantry staples.
            ${
              plan?.locked
                ? " Week is LOCKED — you've shopped for it. GENERATE/RE-ROLL won't run, and changing a meal asks first."
                : " Heading out to shop? Tap GOING TO THE STORE first so the plan can't change out from under your groceries."
            }
          </p>

          ${sections.map(
            (g) => html`
              <h2 class="block-title" key=${g.section}>${g.section}</h2>
              <div class="slots">
                ${g.items.map(
                  (i) => html`
                    <div class="checkrow ${i.checked ? "done" : ""}" key=${i.id}>
                      <button
                        class="tickarea"
                        aria-pressed=${i.checked}
                        onClick=${() => onToggleItem(i.id)}
                      >
                        <span class="box" aria-hidden="true">${i.checked ? "✓" : ""}</span>
                        <span class="food"
                          >${i.food}${i.manual ? html` <span class="tag">manual</span>` : ""}</span
                        >
                        <span class="q num">${i.qty} ${i.unit}</span>
                      </button>
                      <button
                        class="ownbtn"
                        aria-label="Already have ${i.food} — move to pantry staples"
                        onClick=${() => onOwnItem(i.id)}
                      >
                        P+
                      </button>
                    </div>
                  `,
                )}
              </div>
            `,
          )}
          ${
            items.length === 0 &&
            html`<div class="empty">
              ${
                repo?.auth === "invalid"
                  ? "token needs renewing — SYS"
                  : !hasToken
                    ? "connect token in SYS"
                    : loading
                      ? "loading…"
                      : "no list yet — build it from this week's plan"
              }
            </div>`
          }

          <div class="token-form">
            <input
              aria-label="Add item by hand"
              placeholder="add item (e.g. batteries)"
              value=${manual}
              onInput=${(/** @type {{ currentTarget: HTMLInputElement }} */ e) =>
                setManual(e.currentTarget.value)}
            />
            <button
              class="primary"
              onClick=${() => {
                if (manual.trim()) {
                  onAddManual(manual.trim());
                  setManual("");
                }
              }}
            >
              ADD
            </button>
          </div>
        `
      }
      ${
        tab === "pantry" &&
        html`
          <button
            class="ask scanbtn"
            onClick=${() => fileRef.current?.click()}
            disabled=${scan === "busy" || tokenBlocked}
          >
            ${scan === "busy" ? "READING PHOTO…" : "📷 SCAN SHELF"}
            <small>
              photo of fridge or pantry <span aria-hidden="true">→</span> itemized${" "}
              <span aria-hidden="true">→</span> approve
            </small>
          </button>
          <input
            ref=${fileRef}
            class="visuallyhidden"
            type="file"
            accept="image/*"
            capture="environment"
            tabindex="-1"
            aria-hidden="true"
            disabled=${scan === "busy"}
            onChange=${onPhotoPicked}
          />
          ${
            tokenBlocked &&
            html`<p class="hint">
              ${repo?.auth === "invalid" ? "token needs renewing — SYS" : "connect token in SYS"}
            </p>`
          }
          ${scan?.error && html`<p class="hint scanerr" role="status">${scan.error}</p>`}
          ${scan?.notice && html`<p class="hint" role="status">${scan.notice}</p>`}
          ${
            scan?.items &&
            html`
              <div class="tile scanreview">
                <div class="k">Found ${scan.items.length} — untick what's wrong</div>
                ${scan.items.map(
                  (/** @type {any} */ it, /** @type {number} */ i) => html`
                    <label class="checkrow" key=${i}>
                      <input
                        type="checkbox"
                        checked=${scan.kept[i]}
                        onChange=${() =>
                          setScan({
                            ...scan,
                            kept: scan.kept.map(
                              (/** @type {boolean} */ k, /** @type {number} */ j) =>
                                j === i ? !k : k,
                            ),
                          })}
                      />
                      <span class="food">
                        ${it.name}${it.qty ? html` <span class="q num">${it.qty}</span>` : ""}
                      </span>
                      <span class="tag">${it.kind}</span>
                    </label>
                  `,
                )}
                <div class="actions">
                  <button
                    class="primary"
                    onClick=${() => {
                      onScanApprove(
                        scan.items.filter((/** @type {any} */ _, /** @type {number} */ i) =>
                          Boolean(scan.kept[i]),
                        ),
                      );
                      setScan(null);
                    }}
                    disabled=${!scan.kept.some(Boolean)}
                  >
                    ADD ${scan.kept.filter(Boolean).length} TO PANTRY
                  </button>
                  <button class="secondary" onClick=${() => setScan(null)}>CANCEL</button>
                </div>
              </div>
            `
          }
          <p class="hint">
            Tap LOW when a staple runs out — it joins the next shopping list. Perishables arrive
            here via Just Bought or a shelf scan.
          </p>
          <h2 class="block-title">Staples</h2>
          ${
            (pantry.staples ?? []).length === 0 &&
            html`<div class="empty">no staples yet — they arrive with your seed data</div>`
          }
          <div class="slots">
            ${(pantry.staples ?? []).map(
              (/** @type {Record<string, any>} */ s) => html`
                <div class="checkrow static" key=${s.id}>
                  <span class="food">
                    ${s.name}${s.premium ? html` <span class="tag premium">premium</span>` : ""}
                  </span>
                  <button
                    class="lowbtn ${s.runningLow ? "on" : ""}"
                    aria-pressed=${s.runningLow}
                    onClick=${() => onToggleLow(s.id)}
                  >
                    LOW${s.runningLow ? html` <span aria-hidden="true">✓</span>` : ""}
                  </button>
                </div>
              `,
            )}
          </div>
          ${
            (pantry.perishables ?? []).length > 0 &&
            html`
              <h2 class="block-title">Perishables</h2>
              <div class="slots">
                ${(pantry.perishables ?? []).map(
                  (/** @type {Record<string, any>} */ p, /** @type {number} */ i) => html`
                    <div class="checkrow static" key=${i}>
                      <span class="food">${p.food}</span>
                      <span class="q num">${p.qty ?? ""} · ${p.added}</span>
                    </div>
                  `,
                )}
              </div>
            `
          }
        `
      }
    </div>
  `;
}
