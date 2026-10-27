// Mise 2.0 F2 (plan section 6 step 6, RT N3 and N5): the Worker's weekly
// Wayne probe. assertReach is pure (shared with tools/probe-reach.mjs); the
// runner signs in as the probe with the PUBLISHABLE key and reads as it.
// In-memory project only.
import test from "node:test";
import assert from "node:assert/strict";
import { assertReach, runReachProbe, weeklyProbes, probeDue } from "../worker/src/probe.js";
import { projectFor } from "../worker/src/supabase-env.js";
import { fakeSupabase, SANDBOX_ENV } from "./supabase-fakes.js";

const clean = () => ({
  docs: [{ kind: "plan" }, { kind: "shopping" }, { kind: "global" }],
  plates: [{ data: { diet: "omnivore", macros: { calories: 2400 } } }],
  profiles: [],
  households: [],
  memberships: [],
  roster: [{ id: "housemate-1", family: null }],
  guardHits: 0,
});

test("a clean snapshot passes", () => {
  assert.deepEqual(assertReach(clean()), []);
});

test("each leak is named with a count, never with data", () => {
  const cases = /** @type {[string, (s: any) => void][]} */ ([
    ["targets rows visible: 1", (s) => s.docs.push({ kind: "targets" })],
    ["health rows visible: 1", (s) => s.docs.push({ kind: "health" })],
    ["plates with a non-plate key: 1", (s) => s.plates.push({ data: { goalWeightLb: 999 } })],
    ["profiles rows visible: 1", (s) => s.profiles.push({ id: "x" })],
    ["households rows visible: 1", (s) => s.households.push({ id: "x" })],
    ["memberships rows visible: 1", (s) => s.memberships.push({})],
    ["probe rows in roster: 1", (s) => s.roster.push({ id: "probe-a1b2c3", family: null })],
    ["roster rows with family: 1", (s) => s.roster.push({ id: "someone", family: "fam-x" })],
    ["guard hits: 2", (s) => (s.guardHits = 2)],
    ["guard hits: unreadable", (s) => (s.guardHits = Number.NaN)],
  ]);
  for (const [want, poison] of cases) {
    const s = clean();
    poison(s);
    const fails = assertReach(s);
    assert.deepEqual(fails, [want]);
    assert.equal(JSON.stringify(fails).includes("fam-x"), false);
    assert.equal(JSON.stringify(fails).includes("999"), false);
  }
});

test("runReachProbe: signs in with the publishable key, no-grant tables count as zero rows", async () => {
  const project = /** @type {any} */ (projectFor("sandbox", SANDBOX_ENV));
  const denied = () => Response.json({ code: "42501", message: "permission denied" }, { status: 401 });
  const sb = fakeSupabase({
    rpc: {
      __token: (a) => (a.password === "probe-pass-PLACEHOLDER" ? { access_token: "probe-session" } : null),
      "table:docs": () => [{ kind: "plan" }],
      "table:plates": () => [{ data: { diet: "vegetarian" } }],
      "table:profiles": denied,
      "table:households": denied,
      "table:memberships": denied,
      roster: () => ({ profiles: [{ id: "housemate-1", family: null }], rev: 3 }),
      guard_hits: () => 0,
    },
  });
  const r = await runReachProbe(project, { email: "probe@example.test", password: "probe-pass-PLACEHOLDER" }, sb.fetchImpl);
  assert.deepEqual(r, { ok: true, fails: [] });
  const token = sb.calls.find((c) => c.url.includes("/auth/v1/token"));
  assert.equal(token?.headers.get("apikey"), "sb_publishable_PLACEHOLDER");
  const reads = sb.calls.filter((c) => c.fn?.startsWith("table:"));
  assert.ok(reads.every((c) => c.headers.get("authorization") === "Bearer probe-session"));
  const roster = sb.calls.find((c) => c.fn === "roster");
  assert.equal(roster?.headers.get("authorization"), "Bearer probe-session", "roster() as the probe");
  const hits = sb.calls.find((c) => c.fn === "guard_hits");
  assert.equal(hits?.headers.get("apikey"), "sb_secret_PLACEHOLDER", "guard_hits is svc");

  const bad = await runReachProbe(project, { email: "probe@example.test", password: "wrong" }, sb.fetchImpl);
  assert.equal(bad.ok, false);
});

test("weeklyProbes reports a pass, a fail, and a probe that was never set up", async () => {
  /** @type {any[]} */
  const posts = [];
  const post = async (/** @type {any} */ n) => {
    posts.push(n);
  };
  // switched, no probe account: a FAILED report, not silence
  await weeklyProbes(SANDBOX_ENV, post, async () => new Response("", { status: 500 }));
  assert.equal(posts.length, 1);
  assert.match(posts[0].title, /FAILED \(sandbox\)/);
  assert.equal(posts[0].body, "probe account: not set");
  // nothing switched: nothing to probe
  posts.length = 0;
  await weeklyProbes({}, post);
  assert.equal(posts.length, 0);
  // a leaking project: FAILED with the check name
  posts.length = 0;
  const leaky = fakeSupabase({
    rpc: {
      __token: () => ({ access_token: "s" }),
      "table:docs": () => [{ kind: "targets" }],
      roster: () => ({ profiles: [] }),
      guard_hits: () => 0,
    },
  });
  const env = { ...SANDBOX_ENV, PROBE_SANDBOX_EMAIL: "p@example.test", PROBE_SANDBOX_PASSWORD: "x" };
  await weeklyProbes(env, post, leaky.fetchImpl);
  assert.match(posts[0].title, /FAILED/);
  assert.equal(posts[0].body, "targets rows visible: 1");
  assert.equal(posts[0].priority, "high");
});

test("probeDue: Mondays at 7 am only", () => {
  assert.equal(probeDue({ weekday: "Mon", hour: 7 }), true);
  assert.equal(probeDue({ weekday: "Mon", hour: 8 }), false);
  assert.equal(probeDue({ weekday: "Tue", hour: 7 }), false);
});
