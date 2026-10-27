// Mise 2.0 db fix loop 2 (Red Team verify 2, terrigen-db-fixlist-2.md): the
// verify probes (scratchpad redteam-db-v2: g-guard, s-safety-svc,
// m-migrate-tools) as regression cases. Made-up names only; the names below
// are common name SHAPES (an accent, a stroke letter, two words, an
// apostrophe, a diaeresis, mixed scripts), not anyone in the app.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { freshDb, errorOf, asUser, asRole, SKIP } from "./_pglite.js";
import { world } from "./_world.js";
import { PEOPLE, writeSnapshot } from "./_snapshot.js";
import { planMigration, runMigration, GateError } from "../tools/migrate-to-supabase.mjs";
import { fold, guardHits, termWords, TermError } from "../tools/name-guard.mjs";
import { takeSnapshot, SNAPSHOT_TABLES } from "../tools/db-snapshot.mjs";

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

// ---- item 2 (C2, N2): guest_view names only people the host house can see

/** Run a svc function as service_role. @param {any} db @param {string} sql */
async function svcOne(db, sql) {
  return asRole(db, "service_role", async () => (await db.query(sql)).rows[0]);
}

test("C2 probe V: a house-w member seats a family-house member at a guest's table; guest_view does not name them", { skip: SKIP }, async () => {
  const { db, uid } = await world();
  const p = "households/house-w/events.json";
  const rev = (await db.query("select rev from public.docs where path = $1", [p])).rows[0].rev;
  const ev = { tables: [{ id: "t-a", seats: [{ id: "guest-1" }, { id: "mate-1" }, { id: "kin-1" }, { id: "guest-2" }, { id: "owner-1" }] }] };
  const e = await errorOf(() => asUser(db, uid["mate-1"], () => db.query("select public.write_doc($1, $2::jsonb, $3)", [p, JSON.stringify(ev), rev])));
  assert.equal(e, null, "the write itself is allowed (a seat is a slug)");
  const names = (await svcOne(db, "select svc.guest_view('guest-1') v")).v.names;
  // members of house-w and the guest it holds a live grant for; not kin-1
  // (house-f only), not guest-2 (a lapsed grant, and to house-f)
  assert.deepEqual(names, { "guest-1": "Guest A", "mate-1": "Mate", "owner-1": "Owner" });
  const seen = (await asUser(db, uid["mate-1"], () => db.query("select public.roster() r"))).rows[0].r.profiles.map((/** @type {any} */ r) => r.id);
  for (const slug of Object.keys(names)) assert.ok(seen.includes(slug), `${slug} is in mate-1's roster too`);
  // a second guest with a LIVE grant to house-w is named
  await db.exec(`insert into public.guest_grants select p.id, h.id, '2999-01-01' from public.profiles p, public.households h where p.slug = 'guest-2' and h.slug = 'house-w'`);
  assert.equal((await svcOne(db, "select svc.guest_view('guest-1') v")).v.names["guest-2"], "Guest B");
  await db.close();
});

// ---- item 3 (C3, N6): the backup workflow pins the code and keeps secrets out of its steps

const WORKFLOW = readFileSync(new URL("../.github/workflows/mise-backup.yml", import.meta.url), "utf8");
/** The workflow's steps: [name, body]. @param {string} y */
function stepsOf(y) {
  return y
    .split(/^ {6}- name: /m)
    .slice(1)
    .map((b) => /** @type {[string, string]} */ ([b.slice(0, b.indexOf("\n")), b]));
}

test("C3: the public code is pinned to a full commit SHA, refused when absent, never a branch default", () => {
  assert.doesNotMatch(WORKFLOW, /\|\|\s*'main'/, "no default branch");
  assert.match(WORKFLOW, /\[\[ "\$\{CODE_SHA\}" =~ \^\[0-9a-f\]\{40\}\$ \]\]/);
  assert.match(WORKFLOW, /ref: \$\{\{ steps\.pin\.outputs\.sha \}\}/);
  // every action is pinned by commit SHA
  const uses = [...WORKFLOW.matchAll(/uses: (\S+)/g)].map((m) => m[1]);
  assert.ok(uses.length >= 1);
  for (const u of uses) assert.match(String(u), /@[0-9a-f]{40}$/, u);
  // the pin step's check refuses what it should (run the same test in bash)
  const check = (/** @type {string} */ v) => spawnSync("bash", ["-c", `CODE_SHA="${v}"; [[ "\${CODE_SHA}" =~ ^[0-9a-f]{40}$ ]]`]).status;
  assert.equal(check("0123456789abcdef0123456789abcdef01234567"), 0);
  for (const bad of ["", "main", "v2.0", "0123456789abcdef", "0123456789ABCDEF0123456789ABCDEF01234567"]) assert.notEqual(check(bad), 0, bad);
});

test("C3: only the dump step sees the database URL; public code runs only before it, with no secret, and is removed", () => {
  const steps = stepsOf(WORKFLOW);
  const withUrl = steps.filter(([, b]) => b.includes("MISE_BACKUP_DB_URL")).map(([n]) => n);
  assert.deepEqual(withUrl, ["Dump (the only step with the database URL)"]);
  const dump = steps.findIndex(([n]) => n.startsWith("Dump"));
  const withSecrets = steps.filter(([, b]) => /secrets\./.test(b)).map(([n]) => n);
  assert.deepEqual(withSecrets, ["Dump (the only step with the database URL)", "Encrypt, then shred the plaintext", "Alert the phone (no data in the message)"]);
  steps.forEach(([n, b], i) => {
    if (/node mise\/|uses: actions\/checkout/.test(b)) {
      assert.ok(i < dump, `${n} runs before the dump`);
      assert.doesNotMatch(b, /secrets\./, n);
    }
  });
  assert.ok(steps.slice(0, dump).some(([, b]) => b.includes("rm -rf mise")), "the public code is deleted before the URL appears");
  assert.ok(steps.slice(dump).every(([, b]) => !/node mise\//.test(b)), "no public code after the dump");
  assert.doesNotMatch(WORKFLOW, /^ {4}env:/m, "no job-level env");
});

test("C3: the plaintext lives only on tmpfs and is shredded, also after a failure", () => {
  const plain = [...WORKFLOW.matchAll(/(\S*)plain\.json/g)].map((m) => m[1]);
  assert.ok(plain.length >= 3);
  for (const p of plain) assert.match(String(p), /^(-o )?\/dev\/shm\/mise-backup\/$/, p);
  assert.match(WORKFLOW, /test "\$\(findmnt -n -o FSTYPE --target \/dev\/shm\)" = "tmpfs"/);
  const steps = stepsOf(WORKFLOW);
  const enc = steps.find(([n]) => n.startsWith("Encrypt"))?.[1] ?? "";
  assert.ok(enc.indexOf("age -r") < enc.indexOf("shred -u /dev/shm/mise-backup/plain.json"));
  const last = steps.find(([n]) => n.startsWith("Shred any plaintext"))?.[1] ?? "";
  assert.match(last, /if: always\(\)/);
  assert.match(last, /shred -u/);
});

/** The workflow's own counts check, as a python program. */
function checkScript() {
  const lines = WORKFLOW.split("\n");
  const a = lines.findIndex((l) => l.includes("# mise-backup check: begin"));
  const b = lines.findIndex((l) => l.includes("# mise-backup check: end"));
  const indent = /** @type {string} */ (lines[a]).match(/^ */)?.[0].length ?? 0;
  return lines
    .slice(a, b + 1)
    .map((l) => l.slice(indent))
    .join("\n");
}
const PY = ["python3", "python"].find((p) => spawnSync(p, ["-c", "import json"]).status === 0) ?? null;

test("C3: the workflow's own check passes a real snapshot, prints counts only, and refuses a broken one", { skip: SKIP || (PY ? false : "no python here") }, async () => {
  const db = await freshDb();
  await runMigration(db, planMigration(writeSnapshot(), PEOPLE));
  const snap = await takeSnapshot(db);
  await db.close();
  const dir = mkdtempSync(path.join(tmpdir(), "mise-c3-"));
  const tables = path.join(dir, "tables.txt");
  writeFileSync(tables, SNAPSHOT_TABLES.map(([t]) => `${t}\n`).join(""));
  const script = path.join(dir, "check.py");
  writeFileSync(script, checkScript());
  const run = (/** @type {unknown} */ s) => {
    const f = path.join(dir, "plain.json");
    writeFileSync(f, typeof s === "string" ? s : JSON.stringify(s));
    return spawnSync(/** @type {string} */ (PY), [script, tables, f], { encoding: "utf8" });
  };
  const ok = run(snap);
  assert.equal(ok.status, 0, ok.stderr);
  const lines = ok.stdout.trim().split(/\r?\n/);
  assert.equal(lines.length, SNAPSHOT_TABLES.length);
  for (const l of lines) assert.match(l, /^[a-z_]+\.[a-z_]+ \d+$/, "counts only");
  const noDocs = structuredClone(snap);
  noDocs.tables["public.docs"] = [];
  const noTable = structuredClone(snap);
  delete noTable.tables["private.guard_terms"];
  for (const bad of ["not json", { ...snap, format: "other" }, noDocs, noTable]) assert.notEqual(run(bad).status, 0);
  rmSync(dir, { recursive: true, force: true });
});
