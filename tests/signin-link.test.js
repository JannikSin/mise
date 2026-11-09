// A SIGN-IN LINK FOR SOMEONE ALREADY IN THE KITCHEN (2026-11-09, P3; David:
// Elliot as an eater, "only i am" a full user). The host mints a link for an
// existing housemate; claiming it sets ONLY that person's login name and
// passkey. No profile, targets or kitchen file is written. Drives
// worker.fetch() against an in-memory GitHub (harness from guest-routes).
import test from "node:test";
import assert from "node:assert/strict";
import worker, { resetGuestCachesForTests } from "../worker/src/index.js";

const CODE = "k3m7pq2xvta4bcdefgh2";
const SANDBOX = "https://mise-next.pages.dev";

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
    if (/^\/repos\/[^/]+\/[^/]+$/.test(url.pathname))
      return Response.json({ private: true, permissions: { push: true } });
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

const PROFILES = {
  profiles: [
    { id: "david", name: "David Thornton", household: "wayne", admin: true },
    { id: "elliot", name: "Elliot Park", household: "wayne" },
    { id: "sam", name: "Sam Rivera", household: "guesthouse" },
  ],
};
const SEED = (
  inv = invite({ forProfile: "elliot", forName: "Elliot Park", house: "wayne" }),
  logins = [],
) => ({
  sandbox: {
    "invites.json": { invites: [inv] },
    "profiles.json": PROFILES,
    "guests.json": { logins },
    "profiles/elliot/profile/targets.json": { macros: { calories: 2600 } },
    "households/wayne/events.json": {
      tables: [
        {
          id: "t1",
          date: new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(
            new Date(),
          ),
          slot: "breakfast",
          recipeId: "overnight-oats",
          cookId: "elliot",
          seats: [
            { id: "david", servings: 1 },
            { id: "elliot", servings: 1 },
          ],
        },
      ],
    },
    "recipes/overnight-oats.json": {
      name: "Overnight Oats",
      servings: 2,
      ingredients: [],
      instructions: [],
    },
  },
  main: {},
});
const LOGIN = { name: "Elliot P", pin: "5512" };
const authed = (path, body) =>
  new Request(`https://mise-worker.janniksin.workers.dev${path}`, {
    method: "POST",
    headers: {
      origin: SANDBOX,
      "content-type": "application/json",
      "cf-connecting-ip": "7.7.7.7",
      "x-mise-auth": "host-token",
    },
    body: JSON.stringify(body),
  });

test("the host mints a sign-in link for a housemate; never for himself, an admin, or someone outside his kitchen", async () => {
  await withRepo(
    { sandbox: { "invites.json": { invites: [] }, "profiles.json": PROFILES } },
    async (repo) => {
      const ok = await worker.fetch(
        authed("/invite/new", {
          house: "member",
          hostHouse: "wayne",
          by: "david",
          forProfile: "elliot",
        }),
        ENV,
      );
      assert.equal(ok.status, 200, await ok.clone().text());
      const row = repo.files.sandbox["invites.json"].obj.invites[0];
      assert.equal(row.forProfile, "elliot");
      assert.equal(row.house, "wayne");
      for (const forProfile of ["david", "sam", "nobody"]) {
        const res = await worker.fetch(
          authed("/invite/new", { house: "member", hostHouse: "wayne", by: "david", forProfile }),
          ENV,
        );
        assert.equal(res.status, 400, forProfile);
      }
      assert.equal(repo.files.sandbox["invites.json"].obj.invites.length, 1);
    },
  );
});

test("status names the person, first name only, so the page asks only for a login", async () => {
  resetGuestCachesForTests();
  await withRepo(SEED(), async () => {
    const res = await worker.fetch(req("/invite/status", { code: CODE }, SANDBOX, "8.0.0.1"), ENV);
    assert.deepEqual(JSON.parse(await res.text()), { state: "unclaimed", forName: "Elliot" });
  });
});

test("claiming sets only the login for the EXISTING profile, and signs them in as that profile", async () => {
  resetGuestCachesForTests();
  await withRepo(SEED(), async (repo) => {
    const before = JSON.stringify(repo.files.sandbox["profiles.json"].obj);
    const res = await worker.fetch(
      // a profile in the body is ignored: this link never writes one
      req(
        "/invite/claim",
        { code: CODE, entry: { name: "X" }, targets: {}, login: LOGIN },
        SANDBOX,
        "8.0.0.2",
      ),
      ENV,
    );
    const out = JSON.parse(await res.text());
    assert.equal(res.status, 200, JSON.stringify(out));
    assert.equal(out.id, "elliot");
    assert.ok(out.session);
    const puts = repo.calls.filter((c) => c.startsWith("PUT")).map((c) => c.split(" ")[1]);
    assert.equal(puts.length, 2, puts.join(", "));
    assert.match(puts[0], /invites\.json/, "the code is spent first");
    assert.match(puts[1], /guests\.json/);
    assert.equal(JSON.stringify(repo.files.sandbox["profiles.json"].obj), before);
    const logins = repo.files.sandbox["guests.json"].obj.logins;
    assert.equal(logins.length, 1);
    assert.equal(logins[0].profileId, "elliot");
    assert.equal(logins[0].house, "wayne");
    assert.ok(logins[0].hash && !("pin" in logins[0]));
    // the link is spent
    const again = await worker.fetch(
      req("/invite/claim", { code: CODE, login: LOGIN }, SANDBOX, "8.0.0.3"),
      ENV,
    );
    assert.equal(again.status, 410);
    // and the passkey signs in as elliot
    const login = await worker.fetch(req("/guest/login", LOGIN, SANDBOX, "8.0.0.4"), ENV);
    assert.equal(login.status, 200);
    // and he sees the kitchen meal he is seated at, by its name
    const me = await worker.fetch(
      req("/guest/me", { session: out.session }, SANDBOX, "8.0.0.8"),
      ENV,
    );
    const view = JSON.parse(await me.text());
    assert.equal(me.status, 200, JSON.stringify(view));
    assert.equal(view.rows.length, 1);
    assert.equal(view.rows[0].dish, "Overnight Oats");
  });
});

test("a new link replaces that person's old login, and leaves everyone else's alone", async () => {
  resetGuestCachesForTests();
  const old = {
    nameKey: "ell",
    name: "Ell",
    salt: "a",
    hash: "b",
    profileId: "elliot",
    house: "wayne",
    hostHouse: "wayne",
    branch: "sandbox",
    createdAt: "x",
  };
  const sam = { ...old, nameKey: "samr", name: "Sam R", profileId: "sam", house: "guesthouse" };
  await withRepo(SEED(undefined, [old, sam]), async (repo) => {
    const res = await worker.fetch(
      req("/invite/claim", { code: CODE, login: LOGIN }, SANDBOX, "8.0.0.5"),
      ENV,
    );
    assert.equal(res.status, 200);
    const keys = repo.files.sandbox["guests.json"].obj.logins.map((l) => l.nameKey).sort();
    assert.deepEqual(keys, ["elliotp", "samr"]);
  });
});

test("someone else's login name is refused before the link is spent; a bad passkey before anything", async () => {
  resetGuestCachesForTests();
  const sam = {
    nameKey: "elliotp",
    name: "Elliot P",
    salt: "a",
    hash: "b",
    profileId: "sam",
    house: "guesthouse",
    hostHouse: "wayne",
    branch: "sandbox",
    createdAt: "x",
  };
  await withRepo(SEED(undefined, [sam]), async (repo) => {
    const taken = await worker.fetch(
      req("/invite/claim", { code: CODE, login: LOGIN }, SANDBOX, "8.0.0.6"),
      ENV,
    );
    assert.equal(taken.status, 409);
    const bad = await worker.fetch(
      req(
        "/invite/claim",
        { code: CODE, login: { name: "Elliot Q", pin: "12" } },
        SANDBOX,
        "8.0.0.7",
      ),
      ENV,
    );
    assert.equal(bad.status, 400);
    assert.equal(repo.calls.filter((c) => c.startsWith("PUT")).length, 0);
  });
});

test("a person who left the kitchen, or became an admin, cannot be claimed", async () => {
  resetGuestCachesForTests();
  for (const changed of [
    { id: "elliot", name: "Elliot Park", household: "guesthouse" },
    { id: "elliot", name: "Elliot Park", household: "wayne", admin: true },
  ]) {
    const seed = SEED();
    seed.sandbox["profiles.json"] = { profiles: [PROFILES.profiles[0], changed] };
    await withRepo(seed, async (repo) => {
      const res = await worker.fetch(
        req("/invite/claim", { code: CODE, login: LOGIN }, SANDBOX, "8.0.1.1"),
        ENV,
      );
      assert.equal(res.status, 410);
      assert.equal(repo.calls.filter((c) => c.startsWith("PUT")).length, 0);
    });
  }
});
