-- gate20 Red Team RT20-5: a plate no longer hands its reader the git blob sha
-- of the owner's full targets file. That sha is SHA-1 over the whole private
-- file, written by public code in a known format, so with the visible plate it
-- confirms guesses at the owner-only fields offline. The column stays on the
-- table (the migration's verify, the export and the restore read it as the
-- service role); a signed-in client can no longer select it, and plate_for no
-- longer returns it. The app fingerprints a plate by its content hash on every
-- device (supabase-adapter.js plateShaOf).
revoke select on public.plates from authenticated;
grant select (data, rev, content_hash) on public.plates to authenticated;

create or replace function public.plate_for(p_slug text) returns jsonb language sql stable security definer set search_path = '' as $$
select jsonb_build_object('data', pl.data, 'rev', pl.rev, 'content_hash', pl.content_hash)
from public.plates pl join public.profiles p on p.id = pl.profile_id
where p.slug = p_slug
  and ((select private.is_admin()) or pl.profile_id = (select private.my_profile())
       or pl.profile_id = any ((select private.housemates())::uuid[]) or pl.profile_id = any ((select private.visible_guests())::uuid[])) $$;
