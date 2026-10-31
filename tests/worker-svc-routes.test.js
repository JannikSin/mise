// Mise 2.0 F2 (plan section 4.2, Guests, invites, Worker; the Worker readers
// table): the guest, invite, notify-test, annotate-save and cron routes on a
// branch switched to Supabase, driven through worker.fetch() against an
// in-memory stand-in for the svc contract. Made-up people only; no real
// project, key or data.
import test from "node:test";
import assert from "node:assert/strict";
import worker, { resetGuestCachesForTests } from "../worker/src/index.js";
import { resetJwksCacheForTests } from "../worker/src/jwt.js";
import { resetAuthCachesForTests } from "../worker/src/auth.js";
import { signGuestSession, hashGuestPin } from "../worker/src/lib.js";
import { verifyGuestSessionV2, signGuestSessionV2 } from "../worker/src/guest-session.js";
import { inviteCodeHash } from "../worker/src/supa-routes.js";
import {
  makeKey,
  signJwt,
  fakeSupabase,
  fakeSvcDb,
  withFetch,
  workerReq,
  SANDBOX_ENV,
  SANDBOX_REF,
  USER_A,
  USER_B,
} from "./supabase-fakes.js";

const TODAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
const KEY = SANDBOX_ENV.GUEST_SESSION_KEY;

async function seededDb() {
  const pin = await hashGuestPin("4821");
  return fakeSvcDb({
    root: "host-1",
    people: [
      { id: "a0000000-0000-4000-8000-000000000001", user: USER_A, slug: "host-1", kind: "member", home: "house-w", houses: ["house-w"], name: "Host One", admin: true, entitled: true },
      { id: "a0000000-0000-4000-8000-000000000002", user: USER_B, slug: "housemate-1", kind: "member", home: "house-w", houses: ["house-w"], name: "Housemate One", entitled: true },
      { id: "a0000000-0000-4000-8000-000000000003", slug: "guest-a", kind: "guest", home: "guesthouse", houses: [], name: "Guest A", grantHouse: "house-w", grantUntil: "2099-01-01" },
      { id: "a0000000-0000-4000-8000-000000000004", slug: "guest-b", kind: "guest", home: "guesthouse", houses: [], name: "Guest B", grantHouse: "house-w", grantUntil: "2000-01-01" },
    ],
    logins: {
      guesta: { slug: "guest-a", salt: pin.salt, hash: pin.hash },
      guestb: { slug: "guest-b", salt: pin.salt, hash: pin.hash },
    },
    bank: { "lentil-soup": { id: "lentil-soup", name: "Lentil Soup", servings: 4, ingredients: [{ qty: 200, unit: "g", food: "lentils" }], instructions: ["Simmer."] } },
    docs: {
      "households/house-w/events.json": {
        tables: [
          { id: "t1", date: TODAY, slot: "dinner", recipeId: "lentil-soup", cookId: "host-1", seats: [{ id: "host-1", servings: 1 }, { id: "guest-a", servings: 1 }] },
          { id: "t2", date: TODAY, slot: "lunch", recipeId: "house-0123456789ab", cookId: "host-1", seats: [{ id: "guest-a", servings: 1 }] },
          { id: "t3", date: TODAY, slot: "breakfast", recipeId: "secret-dish", seats: [{ id: "housemate-1", servings: 1 }] },
        ],
      },
      "households/house-w/recipes/house-0123456789ab.json": { id: "house-0123456789ab", name: "House Special", servings: 2, ingredients: [], instructions: [] },
      "profiles/guest-a/profile/targets.json": { diet: "vegetarian", allergens: ["peanuts"], macros: { calories: 2100, protein: 90 } },
    },
  });
}

async function world() {
  resetJwksCacheForTests();
  resetAuthCachesForTests();
  resetGuestCachesForTests();
  const db = await seededDb();
  const key = await makeKey("kid-1");
  /** @type {string[]} */
  const github = [];
  /** @type {any[]} */
  const ntfy = [];
  const sb = fakeSupabase({
    jwks: { [SANDBOX_REF]: [key.jwk] },
    rpc: db.rpc,
    other: async (input, init) => {
      const url = new URL(String(input));
      if (url.host === "api.github.com") github.push(url.pathname);
      if (url.host === "ntfy.sh") {
        ntfy.push({ headers: new Headers(init?.headers ?? {}), body: init?.body });
        return new Response("ok");
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { db, key, sb, github, ntfy };
}

const ENV = { ...SANDBOX_ENV, ANTHROPIC_API_KEY: "sk-PLACEHOLDER", NTFY_TOPIC: "topic-PLACEHOLDER" };

test("guest login on Supabase: needs no GitHub token, signs a typed session with GUEST_SESSION_KEY", async () => {
  const w = await world();
  await withFetch(w.sb.fetchImpl, async () => {
    const r = await worker.fetch(workerReq("/guest/login", { name: "Guest A", pin: "4821" }), ENV);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.name, "Guest");
    const s = await verifyGuestSessionV2(body.session, KEY, "sandbox", Date.now());
    assert.equal(s?.p, "guest-a");
    const raw = JSON.parse(atob(body.session.split(".")[0].replace(/-/g, "+").replace(/_/g, "/")));
    assert.equal(raw.typ, "guest");
  });
  assert.equal(w.github.length, 0, "never touches GitHub");
});

test("guest login: wrong passkey and unknown name answer the same words; five wrong tries pause", async () => {
  const w = await world();
  await withFetch(w.sb.fetchImpl, async () => {
    const wrong = await worker.fetch(workerReq("/guest/login", { name: "Guest A", pin: "0000" }), ENV);
    const unknown = await worker.fetch(workerReq("/guest/login", { name: "Nobody Here", pin: "4821" }), ENV);
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.deepEqual(await wrong.json(), await unknown.json());
    for (let i = 0; i < 4; i++) {
      await worker.fetch(workerReq("/guest/login", { name: "Guest A", pin: "0000" }, { ip: `5.5.5.${i}` }), ENV);
    }
    const right = await worker.fetch(workerReq("/guest/login", { name: "Guest A", pin: "4821" }, { ip: "6.6.6.6" }), ENV);
    assert.equal(right.status, 429, "locked even for the right passkey, and says so");
  });
});

test("guest login: a lapsed grant cannot log in; a missing GUEST_SESSION_KEY is 503", async () => {
  const w = await world();
  await withFetch(w.sb.fetchImpl, async () => {
    const lapsed = await worker.fetch(workerReq("/guest/login", { name: "Guest B", pin: "4821" }), ENV);
    assert.equal(lapsed.status, 401);
    const noKey = { ...ENV, GUEST_SESSION_KEY: "" };
    const r = await worker.fetch(workerReq("/guest/login", { name: "Guest A", pin: "4821" }), noKey);
    assert.equal(r.status, 503);
  });
});

test("/guest/me on Supabase: own seats only, bank and house-special recipes, own profile", async () => {
  const w = await world();
  await withFetch(w.sb.fetchImpl, async () => {
    const session = await signGuestSessionV2({ p: "guest-a", b: "sandbox" }, KEY, Date.now());
    const r = await worker.fetch(workerReq("/guest/me", { session }), ENV);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.deepEqual(body.rows.map((/** @type {any} */ x) => x.recipeId).sort(), ["house-0123456789ab", "lentil-soup"]);
    assert.equal(body.recipes["lentil-soup"].name, "Lentil Soup");
    assert.equal(body.recipes["house-0123456789ab"].name, "House Special");
    assert.equal(JSON.stringify(body).includes("secret-dish"), false, "a table they are not at never shows");
    assert.equal(body.profile.diet, "vegetarian");
    assert.deepEqual(body.profile.allergens, ["peanuts"]);
  });
  const rf = w.sb.calls.filter((c) => c.fn === "recipe_for").map((c) => c.args);
  assert.ok(rf.every((a) => a.p_house === "house-w"), "recipes resolve against the host house");
});

test("/guest/me: a 1.95 session, a deleted login and a lapsed grant are all signed out", async () => {
  const w = await world();
  await withFetch(w.sb.fetchImpl, async () => {
    const old = await signGuestSession({ p: "guest-a", b: "sandbox" }, "write-token", Date.now());
    assert.equal((await worker.fetch(workerReq("/guest/me", { session: old }), ENV)).status, 401);
    const lapsed = await signGuestSessionV2({ p: "guest-b", b: "sandbox" }, KEY, Date.now());
    assert.equal((await worker.fetch(workerReq("/guest/me", { session: lapsed }), ENV)).status, 401);
    delete w.db.st.logins.guesta;
    const s = await signGuestSessionV2({ p: "guest-a", b: "sandbox" }, KEY, Date.now());
    assert.equal((await worker.fetch(workerReq("/guest/me", { session: s }), ENV)).status, 401);
  });
});

test("invite/new for a signed-in member: guest-only, the database gets a HASH, the host gets the code", async () => {
  const w = await world();
  await withFetch(w.sb.fetchImpl, async () => {
    const jwt = await signJwt(w.key, { sub: USER_B });
    const member = await worker.fetch(workerReq("/invite/new", { house: "member", hostHouse: "house-w" }, { auth: jwt }), ENV);
    assert.equal(member.status, 400, "member invites are not made by link");
    const other = await worker.fetch(workerReq("/invite/new", { hostHouse: "house-f" }, { auth: jwt }), ENV);
    assert.equal(other.status, 403, "only to a house you belong to");
    const r = await worker.fetch(workerReq("/invite/new", { hostHouse: "house-w" }, { auth: jwt }), ENV);
    assert.equal(r.status, 200);
    const { code, house } = await r.json();
    assert.match(code, /^[a-z2-7]{20}$/);
    assert.equal(house, "guesthouse");
    const stored = Object.keys(w.db.st.invites);
    assert.deepEqual(stored, [await inviteCodeHash(code)]);
    assert.equal(JSON.stringify(w.db.st.invites).includes(code), false, "no plaintext code stored");
  });
  assert.equal(w.github.length, 0);
});

test("invite claim then status on Supabase: one transaction, login, session, no family from a link", async () => {
  const w = await world();
  await withFetch(w.sb.fetchImpl, async () => {
    const jwt = await signJwt(w.key, { sub: USER_B });
    const { code } = await (await worker.fetch(workerReq("/invite/new", { hostHouse: "house-w" }, { auth: jwt }), ENV)).json();
    const before = await worker.fetch(workerReq("/invite/status", { code }), ENV);
    assert.deepEqual(await before.json(), { state: "unclaimed" });
    const claim = await worker.fetch(
      workerReq("/invite/claim", {
        code,
        entry: { name: "Guest C", emoji: "🍋", family: "fam-x" },
        targets: { macros: { calories: 2000, protein: 100, fat: 60, carbs: 220 }, phase: "maintain", allergens: ["shellfish"] },
        dinners: [TODAY],
        login: { name: "Guest C", pin: "1357" },
      }),
      ENV,
    );
    assert.equal(claim.status, 200);
    const out = await claim.json();
    assert.equal(out.id, "guest-c");
    assert.equal(out.house, "guesthouse");
    assert.equal((await verifyGuestSessionV2(out.session, KEY, "sandbox", Date.now()))?.p, "guest-c");
    const args = w.sb.calls.find((c) => c.fn === "claim_guest")?.args;
    assert.equal(JSON.stringify(args).includes("fam-x"), false, "a link never sets a family");
    assert.match(args.p_until, /^\d{4}-\d{2}-\d{2}$/);
    const login = w.sb.calls.find((c) => c.fn === "guest_login_add")?.args;
    assert.equal(login.p_name_key, "guestc");
    assert.equal(login.p_hash.length > 20, true);
    assert.equal(args.p_code_hash, await inviteCodeHash(code));
    assert.equal(JSON.stringify(args).includes(code), false);
    assert.equal(JSON.stringify(w.sb.calls.map((c) => c.args)).includes("1357"), false, "the passkey is hashed before any call");
    // spent
    const again = await worker.fetch(
      workerReq("/invite/claim", { code, entry: { name: "Guest D", emoji: "🍋" }, targets: { macros: { calories: 2000, protein: 100 } } }, { ip: "8.8.8.8" }),
      ENV,
    );
    assert.equal(again.status, 410);
    const status = await worker.fetch(workerReq("/invite/status", { code }, { ip: "7.7.7.7" }), ENV);
    assert.equal(status.status, 200);
    assert.equal((await status.json()).state, "claimed");
  });
  assert.equal(w.github.length, 0);
});

test("invite claim: a taken login name is refused before the code is spent", async () => {
  const w = await world();
  await withFetch(w.sb.fetchImpl, async () => {
    const jwt = await signJwt(w.key, { sub: USER_B });
    const { code } = await (await worker.fetch(workerReq("/invite/new", { hostHouse: "house-w" }, { auth: jwt }), ENV)).json();
    const r = await worker.fetch(
      workerReq("/invite/claim", {
        code,
        entry: { name: "Guest E", emoji: "🍋" },
        targets: { macros: { calories: 2000, protein: 100 } },
        login: { name: "Guest A", pin: "1111" },
      }),
      ENV,
    );
    assert.equal(r.status, 409);
    assert.equal(w.db.st.invites[await inviteCodeHash(code)].used_at, null, "still unspent");
    assert.equal(w.sb.calls.filter((c) => c.fn === "claim_guest").length, 0);
  });
});

test("an unknown, malformed or other-project code is 'does not exist'", async () => {
  const w = await world();
  await withFetch(w.sb.fetchImpl, async () => {
    const r = await worker.fetch(workerReq("/invite/status", { code: "aaaaaaaaaaaaaaaaaaaa" }), ENV);
    assert.equal(r.status, 404);
    const bad = await worker.fetch(workerReq("/invite/status", { code: "../../etc" }), ENV);
    assert.equal(bad.status, 404);
  });
  assert.equal(w.sb.calls.filter((c) => c.fn === "invite_get").length, 1, "a malformed code never reaches svc");
});

test("notify-test on the account: admin only, previews from svc.cron_inputs", async () => {
  const w = await world();
  w.db.st.bank["oat-bowl"] = { id: "oat-bowl", name: "Oat Bowl" };
  const week = (await import("../worker/src/lib.js")).isoWeekIdOf(TODAY);
  w.db.st.docs[`plans/${week}.json`] = { entries: [{ date: TODAY, slot: "breakfast", recipeId: "oat-bowl" }] };
  await withFetch(w.sb.fetchImpl, async () => {
    const no = await worker.fetch(workerReq("/notify-test", {}, { auth: await signJwt(w.key, { sub: USER_B }) }), ENV);
    assert.equal(no.status, 403);
    const r = await worker.fetch(workerReq("/notify-test", {}, { auth: await signJwt(w.key, { sub: USER_A }) }), ENV);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.topicSet, true);
    const all = JSON.stringify(body.preview);
    assert.ok(all.includes("Oat Bowl") || all.includes("Lentil Soup"), "names come from svc.recipe_names");
  });
  assert.equal(w.github.length, 0);
  const ci = w.sb.calls.find((c) => c.fn === "cron_inputs");
  assert.equal(ci?.args.p_week, week);
});

test("the hourly cron on a switched live branch reads svc, never GitHub", async () => {
  const w = await world();
  const env = {
    SUPABASE_BACKEND: "main",
    SUPABASE_URL: `https://${SANDBOX_REF}.supabase.co`,
    SUPABASE_SECRET_KEY: "sb_secret_PLACEHOLDER",
    NTFY_TOPIC: "topic-PLACEHOLDER",
    MISE_DATA_TOKEN: "github-read-PLACEHOLDER",
  };
  await withFetch(w.sb.fetchImpl, async () => {
    await worker.scheduled({ cron: "0 * * * *" }, env);
  });
  assert.equal(w.sb.calls.filter((c) => c.fn === "cron_inputs").length, 1);
  assert.equal(w.github.length, 0);
});

test("the hourly cron with nothing switched is 1.95: GitHub, no svc", async () => {
  const w = await world();
  await withFetch(w.sb.fetchImpl, async () => {
    await worker.scheduled({ cron: "0 * * * *" }, { NTFY_TOPIC: "t", MISE_DATA_TOKEN: "r" });
  });
  assert.equal(w.sb.calls.length, 0);
  assert.ok(w.github.length > 0);
});

test("F8: house and profile for recipe_for, recipe_names and guest_summary come from the verified session, never the body", async () => {
  const w = await world();
  // a second house with its own special and another guest's targets the body tries to reach
  w.db.st.docs["households/house-f/recipes/house-ffffffffffff.json"] = { id: "house-ffffffffffff", name: "Other House Dish" };
  w.db.st.docs["profiles/guest-b/profile/targets.json"] = { diet: "vegan", allergens: ["sesame"] };
  const hostile = {
    hostHouse: "house-f",
    house: "house-f",
    p_house: "house-f",
    profile: "guest-b",
    profileId: "a0000000-0000-4000-8000-000000000004",
    p_profile: "a0000000-0000-4000-8000-000000000004",
    recipeId: "house-ffffffffffff",
    ids: ["house-ffffffffffff"],
  };
  await withFetch(w.sb.fetchImpl, async () => {
    const session = await signGuestSessionV2({ p: "guest-a", b: "sandbox" }, KEY, Date.now());
    const r = await worker.fetch(workerReq("/guest/me", { session, ...hostile }), ENV);
    assert.equal(r.status, 200);
    const body = JSON.stringify(await r.json());
    assert.equal(body.includes("Other House Dish"), false);
    assert.equal(body.includes("sesame"), false);
    // a forged session naming the other guest is refused outright
    const forged = await signGuestSessionV2({ p: "guest-b", b: "sandbox" }, "not-the-key-PLACEHOLDER", Date.now());
    assert.equal((await worker.fetch(workerReq("/guest/me", { session: forged, ...hostile }), ENV)).status, 401);
    // the status page takes its house from the stored invite, not the body
    const jwt = await signJwt(w.key, { sub: USER_B });
    const { code } = await (await worker.fetch(workerReq("/invite/new", { hostHouse: "house-w" }, { auth: jwt }), ENV)).json();
    await worker.fetch(workerReq("/invite/status", { code, ...hostile }, { ip: "4.4.4.4" }), ENV);
  });
  const calls = w.sb.calls.filter((c) => ["recipe_for", "recipe_names", "guest_summary"].includes(String(c.fn)));
  assert.ok(calls.length > 0);
  for (const c of calls) {
    if ("p_house" in c.args) assert.equal(c.args.p_house, "house-w", `${c.fn} house from the session`);
    if ("p_profile" in c.args) assert.equal(c.args.p_profile, "a0000000-0000-4000-8000-000000000003", `${c.fn} profile from the session`);
    if ("p_id" in c.args) assert.notEqual(c.args.p_id, "house-ffffffffffff");
  }
});

test("F8: invite/new names a house in the body, but the database checks it against the caller's own sub", async () => {
  const w = await world();
  await withFetch(w.sb.fetchImpl, async () => {
    const jwt = await signJwt(w.key, { sub: USER_B });
    const r = await worker.fetch(workerReq("/invite/new", { hostHouse: "house-f", p_sub: USER_A, by: "host-1" }, { auth: jwt }), ENV);
    assert.equal(r.status, 403);
  });
  const mint = w.sb.calls.find((c) => c.fn === "mint_invite");
  assert.equal(mint?.args.p_sub, USER_B, "the sub is the verified token's, never the body's");
});

// fix loop 1, item 9: the mutation-killing tests for this file's sources
import { svcKills } from "./_mutation-kills.js";
svcKills(test);
