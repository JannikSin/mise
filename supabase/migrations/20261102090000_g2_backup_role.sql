-- Mise 2.0, G2: the read-only `mise_backup` role for the nightly backup and
-- the keep-alive (plan section 3; RT M6: the backup uses a read-only DB role,
-- not the secret key).
--
-- The role is created WITHOUT login. David turns login on with a password in
-- step 10 (`node tools/backup-setup.mjs role-sql` prints the one statement to
-- paste, with a fresh random password, and the connection string for the
-- Actions secret). It reads every table the snapshot carries
-- (tools/db-snapshot.mjs SNAPSHOT_TABLES) and writes nothing.
--
-- Row level security: Supabase may refuse BYPASSRLS to a custom role (plan,
-- "What I could not verify"), so the role gets a select policy on every RLS
-- table instead. tests/backup.test.js checks the role reads every row of
-- every snapshot table and can write none.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'mise_backup') then
    create role mise_backup nologin noinherit;
  end if;
end $$;

grant usage on schema public, private to mise_backup;
grant select on
  public.households, public.profiles, public.memberships, public.admins, public.roster_rev,
  public.recipes, public.docs, public.plates, public.guest_grants, public.invites,
  public.guest_logins, public.ai_usage,
  private.settings, private.pending_links, private.guard_terms
  to mise_backup;

create policy backup_read on public.households   for select to mise_backup using (true);
create policy backup_read on public.profiles     for select to mise_backup using (true);
create policy backup_read on public.memberships  for select to mise_backup using (true);
create policy backup_read on public.admins       for select to mise_backup using (true);
create policy backup_read on public.roster_rev   for select to mise_backup using (true);
create policy backup_read on public.recipes      for select to mise_backup using (true);
create policy backup_read on public.docs         for select to mise_backup using (true);
create policy backup_read on public.plates       for select to mise_backup using (true);
create policy backup_read on public.guest_grants for select to mise_backup using (true);
create policy backup_read on public.invites      for select to mise_backup using (true);
create policy backup_read on public.guest_logins for select to mise_backup using (true);
create policy backup_read on public.ai_usage     for select to mise_backup using (true);
