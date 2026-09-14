// Join by link, the ROUTES (security review 2026-09-14, C1: "the handler has
// never executed once"). This drives worker.fetch() against an in-memory
// GitHub Contents API, so the claim ordering, the single-use race, the branch
// binding, the body cap and the status scoping are all exercised, not read.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/src/index.js";

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
/** a date N days from today, ISO, in the Worker's own (Chicago) calendar sense: near enough for a 14-day window */
const plusDays = (n) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
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

test("a claim spends the code FIRST, then writes both targets files and one profile row, on the invite's branch only", async () => {
  await withRepo(
    {
      sandbox: {
        "invites.json": { invites: [invite()] },
        "profiles.json": { profiles: [{ id: "david", name: "David", household: "wayne" }] },
      },
      main: { "invites.json": { invites: [] }, "profiles.json": { profiles: [{ id: "david" }] } },
    },
    async (repo) => {
      const res = await worker.fetch(req("/invite/claim", { code: CODE, ...PRIYA }), ENV);
      const text = await res.text();
      assert.equal(res.status, 200, text);
      const out = JSON.parse(text);
      assert.deepEqual(out, { ok: true, id: "priya", name: "Priya", house: "guesthouse" });
      const sb = repo.files.sandbox;
      const stamped = sb["invites.json"].obj.invites[0];
      assert.equal(stamped.profileId, "priya");
      assert.ok(
        stamped.usedAt && stamped.statusUntil > stamped.usedAt,
        "status grant has its own lifetime",
      );
      assert.deepEqual(sb["profiles/priya/profile/targets.json"].obj.macros, PRIYA.targets.macros);
      assert.deepEqual(
        sb["profiles/priya/fitness/targets.json"].obj,
        sb["profiles/priya/profile/targets.json"].obj,
        "mirrored pair identical",
      );
      const row = sb["profiles.json"].obj.profiles.find((p) => p.id === "priya");
      assert.equal(
        row.household,
        "guesthouse",
        "the body's household is ignored; the invite decides",
      );
      assert.deepEqual(row.capabilities, []);
      // the LIVE branch was never written
      assert.equal(repo.files.main["profiles.json"].obj.profiles.length, 1);
      assert.equal(repo.files.main["profiles/priya/profile/targets.json"], undefined);
      // ordering: the invites.json stamp is the first PUT
      const puts = repo.calls.filter((c) => c.startsWith("PUT"));
      assert.match(puts[0], /invites\.json/);
      assert.ok(puts.every((c) => !/main/.test(c)));
    },
  );
});

test("the same code a second time is 410, and a racing claim that loses the stamp is 410 too", async () => {
  await withRepo(
    {
      sandbox: {
        "invites.json": { invites: [invite()] },
        "profiles.json": { profiles: [] },
      },
    },
    async (repo) => {
      const first = await worker.fetch(
        req("/invite/claim", { code: CODE, ...PRIYA }, SANDBOX, "2.2.2.2"),
        ENV,
      );
      assert.equal(first.status, 200);
      const again = await worker.fetch(
        req("/invite/claim", { code: CODE, ...PRIYA }, SANDBOX, "2.2.2.3"),
        ENV,
      );
      assert.equal(again.status, 410);
      assert.equal(
        repo.files.sandbox["profiles.json"].obj.profiles.length,
        1,
        "one profile, not two",
      );
      // a stale sha on the stamp (someone else got there first) reads as used
      repo.files.sandbox["invites.json"] = {
        obj: { invites: [invite({ code: "aaaaaaaaaaaaaaaaaaaa" })] },
        sha: "fresh",
      };
      const realStub = globalThis.fetch;
      globalThis.fetch = /** @type {any} */ (
        async (input, init) => {
          const r = await realStub(input, init);
          if ((init?.method ?? "GET") === "PUT" && String(input).includes("invites.json")) {
            return Response.json({ message: "sha mismatch" }, { status: 409 });
          }
          return r;
        }
      );
      const raced = await worker.fetch(
        req("/invite/claim", { code: "aaaaaaaaaaaaaaaaaaaa", ...PRIYA }, SANDBOX, "2.2.2.4"),
        ENV,
      );
      assert.equal(raced.status, 410);
      assert.equal(
        repo.files.sandbox["profiles.json"].obj.profiles.length,
        1,
        "nothing created when the stamp lost",
      );
    },
  );
});

test("a forged Origin cannot move a sandbox code onto the live branch, and a row whose branch disagrees is refused", async () => {
  await withRepo(
    {
      sandbox: { "invites.json": { invites: [invite()] }, "profiles.json": { profiles: [] } },
      main: {
        "invites.json": { invites: [invite({ branch: "sandbox" })] },
        "profiles.json": { profiles: [] },
      },
    },
    async (repo) => {
      // the live origin looks in main's invites.json; the row there says branch sandbox -> refused
      const res = await worker.fetch(
        req("/invite/claim", { code: CODE, ...PRIYA }, LIVE, "3.3.3.3"),
        ENV,
      );
      assert.equal(res.status, 404);
      assert.equal(
        repo.calls.filter((c) => c.startsWith("PUT")).length,
        0,
        "nothing written anywhere",
      );
      const local = await worker.fetch(
        req("/invite/claim", { code: CODE, ...PRIYA }, "http://127.0.0.1:8378", "3.3.3.4"),
        ENV,
      );
      assert.equal(local.status, 403, "a local server may not write");
    },
  );
});

test("open routes: no write token = 503 and no GitHub call, bad code = 404 with no GitHub call, oversized body = 413", async () => {
  await withRepo({ sandbox: { "invites.json": { invites: [invite()] } } }, async (repo) => {
    const noTok = await worker.fetch(
      req("/invite/claim", { code: CODE, ...PRIYA }, SANDBOX, "4.4.4.1"),
      { MISE_DATA_TOKEN: "read-only" },
    );
    assert.equal(noTok.status, 503, "the cron's read-only token is never used to write");
    const bad = await worker.fetch(
      req("/invite/claim", { code: "../etc/passwd", ...PRIYA }, SANDBOX, "4.4.4.2"),
      ENV,
    );
    assert.equal(bad.status, 404);
    assert.equal(repo.calls.length, 0, "no GitHub traffic for junk");
    const big = await worker.fetch(
      req(
        "/invite/claim",
        JSON.stringify({ code: CODE, pad: "x".repeat(70 * 1024) }),
        SANDBOX,
        "4.4.4.3",
      ),
      ENV,
    );
    assert.equal(big.status, 413);
    assert.equal(repo.calls.length, 0);
    const junk = await worker.fetch(
      req(
        "/invite/claim",
        { code: CODE, entry: { name: "", emoji: "" }, targets: {} },
        SANDBOX,
        "4.4.4.4",
      ),
      ENV,
    );
    assert.equal(junk.status, 400);
    assert.equal(repo.calls.filter((c) => c.startsWith("PUT")).length, 0);
  });
});

test("status: unclaimed before, then only this person's live seats with their plate; expired grant is 410", async () => {
  const used = invite({
    usedAt: "2026-09-14T21:00:00.000Z",
    profileId: "priya",
    statusUntil: "2099-01-01T00:00:00.000Z",
  });
  await withRepo(
    {
      sandbox: {
        "invites.json": { invites: [invite({ code: "bbbbbbbbbbbbbbbbbbbb" }), used] },
        "profiles.json": {
          profiles: [
            { id: "david", name: "David" },
            { id: "priya", name: "Priya", household: "guesthouse" },
          ],
        },
        "households/wayne/events.json": {
          tables: [
            {
              id: "t1",
              date: plusDays(2),
              slot: "dinner",
              recipeId: "chicken-piccata",
              cookId: "david",
              seats: [
                { id: "david", servings: 1 },
                { id: "priya", servings: 1.25 },
              ],
              tailor: {
                seats: {
                  david: { plate: ["DAVID SECRET"] },
                  priya: { plate: ["add 100 g pasta"] },
                },
              },
            },
            {
              id: "t2",
              date: plusDays(3),
              slot: "dinner",
              recipeId: "stew",
              cookId: "david",
              seats: [{ id: "david", servings: 1 }],
            },
          ],
        },
        "recipes/chicken-piccata.json": { name: "Chicken Piccata" },
      },
    },
    async () => {
      const before = await worker.fetch(
        req("/invite/status", { code: "bbbbbbbbbbbbbbbbbbbb" }, SANDBOX, "5.5.5.1"),
        ENV,
      );
      assert.deepEqual(await before.json(), { state: "unclaimed" });
      const res = await worker.fetch(
        req("/invite/status", { code: CODE }, SANDBOX, "5.5.5.2"),
        ENV,
      );
      assert.equal(res.status, 200);
      const out = await res.json();
      assert.equal(out.state, "claimed");
      assert.equal(out.name, "Priya");
      assert.equal(out.rows.length, 1, "the table she is not seated at is not returned");
      assert.equal(out.rows[0].dish, "Chicken Piccata");
      assert.deepEqual(out.rows[0].plate, ["add 100 g pasta"]);
      assert.ok(!JSON.stringify(out).includes("DAVID SECRET"), "no other seat's plate leaks");
      assert.equal(out.rows[0].cook, "David");
    },
  );
  await withRepo(
    {
      sandbox: {
        "invites.json": {
          invites: [
            invite({
              usedAt: "2026-01-01T00:00:00.000Z",
              profileId: "priya",
              statusUntil: "2026-03-01T00:00:00.000Z",
            }),
          ],
        },
      },
    },
    async () => {
      const res = await worker.fetch(
        req("/invite/status", { code: CODE }, SANDBOX, "5.5.5.3"),
        ENV,
      );
      assert.equal(res.status, 410);
    },
  );
});

test("an open-route failure never echoes internal detail", async () => {
  await withRepo({ sandbox: {} }, async (repo) => {
    // invites.json missing on the branch -> the Worker's reader returns no data -> 404, not a stack
    const res = await worker.fetch(
      req("/invite/claim", { code: CODE, ...PRIYA }, SANDBOX, "6.6.6.6"),
      ENV,
    );
    assert.equal(res.status, 404);
    const text = await res.text();
    assert.ok(!/failed: \d{3}|api\.github|token/i.test(text), text);
    assert.equal(repo.calls.filter((c) => c.startsWith("PUT")).length, 0);
  });
});
