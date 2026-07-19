import { html } from "htm/preact";
import { useRef, useState } from "preact/hooks";
import { scanPhoto, scanReceipt } from "../lib/worker.js";
import { mergeProfileLists, swapCandidates, formatStoreQty, tripOf } from "../lib/shopping.js";
import { itemCost, rankStores, taxRateFor, tripTotal, storeSlugFromReceipt } from "../lib/prices.js";
import { activeProfile } from "../lib/store.js";

/** Catalogue store slug → shopper-facing name. */
const STORE_NAMES = /** @type {Record<string, string>} */ ({
  "trader-joes": "Trader Joe's",
  marianos: "Mariano's",
  "jewel-osco": "Jewel-Osco",
  costco: "Costco",
});

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
 *   onToggleLock: () => void,
 *   others: { profileId: string, name: string, emoji: string, list: import("../lib/shopping.js").ShoppingList }[],
 *   ownEmoji: string,
 *   onCombinedToggle: (itemId: string, sources: { profileId: string, checked: boolean }[]) => void,
 *   shopsPerWeek?: number,
 *   prices?: import("../lib/prices.js").PriceCatalogue | null,
 *   region?: { country?: string, state?: string },
 *   storeSlug?: string,
 *   onReceiptApprove?: (store: string, lines: { name: string, price: number, size: string }[]) => void
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
  others,
  ownEmoji,
  onCombinedToggle,
  shopsPerWeek = 1,
  prices = null,
  region = undefined,
  storeSlug = "",
  onReceiptApprove = undefined,
}) {
  const [tab, setTab] = useState(/** @type {"list" | "pantry" | "combined"} */ ("list"));
  const [manual, setManual] = useState("");
  // camera scan: null | "busy" | { error } | { items, kept: boolean[] }
  const [scan, setScan] = useState(/** @type {any} */ (null));
  const fileRef = useRef(/** @type {HTMLInputElement | null} */ (null));
  // receipt scan (price freshness loop): null | "busy" | { error } | { notice }
  //   | { store, lines: [{name, price, size}], kept: bool[] }
  const [receipt, setReceipt] = useState(/** @type {any} */ (null));
  const receiptRef = useRef(/** @type {HTMLInputElement | null} */ (null));

  const onReceiptPicked = async (/** @type {{ currentTarget: HTMLInputElement }} */ e) => {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = "";
    if (!file || receipt === "busy") return;
    setReceipt("busy");
    try {
      const { store, items: lines } = await scanReceipt(file);
      if (lines.length === 0) {
        setReceipt({ notice: "no priced lines read — try a flatter, brighter shot" });
        return;
      }
      const detected = storeSlugFromReceipt(store, prices?.stores ?? []);
      setReceipt({ store: detected ?? storeSlug ?? "", lines, kept: lines.map(() => true) });
    } catch (err) {
      setReceipt({ error: err instanceof Error ? err.message : "receipt scan failed" });
    }
  };

  const approveReceipt = () => {
    if (!receipt?.lines || !receipt.store || !onReceiptApprove) return;
    const chosen = receipt.lines.filter((/** @type {any} */ _l, /** @type {number} */ i) => receipt.kept[i]);
    if (chosen.length) onReceiptApprove(receipt.store, chosen);
    setReceipt({ notice: `updated ${chosen.length} prices — thanks, the catalogue is fresher now` });
  };

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

  // survey-v2 David-ask #3: split the list into shopping trips when the
  // profile shops more than once a week. One trip = today's single list.
  const trips =
    shopsPerWeek >= 2
      ? [
          { key: "pantry", label: "Trip · pantry & bulk", groups: sections.filter((g) => tripOf(g.section) === "pantry") },
          { key: "fresh", label: "Trip · fresh", groups: sections.filter((g) => tripOf(g.section) === "fresh") },
        ].filter((t) => t.groups.length > 0)
      : [{ key: "all", label: "", groups: sections }];

  // combined household trip: this profile's list + every other profile's,
  // merged read-time (no third artifact to sync)
  const me = activeProfile();
  /** @type {Map<string, string>} */
  const emojiFor = new Map();
  emojiFor.set(me, ownEmoji || "you");
  for (const o of others) emojiFor.set(o.profileId, o.emoji);
  const combined =
    others.length > 0
      ? mergeProfileLists([
          { profileId: me, list: shopping },
          ...others.map((o) => ({ profileId: o.profileId, list: o.list })),
        ])
      : [];
  const combinedSections = SECTION_ORDER.map((s) => ({
    section: s,
    items: combined.filter((i) => i.section === s),
  })).filter((g) => g.items.length > 0);
  const candidates = swapCandidates(combined);
  const sharedCount = combined.filter((i) => i.sources.length > 1).length;

  // price estimates (prices.json catalogue): chips per row at the profile's
  // own store, trip totals + grocery tax below the list, honest store ranking
  const ranked = prices ? rankStores(items, prices, region) : [];
  const homeStore =
    storeSlug && ranked.some((r) => r.store === storeSlug)
      ? storeSlug
      : (ranked[0]?.store ?? "");
  const homeSummary = ranked.find((r) => r.store === homeStore)?.summary ?? null;
  const bestStore = ranked[0] ?? null;
  const priceTag = (/** @type {any} */ item) => {
    const c = prices && homeStore ? itemCost(item, prices, homeStore) : null;
    return c ? html`<span class="q num">$${c.cost.toFixed(2)}${c.estimate ? "~" : ""}</span>` : "";
  };
  // the whole household's one trip, priced: combined items already carry
  // {food, qty, unit}, so tripTotal works on them directly
  const combinedSummary =
    prices && homeStore && combined.length > 0
      ? tripTotal(combined, prices, homeStore, region)
      : null;

  // receipt → catalogue freshness loop: photograph a receipt, review the
  // parsed lines and store, apply the real prices over the estimates.
  const receiptControl = () => html`
    <div class="receipt-loop">
      <input
        ref=${receiptRef}
        type="file"
        accept="image/*"
        capture="environment"
        style="display:none"
        onChange=${onReceiptPicked}
      />
      ${
        (receipt === null || receipt?.notice || receipt?.error) &&
        html`<button
          class="secondary"
          disabled=${tokenBlocked}
          onClick=${() => receiptRef.current?.click()}
        >
          📷 update prices from a receipt
        </button>`
      }
      ${receipt === "busy" && html`<p class="hint">reading the receipt…</p>`}
      ${receipt?.notice && html`<p class="hint">${receipt.notice}</p>`}
      ${
        receipt?.error &&
        html`<p class="hint">
          ${receipt.error}${tokenBlocked ? "" : " (needs the app's AI key set — same as pantry scan)"}
        </p>`
      }
      ${
        receipt?.lines &&
        html`
          <div class="tile">
            <div class="row">
              <span class="k">which store?</span>
            </div>
            <div class="chips wrapchips" role="group" aria-label="Receipt store">
              ${(prices?.stores ?? []).map(
                (s) => html`
                  <button
                    class="chip ${receipt.store === s ? "on" : ""}"
                    key=${s}
                    onClick=${() => setReceipt({ ...receipt, store: s })}
                  >
                    ${STORE_NAMES[s] ?? s}
                  </button>
                `,
              )}
            </div>
            <p class="hint">tick the lines to save, then apply. Only lines that match a tracked item update.</p>
            <div class="slots">
              ${receipt.lines.map(
                (/** @type {any} */ l, /** @type {number} */ idx) => html`
                  <div class="checkrow ${receipt.kept[idx] ? "" : "off"}" key=${idx}>
                    <button
                      class="tickarea"
                      aria-pressed=${receipt.kept[idx]}
                      onClick=${() =>
                        setReceipt({
                          ...receipt,
                          kept: receipt.kept.map((/** @type {boolean} */ k, /** @type {number} */ j) =>
                            j === idx ? !k : k,
                          ),
                        })}
                    >
                      <span class="box" aria-hidden="true">${receipt.kept[idx] ? "✓" : ""}</span>
                      <span class="food">${l.name}${l.size ? html` <span class="tag">${l.size}</span>` : ""}</span>
                      <span class="q num">$${Number(l.price).toFixed(2)}</span>
                    </button>
                  </div>
                `,
              )}
            </div>
            <div class="actions wrap">
              <button class="primary" onClick=${approveReceipt} disabled=${!receipt.store}>
                APPLY TO ${(STORE_NAMES[receipt.store] ?? receipt.store ?? "").toUpperCase()}
              </button>
              <button class="secondary" onClick=${() => setReceipt(null)}>cancel</button>
            </div>
          </div>
        `
      }
    </div>
  `;

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
        ${
          others.length > 0 &&
          html`<button
            class="chip ${tab === "combined" ? "on" : ""}"
            aria-pressed=${tab === "combined"}
            onClick=${() => setTab("combined")}
          >
            EVERYONE ${combined.length ? `(${combined.length})` : ""}
          </button>`
        }
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
          <p class="hint lockhint">
            ${
              plan?.locked
                ? html`<strong>Week is LOCKED 🔒</strong> — you've shopped for it. Meals can't
                    change without asking you first.`
                : html`<strong>Going shopping? Tap 🛒 GOING TO THE STORE first.</strong> It locks
                    this week's meals so they can't change after you've bought the food.`
            }
          </p>
          <p class="hint">
            Aggregates the week's plan, drops pantry staples, groups by aisle. Rebuilt lists keep
            your ticks and manual items. Tick = got it / have enough this week. P+ = already own it
            — moves it to your permanent pantry staples.
          </p>

          ${trips.map(
            (trip) => html`
              <div key=${trip.key}>
                ${trip.label && html`<h2 class="block-title trip-title">${trip.label}</h2>`}
                ${trip.groups.map(
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
                                >${i.food}${i.manual
                                  ? html` <span class="tag">manual</span>`
                                  : ""}</span
                              >
                              <span class="q num">${formatStoreQty(i.qty, i.unit)}</span>
                              ${priceTag(i)}
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
              </div>
            `,
          )}
          ${
            homeSummary &&
            items.length > 0 &&
            html`
              <div class="tile">
                <div class="row">
                  <span class="k">Est. ${STORE_NAMES[homeStore] ?? homeStore} trip</span>
                  <span class="status num">$${homeSummary.subtotal.toFixed(2)}</span>
                </div>
                ${
                  homeSummary.tax > 0 &&
                  html`<div class="row">
                    <span class="k">grocery tax ${(taxRateFor(region) * 100).toFixed(1)}%</span>
                    <span class="status num">$${homeSummary.tax.toFixed(2)}</span>
                  </div>`
                }
                <div class="row">
                  <span class="k">Total</span>
                  <span class="status num">$${homeSummary.total.toFixed(2)}</span>
                </div>
                <p class="hint">
                  ${homeSummary.priced} of ${items.length} rows priced${
                    homeSummary.estimates > 0 ? `, ${homeSummary.estimates} are estimates (~)` : ""
                  }${homeSummary.unpriced > 0 ? " — unpriced rows cost extra on top" : ""}.
                </p>
                ${
                  bestStore &&
                  ranked.length > 1 &&
                  (bestStore.store === homeStore
                    ? html`<p class="hint">cheapest well-covered store for this basket ✓</p>`
                    : html`<p class="hint">
                        cheaper basket: ${STORE_NAMES[bestStore.store] ?? bestStore.store} est.
                        $${bestStore.summary.total.toFixed(2)}
                      </p>`)
                }
                ${prices && onReceiptApprove && receiptControl()}
              </div>
            `
          }
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
      ${
        tab === "combined" &&
        html`
          <p class="hint">
            One trip for the whole household. Quantities are everyone's lists summed; the badges
            show who wants it. Tick = bought for everyone who wants it (writes to each person's
            own list). <span class="num">${sharedCount}</span> of${" "}
            <span class="num">${combined.length}</span> items are already shared.
          </p>
          ${
            candidates.length > 0 &&
            html`
              <div class="tile buildreport" role="note">
                <div class="k">Could share instead of buying twice</div>
                ${candidates.slice(0, 6).map(
                  (c) => html`
                    <div class="d" key=${c.item.id}>
                      ${emojiFor.get(c.item.sources[0]?.profileId ?? "") ?? "?"} ${c.item.food} —
                      others already buying: ${c.alreadyBuying.map((i) => i.food).join(", ")}
                    </div>
                  `,
                )}
                <div class="d hint">
                  suggestions only — swap the recipe yourself if it makes sense
                </div>
              </div>
            `
          }
          ${combinedSections.map(
            (g) => html`
              <h2 class="block-title" key=${g.section}>${g.section}</h2>
              <div class="slots">
                ${g.items.map((i) => {
                  const allChecked = i.sources.every((s) => s.checked);
                  const someChecked = !allChecked && i.sources.some((s) => s.checked);
                  const stillNeeds = i.sources
                    .filter((s) => !s.checked)
                    .map((s) => emojiFor.get(s.profileId) ?? "?")
                    .join(" ");
                  return html`
                    <div class="checkrow ${allChecked ? "done" : ""}" key=${i.id}>
                      <button
                        class="tickarea"
                        aria-pressed=${allChecked}
                        aria-label=${
                          someChecked
                            ? `${i.food} — partly bought, still needed for ${stillNeeds}`
                            : i.food
                        }
                        onClick=${() => onCombinedToggle(i.id, i.sources)}
                      >
                        <span class="box" aria-hidden="true"
                          >${allChecked ? "✓" : someChecked ? "◐" : ""}</span
                        >
                        <span class="food">
                          ${i.food}${" "}
                          <span class="tag"
                            >${i.sources.map((s) => emojiFor.get(s.profileId) ?? "?").join(" ")}</span
                          >
                          ${
                            someChecked &&
                            html` <span class="tag">still needs ${stillNeeds}</span>`
                          }
                        </span>
                        <span class="q num">${formatStoreQty(i.qty, i.unit)}</span>
                        ${priceTag(i)}
                      </button>
                    </div>
                  `;
                })}
              </div>
            `,
          )}
          ${
            combinedSummary &&
            html`
              <div class="tile">
                <div class="row">
                  <span class="k">Est. ${STORE_NAMES[homeStore] ?? homeStore} household trip</span>
                  <span class="status num">$${combinedSummary.subtotal.toFixed(2)}</span>
                </div>
                ${
                  combinedSummary.tax > 0 &&
                  html`<div class="row">
                    <span class="k">grocery tax ${(taxRateFor(region) * 100).toFixed(1)}%</span>
                    <span class="status num">$${combinedSummary.tax.toFixed(2)}</span>
                  </div>`
                }
                <div class="row">
                  <span class="k">Total</span>
                  <span class="status num">$${combinedSummary.total.toFixed(2)}</span>
                </div>
                <p class="hint">
                  the whole household's one trip. ${combinedSummary.priced} of ${combined.length}
                  rows priced${
                    combinedSummary.estimates > 0
                      ? `, ${combinedSummary.estimates} are estimates (~)`
                      : ""
                  }${combinedSummary.unpriced > 0 ? " — unpriced rows cost extra on top" : ""}.
                </p>
              </div>
            `
          }
          ${combined.length === 0 && html`<div class="empty">no lists to combine yet</div>`}
        `
      }
    </div>
  `;
}
