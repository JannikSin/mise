-- Mise 2.0, db fix loop 1, blockers 1 and 2 (Red Team BLOCK on the db slice,
-- fleet note terrigen-db-fixlist-1.md). New functions and replacements only;
-- the earlier files are unchanged.
--
-- F1 (name guard bypass). The guard read lower(d::text), the SERIALIZED JSON,
-- where a newline is the two characters backslash and n: "\nName" glued into
-- one word, and plurals, lookalike letters, zero-width characters, accents and
-- a name split across two array strings all passed. Now it reads every
-- decoded string and every object key (plus adjacent array strings joined,
-- plus the path without its owner segment), folded by private.guard_fold, and
-- a term matches with an optional plural (s, es) and trailing digits. The JS
-- twin is tools/name-guard.mjs; tests/name-guard.test.js runs one corpus
-- through both.
--
-- F2 and F7 (allergens dropped). The plate followed the LAST targets row
-- written, so a stale mirror (or an admin's insert of one) emptied a person's
-- allergens on their plate card while the canonical file still held them. Now:
--   - the plate is made from the CANONICAL row (`.../profile/targets.json`)
--     whenever one exists, the mirror only when there is none;
--   - for a signed-in writer who is not the owner (the admin included), the
--     key-drop rule runs on INSERT as well as UPDATE, and the plate's safety
--     keys may only grow (private.safety_loosened);
--   - the root profile's slug-form paths (`profiles/<root>/profile/...`)
--     resolve to the root row (private.canonical_path), so there is never a
--     second canonical row.

-- ===== F1: what the guard reads

-- Fold: NFKD, drop combining marks and zero-width characters, map lookalikes
-- (tools/name-guard.mjs LOOKALIKES, same order), lowercase.
create function private.guard_fold(s text) returns text language sql immutable set search_path = '' as $$
select lower(translate(
  regexp_replace(normalize(coalesce(s, ''), nfkd), '[\u0300-\u036f\u200b-\u200d\u2060\ufeff\u00ad]', '', 'g'),
  'авеіјкмнорстухѕԁӏүһԛԝАВЕІЈКМНОРСТУХЅҮҺӀαβγεηικνορτυχωΑΒΕΖΗΙΚΜΝΟΡΤΥΧıłŁøØđĐß',
  'abeijkmhopctyxsdlyhqwabeijkmhopctyxsyhlabyenikvoptuxwabezhikmnoptyxilloodds')) $$;

-- The path the guard reads: the owner segment is an identity, not text.
create function private.guard_path(p text) returns text language sql immutable set search_path = '' as $$
select regexp_replace(coalesce(p, ''), '^(profiles|households)/[^/]+/', '') $$;

-- Every decoded string, every object key, each pair of adjacent strings in an
-- array joined with nothing, and `extra` (a path or an id), folded.
create function private.guard_text(d jsonb, extra text) returns text language sql stable set search_path = '' as $$
with v as (
  select x, row_number() over () as vid from jsonb_path_query(coalesce(d, 'null'::jsonb), 'strict $.**') x
)
select private.guard_fold(concat_ws(' ', extra,
  (select string_agg(v.x #>> '{}', ' ') from v where jsonb_typeof(v.x) = 'string'),
  (select string_agg(k, ' ') from v
     cross join lateral jsonb_object_keys(case when jsonb_typeof(v.x) = 'object' then v.x else '{}'::jsonb end) k),
  (select string_agg((p.e #>> '{}') || (p.nx #>> '{}'), ' ') from (
     select a.e, lead(a.e) over (partition by v.vid order by a.i) as nx
     from v cross join lateral jsonb_array_elements(case when jsonb_typeof(v.x) = 'array' then v.x else '[]'::jsonb end)
       with ordinality a(e, i)) p
   where jsonb_typeof(p.e) = 'string' and jsonb_typeof(p.nx) = 'string'))) $$;

create function private.guard_hit(d jsonb, houses uuid[], extra text) returns boolean
language sql stable security definer set search_path = '' as $$
with t as (select private.guard_text(d, extra) as s)
select exists (select 1 from t, private.guard_terms g
  where (houses is null or g.hidden_from = any (houses))
    and t.s ~ ('(^|[^a-z0-9])' || g.term || '(s|es)?[0-9]*([^a-z0-9]|$)')) $$;

create or replace function private.guard_hit(d jsonb, houses uuid[]) returns boolean
language sql stable security definer set search_path = '' as $$
select private.guard_hit(d, houses, null) $$;

-- ===== F2: one canonical row, safety keys only grow

-- profiles/<root>/X -> X for the paths the root profile keeps at the root.
create function private.canonical_path(p text) returns text language sql stable security definer set search_path = '' as $$
select case
  when p ~ '^profiles/[a-z0-9][a-z0-9-]*/(plans/[^/]+|profile/targets\.json|shopping\.json|occasions\.json|pantry\.json)$'
   and split_part(p, '/', 2) = (select s.value from private.settings s where s.key = 'root_profile')
  then regexp_replace(p, '^profiles/[^/]+/', '')
  else p end $$;

-- True when `nxt` is less strict than `prev` on any plate safety key
-- (app/lib/plate-fields.js PLATE_SAFETY_FIELDS): a diet less strict, an item
-- missing from allergens, avoidIngredients, avoidRecipes or
-- dislikeIngredients, a slot's slotAvoid item missing, or allergensFreeText
-- no longer containing the old text. Absent counts as empty, and an unknown
-- diet value as a change that is refused.
create function private.safety_loosened(prev jsonb, nxt jsonb) returns boolean language sql immutable set search_path = '' as $$
with rank(d, r) as (values ('omnivore', 0), ('pescatarian', 1), ('vegetarian', 2), ('vegan', 3)),
arr(k) as (values ('allergens'), ('avoidIngredients'), ('avoidRecipes'), ('dislikeIngredients'))
select
  -- diet
  (coalesce(prev->>'diet', 'omnivore') is distinct from coalesce(nxt->>'diet', 'omnivore')
   and coalesce((select r from rank where d = coalesce(nxt->>'diet', 'omnivore')), -1)
     < coalesce((select r from rank where d = coalesce(prev->>'diet', 'omnivore')), 99))
  -- the list keys: every old item still there
  or exists (select 1 from arr, jsonb_array_elements(case when jsonb_typeof(prev->arr.k) = 'array' then prev->arr.k else '[]'::jsonb end) e
     where not (case when jsonb_typeof(nxt->arr.k) = 'array' then nxt->arr.k else '[]'::jsonb end) @> jsonb_build_array(e))
  -- slotAvoid: per slot
  or exists (select 1 from jsonb_each(case when jsonb_typeof(prev->'slotAvoid') = 'object' then prev->'slotAvoid' else '{}'::jsonb end) s(slot, items),
       jsonb_array_elements(case when jsonb_typeof(s.items) = 'array' then s.items else '[]'::jsonb end) e
     where not (case when jsonb_typeof(nxt->'slotAvoid'->s.slot) = 'array' then nxt->'slotAvoid'->s.slot else '[]'::jsonb end) @> jsonb_build_array(e))
  -- free text: the old words stay
  or (coalesce(prev->>'allergensFreeText', '') <> ''
      and position(prev->>'allergensFreeText' in coalesce(nxt->>'allergensFreeText', '')) = 0) $$;

create or replace function private.docs_before() returns trigger language plpgsql security definer set search_path = '' as $$
declare s record; aud uuid[]; ref jsonb; gpath text;
begin
  if tg_op = 'INSERT' then
    new.path := private.canonical_path(new.path);
    s := private.doc_scope(new.path);
    new.kind := s.kind; new.profile_id := s.profile_id; new.household_id := s.household_id; new.rev := 1;
  else
    new.path := old.path; new.doc_id := old.doc_id; new.kind := old.kind;
    new.profile_id := old.profile_id; new.household_id := old.household_id;
    new.legacy_sha := old.legacy_sha; new.rev := old.rev + 1;
  end if;
  -- ENG L2-2, F2, F7: a signed-in writer who is not the owner (the admin
  -- included) may not drop a targets key, nor loosen a plate safety key, on
  -- an update or on an insert (compared with the person's canonical row, or
  -- their other targets row). Session-less writes (the migration, svc) are
  -- exempt.
  if new.kind = 'targets' and auth.uid() is not null and new.profile_id is distinct from private.my_profile() then
    if tg_op = 'UPDATE' then ref := old.data;
    else
      select d.data into ref from public.docs d
       where d.profile_id = new.profile_id and d.kind = 'targets'
       order by (d.path like '%profile/targets.json') desc limit 1;
    end if;
    if jsonb_typeof(ref) = 'object' and (
         exists (select 1 from jsonb_object_keys(ref) k where not (new.data ? k))
         or private.safety_loosened(ref, new.data)) then
      raise exception 'mise_forbidden' using errcode = 'P0403';
    end if;
  end if;
  gpath := private.guard_path(new.path);
  aud := private.audience(new.kind, new.profile_id, new.household_id);
  if (aud is not null and private.guard_hit(new.data, aud, gpath))
     or (new.kind = 'global' and private.guard_hit(new.data, null, gpath)) then
    raise exception 'mise_name_guard' using errcode = 'P0422';
  end if;
  new.updated_at := now(); new.updated_by := auth.uid();
  return new;
end $$;

create or replace function private.recipes_before() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if private.guard_hit(new.data, null, new.id) then raise exception 'mise_name_guard' using errcode = 'P0422'; end if;
  if tg_op = 'INSERT' then new.rev := 1;
  else new.rev := old.rev + 1; new.doc_id := old.doc_id; new.legacy_sha := old.legacy_sha; end if;
  new.updated_at := now(); new.updated_by := auth.uid();
  return new;
end $$;

-- The plate comes from the canonical row when there is one (F2), from the
-- written row only when the person has no canonical row (a mirror-only
-- profile still refreshes, item 13). Its legacy_sha is the canonical row's
-- while that row is unedited.
create or replace function private.targets_after() returns trigger language plpgsql security definer set search_path = '' as $$
declare c_data jsonb; c_sha text; c_rev bigint; v jsonb;
begin
  select d.data, d.legacy_sha, d.rev into c_data, c_sha, c_rev from public.docs d
   where d.profile_id = new.profile_id and d.kind = 'targets' and d.path like '%profile/targets.json'
   limit 1;
  v := private.plate_of(coalesce(c_data, new.data));
  if private.guard_hit(v, private.plate_audience(new.profile_id)) then
    raise exception 'mise_name_guard' using errcode = 'P0422';
  end if;
  insert into public.plates (profile_id, data, content_hash, legacy_sha)
    values (new.profile_id, v, '', case when c_rev = 1 then c_sha end)
    on conflict (profile_id) do update set data = excluded.data
    where public.plates.data is distinct from excluded.data;
  return null;
end $$;

-- The writer resolves the root slug-form path first, so an update by that
-- path finds the root row.
create or replace function public.write_doc(p_path text, p_data jsonb, p_expected_rev bigint)
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
    p_path := private.canonical_path(p_path);
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

-- The weekly probe's counts read the same way the triggers do (paths and ids
-- included).
create or replace function svc.guard_hits() returns jsonb language sql stable security definer set search_path = '' as $$
select jsonb_build_object(
  'docs', (select count(*) from public.docs d
            where (d.kind = 'global' and private.guard_hit(d.data, null, private.guard_path(d.path)))
               or private.guard_hit(d.data, private.audience(d.kind, d.profile_id, d.household_id), private.guard_path(d.path))),
  'recipes', (select count(*) from public.recipes r where private.guard_hit(r.data, null, r.id)),
  'plates', (select count(*) from public.plates p where private.guard_hit(p.data, private.plate_audience(p.profile_id)))) $$;

revoke execute on all functions in schema private, svc from public, anon;
grant execute on all functions in schema private to authenticated;   -- narrowed by the F6 file
grant execute on all functions in schema svc to service_role;
