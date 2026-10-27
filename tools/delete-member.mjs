#!/usr/bin/env node
// Mise 2.0 G2: delete a person (Lawyer: a deletion script). Members and
// guests alike; never the admin or the root profile.
//
//   node tools/delete-member.mjs --slug <slug>                 (dry run)
//   node tools/delete-member.mjs --slug <slug> --sql del.sql   (writes the script)
//   psql "<the project's postgres connection string>" -X -v ON_ERROR_STOP=1 -f del.sql
//
// One transaction. It removes: the person's account (auth.users, so their
// sign-in stops at once; admins follows), their profile and with it every row
// they own (targets, health, plans, shopping, occasions, pantry, own recipes),
// their plate, memberships, guest grants and name login, their pending invite
// link, the invites they made, their AI usage counts. An invite they claimed
// keeps its row with the claimed profile cleared. Then it checks nothing of
// theirs is left, or rolls everything back.
//
// It does NOT reach: rows of a HOUSE they edited (house files belong to the
// house), the nightly backups (they age out after 30 days, the retention
// line), and the old mise-data files on GitHub (delete those by hand during
// the 30-day rollback window, or with the repo once it ends).
// Run tools/export-person.mjs first if the person asked for a copy.
import { writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { lit, SLUG, parseArgs } from "./sql-script.mjs";

/** @param {string} slug */
export function deleteMemberSql(slug) {
  if (!SLUG.test(slug)) throw new Error("slug: lowercase letters, digits and dashes, at most 40");
  const s = lit(slug);
  return `-- Mise 2.0 delete-member (tools/delete-member.mjs). One transaction.
begin;
do $del$
declare pid uuid; uid uuid;
begin
  select id, user_id into pid, uid from public.profiles where slug = ${s};
  if pid is null then raise exception 'mise_delete: no such person'; end if;
  if exists (select 1 from private.settings where key in ('root_profile', 'admin_profile') and value = ${s}) then
    raise exception 'mise_delete: refuses the admin and the root profile'; end if;
  delete from public.invites where created_by = pid;
  update public.invites set claimed_profile = null where claimed_profile = pid;
  delete from private.pending_links where profile_id = pid;
  if uid is not null then
    delete from public.ai_usage where user_id = uid;
    delete from auth.users where id = uid;
  end if;
  delete from public.profiles where id = pid;
  update public.roster_rev set rev = rev + 1;
  if exists (select 1 from public.profiles where slug = ${s})
     or exists (select 1 from public.docs where profile_id = pid or starts_with(path, 'profiles/' || ${s} || '/'))
     or exists (select 1 from public.plates where profile_id = pid)
     or exists (select 1 from public.memberships where profile_id = pid)
     or exists (select 1 from public.guest_grants where guest_profile = pid)
     or exists (select 1 from public.guest_logins where profile_id = pid)
     or (uid is not null and exists (select 1 from auth.users where id = uid)) then
    raise exception 'mise_delete: something of theirs is left; rolled back';
  end if;
end $del$;
commit;
`;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (typeof a.slug !== "string") {
    console.log("usage: node tools/delete-member.mjs --slug <slug> [--sql <out.sql>]");
    process.exit(2);
  }
  const sql = deleteMemberSql(a.slug);
  if (typeof a.sql !== "string") {
    console.log("dry run: would delete 1 person, their account and every row they own (never a house's rows); add --sql <file> to write the script");
    console.log("not reached: house files they edited, the 30 nights of encrypted backups, the old mise-data files on GitHub");
    return;
  }
  writeFileSync(a.sql, sql, { mode: 0o600 });
  console.log("wrote the script; run it with psql");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main();
  } catch (e) {
    console.error(String(/** @type {any} */ (e)?.message ?? e));
    process.exit(1);
  }
}
