// Mise 2.0, D-01 (David's live guest test, Sun 10/18 about 10 pm): Mara
// signed up as a guest, he added her to that night's coconut curry from
// People, and "it doesn't work". Her targets had never reached his phone, so
// the cached-first read answered null and the plate screen refused her as
// unreadable. The data below has the real shape: the Wayne kitchen's Sun 10/18
// dinner as it stood before her seat, and a guest's saved targets. The guest,
// her numbers and her typed allergy are made up (Tribunal Red Team, 10/24:
// the code repo is public, so no real guest's name or health detail is here).
import test from "node:test";
import assert from "node:assert/strict";

/** @type {Map<string, string>} */
const kv = new Map();
globalThis.localStorage = /** @type {any} */ ({
  getItem: (/** @type {string} */ k) => kv.get(k) ?? null,
  setItem: (/** @type {string} */ k, /** @type {string} */ v) => kv.set(k, String(v)),
  removeItem: (/** @type {string} */ k) => kv.delete(k),
});

// a small in-memory IndexedDB, just the calls db.js makes
/** @type {Map<string, any>} */
const idb = new Map();
const req = (/** @type {() => any} */ fn) => {
  /** @type {any} */
  const r = { onsuccess: null, onerror: null, result: undefined };
  queueMicrotask(() => {
    r.result = fn();
    r.onsuccess?.();
  });
  return r;
};
const store = {
  get: (/** @type {string} */ k) => req(() => (idb.has(k) ? structuredClone(idb.get(k)) : undefined)),
  getAll: () => req(() => [...idb.values()].map((v) => structuredClone(v))),
  put: (/** @type {any} */ v) => req(() => void idb.set(v.path, structuredClone(v))),
  delete: (/** @type {string} */ k) => req(() => void idb.delete(k)),
};
globalThis.indexedDB = /** @type {any} */ ({
  open: () => {
    const r = req(() => ({ transaction: () => ({ objectStore: () => store }) }));
    /** @type {any} */ (r).onupgradeneeded = null;
    return r;
  },
});
Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true });

/** what GitHub holds, by path; every fetch is counted */
/** @type {Map<string, any>} */
const remote = new Map();
/** @type {string[]} */
const fetched = [];
globalThis.fetch = /** @type {any} */ (
  async (/** @type {string} */ url) => {
    const path = decodeURIComponent(String(url).split("/contents/")[1] ?? "").split("?")[0] ?? "";
    fetched.push(path);
    if (!navigator.onLine) throw new Error("offline");
    if (!remote.has(path)) return { status: 404, ok: false, json: async () => ({}) };
    const content = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(remote.get(path)))));
    return { status: 200, ok: true, json: async () => ({ content, sha: `sha-${path}` }) };
  }
);
kv.set("mise.pat", "test-token");
kv.set("mise.pat.savedAt", new Date().toISOString());

const {
  read,
  readNow,
  readTargetsOf,
  readTargetsForSeat,
  setSyncScope,
  setScopeGuests,
  inSyncScope,
  resetFileChecks,
} = await import("../app/lib/store.js");
const { seatGuestOnDay, seatScreen } = await import("../app/lib/tables.js");
const { recipeConflicts } = await import("../app/lib/plan.js");

const MARA = { id: "mara", name: "Mara" };
const MARA_TARGETS = {
  macros: { calories: 2050, protein: 120, fat: 70, carbs: 230 },
  avoidIngredients: ["celery and okra"],
  mealSlots: ["lunch", "dinner"],
};
const CURRY = {
  id: "one-pot-coconut-curry-chicken",
  name: "One-Pot Creamy Coconut Curry Chicken",
  servings: 4,
  nutrition: { calories: 910, protein: 56, carbs: 67, fat: 45 },
  ingredients: [
    { qty: 900, unit: "g", food: "chicken thigh" },
    { qty: 400, unit: "ml", food: "coconut milk" },
    { qty: 4, unit: "each", food: "japanese curry roux cubes" },
    { qty: 400, unit: "g", food: "broccoli" },
  ],
};
const BANK = new Map([[CURRY.id, CURRY]]);
const SUN = "2026-10-18";
/** @returns {import("../app/lib/tables.js").HouseEvents} */
const wayne = (/** @type {Record<string, any>} */ extra = {}) => ({
  brigades: [],
  tables: [
    {
      id: `b-20974b9d-${SUN}-dinner`,
      name: "Wayne kitchen",
      date: SUN,
      slot: "dinner",
      recipeId: CURRY.id,
      seats: [
        { id: "david", servings: 1, rawServings: 2.044 },
        { id: "rowan", servings: 0.75, rawServings: 1.575 },
      ],
      cookId: "rowan",
      fromBrigade: "20974b9d",
      pinned: true,
      buyerId: "david",
      ...extra,
    },
  ],
});
const seatMara = (
  /** @type {any} */ events,
  /** @type {any} */ targets,
  /** @type {Record<string, any>} */ ctx = {},
) =>
  seatGuestOnDay(events, "20974b9d", SUN, ["dinner"], MARA, targets, BANK, {
    today: SUN,
    ...ctx,
  });

test("a guest who signed up tonight can be seated at tonight's dinner", () => {
  const r = seatMara(wayne(), MARA_TARGETS);
  assert.ok(r.events, "the seat is written");
  const seats = r.events.tables[0]?.seats ?? [];
  assert.deepEqual(
    seats.map((s) => s.id),
    ["david", "rowan", "mara"],
  );
  assert.equal(seats[2]?.servings, 1.25, "her plate sized from her own targets");
  assert.equal(r.retry, false);
  assert.match(r.note, /^Mara joins tonight's dinner \(One-Pot Creamy Coconut Curry Chicken, about 1138 kcal\)\./);
  assert.match(r.note, /pot and the list grow by Mara's plate/);
});

test("a guest whose profile cannot be read is not seated, and the screen says why and offers to retry", () => {
  const events = wayne();
  const r = seatMara(events, null);
  assert.equal(r.events, null, "fail closed: nothing is written");
  assert.equal(r.retry, true);
  assert.match(r.note, /Mara was not added to tonight's dinner/);
  assert.match(r.note, /profile could not be read on this phone/);
  assert.match(r.note, /allergy check could not run/);
  assert.match(r.note, /TRY AGAIN/);
  assert.doesNotMatch(r.note, /—/, "no em dashes");
});

test("a guest the dish is unsafe for is refused with the reason, and no retry is offered", () => {
  const peanut = { ...MARA_TARGETS, avoidIngredients: ["curry roux"] };
  const r = seatMara(wayne(), peanut);
  assert.equal(r.events, null);
  assert.equal(r.retry, false, "trying again cannot make an unsafe dish safe");
  // 1.96 (shrike item 20): the dish, the food, then the meal
  assert.match(r.note, /Mara was not added: One-Pot Creamy Coconut Curry Chicken has curry roux \(tonight's dinner\)\./);
});

test("a guest already at the dinner hears that, not 'no shared meal is set'", () => {
  const seated = wayne({
    seats: [
      { id: "david", servings: 1 },
      { id: "mara", servings: 1 },
    ],
  });
  const r = seatMara(seated, MARA_TARGETS);
  assert.equal(r.events, null);
  assert.equal(r.note, "Mara is already at tonight's dinner.");
});

test("a recipe bank still loading says so and offers to retry, instead of 'the dish could not be found'", () => {
  const r = seatGuestOnDay(wayne(), "20974b9d", SUN, ["dinner"], MARA, MARA_TARGETS, new Map(), {
    today: SUN,
    bankLoading: true,
  });
  assert.equal(r.events, null);
  assert.equal(r.retry, true);
  assert.match(r.note, /recipes are still loading on this phone/);
  // a loaded bank without the dish still fails closed, as before
  const gone = seatGuestOnDay(wayne(), "20974b9d", SUN, ["dinner"], MARA, MARA_TARGETS, new Map(), {
    today: SUN,
  });
  assert.equal(gone.events, null);
  assert.match(gone.note, /the dish could not be found/);
});

test("tonight's dinner already cooked still seats the guest, and says the plate comes out of the pot", () => {
  const r = seatMara(wayne({ cookedAt: "2026-10-18T23:30:00Z" }), MARA_TARGETS);
  assert.ok(r.events);
  assert.match(r.note, /already made Sunday, so Mara's plate comes out of what is there/);
});

test("tonight's dinner with its food already bought seats the guest and says the list does not grow", () => {
  const r = seatMara(wayne({ pot: "frozen" }), MARA_TARGETS);
  assert.ok(r.events);
  assert.match(r.note, /food is already bought, so the list does not grow/);
});

test("another night's dinner is named by its day", () => {
  const r = seatMara(wayne(), MARA_TARGETS, { today: "2026-10-17" });
  assert.match(r.note, /^Mara joins Sunday's dinner/);
});

test("a typed pair like 'celery and okra' screens both foods", () => {
  const okra = { id: "gumbo", ingredients: [{ food: "okra" }] };
  const celery = { id: "soup", ingredients: [{ food: "celery stalks" }] };
  // the store widens stored typed words on every read
  return (async () => {
    const t = await readTargetsOf("mara", async () => MARA_TARGETS);
    assert.ok(recipeConflicts(okra, undefined, t.avoidIngredients).length > 0, "okra");
    assert.ok(recipeConflicts(celery, undefined, t.avoidIngredients).length > 0, "celery");
    assert.equal(recipeConflicts(CURRY, undefined, t.avoidIngredients).length, 0, "the curry passes");
  })();
});

test("a dinner holding either food of her typed pair refuses her seat", async () => {
  const t = await readTargetsOf("mara", async () => MARA_TARGETS);
  for (const food of ["celery", "okra"]) {
    const dish = { ...CURRY, ingredients: [...CURRY.ingredients, { qty: 2, unit: "each", food: `${food} stalks` }] };
    const r = seatGuestOnDay(wayne(), "20974b9d", SUN, ["dinner"], MARA, t, new Map([[CURRY.id, dish]]), {
      today: SUN,
    });
    assert.equal(r.events, null, `${food}: nothing is written`);
    assert.equal(r.retry, false);
    assert.match(r.note, new RegExp(`Mara was not added: .* has ${food}`), r.note);
  }
});

test("a guest's targets this phone never cached are fetched before the screen decides", async () => {
  await setSyncScope(null); // David's phone, the admin's
  resetFileChecks();
  idb.clear();
  fetched.length = 0;
  remote.set("profiles/mara/profile/targets.json", MARA_TARGETS);
  remote.set("profiles/bea/profile/targets.json", MARA_TARGETS);
  // the old path: the cached-first read answers null on the first tap
  assert.equal(await read("profiles/mara/profile/targets.json", { raw: true }), null);
  // the new one, for a guest this phone has never touched
  const t = await readTargetsOf("bea", readNow);
  assert.equal(t?.macros?.calories, 2050, "readNow waited for GitHub");
  assert.ok(fetched.includes("profiles/bea/profile/targets.json"));
  assert.ok(t.avoidIngredients.includes("okra"), "and the typed pair is widened");
});

test("a profile remembered as missing is asked for again when nothing is cached", async () => {
  await setSyncScope(null);
  resetFileChecks();
  idb.clear();
  remote.delete("profiles/newguest/profile/targets.json");
  assert.equal(await readNow("profiles/newguest/profile/targets.json", { raw: true }), null);
  // she finishes signing up a moment later
  remote.set("profiles/newguest/profile/targets.json", MARA_TARGETS);
  const t = await readNow("profiles/newguest/profile/targets.json", { raw: true });
  assert.equal(/** @type {any} */ (t)?.macros?.calories, 2050);
});

test("readNow offline with nothing cached answers null, so the seat fails closed", async () => {
  await setSyncScope(null);
  resetFileChecks();
  idb.clear();
  navigator.onLine = false;
  try {
    assert.equal(await readTargetsOf("mara", readNow), null);
  } finally {
    navigator.onLine = true;
  }
});

test("readNow never reaches past the sync scope", async () => {
  await setSyncScope({ profileIds: ["david", "rowan"], houses: ["wayne"] });
  resetFileChecks();
  fetched.length = 0;
  assert.equal(await readNow("profiles/mara/profile/targets.json", { raw: true }), null);
  assert.equal(fetched.length, 0);
  await setSyncScope(null);
});

test("a diner whose allergies could not be read is never seated", () => {
  // every seat path screens through seatScreen (People, Plan, a hand-made
  // table's SET TABLE, an occasion's picker): an unread profile is a reason
  assert.deepEqual(seatScreen(CURRY, null), ["their profile could not be read"]);
  assert.deepEqual(seatScreen(CURRY, undefined), ["their profile could not be read"]);
  const r = seatMara(wayne(), null);
  assert.equal(r.events, null);
});

// the raw check answers [] for a null avoid list, so a screen that calls it
// directly seats a diner whose profile could not be read. Every screen goes
// through seatScreen instead. Comments are stripped first, so a comment that
// names the function cannot trip this, and a call cannot hide beside one.
// Intentional raw callers in these files, each with how many calls and why:
/** @type {Record<string, { calls: number, why: string }>} */
const RAW_CONFLICT_CALLERS = {
  "views/annotate.js": {
    calls: 1,
    why:
      "the cookbook alternatives after a hard stop screen diners that already passed " +
      "unconfirmedReason, which stops the scan when any profile is unread",
  },
};
// Drops comments but leaves string contents alone, so a "/*" or "//" inside a
// string never swallows the code after it. Limits: a regex literal holding a
// quote, and ${} inside a template string, are read as plain text.
const stripComments = (/** @type {string} */ src) => {
  let out = "";
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2;
    } else if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
};

test("no screen in main.js or app/views calls the raw conflict check, which passes an unread profile", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const views = readdirSync(new URL("../app/views/", import.meta.url)).filter((f) => f.endsWith(".js"));
  const files = ["main.js", ...views.map((f) => `views/${f}`)];
  assert.ok(files.length > 5, "the views folder was read");
  for (const f of files) {
    const src = stripComments(readFileSync(new URL(`../app/${f}`, import.meta.url), "utf8"));
    const n = (src.match(/\brecipeConflicts\s*\(/g) ?? []).length;
    assert.equal(n, RAW_CONFLICT_CALLERS[f]?.calls ?? 0, `app/${f} calls recipeConflicts( directly`);
  }
});

test("the raw-call guard ignores comments but still catches a real call", () => {
  const caught = (/** @type {string} */ src) => /\brecipeConflicts\s*\(/.test(stripComments(src));
  assert.equal(caught("// recipeConflicts( once refused\nconst x = 1;"), false, "a line comment");
  assert.equal(caught("/* recipeConflicts(r) */ const x = 1;"), false, "a block comment");
  assert.equal(caught("const c = recipeConflicts(r, d, a); // checked"), true, "a call beside a comment");
  assert.equal(caught('const u = "https://x"; recipeConflicts (r)'), true, "a url does not hide a call");
  assert.equal(caught('"x/*" ; recipeConflicts(r)'), true, "a slash-star inside a string does not hide a call");
  assert.equal(caught('"x//" ; recipeConflicts(r)'), true, "a double slash inside a string does not hide a call");
  assert.equal(caught("const a = 'it\\'s /*'; recipeConflicts(r)"), true, "an escaped quote does not end the string early");
});

test("seating refuses a profile this phone does not show, before anything is fetched", async () => {
  // Rowan's phone; the id came from somewhere other than its People list
  await setSyncScope({ profileIds: ["david", "rowan"], houses: ["wayne"] });
  await setScopeGuests([]);
  resetFileChecks();
  idb.clear();
  fetched.length = 0;
  remote.set("profiles/stranger/profile/targets.json", MARA_TARGETS);
  assert.equal(await readTargetsForSeat("stranger", ["david", "rowan"]), null);
  assert.equal(fetched.length, 0, "nothing was asked of GitHub");
  assert.equal(inSyncScope("profiles/stranger/profile/targets.json"), false, "the scope did not widen");
  // a guest already seated at this house's tables is still read
  await setScopeGuests(["mara"]);
  remote.set("profiles/mara/profile/targets.json", MARA_TARGETS);
  const t = await readTargetsForSeat("mara", ["david", "rowan"]);
  assert.equal(/** @type {any} */ (t)?.macros?.calories, 2050);
  await setScopeGuests([]);
  await setSyncScope(null);
});

test("the admin's phone also refuses an id it was not shown", async () => {
  await setSyncScope(null);
  await setScopeGuests([]);
  resetFileChecks();
  idb.clear();
  fetched.length = 0;
  assert.equal(await readTargetsForSeat("stranger", ["david"]), null);
  assert.equal(fetched.length, 0);
});

test("main.js hands the seat read the phone's visible profiles and refuses anyone else first", async () => {
  const { readFileSync } = await import("node:fs");
  const src = stripComments(readFileSync(new URL("../app/main.js", import.meta.url), "utf8"));
  const calls = src.match(/readTargetsForSeat\([^)]*\)/g) ?? [];
  assert.ok(calls.length > 0);
  // the call shape: the second argument is the visible ids, built from the profiles this phone shows
  for (const c of calls) assert.match(c, /readTargetsForSeat\([^,]+,\s*mayShow\)/, c);
  assert.match(src, /const mayShow = visibleProfilesRef\.current\.map/, "the visible ids come from the phone's People list");
  // the refusal: an id outside those is turned away, with no retry, before the read
  const refuse = src.indexOf("if (!mayShow.includes(profileId))");
  assert.ok(refuse > 0, "an id outside the visible ones is refused");
  assert.match(src.slice(refuse, refuse + 200), /return \{ note: "[^"]+", retry: false \}/);
  assert.ok(refuse < src.indexOf("readTargetsForSeat(profileId"), "the refusal comes before the read");
});

test("seating a guest outside the sync scope reads her targets for real, and only her targets", async () => {
  // Rowan's phone: Mara is not seated yet, so she is outside its scope
  await setSyncScope({ profileIds: ["david", "rowan"], houses: ["wayne"] });
  await setScopeGuests([]);
  resetFileChecks();
  idb.clear();
  remote.set("profiles/mara/profile/targets.json", MARA_TARGETS);
  assert.equal(await readTargetsOf("mara", readNow), null, "an ordinary read stays out");
  const t = await readTargetsForSeat("mara", ["david", "rowan", "mara"]);
  assert.equal(/** @type {any} */ (t)?.macros?.calories, 2050);
  assert.equal(inSyncScope("profiles/mara/fitness/daily.json"), false, "nothing else of hers");
  assert.equal(inSyncScope("profiles/mom/profile/targets.json"), false);
  // not seated after all: the next scope from the tables drops her again
  await setScopeGuests([]);
  assert.equal(inSyncScope("profiles/mara/profile/targets.json"), false);
  await setSyncScope(null);
});

test("1.96 (shrike item 20): a refusal names the allergen family, not just the food", async () => {
  const { avoidTermsFromAllergens } = await import("../app/lib/targets.js");
  const dairy = { ...MARA_TARGETS, avoidIngredients: avoidTermsFromAllergens(["dairy"], "") };
  const r = seatMara(wayne(), dairy);
  assert.equal(r.events, null);
  assert.match(r.note, /curry roux, which has dairy/, r.note);
  assert.match(r.note, /\(tonight's dinner\)\.$/);
  assert.doesNotMatch(r.note, /\u2014/);
});
