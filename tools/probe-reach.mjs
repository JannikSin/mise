// Mise 2.0 G1: what a probe account can reach (plan section 6 step 6, RT N3,
// RT N5). Shared by the migration's verify and by the Worker's weekly probe.
// Assertions only, counts only: a failing check says how many rows, never
// which person.
//
// A reader is anything with
//   select(table): Promise<any[] | "denied">   every row the caller may read
//   rpc(name, args?): Promise<any>
// `restReader` speaks PostgREST with the publishable key and the probe's
// access token (the real probes, the weekly cron). `sqlReader` runs as
// `authenticated` with a stubbed auth.uid() on a local PGlite stand-in.
//
// `expectFor` computes, with a superuser client, what the probe may see. The
// probe kinds of the plan all reduce to the same rules:
//   shared-house probe: its house's rows, housemates' food files, housemates'
//     and live guests' plates; zero targets and health rows, its own included
//   no-house probe: only the bank, global rows and its own rows
//   family-house probe: zero rows of the other house, plates only for housemates
import { PLATE_FIELDS } from "../app/lib/plate-fields.js";

const PEOPLE_TABLES = ["profiles", "households", "memberships", "admins", "roster_rev", "guest_grants", "invites", "guest_logins", "ai_usage"];

/**
 * @typedef {{ select: (table: string) => Promise<any[] | "denied">, rpc: (name: string, args?: Record<string, unknown>) => Promise<any> }} Reader
 * @typedef {{
 *   houses: string[], docProfiles: string[], plateProfiles: string[],
 *   hiddenTerms: string[], allTerms: string[], probeSlugs: string[], familyNull: boolean
 * }} ProbeExpect ids are uuids; terms lowercase
 */

/** @param {unknown} data @param {string[]} terms */
function hit(data, terms) {
  const text = JSON.stringify(data).toLowerCase();
  return terms.some((t) => new RegExp(`(^|[^a-z0-9])${t.replace(/[^a-z0-9-]/g, "")}([^a-z0-9]|$)`).test(text));
}

/**
 * @param {Reader} reader
 * @param {ProbeExpect} expect
 * @returns {Promise<{ check: string, ok: boolean, count: number }[]>}
 */
export async function probeReach(reader, expect) {
  /** @type {{ check: string, ok: boolean, count: number }[]} */
  const out = [];
  const add = (/** @type {string} */ check, /** @type {number} */ count) => out.push({ check, ok: count === 0, count });

  const docs = await reader.select("docs");
  const d = docs === "denied" ? [] : docs;
  add("no targets or health rows", d.filter((r) => r.kind === "targets" || r.kind === "health").length);
  add("house rows only of its houses", d.filter((r) => r.household_id && !expect.houses.includes(r.household_id)).length);
  add("food files only of housemates", d.filter((r) => r.profile_id && !expect.docProfiles.includes(r.profile_id)).length);
  add("no hidden name in docs", d.filter((r) => hit(r.data, expect.hiddenTerms)).length);

  const plates = await reader.select("plates");
  const p = plates === "denied" ? [] : plates;
  add("plates only of housemates and live guests", p.filter((r) => !expect.plateProfiles.includes(r.profile_id)).length);
  add("plate keys within PLATE_FIELDS", p.filter((r) => Object.keys(r.data ?? {}).some((k) => !PLATE_FIELDS.includes(k))).length);
  add("no hidden name on plates", p.filter((r) => hit(r.data, expect.hiddenTerms)).length);

  let peopleRows = 0;
  for (const t of PEOPLE_TABLES) {
    const rows = await reader.select(t);
    if (rows !== "denied") peopleRows += rows.length;
  }
  add("zero rows from the people tables", peopleRows);

  const recipes = await reader.select("recipes");
  const r = recipes === "denied" ? [] : recipes;
  add("no staging recipes", r.filter((x) => x.staging).length);
  add("no name in the bank", r.filter((x) => hit(x.data, expect.allTerms)).length);

  const roster = await reader.rpc("roster");
  const rows = /** @type {any[]} */ (roster?.profiles ?? []);
  add("roster shows no probe", rows.filter((x) => expect.probeSlugs.includes(x.id)).length);
  if (expect.familyNull) add("roster family null for every row", rows.filter((x) => x.family != null).length);
  add("no hidden name in the roster", rows.filter((x) => hit(x, expect.hiddenTerms)).length);
  return out;
}

/**
 * What the probe `slug` may see, read with a superuser client.
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} admin
 * @param {string} slug
 * @returns {Promise<ProbeExpect>}
 */
export async function expectFor(admin, slug) {
  const me = (await admin.query("select id from public.profiles where slug = $1", [slug])).rows[0]?.id;
  if (!me) throw new Error("no such probe");
  const houses = (await admin.query("select household_id from public.memberships where profile_id = $1", [me])).rows.map((r) => r.household_id);
  const mates = (await admin.query(
    "select distinct b.profile_id from public.memberships a join public.memberships b using (household_id) where a.profile_id = $1",
    [me],
  )).rows.map((r) => r.profile_id);
  const guests = (await admin.query(
    "select guest_profile from public.guest_grants where until >= current_date and host_household = any ($1::uuid[])",
    [houses],
  )).rows.map((r) => r.guest_profile);
  const hiddenTerms = (await admin.query("select term from private.guard_terms where hidden_from = any ($1::uuid[])", [houses])).rows.map((r) => r.term);
  const allTerms = (await admin.query("select distinct term from private.guard_terms")).rows.map((r) => r.term);
  const probeSlugs = (await admin.query("select slug from public.profiles where kind = 'probe'")).rows.map((r) => r.slug);
  // family is shown only to members of the house it names; a probe is in none of those unless it shares one
  const familyHouses = (await admin.query("select count(*)::int n from public.households h where h.id = any ($1::uuid[]) and exists (select 1 from public.profiles p where p.family = h.slug)", [houses])).rows[0].n;
  return {
    houses,
    docProfiles: [me, ...mates],
    plateProfiles: [me, ...mates, ...guests],
    hiddenTerms,
    allTerms,
    probeSlugs,
    familyNull: familyHouses === 0,
  };
}

/**
 * A PostgREST reader with the publishable key and a signed-in probe's token.
 * @param {{ url: string, key: string, accessToken: string, fetch?: typeof fetch }} o
 * @returns {Reader}
 */
export function restReader({ url, key, accessToken, fetch: f = fetch }) {
  const headers = { apikey: key, authorization: `Bearer ${accessToken}`, "content-type": "application/json" };
  return {
    async select(table) {
      const res = await f(`${url}/rest/v1/${table}?select=*`, { headers });
      if (res.status === 401 || res.status === 403) return "denied";
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        if (body?.code === "42501") return "denied";
        throw new Error(`probe select ${table}: HTTP ${res.status}`);
      }
      return res.json();
    },
    async rpc(name, args = {}) {
      const res = await f(`${url}/rest/v1/rpc/${name}`, { method: "POST", headers, body: JSON.stringify(args) });
      if (!res.ok) throw new Error(`probe rpc ${name}: HTTP ${res.status}`);
      return res.json();
    },
  };
}

/**
 * A reader that runs as `authenticated` with auth.uid() = `uid` on a local
 * Postgres (the PGlite stand-in). The client must be a superuser connection.
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>, exec: (sql: string) => Promise<unknown> }} db
 * @param {string} uid
 * @returns {Reader}
 */
export function sqlReader(db, uid) {
  /** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  const as = async (fn) => {
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [uid]);
    await db.exec("set role authenticated");
    try {
      return await fn();
    } finally {
      await db.exec("reset role");
      await db.query("select set_config('request.jwt.claim.sub', '', false)");
    }
  };
  return {
    select: (table) =>
      as(async () => {
        try {
          return (await db.query(`select * from public.${table.replace(/[^a-z_]/g, "")}`)).rows;
        } catch (e) {
          if (/permission denied/.test(String(/** @type {any} */ (e)?.message))) return "denied";
          throw e;
        }
      }),
    rpc: (name) => as(async () => (await db.query(`select public.${name.replace(/[^a-z_]/g, "")}() as r`)).rows[0].r),
  };
}
