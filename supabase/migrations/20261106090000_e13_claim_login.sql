-- E13 (2.0 open item): the guest's name login is saved INSIDE the claim. It
-- used to be a second call after the invite was spent, so a failed or raced
-- login save left a guest with a spent link and no way to sign in ("ask for a
-- new link"). Now a taken name raises P0410 and the whole claim rolls back:
-- the invite stays unused and the guest can pick another name. A claim with
-- no login (p_login null) behaves exactly as before.
drop function svc.claim_guest(text, text, jsonb, jsonb, date);
create function svc.claim_guest(p_code_hash text, p_slug text, p_roster jsonb, p_targets jsonb, p_until date,
  p_login jsonb default null)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare inv record; pid uuid;
begin
  select * into inv from public.invites where code_hash = p_code_hash for update;
  if inv is null or inv.used_at is not null or inv.expires_at <= now() then
    raise exception 'mise_invite_invalid' using errcode = 'P0403';
  end if;
  if not svc.slug_free(p_slug) then raise exception 'mise_conflict' using errcode = 'P0409'; end if;
  if private.guard_hit(coalesce(p_roster, '{}'::jsonb) - 'id', array[inv.host_household]) then
    raise exception 'mise_name_guard' using errcode = 'P0422';
  end if;
  if p_login is not null and (coalesce(p_login->>'name_key', '') = '' or coalesce(p_login->>'salt', '') = ''
      or coalesce(p_login->>'hash', '') = '') then
    raise exception 'mise_login_invalid' using errcode = 'P0400';
  end if;
  insert into public.profiles (slug, kind, roster) values (p_slug, 'guest', coalesce(p_roster, '{}'::jsonb) - 'id')
    returning id into pid;
  insert into public.guest_grants (guest_profile, host_household, until) values (pid, inv.host_household, p_until);
  insert into public.docs (path, data) values
    ('profiles/' || p_slug || '/profile/targets.json', p_targets),
    ('profiles/' || p_slug || '/fitness/targets.json', p_targets);
  if p_login is not null then
    begin
      insert into public.guest_logins (profile_id, name_key, salt, hash)
        values (pid, p_login->>'name_key', p_login->>'salt', p_login->>'hash');
    exception when unique_violation then
      raise exception 'mise_login_taken' using errcode = 'P0410';
    end;
  end if;
  -- the guest's status page lives 60 days (the Worker's INVITE_STATUS_TTL_MS; fix list item 12)
  update public.invites set used_at = now(), claimed_profile = pid, status_until = now() + interval '60 days'
   where code_hash = p_code_hash;
  update public.roster_rev set rev = rev + 1;
  return pid;
end $$;

revoke execute on function svc.claim_guest(text, text, jsonb, jsonb, date, jsonb) from public, anon, authenticated;
grant execute on function svc.claim_guest(text, text, jsonb, jsonb, date, jsonb) to service_role;
