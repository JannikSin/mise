// Mise 2.0 db fix loop 2 (Red Team verify 2, terrigen-db-fixlist-2.md): the
// verify probes (scratchpad redteam-db-v2: g-guard, s-safety-svc,
// m-migrate-tools) as regression cases. Made-up names only; the names below
// are common name SHAPES (an accent, a stroke letter, two words, an
// apostrophe, a diaeresis, mixed scripts), not anyone in the app.
import test from "node:test";
import assert from "node:assert/strict";
import { freshDb, errorOf, SKIP } from "./_pglite.js";
import { PEOPLE, writeSnapshot } from "./_snapshot.js";
import { planMigration, runMigration, GateError } from "../tools/migrate-to-supabase.mjs";
import { fold, guardHits, termWords, TermError } from "../tools/name-guard.mjs";

// ---- item 1 (C1, N1): a term folds exactly as the text does

/** [name as typed in people.local.json, text that must hit, words expected] */
const NAME_CASES = /** @type {[string, string, string[]][]} */ ([
  ["Wójcik", "Wójcik's pierogi", ["wojcik"]],
  ["Łukasz", "Łukasz soup", ["lukasz"]],
  ["Mary Ann", "Mary Ann's cake", ["mary", "ann", "maryann"]],
  ["O'Brien", "O’Brien’s stew", ["brien", "obrien"]],
  ["Zoë", "Zoe's pie", ["zoe"]],
  ["Kоwalski", "Kowalski bigos", ["kowalski"]], // Cyrillic o inside a Latin name
  ["Anna-Maria", "Anna Maria salad", ["anna", "maria", "annamaria"]],
  ["Strauß", "Strauss cake", ["strauss"]],
  ["Þóra", "Thora bread", ["thora"]],
]);
/** Terms that must be REFUSED: not plain a to z after folding, or no word left. */
const BAD_TERMS = ["Иван", "Petrovич", "x2", "O", "Σοφία", "名前", "kin_word"];

test("C1: every name shape folds to its words and hits its own text, in any spelling", () => {
  for (const [name, text, words] of NAME_CASES) {
    assert.deepEqual(termWords(name), words, name);
    assert.ok(guardHits({ name: text }, [name]) > 0, `${name} on its own text`);
    assert.ok(guardHits({ name: fold(text) }, [name]) > 0, `${name} on the folded text`);
  }
  assert.ok(guardHits({ name: "Wojcik pie" }, ["Wójcik"]) > 0, "the term with the accent hits the text without");
  assert.ok(guardHits({ name: "Maryann's" }, ["Mary Ann"]) > 0, "two words hit the joined form");
  assert.ok(guardHits({ name: "OBrien stew" }, ["O'Brien"]) > 0);
  assert.equal(guardHits({ name: "the cruz of it" }, ["de la Cruz"]) > 0, true, "the last word of a long name still counts");
  assert.equal(guardHits({ name: "de la soup" }, ["de la Cruz"]), 0, "particles are not words of their own");
});

test("C1: a term that is not plain a to z after folding is refused, never silently empty", () => {
  for (const t of BAD_TERMS) assert.throws(() => termWords(t), TermError, t);
  for (const t of BAD_TERMS) assert.throws(() => guardHits({ a: "x" }, [t]), TermError, t);
  // the message never carries the term
  try {
    termWords("Petrovич");
  } catch (e) {
    assert.doesNotMatch(String(/** @type {Error} */ (e).message), /petrov/i);
  }
});

test("C1 probe M2: a bank recipe named for an accented, two-word or apostrophe name stops the scrub gate", () => {
  for (const name of ["Wójcik", "Mary Ann", "O'Brien", "Łukasz", "Zoë"]) {
    const people = structuredClone(PEOPLE);
    /** @type {any} */ (people.people.find((p) => p.slug === "kin-1")).names = [name];
    const dir = writeSnapshot((f) => {
      f["recipes/pierogi.json"] = { id: "pierogi", name: `${name}'s pierogi` };
    });
    assert.throws(() => planMigration(dir, people), (e) => e instanceof GateError && e.gate === "scrub", name);
  }
});

test("C1 probe M3: an accented guard term catches its text in the JS gate, and a bad one stops the preflight naming the field only", () => {
  const people = structuredClone(PEOPLE);
  people.guardTerms.push({ term: "Wójcik", hiddenFrom: "house-w" });
  const dir = writeSnapshot((f) => {
    f["households/house-w/events.json"] = { tables: [{ note: "Wojcik visit" }] };
  });
  assert.throws(() => planMigration(dir, people), (e) => e instanceof GateError && e.gate === "name-guard");
  for (const bad of ["Petrovич", "x2"]) {
    const p2 = structuredClone(PEOPLE);
    p2.guardTerms.push({ term: bad, hiddenFrom: "house-w" });
    assert.throws(
      () => planMigration(writeSnapshot(), p2),
      (e) => e instanceof GateError && e.gate === "terms" && /guardTerms\[2\]/.test(e.message) && !e.message.toLowerCase().includes(bad.toLowerCase()),
      bad,
    );
    const p3 = structuredClone(PEOPLE);
    /** @type {any} */ (p3.people.find((p) => p.slug === "kin-1")).names = [bad];
    assert.throws(() => planMigration(writeSnapshot(), p3), (e) => e instanceof GateError && e.gate === "terms" && /people\[2\]\.names\[0\]/.test(e.message), bad);
  }
});

test("C1: the migration stores the folded words, and the database guard then catches every spelling", { skip: SKIP }, async () => {
  const people = structuredClone(PEOPLE);
  people.guardTerms.push({ term: "Wójcik", hiddenFrom: "house-w" }, { term: "Mary Ann", hiddenFrom: "house-w" }, { term: "Anna-Maria", hiddenFrom: "house-w" });
  const db = await freshDb();
  await runMigration(db, planMigration(writeSnapshot(), people));
  const terms = (await db.query("select g.term from private.guard_terms g join public.households h on h.id = g.hidden_from where h.slug = 'house-w' order by 1")).rows.map((r) => r.term);
  assert.deepEqual(terms, ["ann", "anna", "annamaria", "kinword", "maria", "mary", "maryann", "wojcik"]);
  const h = (await db.query("select id from public.households where slug = 'house-w'")).rows[0].id;
  for (const text of ["Wójcik's pierogi", "WOJCIK", "Mary Ann's cake", "Maryann", "Anna-Maria salad"]) {
    assert.equal((await db.query("select private.guard_hit($1::jsonb, array[$2::uuid], null) h", [JSON.stringify({ n: text }), h])).rows[0].h, true, text);
  }
  await db.close();
});

test("C1 (SQL): the database folds a guard term on the way in and refuses one that is not one plain word", { skip: SKIP }, async () => {
  const db = await freshDb();
  await db.exec("insert into public.households (slug) values ('house-g')");
  const h = (await db.query("select id from public.households where slug = 'house-g'")).rows[0].id;
  for (const [raw, stored] of [["Wójcik", "wojcik"], ["ŁUKASZ", "lukasz"], ["Zoë", "zoe"], ["Kоwalski", "kowalski"], ["Strauß", "strauss"]]) {
    await db.query("insert into private.guard_terms values ($1, $2)", [raw, h]);
    assert.equal((await db.query("select count(*)::int n from private.guard_terms where term = $1", [stored])).rows[0].n, 1, raw);
  }
  for (const raw of ["Mary Ann", "O'Brien", "anna-maria", "x2", ...BAD_TERMS]) {
    const e = await errorOf(() => db.query("insert into private.guard_terms values ($1, $2)", [raw, h]));
    assert.ok(e, `refused: ${raw}`);
  }
  // the fold itself: the letters that become two, SQL equals JS
  for (const s of ["ßẞæÆœŒþÞðÐ", "Ærøskøbing Þóra Straße"]) {
    assert.equal((await db.query("select private.guard_fold($1) f", [s])).rows[0].f, fold(s), s);
  }
  // twin parity on every name shape: JS words inserted, SQL hit equals JS hit
  for (const [name, text] of NAME_CASES) {
    await db.query("delete from private.guard_terms");
    for (const w of termWords(name)) await db.query("insert into private.guard_terms values ($1, $2)", [w, h]);
    const sql = (await db.query("select private.guard_hit($1::jsonb, array[$2::uuid], null) h", [JSON.stringify({ n: text }), h])).rows[0].h;
    assert.equal(sql, guardHits({ n: text }, [name]) > 0, name);
    assert.equal(sql, true, name);
  }
  await db.close();
});
