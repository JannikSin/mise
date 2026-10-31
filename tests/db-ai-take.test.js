// Mise 2.0 worker fix loop 1, item 10 (Engineer F9): svc.ai_take, the one
// quota call per AI request. PGlite; skips cleanly without it.
import test from "node:test";
import assert from "node:assert/strict";
import { asRole, asUser, errorOf, freshDb, SKIP } from "./_pglite.js";

const A = "a0000000-0000-4000-8000-0000000000a1";
const GLOBAL = "ffffffff-ffff-4fff-8fff-ffffffffffff";

/** @param {any} db @param {unknown[]} p */
const take = async (db, p) =>
  (await asRole(db, "service_role", () => db.query("select svc.ai_take($1, $2, $3::date, $4, $5) as r", p))).rows[0].r;

const today = async (/** @type {any} */ db) => (await db.query("select current_date::text as d")).rows[0].d;
const calls = async (/** @type {any} */ db, /** @type {string} */ sub) =>
  (await db.query("select coalesce(sum(calls), 0)::int as n from public.ai_usage where user_id = $1", [sub])).rows[0].n;

test("ai_take: one call adds the weight to the person, then the global row; caps answer user or global", { skip: SKIP }, async () => {
  const db = await freshDb();
  const d = await today(db);
  assert.equal(await take(db, [A, 4, d, 10, 50]), "ok");
  assert.equal(await calls(db, A), 4);
  assert.equal(await calls(db, GLOBAL), 4);
  assert.equal(await take(db, [A, 4, d, 10, 50]), "ok");
  assert.equal(await take(db, [A, 4, d, 10, 50]), "user", "12 > 10");
  assert.equal(await calls(db, A), 12, "a refused call still counts");
  assert.equal(await calls(db, GLOBAL), 8, "over your own: the global row is not spent");
  const B = "a0000000-0000-4000-8000-0000000000b2";
  assert.equal(await take(db, [B, 1, d, 10, 8]), "global", "9 > 8");
  await db.close();
});

test("ai_take: the day is the caller's Chicago date, within one day of the server's", { skip: SKIP }, async () => {
  const db = await freshDb();
  const d = await today(db);
  const prev = (await db.query("select (current_date - 1)::text as d")).rows[0].d;
  assert.equal(await take(db, [A, 1, prev, 10, 50]), "ok");
  const far = (await db.query("select (current_date - 5)::text as d")).rows[0].d;
  const e = await asRole(db, "service_role", () => errorOf(() => db.query("select svc.ai_take($1, 1, $2::date, 10, 50)", [A, far])));
  assert.match(e?.message ?? "", /bad day/);
  for (const [n, sub] of [[0, A], [11, A], [1, GLOBAL]]) {
    const bad = await asRole(db, "service_role", () => errorOf(() => db.query("select svc.ai_take($1, $2, $3::date, 10, 50)", [sub, n, d])));
    assert.ok(bad, `refused: n=${n}`);
  }
  await db.close();
});

test("ai_take is service_role only", { skip: SKIP }, async () => {
  const db = await freshDb();
  const sig = "svc.ai_take(uuid, integer, date, integer, integer)";
  const r = (await db.query("select has_function_privilege('service_role', $1, 'execute') s, has_function_privilege('authenticated', $1, 'execute') a, has_function_privilege('anon', $1, 'execute') n", [sig])).rows[0];
  assert.deepEqual(r, { s: true, a: false, n: false });
  const e = await asUser(db, A, () => errorOf(() => db.query("select svc.ai_take($1, 1, current_date, 10, 50)", [A])));
  assert.match(e?.message ?? "", /permission denied/);
  await db.close();
});
