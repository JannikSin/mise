// ATE THE WHOLE DAY (2026-11-09, P11 + P1): the plan field, the evening and
// morning notifications with their "Ate everything" button, the signed link,
// and the open /ate route driven through worker.fetch against an in-memory
// GitHub Contents API (same harness idea as invite-routes.test.js).
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/src/index.js";
import {
  buildNotifications,
  EVENING_HOUR,
  ateSignature,
  verifyAteSignature,
  ntfyActionsHeader,
  isoWeekIdOf,
  shiftIsoDays,
  openMealCount,
} from "../worker/src/lib.js";
import {
  normalizePlan,
  markDayAte,
  unmarkDayAte,
  unmarkMealAte,
  dayAte,
  ateBannerDay,
  datesOfWeek,
} from "../app/lib/plan.js";
import { weekAdherence } from "../app/lib/adherence.js";

// ---- the plan field ---------------------------------------------------------

test("markDayAte adds a day once, sorted; unmarkDayAte takes it off; dayAte reads it", () => {
  const p0 = { week: "2026-W46", entries: [] };
  assert.equal(dayAte(p0, "2026-11-09"), false, "absent ateDays reads as none");
  const p1 = markDayAte(markDayAte(p0, "2026-11-09"), "2026-11-08");
  assert.deepEqual(p1.ateDays, ["2026-11-08", "2026-11-09"]);
  assert.equal(markDayAte(p1, "2026-11-09"), p1, "already marked is a no-op");
  assert.equal(dayAte(p1, "2026-11-08"), true);
  assert.deepEqual(markDayAte(p0, "not-a-date"), p0, "an invalid date is never written");
  const p2 = unmarkDayAte(p1, "2026-11-08");
  assert.deepEqual(p2.ateDays, ["2026-11-09"]);
  assert.equal(
    "ateDays" in unmarkDayAte(p2, "2026-11-09"),
    false,
    "the last day out drops the field",
  );
  assert.equal(p0.ateDays, undefined, "pure: the input is never changed");
});

test("normalizePlan carries ateDays, cleaned to valid unique sorted dates", () => {
  const raw = {
    week: "2026-W46",
    entries: [],
    ateDays: ["2026-11-09", "2026-11-08", "2026-11-09", "2026-02-30", "x", 7],
  };
  assert.deepEqual(normalizePlan(raw, "2026-W46").ateDays, ["2026-11-08", "2026-11-09"]);
  assert.equal("ateDays" in normalizePlan({ week: "2026-W46", entries: [] }, "2026-W46"), false);
});

test("the Plan banner asks about the oldest open day of yesterday and today (today only from 6 pm), in the week on screen", () => {
  const dates = datesOfWeek("2026-W46"); // Sun 11/8 .. Sat 11/14
  const plan = { week: "2026-W46", entries: [] };
  const open = (/** @type {string[]} */ days) => (/** @type {string} */ d) =>
    days.includes(d) ? 2 : 0;
  assert.deepEqual(
    ateBannerDay(plan, dates, "2026-11-09", 12, open(["2026-11-08", "2026-11-09"])),
    {
      date: "2026-11-08",
      word: "yesterday",
    },
  );
  assert.equal(
    ateBannerDay(plan, dates, "2026-11-09", 12, open(["2026-11-09"])),
    null,
    "today waits for 6 pm",
  );
  assert.deepEqual(ateBannerDay(plan, dates, "2026-11-09", 18, open(["2026-11-09"])), {
    date: "2026-11-09",
    word: "today",
  });
  assert.equal(
    ateBannerDay(markDayAte(plan, "2026-11-08"), dates, "2026-11-09", 12, open(["2026-11-08"])),
    null,
    "a day marked eaten is not asked about",
  );
  assert.equal(
    ateBannerDay(plan, dates, "2026-11-09", 12, open(["2026-11-08"]), new Set(["2026-11-08"])),
    null,
    "NOT ALL hides it for the session",
  );
  assert.equal(
    ateBannerDay(plan, dates, "2026-11-08", 12, open(["2026-11-07"])),
    null,
    "yesterday in the previous week is not shown on this week",
  );
});

test("adherence: a day in ateDays confirms every cookable meal on it", () => {
  const e = (/** @type {string} */ id, /** @type {string} */ date) => ({
    id,
    date,
    slot: "dinner",
    recipeId: "lentil-bolognese",
    servings: 1,
  });
  const plan = {
    week: "2026-W30",
    entries: [e("a", "2026-07-20"), e("b", "2026-07-20"), e("c", "2026-07-21")],
    ateDays: ["2026-07-20"],
  };
  const r = weekAdherence({ plan, weekId: "2026-W30", today: "2026-07-23" });
  assert.deepEqual(r.cooked, { done: 2, total: 3 });
});

// ---- notifications ----------------------------------------------------------

const BASE = {
  weekday: "Mon",
  dateIso: "2026-11-09",
  shopping: null,
  recipeName: (/** @type {string} */ id) => id,
};
const PLAN = {
  week: "2026-W46",
  entries: [
    { id: "a", date: "2026-11-09", slot: "dinner", recipeId: "chili", servings: 1 },
    { id: "b", date: "2026-11-09", slot: "breakfast", recipeId: "oats", servings: 1 },
  ],
};
const ateUrl = (/** @type {string} */ d) => `https://w.example/ate?d=${d}&k=sig`;

test("evening Ate it? carries the Ate everything button and says how to use it", () => {
  const out = buildNotifications({ ...BASE, hour: EVENING_HOUR, plan: PLAN, ateUrl });
  assert.equal(out.length, 1);
  assert.equal(out[0].title, "Ate it?");
  assert.equal(
    out[0].body,
    "2 of today's meals not marked eaten. Press and hold this notification, then tap Ate everything.",
  );
  assert.deepEqual(out[0].actions, [{ label: "Ate everything", url: ateUrl("2026-11-09") }]);
  const one = { ...PLAN, entries: [PLAN.entries[0]] };
  assert.match(
    buildNotifications({ ...BASE, hour: EVENING_HOUR, plan: one, ateUrl })[0].body,
    /^1 of today's meal not marked eaten\./,
  );
});

test("evening Ate it? is skipped when today is already in ateDays", () => {
  const marked = { ...PLAN, ateDays: ["2026-11-09"] };
  assert.deepEqual(buildNotifications({ ...BASE, hour: EVENING_HOUR, plan: marked, ateUrl }), []);
});

test("without ateUrl no notification carries actions (the old behaviour)", () => {
  const evening = buildNotifications({ ...BASE, hour: EVENING_HOUR, plan: PLAN });
  assert.equal(evening[0].actions, undefined);
  assert.match(evening[0].body, /One tap: ATE EVERYTHING TODAY on Plan\./);
  const morning = buildNotifications({
    ...BASE,
    hour: 7,
    plan: PLAN,
    yesterday: { dateIso: "2026-11-08", open: 2 },
  });
  assert.ok(morning.every((n) => n.actions === undefined));
});

test("7 am: one Yesterday not logged with yesterday's button when yesterday is open, apart from The day ahead", () => {
  const out = buildNotifications({
    ...BASE,
    hour: 7,
    plan: PLAN,
    ateUrl,
    yesterday: { dateIso: "2026-11-08", open: 3 },
  });
  assert.deepEqual(
    out.map((n) => n.title),
    ["The day ahead", "Yesterday not logged"],
  );
  const y = out[1];
  assert.equal(y.body, "Press and hold this notification, then tap Ate everything.");
  assert.deepEqual(y.actions, [{ label: "Ate everything", url: ateUrl("2026-11-08") }]);
  assert.equal(out[0].actions, undefined, "the day ahead carries no button");
});

test("7 am: no catch-up when yesterday is all logged, marked in ateDays, or not given", () => {
  const titles = (/** @type {any} */ yesterday) =>
    buildNotifications({ ...BASE, hour: 7, plan: PLAN, ateUrl, yesterday }).map((n) => n.title);
  assert.deepEqual(titles({ dateIso: "2026-11-08", open: 0 }), ["The day ahead"]);
  assert.deepEqual(titles({ dateIso: "2026-11-08", open: 2, ateDays: ["2026-11-08"] }), [
    "The day ahead",
  ]);
  assert.deepEqual(titles(undefined), ["The day ahead"]);
  assert.deepEqual(
    buildNotifications({
      ...BASE,
      hour: 11,
      plan: PLAN,
      ateUrl,
      yesterday: { dateIso: "2026-11-08", open: 2 },
    })
      .map((n) => n.title)
      .filter((t) => t === "Yesterday not logged"),
    [],
    "only at 7",
  );
});

test("openMealCount counts own and shared meals without cookedAt plus unconfirmed swipes, never a batch-only job", () => {
  const entries = [
    { date: "2026-11-08", recipeId: "x" },
    { date: "2026-11-08", recipeId: "y", cookedAt: "2026-11-08" },
    { date: "2026-11-08", table: "t1" },
    { date: "2026-11-08", out: true, currency: "swipes" },
    { date: "2026-11-08", out: true, currency: "swipes", eatenAt: "2026-11-08" },
    { date: "2026-11-08", table: "batch", batchOnly: true },
    { date: "2026-11-09", recipeId: "z" },
  ];
  assert.equal(openMealCount(entries, "2026-11-08"), 3);
});

test("the ntfy Actions header for the button", () => {
  const url =
    "https://mise-worker.janniksin.workers.dev/ate?d=2026-11-09&k=0123456789abcdef0123456789abcdef";
  assert.equal(
    ntfyActionsHeader([{ label: "Ate everything", url }]),
    `http, Ate everything, ${url}, method=POST, clear=true`,
  );
  assert.equal(ntfyActionsHeader(undefined), "");
  assert.equal(
    ntfyActionsHeader([{ label: "a, b", url }]).startsWith("http, a b, "),
    true,
    "no comma in a label",
  );
});

// ---- the signature ------------------------------------------------------------

test("ate signature: 32 hex characters, verifies, and fails on a tampered date or signature", async () => {
  const secret = "YOUR_PAT_HERE:topic";
  const sig = await ateSignature(secret, "david", "2026-11-09");
  assert.match(sig, /^[0-9a-f]{32}$/);
  assert.equal(await verifyAteSignature(secret, "david", "2026-11-09", sig), true);
  assert.equal(
    await verifyAteSignature(secret, "david", "2026-11-08", sig),
    false,
    "tampered date",
  );
  const flipped = (sig[0] === "0" ? "1" : "0") + sig.slice(1);
  assert.equal(
    await verifyAteSignature(secret, "david", "2026-11-09", flipped),
    false,
    "tampered sig",
  );
  assert.equal(await verifyAteSignature(secret, "david", "2026-11-09", sig.slice(0, 31)), false);
  assert.equal(
    await verifyAteSignature("other:topic", "david", "2026-11-09", sig),
    false,
    "other key",
  );
  assert.equal(await verifyAteSignature(secret, "david", "2026-11-09", undefined), false);
});

// ---- the /ate route -----------------------------------------------------------

const ENV = { MISE_INVITE_TOKEN: "YOUR_PAT_HERE", NTFY_TOPIC: "topic", MISE_DATA_TOKEN: "read" };
const SECRET = `${ENV.MISE_INVITE_TOKEN}:${ENV.NTFY_TOPIC}`;

/** the Worker's own today, on the Chicago clock */
function chicagoToday() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (/** @type {string} */ t) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * A tiny GitHub Contents API on the main branch: shas, 409 on a stale sha.
 * `conflictOnce` answers the first PUT 409 after another device's write.
 * @param {Record<string, any>} seed
 * @param {{ conflictOnce?: (files: Record<string, any>) => void }} [opts]
 */
function fakeRepo(seed, opts = {}) {
  /** @type {Record<string, { obj: any, sha: string }>} */
  const files = {};
  let n = 0;
  for (const [path, obj] of Object.entries(seed)) files[path] = { obj, sha: `s${++n}` };
  /** @type {{ method: string, path: string, ref: string | null, body?: any }[]} */
  const calls = [];
  let conflicted = false;
  const fetchStub = async (/** @type {any} */ input, /** @type {any} */ init = {}) => {
    const url = new URL(String(input));
    const m = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/);
    if (!m) return new Response("not found", { status: 404 });
    const path = decodeURIComponent(m[1]);
    const method = init.method ?? "GET";
    if (method === "GET") {
      calls.push({ method, path, ref: url.searchParams.get("ref") });
      const f = files[path];
      if (!f) return new Response("{}", { status: 404 });
      const content = btoa(unescape(encodeURIComponent(JSON.stringify(f.obj, null, 2))));
      return Response.json({ content, sha: f.sha });
    }
    if (method === "PUT") {
      const body = JSON.parse(init.body);
      calls.push({ method, path, ref: body.branch ?? null, body });
      if (opts.conflictOnce && !conflicted) {
        conflicted = true;
        opts.conflictOnce(files);
        if (files[path]) files[path].sha = `s${++n}`;
        return Response.json({ message: "conflict" }, { status: 409 });
      }
      const cur = files[path];
      if (cur && body.sha !== cur.sha)
        return Response.json({ message: "sha mismatch" }, { status: 409 });
      if (!cur && body.sha) return Response.json({ message: "no sha" }, { status: 422 });
      const obj = JSON.parse(decodeURIComponent(escape(atob(body.content))));
      files[path] = { obj, sha: `s${++n}` };
      return Response.json({ content: { sha: files[path].sha } });
    }
    return new Response("nope", { status: 405 });
  };
  return { files, calls, fetchStub };
}

/**
 * @param {Record<string, any>} seed
 * @param {(repo: ReturnType<typeof fakeRepo>) => Promise<void>} fn
 * @param {Parameters<typeof fakeRepo>[1]} [opts]
 */
async function withRepo(seed, fn, opts) {
  const repo = fakeRepo(seed, opts);
  const real = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (repo.fetchStub);
  try {
    await fn(repo);
  } finally {
    globalThis.fetch = real;
  }
}

let ipN = 0;
/** a fresh address per call, so the rate limit never decides a test */
const ateReq = (/** @type {string} */ d, /** @type {string} */ k, method = "POST") =>
  new Request(`https://mise-worker.janniksin.workers.dev/ate?d=${d}&k=${k}`, {
    method,
    headers: { "cf-connecting-ip": `10.9.0.${++ipN}` },
  });

test("/ate with a good link adds the date to ateDays on main, passing the sha, and keeps the plan", async () => {
  const d = chicagoToday();
  const path = `plans/${isoWeekIdOf(d)}.json`;
  const plan = {
    week: isoWeekIdOf(d),
    entries: [{ id: "a", date: d, slot: "dinner", recipeId: "chili", servings: 1 }],
    shoppedAt: d,
  };
  await withRepo({ [path]: plan }, async (repo) => {
    const k = await ateSignature(SECRET, "david", d);
    const res = await worker.fetch(ateReq(d, k), ENV);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), `Marked: ate everything on ${d}.`);
    const put = repo.calls.find((c) => c.method === "PUT");
    assert.ok(put, "it wrote");
    assert.equal(put.body.sha, "s1", "the write carries the read sha");
    assert.equal(put.ref, "main");
    assert.equal(repo.calls[0].ref, "main", "it read main");
    assert.deepEqual(repo.files[path].obj, { ...plan, ateDays: [d] });

    // idempotent: a second tap answers 200 and writes nothing more
    const again = await worker.fetch(ateReq(d, k), ENV);
    assert.equal(again.status, 200);
    assert.equal(repo.calls.filter((c) => c.method === "PUT").length, 1);

    // a GET (a link previewer, a prefetch) never reaches the route
    const reads = repo.calls.length;
    const get = await worker.fetch(ateReq(d, k, "GET"), ENV);
    assert.notEqual(get.status, 200);
    assert.equal(repo.calls.length, reads, "a GET reads and writes nothing");
  });
});

test("/ate refuses a bad signature, a too-old date and a future date with 403 before any read", async () => {
  const d = chicagoToday();
  await withRepo({}, async (repo) => {
    const bad = await worker.fetch(ateReq(d, "0".repeat(32)), ENV);
    assert.equal(bad.status, 403);
    const old = shiftIsoDays(d, -4);
    const oldRes = await worker.fetch(ateReq(old, await ateSignature(SECRET, "david", old)), ENV);
    assert.equal(oldRes.status, 403, "older than three days");
    const future = shiftIsoDays(d, 1);
    const futRes = await worker.fetch(
      ateReq(future, await ateSignature(SECRET, "david", future)),
      ENV,
    );
    assert.equal(futRes.status, 403, "tomorrow");
    const junk = await worker.fetch(ateReq("2026-13-40", "x"), ENV);
    assert.equal(junk.status, 403);
    assert.doesNotMatch(
      await bad.text(),
      /hmac|sha|token|github/i,
      "never says what failed inside",
    );
    assert.equal(repo.calls.length, 0, "nothing was read");
  });
  // three days back still works
  const three = shiftIsoDays(d, -3);
  await withRepo({}, async () => {
    const res = await worker.fetch(ateReq(three, await ateSignature(SECRET, "david", three)), ENV);
    assert.equal(res.status, 200);
  });
});

test("/ate on 409 re-reads and retries once, keeping the other device's write", async () => {
  const d = chicagoToday();
  const path = `plans/${isoWeekIdOf(d)}.json`;
  await withRepo(
    { [path]: { week: isoWeekIdOf(d), entries: [] } },
    async (repo) => {
      const res = await worker.fetch(ateReq(d, await ateSignature(SECRET, "david", d)), ENV);
      assert.equal(res.status, 200);
      assert.equal(repo.calls.filter((c) => c.method === "PUT").length, 2);
      assert.deepEqual(repo.files[path].obj.entries, [
        { id: "x", date: d, slot: "lunch", servings: 1 },
      ]);
      assert.deepEqual(repo.files[path].obj.ateDays, [d]);
    },
    {
      conflictOnce: (files) => {
        files[path].obj = {
          ...files[path].obj,
          entries: [{ id: "x", date: d, slot: "lunch", servings: 1 }],
        };
      },
    },
  );
});

test("/ate with no plan file creates one holding just the day", async () => {
  const d = chicagoToday();
  const path = `plans/${isoWeekIdOf(d)}.json`;
  await withRepo({}, async (repo) => {
    const res = await worker.fetch(ateReq(d, await ateSignature(SECRET, "david", d)), ENV);
    assert.equal(res.status, 200);
    assert.deepEqual(repo.files[path].obj, { week: isoWeekIdOf(d), entries: [], ateDays: [d] });
    assert.equal(repo.calls.find((c) => c.method === "PUT")?.body.sha, undefined);
  });
});

test("/ate refuses when MISE_INVITE_TOKEN is missing, and never reaches the PAT gate", async () => {
  const d = chicagoToday();
  await withRepo({}, async (repo) => {
    const k = await ateSignature(SECRET, "david", d);
    const res = await worker.fetch(ateReq(d, k), { NTFY_TOPIC: "topic" });
    assert.equal(res.status, 503);
    assert.equal(repo.calls.length, 0);
  });
});

test("ateDays merges as a set: a stale device never drops the phone's mark, and an undo still holds", async () => {
  const { mergeFieldWise } = await import("../app/lib/merge.js");
  const base = { week: "2026-W46", entries: [] };
  // the phone marked Sunday on GitHub; the app, from a stale base, marked Monday
  const remote = { ...base, ateDays: ["2026-11-08"] };
  const local = { ...base, ateDays: ["2026-11-09"] };
  assert.deepEqual(mergeFieldWise(base, local, remote).ateDays, ["2026-11-08", "2026-11-09"]);
  // an undo on one side wins over the other side leaving it alone
  const b2 = { ...base, ateDays: ["2026-11-08", "2026-11-09"] };
  const undone = { ...base, ateDays: ["2026-11-09"] };
  const phone = { ...base, ateDays: ["2026-11-08", "2026-11-09", "2026-11-10"] };
  assert.deepEqual(mergeFieldWise(b2, undone, phone).ateDays, ["2026-11-09", "2026-11-10"]);
  // nobody touched it: unchanged, and absent stays absent
  assert.equal(mergeFieldWise(base, { ...base, note: 1 }, base).ateDays, undefined);
});

// ---- ATE IT taken back off one meal (David, 2026-11-12) ---------------------

test("unmarkMealAte takes one meal's tick back and leaves every other meal alone", () => {
  const plan = {
    week: "2026-W46",
    entries: [
      {
        id: "a",
        date: "2026-11-10",
        slot: "breakfast",
        recipeId: "r1",
        servings: 1,
        cookedAt: "2026-11-10",
      },
      {
        id: "b",
        date: "2026-11-10",
        slot: "lunch",
        recipeId: "r2",
        servings: 1,
        cookedAt: "2026-11-12",
      },
      { id: "c", date: "2026-11-11", slot: "lunch", recipeId: "r2", servings: 1 },
    ],
  };
  const next = unmarkMealAte(plan, "b", "2026-11-10", "2026-11-12");
  assert.equal(next.entries[1].cookedAt, undefined, "the mis-tapped meal is not eaten any more");
  assert.equal("cookedAt" in next.entries[1], false, "the field is gone, not set to undefined");
  assert.equal(next.entries[0].cookedAt, "2026-11-10", "another meal's tick and its date stay");
  assert.equal(
    next.entries[2].cookedAt,
    undefined,
    "an unconfirmed meal is never ticked by an undo",
  );
  assert.equal(
    unmarkMealAte(plan, "c", "2026-11-11", "2026-11-12"),
    plan,
    "nothing to take back is a no-op",
  );
  assert.equal(
    unmarkMealAte(plan, "nope", "2026-11-10", "2026-11-12"),
    plan,
    "an unknown meal is a no-op",
  );
});

test("unmarkMealAte on a day marked eaten in full: the day mark goes, the other meals and the swipe keep their tick", () => {
  const plan = markDayAte(
    {
      week: "2026-W46",
      entries: [
        { id: "a", date: "2026-11-10", slot: "breakfast", recipeId: "r1", servings: 1 },
        { id: "b", date: "2026-11-10", slot: "lunch", recipeId: "r2", servings: 1 },
        {
          id: "s",
          date: "2026-11-10",
          slot: "dinner",
          freeText: "dining swipe",
          servings: 1,
          out: true,
          currency: "swipes",
        },
        {
          id: "o",
          date: "2026-11-10",
          slot: "snack",
          freeText: "eating out",
          servings: 1,
          out: true,
        },
        { id: "z", date: "2026-11-11", slot: "lunch", recipeId: "r2", servings: 1 },
      ],
    },
    "2026-11-10",
  );
  const next = unmarkMealAte(plan, "b", "2026-11-10", "2026-11-12");
  assert.equal(dayAte(next, "2026-11-10"), false, "the day is no longer eaten in full");
  assert.equal(next.entries[1].cookedAt, undefined, "the meal he did not eat reads as not eaten");
  assert.equal(
    next.entries[0].cookedAt,
    "2026-11-12",
    "the other meal keeps its tick as its own stamp",
  );
  assert.equal(
    next.entries[2].eatenAt,
    "2026-11-12",
    "the swipe the day mark covered keeps its tick",
  );
  assert.equal(
    next.entries[3].eatenAt,
    undefined,
    "a plain eating-out slot has nothing to confirm",
  );
  assert.equal(next.entries[4].cookedAt, undefined, "another day is never touched");
  // a shared-table row is not in the plan: the day is still converted
  const viaTable = unmarkMealAte(plan, "table-row", "2026-11-10", "2026-11-12");
  assert.equal(dayAte(viaTable, "2026-11-10"), false);
  assert.equal(viaTable.entries[1].cookedAt, "2026-11-12");
});

test("an un-ticked meal stays un-ticked through a sync merge with another device's write", async () => {
  const { mergeFieldWise } = await import("../app/lib/merge.js");
  const base = {
    week: "2026-W46",
    entries: [
      { id: "a", date: "2026-11-10", slot: "lunch", recipeId: "r1", servings: 1, cookedAt: "2026-11-10" },
      { id: "b", date: "2026-11-11", slot: "lunch", recipeId: "r2", servings: 1 },
    ],
  };
  const local = unmarkMealAte(base, "a", "2026-11-10", "2026-11-12");
  const remote = {
    ...base,
    entries: [base.entries[0], { ...base.entries[1], cookedAt: "2026-11-12" }],
  };
  const merged = /** @type {any} */ (mergeFieldWise(base, local, remote));
  const byId = Object.fromEntries(merged.entries.map((/** @type {any} */ e) => [e.id, e]));
  assert.equal(byId.a.cookedAt, undefined, "the undo survives the merge");
  assert.equal(byId.b.cookedAt, "2026-11-12", "the other device's tick survives too");
});
