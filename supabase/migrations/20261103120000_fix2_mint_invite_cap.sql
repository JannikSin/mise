-- Mise 2.0, db fix loop 2, item 7 (Red Team verify 2, N8). A replacement
-- only. svc.mint_invite accepted any future expiry (an invite valid until
-- 9999-01-01 came back 'ok'). Now an expiry more than 30 days out is
-- 'forbidden', server side, whatever the caller sends (the Worker mints 7
-- days, INVITE_TTL_MS).
create or replace function svc.mint_invite(p_sub uuid, p_code_hash text, p_host_house text, p_expires_at timestamptz) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare me record; hid uuid; n int;
begin
  select p.id, p.kind, p.entitled into me from public.profiles p where p.user_id = p_sub;
  select h.id into hid from public.households h where h.slug = p_host_house;
  if me.id is null or hid is null or me.kind <> 'member' or p_expires_at is null or p_expires_at <= now()
     or p_expires_at > now() + interval '30 days'
     or coalesce(p_code_hash, '') = '' then
    return 'forbidden';
  end if;
  if not (exists (select 1 from public.admins a where a.user_id = p_sub)
          or (me.entitled and exists (select 1 from public.memberships m where m.profile_id = me.id and m.household_id = hid))) then
    return 'forbidden';
  end if;
  insert into public.invites (code_hash, host_household, created_by, expires_at)
    values (p_code_hash, hid, me.id, p_expires_at) on conflict do nothing;
  get diagnostics n = row_count;
  return case when n = 1 then 'ok' else 'forbidden' end;
end $$;
