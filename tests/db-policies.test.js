// Mise 2.0 B3: the policy go/no-go (plan section 8, Tue 10/27). Every person
// in the made-up world reads and writes the database under SET ROLE
// authenticated with a stubbed auth.uid(), and what they reach is compared,
// row by row, with an oracle written from the rules (decision 1: plate cards
// for everyone, the family house included; full profiles for the admin only).
//
// The NEGATIVE CONTROL is the point of the suite: a deliberately leaky policy
// is added, and the same comparison must catch it. A suite that cannot fail
// proves nothing about the policies it passes.
import test from "node:test";
import assert from "node:assert/strict";
import { asUser, asRole, errorOf, SKIP } from "./_pglite.js";
import { world, PEOPLE } from "./_world.js";

/**
 * Every place a policy decides, for every person: the rows they should and do
 * reach. Returns the differences, empty when the policies match the rules.
 * @param {any} db
 * @param {Record<string, string>} uid
 * @returns {Promise<string[]>}
 */
async function reachViolations(db, uid) {
  const docs = (await db.query(
    `select d.path, d.kind, p.slug as owner, h.slug as house
       from public.docs d left join public.profiles p on p.id = d.profile_id
       left join public.households h on h.id = d.household_id`,
  )).rows;
  const members = (await db.query(
    "select p.slug, h.slug as house from public.memberships m join public.profiles p on p.id = m.profile_id join public.households h on h.id = m.household_id",
  )).rows;
  const grants = (await db.query(
    "select p.slug, h.slug as house from public.guest_grants g join public.profiles p on p.id = g.guest_profile join public.households h on h.id = g.host_household where g.until >= current_date",
  )).rows;
  const plateOwners = (await db.query("select p.slug from public.plates pl join public.profiles p on p.id = pl.profile_id")).rows.map((/** @type {any} */ r) => r.slug);
  const recipes = (await db.query("select id, staging from public.recipes")).rows;

  const housesOf = (/** @type {string} */ s) => members.filter((/** @type {any} */ m) => m.slug === s).map((/** @type {any} */ m) => m.house);
  const shareHouse = (/** @type {string} */ a, /** @type {string} */ b) => housesOf(a).some((h) => housesOf(b).includes(h));
  const isAdmin = (/** @type {string} */ s) => s === "owner-1";

  // the rules, written out (SCHEMAS.md "Who reads what")
  const canRead = (/** @type {string} */ me, /** @type {any} */ d) => {
    if (isAdmin(me)) return true;
    if (d.house) return housesOf(me).includes(d.house);
    if (d.kind === "global") return true;
    if (d.kind === "targets" || d.kind === "health") return d.owner === me;
    return d.owner === me || shareHouse(me, d.owner);
  };
  const canWrite = (/** @type {string} */ me, /** @type {any} */ d) => {
    if (isAdmin(me)) return true;
    if (d.house) return housesOf(me).includes(d.house);
    if (d.owner === me) return true;
    return ["plan", "shopping", "occasions"].includes(d.kind) && shareHouse(me, d.owner);
  };
  const canSeePlate = (/** @type {string} */ me, /** @type {string} */ owner) =>
    isAdmin(me) ||
    owner === me ||
    shareHouse(me, owner) ||
    grants.some((/** @type {any} */ g) => g.slug === owner && housesOf(me).includes(g.house));

  /** @type {string[]} */
  const out = [];
  /** @param {string} what @param {string[]} want @param {string[]} got */
  const diff = (what, want, got) => {
    for (const x of got) if (!want.includes(x)) out.push(`LEAK ${what}: ${x}`);
    for (const x of want) if (!got.includes(x)) out.push(`MISSING ${what}: ${x}`);
  };

  for (const me of PEOPLE) {
    await asUser(db, uid[me], async () => {
      const seen = (await db.query("select path from public.docs")).rows.map((/** @type {any} */ r) => r.path);
      diff(`${me} reads docs`, docs.filter((d) => canRead(me, d)).map((d) => d.path), seen);

      const plates = (await db.query("select profile_id from public.plates")).rows.length;
      const viaRpc = [];
      for (const owner of plateOwners) {
        if ((await db.query("select public.plate_for($1) as p", [owner])).rows[0].p) viaRpc.push(owner);
      }
      const wantPlates = plateOwners.filter((o) => canSeePlate(me, o));
      diff(`${me} reads plates (plate_for)`, wantPlates, viaRpc);
      if (plates !== wantPlates.length) out.push(`LEAK or MISSING ${me} plates table: ${plates} rows, want ${wantPlates.length}`);

      const rs = (await db.query("select id from public.recipes")).rows.map((/** @type {any} */ r) => r.id);
      diff(`${me} reads bank`, recipes.filter((/** @type {any} */ r) => !r.staging || isAdmin(me)).map((/** @type {any} */ r) => r.id), rs);

      // direct table update: RLS silently filters what a policy refuses
      /** @type {string[]} */
      const wrote = [];
      for (const d of docs) {
        await db.exec("begin");
        try {
          const r = await db.query("update public.docs set data = data where path = $1", [d.path]);
          if (r.affectedRows === 1) wrote.push(d.path);
        } catch {
          // a trigger refusal counts as not written
        } finally {
          await db.exec("rollback");
        }
      }
      diff(`${me} updates docs`, docs.filter((d) => canWrite(me, d)).map((d) => d.path), wrote);
    });
  }
  return out;
}

test("policy go/no-go: every person reaches exactly what the rules allow", { skip: SKIP }, async () => {
  const { db, uid } = await world();
  assert.deepEqual(await reachViolations(db, uid), []);
  await db.close();
});

test("anon (the publishable key with no session) reaches nothing", { skip: SKIP }, async () => {
  const { db } = await world();
  for (const q of ["select * from public.docs", "select * from public.plates", "select * from public.recipes", "select public.roster()", "select public.plate_for('owner-1')", "select public.write_doc('shopping.json', '{}'::jsonb, null)"]) {
    const e = await asRole(db, "anon", () => errorOf(() => db.query(q)));
    assert.match(e?.message ?? "", /permission denied/, q);
  }
  await db.close();
});

test("decision 1 in plain terms: housemates get the plate, never the full targets", { skip: SKIP }, async () => {
  const { db, uid } = await world();
  /** @param {string} who @param {string} path */
  const reads = async (who, path) =>
    (await asUser(db, uid[who], () => db.query("select count(*)::int n from public.docs where path = $1", [path]))).rows[0].n;
  // the family house: each other's plate cards, not full profiles
  assert.equal(await reads("kin-1", "profiles/kin-2/profile/targets.json"), 0);
  assert.equal(await reads("kin-1", "profiles/kin-2/fitness/targets.json"), 0);
  assert.equal(await reads("kin-1", "profiles/kin-2/health/vitals.json"), 0);
  // the shared house: the admin's plate, not his targets
  assert.equal(await reads("mate-1", "profile/targets.json"), 0);
  // the admin sees full profiles
  assert.equal(await reads("owner-1", "profiles/kin-2/profile/targets.json"), 1);
  await db.close();
});

/** Leaky policies, each one a mistake that could plausibly be made. */
const LEAKS = [
  [
    "full targets to housemates (decision 1 broken)",
    `create policy leak on public.docs for select to authenticated using (kind in ('targets','health') and profile_id = any ((select private.housemates())::uuid[]))`,
  ],
  ["plates to everyone signed in", `create policy leak on public.plates for select to authenticated using (true)`],
  ["every house's rows to everyone", `create policy leak on public.docs for select to authenticated using (household_id is not null)`],
  ["staging to everyone", `create policy leak on public.recipes for select to authenticated using (staging)`],
  [
    "housemates may update each other's targets",
    `create policy leak on public.docs for update to authenticated using (profile_id = any ((select private.housemates())::uuid[])) with check (true)`,
  ],
  [
    "plate_for without the house check",
    `create or replace function public.plate_for(p_slug text) returns jsonb language sql stable security definer set search_path = '' as $$
       select jsonb_build_object('data', pl.data) from public.plates pl join public.profiles p on p.id = pl.profile_id where p.slug = p_slug $$`,
  ],
];

for (const [name, sql] of LEAKS) {
  test(`negative control: the suite catches a leaky policy (${name})`, { skip: SKIP }, async () => {
    const { db, uid } = await world();
    await db.exec(sql);
    const v = await reachViolations(db, uid);
    assert.ok(v.length > 0, `the leak "${name}" went unnoticed`);
    assert.ok(v.every((x) => x.startsWith("LEAK")), v.join("\n"));
    await db.close();
  });
}
