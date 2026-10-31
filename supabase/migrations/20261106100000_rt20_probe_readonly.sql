-- gate20 Red Team RT20-4: the probe account reads what a member of its house
-- may read, and writes nothing. It only ever needs reads, and its password is
-- a Worker secret, so a write credential need not exist.
create or replace function private.can_write(p text) returns boolean language plpgsql stable security definer set search_path = '' as $$
declare s record; begin
  if exists (select 1 from public.profiles where id = private.my_profile() and kind = 'probe') then
    return false;
  end if;
  s := private.doc_scope(p);
  -- coalesce: a null owner compares to null, and `not null` would let the
  -- writer's refusal fall through to a misleading conflict (plan SQL fix)
  return coalesce(private.is_admin()
      or (s.household_id is not null and s.household_id = any (private.my_households()))
      or (s.profile_id = private.my_profile())
      or (s.kind in ('plan','shopping','occasions') and s.profile_id = any (private.housemates())), false);
exception when others then return false; end $$;
