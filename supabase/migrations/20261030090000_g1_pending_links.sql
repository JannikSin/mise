-- Mise 2.0, G1: pending links. The migration creates no auth users; it writes
-- each person's invite email into private.pending_links. When an invite
-- creates the auth user (tools/invite.mjs), this trigger links it to its
-- profile, and makes it the admin when that profile is the admin profile
-- named in private.settings ('admin_profile', written by the migration).
-- An email with no pending link links to nothing: sign-ups stay closed (B2).
create function private.link_pending() returns trigger language plpgsql security definer set search_path = '' as $$
declare pid uuid;
begin
  select l.profile_id into pid from private.pending_links l where lower(l.email) = lower(new.email);
  if pid is null then return null; end if;
  update public.profiles set user_id = new.id where id = pid and user_id is null;
  if exists (select 1 from public.profiles p join private.settings s on s.key = 'admin_profile' and s.value = p.slug
             where p.id = pid and p.user_id = new.id) then
    insert into public.admins (user_id) values (new.id) on conflict do nothing;
  end if;
  return null;
end $$;
create trigger link_pending after insert on auth.users for each row execute function private.link_pending();

revoke execute on all functions in schema private from public, anon;
grant execute on all functions in schema private to authenticated;
