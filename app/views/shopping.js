import { html } from "htm/preact";
import { Fragment } from "preact";
import { tokenBroken } from "../lib/github.js";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  krogerCartAdd,
  krogerCartLink,
  krogerLinked,
  krogerPricesById,
  krogerSearch,
  krogerUnlink,
  scanPhoto,
  scanReceipt,
  recordKrogerPush,
  krogerPushLog,
  krogerLinkExpiry,
} from "../lib/worker.js";
import {
  aisleLabelsFromPins,
  allergenHits,
  applyLivePrice,
  confirmPin,
  isStalePrice,
  locationIdFor,
  normalizePins,
  pinFor,
  rankCandidates,
  refreshPinFacts,
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
  plentyKey,
  subtractPantryFromTrip,
  swapCandidates,
  formatStoreQty,
  sectionOf,
  tripOf,
  cartLines,
} from "../lib/shopping.js";
import { AISLES } from "../lib/ingredients.js";
import { decodeReceiptLine, shopScore } from "../lib/receipt.js";
import { localIsoDate, parseLocalIso } from "../lib/dates.js";
import { datesOfWeek, SLOT_KEYS, SLOT_META } from "../lib/plan.js";
import {
  itemCost,
  matchPrice,
  rankStores,
  resolveHomeStore,
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
 * @param {import("../lib/kroger.js").PinBook | null} [pins]
 * @returns {{ order: string[], labels: Record<string, string> }}
 */
function aisleOrderFor(prices, store, pins = null) {
  const map = prices?.aisles?.[store];
  const curated = Array.isArray(map?.order)
    ? map.order.filter((/** @type {string} */ a) => AISLES.includes(a))
    : [];
  const order = [...curated, ...SECTION_ORDER.filter((a) => !curated.includes(a))];
  // The store's own answer fills every section a human never curated
  // (David, 2026-08-22: "know where it is, don't discard the answer"). A
  // hand-curated label still WINS, because someone stood in the shop; the
  // derived one only fills gaps, so curating never gets overwritten by data.
  const derived = aisleLabelsFromPins(pins, store);
  return { order, labels: { ...derived, ...(map?.labels ?? {}) } };
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
 *   brigade?: { id: string, name: string, iShop: boolean, nights: number, seats: number, shopperName: string, buildWeek: string | null, rangeLabel: string, weekNote: string | null } | null,
 *   onBuildWeek?: (week: string) => void,
 *   repriceNote?: string,
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
  brigade = null,
  onBuildWeek = undefined,
  repriceNote = "",
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
  // typed pantry add (David 2026-08-29: "I can just type in things" — a
  // mis-scanned item should never mean re-shooting the shelf until the
  // camera gets it right). Same applyScanItems path as an approved scan.
  const [pantryTyped, setPantryTyped] = useState("");
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
          "kitchen scanned ✓ — now everyone taps GENERATE MY WEEK on Plan, then shop the HOUSEHOLD list once",
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
  // off the trip at render time. Only where THIS list IS the trip — a
  // profile alone in its house, or the BRIGADE'S SHOPPER, whose list is the
  // whole kitchen's one buy (hiding the HOUSEHOLD tab under a brigade
  // removed the only other subtraction site — Tribunal Engineer,
  // 2026-08-30). A non-brigade housemate's list is a portion of the merged
  // HOUSEHOLD trip, and the subtraction happens there exactly once: four
  // lists each subtracting the same fridge pack would collectively under-buy.
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
    others.length === 0 || brigade?.iShop
      ? keepTicked(subtractPantryFromTrip(items, pantry), (i) => i.checked)
      : null;
  const tripItems = soloTrip ? soloTrip.toBuy : items;

  // price estimates (prices.json catalogue): chips per row at the profile's
  // own store, trip totals + grocery tax below the list, honest store ranking
  // store to price against: the shopper PICKS it per trip (they might go to
  // Aldi one week, Mariano's the next), defaulting to the profile's usual
  // store but never locked to it. Persisted per profile in localStorage.
  // THE DEFAULT STORE IS THE PROFILE'S DECLARED ONE (targets.stores[0]),
  // never "whichever catalogue is arithmetically cheapest": with no stores
  // declared, ranked[0] silently priced David's West Lafayette week at
  // Mariano's Vernon Hills, 120 miles away (Tribunal, 2026-08-30). A tapped
  // chip still wins per trip — but a tap made BEFORE the profile declared
  // its store (the ranked[0] era) must not outrank the declaration forever.
  // `declKey` stamps which declaration the pick was made under; the shared
  // resolveHomeStore chain IGNORES (never deletes) a pick whose stamp does
  // not match the current declaration — non-destructive, because the old
  // clear-on-mismatch ran in the first render, when prices/targets are
  // still null, and wiped deliberate picks (Tribunal Realist, 2026-08-30).
  const storeKey = `mise.priceStore.${activeProfile()}`;
  const declKey = `mise.priceStoreDecl.${activeProfile()}`;
  const allStores = prices?.stores ?? [];
  const declaredStore = storeSlug && allStores.includes(storeSlug) ? storeSlug : "";
  const [pickedStore, setPickedStore] = useState(/** @type {string} */ (
    (() => {
      try {
        return localStorage.getItem(storeKey) || "";
      } catch {
        return "";
      }
    })()
  ));
  const [pickedDecl, setPickedDecl] = useState(/** @type {string} */ (
    (() => {
      try {
        return localStorage.getItem(declKey) || "";
      } catch {
        return "";
      }
    })()
  ));
  const chooseStore = (/** @type {string} */ s) => {
    setPickedStore(s);
    setPickedDecl(declaredStore);
    try {
      localStorage.setItem(storeKey, s);
      localStorage.setItem(declKey, declaredStore);
    } catch {
      // storage refused: the pick still applies for this render
    }
  };
  // ranked survives solely as the last-resort homeStore fallback for
  // profiles that declare no store (the cheaper-store nudge is DELETED,
  // 2026-08-30: rankStores keeps only maximally-covered stores, so with
  // real coverage it compared nothing and nagged toward a store 120 miles
  // away). Memoized — it walks the whole catalogue per store.
  const ranked = useMemo(
    () => (prices ? rankStores(tripItems, prices, region) : []),
    [prices, tripItems, region],
  );
  const homeStore = resolveHomeStore({
    picked: pickedStore,
    pickedDecl,
    declared: declaredStore,
    stores: allStores,
    fallback: ranked[0]?.store ?? "",
  });
  const homeSummary = homeStore ? tripTotal(tripItems, prices, homeStore, region) : null;
  // per-store coverage for the chip labels ("aldi · 12/92 priced") — one
  // tripTotal per store per LIST, not per render (Tribunal: 6 stores × 92
  // rows on every checkbox tap measured ~45ms on desktop, several times
  // that on a phone in a store)
  const storeCoverage = useMemo(() => {
    /** @type {Map<string, number>} */
    const cov = new Map();
    if (prices) for (const s of allStores) cov.set(s, tripTotal(tripItems, prices, s, region).priced);
    return cov;
  }, [prices, tripItems, region, allStores]);
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
    prices && homeStore
      ? matchPrice(item.food, prices.items ?? [])?.prices?.[homeStore]
      : undefined;
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
    const perLb = String(sp.size ?? "")
      .toLowerCase()
      .includes("per lb");
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
  const colCells = (/** @type {any} */ item) =>
    html`<span class="cols num">
      <span class="c">${formatStoreQty(item.qty, item.unit)}</span>
      <span class="c">${buyCell(item)}</span>
      <span class="c">${unitCell(item)}</span>
      <span class="c">${totalCell(item)}</span>
    </span>`;
  const colHead = () =>
    html`<div class="colhead num">
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
  // rows priced by an auto-picked (provisional) pin: reviewed from ONE line
  // in the price tile, not a per-row "?" scattered down 79 rows
  const provisionalRows = canLive
    ? tripItems.filter((i) => pinFor(pins, i.food, homeStore)?.provisional)
    : [];
  const staleCount = (prices?.items ?? []).filter((it) =>
    isStalePrice(/** @type {any} */ (it.prices?.[homeStore]), todayIso),
  ).length;
  const openPricePick = async (/** @type {any} */ item, fromTile = false) => {
    if (!canLive) return;
    // fromTile rides through every state transition: dropping it mid-search
    // teleported the sheet from the tile down under the row (the exact
    // complaint fromTile exists to prevent — Tribunal Engineer, 2026-08-30)
    setPricePick({ item, busy: true, candidates: [], fromTile });
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
      setPricePick({ item, busy: false, candidates: ranked2, fromTile });
    } catch (err) {
      setPricePick({
        item,
        busy: false,
        candidates: [],
        error: err instanceof Error ? err.message : "search failed",
        fromTile,
      });
    }
  };
  // the confirm-once tap on a provisional (auto-picked) pin: show what was
  // picked, confirm it or search for something better
  const openPinConfirm = (/** @type {any} */ item, fromTile = false) => {
    const pin = pinFor(pins, item.food, homeStore);
    // fromTile: opened from the price tile's REVIEW line, so the sheet
    // renders right there under the tapped button, never three screens down
    // under the row (David, 2026-08-19)
    if (pin) setPricePick({ item, busy: false, candidates: [], confirm: pin, fromTile });
  };
  // from the tile's REVIEW queue, finishing one row auto-advances to the
  // next auto-picked one — 12 provisional pins must not cost 12 separate
  // REVIEW taps through a 92-row re-render (Tribunal, 2026-08-30)
  const advanceOrClose = (/** @type {any} */ finishedItem) => {
    if (pricePick?.fromTile) {
      const next = provisionalRows.find((r) => r.id !== finishedItem.id);
      if (next) {
        openPinConfirm(next, true);
        return;
      }
    }
    setPricePick(null);
  };
  const choosePick = (/** @type {any} */ item, /** @type {any} */ product) => {
    if (!canLive || !onSavePins || !onSavePrices || !prices) return;
    onSavePins(setPin(normalizePins(pins), item.food, homeStore, product, todayIso, true));
    onSavePrices(applyLivePrice(prices, homeStore, item.food, product, todayIso));
    advanceOrClose(item);
  };
  // the weekly refresh (fix list 3.5): re-price every pinned UPC at this
  // store, write through per item with a timestamp. A vanished UPC gets ONE
  // same-food search and the cheapest allergen-clean survivor as a
  // PROVISIONAL re-pin — a form swap by construction (rankCandidates only
  // returns the same food, fix list 3.4); anything dish-changing can only
  // enter through the pick sheet, which is the ask.
  // ---- Kroger cart push (David, 2026-08-22) --------------------------------
  // Mise builds the list; Kroger's own app does checkout. There is NO order
  // placement and NO pickup-slot endpoint in the public API at any tier, so
  // this hands off and never claims to have ordered anything.
  const [cartNote, setCartNote] = useState("");
  const [cartOff, setCartOff] = useState(false);
  // THE SEVEN BROCCOLIS (David, 2026-08-24: "last time I ended up with like
  // seven things of frozen broccoli"). Kroger's cart endpoint is ADD-ONLY and
  // ADDITIVE, with no read-back at the public tier -- the same push twice puts
  // the food in twice. Nothing here stopped a second tap: no disabled state,
  // no sent flag, no confirm. A slow response on store wifi, an impatient
  // second tap, or simply opening the list again later all stacked another
  // full copy of the week into the cart, silently.
  //
  // So a send is now a one-time act that has to be explicitly re-armed. The
  // count is what makes it legible: he can SEE it is about to go in twice.
  const [cartSent, setCartSent] = useState(0);
  const [pushLog, setPushLog] = useState(/** @type {any[]} */ ([]));
  useEffect(() => setPushLog(krogerPushLog()), []);
  const [cartArmed, setCartArmed] = useState(false);
  // rows we can actually send: a UPC only exists once a food is pinned here
  //
  // TWO BUGS LIVED IN THE ONE LINE THIS REPLACES (David, 2026-08-24: "last
  // time I ended up with like seven things of frozen broccoli"):
  //
  //  1. NO DEDUPE BY UPC. Several rows legitimately pin to the SAME product --
  //     a week's broccoli arrives from a stir-fry, a steam-fry and a bowl, and
  //     the list keeps them as separate foods. Each sent its own
  //     `{upc, quantity: 1}` line and **Kroger SUMS duplicate UPCs**, so seven
  //     rows became seven bags. That is the reported bug, exactly.
  //  2. QUANTITY WAS HARD-CODED TO 1. A row needing 900 g of broccoli against
  //     a 12 oz bag ordered one bag: a quarter of the need. The two bugs
  //     pulled in opposite directions, which is why neither showed up as a
  //     simple "too much" or "too little" and both survived.
  //
  // Both are answered by the pack count `itemCost` ALREADY computes for the
  // budget line. Using it here means the number that PRICES a row is the same
  // number that ORDERS it, so the cart and the week's total cannot drift apart.
  // An unpriced row still falls back to one package, which is the old
  // behaviour and is flagged to the user as an estimate elsewhere.
  const cartRows = cartLines(
    tripItems,
    (food) => pinFor(pins, food, homeStore)?.upc,
    (i) => itemCost(i, prices, homeStore)?.packs,
  );

  // A THREE-ITEM TEST PUSH (David, 2026-08-24: "push a few things onto the
  // payless cart so that i can check to see them... just a few test items and
  // tell me the quantities as well ... and the price").
  //
  // Kroger's cart API is add-only with NO read-back, so the only way to know a
  // push landed -- with the right products, at the right counts -- is for a
  // human to open the Kroger app and look. Committing a whole week's groceries
  // to find that out is an expensive way to run a test, and undoing it means
  // deleting ~40 lines by hand. Three rows proves the same pipeline: auth,
  // UPC match, quantity, store selection.
  //
  // The three cheapest rows on purpose: if the store selection turns out to be
  // wrong, the mistake is a few dollars, not a week of food.
  const testRows = [...cartRows]
    .sort((a, b) => a.quantity - b.quantity)
    .slice(0, 3)
    .map((r) => ({ ...r, quantity: 1 }));

  const sendToKrogerCart = async (/** @type {{ test?: boolean }} */ opts = {}) => {
    const rows = opts.test === true ? testRows : cartRows;
    if (rows.length === 0) return;
    // a test push is small and repeatable by design, so it skips the re-arm
    // that protects the full list
    if (opts.test !== true && cartSent > 0 && !cartArmed) {
      setCartArmed(true);
      setCartNote(
        `already sent ${cartSent} time${cartSent === 1 ? "" : "s"} — sending again ADDS another copy to your Kroger cart. Tap once more only if you really want doubles.`,
      );
      return;
    }
    setCartArmed(false);
    setCartNote("sending…");
    try {
      if (!krogerLinked()) {
        setCartNote("opening Kroger to sign in…");
        location.href = await krogerCartLink();
        return;
      }
      const sent = await krogerCartAdd(rows);
      if (opts.test !== true) setCartSent((n) => n + 1);
      recordKrogerPush({
        ok: true,
        rows,
        test: opts.test === true,
        store: homeStore,
        message: `Kroger accepted ${sent} row${sent === 1 ? "" : "s"}`,
      });
      setPushLog(krogerPushLog());
      // "sent", never "added": the public tier is add-only with no read-back,
      // so an HTTP 200 is the ONLY evidence there is. Overclaiming here is
      // how a missing item becomes a surprise at the pickup counter.
      setCartNote(
        `sent ${sent} row${sent === 1 ? "" : "s"} to your Kroger cart — open the Pay Less app to check it and place the order`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "that did not work";
      recordKrogerPush({
        ok: false,
        rows,
        test: opts.test === true,
        store: homeStore,
        message: msg,
      });
      setPushLog(krogerPushLog());
      if (/not set up yet/.test(msg)) {
        setCartOff(true);
        setCartNote("");
        return;
      }
      if (/link expired|not linked/.test(msg)) {
        krogerUnlink();
        setCartNote("that link expired — tap again to sign in to Kroger");
        return;
      }
      setCartNote(msg);
    }
  };

  const refreshLivePrices = async () => {
    if (!canLive || !onSavePrices || !prices || pinnedForStore.length === 0) return;
    setRefreshNote("refreshing…");
    try {
      const upcs = pinnedForStore.map((p) => p.pin.upc);
      const { products, failed, requested } = await krogerPricesById(upcs, locId);
      let cat = prices;
      const book0 = normalizePins(pins);
      let book = book0;
      let updated = 0;
      let repinned = 0;
      for (const p of products) {
        const hit = pinnedForStore.find((x) => x.pin.upc === p.upc);
        if (!hit) continue;
        // the store's aisle, brand and pack size ride along on the same
        // payload as the price; spending it on price alone is what left 89
        // Pay Less pins with no aisle. Runs even when the price is missing,
        // because knowing where a thing sits is useful without a price.
        book = refreshPinFacts(book, hit.key, homeStore, p, todayIso);
        if (p.price.regular == null) continue;
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
      // book changes on a re-pin OR on a store-facts backfill, so compare
      // against the book we STARTED with (normalizePins returns a fresh
      // object every call, so comparing to a new one is always true). Was
      // `repinned > 0`, which is why a backfill would never have been saved.
      if (book !== book0 && onSavePins) onSavePins(book);
      const unpriceable = failed.length - repinned;
      // the worker processes at most 60 UPCs per call and now SAYS so —
      // without this line 29 of David's 89 pins silently read as refreshed
      const beyondCap = Math.max(0, upcs.length - requested);
      setRefreshNote(
        `${updated} refreshed${repinned > 0 ? `, ${repinned} re-pinned (tap REVIEW to confirm)` : ""}${unpriceable > 0 ? `, ${unpriceable} gone from the store` : ""}${beyondCap > 0 ? `, ${beyondCap} over this call's cap — tap REFRESH again` : ""}`,
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
        <span class="k"
          >${pricePick.confirm ? "confirm product for" : "price"} ${pricePick.item.food} ·
          ${STORE_NAMES[homeStore] ?? homeStore}</span
        >
        <button class="linktext" onClick=${() => setPricePick(null)}>CLOSE</button>
      </div>
      ${
        pricePick.confirm &&
        html`<div class="row">
            <span class="k"
              >${pricePick.confirm.description}
              <span class="hint">${pricePick.confirm.size}</span></span
            >
            <button
              class="linktext"
              onClick=${() => {
                if (onSavePins)
                  onSavePins(
                    confirmPin(normalizePins(pins), pricePick.item.food, homeStore, todayIso),
                  );
                advanceOrClose(pricePick.item);
              }}
            >
              CONFIRM
            </button>
          </div>
          <p class="hint">
            auto-picked as the cheapest match — confirming keeps it, or${" "}
            <button
              class="linktext"
              onClick=${() => openPricePick(pricePick.item, pricePick.fromTile)}
            >
              search for something better
            </button>
          </p>`
      }
      ${pricePick.busy && html`<p class="hint">searching the store…</p>`}
      ${pricePick.error && html`<p class="hint">⚠ ${pricePick.error}</p>`}
      ${!pricePick.busy && !pricePick.error && !pricePick.confirm && pricePick.candidates.length === 0 && html`<p class="hint">nothing matched at this store — the row stays honestly unpriced.</p>`}
      ${pricePick.candidates.slice(0, 8).map((/** @type {any} */ c) => {
        const hits = allergenHits(c, avoid);
        return html`<div class="row" key=${c.upc}>
          <span class="k"
            >${c.description}
            <span class="hint"
              >${c.brand ? `${c.brand} · ` : ""}${c.size}${c.unitLabel ? ` · ${c.unitLabel}` : ""}${c.spend != null && c.spend !== c.price.regular ? ` · covers yours $${c.spend.toFixed(2)}` : ""}${c.aisle ? ` · ${c.aisle}` : ""}${c.price.promo != null ? ` · promo $${c.price.promo.toFixed(2)}` : ""}</span
            ></span
          >
          ${hits.length > 0 ? html`<span class="status warn">contains ${hits.join(", ")}</span>` : html`<button class="linktext num" onClick=${() => choosePick(pricePick.item, c)}>$${c.price.regular.toFixed(2)} PIN</button>`}
        </div>`;
      })}
      ${!pricePick.confirm && pricePick.candidates.length > 0 && html`<p class="hint">pinning maps ${pricePick.item.food} to this exact product here — priced by UPC from now on, never searched again.</p>`}
    </div>`;

  // the aisle walk order for the store actually being shopped
  const aisles = aisleOrderFor(prices, homeStore, pins);
  const sections = aisles.order
    .map((s) => ({
      section: s,
      label: aisles.labels[s] ?? "",
      items: tripItems.filter((i) => i.section === s),
    }))
    .filter((g) => g.items.length > 0);

  // render-level grouping (list audit 2026-08-30): "banana" and "bananas",
  // mango in grams and mango in cups, are ONE food to a person in an aisle.
  // The data rows stay separate (ids, ticks, prices, cart quantities are all
  // per-row) — only the RENDER combines them: one line, one tick that ticks
  // every member.
  const rowGroups = (/** @type {any[]} */ items) => {
    /** @type {Map<string, any[]>} */
    const byKey = new Map();
    for (const i of items) {
      const k = plentyKey(i.food);
      const arr = byKey.get(k);
      if (arr) arr.push(i);
      else byKey.set(k, [i]);
    }
    return [...byKey.values()];
  };
  const toggleGroup = (/** @type {any[]} */ members) => {
    const allDone = members.every((m) => m.checked);
    // ticking a group means "got it": tick only the unticked; unticking a
    // fully ticked group unticks all. onToggleItem reads the live ref, so
    // sequential calls compose.
    for (const m of members) {
      if (allDone || !m.checked) onToggleItem(m.id);
    }
  };
  const groupCells = (/** @type {any[]} */ members) => {
    const costs = members.map((m) => rowCost(m));
    const priced = costs.filter((c) => c != null);
    const total =
      priced.length === 0
        ? "—"
        : `$${priced.reduce((s, c) => s + (c?.cost ?? 0), 0).toFixed(2)}${priced.some((c) => c?.estimate) || priced.length < members.length ? "~" : ""}`;
    // members priced off the SAME catalogue row share one unit price — show
    // it; only genuinely divergent members earn the dash
    const units = new Set(members.map((m) => unitCell(m)).filter((u) => u && u !== "—"));
    return html`<span class="cols num">
      <span class="c">${members.map((m) => formatStoreQty(m.qty, m.unit)).join(" + ")}</span>
      <span class="c">${members.map((m) => buyCell(m) || "—").join(" + ")}</span>
      <span class="c">${units.size === 1 ? [...units][0] : "—"}</span>
      <span class="c">${total}</span>
    </span>`;
  };

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

  // THE PRICE TILE, one definition, two placements: legacy surfaces keep
  // it under the rows; the brigade surface hoists it to the TOP, because a
  // 79-row list put the total and the store switcher ten phone-screens
  // down (Tribunal, 2026-08-30).
  const priceTileBlock = () => {
    // pre-build (Tribunal Realist, 2026-08-30): before the first BUILD the
    // list is empty and the full tile has nothing to total, but the brigade
    // shopper still must be able to SEE and switch the pricing store before
    // committing the build — a slim chips-only tile carries that
    if (tripItems.length === 0 && brigade?.iShop && homeStore && allStores.length > 0) {
      return html`<div class="tile">
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
        <p class="hint">
          Prices come from ${STORE_NAMES[homeStore] ?? homeStore}. BUILD prices the week here
          automatically.
        </p>
      </div>`;
    }
    return (
      homeSummary &&
                tripItems.length > 0 &&
                html`
                  <div class="tile">
                    <div class="chips wrapchips" role="group" aria-label="Which store to price against">
                      ${allStores.map(
                        // coverage on the chip: switching stores is only an
                        // honest choice when you can SEE that aldi prices 11
                        // of 79 rows before you tap it (storeCoverage is the
                        // memo — never recompute here)
                        (s) => html`
                          <button
                            class="chip ${homeStore === s ? "on" : ""}"
                            key=${s}
                            aria-pressed=${homeStore === s}
                            onClick=${() => chooseStore(s)}
                          >
                            ${STORE_NAMES[s] ?? s} · ${storeCoverage.get(s) ?? 0}/${tripItems.length}
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
                          ↳ ${homeSummary.variableRows}
                          row${homeSummary.variableRows === 1 ? " is" : "s are"} sold by weight, so the
                          pack you get decides the cents
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
                        <span class="status num"
                          >$${(homeSummary.subtotal - homeSummary.eaten).toFixed(2)} becomes stock</span
                        >
                      </div>`
                    }
                    ${
                      typeof weeklyBudgetUsd === "number" &&
                      weeklyBudgetUsd > 0 &&
                      (() => {
                        // a brigade trip feeds every seat, but weeklyBudgetUsd
                        // is MY number — judging the whole kitchen's eaten
                        // total against one person's budget read "over by $35"
                        // on a two-person week that was fine (David,
                        // 2026-08-30). The even split is the honest headline
                        // here; exact who-ate-what money lives in house money.
                        const seats =
                          brigade?.iShop && (brigade.seats ?? 1) > 1 ? /** @type {number} */ (brigade.seats) : 1;
                        const share = homeSummary.eaten / seats;
                        const label = seats > 1 ? `your ≈1/${seats} eaten share` : "eaten share";
                        return html`<div class="row">
                          <span class="k"
                            >weekly budget $${weeklyBudgetUsd.toFixed(0)}${seats > 1 ? " (yours)" : ""}</span
                          >
                          <span class="status num ${share > weeklyBudgetUsd ? "warn" : ""}"
                            >${share > weeklyBudgetUsd ? `${label} over by $${(share - weeklyBudgetUsd).toFixed(2)}` : `${label} ≈ $${share.toFixed(2)} fits ✓`}</span
                          >
                        </div>`;
                      })()
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
                    ${canLive && repriceNote && html`<p class="hint">${repriceNote}</p>`}
                    ${
                      canLive &&
                      provisionalRows.length > 0 &&
                      html`<div class="row">
                        <span class="k"
                          >${provisionalRows.length} price${provisionalRows.length === 1 ? "" : "s"} auto-picked</span
                        >
                        <button
                          class="linktext"
                          onClick=${() => openPinConfirm(provisionalRows[0], true)}
                        >
                          REVIEW
                        </button>
                      </div>`
                    }
                    ${pricePick?.fromTile ? pickSheet() : ""}
                    ${
                      // NO FEATURE SHIPS DARK, and this one did (David,
                      // 2026-08-25: "it said not linked and push failed"). The
                      // Worker was missing KROGER_STATE_SECRET and
                      // KROGER_REDIRECT_URI, so /kroger/cart/link answered 503
                      // every time and no link could ever be made. The app's
                      // response to that 503 was to HIDE the whole cart block,
                      // which turned a server misconfiguration into a blank space
                      // — the worst possible way to report it, and why he was left
                      // guessing. Say it out loud instead.
                      canLive &&
                      cartOff &&
                      html`<p class="hint">
                        ⚠️ Cart push is switched off on the server, so nothing can be sent yet. This is
                        a configuration gap, not something you did wrong.
                      </p>`
                    }
                    ${
                      canLive &&
                      !cartOff &&
                      html`<div class="row">
                          <span class="k"
                            >kroger cart · ${cartRows.length} of ${tripItems.length} rows have a
                            UPC</span
                          >
                          <button
                            class="linktext"
                            disabled=${cartRows.length === 0 || cartNote === "sending…"}
                            onClick=${() => sendToKrogerCart()}
                          >
                            ${krogerLinked() ? "SEND TO CART" : "LINK KROGER"}
                          </button>
                        </div>
                        <p class="hint">
                          Sends the unticked rows to your Kroger cart for
                          ${" "}${STORE_NAMES[homeStore] ?? homeStore}. It cannot place the order and
                          cannot choose a pickup slot — no Kroger API does — so you finish in the app.
                          ⚠️ Kroger has no store field on a cart write: items land in whichever store
                          your Kroger ACCOUNT has selected, so set that to
                          ${" "}${STORE_NAMES[homeStore] ?? homeStore} first.
                        </p>
                        ${
                          testRows.length > 0 &&
                          html`<div class="row">
                              <span class="k"
                                >test it first · ${testRows.length} cheap rows, 1 each</span
                              >
                              <button
                                class="linktext"
                                disabled=${cartNote === "sending…"}
                                onClick=${() => sendToKrogerCart({ test: true })}
                              >
                                SEND 3 TEST ITEMS
                              </button>
                            </div>
                            <p class="hint">
                              Proves the whole path — sign-in, product match, quantity, which store —
                              for a few dollars instead of a week of food. Check them in the Kroger app,
                              then send the real list.
                            </p>`
                        }`
                    }
                    ${canLive && cartNote && html`<p class="hint">${cartNote}</p>`}
                    ${
                      // WHAT ACTUALLY HAPPENED (David, 2026-08-25: "I'm logged in
                      // to my account on the Pay Less app, but I see nothing").
                      // Kroger cannot be read back, so this shows what WE sent and
                      // what Kroger said about it, durably. The UPCs are printed
                      // because searching one in the Kroger app is the only way to
                      // tell "never arrived" from "arrived, looking in the wrong
                      // place".
                      canLive &&
                      html`<details class="pushlog">
                        <summary>
                          kroger status ·
                          ${krogerLinked() ? "linked" : "NOT LINKED — that is why nothing arrives"}
                        </summary>
                        ${
                          !krogerLinked() &&
                          html`<p class="hint">
                            Signing in to the Pay Less app is <b>not</b> the same as linking Mise. Tap
                            LINK KROGER above, finish Kroger's sign-in page, and let it bounce you back
                            here — the link only exists once you land back in Mise.
                          </p>`
                        }
                        ${
                          krogerLinked() &&
                          html`<p class="hint">
                            link valid until
                            ${krogerLinkExpiry().slice(0, 16).replace("T", " ") || "unknown"}. Items
                            land in whichever store your Kroger ACCOUNT has selected, and in its PICKUP
                            basket — check that it says ${" "}${STORE_NAMES[homeStore] ?? homeStore},
                            and look under Pickup rather than Delivery.
                          </p>`
                        }
                        ${
                          pushLog.length === 0
                            ? html`<p class="hint">
                                No push has ever been made from this phone. If you tapped and saw
                                nothing, the tap did not reach Kroger.
                              </p>`
                            : pushLog.map(
                                (/** @type {any} */ e) =>
                                  html`<div class="pushrow">
                                    <p class="hint">
                                      <b>${e.ok ? "sent" : "FAILED"}</b>
                                      ${e.at.slice(0, 16).replace("T", " ")} ${e.test ? " (test)" : ""}
                                      · ${e.store} · ${e.message}
                                    </p>
                                    <p class="hint mono">
                                      ${e.rows
                                        .map((/** @type {any} */ r) => `${r.upc} ×${r.quantity}`)
                                        .join("  ")}
                                    </p>
                                  </div>`,
                              )
                        }
                        <p class="hint">
                          Search one of those UPCs in the Kroger app. Found = it arrived and the cart
                          you are looking at is the wrong one. Not found = it never arrived.
                        </p>
                      </details>`
                    }
                    ${
                      canLive &&
                      homeSummary.unpriced > 0 &&
                      html`<p class="hint">
                        BUILD already searched the priciest rows; anything still unpriced carries a
                        $? button — one search, one tap, priced forever.
                      </p>`
                    }
                  </div>
                `
    );
  };

  return html`
    <div class="view">
      <div class="hero"><h1>List</h1></div>

      <div class="chips" role="group" aria-label="List or pantry">
        <button
          class="chip ${tab === "list" ? "on" : ""}"
          aria-pressed=${tab === "list"}
          onClick=${() => setTab("list")}
        >
          ${
            // one kitchen, one list: for a brigade's shopper this IS the
            // brigade trip (the cook buys by rule), so the chip says so;
            // a non-shopping member keeps a plain LIST for odds and ends
            brigade ? (brigade.iShop ? "BRIGADE" : "LIST") : "SHOPPING"
          }
          ${items.length ? `(${items.length})` : ""}
        </button>
        <button
          class="chip ${tab === "pantry" ? "on" : ""}"
          aria-pressed=${tab === "pantry"}
          onClick=${() => setTab("pantry")}
        >
          PANTRY
        </button>
        ${
          // the HOUSEHOLD merge tab is a FAMILY-era surface: in a brigade
          // house it summed each member's stored personal list on top of a
          // pot that already feeds everyone — measured $1,141 for a $239
          // trip, 20 rows from a housemate's stale old week (Tribunal,
          // 2026-08-30). The pot IS the trip; there is nothing to merge.
          !brigade &&
          others.length > 0 &&
          html`<button
            class="chip ${tab === "combined" ? "on" : ""}"
            aria-pressed=${tab === "combined"}
            onClick=${() => setTab("combined")}
          >
            HOUSEHOLD ${combined.length ? `(${combined.length})` : ""}
          </button>`
        }
      </div>

      ${
        tab === "list" &&
        !brigade &&
        others.length > 0 &&
        html`<div class="tile" role="note">
          <div class="k">🛒 The store trip is the HOUSEHOLD tab</div>
          <p class="hint">
            This list is just your own meals. HOUSEHOLD merges the whole house, subtracts what the
            kitchen already holds, and is the one list to shop from.
          </p>
        </div>`
      }
      ${
        tab === "list" &&
        brigade &&
        brigade.weekNote &&
        html`<div class="tile" role="note">
          <div class="k">🗓 ${brigade.name}</div>
          <p class="hint">${brigade.weekNote}</p>
        </div>`
      }
      ${
        // the non-shopper's standing answer, ALWAYS shown — the old
        // empty-state-only message was dead code for any housemate whose
        // list still held rows, which is exactly the state real housemates
        // are in (Tribunal Realist, 2026-08-30)
        tab === "list" &&
        brigade &&
        !brigade.iShop &&
        html`<div class="tile" role="note">
          <div class="k">🍳 ${brigade.name}</div>
          <p class="hint">
            ${brigade.shopperName} shops for ${brigade.name}: nothing here is yours to buy. Your
            meals are on PLAN.${
              items.length > 0
                ? " The rows below are your old personal list from before the brigade. CLEAR LIST removes them."
                : ""
            }
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
            ${
              // a housemate the brigade shops FOR has nothing to build or
              // buy: a live BUILD sitting above "nothing for you to buy"
              // both contradicts the message and, tapped, overwrites his
              // list with food the cook already buys (Tribunal, 2026-08-30).
              // ADD TO PANTRY and CLEAR LIST below stay — old rows and
              // manual items are still his to tidy.
              !(brigade && !brigade.iShop) &&
              html`<button
                  class="primary"
                  onClick=${() => {
                    if (buyDays.length > 0 || buySlots.length > 0) {
                      onBuild({ dates: buyDays, slots: buySlots });
                    } else if (brigade?.iShop && brigade.buildWeek && onBuildWeek) {
                      // one tap builds the BRIGADE week even when the view
                      // still shows the ending one (the Sunday trap: BUILD
                      // FROM W35 made 24 leftover rows instead of the
                      // brigade's 79)
                      onBuildWeek(brigade.buildWeek);
                    } else {
                      onBuild(undefined);
                    }
                  }}
                >
                  ${
                    buyDays.length > 0 || buySlots.length > 0
                      ? `BUILD FOR ${buyDays.length || 7} ${(buyDays.length || 7) === 1 ? "DAY" : "DAYS"}`
                      : brigade?.iShop && brigade.buildWeek
                        ? `BUILD ${brigade.rangeLabel.toUpperCase()}`
                        : `BUILD FROM W${weekId.split("-W")[1]}`
                  }
                </button>
                ${
                  // JUST SOME DAYS renders the VIEWED week's day chips —
                  // before the one-tap flip those are the dying week's days
                  // (the Sunday trap again), so hide it until the view sits
                  // on the brigade week
                  !(brigade?.iShop && brigade.buildWeek && brigade.buildWeek !== weekId) &&
                  html`<button class="secondary" onClick=${() => setShowPartial(!showPartial)}>
                    ${showPartial ? "WHOLE WEEK" : "JUST SOME DAYS"}
                  </button>`
                }`
            }
            ${
              checkedCount > 0 &&
              html`<button class="primary" onClick=${onJustBought}>
                ADD TO PANTRY (${checkedCount}) <span aria-hidden="true">→</span>
              </button>`
            }
            ${
              !(brigade && !brigade.iShop) &&
              html`<button
                class="secondary lockbtn ${/** @type {any} */ (plan)?.fallback ? "on" : ""}"
                aria-label="Going to the store — save this week's plan as the fallback you can always return to"
                onClick=${onGoingShopping}
              >
                ${/** @type {any} */ (plan)?.fallback ? "🛒 RE-SAVE SHOPPED PLAN" : "🛒 GOING TO THE STORE"}
              </button>`
            }
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
          ${brigade?.iShop && priceTileBlock()}
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
                ? html`<strong>Shopped plan saved ✓</strong> — the week stays freely changeable; the
                    Plan tab watches that every bought perishable still gets cooked before it dies,
                    and ↩ can always put the shopped plan back.`
                : html`<strong>Going shopping? Tap 🛒 GOING TO THE STORE first.</strong> It saves
                    this plan as your fallback — the week stays changeable after you buy, and the
                    app tracks that everything perishable still gets used.`
            }
          </p>
          <p class="hint">
            Aggregates the week's plan${
              brigade?.iShop ? ", the whole brigade's meals in one buy, " : ", "
            }drops pantry
            staples${
              soloTrip
                ? " and food already on the kitchen's shelves"
                : brigade
                  ? ""
                  : " (the HOUSEHOLD tab subtracts what the kitchen already holds, once for the house)"
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
                      ${rowGroups(g.items).map(
                        // keyed Fragment: the row + its inline pick sheet are
                        // two roots, and an unkeyed array child would make
                        // Preact diff the list positionally (ui-review
                        // 2026-08-19: P+ removing a row would remount every
                        // row below it)
                        (members) => {
                          const i = members[0];
                          const grouped = members.length > 1;
                          const done = grouped ? members.every((m) => m.checked) : i.checked;
                          const unpriced = members.find((m) => !rowCost(m));
                          return html`<${Fragment} key=${i.id}>
                            <div class="checkrow listcols ${done ? "done" : ""}">
                              <button
                                class="tickarea"
                                aria-pressed=${done}
                                onClick=${() => (grouped ? toggleGroup(members) : onToggleItem(i.id))}
                              >
                                <span class="box" aria-hidden="true">${done ? "✓" : ""}</span>
                                <span class="food"
                                  >${i.food}${
                                    grouped
                                      ? html` <span class="tag">${members.length} recipes</span>`
                                      : ""
                                  }${
                                    members.some((m) => m.manual)
                                      ? html` <span class="tag">manual</span>`
                                      : ""
                                  }${
                                    members.some((m) => /** @type {any} */ (m).kitchenHas)
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
                                  aria-label="Already have ${i.food}${grouped ? `, all ${members.length} forms` : ""} — move to pantry staples"
                                  onClick=${() => members.forEach((m) => onOwnItem(m.id))}
                                >
                                  P+
                                </button>
                                ${canLive && unpriced && html`<button class="ownbtn" aria-label="Find live price for ${i.food}" onClick=${() => openPricePick(unpriced)}>$?</button>`}
                              </div>
                              ${grouped ? groupCells(members) : colCells(i)}
                            </div>
                            ${members.some((m) => pricePick?.item?.id === m.id) && !pricePick.fromTile ? pickSheet() : ""}
                          <//>`;
                        },
                      )}
                    </div>
                  `,
                )}
              </div>
            `,
          )}
          ${soloTrip && coveredBlock(soloTrip.covered)}
          ${
            // legacy placement (no brigade). A brigade housemate the cook
            // shops for gets NO price tile at all: pricing his stale rows at
            // a coverage-ranked store 120 miles away, with a live SEND TO
            // CART, was the measured failure (Tribunal Realist, 2026-08-30)
            !brigade && priceTileBlock()
          }
          ${
            // fallback placement for the pick sheet: the sheet normally
            // renders directly under its row (David, 2026-08-19: the
            // bottom-of-page tile looked like the ? button did nothing), but
            // if the row left the list mid-pick it still needs a home. A
            // fromTile sheet already renders inside the price tile — without
            // the guard, ticking the row under review drew both at once
            pricePick &&
            !pricePick.fromTile &&
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
                        : brigade && !brigade.iShop
                          ? "nothing to buy ✓"
                          : brigade?.iShop && brigade.rangeLabel
                            ? `no list yet — BUILD makes the brigade's ${brigade.rangeLabel} list`
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
            it. Food arrives on a shelf when you scan the receipt, tap ADD TO PANTRY, photograph
            the shelf, or type it in below, and comes off it when you cook the meal.
          </p>
          <div class="token-form">
            <input
              aria-label="Type an item to add to the pantry"
              placeholder="type an item (e.g. whey protein)"
              value=${pantryTyped}
              onInput=${(/** @type {any} */ e) => setPantryTyped(e.currentTarget.value)}
            />
            <button
              class="secondary"
              disabled=${!pantryTyped.trim()}
              aria-label="Add typed item as a shelf-stable staple"
              onClick=${() => {
                if (!pantryTyped.trim()) return;
                onScanApprove([{ name: pantryTyped.trim(), kind: "staple", qty: "" }], "unsorted", "add");
                setPantryTyped("");
              }}
            >
              + SHELF-STABLE
            </button>
            <button
              class="secondary"
              disabled=${!pantryTyped.trim() || scanLocation === "unsorted"}
              aria-label="Add typed item to the ${scanLocation}, dated today"
              onClick=${() => {
                if (!pantryTyped.trim()) return;
                onScanApprove([{ name: pantryTyped.trim(), kind: "fresh", qty: "" }], scanLocation, "add");
                setPantryTyped("");
              }}
            >
              + ${scanLocation.toUpperCase()}
            </button>
          </div>
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
          ${coveredBlock(combinedTrip.covered)} ${combinedSections.length > 0 && colHead()}
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
            // till with the HOUSEHOLD list open and there was nothing to press).
            // HOUSEHOLD is where the house shops, so HOUSEHOLD is where the receipt
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
