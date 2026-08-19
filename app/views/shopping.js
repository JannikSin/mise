import { html } from "htm/preact";
import { Fragment } from "preact";
import { tokenBroken } from "../lib/github.js";
import { useEffect, useRef, useState } from "preact/hooks";
import { krogerPricesById, krogerSearch, scanPhoto, scanReceipt } from "../lib/worker.js";
import {
  allergenHits,
  applyLivePrice,
  confirmPin,
  isStalePrice,
  locationIdFor,
  normalizePins,
  pinFor,
  rankCandidates,
  setPin,
} from "../lib/kroger.js";
import {
  cycleDayPick,
  deriveShoppingList,
  isDatedItem,
  mergeProfileLists,
  packHint,
  pantryItems,
  perishableStatus,
  subtractPantryFromTrip,
  swapCandidates,
  formatStoreQty,
  sectionOf,
  tripOf,
} from "../lib/shopping.js";
import { AISLES } from "../lib/ingredients.js";
import { decodeReceiptLine, shopScore } from "../lib/receipt.js";
import { localIsoDate, parseLocalIso } from "../lib/dates.js";
import { datesOfWeek, SLOT_KEYS, SLOT_META } from "../lib/plan.js";
import {
  itemCost,
  matchPrice,
  rankStores,
  taxRateFor,
  tripTotal,
  storeSlugFromReceipt,
} from "../lib/prices.js";
import { activeProfile } from "../lib/store.js";

/**
 * Food-safety reference (roadmap D3): static, offline, no AI. Fridge rows
 * mirror the shelf-life table that drives auto-expiry and the "good til"
 * dates (app/lib/shopping.js PERISHABLE_SHELF_DAYS) — change one, change
 * the other. Freezer/danger-sign guidance follows USDA/FoodSafety.gov
 * consumer rules.
 */
const FOOD_SAFETY = {
  temps: [
    "fridge at or below 40°F (4°C) · freezer at 0°F (-18°C)",
    "danger zone 40-140°F: max 2 hours out, 1 hour above 90°F",
    "reheat leftovers to 165°F (74°C) · leftovers keep 3-4 days in the fridge",
  ],
  rows: [
    {
      food: "Fish, shrimp, seafood (raw)",
      fridge: "1-3 days",
      freezer: "3-8 months",
      rule: "cook or freeze within 2 days",
    },
    {
      food: "Chicken, turkey, ground meat (raw)",
      fridge: "1-4 days",
      freezer: "3-4 months",
      rule: "cook or freeze within 1-2 days",
    },
    {
      food: "Beef, pork steaks/roasts (raw)",
      fridge: "3-5 days",
      freezer: "4-12 months",
      rule: "",
    },
    {
      food: "Leafy greens, fresh herbs, berries",
      fridge: "3-6 days",
      freezer: "greens/berries freeze OK, herbs in oil",
      rule: "",
    },
    {
      food: "Broccoli, peppers, cucumber, mushrooms, tofu",
      fridge: "5-8 days",
      freezer: "blanch veg first",
      rule: "",
    },
    {
      food: "Milk, yogurt, cottage cheese",
      fridge: "7-10 days after opening",
      freezer: "not recommended",
      rule: "",
    },
    {
      food: "Carrots, cabbage, apples, citrus, potatoes",
      fridge: "2-3 weeks",
      freezer: "—",
      rule: "potatoes/onions prefer a cool pantry",
    },
    {
      food: "Eggs (in shell), hard cheese",
      fridge: "3-5 weeks / 3-4 weeks opened",
      freezer: "eggs out of shell only",
      rule: "",
    },
  ],
  danger: [
    "smell: sour, ammonia, or sulfur = bin it",
    "slime on meat, fish, or deli = bin it",
    "gray/green tint on meat, dull sunken eyes on fish = bin it",
    "mold on soft foods (berries, yogurt, bread, soft cheese) = bin the whole thing; hard cheese can be cut 1 inch around",
    "bulging or hissing cans/jars = bin, never taste",
    "when in doubt, throw it out — no meal is worth 3 days of food poisoning",
  ],
};

/** Catalogue store slug → shopper-facing name. */
const STORE_NAMES = /** @type {Record<string, string>} */ ({
  "trader-joes": "Trader Joe's",
  marianos: "Mariano's",
  "jewel-osco": "Jewel-Osco",
  costco: "Costco",
  aldi: "Aldi",
  "pay-less": "Pay Less",
});

// Default walk order for a US grocery store: produce at the door, freezer and
// household on the way out. A store with a curated aisle map in prices.json
// overrides this per store (see aisleOrderFor).
const SECTION_ORDER = AISLES;

/**
 * The section order to render for a store, and the aisle label to show beside
 * each section header.
 *
 * prices.json may carry `aisles: { <store>: { order, labels } }`, hand-curated
 * once per store, because a store's layout is a stable fact that no chain
 * publishes. Absent = the default walk order and no labels. Anything a curated
 * order forgets still renders after the curated part, so a half-finished aisle
 * map can never hide groceries.
 * @param {Record<string, any> | null} prices
 * @param {string} store
 * @returns {{ order: string[], labels: Record<string, string> }}
 */
function aisleOrderFor(prices, store) {
  const map = prices?.aisles?.[store];
  const curated = Array.isArray(map?.order)
    ? map.order.filter((/** @type {string} */ a) => AISLES.includes(a))
    : [];
  const order = [...curated, ...SECTION_ORDER.filter((a) => !curated.includes(a))];
  return { order, labels: map?.labels ?? {} };
}

/**
 * Fresh-start wizard steps: one photo pass per part of the kitchen. The
 * spice cabinet reuses the "pantry" shelf — its items classify as staples
 * and land in the staples registry, not on a shelf row.
 */
const FRESH_STEPS = [
  { loc: "fridge", label: "the fridge" },
  { loc: "freezer", label: "the freezer" },
  { loc: "pantry", label: "the pantry shelves" },
  { loc: "pantry", label: "the spice cabinet" },
];

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
 *   onBuild: (only?: { dates?: string[], slots?: string[] }) => void,
 *   onToggleItem: (id: string) => void,
 *   onAddManual: (food: string) => void,
 *   onJustBought: () => void,
 *   onToggleLow: (id: string) => void,
 *   onOwnItem: (id: string) => void,
 *   onScanApprove: (items: { name: string, kind: string, qty: string }[], location?: string, mode?: "sweep" | "add") => void,
 *   onGoingShopping: () => void,
 *   others: { profileId: string, name: string, emoji: string, list: import("../lib/shopping.js").ShoppingList, plan?: import("../lib/plan.js").Plan | null }[],
 *   ownEmoji: string,
 *   recipeIndex?: Map<string, any> | null,
 *   myPlan?: import("../lib/plan.js").Plan | null,
 *   allCookExtras?: { cookId: string, buyerId?: string, recipeId: string, date: string, servings: number }[],
 *   tripFromDate?: string,
 *   onCombinedToggle: (itemId: string, sources: { profileId: string, checked: boolean, qty?: number, unit?: string, food?: string, section?: string }[]) => void,
 *   onClaimAllDinners?: (claim: boolean) => number,
 *   dinnerClaims?: { unclaimed: number, mine: number },
 *   onRemoveDinnerRows?: () => void,
 *   shopsPerWeek?: number,
 *   houseShopped?: boolean,
 *   prices?: import("../lib/prices.js").PriceCatalogue | null,
 *   pins?: import("../lib/kroger.js").PinBook | null,
 *   onSavePins?: (next: import("../lib/kroger.js").PinBook) => void,
 *   onSavePrices?: (next: import("../lib/prices.js").PriceCatalogue) => void,
 *   avoid?: string[],
 *   weeklyBudgetUsd?: number,
 *   region?: { country?: string, state?: string },
 *   storeSlug?: string,
 *   onReceiptApprove?: (store: string, lines: { name: string, price: number, size: string }[]) => void,
 *   onClearList?: () => void,
 *   onRemovePantry?: (kind: "staple" | "perishable", key: string) => void,
 *   onEmptyPantry?: (keepStaples: boolean) => Promise<boolean | undefined> | void,
 *   pantryLocations?: string[],
 *   moneyBalances?: { profileId: string, net: number, entries: number, estimate: boolean }[],
 *   profiles?: Record<string, any>[],
 *   onSettle?: (other: string) => void,
 *   substitutions?: { entryId: string, date: string, slot: string, fromId: string, fromName: string, toId: string, toName: string, drops: string[] }[],
 *   onSubstitute?: (swaps: { entryId: string, toId: string }[]) => void
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
  onGoingShopping,
  others,
  ownEmoji,
  recipeIndex = null,
  myPlan = null,
  allCookExtras = [],
  tripFromDate = undefined,
  onCombinedToggle,
  onClaimAllDinners = undefined,
  dinnerClaims = undefined,
  onRemoveDinnerRows = undefined,
  shopsPerWeek = 1,
  houseShopped = false,
  prices = null,
  pins = null,
  onSavePins = undefined,
  onSavePrices = undefined,
  avoid = [],
  weeklyBudgetUsd = undefined,
  region = undefined,
  storeSlug = "",
  onReceiptApprove = undefined,
  onClearList = undefined,
  onRemovePantry = undefined,
  onEmptyPantry = undefined,
  pantryLocations = ["fridge", "freezer", "pantry", "unsorted"],
  moneyBalances = undefined,
  profiles = undefined,
  onSettle = undefined,
  substitutions = [],
  onSubstitute = undefined,
}) {
  const [tab, setTab] = useState(/** @type {"list" | "pantry" | "combined"} */ ("list"));
  const [manual, setManual] = useState("");
  // which shelf the next photo is of. Tagging the shot turns an additive scan
  // into a SWEEP: those photos become the whole truth about that location.
  const [scanLocation, setScanLocation] = useState("fridge");
  // Buying for PART of the week (David, 2026-07-26: guests over, fridge full,
  // still on the plan). Empty = the whole week, which is the default and the
  // old behaviour. The meals stay planned either way; only the shopping is
  // partial, which is why this is not the OUT toggle.
  const [buyDays, setBuyDays] = useState(/** @type {string[]} */ ([]));
  const [buySlots, setBuySlots] = useState(/** @type {string[]} */ ([]));
  const [showPartial, setShowPartial] = useState(false);
  // camera scan: null | "busy" | { error } | { items, kept: boolean[] }
  const [scan, setScan] = useState(/** @type {any} */ (null));
  const fileRef = useRef(/** @type {HTMLInputElement | null} */ (null));
  // FRESH START (David, 2026-08-01: "start from a nothing pantry and scan
  // into the pantry and fridge"): wipe everything, then walk the kitchen one
  // shelf at a time. `fresh` = step index into FRESH_STEPS, null = not
  // running. Wizard scans are ADDITIVE ("add" mode) — the wipe already
  // guaranteed a clean slate, and a big fridge takes more than one photo.
  const [fresh, setFresh] = useState(
    /** @type {number | null} */ (
      (() => {
        // the wipe is irreversible in-app, so the wizard step survives a
        // reload or PWA background-kill instead of stranding a half-scanned
        // kitchen with no prompt (Tribunal L7)
        try {
          const raw = localStorage.getItem("mise.freshStart");
          if (raw == null) return null;
          const n = Number(raw);
          return Number.isInteger(n) && n >= 0 && n < FRESH_STEPS.length ? n : null;
        } catch {
          return null;
        }
      })()
    ),
  );
  const [freshShots, setFreshShots] = useState(0); // photos approved this step
  useEffect(() => {
    try {
      if (fresh == null) localStorage.removeItem("mise.freshStart");
      else localStorage.setItem("mise.freshStart", String(fresh));
    } catch {
      // storage blocked: the step just does not survive a reload
    }
    if (fresh != null) setScanLocation(FRESH_STEPS[fresh]?.loc ?? "pantry");
  }, [fresh]);
  const freshStep = (fresh != null ? FRESH_STEPS[fresh] : null) ?? null;
  // a scan in flight or an unapproved review on screen: advancing now would
  // either retarget the resolving photo at the wrong shelf or silently throw
  // away food the camera already read — from a kitchen that was just wiped
  const scanPending = scan === "busy" || Boolean(scan?.items);
  const advanceFresh = () => {
    if (fresh == null) return;
    if (fresh < FRESH_STEPS.length - 1) {
      const next = fresh + 1;
      setFresh(next);
      setFreshShots(0);
      setScan(null);
      setScanLocation(FRESH_STEPS[next]?.loc ?? "pantry");
    } else {
      setFresh(null);
      setScan({
        notice:
          "kitchen scanned ✓ — now everyone taps GENERATE MY WEEK on Plan, then shop the FAMILY list once",
      });
    }
  };
  const [dinnersNote, setDinnersNote] = useState(/** @type {string} */ (""));
  // receipt scan (price freshness loop): null | "busy" | { error } | { notice }
  //   | { store, lines: [{name, price, size}], kept: bool[] }
  const [receipt, setReceipt] = useState(/** @type {any} */ (null));
  const receiptRef = useRef(/** @type {HTMLInputElement | null} */ (null));
  // Photos of ONE receipt, in order top to bottom. A long till roll does not
  // fit in a frame (David, 2026-08-10), so shots accumulate here and are read
  // together in a single request — see scanReceipt for why reading them
  // separately cannot dedupe the overlap correctly.
  const [shots, setShots] = useState(/** @type {File[]} */ ([]));
  const MAX_SHOTS = 6;

  const onReceiptPicked = (/** @type {{ currentTarget: HTMLInputElement }} */ e) => {
    const picked = [...(e.currentTarget.files ?? [])];
    e.currentTarget.value = "";
    if (picked.length === 0 || receipt === "busy") return;
    setShots((cur) => [...cur, ...picked].slice(0, MAX_SHOTS));
    setReceipt(null);
  };

  const readShots = async () => {
    if (shots.length === 0 || receipt === "busy") return;
    setReceipt("busy");
    try {
      const { store, items: lines } = await scanReceipt(shots);
      if (lines.length === 0) {
        setReceipt({ notice: "no priced lines read — try a flatter, brighter shot" });
        return;
      }
      setShots([]);
      const detected = storeSlugFromReceipt(store, prices?.stores ?? []);
      // decode each till line against THIS WEEK'S LIST before showing it.
      // The abbreviation alone is ambiguous ("BLDMD ALMND" reads as almond
      // milk); the list you were sent to buy from resolves it.
      const expected = (shopping.items ?? []).map((/** @type {any} */ i) => i.food);
      const decoded = lines.map((/** @type {any} */ l) => {
        const d = decodeReceiptLine(l.name, expected);
        return { ...l, name: d.food, till: d.food === l.name ? "" : l.name, guessed: !d.confident };
      });
      setReceipt({
        store: detected ?? storeSlug ?? "",
        lines: decoded,
        kept: decoded.map(() => true),
        editing: null,
      });
    } catch (err) {
      setReceipt({ error: err instanceof Error ? err.message : "receipt scan failed" });
    }
  };

  const approveReceipt = () => {
    if (!receipt?.lines || !receipt.store || !onReceiptApprove) return;
    const chosen = receipt.lines.filter(
      (/** @type {any} */ _l, /** @type {number} */ i) => receipt.kept[i],
    );
    if (chosen.length) onReceiptApprove(receipt.store, chosen);
    setReceipt({
      notice: `${chosen.length} lines applied — those items left the list and are on the shelves now (PANTRY tab)`,
    });
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
  const tokenBlocked = !hasToken || tokenBroken(repo?.auth);
  const items = shopping.items ?? [];
  const checkedCount = items.filter((i) => i.checked).length;

  // fridge-first (David, 2026-08-01): food the kitchen already holds comes
  // off the trip at render time. Only where THIS list IS the trip — a profile
  // alone in its house. With housemates, the FAMILY tab is the trip and the
  // subtraction happens there exactly once: four lists each subtracting the
  // same fridge pack would collectively under-buy.
  // a row someone already TICKED never hides in the covered block, whatever
  // stock arrives mid-trip: it stays visible (and un-tickable back) in its
  // aisle, so "ADD TO PANTRY (n)" always counts rows the shopper can see
  const keepTicked = (
    /** @type {{ toBuy: any[], covered: any[] }} */ trip,
    /** @type {(i: any) => boolean} */ isDone,
  ) => ({
    toBuy: [...trip.toBuy, ...trip.covered.filter(isDone)],
    covered: trip.covered.filter((i) => !isDone(i)),
  });
  const soloTrip =
    others.length === 0
      ? keepTicked(subtractPantryFromTrip(items, pantry), (i) => i.checked)
      : null;
  const tripItems = soloTrip ? soloTrip.toBuy : items;

  // price estimates (prices.json catalogue): chips per row at the profile's
  // own store, trip totals + grocery tax below the list, honest store ranking
  // store to price against: the shopper PICKS it per trip (they might go to
  // Aldi one week, Mariano's the next), defaulting to the profile's usual
  // store but never locked to it. Persisted per profile in localStorage.
  const storeKey = `mise.priceStore.${activeProfile()}`;
  const [pickedStore, setPickedStore] = useState(
    /** @type {string} */ (localStorage.getItem(storeKey) || ""),
  );
  const chooseStore = (/** @type {string} */ s) => {
    setPickedStore(s);
    localStorage.setItem(storeKey, s);
  };
  const allStores = prices?.stores ?? [];
  const ranked = prices ? rankStores(tripItems, prices, region) : [];
  const homeStore =
    (pickedStore && allStores.includes(pickedStore) && pickedStore) ||
    (storeSlug && allStores.includes(storeSlug) && storeSlug) ||
    ranked[0]?.store ||
    "";
  const homeSummary = homeStore ? tripTotal(tripItems, prices, homeStore, region) : null;
  const bestStore = ranked[0] ?? null;
  const todayIso = localIsoDate(new Date());
  // one itemCost per row per render: priceTag, buyHint and the $? gate all
  // ask the same question, and itemCost scans the whole catalogue each time
  // (60 rows × 3 calls on a phone in a store adds up). Keyed on the item
  // OBJECT so combined-trip rows from other profiles can never collide.
  /** @type {WeakMap<object, ReturnType<typeof itemCost>>} */
  const costMemo = new WeakMap();
  const rowCost = (/** @type {any} */ item) => {
    if (!prices || !homeStore) return null;
    if (!costMemo.has(item)) costMemo.set(item, itemCost(item, prices, homeStore));
    return costMemo.get(item) ?? null;
  };
  // STRICT COLUMNS (David 2026-08-19: "literally make columns"): every row
  // reads NEED (the recipes' summation) · BUY (packs × the store's real
  // pack, or the weighed amount) · $/unit · TOTAL, in fixed tracks that
  // repeat identically under a per-trip header. The buy column is always
  // explicit — "×1 avocado but a 4 ct bag" must be visible without a tap.
  const spFor = (/** @type {any} */ item) =>
    prices && homeStore ? matchPrice(item.food, prices.items ?? [])?.prices?.[homeStore] : undefined;
  const buyCell = (/** @type {any} */ item) => {
    if (!prices || !homeStore) return "";
    const c = rowCost(item);
    if (c?.packs && c.size) return `${c.packs} × ${c.size}`;
    if (c?.lbs != null) return `${c.lbs} lb weighed`;
    if (c) return c.size ? `1 × ${c.size}` : "1 pack";
    // unpriced rows fall back to packHint's table guess, which carries its
    // own ≈ so it keeps reading as a guess (ui-review F7)
    return packHint(item.food, item.qty, item.unit, prices, homeStore) || "—";
  };
  const unitCell = (/** @type {any} */ item) => {
    if (!prices || !homeStore) return "";
    const sp = spFor(item);
    if (!sp || rowCost(item) == null) return "—";
    const perLb = String(sp.size ?? "").toLowerCase().includes("per lb");
    // sale = the card price the API returned under promo (applyLivePrice
    // writes it as the effective price and flags the row)
    return `$${sp.price.toFixed(2)}${perLb ? "/lb" : ""}${/** @type {any} */ (sp).sale ? " 🏷" : ""}`;
  };
  const totalCell = (/** @type {any} */ item) => {
    // no catalogue yet (cold/offline open) = quiet cells, exactly as the old
    // price chips behaved; "—" for a row the catalogue can't price — NEVER
    // "$?", which is the action button's name (reviewer catch 2026-08-19)
    if (!prices || !homeStore) return "";
    const c = rowCost(item);
    if (!c) return "—";
    // ~ = estimate; † = a live price past its freshness window (fix list 3.5)
    const stale = isStalePrice(spFor(item), todayIso);
    return `$${c.cost.toFixed(2)}${c.estimate ? "~" : ""}${stale ? " †" : ""}`;
  };
  const colCells = (/** @type {any} */ item) => html`<span class="cols num">
    <span class="c">${formatStoreQty(item.qty, item.unit)}</span>
    <span class="c">${buyCell(item)}</span>
    <span class="c">${unitCell(item)}</span>
    <span class="c">${totalCell(item)}</span>
  </span>`;
  const colHead = () => html`<div class="colhead num">
    <span class="c">NEED</span>
    <span class="c">BUY</span>
    <span class="c">$/UNIT</span>
    <span class="c">TOTAL</span>
  </div>`;

  // ---- live Kroger pricing (fix list Tier 3: pins, refresh, confirm-once) --
  // Only a store with a registered locationId in pins.json gets live
  // features; every other store keeps the plain catalogue behaviour.
  const locId = locationIdFor(pins, homeStore);
  const canLive = Boolean(locId && onSavePins && onSavePrices);
  // null | { item, busy, candidates, error?, confirm? }
  const [pricePick, setPricePick] = useState(/** @type {any} */ (null));
  const [refreshNote, setRefreshNote] = useState("");
  const pinnedForStore = pins
    ? Object.entries(pins.pins).flatMap(([key, byStore]) => {
        const pin = byStore[homeStore];
        return pin ? [{ key, pin }] : [];
      })
    : [];
  const staleCount = (prices?.items ?? []).filter((it) =>
    isStalePrice(/** @type {any} */ (it.prices?.[homeStore]), todayIso),
  ).length;
  const openPricePick = async (/** @type {any} */ item) => {
    if (!canLive) return;
    setPricePick({ item, busy: true, candidates: [] });
    try {
      const products = await krogerSearch(item.food, locId);
      const ranked2 = rankCandidates(
        products,
        item.food,
        pins?.redList ?? [],
        item.section ?? sectionOf(item.food),
        // 3.6: rank by what covering THIS row costs, not per-unit abstractions
        item.qty > 0 ? { qty: item.qty, unit: item.unit } : null,
      );
      setPricePick({ item, busy: false, candidates: ranked2 });
    } catch (err) {
      setPricePick({
        item,
        busy: false,
        candidates: [],
        error: err instanceof Error ? err.message : "search failed",
      });
    }
  };
  // the confirm-once tap on a provisional (auto-picked) pin: show what was
  // picked, confirm it or search for something better
  const openPinConfirm = (/** @type {any} */ item) => {
    const pin = pinFor(pins, item.food, homeStore);
    if (pin) setPricePick({ item, busy: false, candidates: [], confirm: pin });
  };
  const choosePick = (/** @type {any} */ item, /** @type {any} */ product) => {
    if (!canLive || !onSavePins || !onSavePrices || !prices) return;
    onSavePins(setPin(normalizePins(pins), item.food, homeStore, product, todayIso, true));
    onSavePrices(applyLivePrice(prices, homeStore, item.food, product, todayIso));
    setPricePick(null);
  };
  // the weekly refresh (fix list 3.5): re-price every pinned UPC at this
  // store, write through per item with a timestamp. A vanished UPC gets ONE
  // same-food search and the cheapest allergen-clean survivor as a
  // PROVISIONAL re-pin — a form swap by construction (rankCandidates only
  // returns the same food, fix list 3.4); anything dish-changing can only
  // enter through the pick sheet, which is the ask.
  const refreshLivePrices = async () => {
    if (!canLive || !onSavePrices || !prices || pinnedForStore.length === 0) return;
    setRefreshNote("refreshing…");
    try {
      const upcs = pinnedForStore.map((p) => p.pin.upc);
      const { products, failed } = await krogerPricesById(upcs, locId);
      let cat = prices;
      let book = normalizePins(pins);
      let updated = 0;
      let repinned = 0;
      for (const p of products) {
        const hit = pinnedForStore.find((x) => x.pin.upc === p.upc);
        if (!hit || p.price.regular == null) continue;
        cat = applyLivePrice(cat, homeStore, hit.key, p, todayIso);
        updated += 1;
      }
      for (const upc of failed.slice(0, 5)) {
        const hit = pinnedForStore.find((x) => x.pin.upc === upc);
        if (!hit) continue;
        const food = hit.key.replace(/-/g, " ");
        try {
          const alt = rankCandidates(
            await krogerSearch(food, locId),
            food,
            book.redList,
            sectionOf(food),
          ).filter((c) => allergenHits(c, avoid).length === 0)[0];
          if (alt) {
            book = setPin(book, food, homeStore, alt, todayIso, false);
            cat = applyLivePrice(cat, homeStore, food, alt, todayIso);
            repinned += 1;
          }
        } catch {
          // upstream hiccup: the pin stays and renders stale, never silently dropped
        }
      }
      if (cat !== prices) onSavePrices(cat);
      if (repinned > 0 && onSavePins) onSavePins(book);
      const unpriceable = failed.length - repinned;
      setRefreshNote(
        `${updated} refreshed${repinned > 0 ? `, ${repinned} re-pinned (tap ? to confirm)` : ""}${unpriceable > 0 ? `, ${unpriceable} gone from the store` : ""}`,
      );
    } catch (err) {
      setRefreshNote(err instanceof Error ? err.message : "refresh failed");
    }
  };

  // the confirm-once pick sheet (fix list 3.2): search results for one row,
  // cheapest first by UNIT price, allergen-screened on the OUTPUT — a
  // hitting product renders its warning and cannot be pinned (fix list
  // 3.4). Inline tile, never an overlay — rendered directly UNDER the
  // tapped row (David, 2026-08-19: at the bottom of the page it opened
  // three screens below his thumb and read as the button doing nothing).
  const pickSheet = () =>
    pricePick &&
    html`<div class="tile">
      <div class="row">
        <span class="k">${pricePick.confirm ? "confirm product for" : "price"} ${pricePick.item.food} · ${STORE_NAMES[homeStore] ?? homeStore}</span>
        <button class="linktext" onClick=${() => setPricePick(null)}>CLOSE</button>
      </div>
      ${
        pricePick.confirm &&
        html`<div class="row">
            <span class="k">${pricePick.confirm.description} <span class="hint">${pricePick.confirm.size}</span></span>
            <button class="linktext" onClick=${() => { if (onSavePins) onSavePins(confirmPin(normalizePins(pins), pricePick.item.food, homeStore, todayIso)); setPricePick(null); }}>CONFIRM</button>
          </div>
          <p class="hint">
            auto-picked as the cheapest match — confirming keeps it, or${" "}
            <button class="linktext" onClick=${() => openPricePick(pricePick.item)}>search for something better</button>
          </p>`
      }
      ${pricePick.busy && html`<p class="hint">searching the store…</p>`}
      ${pricePick.error && html`<p class="hint">⚠ ${pricePick.error}</p>`}
      ${!pricePick.busy && !pricePick.error && !pricePick.confirm && pricePick.candidates.length === 0 && html`<p class="hint">nothing matched at this store — the row stays honestly unpriced.</p>`}
      ${pricePick.candidates.slice(0, 8).map((/** @type {any} */ c) => {
        const hits = allergenHits(c, avoid);
        return html`<div class="row" key=${c.upc}>
          <span class="k">${c.description} <span class="hint">${c.brand ? `${c.brand} · ` : ""}${c.size}${c.unitLabel ? ` · ${c.unitLabel}` : ""}${c.spend != null && c.spend !== c.price.regular ? ` · covers yours $${c.spend.toFixed(2)}` : ""}${c.aisle ? ` · ${c.aisle}` : ""}${c.price.promo != null ? ` · promo $${c.price.promo.toFixed(2)}` : ""}</span></span>
          ${hits.length > 0 ? html`<span class="status warn">contains ${hits.join(", ")}</span>` : html`<button class="linktext num" onClick=${() => choosePick(pricePick.item, c)}>$${c.price.regular.toFixed(2)} PIN</button>`}
        </div>`;
      })}
      ${!pricePick.confirm && pricePick.candidates.length > 0 && html`<p class="hint">pinning maps ${pricePick.item.food} to this exact product here — priced by UPC from now on, never searched again.</p>`}
    </div>`;

  // the aisle walk order for the store actually being shopped
  const aisles = aisleOrderFor(prices, homeStore);
  const sections = aisles.order
    .map((s) => ({
      section: s,
      label: aisles.labels[s] ?? "",
      items: tripItems.filter((i) => i.section === s),
    }))
    .filter((g) => g.items.length > 0);

  // survey-v2 David-ask #3: split the list into shopping trips when the
  // profile shops more than once a week. One trip = today's single list.
  const trips =
    shopsPerWeek >= 2
      ? [
          {
            key: "pantry",
            label: "Trip · pantry & bulk",
            groups: sections.filter((g) => tripOf(g.section) === "pantry"),
          },
          {
            key: "fresh",
            label: "Trip · fresh",
            groups: sections.filter((g) => tripOf(g.section) === "fresh"),
          },
        ].filter((t) => t.groups.length > 0)
      : [{ key: "all", label: "", groups: sections }];

  // combined household trip: this profile's list + every other profile's,
  // merged read-time (no third artifact to sync)
  const me = activeProfile();
  /** @type {Map<string, string>} */
  const emojiFor = new Map();
  emojiFor.set(me, ownEmoji || "you");
  for (const o of others) emojiFor.set(o.profileId, o.emoji);
  // FAMILY (David, 2026-07-25): the EVERYONE trip became a per-person picker,
  // because you do not always shop for the whole house. Toggled-off people
  // simply drop out of the merge. Persisted per profile, same pattern as the
  // store pick. Absent = everyone on, which is the old behaviour exactly.
  const familyKey = `mise.familyTrip.${me}`;
  const [tripOff, setTripOff] = useState(() => {
    try {
      const raw = localStorage.getItem(familyKey);
      return new Set(raw ? JSON.parse(raw) : []);
    } catch {
      return new Set();
    }
  });
  const toggleTripMember = (/** @type {string} */ id) => {
    const next = new Set(tripOff);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setTripOff(next);
    try {
      localStorage.setItem(familyKey, JSON.stringify([...next]));
    } catch {
      // storage blocked: the toggle just does not persist across reloads
    }
  };
  const tripOthers = others.filter((o) => !tripOff.has(o.profileId));
  // FAMILY days (David, 2026-08-09): buy only SOME days for one member of the
  // EVERYONE trip — mom eats at home the first three days, the rest of the
  // house shops the whole week. Per person, per week (the picks are dates, so
  // a new week starts clean), persisted like the member toggle. Absent/empty
  // = their whole week, which is the old behaviour exactly.
  const daysKey = `mise.familyDays.${me}`;
  const [tripDays, setTripDays] = useState(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(daysKey) ?? "null");
      return /** @type {Record<string, string[]>} */ (
        raw && raw.week === weekId ? (raw.days ?? {}) : {}
      );
    } catch {
      return /** @type {Record<string, string[]>} */ ({});
    }
  });
  const toggleTripDay = (/** @type {string} */ id, /** @type {string} */ d) => {
    // pick math lives in the lib (cycleDayPick) so it is testable; null =
    // no dates for this week (malformed weekId), the tap is ignored
    const nextDays = cycleDayPick(tripDays[id] ?? [], datesOfWeek(weekId), d);
    if (nextDays === null) return;
    const next = { ...tripDays };
    if (nextDays.length === 0) delete next[id];
    else next[id] = nextDays;
    setTripDays(next);
    try {
      localStorage.setItem(daysKey, JSON.stringify({ week: weekId, days: next }));
    } catch {
      // storage blocked: the picks just do not persist across reloads
    }
  };
  // week nav / auto-roll changes weekId under a mounted view: prior-week date
  // picks would match nothing (all chips un-lit, empty contributions), so the
  // picks re-read from storage — which the week guard resolves to {} for any
  // other week — instead of surviving the shift
  useEffect(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(daysKey) ?? "null");
      setTripDays(raw && raw.week === weekId ? (raw.days ?? {}) : {});
    } catch {
      setTripDays({});
    }
    // daysKey covers the active-profile half of the dependency
  }, [weekId, daysKey]);
  // the picker starts open when picks survived a reload, so the narrowed
  // trip is never invisibly narrowed
  const [showTripDays, setShowTripDays] = useState(Object.keys(tripDays).length > 0);
  // A member with picked days contributes a list RE-DERIVED from their plan
  // for just those dates — the same deriveShoppingList `only` path as my own
  // partial build. Their stored list is a week total and carries no dates, so
  // it cannot be filtered; passing it as `previous` keeps their ticks and
  // manual rows. Honest fallbacks, each returning the FULL stored list:
  //  - no plan on file / empty plan (nothing to day-filter);
  //  - recipe index still loading (empty = every derive would drop rows);
  //  - `misses`: a picked-day meal whose recipe this phone cannot resolve
  //    (their personal recipe, or one my diet screen filtered from the pool)
  //    would silently vanish from the trip — refuse to narrow and say so.
  // Claimed family-dinner batches (allCookExtras, buyerId = this member) are
  // appended before deriving, exactly like the canonical build's cookExtras.
  const tripContribFor = (
    /** @type {string} */ id,
    /** @type {any} */ memberPlan,
    /** @type {import("../lib/shopping.js").ShoppingList} */ full,
  ) => {
    const dates = tripDays[id] ?? [];
    if (
      dates.length === 0 ||
      !recipeIndex ||
      recipeIndex.size === 0 ||
      !Array.isArray(memberPlan?.entries) ||
      memberPlan.entries.length === 0
    )
      return { list: full, misses: 0 };
    const extras = (allCookExtras ?? []).filter((x) => x.buyerId === id);
    const planned = { ...memberPlan, entries: [...memberPlan.entries, ...extras] };
    const misses = planned.entries.filter(
      (/** @type {any} */ e) =>
        e.recipeId &&
        dates.includes(e.date) &&
        // an already-eaten day is filtered out of the derive anyway, so an
        // unresolvable recipe there must not veto the narrowing
        (!tripFromDate || e.date >= tripFromDate) &&
        !recipeIndex.has(e.recipeId),
    ).length;
    if (misses > 0) return { list: full, misses };
    return {
      list: deriveShoppingList(planned, recipeIndex, pantry, full, tripFromDate, { dates }),
      misses: 0,
    };
  };
  const combinedMerged =
    tripOthers.length > 0 || tripOff.has(me)
      ? mergeProfileLists([
          ...(tripOff.has(me)
            ? []
            : [{ profileId: me, list: tripContribFor(me, myPlan ?? plan, shopping).list }]),
          ...tripOthers.map((o) => ({
            profileId: o.profileId,
            list: tripContribFor(o.profileId, o.plan, o.list).list,
          })),
        ])
      : others.length > 0
        ? mergeProfileLists([
            { profileId: me, list: tripContribFor(me, myPlan ?? plan, shopping).list },
            ...others.map((o) => ({
              profileId: o.profileId,
              list: tripContribFor(o.profileId, o.plan, o.list).list,
            })),
          ])
        : [];
  // fridge-first for the house: the shared pantry is subtracted from the
  // MERGED trip, exactly once, after everyone's quantities are summed
  const combinedTrip = keepTicked(subtractPantryFromTrip(combinedMerged, pantry), (i) =>
    i.sources.every((/** @type {any} */ s) => s.checked),
  );
  const combined = combinedTrip.toBuy;
  // honest display of what the fridge-first pass took off a trip
  const coveredBlock = (/** @type {any[]} */ covered) =>
    covered.length > 0 &&
    html`<div class="tile" role="note">
      <div class="k">🧊 Already in the kitchen · ${covered.length} — not on this trip</div>
      ${covered.map(
        (i) => html`
          <div class="d num" key=${i.id}>
            ${i.food} — ${formatStoreQty(i.qty, i.unit)} needed, the shelves cover it
          </div>
        `,
      )}
      <p class="hint">
        counted from the PANTRY tab's shelves. If a row there is wrong, fix it and this updates.
      </p>
    </div>`;

  const combinedSections = aisles.order
    .map((s) => ({
      section: s,
      label: aisles.labels[s] ?? "",
      items: combined.filter((i) => i.section === s),
    }))
    .filter((g) => g.items.length > 0);
  const candidates = swapCandidates(combined);
  const sharedCount = combined.filter((i) => i.sources.length > 1).length;

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
        multiple
        style="display:none"
        onChange=${onReceiptPicked}
      />
      ${
        (receipt === null || receipt?.notice || receipt?.error) &&
        html`<button
          class="secondary"
          disabled=${tokenBlocked || shots.length >= MAX_SHOTS}
          onClick=${() => receiptRef.current?.click()}
        >
          ${
            shots.length === 0
              ? "📷 update prices from a receipt"
              : shots.length >= MAX_SHOTS
                ? `📷 ${MAX_SHOTS} photos — that's the limit`
                : "📷 ANOTHER PHOTO further down"
          }
        </button>`
      }
      ${
        // a long receipt takes several overlapping shots: nothing is read
        // until you say so, so the whole strip goes to the model at once
        shots.length > 0 &&
        receipt !== "busy" &&
        html`
          <div class="shotstrip">
            <p class="hint">
              <span class="num">${shots.length}</span>${" "}${
                shots.length === 1 ? "photo" : "photos"
              }
              of this receipt, top to bottom. If the receipt is longer than the frame, take the next
              one so it OVERLAPS a few lines with the last — the overlap is what stops a line being
              counted twice.
            </p>
            <div class="actions">
              <button class="primary" disabled=${tokenBlocked} onClick=${readShots}>
                READ ${shots.length === 1 ? "IT" : `ALL ${shots.length}`}
              </button>
              <button class="secondary" onClick=${() => setShots([])}>START OVER</button>
            </div>
          </div>
        `
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
            <p class="hint">
              tick the lines to save, then apply. Only lines that match a tracked item update. A
              till abbreviation the scan read wrong is EDITABLE — fix the name and the price lands
              on the right food.
            </p>
            <div class="slots">
              ${receipt.lines.map(
                (/** @type {any} */ l, /** @type {number} */ idx) => html`
                  <div class="checkrow ${receipt.kept[idx] ? "picked" : "off"}" key=${idx}>
                    <button
                      class="tickarea"
                      aria-pressed=${receipt.kept[idx]}
                      onClick=${() =>
                        setReceipt({
                          ...receipt,
                          kept: receipt.kept.map(
                            (/** @type {boolean} */ k, /** @type {number} */ j) =>
                              j === idx ? !k : k,
                          ),
                        })}
                    >
                      <span class="box" aria-hidden="true">${receipt.kept[idx] ? "✓" : ""}</span>
                      <span class="food">
                        ${l.name}${l.size ? html` <span class="tag">${l.size}</span>` : ""}
                        ${l.guessed && html` <span class="usesoon">check this</span>`}
                        ${l.till && html`<span class="hint plateline">till read: ${l.till}</span>`}
                      </span>
                      <span class="q num">${Number(l.price).toFixed(2)}</span>
                    </button>
                    <button
                      class="ownbtn"
                      aria-label="Edit ${l.name}"
                      onClick=${() => setReceipt({ ...receipt, editing: idx })}
                    >
                      ✎
                    </button>
                  </div>
                  ${
                    receipt.editing === idx &&
                    html`<div class="tile" key=${`edit-${idx}`}>
                      <div class="k">what was this really?</div>
                      <input
                        aria-label="Item name"
                        value=${l.name}
                        onInput=${(/** @type {any} */ e) =>
                          setReceipt({
                            ...receipt,
                            lines: receipt.lines.map(
                              (/** @type {any} */ x, /** @type {number} */ j) =>
                                j === idx ? { ...x, name: e.currentTarget.value } : x,
                            ),
                          })}
                      />
                      <input
                        aria-label="Price"
                        inputmode="decimal"
                        value=${l.price}
                        onInput=${(/** @type {any} */ e) =>
                          setReceipt({
                            ...receipt,
                            lines: receipt.lines.map(
                              (/** @type {any} */ x, /** @type {number} */ j) =>
                                j === idx ? { ...x, price: Number(e.currentTarget.value) || 0 } : x,
                            ),
                          })}
                      />
                      <div class="actions">
                        <button
                          class="secondary"
                          onClick=${() => setReceipt({ ...receipt, editing: null })}
                        >
                          DONE
                        </button>
                      </div>
                    </div>`
                  }
                `,
              )}
            </div>
            ${
              // "give me a score on how well i did at the store" (David).
              // Same spirit as the adherence score: three plain numbers over
              // what is already known, and the names behind each, so a low
              // score explains itself instead of just accusing.
              (() => {
                const s = shopScore(
                  receipt.lines.filter(
                    (/** @type {any} */ _l, /** @type {number} */ i) => receipt.kept[i],
                  ),
                  shopping.items ?? [],
                );
                if ((shopping.items ?? []).length === 0) return "";
                return html`<div class="tile buildreport" role="status">
                  <div class="k">This trip covered <b>${s.score}%</b> of the list</div>
                  ${
                    s.missed.length > 0 &&
                    html`<div class="d num redflag">
                      still needed:
                      ${s.missed.slice(0, 8).join(" · ")}${s.missed.length > 8 ? " …" : ""}
                    </div>`
                  }
                  ${
                    s.extra.length > 0 &&
                    html`<div class="d num">
                      not on the list:
                      ${s.extra.slice(0, 8).join(" · ")}${s.extra.length > 8 ? " …" : ""}
                    </div>`
                  }
                </div>`;
              })()
            }
            <div class="actions">
              <button
                class="secondary"
                onClick=${() =>
                  setReceipt({
                    ...receipt,
                    lines: [...receipt.lines, { name: "", price: 0, size: "" }],
                    kept: [...receipt.kept, true],
                    editing: receipt.lines.length,
                  })}
              >
                + ADD A LINE THE SCAN MISSED
              </button>
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
            FAMILY ${combined.length ? `(${combined.length})` : ""}
          </button>`
        }
      </div>

      ${
        tab === "list" &&
        others.length > 0 &&
        html`<div class="tile" role="note">
          <div class="k">🛒 The store trip is the FAMILY tab</div>
          <p class="hint">
            This list is just your own meals. FAMILY merges the whole house, subtracts what the
            kitchen already holds, and is the one list to shop from.
          </p>
        </div>`
      }
      ${
        tab === "list" &&
        (moneyBalances ?? []).length > 0 &&
        html`<div class="tile" role="status">
          <div class="k">💰 house money · from shared tables</div>
          ${(moneyBalances ?? []).map((b) => {
            const name = (profiles ?? []).find((p) => p.id === b.profileId)?.name ?? b.profileId;
            return html`<div class="row" key=${b.profileId}>
              <span class="k num">
                ${b.net > 0 ? `${name} owes you` : `you owe ${name}`}
                ${b.estimate ? " ~" : " "}$${Math.abs(b.net).toFixed(2)}
                <small> · ${b.entries} meal${b.entries === 1 ? "" : "s"}</small>
              </span>
              ${
                onSettle &&
                html`<button class="secondary" onClick=${() => onSettle(b.profileId)}>
                  SETTLED
                </button>`
              }
            </div>`;
          })}
          <p class="hint">
            you pay for what you eat: your share of the food is your share of the bill, so two
            thirds of the food means two thirds of the cost, never an automatic even split. Settle
            in the real world (Venmo, cash), then tap SETTLED.
          </p>
        </div>`
      }
      ${
        tab === "list" &&
        html`
          <div class="actions wrap">
            <button
              class="primary"
              onClick=${() =>
                onBuild(
                  buyDays.length > 0 || buySlots.length > 0
                    ? { dates: buyDays, slots: buySlots }
                    : undefined,
                )}
            >
              ${
                buyDays.length > 0 || buySlots.length > 0
                  ? `BUILD FOR ${buyDays.length || 7} ${(buyDays.length || 7) === 1 ? "DAY" : "DAYS"}`
                  : `BUILD FROM W${weekId.split("-W")[1]}`
              }
            </button>
            <button class="secondary" onClick=${() => setShowPartial(!showPartial)}>
              ${showPartial ? "WHOLE WEEK" : "JUST SOME DAYS"}
            </button>
            ${
              checkedCount > 0 &&
              html`<button class="primary" onClick=${onJustBought}>
                ADD TO PANTRY (${checkedCount}) <span aria-hidden="true">→</span>
              </button>`
            }
            <button
              class="secondary lockbtn ${/** @type {any} */ (plan)?.fallback ? "on" : ""}"
              aria-label="Going to the store — save this week's plan as the fallback you can always return to"
              onClick=${onGoingShopping}
            >
              ${/** @type {any} */ (plan)?.fallback ? "🛒 RE-SAVE SHOPPED PLAN" : "🛒 GOING TO THE STORE"}
            </button>
            ${
              items.length > 0 &&
              onClearList &&
              html`<button
                class="secondary"
                aria-label="Clear the whole list, including old ticks and manual items"
                onClick=${onClearList}
              >
                🗑 CLEAR LIST
              </button>`
            }
          </div>
          ${
            showPartial &&
            html`<div class="tile">
              <div class="k">Buy for only part of the week</div>
              <p class="hint">
                The meals stay planned, they just are not bought yet. For the weeks when the fridge
                is already full but you still want to eat to plan.
              </p>
              <div class="chips wrapchips" role="group" aria-label="Days to buy for">
                ${datesOfWeek(weekId).map((d) => {
                  const on = buyDays.includes(d);
                  return html`<button
                    key=${d}
                    class=${on ? "chip on" : "chip"}
                    aria-pressed=${on}
                    onClick=${() =>
                      setBuyDays(on ? buyDays.filter((x) => x !== d) : [...buyDays, d])}
                  >
                    ${parseLocalIso(d).toLocaleDateString([], { weekday: "short" })}
                  </button>`;
                })}
              </div>
              <div class="chips wrapchips" role="group" aria-label="Meals to buy for">
                ${SLOT_KEYS.map((k) => {
                  const on = buySlots.includes(k);
                  return html`<button
                    key=${k}
                    class=${on ? "chip on" : "chip"}
                    aria-pressed=${on}
                    onClick=${() =>
                      setBuySlots(on ? buySlots.filter((x) => x !== k) : [...buySlots, k])}
                  >
                    ${SLOT_META[k]?.full ?? k}
                  </button>`;
                })}
              </div>
              <p class="hint">
                Nothing picked = the whole week. Days alone buys every meal on those days; adding
                meals narrows it further. The weekly buffer snack sits out a partial shop, since it
                is a week-long batch.
              </p>
            </div>`
          }
          <p class="hint lockhint">
            ${
              /** @type {any} */ (plan)?.fallback
                ? html`<strong>Shopped plan saved ✓</strong> — the week stays freely changeable;
                    the Plan tab watches that every bought perishable still gets cooked before it
                    dies, and ↩ can always put the shopped plan back.`
                : html`<strong>Going shopping? Tap 🛒 GOING TO THE STORE first.</strong> It saves
                    this plan as your fallback — the week stays changeable after you buy, and the
                    app tracks that everything perishable still gets used.`
            }
          </p>
          <p class="hint">
            Aggregates the week's plan, drops pantry
            staples${
              soloTrip
                ? " and food already on the kitchen's shelves"
                : " (the FAMILY tab subtracts what the kitchen already holds, once for the house)"
            },
            groups by aisle. Rebuilt lists keep your ticks and manual items. Tick = got it / have
            enough this week. P+ = already own it — moves it to your permanent pantry staples.
          </p>

          ${trips.map(
            (trip) => html`
              <div key=${trip.key}>
                ${trip.label && html`<h2 class="block-title trip-title">${trip.label}</h2>`}
                ${trip.groups.length > 0 && colHead()}
                ${trip.groups.map(
                  (g) => html`
                    <h2 class="block-title" key=${g.section}>
                      ${g.section}${g.label && html` <span class="hint">${g.label}</span>`}
                    </h2>
                    <div class="slots">
                      ${g.items.map(
                        // keyed Fragment: the row + its inline pick sheet are
                        // two roots, and an unkeyed array child would make
                        // Preact diff the list positionally (ui-review
                        // 2026-08-19: P+ removing a row would remount every
                        // row below it)
                        (i) => html`<${Fragment} key=${i.id}>
                          <div class="checkrow listcols ${i.checked ? "done" : ""}">
                            <button
                              class="tickarea"
                              aria-pressed=${i.checked}
                              onClick=${() => onToggleItem(i.id)}
                            >
                              <span class="box" aria-hidden="true">${i.checked ? "✓" : ""}</span>
                              <span class="food"
                                >${i.food}${
                                  i.manual ? html` <span class="tag">manual</span>` : ""
                                }${
                                  /** @type {any} */ (i).kitchenHas
                                    ? html` <span class="tag"
                                        >buy this much — kitchen has the rest</span
                                      >`
                                    : ""
                                }</span
                              >
                            </button>
                            <div class="rowbtns">
                              <button
                                class="ownbtn"
                                aria-label="Already have ${i.food} — move to pantry staples"
                                onClick=${() => onOwnItem(i.id)}
                              >
                                P+
                              </button>
                              ${canLive && !rowCost(i) && html`<button class="ownbtn" aria-label="Find live price for ${i.food}" onClick=${() => openPricePick(i)}>$?</button>`}
                              ${canLive && pinFor(pins, i.food, homeStore)?.provisional && html`<button class="ownbtn" aria-label="Confirm auto-picked product for ${i.food}" onClick=${() => openPinConfirm(i)}>?</button>`}
                            </div>
                            ${colCells(i)}
                          </div>
                          ${pricePick?.item?.id === i.id ? pickSheet() : ""}
                        <//>`,
                      )}
                    </div>
                  `,
                )}
              </div>
            `,
          )}
          ${soloTrip && coveredBlock(soloTrip.covered)}
          ${
            homeSummary &&
            tripItems.length > 0 &&
            html`
              <div class="tile">
                <div class="chips wrapchips" role="group" aria-label="Which store to price against">
                  ${allStores.map(
                    (s) => html`
                      <button
                        class="chip ${homeStore === s ? "on" : ""}"
                        key=${s}
                        aria-pressed=${homeStore === s}
                        onClick=${() => chooseStore(s)}
                      >
                        ${STORE_NAMES[s] ?? s}
                      </button>
                    `,
                  )}
                </div>
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
                  <span class="status num">
                    ${
                      // P5: "Variable-weight items make the estimate a range,
                      // and the app says so. '$48 to $53,' never a
                      // false-precision point." A per-pound row is bought as
                      // whatever the tray weighs, so quoting one number to the
                      // cent was a lie told with a straight face. Only the
                      // variable rows widen it, so a trolley of packaged goods
                      // still quotes exactly.
                      homeSummary.variableRows > 0
                        ? `$${homeSummary.low.toFixed(2)} to $${homeSummary.high.toFixed(2)}`
                        : `$${homeSummary.total.toFixed(2)}`
                    }
                  </span>
                </div>
                ${
                  homeSummary.variableRows > 0 &&
                  html`<div class="row">
                    <span class="k hint">
                      ↳ ${homeSummary.variableRows} row${homeSummary.variableRows === 1 ? " is" : "s are"}
                      sold by weight, so the pack you get decides the cents
                    </span>
                  </div>`
                }
                ${
                  // P5's stocking rule made visible: whole packages are the
                  // TRIP cost; what this week's meals consume is the number
                  // the weekly budget answers to. The rest becomes pantry
                  // stock that later weeks eat for free.
                  homeSummary.eaten > 0 &&
                  homeSummary.eaten < homeSummary.subtotal - 0.5 &&
                  html`<div class="row">
                    <span class="k">↳ eaten this week ≈ $${homeSummary.eaten.toFixed(2)}</span>
                    <span class="status num">$${(homeSummary.subtotal - homeSummary.eaten).toFixed(2)} becomes stock</span>
                  </div>`
                }
                ${
                  typeof weeklyBudgetUsd === "number" &&
                  weeklyBudgetUsd > 0 &&
                  html`<div class="row">
                    <span class="k">weekly budget $${weeklyBudgetUsd.toFixed(0)}</span>
                    <span class="status num ${homeSummary.eaten > weeklyBudgetUsd ? "warn" : ""}"
                      >${homeSummary.eaten > weeklyBudgetUsd ? `eaten share over by $${(homeSummary.eaten - weeklyBudgetUsd).toFixed(2)}` : "eaten share fits ✓"}</span
                    >
                  </div>`
                }
                ${
                  homeSummary.unpriced > 0 &&
                  html`<div class="row">
                    <span class="k status warn"
                      >⚠ ${homeSummary.unpriced} of ${tripItems.length} rows UNPRICED</span
                    >
                    <span class="status warn">total is a floor</span>
                  </div>`
                }
                <p class="hint">
                  ${homeSummary.priced} of ${tripItems.length} rows
                  priced${
                    homeSummary.estimates > 0 ? `, ${homeSummary.estimates} are estimates (~)` : ""
                  }.
                </p>
                ${
                  canLive &&
                  html`<div class="row">
                    <span class="k"
                      >live prices · ${pinnedForStore.length}
                      pinned${staleCount > 0 ? `, ${staleCount} stale (†)` : ""}</span
                    >
                    <button
                      class="linktext"
                      disabled=${pinnedForStore.length === 0 || refreshNote === "refreshing…"}
                      onClick=${refreshLivePrices}
                    >
                      REFRESH
                    </button>
                  </div>`
                }
                ${canLive && refreshNote && html`<p class="hint">${refreshNote}</p>`}
                ${
                  canLive &&
                  homeSummary.unpriced > 0 &&
                  html`<p class="hint">unpriced rows carry a $? button — one search, one tap, priced forever.</p>`
                }
                ${
                  bestStore &&
                  ranked.length > 1 &&
                  (bestStore.store === homeStore
                    ? html`<p class="hint">cheapest well-covered store for this basket ✓</p>`
                    : html`<p class="hint">
                        <button class="linktext" onClick=${() => chooseStore(bestStore.store)}>
                          ${STORE_NAMES[bestStore.store] ?? bestStore.store} is cheaper: est.
                          $${bestStore.summary.total.toFixed(2)} — tap to switch
                        </button>
                      </p>`)
                }
              </div>
            `
          }
          ${
            // fallback placement for the pick sheet: the sheet normally
            // renders directly under its row (David, 2026-08-19: the
            // bottom-of-page tile looked like the ? button did nothing), but
            // if the row left the list mid-pick it still needs a home
            pricePick &&
            !tripItems.some((/** @type {any} */ x) => x.id === pricePick.item.id) &&
            pickSheet()
          }
          ${
            // OUTSIDE the price tile on purpose: applying a receipt empties the
            // list, and that tile only renders while the list has rows — the
            // review panel and its confirmation would vanish under your thumb
            // at the exact moment you pressed APPLY.
            prices && onReceiptApprove && receiptControl()
          }
          ${
            items.length === 0 &&
            html`<div class="empty">
              ${
                tokenBroken(repo?.auth)
                  ? "token needs fixing — Settings"
                  : !hasToken
                    ? "connect token in Settings"
                    : loading
                      ? "loading…"
                      : houseShopped
                        ? "the house has shopped this week ✓ — the receipt cleared this list and the food is on the PANTRY shelves. BUILD only if you add new meals."
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
          ${
            fresh == null
              ? html`<button
                  class="ask scanbtn"
                  disabled=${tokenBlocked || scan === "busy"}
                  onClick=${async () => {
                    const ok = await onEmptyPantry?.(false);
                    if (ok === false) return;
                    setFresh(0);
                    setFreshShots(0);
                    setScan(null);
                    setScanLocation("fridge");
                  }}
                >
                  🧹 START FRESH — rescan the whole kitchen
                  <small>
                    empties every shelf and the staples registry, then walks you through
                    photographing the fridge, freezer, pantry and spice cabinet. What the camera
                    reads becomes the kitchen's truth, and the week's shopping only buys what is not
                    already here.
                  </small>
                </button>`
              : html`<div class="tile scanreview" role="status">
                  <div class="k">
                    FRESH START · ${/** @type {number} */ (fresh) + 1} of ${FRESH_STEPS.length} —
                    ${freshStep?.label}
                  </div>
                  <p class="hint">
                    Photograph ${freshStep?.label}, approve what the camera reads, and take another
                    photo if one shot didn't fit everything. Every photo ADDS here — nothing is
                    replaced. Then NEXT. SKIP records nothing for this shelf, so the list will shop
                    as if it were bare.
                  </p>
                  <div class="actions">
                    <button class="secondary" disabled=${scanPending} onClick=${advanceFresh}>
                      ${
                        fresh < FRESH_STEPS.length - 1
                          ? freshShots > 0
                            ? "NEXT →"
                            : "SKIP →"
                          : "DONE ✓"
                      }
                    </button>
                    <button
                      class="secondary"
                      disabled=${scanPending}
                      onClick=${() => setFresh(null)}
                    >
                      STOP
                    </button>
                  </div>
                  <p class="hint">
                    STOP keeps the wipe and whatever is scanned so far — shelves you haven't
                    photographed stay empty until you scan them from the shelf chips below.
                  </p>
                  ${
                    scanPending &&
                    html`<p class="hint">finish the photo below first — approve or cancel it</p>`
                  }
                </div>`
          }
          <div class="chips wrapchips" role="group" aria-label="Which shelf">
            ${
              // the shelf chips are the VIEW, not just the camera's target
              // (David, 2026-07-26: "the fridge is kind of a thing but not
              // really"). Picking one shows what is on it and points the next
              // photo at it. "unsorted" only appears when rows are actually
              // stranded there, so it never reads as a fifth shelf.
              [
                ...pantryLocations.filter(
                  (l) =>
                    l !== "unsorted" ||
                    pantryItems(pantry)
                      .filter(isDatedItem)
                      .some((/** @type {any} */ p) => (p.location ?? "unsorted") === "unsorted"),
                ),
              ].map((l) => {
                const n = pantryItems(pantry)
                  .filter(isDatedItem)
                  .filter((/** @type {any} */ p) => (p.location ?? "unsorted") === l).length;
                return html`
                  <button
                    key=${l}
                    class=${scanLocation === l ? "chip on" : "chip"}
                    aria-pressed=${scanLocation === l}
                    disabled=${fresh != null}
                    onClick=${() => setScanLocation(l)}
                  >
                    ${l}${n > 0 ? ` (${n})` : ""}
                  </button>
                `;
              })
            }
          </div>
          <button
            class="ask scanbtn"
            onClick=${() => fileRef.current?.click()}
            disabled=${scan === "busy" || tokenBlocked || scanLocation === "unsorted"}
          >
            ${
              scan === "busy"
                ? "READING PHOTO…"
                : `📷 SCAN ${fresh != null ? (freshStep?.label ?? "").toUpperCase() : `THE ${scanLocation.toUpperCase()}`}`
            }
            <small>
              ${
                fresh != null
                  ? `fresh start: every approved photo ADDS to ${freshStep?.label}. Shoot until it is all recorded.`
                  : `these photos become the whole truth about the ${scanLocation}: approving REPLACES what is recorded there. Nothing else is touched.`
              }
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
              ${tokenBroken(repo?.auth) ? "token needs fixing — Settings" : "connect token in Settings"}
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
                        // mid-wizard the STEP owns the target shelf — a chip
                        // tapped while a photo was in flight must not redirect
                        // the fridge's food to the pantry
                        fresh != null ? (freshStep?.loc ?? scanLocation) : scanLocation,
                        fresh != null ? "add" : "sweep",
                      );
                      setScan(null);
                      if (fresh != null) setFreshShots(freshShots + 1);
                    }}
                    disabled=${!scan.kept.some(Boolean)}
                  >
                    ${
                      fresh != null
                        ? `ADD THESE ${scan.kept.filter(Boolean).length} TO THE KITCHEN`
                        : `SET THE ${scanLocation.toUpperCase()} TO THESE ${scan.kept.filter(Boolean).length}`
                    }
                  </button>
                  <button class="secondary" onClick=${() => setScan(null)}>CANCEL</button>
                </div>
              </div>
            `
          }
          <p class="hint">
            ${
              onEmptyPantry &&
              html`<span class="resetpantry">
                <button class="secondary" onClick=${() => onEmptyPantry(true)}>
                  EMPTY PERISHABLES
                </button>
                <button class="secondary" onClick=${() => onEmptyPantry(false)}>
                  EMPTY EVERYTHING
                </button>
              </span>`
            }
            One pantry, no exempt class: tap an item's state to cycle it. PLENTY means the list
            skips it, LOW puts it on the next list, OUT means it gets bought whenever a recipe needs
            it. Food arrives on a shelf when you scan the receipt, tap ADD TO PANTRY, or photograph
            the shelf, and comes off it when you cook the meal.
          </p>
          <h2 class="block-title">Shelf-stable</h2>
          ${(() => {
            const stateRows = pantryItems(pantry).filter((it) => !isDatedItem(it));
            return html`
              ${
                stateRows.length === 0 &&
                html`<div class="empty">
                  nothing asserted yet — they arrive with your seed data
                </div>`
              }
              <div class="slots">
                ${stateRows.map(
                  (/** @type {Record<string, any>} */ s) => html`
                    <div class="checkrow static" key=${s.id}>
                      <span class="food">
                        ${s.food}${s.premium ? html` <span class="tag premium">premium</span>` : ""}
                      </span>
                      <button
                        class="lowbtn ${s.state === "low" ? "on" : ""}"
                        aria-label="Cycle stock state for ${s.food}"
                        onClick=${() => onToggleLow(s.id)}
                      >
                        ${s.state === "low" ? "LOW ✓" : s.state === "plenty" ? "PLENTY" : "OUT"}
                      </button>
                      ${
                        onRemovePantry &&
                        html`<button
                          class="rmbtn"
                          aria-label="Remove ${s.food} from the pantry"
                          onClick=${() => onRemovePantry("staple", s.id)}
                        >
                          ✕
                        </button>`
                      }
                    </div>
                  `,
                )}
              </div>
            `;
          })()}
          ${(() => {
            const shelf = pantryItems(pantry)
              .filter(isDatedItem)
              .filter((/** @type {any} */ p) => (p.location ?? "unsorted") === scanLocation);
            return html`
              <h2 class="block-title">In the ${scanLocation}</h2>
              ${
                shelf.length === 0 &&
                html`<div class="empty">
                  nothing recorded in the ${scanLocation} — food lands here when you scan a receipt,
                  tap ADD TO PANTRY, or photograph the shelf
                </div>`
              }
              <div class="slots">
                ${shelf.map((/** @type {Record<string, any>} */ p, /** @type {number} */ i) => {
                  const { goodUntil, daysLeft } = perishableStatus(p, localIsoDate(new Date()));
                  return html`
                    <div class="checkrow static" key=${p.id ?? i}>
                      <span class="food">
                        ${p.food}${(p.useSoon || (daysLeft != null && daysLeft <= 2)) && html` <span class="usesoon">use soon</span>`}
                      </span>
                      <span class="q num ${daysLeft != null && daysLeft <= 2 ? "expiring" : ""}">
                        ${
                          // how much is LEFT, now that cooking subtracts —
                          // "good til" alone can't tell you whether there is
                          // enough chicken for Thursday
                          p.qty ? `${p.qty} · ` : ""
                        }${
                          goodUntil
                            ? `good til ${parseLocalIso(goodUntil).toLocaleDateString([], { month: "short", day: "numeric" })} · ${daysLeft}d`
                            : "no date"
                        }
                      </span>
                      ${
                        onRemovePantry &&
                        html`<button
                          class="rmbtn"
                          aria-label="Remove ${p.food} from the pantry"
                          onClick=${() => onRemovePantry("perishable", p.id)}
                        >
                          ✕
                        </button>`
                      }
                    </div>
                  `;
                })}
              </div>
            `;
          })()}
          <details class="foodsafety">
            <summary class="block-title">
              🧊 Food safety <span class="hint">shelf lives, danger signs, temps</span>
            </summary>
            <p class="hint">
              These windows drive the pantry's auto-expiry and "good til" dates. Freezer times are
              for quality; frozen food stays safe indefinitely at 0°F.
            </p>
            ${FOOD_SAFETY.temps.map((t) => html`<p class="hint num">🌡 ${t}</p>`)}
            <div class="tablewrap">
              <table class="safetytable">
                <thead>
                  <tr>
                    <th>Food</th>
                    <th>Fridge</th>
                    <th>Freezer</th>
                  </tr>
                </thead>
                <tbody>
                  ${FOOD_SAFETY.rows.map(
                    (r) => html`
                      <tr key=${r.food}>
                        <td>${r.food}${r.rule && html`<div class="hint">${r.rule}</div>`}</td>
                        <td class="num">${r.fridge}</td>
                        <td class="num">${r.freezer}</td>
                      </tr>
                    `,
                  )}
                </tbody>
              </table>
            </div>
            <p class="hint"><strong>Bin it when:</strong></p>
            <ul class="dangerlist">
              ${FOOD_SAFETY.danger.map((d) => html`<li key=${d}>${d}</li>`)}
            </ul>
          </details>
        `
      }
      ${
        tab === "combined" &&
        onClaimAllDinners &&
        html`
          <div class="tile" role="note">
            <div class="k">🛒 Family dinner groceries — who's buying?</div>
            <p class="hint">
              A dinner's ingredients sit on NOBODY's list until someone claims the buy (each dinner
              card on Today has its own I'LL BUY THIS button). Claim them all below and they join
              your own list as normal rows — ticks, receipt, and the who-owes-what ledger all follow
              the buyer.
              ${dinnerClaims ? html`<b>${dinnerClaims.unclaimed}</b> unclaimed · <b>${dinnerClaims.mine}</b> yours.` : ""}
            </p>
            <div class="actions wrap">
              ${
                (dinnerClaims?.unclaimed ?? 0) > 0 &&
                html`<button
                  class="primary"
                  onClick=${() => {
                    const n = onClaimAllDinners(true);
                    setDinnersNote(
                      n > 0
                        ? `you're buying ${n} more dinner${n === 1 ? "" : "s"} ✓ — their groceries just joined your list`
                        : "nothing to claim",
                    );
                  }}
                >
                  🛒 I'M BUYING ALL THE FAMILY DINNERS
                </button>`
              }
              ${
                (dinnerClaims?.mine ?? 0) > 0 &&
                html`<button
                  class="secondary"
                  onClick=${() => {
                    const n = onClaimAllDinners(false);
                    setDinnersNote(
                      n > 0
                        ? `released ${n} dinner claim${n === 1 ? "" : "s"} — those groceries left your list`
                        : "nothing to release",
                    );
                  }}
                >
                  RELEASE MY DINNER CLAIMS
                </button>`
              }
            </div>
            ${dinnersNote && html`<p class="hint" role="status">${dinnersNote}</p>`}
            ${
              // RETIRED manual rows from the pre-claims button: surface the
              // cleanup as long as any survive, they are untrusted by design
              (shopping.items ?? []).some((i) => String(i.id).endsWith("-famdinners")) &&
              onRemoveDinnerRows &&
              html`<p class="hint scanerr" role="status">
                  ⚠ Old manually-added dinner rows are still on your list from before claims existed
                  — they may double-count. Remove them; claimed dinners re-derive cleanly.
                </p>
                <div class="actions">
                  <button class="secondary" onClick=${onRemoveDinnerRows}>
                    REMOVE THE OLD DINNER ROWS
                  </button>
                </div>`
            }
          </div>
        `
      }
      ${
        tab === "combined" &&
        html`
          <div class="chips wrapchips" role="group" aria-label="Who this trip is for">
            ${[{ profileId: me, name: "You", emoji: ownEmoji }, ...others].map((p) => {
              // a narrowed member is visible on the always-shown chip, not
              // only inside the (collapsible) day picker
              const nDays = (tripDays[p.profileId] ?? []).length;
              const badge =
                nDays > 0 && !tripOff.has(p.profileId)
                  ? ` · ${nDays}/${datesOfWeek(weekId).length}d`
                  : "";
              return html`
                <button
                  key=${p.profileId}
                  class=${tripOff.has(p.profileId) ? "chip" : "chip on"}
                  aria-pressed=${!tripOff.has(p.profileId)}
                  onClick=${() => toggleTripMember(p.profileId)}
                >
                  ${p.emoji ?? ""} ${p.name}${badge}
                </button>
              `;
            })}
            ${
              // EVERY profile not in this house is shown greyed with the
              // reason, family field or not (David, 2026-08-02: dad and
              // laurie were simply invisible here while their household was
              // stale, and invisible reads as broken — an explained absence
              // says exactly what to fix in Settings)
              (profiles ?? [])
                .filter((p) => p.id !== me && !others.some((o) => o.profileId === p.id))
                .map(
                  (p) => html`
                    <button
                      key=${p.id}
                      class="chip"
                      disabled
                      title="different house — move them in Settings to shop together"
                    >
                      ${p.emoji ?? ""} ${p.name} · different house
                    </button>
                  `,
                )
            }
          </div>
          ${(() => {
            const dayRows = [
              ...(tripOff.has(me)
                ? []
                : [
                    {
                      profileId: me,
                      name: "You",
                      emoji: ownEmoji,
                      plan: myPlan ?? plan,
                      list: shopping,
                    },
                  ]),
              ...tripOthers,
            ];
            if (dayRows.length === 0) return "";
            const trimmed = dayRows.filter((p) => (tripDays[p.profileId] ?? []).length > 0).length;
            return html`
              <div class="actions wrap">
                <button
                  class="secondary"
                  aria-expanded=${showTripDays}
                  onClick=${() => setShowTripDays(!showTripDays)}
                >
                  ${
                    showTripDays
                      ? "HIDE DAY PICKS"
                      : `JUST SOME DAYS · PER PERSON${trimmed > 0 ? ` · ${trimmed} trimmed` : ""}`
                  }
                </button>
              </div>
              ${
                showTripDays &&
                html`<div class="tile">
                  <div class="k">Buy for only some of someone's days</div>
                  <p class="hint">
                    All days lit = their whole week. Un-light days to leave them out of this trip —
                    their meals stay planned, just not bought yet. Picks are for this week only; a
                    new week starts whole again. To shop NONE of someone's days, toggle them off the
                    trip above.
                  </p>
                  ${dayRows.map((p) => {
                    const picked = tripDays[p.profileId] ?? [];
                    const noPlan =
                      picked.length > 0 &&
                      (!Array.isArray(p.plan?.entries) || p.plan.entries.length === 0);
                    const noRecipes =
                      picked.length > 0 && !noPlan && (!recipeIndex || recipeIndex.size === 0);
                    const misses =
                      picked.length > 0 && !noPlan && !noRecipes
                        ? tripContribFor(p.profileId, p.plan, p.list).misses
                        : 0;
                    return html`
                      <div key=${p.profileId}>
                        <div class="d">${p.emoji ?? ""} ${p.name}</div>
                        <div
                          class="chips wrapchips"
                          role="group"
                          aria-label="Days to buy for ${p.name}"
                        >
                          ${datesOfWeek(weekId).map((d) => {
                            const on = picked.length === 0 || picked.includes(d);
                            return html`<button
                              key=${d}
                              class=${on ? "chip on" : "chip"}
                              aria-pressed=${on}
                              disabled=${on && picked.length === 1}
                              onClick=${() => toggleTripDay(p.profileId, d)}
                            >
                              ${parseLocalIso(d).toLocaleDateString([], { weekday: "short" })}
                            </button>`;
                          })}
                        </div>
                        ${
                          noPlan &&
                          html`<p class="hint scanerr" role="status">
                            ⚠ No meal plan for this week for ${p.name} — their whole list rides
                            along until they generate one.
                          </p>`
                        }
                        ${
                          noRecipes &&
                          html`<p class="hint scanerr" role="status">
                            ⚠ Recipes are still loading — ${p.name}'s day picks apply once they
                            arrive; until then their whole list rides along.
                          </p>`
                        }
                        ${
                          misses > 0 &&
                          html`<p class="hint scanerr" role="status">
                            ⚠ ${misses} of ${p.name}'s picked-day
                            ${misses === 1 ? "meal uses a recipe" : "meals use recipes"} this phone
                            can't see — their whole list rides along instead of narrowing.
                          </p>`
                        }
                      </div>
                    `;
                  })}
                </div>`
              }
            `;
          })()}
          <p class="hint">
            One trip for the whole house. Quantities are everyone's lists summed; the badges show
            who wants it. Tick = bought for everyone who wants it (writes to each person's own
            list). <span class="num">${sharedCount}</span> of${" "}
            <span class="num">${combined.length}</span> items are already shared.
          </p>
          ${
            // SUBSTITUTE (David: "regenerate lists to match each other more").
            // Only ever rewrites MY week: applying a swap to someone else’s
            // plan means writing their plan file from this device, which the
            // Tribunal vetoed, because a recipe arriving that way passes no
            // diet screen on their phone.
            onSubstitute &&
            substitutions.length > 0 &&
            html`
              <div class="tile buildreport" role="note">
                <div class="k">
                  SUBSTITUTE · ${substitutions.length}
                  ${substitutions.length === 1 ? "swap" : "swaps"} to your week would drop
                  ${new Set(substitutions.flatMap((x) => x.drops)).size} single-buyer
                  ${new Set(substitutions.flatMap((x) => x.drops)).size === 1 ? "item" : "items"}
                </div>
                ${substitutions.map(
                  (x) => html`
                    <div class="d num" key=${x.entryId}>
                      ${parseLocalIso(x.date).toLocaleDateString([], { weekday: "short" })}
                      ${x.slot}: ${x.fromName} → ${x.toName}
                      <span class="hint">drops ${x.drops.join(", ")}</span>
                    </div>
                  `,
                )}
                <p class="hint">
                  Only your own week changes. Whole meals are swapped, never ingredients inside a
                  recipe, so the nutrition audit stays intact.
                </p>
                <div class="actions">
                  <button
                    class="secondary"
                    onClick=${() =>
                      onSubstitute(
                        substitutions.map((x) => ({ entryId: x.entryId, toId: x.toId })),
                      )}
                  >
                    APPLY THESE SWAPS
                  </button>
                </div>
              </div>
            `
          }
          ${
            candidates.length > 0 &&
            html`
              <div class="tile buildreport" role="note">
                <div class="k">Could share instead of buying twice</div>
                ${candidates
                  .slice(0, 6)
                  .map(
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
          ${coveredBlock(combinedTrip.covered)}
          ${combinedSections.length > 0 && colHead()}
          ${combinedSections.map(
            (g) => html`
              <h2 class="block-title" key=${g.section}>
                ${g.section}${g.label && html` <span class="hint">${g.label}</span>`}
              </h2>
              <div class="slots">
                ${g.items.map((i) => {
                  const allChecked = i.sources.every((/** @type {any} */ s) => s.checked);
                  const someChecked =
                    !allChecked && i.sources.some((/** @type {any} */ s) => s.checked);
                  const stillNeeds = i.sources
                    .filter((/** @type {any} */ s) => !s.checked)
                    .map((/** @type {any} */ s) => emojiFor.get(s.profileId) ?? "?")
                    .join(" ");
                  return html`
                    <div class="checkrow listcols ${allChecked ? "done" : ""}" key=${i.id}>
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
                            >${i.sources.map((/** @type {any} */ s) => emojiFor.get(s.profileId) ?? "?").join(" ")}</span
                          >
                          ${
                            someChecked && html` <span class="tag">still needs ${stillNeeds}</span>`
                          }${
                            i.kitchenHas
                              ? html` <span class="tag">buy this much — kitchen has the rest</span>`
                              : ""
                          }
                        </span>
                      </button>
                      ${colCells(i)}
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
                  <span class="k">Est. ${STORE_NAMES[homeStore] ?? homeStore} house trip</span>
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
                ${
                  combinedSummary.unpriced > 0 &&
                  html`<div class="row">
                    <span class="k status warn"
                      >⚠ ${combinedSummary.unpriced} of ${combined.length} rows UNPRICED</span
                    >
                    <span class="status warn">total is a floor</span>
                  </div>`
                }
                <p class="hint">
                  the whole house's one trip. ${combinedSummary.priced} of ${combined.length} rows
                  priced${
                    combinedSummary.estimates > 0
                      ? `, ${combinedSummary.estimates} are estimates (~)`
                      : ""
                  }.
                </p>
              </div>
            `
          }
          ${
            // THE receipt button (David, 2026-08-10: his mother stood at the
            // till with the FAMILY list open and there was nothing to press).
            // FAMILY is where the house shops, so FAMILY is where the receipt
            // gets scanned. It was only ever on the personal list, which is
            // the one list that receipt is NOT for.
            prices && onReceiptApprove && receiptControl()
          }
          ${combined.length === 0 && html`<div class="empty">no lists to combine yet</div>`}
        `
      }
    </div>
  `;
}
