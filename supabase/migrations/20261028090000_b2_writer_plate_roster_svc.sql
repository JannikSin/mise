-- Mise 2.0, B2: the plate projection, the writer, the roster, the Worker's svc
-- functions, and the row level security policies with their grants.
-- Plan: ~/.claude/fleet/schelkin-2.0-plan.md revision 3, sections 4.1 and 4.2.
--
-- WHO SEES WHAT (David's decision 1, 2026-10-27): plate cards for everyone,
-- the family house included; full profiles for the admin only. So a `targets`
-- or `health` row is readable by its owner and the admin and nobody else, in
-- every house; housemates and live guests' hosts read the `plates` row.

-- The roster keeps the order of the old profiles.json.
alter table public.profiles add column sort_order int not null default 0;

-- The plate card: exactly app/lib/plate-fields.js PLATE_FIELDS (checked by
-- tests/plate-allowlist.test.js), currencies items cut to PLATE_CURRENCY_KEYS,
-- notes stripped from object items of mealSlots, macros.waterLiters dropped.
-- app/lib/plate-of.js is the JS port (tests/plate-of.test.js).
create function private.plate_of(t jsonb) returns jsonb language sql immutable set search_path = '' as $$
select coalesce(jsonb_object_agg(e.key, case
    when e.key = 'macros' and jsonb_typeof(e.value) = 'object' then e.value - 'waterLiters'
    when e.key = 'currencies' and jsonb_typeof(e.value) = 'array' then (
      select coalesce(jsonb_agg(case when jsonb_typeof(c) = 'object' then (
          select coalesce(jsonb_object_agg(ck, cv), '{}'::jsonb) from jsonb_each(c) x(ck, cv)
           where ck in ('id', 'unit', 'perWeek', 'expires', 'venue', 'toGo', 'preferredSlot', 'estCalories', 'estProtein'))
        else c end order by ord), '[]'::jsonb)
      from jsonb_array_elements(e.value) with ordinality a(c, ord))
    when e.key = 'mealSlots' and jsonb_typeof(e.value) = 'array' then (
      select coalesce(jsonb_agg(case when jsonb_typeof(s) = 'object' then s - 'note' - 'notes' else s end
        order by ord), '[]'::jsonb)
      from jsonb_array_elements(e.value) with ordinality a(s, ord))
    else e.value end), '{}'::jsonb)
from jsonb_each(case when jsonb_typeof(t) = 'object' then t else '{}'::jsonb end) e
where e.key in (
  -- PLATE_FIELDS
  'diet', 'allergens', 'allergensFreeText', 'avoidIngredients', 'avoidRecipes',
  'dislikeIngredients', 'cuisinePrefs', 'fixedSlots', 'skipSlots', 'mealSlots',
  'slotAvoid', 'breakfastStyle', 'snackStyle', 'snackPortable', 'dinnerAnchor',
  'phase', 'weeklyBudgetUsd', 'macros', 'currencies'
  -- end PLATE_FIELDS
) $$;

create function private.can_write(p text) returns boolean language plpgsql stable security definer set search_path = '' as $$
declare s record; begin
  s := private.doc_scope(p);
  -- coalesce: a null owner compares to null, and `not null` would let the
  -- writer's refusal fall through to a misleading conflict (plan SQL fix)
  return coalesce(private.is_admin()
      or (s.household_id is not null and s.household_id = any (private.my_households()))
      or (s.profile_id = private.my_profile())
      or (s.kind in ('plan','shopping','occasions') and s.profile_id = any (private.housemates())), false);
exception when others then return false; end $$;

-- The roster, as the caller may see it (RT N2):
--   {profiles: [{id, roster, household, family, admin}], rev}
-- `roster` is the stored display fields (name, emoji, phase...), the shape the
-- seam lane's adapter flattens back into a 1.95 profiles.json entry.
-- A row is visible to the admin, to its owner, to housemates and, for a guest,
-- to the houses holding a live grant. `household` is the home house's slug only
-- for the admin or a member of that house, else JSON null (hidden, NOT "home").
-- `family` only for the admin or a member of the house whose slug equals it.
-- Probe rows never appear. Old passkey hashes are never returned.
create function public.roster() returns jsonb language sql stable security definer set search_path = '' as $$
select jsonb_build_object(
  'profiles', coalesce(jsonb_agg(r.obj order by r.sort_order, r.slug), '[]'::jsonb),
  'rev', (select rev from public.roster_rev))
from (
  select p.slug, p.sort_order,
    jsonb_build_object(
         'id', p.slug,
         'roster', p.roster - 'id' - 'household' - 'family' - 'admin' - 'passkey' - 'adminKey',
         'household', case when (select private.is_admin()) or p.home_household = any ((select private.my_households())::uuid[])
                           then h.slug end,
         'family', case when (select private.is_admin())
                          or exists (select 1 from public.households fh
                                     where fh.slug = p.family and fh.id = any ((select private.my_households())::uuid[]))
                        then p.family end,
         'admin', exists (select 1 from public.admins a where a.user_id = p.user_id)) as obj
  from public.profiles p left join public.households h on h.id = p.home_household
  where p.kind <> 'probe'
    and ((select private.is_admin()) or p.id = (select private.my_profile())
         or p.id = any ((select private.housemates())::uuid[]) or p.id = any ((select private.visible_guests())::uuid[]))
) r $$;

-- profiles.json writes, in the 1.95 shape {profiles: [{id, ...display fields,
-- household?, family?, admin?}]}. Diffs only the rows roster() returns to the
-- caller. An absent household or family equals a hidden (null) one.
-- Only the display fields (the `roster` jsonb) change here: a new row, a
-- house, a family or an admin flag is refused (members come only from
-- tools/add-member.mjs, B4). A non-admin may change only their own row. A row
-- left out of the write is left as it is. Passkey hashes are not stored.
create function private.patch_roster(p_data jsonb, p_expected_rev bigint) returns bigint
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
      update public.profiles set roster = newr, updated_at = now() where id = pid;
      changed := true;
    end if;
  end loop;
  if changed then update public.roster_rev set rev = rev + 1 returning rev into v_rev; end if;
  return v_rev;
end $$;

-- The writer (ENG 2, ENG L2-2). Writes are a subset of reads, so every P0409
-- is a genuine conflict. P0403 (forbidden) and P0422 (name guard) are uniform:
-- the same answer whatever the reason. The partial-targets rule is enforced by
-- the docs_before trigger (B1), so it holds here and for direct table writes.
create function public.write_doc(p_path text, p_data jsonb, p_expected_rev bigint)
returns bigint language plpgsql security invoker set search_path = '' as $$
declare v_rev bigint; m text[];
begin
  if p_path = 'profiles.json' then return private.patch_roster(p_data, p_expected_rev); end if;
  m := regexp_match(p_path, '^(recipes|recipes-staging)/([a-z0-9][a-z0-9-]*)\.json$');
  if m is not null then
    if not private.is_admin() then raise exception 'mise_forbidden' using errcode = 'P0403'; end if;
    if p_expected_rev is null then
      insert into public.recipes (id, data, staging) values (m[2], p_data, m[1] = 'recipes-staging')
        on conflict (id) do nothing returning rev into v_rev;
    else
      update public.recipes set data = p_data, staging = (m[1] = 'recipes-staging')
        where id = m[2] and rev = p_expected_rev returning rev into v_rev;
    end if;
  else
    if not private.can_write(p_path) then raise exception 'mise_forbidden' using errcode = 'P0403'; end if;
    if p_expected_rev is null then
      insert into public.docs (path, data) values (p_path, p_data) on conflict (path) do nothing returning rev into v_rev;
    else
      update public.docs set data = p_data where path = p_path and rev = p_expected_rev returning rev into v_rev;
    end if;
  end if;
  if v_rev is null then raise exception 'mise_conflict' using errcode = 'P0409'; end if;
  return v_rev;
end $$;

-- One person's plate card by slug, under exactly plates_read's rules; null
-- when the caller may not see it (or there is none). The seam lane reads
-- plates through this by slug. (Fix loop 1, F9: clients DO see profile and
-- household uuids on the docs rows they may read; this RPC exists so the app
-- never has to map a slug to a uuid, not because uuids are hidden.)
create function public.plate_for(p_slug text) returns jsonb language sql stable security definer set search_path = '' as $$
select jsonb_build_object('data', pl.data, 'rev', pl.rev, 'content_hash', pl.content_hash, 'legacy_sha', pl.legacy_sha)
from public.plates pl join public.profiles p on p.id = pl.profile_id
where p.slug = p_slug
  and ((select private.is_admin()) or pl.profile_id = (select private.my_profile())
       or pl.profile_id = any ((select private.housemates())::uuid[]) or pl.profile_id = any ((select private.visible_guests())::uuid[])) $$;

-- ===== svc: the Worker's typed reads and writes (ENG L2-5). service_role only.

-- Entitlement (B1 of the 7/17 design): a signed-in account may use the AI
-- routes only when its profile is entitled or it is the admin. Probes never.
create function svc.entitled(p_sub uuid) returns boolean language sql stable security definer set search_path = '' as $$
select exists (select 1 from public.profiles p where p.user_id = p_sub and p.kind <> 'probe'
               and (p.entitled or exists (select 1 from public.admins a where a.user_id = p_sub))) $$;

-- One AI call counted against today's quota; returns today's count.
create function svc.ai_count(p_sub uuid) returns int language sql volatile security definer set search_path = '' as $$
insert into public.ai_usage (user_id, day, calls) values (p_sub, current_date, 1)
  on conflict (user_id, day) do update set calls = public.ai_usage.calls + 1
returning calls $$;

-- A recipe for a guest's meal: a house special of p_house when the id is an
-- opaque house id, else a non-staging bank recipe; null otherwise.
create function svc.recipe_for(p_house text, p_id text) returns jsonb language sql stable security definer set search_path = '' as $$
select case when p_id ~ '^house-[0-9a-f]{12}$'
  then (select d.data from public.docs d where d.path = 'households/' || p_house || '/recipes/' || p_id || '.json'
          and d.kind = 'house_recipe')
  else (select r.data from public.recipes r where r.id = p_id and not r.staging) end $$;

-- Dish names for the cron: {id: name} for the ids that resolve.
create function svc.recipe_names(p_house text, p_ids text[]) returns jsonb language sql stable security definer set search_path = '' as $$
select coalesce(jsonb_object_agg(i, svc.recipe_for(p_house, i)->>'name')
                filter (where svc.recipe_for(p_house, i)->>'name' is not null), '{}'::jsonb)
from unnest(p_ids) i $$;

-- /guest/me: the guest's own targets (the guest is the owner, so the full row;
-- the Worker trims it with guestProfileSummary). Guests only.
create function svc.guest_summary(p_profile uuid) returns jsonb language sql stable security definer set search_path = '' as $$
select coalesce(
  (select d.data from public.docs d join public.profiles p on p.id = d.profile_id
    where p.id = p_profile and p.kind = 'guest' and d.path = 'profiles/' || p.slug || '/profile/targets.json'),
  (select d.data from public.docs d join public.profiles p on p.id = d.profile_id
    where p.id = p_profile and p.kind = 'guest' and d.path = 'profiles/' || p.slug || '/fitness/targets.json')) $$;

-- /invite/claim: true only for a well-formed slug with no profiles row and no
-- docs row under profiles/<slug>/.
create function svc.slug_free(p_slug text) returns boolean language sql stable security definer set search_path = '' as $$
select p_slug ~ '^[a-z0-9][a-z0-9-]{0,39}$'
   and not exists (select 1 from public.profiles where slug = p_slug)
   and not exists (select 1 from public.docs where starts_with(path, 'profiles/' || p_slug || '/')) $$;

-- /invite/claim: spend an unused, unexpired guest invite and create the guest:
-- profile, grant to the inviting house until p_until, and both targets rows
-- (the plate trigger fires on them). Returns the new profile id.
create function svc.claim_guest(p_code_hash text, p_slug text, p_roster jsonb, p_targets jsonb, p_until date)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare inv record; pid uuid;
begin
  select * into inv from public.invites where code_hash = p_code_hash for update;
  if inv is null or inv.used_at is not null or inv.expires_at <= now() then
    raise exception 'mise_invite_invalid' using errcode = 'P0403';
  end if;
  if not svc.slug_free(p_slug) then raise exception 'mise_conflict' using errcode = 'P0409'; end if;
  insert into public.profiles (slug, kind, roster) values (p_slug, 'guest', coalesce(p_roster, '{}'::jsonb) - 'id')
    returning id into pid;
  insert into public.guest_grants (guest_profile, host_household, until) values (pid, inv.host_household, p_until);
  insert into public.docs (path, data) values
    ('profiles/' || p_slug || '/profile/targets.json', p_targets),
    ('profiles/' || p_slug || '/fitness/targets.json', p_targets);
  update public.invites set used_at = now(), claimed_profile = pid where code_hash = p_code_hash;
  update public.roster_rev set rev = rev + 1;
  return pid;
end $$;

-- The weekly probe (tools/probe-reach.mjs): how many rows carry a guarded
-- term where its audience can read it. Counts only, never a name.
create function svc.guard_hits() returns jsonb language sql stable security definer set search_path = '' as $$
select jsonb_build_object(
  'docs', (select count(*) from public.docs d
            where (d.kind = 'global' and private.guard_hit(d.data, null))
               or private.guard_hit(d.data, private.audience(d.kind, d.profile_id, d.household_id))),
  'recipes', (select count(*) from public.recipes r where private.guard_hit(r.data, null)),
  'plates', (select count(*) from public.plates p where private.guard_hit(p.data, private.plate_audience(p.profile_id)))) $$;

-- ===== Row level security policies.

create policy docs_read on public.docs for select to authenticated using (
  (select private.is_admin())
  or household_id = any ((select private.my_households())::uuid[])
  or profile_id = (select private.my_profile())
  or (kind in ('plan','shopping','occasions','pantry','own_recipe') and profile_id = any ((select private.housemates())::uuid[]))
  or kind = 'global'
);   -- targets and health: owner or admin only, in every house (decision 1)
create policy docs_insert on public.docs for insert to authenticated with check ((select private.can_write(path)));
create policy docs_update on public.docs for update to authenticated
  using ((select private.can_write(path))) with check ((select private.can_write(path)));

-- plate cards: the admin, the owner, everyone sharing a house with them (the
-- family house included, decision 1), and the hosts of a live guest grant
create policy plates_read on public.plates for select to authenticated using (
  (select private.is_admin()) or profile_id = (select private.my_profile())
  or profile_id = any ((select private.housemates())::uuid[]) or profile_id = any ((select private.visible_guests())::uuid[]));

create policy bank_read  on public.recipes for select to authenticated using (not staging or (select private.is_admin()));
create policy bank_write on public.recipes for insert to authenticated with check ((select private.is_admin()));
create policy bank_edit  on public.recipes for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));

revoke all on all tables in schema public from anon, authenticated;
grant select on public.docs, public.recipes, public.plates to authenticated;
grant insert (path, data) on public.docs to authenticated;
grant update (data) on public.docs to authenticated;
grant insert (id, data, staging) on public.recipes to authenticated;
grant update (data, staging) on public.recipes to authenticated;

revoke execute on all functions in schema public, private, svc from public, anon;
revoke execute on all functions in schema svc from authenticated;
revoke execute on all functions in schema public from authenticated;
grant execute on all functions in schema private to authenticated;
grant execute on function public.write_doc(text, jsonb, bigint), public.roster(), public.plate_for(text) to authenticated;
grant execute on all functions in schema svc to service_role;
