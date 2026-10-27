// Mise 2.0 db fix loop 1, blocker 1 (Red Team F1): the name guard reads
// decoded strings and keys, folded, with plurals. One corpus runs through the
// JS twin (tools/name-guard.mjs, the migration's gates and probe-reach) and the
// SQL guard (private.guard_hit), and the two must agree. Negative controls:
// the old serialized-text guard, in JS and in SQL, misses the corpus.
import test from "node:test";
import assert from "node:assert/strict";
import { fold, guardHits, guardText, LOOKALIKES } from "../tools/name-guard.mjs";
import { HITS, MISSES } from "./_guard-corpus.js";
import { freshDb, SKIP } from "./_pglite.js";

/** The guard as it was before fix loop 1 (serialized JSON text). */
function oldGuard(/** @type {unknown} */ data, /** @type {string} */ term) {
  return new RegExp(`(^|[^a-z0-9])${term}([^a-z0-9]|$)`).test(JSON.stringify(data).toLowerCase());
}

test("JS guard: every F1 string hits, the near misses do not", () => {
  for (const [name, data, extra] of HITS) assert.ok(guardHits(data, ["kinword"], extra) > 0, name);
  for (const [name, data, extra] of MISSES) assert.equal(guardHits(data, ["kinword"], extra), 0, name);
});

test("negative control: the old serialized-text guard misses the corpus", () => {
  const missed = HITS.filter(([, data, extra]) => !oldGuard(extra ? { data, extra } : data, "kinword")).map(([n]) => n);
  for (const n of ["after a newline", "plural", "Cyrillic i", "zero-width space", "accent", "split across an array", "bank name after a newline", "recipe step"]) {
    assert.ok(missed.includes(n), n);
  }
});

test("fold: NFKD, marks and zero-width dropped, lookalikes mapped, lower case", () => {
  assert.equal(fold("K\u00cdN\u200bW\u043eRD"), "kinword");
  for (const [k, v] of Object.entries(LOOKALIKES)) assert.equal(fold(k), v, k);
  assert.match(guardText({ a: "x\ny", b: ["p", "q"] }, "path"), /path/);
});

/**
 * Run the corpus through the SQL guard; returns the names it gets wrong.
 * @param {any} db
 */
async function sqlGuardErrors(db) {
  const h = (await db.query("select id from public.households where slug = 'house-g'")).rows[0].id;
  /** @type {string[]} */
  const wrong = [];
  for (const [name, data, extra] of HITS) {
    const r = (await db.query("select private.guard_hit($1::jsonb, array[$2::uuid], $3) as h", [JSON.stringify(data), h, extra])).rows[0].h;
    if (r !== true) wrong.push(name);
  }
  for (const [name, data, extra] of MISSES) {
    const r = (await db.query("select private.guard_hit($1::jsonb, array[$2::uuid], $3) as h", [JSON.stringify(data), h, extra])).rows[0].h;
    if (r !== false) wrong.push(name);
  }
  return wrong;
}

async function guardDb() {
  const db = await freshDb();
  await db.exec(`insert into public.households (slug) values ('house-g');
    insert into private.guard_terms select 'kinword', id from public.households where slug = 'house-g';`);
  return db;
}

test("SQL guard agrees with the JS guard on the whole corpus", { skip: SKIP }, async () => {
  const db = await guardDb();
  assert.deepEqual(await sqlGuardErrors(db), []);
  // the fold itself, character for character
  for (const s of [Object.keys(LOOKALIKES).join(""), "K\u00cdN\u200bW\u043eRD", "\uff4b\uff49\uff4e", "Stra\u00dfe \u0141\u00f3d\u017a"]) {
    assert.equal((await db.query("select private.guard_fold($1) f", [s])).rows[0].f, fold(s), s);
  }
  await db.close();
});

test("negative control: the old SQL guard misses the corpus", { skip: SKIP }, async () => {
  const db = await guardDb();
  await db.exec(`create or replace function private.guard_hit(d jsonb, houses uuid[], extra text) returns boolean
    language sql stable set search_path = '' as $$ select exists (select 1 from private.guard_terms g
      where (houses is null or g.hidden_from = any (houses))
        and lower(d::text) ~ ('(^|[^a-z0-9])' || g.term || '([^a-z0-9]|$)')) $$;`);
  const wrong = await sqlGuardErrors(db);
  for (const n of ["after a newline", "plural", "Cyrillic i", "split across an array", "path"]) assert.ok(wrong.includes(n), n);
  await db.close();
});
