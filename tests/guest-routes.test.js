// Guest LOG IN / SIGN UP, the ROUTES (Mise v1.6, P8 + P3; David 2026-10-18:
// "not too much security, just a little bit of a boundary"; guests never see
// other people's accounts or who else he has over). Drives worker.fetch()
// against the same in-memory GitHub as tests/invite-routes.test.js, so the
// plan gate's binding changes are exercised, not read.
import test from "node:test";
import assert from "node:assert/strict";
import worker, { resetGuestCachesForTests } from "../worker/src/index.js";

const CODE = "k3m7pq2xvta4bcdefgh2";
const SANDBOX = "https://mise-next.pages.dev";
const LIVE = "https://janniksin.github.io";

/** a tiny GitHub Contents API: files per branch, shas, 409 on a stale sha */
function fakeRepo(seed) {
  /** @type {Record<string, Record<string, { obj: any, sha: string }>>} */
  const files = { main: {}, sandbox: {} };
  let n = 0;
  for (const [branch, paths] of Object.entries(seed)) {
    for (const [path, obj] of Object.entries(paths)) files[branch][path] = { obj, sha: `s${++n}` };
  }
  const calls = [];
  const fetchStub = async (/** @type {any} */ input, /** @type {any} */ init = {}) => {
    const url = new URL(String(input));
    calls.push(`${init.method ?? "GET"} ${url.pathname}${url.search}`);
    const m = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/);
    if (!m) return new Response("not found", { status: 404 });
    const path = decodeURIComponent(m[1]);
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers ?? {});
    if (method === "GET") {
      const branch = url.searchParams.get("ref") ?? "main";
      const f = files[branch]?.[path];
      if (!f) return new Response("{}", { status: 404 });
      if ((headers.get("accept") ?? "").includes("raw")) return Response.json(f.obj);
      const content = btoa(unescape(encodeURIComponent(JSON.stringify(f.obj, null, 2))));
      return Response.json({ content, sha: f.sha });
    }
    if (method === "PUT") {
      const body = JSON.parse(init.body);
      const branch = body.branch ?? "main";
      const cur = files[branch][path];
      if (cur && body.sha !== cur.sha)
        return Response.json({ message: "sha mismatch" }, { status: 409 });
      if (!cur && body.sha)
        return Response.json({ message: "sha wasn't supplied" }, { status: 422 });
      const obj = JSON.parse(decodeURIComponent(escape(atob(body.content))));
      files[branch][path] = { obj, sha: `s${++n}` };
      return Response.json({ content: { sha: files[branch][path].sha } });
    }
    return new Response("nope", { status: 405 });
  };
  return { files, calls, fetchStub };
}

const invite = (over = {}) => ({
  code: CODE,
  house: "guesthouse",
  hostHouse: "wayne",
  branch: "sandbox",
  createdBy: "david",
  createdAt: "2026-09-14T20:00:00.000Z",
  expiresAt: "2099-01-01T00:00:00.000Z",
  ...over,
});
const PRIYA = {
  entry: { name: "Priya", emoji: "🌶", household: "wayne" },
  targets: {
    macros: { calories: 2300, protein: 120, fat: 70, carbs: 280 },
    phase: "recomp",
    allergens: ["peanuts"],
    avoidIngredients: ["peanut"],
  },
};
const req = (path, body, origin = SANDBOX, ip = "1.1.1.1") =>
  new Request(`https://mise-worker.janniksin.workers.dev${path}`, {
    method: "POST",
    headers: { origin, "content-type": "application/json", "cf-connecting-ip": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const ENV = { MISE_INVITE_TOKEN: "write-token", MISE_DATA_TOKEN: "read-token" };

async function withRepo(seed, fn) {
  const repo = fakeRepo(seed);
  const real = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (repo.fetchStub);
  try {
    return await fn(repo);
  } finally {
    globalThis.fetch = real;
  }
}

const TODAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
const SEED = () => ({
  sandbox: {
    "invites.json": { invites: [invite()] },
    "profiles.json": {
      profiles: [
        { id: "david", name: "David Taranowski", household: "wayne" },
        { id: "sam", name: "Sam Rivera", household: "guesthouse" },
      ],
    },
    "households/wayne/events.json": {
      tables: [
        {
          id: "t1",
          date: TODAY,
          slot: "dinner",
          recipeId: "coconut-curry",
          cookId: "david",
          seats: [
            { id: "david", servings: 1 },
            { id: "sam", servings: 1 },
            { id: "priya", servings: 1 },
          ],
        },
        {
          id: "t2",
          date: TODAY,
          slot: "lunch",
          recipeId: "secret-dish",
          cookId: "david",
          seats: [{ id: "sam", servings: 1 }],
        },
      ],
    },
    "recipes/coconut-curry.json": {
      name: "Coconut Curry",
      servings: 4,
      ingredients: [{ qty: 900, unit: "g", food: "chicken thigh", note: "" }],
      instructions: [{ step: 1, text: "Sear the chicken." }],
      audited: { by: "nobody a guest needs" },
    },
  },
  main: { "invites.json": { invites: [] }, "profiles.json": { profiles: [] } },
});
const LOGIN = { name: "Priya K", pin: "4821" };

test("sign up stores the login with the host house and returns a session; the guest sees only their own meal", async () => {
  resetGuestCachesForTests();
  await withRepo(SEED(), async (repo) => {
    const res = await worker.fetch(req("/invite/claim", { code: CODE, ...PRIYA, login: LOGIN }, SANDBOX, "9.0.0.1"), ENV);
    const out = JSON.parse(await res.text());
    assert.equal(res.status, 200, JSON.stringify(out));
    assert.ok(out.session, "signed in on sign up");
    const row = repo.files.sandbox["guests.json"].obj.logins[0];
    assert.equal(row.nameKey, "priyak");
    assert.equal(row.hostHouse, "wayne");
    assert.equal(row.house, "guesthouse", "copied from the invite, not assumed");
    assert.equal(row.branch, "sandbox");
    assert.ok(row.salt && row.hash && !("pin" in row), "only a salted hash is stored");
    const puts = repo.calls.filter((c) => c.startsWith("PUT"));
    assert.match(puts[puts.length - 1], /guests\.json/, "the login is written last");

    const me = await worker.fetch(req("/guest/me", { session: out.session }, SANDBOX, "9.0.0.1"), ENV);
    const text = await me.text();
    assert.equal(me.status, 200, text);
    const view = JSON.parse(text);
    assert.equal(view.rows.length, 1, "only the meal they are seated at");
    assert.equal(view.rows[0].cook, "David", "the cook by first name only");
    assert.equal(view.rows[0].dish, "Coconut Curry");
    assert.deepEqual(view.recipes["coconut-curry"].steps, ["Sear the chicken."]);
    for (const leak of ["Sam", "Rivera", "Taranowski", "wayne", "secret-dish", "audited", "nobody"]) {
      assert.ok(!text.includes(leak), `no ${leak} in a guest's view`);
    }
  });
});

test("a taken login name is refused BEFORE the invite is spent", async () => {
  resetGuestCachesForTests();
  const seed = SEED();
  seed.sandbox["guests.json"] = { logins: [{ nameKey: "priyak", profileId: "other" }] };
  await withRepo(seed, async (repo) => {
    const res = await worker.fetch(req("/invite/claim", { code: CODE, ...PRIYA, login: { name: "priya  k", pin: "1111" } }, SANDBOX, "9.0.0.2"), ENV);
    assert.equal(res.status, 409);
    assert.ok(!repo.calls.some((c) => c.startsWith("PUT")), "nothing written, the code is not spent");
    assert.equal(repo.files.sandbox["invites.json"].obj.invites[0].usedAt, undefined);
  });
});

test("a bad login name or passkey is refused before anything is written", async () => {
  resetGuestCachesForTests();
  await withRepo(SEED(), async (repo) => {
    const res = await worker.fetch(req("/invite/claim", { code: CODE, ...PRIYA, login: { name: "P", pin: "12" } }, SANDBOX, "9.0.0.3"), ENV);
    assert.equal(res.status, 400);
    assert.ok(!repo.calls.some((c) => c.startsWith("PUT")));
  });
});

test("log in: right passkey signs in; wrong passkey and unknown name answer the same; never a GitHub write", async () => {
  resetGuestCachesForTests();
  await withRepo(SEED(), async (repo) => {
    await worker.fetch(req("/invite/claim", { code: CODE, ...PRIYA, login: LOGIN }, SANDBOX, "9.0.0.4"), ENV);
    resetGuestCachesForTests(); // a cold colo: the login must come from guests.json itself
    const writesBefore = repo.calls.filter((c) => c.startsWith("PUT")).length;
    const ok = await worker.fetch(req("/guest/login", { name: "priya k", pin: "4821" }, SANDBOX, "9.0.0.5"), ENV);
    assert.equal(ok.status, 200);
    assert.ok(JSON.parse(await ok.text()).session);
    const wrong = await worker.fetch(req("/guest/login", { name: "Priya K", pin: "0000" }, SANDBOX, "9.0.0.6"), ENV);
    const unknown = await worker.fetch(req("/guest/login", { name: "Nobody Here", pin: "0000" }, SANDBOX, "9.0.0.7"), ENV);
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.equal(await wrong.text(), await unknown.text(), "no way to tell a real name from a made-up one");
    assert.equal(repo.calls.filter((c) => c.startsWith("PUT")).length, writesBefore, "log in writes nothing");
  });
});

test("five wrong passkeys lock the login: the right one then fails too, with the same words", async () => {
  resetGuestCachesForTests();
  await withRepo(SEED(), async () => {
    await worker.fetch(req("/invite/claim", { code: CODE, ...PRIYA, login: LOGIN }, SANDBOX, "9.0.1.1"), ENV);
    for (let i = 0; i < 5; i++) {
      await worker.fetch(req("/guest/login", { name: "Priya K", pin: "9999" }, SANDBOX, `9.0.1.${10 + i}`), ENV);
    }
    const locked = await worker.fetch(req("/guest/login", { name: "Priya K", pin: "4821" }, SANDBOX, "9.0.1.20"), ENV);
    assert.equal(locked.status, 401);
    assert.match(await locked.text(), /don't match/);
  });
});

test("deleting the login row signs the guest out, and a session from the other branch is refused", async () => {
  resetGuestCachesForTests();
  await withRepo(SEED(), async (repo) => {
    const res = await worker.fetch(req("/invite/claim", { code: CODE, ...PRIYA, login: LOGIN }, SANDBOX, "9.0.2.1"), ENV);
    const { session } = JSON.parse(await res.text());
    const live = await worker.fetch(req("/guest/me", { session }, LIVE, "9.0.2.2"), ENV);
    assert.equal(live.status, 401, "a sandbox session opens nothing on live");
    repo.files.sandbox["guests.json"].obj = { logins: [] };
    resetGuestCachesForTests();
    const gone = await worker.fetch(req("/guest/me", { session }, SANDBOX, "9.0.2.3"), ENV);
    assert.equal(gone.status, 401);
  });
});

test("an old link with no login still claims as before", async () => {
  resetGuestCachesForTests();
  await withRepo(SEED(), async (repo) => {
    const res = await worker.fetch(req("/invite/claim", { code: CODE, ...PRIYA }, SANDBOX, "9.0.3.1"), ENV);
    const out = JSON.parse(await res.text());
    assert.equal(res.status, 200);
    assert.equal(out.session, undefined);
    assert.equal(repo.files.sandbox["guests.json"], undefined);
  });
});

test("Tribunal BLOCK: ten wrong passkeys sent at once still lock the name; the right one then fails", async () => {
  resetGuestCachesForTests();
  await withRepo(SEED(), async () => {
    await worker.fetch(req("/invite/claim", { code: CODE, ...PRIYA, login: LOGIN }, SANDBOX, "9.1.0.1"), ENV);
    const burst = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        worker.fetch(req("/guest/login", { name: "Priya K", pin: "9999" }, SANDBOX, `9.1.1.${i}`), ENV),
      ),
    );
    assert.ok(burst.every((r) => r.status === 401));
    const right = await worker.fetch(req("/guest/login", { name: "Priya K", pin: "4821" }, SANDBOX, "9.1.2.1"), ENV);
    assert.equal(right.status, 401, "the burst cannot race past the limit");
  });
});

test("a GitHub hiccup reading guests.json says try again, it never signs the guest out", async () => {
  resetGuestCachesForTests();
  await withRepo(SEED(), async () => {
    const res = await worker.fetch(req("/invite/claim", { code: CODE, ...PRIYA, login: LOGIN }, SANDBOX, "9.2.0.1"), ENV);
    const { session } = JSON.parse(await res.text());
    resetGuestCachesForTests();
    const real = globalThis.fetch;
    globalThis.fetch = /** @type {any} */ (async (/** @type {any} */ input, /** @type {any} */ init) =>
      String(input).includes("guests.json")
        ? new Response("busy", { status: 500 })
        : real(input, init));
    try {
      const me = await worker.fetch(req("/guest/me", { session }, SANDBOX, "9.2.0.2"), ENV);
      assert.equal(me.status, 502, "try again, not signed out");
    } finally {
      globalThis.fetch = real;
    }
  });
});

test("one unspent code cannot probe login names: after five taken answers it stops", async () => {
  resetGuestCachesForTests();
  const seed = SEED();
  seed.sandbox["guests.json"] = { logins: [{ nameKey: "priyak", profileId: "other" }] };
  await withRepo(seed, async () => {
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      const r = await worker.fetch(
        req("/invite/claim", { code: CODE, ...PRIYA, login: { name: "Priya K", pin: "1111" } }, SANDBOX, `9.3.0.${i}`),
        ENV,
      );
      statuses.push(r.status);
    }
    assert.deepEqual(statuses, [409, 409, 409, 409, 409, 429]);
  });
});

test("a guest sees their OWN profile, read only and whitelisted; a failed read just leaves it out", async () => {
  resetGuestCachesForTests();
  await withRepo(SEED(), async (repo) => {
    const res = await worker.fetch(req("/invite/claim", { code: CODE, ...PRIYA, login: LOGIN }, SANDBOX, "9.4.0.1"), ENV);
    const { session } = JSON.parse(await res.text());
    const me = await worker.fetch(req("/guest/me", { session }, SANDBOX, "9.4.0.2"), ENV);
    const view = JSON.parse(await me.text());
    assert.equal(view.profile.name, "Priya");
    assert.deepEqual(view.profile.allergens, ["peanuts"]);
    assert.deepEqual(view.profile.avoid, ["peanut"]);
    assert.equal(view.profile.calories, 2300);
    assert.equal(view.profile.protein, 120);
    assert.deepEqual(
      Object.keys(view.profile).sort(),
      ["allergens", "avoid", "avoids", "calories", "diet", "dislike", "loves", "name", "protein"],
      "nothing past the whitelist (no fat, carbs, phase)",
    );
    assert.ok(!repo.calls.some((c) => c.includes("profiles/sam/")), "never another guest's file");
    delete repo.files.sandbox["profiles/priya/profile/targets.json"];
    const bare = await worker.fetch(req("/guest/me", { session }, SANDBOX, "9.4.0.3"), ENV);
    assert.equal(bare.status, 200, "the meals still load");
    assert.equal(JSON.parse(await bare.text()).profile, undefined);
  });
});
