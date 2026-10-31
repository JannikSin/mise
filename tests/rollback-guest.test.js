// gate20 Engineer E2 (fixed): the rollback export writes a 2.0-claimed guest,
// and an edited 1.95 guest, into profiles.json WITHOUT household
// "guesthouse"; 1.95 reads an absent household as "home".
import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { planMigration, runMigration } from "../tools/migrate-to-supabase.mjs";
import { takeSnapshot } from "../tools/db-snapshot.mjs";
import { exportInto, serialize } from "../tools/export-from-supabase.mjs";
import { visibleProfilesFor } from "../app/lib/privacy.js";
import { freshDb, SKIP } from "./_pglite.js";
import { PEOPLE, writeSnapshot } from "./_snapshot.js";

test("E2: rollback keeps a guest a guest", { skip: SKIP }, async () => {
  const src = writeSnapshot((f) => {
    const p = /** @type {any} */ (f["profiles.json"]).profiles;
    p.find((/** @type {any} */ r) => r.id === "guest-1").household = "guesthouse";
    // the family house is 1.95's default "home"
    const k = p.find((/** @type {any} */ r) => r.id === "kin-1"); k.household = "home"; k.family = "home";
    for (const key of Object.keys(f)) if (key.startsWith("households/house-f/")) { f[key.replace("house-f", "home")] = f[key]; delete f[key]; }
  });
  const people = structuredClone(PEOPLE);
  people.houses = ["house-w", "home"];
  for (const x of people.people) x.houses = x.houses?.map((/** @type {string} */ h) => (h === "house-f" ? "home" : h));
  people.guardTerms = [];
  const db = await freshDb();
  // the fixture's family files live under house-f; move them to home
  const plan = planMigration(src, people);
  await runMigration(db, plan);
  // 2.0 life: house-w mints an invite, a guest claims it; guest-1 renames themself
  const owner = (await db.query("select id from public.profiles where slug='owner-1'")).rows[0].id;
  await db.query("insert into public.invites (code_hash, host_household, created_by, expires_at) select 'c1', id, $1, now() + interval '1 day' from public.households where slug='house-w'", [owner]);
  await db.query("select svc.claim_guest('c1', 'guest-2', '{\"name\":\"Guest Two\"}', '{\"diet\":\"vegan\",\"body\":{\"weightLb\":150}}', '2999-01-01')");
  await db.query("update public.profiles set roster = roster || '{\"emoji\":\"y\"}' where slug = 'guest-1'");
  const snap = await takeSnapshot(db);
  const dir = mkdtempSync(path.join(tmpdir(), "rb-"));
  cpSync(src, dir, { recursive: true });
  writeFileSync(path.join(dir, "freeze.json"), serialize({ frozen: true }));
  exportInto(snap, dir, { write: true, requireFreeze: true });
  const prof = JSON.parse(readFileSync(path.join(dir, "profiles.json"), "utf8")).profiles;
  const g1 = prof.find((/** @type {any} */ r) => r.id === "guest-1");
  const g2 = prof.find((/** @type {any} */ r) => r.id === "guest-2");
  // what a family-house (home) member's 1.95 phone shows
  const seen = visibleProfilesFor(prof, "kin-1", [], "2026-11-01").map((/** @type {any} */ r) => r.id);
  assert.equal(g1?.household, "guesthouse", "edited 1.95 guest keeps guesthouse");
  assert.equal(g2?.household, "guesthouse", "2.0 guest of house-w is a guesthouse row");
  assert.ok(!seen.includes("guest-2"), "the family house does not see house-w's guest");
});
