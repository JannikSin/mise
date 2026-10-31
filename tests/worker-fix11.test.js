// Mise 2.0 fix loop 1, item 11 (Engineer F10, F11, F12): the live cron that
// cannot run reports once a day, claim_guest's P0422 and 23505 get plain
// answers, and invite expiry is compared as instants. In-memory only.
import test from "node:test";
import assert from "node:assert/strict";
import worker, { resetGuestCachesForTests } from "../worker/src/index.js";
import { supaInviteRoute, inviteCodeHash, pastIso } from "../worker/src/supa-routes.js";
import { claimGuest } from "../worker/src/svc.js";
import { projectFor } from "../worker/src/supabase-env.js";
import { fakeSupabase, withFetch, SANDBOX_ENV, SANDBOX_REF } from "./supabase-fakes.js";

const LIVE = {
  SUPABASE_BACKEND: "main",
  SUPABASE_URL: `https://${SANDBOX_REF}.supabase.co`,
  SUPABASE_SECRET_KEY: "sb_secret_PLACEHOLDER",
  NTFY_TOPIC: "topic-PLACEHOLDER",
};

/** @param {any} rpc */
function net(rpc) {
  /** @type {{ title: string | null, body: string }[]} */
  const ntfy = [];
  const sb = fakeSupabase({
    rpc,
    other: async (input, init) => {
      if (new URL(String(input)).host === "ntfy.sh") {
        ntfy.push({ title: new Headers(init?.headers ?? {}).get("title"), body: String(init?.body ?? "") });
        return new Response("ok");
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { sb, ntfy };
}

test("E10: a switched live cron whose svc call fails sends one high-priority report a day, counts only", async () => {
  resetGuestCachesForTests();
  const { sb, ntfy } = net({
    cron_inputs: () =>
      Response.json({ code: "42501", message: "permission denied for function cron_inputs" }, { status: 403 }),
  });
  await withFetch(sb.fetchImpl, async () => {
    await worker.scheduled({ cron: "0 * * * *" }, LIVE);
    await worker.scheduled({ cron: "0 * * * *" }, LIVE);
  });
  assert.equal(ntfy.length, 1, "once a day, not every hour");
  assert.match(String(ntfy[0]?.title), /not running/);
  assert.equal(/cron_inputs|permission|42501/.test(String(ntfy[0]?.body)), false, "no server text");
});

test("E10: switched live with incomplete settings reports instead of returning silently", async () => {
  resetGuestCachesForTests();
  const { sb, ntfy } = net({});
  await withFetch(sb.fetchImpl, async () => {
    await worker.scheduled({ cron: "0 * * * *" }, { SUPABASE_BACKEND: "main", NTFY_TOPIC: "topic-PLACEHOLDER" });
  });
  assert.equal(ntfy.length, 1);
  assert.match(String(ntfy[0]?.body), /settings are incomplete/);
});

const project = /** @type {NonNullable<ReturnType<typeof projectFor>>} */ (projectFor("sandbox", SANDBOX_ENV));
const refuse = (/** @type {string} */ code) => () => Response.json({ code, message: "x" }, { status: 400 });

test("E11: claim_guest P0422 is 'guarded', 23505 is a taken slug", async () => {
  for (const [code, want] of [
    ["P0422", "guarded"],
    ["23505", "slug_taken"],
    ["P0409", "slug_taken"],
    ["P0403", "invalid"],
  ]) {
    const sb = fakeSupabase({ rpc: { claim_guest: refuse(String(code)) } });
    const r = await claimGuest(
      project,
      { codeHash: "h", slug: "s", roster: {}, targets: {}, until: "2026-12-01" },
      sb.fetchImpl,
    );
    assert.equal(r.status, want, code);
  }
});

/** a RouteCtx @param {any} fetchImpl @param {number} nowMs */
const ctx = (fetchImpl, nowMs) => ({
  json: (/** @type {number} */ status, /** @type {any} */ body) => Response.json(body, { status }),
  cacheGet: async () => null,
  cachePut: async () => {},
  cacheDelete: async () => {},
  rateState: new Map(),
  todayIso: "2026-10-27",
  nowMs,
  fetchImpl,
});

test("E11: a claim the guard refuses answers 422 in plain words; a racing slug moves on to the next", async () => {
  const code = "k3m7pq2xvta4bcdefgh2";
  const hash = await inviteCodeHash(code);
  const inv = { host_house: "house-w", expires_at: "2099-01-01T00:00:00+00:00", used_at: null, claimed: null };
  const body = { entry: { name: "Guest Z", emoji: "x" }, targets: { macros: { calories: 2000, protein: 90 } } };
  const guarded = fakeSupabase({
    rpc: {
      invite_get: (/** @type {any} */ a) => (a.p_code_hash === hash ? inv : null),
      slug_free: () => true,
      claim_guest: refuse("P0422"),
    },
  });
  const r = await supaInviteRoute("/invite/claim", body, code, "sandbox", SANDBOX_ENV, ctx(guarded.fetchImpl, Date.now()));
  assert.equal(r.status, 422);
  assert.match((await r.json()).error, /can't be saved for this kitchen/);
  /** @type {string[]} */
  const slugs = [];
  const race = fakeSupabase({
    rpc: {
      invite_get: () => inv,
      slug_free: () => true,
      claim_guest: (/** @type {any} */ a) => {
        slugs.push(a.p_slug);
        return slugs.length === 1
          ? Response.json({ code: "23505", message: "dup" }, { status: 409 })
          : "a0000000-0000-4000-8000-000000000009";
      },
    },
  });
  const ok = await supaInviteRoute("/invite/claim", body, code, "sandbox", SANDBOX_ENV, ctx(race.fetchImpl, Date.now()));
  assert.equal(ok.status, 200);
  assert.equal(slugs.length, 2);
  assert.notEqual(slugs[0], slugs[1]);
});

test("E12: expiry is compared as an instant, whatever zone Postgres writes", async () => {
  const now = Date.UTC(2026, 9, 27, 12, 0);
  assert.equal(pastIso("2026-10-27T13:00:00+02:00", now), true, "11:00 UTC, past, though its text sorts later");
  assert.equal(pastIso("2026-10-27 12:30:00+00", now), false);
  assert.equal(pastIso("2026-10-27T07:30:00-05:00", now), false);
  assert.equal(pastIso("not a date", now), true, "unreadable is past");
  const code = "k3m7pq2xvta4bcdefgh2";
  const sb = fakeSupabase({
    rpc: {
      invite_get: () => ({ host_house: "house-w", expires_at: "2026-10-27T13:00:00+02:00", used_at: null, claimed: null }),
    },
  });
  const st = await supaInviteRoute("/invite/status", {}, code, "sandbox", SANDBOX_ENV, ctx(sb.fetchImpl, now));
  assert.equal(st.status, 410);
});
