#!/usr/bin/env node
// Mise 2.0 G2: add a household MEMBER (plan B4: members are created only by
// the migration or this tool; invites are guest-only). Public code, no names:
// the person comes from a local file on David's laptop.
//
//   node tools/add-member.mjs --person person.local.json                (dry run: what it would do, counts only)
//   node tools/add-member.mjs --person person.local.json --sql add.sql  (writes the script)
//   psql "<the project's postgres connection string>" -X -v ON_ERROR_STOP=1 -f add.sql
//   then: node tools/invite.mjs ... --slug <slug> --send   (the invite links the account)
//
// person.local.json:
//   { "slug": "...", "email": "...", "houses": ["<house>", ...], "home": "<house>",
//     "entitled": false, "family": "<house slug or null>",
//     "roster": { "name": "...", "emoji": "..." },
//     "guardTerms": [{ "term": "<word>", "hiddenFrom": "<house>" }] }
//
// The script is one transaction and refuses, before writing, when the slug is
// taken (a profiles row or any docs row under profiles/<slug>/), a house does
// not exist, the email already waits for another profile, the display fields
// carry a word hidden from a house that will see the row, or a new guard term
// already appears somewhere its house can read. A member is never the admin.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { lit, jsonLit, textArray, SLUG, EMAIL, parseArgs } from "./sql-script.mjs";
import { DISPLAY_DROPPED } from "./migrate-to-supabase.mjs";
import { termWords } from "./name-guard.mjs";

/**
 * Check a person file; throws naming the field, never the value.
 * @param {any} p
 */
export function checkPerson(p) {
  if (!p || typeof p !== "object") throw new Error("the person file is not an object");
  if (!SLUG.test(String(p.slug)) || String(p.slug).startsWith("probe-")) throw new Error("slug: lowercase letters, digits and dashes, at most 40, not probe-");
  if (!EMAIL.test(String(p.email ?? ""))) throw new Error("email: not an email address");
  const houses = /** @type {unknown[]} */ (Array.isArray(p.houses) ? p.houses : []);
  if (!houses.length || !houses.every((h) => SLUG.test(String(h)))) throw new Error("houses: one or more house slugs");
  const home = p.home ?? houses[0];
  if (!houses.includes(home)) throw new Error("home: must be one of houses");
  if (p.family != null && !SLUG.test(String(p.family))) throw new Error("family: a slug or null");
  const roster = p.roster ?? {};
  if (!roster || typeof roster !== "object" || Array.isArray(roster)) throw new Error("roster: an object of display fields");
  if (Object.keys(roster).some((k) => DISPLAY_DROPPED.includes(k))) throw new Error(`roster: may not carry ${DISPLAY_DROPPED.join(", ")}`);
  const terms = /** @type {any[]} */ (p.guardTerms ?? []);
  // fix loop 2 C1: a term is folded as the text is and split into words
  /** @type {{ term: string, hiddenFrom: string }[]} */
  const words = [];
  for (const t of terms) {
    if (!SLUG.test(String(t?.hiddenFrom))) throw new Error("guardTerms: {term, hiddenFrom} with a name or word and a house slug");
    try {
      for (const w of termWords(String(t?.term ?? ""))) words.push({ term: w, hiddenFrom: String(t.hiddenFrom) });
    } catch {
      throw new Error("guardTerms: a term must fold to plain letters a to z, with a word of 2 to 40 letters");
    }
  }
  return {
    slug: String(p.slug),
    email: String(p.email).toLowerCase(),
    houses: houses.map(String),
    home: String(home),
    entitled: p.entitled === true,
    family: p.family == null ? null : String(p.family),
    roster,
    guardTerms: words.filter((w, i) => words.findIndex((x) => x.term === w.term && x.hiddenFrom === w.hiddenFrom) === i),
  };
}

/** @param {ReturnType<typeof checkPerson>} p @returns {string} */
export function addMemberSql(p) {
  const s = lit(p.slug);
  const terms = p.guardTerms
    .map((t) => `insert into private.guard_terms select ${lit(t.term)}, h.id from public.households h where h.slug = ${lit(t.hiddenFrom)} on conflict do nothing;`)
    .join("\n");
  const allHouses = [...new Set([...p.houses, ...p.guardTerms.map((t) => t.hiddenFrom)])];
  return `-- Mise 2.0 add-member (tools/add-member.mjs). One transaction. Holds a person's details: delete after use.
begin;
do $check$ begin
  if not svc.slug_free(${s}) then raise exception 'mise_add_member: the slug is taken'; end if;
  if (select count(*) from public.households where slug = any (${textArray(allHouses)})) <> ${allHouses.length} then
    raise exception 'mise_add_member: a house does not exist'; end if;
  if exists (select 1 from private.pending_links where email = ${lit(p.email)}) then
    raise exception 'mise_add_member: that email already waits for another profile'; end if;
  if (select sum(v::int) from jsonb_each_text(svc.guard_hits()) x(k, v)) <> 0 then
    raise exception 'mise_add_member: the guard already finds hidden words; fix those first'; end if;
end $check$;
insert into public.profiles (slug, kind, home_household, family, roster, entitled, sort_order)
  select ${s}, 'member', (select id from public.households where slug = ${lit(p.home)}), ${p.family == null ? "null" : lit(p.family)},
         ${jsonLit(p.roster)}, ${p.entitled}, coalesce((select max(sort_order) from public.profiles), 0) + 1;
insert into public.memberships select p.id, h.id from public.profiles p, public.households h
  where p.slug = ${s} and h.slug = any (${textArray(p.houses)});
${terms}
insert into private.pending_links select ${lit(p.email)}, id from public.profiles where slug = ${s};
do $check$ begin
  if private.guard_hit((select roster from public.profiles where slug = ${s}), private.plate_audience((select id from public.profiles where slug = ${s}))) then
    raise exception 'mise_add_member: the display fields carry a word hidden from a house that sees this person'; end if;
  if (select sum(v::int) from jsonb_each_text(svc.guard_hits()) x(k, v)) <> 0 then
    raise exception 'mise_add_member: a new guard term already appears where its house reads; scrub it first'; end if;
end $check$;
update public.profiles pr set user_id = u.id from auth.users u
  where pr.slug = ${s} and pr.user_id is null and lower(u.email) = ${lit(p.email)} and u.email_confirmed_at is not null;
update public.roster_rev set rev = rev + 1;
commit;
`;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (typeof a.person !== "string") {
    console.log("usage: node tools/add-member.mjs --person <person.local.json> [--sql <out.sql>]");
    process.exit(2);
  }
  const p = checkPerson(JSON.parse(readFileSync(a.person, "utf8")));
  if (typeof a.sql !== "string") {
    console.log(`dry run: would add 1 member to ${p.houses.length} house(s), with ${p.guardTerms.length} new guard term(s); add --sql <file> to write the script`);
    return;
  }
  writeFileSync(a.sql, addMemberSql(p), { mode: 0o600 });
  console.log("wrote the script; run it with psql, then send the invite with tools/invite.mjs, then delete the script");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main();
  } catch (e) {
    console.error(String(/** @type {any} */ (e)?.message ?? e));
    process.exit(1);
  }
}
