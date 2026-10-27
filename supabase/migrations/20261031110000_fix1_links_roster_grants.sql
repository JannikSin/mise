-- Mise 2.0, db fix loop 1, items 3 to 7 (Red Team F4, F5, F6, F9).
--
-- F4: an invite links its profile only once the email is CONFIRMED. A bare
-- auth.users insert (open sign-ups, or "confirm email" off) used to link the
-- admin profile and make it admin. Deploy gate, written in docs/SCHEMAS.md:
-- sign-ups OFF and confirm email ON in every project.
-- F5: roster display fields go through the name guard, for the houses that
-- can see the row (patch_roster, svc.claim_guest; the migration's preflight
-- does the same for profiles.json).
-- F6: authenticated may execute only the private helpers its policies and the
-- invoker write_doc call. Deploy gate: `private` is never an exposed schema.

-- F4
create or replace function private.link_pending() returns trigger language plpgsql security definer set search_path = '' as $$
declare pid uuid;
begin
  if new.email_confirmed_at is null then return null; end if;
  select l.profile_id into pid from private.pending_links l where lower(l.email) = lower(new.email);
  if pid is null then return null; end if;
  update public.profiles set user_id = new.id where id = pid and user_id is null;
  if exists (select 1 from public.profiles p join private.settings s on s.key = 'admin_profile' and s.value = p.slug
             where p.id = pid and p.user_id = new.id) then
    insert into public.admins (user_id) values (new.id) on conflict do nothing;
  end if;
  return null;
end $$;
drop trigger link_pending on auth.users;
create trigger link_pending after insert or update of email_confirmed_at on auth.users
  for each row execute function private.link_pending();

-- F5: patch_roster, as B2 plus the guard on the new display fields
create or replace function private.patch_roster(p_data jsonb, p_expected_rev bigint) returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_rev bigint; cur jsonb; inc jsonb; vis jsonb; newr jsonb; oldr jsonb; pid uuid;
  me uuid := private.my_profile(); adm boolean := private.is_admin(); changed boolean := false;
begin
  if me is null and not adm then raise exception 'mise_forbidden' using errcode = 'P0403'; end if;
  select rev into v_rev from public.roster_rev for update;
  if p_expected_rev is null or v_rev <> p_expected_rev then raise exception 'mise_conflict' using errcode = 'P0409'; end if;
  if jsonb_typeof(p_data->'profiles') is distinct from 'array' then raise exception 'mise_forbidden' using errcode = 'P0403'; end if;
  cur := public.roster()->'profiles';
  for inc in select x from jsonb_array_elements(p_data->'profiles') x loop
    select e into vis from jsonb_array_elements(cur) e where e->>'id' = inc->>'id';
    if vis is null or jsonb_typeof(inc) <> 'object' then raise exception 'mise_forbidden' using errcode = 'P0403'; end if;
    if coalesce(inc->'household', 'null') <> coalesce(vis->'household', 'null')
       or coalesce(inc->'family', 'null') <> coalesce(vis->'family', 'null')
       or coalesce(inc->'admin', 'false') <> coalesce(vis->'admin', 'false') then
      raise exception 'mise_forbidden' using errcode = 'P0403';
    end if;
    newr := inc - 'id' - 'household' - 'family' - 'admin' - 'passkey' - 'adminKey';
    select p.id, p.roster into pid, oldr from public.profiles p where p.slug = inc->>'id';
    if newr is distinct from (oldr - 'passkey' - 'adminKey') then
      if not adm and pid is distinct from me then raise exception 'mise_forbidden' using errcode = 'P0403'; end if;
      if private.guard_hit(newr, private.plate_audience(pid)) then raise exception 'mise_name_guard' using errcode = 'P0422'; end if;
      update public.profiles set roster = newr, updated_at = now() where id = pid;
      changed := true;
    end if;
  end loop;
  if changed then update public.roster_rev set rev = rev + 1 returning rev into v_rev; end if;
  return v_rev;
end $$;

-- F5: claim_guest, as B2 plus the guard on the guest's display fields for the
-- inviting house
create or replace function svc.claim_guest(p_code_hash text, p_slug text, p_roster jsonb, p_targets jsonb, p_until date)
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
  insert into public.profiles (slug, kind, roster) values (p_slug, 'guest', coalesce(p_roster, '{}'::jsonb) - 'id')
    returning id into pid;
  insert into public.guest_grants (guest_profile, host_household, until) values (pid, inv.host_household, p_until);
  insert into public.docs (path, data) values
    ('profiles/' || p_slug || '/profile/targets.json', p_targets),
    ('profiles/' || p_slug || '/fitness/targets.json', p_targets);
  -- the guest's status page lives 60 days (the Worker's INVITE_STATUS_TTL_MS; fix list item 12)
  update public.invites set used_at = now(), claimed_profile = pid, status_until = now() + interval '60 days'
   where code_hash = p_code_hash;
  update public.roster_rev set rev = rev + 1;
  return pid;
end $$;

-- The weekly probe counts roster rows too.
create or replace function svc.guard_hits() returns jsonb language sql stable security definer set search_path = '' as $$
select jsonb_build_object(
  'docs', (select count(*) from public.docs d
            where (d.kind = 'global' and private.guard_hit(d.data, null, private.guard_path(d.path)))
               or private.guard_hit(d.data, private.audience(d.kind, d.profile_id, d.household_id), private.guard_path(d.path))),
  'recipes', (select count(*) from public.recipes r where private.guard_hit(r.data, null, r.id)),
  'plates', (select count(*) from public.plates p where private.guard_hit(p.data, private.plate_audience(p.profile_id))),
  'roster', (select count(*) from public.profiles p where p.kind <> 'probe' and private.guard_hit(p.roster, private.plate_audience(p.id)))) $$;

-- F6: the private helpers authenticated may call, and nothing else. A later
-- file that adds a private function must not re-grant the whole schema.
revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function
  private.my_profile(), private.is_admin(), private.my_households(), private.housemates(), private.visible_guests(),
  private.can_write(text), private.patch_roster(jsonb, bigint), private.canonical_path(text)
  to authenticated;
-- Item 10: every svc function granted to service_role BY NAME (a schema-wide
-- grant covers only the functions that exist when it runs).
revoke execute on all functions in schema svc from public, anon, authenticated;
grant execute on function
  svc.entitled(uuid), svc.ai_count(uuid), svc.recipe_for(text, text), svc.recipe_names(text, text[]),
  svc.guest_summary(uuid), svc.slug_free(text), svc.claim_guest(text, text, jsonb, jsonb, date), svc.guard_hits(),
  svc.whoami(uuid), svc.cron_inputs(text, boolean), svc.mint_invite(uuid, text, text, timestamptz),
  svc.invite_get(text), svc.guest_login_add(uuid, text, text, text), svc.guest_login_row(text), svc.guest_view(text)
  to service_role;
revoke execute on function public.whoami() from public, anon;
grant execute on function public.whoami() to authenticated;
