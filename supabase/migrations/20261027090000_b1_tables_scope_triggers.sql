-- Mise 2.0, B1: tables, doc_scope, the policy helpers and the four triggers.
-- Plan: ~/.claude/fleet/schelkin-2.0-plan.md revision 3, section 4.2.
-- Apply the files in supabase/migrations/ in name order (SQL Editor, or
-- `supabase db push`). This file holds no person's name: the root profile's
-- slug is written into private.settings by tools/migrate-to-supabase.mjs.
--
-- Functions this file's triggers call that land in a later file (resolved when
-- the trigger fires, not when it is created): private.plate_of (B2).

create schema if not exists private;
create schema if not exists svc;                       -- exposed to the Data API for the Worker only
revoke all on schema private, svc from public;
grant usage on schema private to authenticated;
grant usage on schema svc to service_role;             -- authenticated and anon get NO usage on svc (RT N5)

alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges revoke execute on functions from public;
alter default privileges in schema public, private, svc revoke execute on functions from anon, authenticated;

create table private.settings (key text primary key, value text not null);
create table private.pending_links (email text primary key, profile_id uuid not null);

create table public.households (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9-]{1,40}$'),
  created_at timestamptz not null default now()
);

-- RT N4: a term may not appear in any row readable by members of hidden_from
create table private.guard_terms (
  term text not null check (term ~ '^[a-z0-9-]{2,40}$'),
  hidden_from uuid not null references public.households(id) on delete cascade,
  primary key (term, hidden_from)
);

create table public.profiles (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9-]{1,40}$'),
  user_id uuid unique references auth.users(id) on delete set null,
  kind text not null default 'member' check (kind in ('member', 'guest', 'probe')),   -- probe: hidden from roster() (RT N5)
  home_household uuid references public.households(id),
  family text,
  roster jsonb not null default '{}'::jsonb,
  entitled boolean not null default false,
  updated_at timestamptz not null default now()
);
create table public.memberships (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  household_id uuid not null references public.households(id) on delete cascade,
  primary key (profile_id, household_id)
);
create table public.admins (user_id uuid primary key references auth.users(id) on delete cascade);
create table public.roster_rev (one boolean primary key default true check (one), rev bigint not null default 1);
insert into public.roster_rev default values;

create table public.recipes (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9-]{0,150}$'),
  doc_id uuid not null unique default gen_random_uuid(),
  data jsonb not null check (data->>'id' = id),
  staging boolean not null default false,
  rev bigint not null default 1,
  legacy_sha text,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

create table public.docs (
  path text primary key,
  doc_id uuid not null unique default gen_random_uuid(),
  kind text not null,
  profile_id uuid references public.profiles(id) on delete cascade,
  household_id uuid references public.households(id) on delete cascade,
  data jsonb not null,
  rev bigint not null default 1,
  legacy_sha text,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid(),
  check (num_nonnulls(profile_id, household_id) <= 1)
);
create index docs_profile on public.docs (profile_id);
create index docs_household on public.docs (household_id);

create table public.plates (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  data jsonb not null,
  rev bigint not null default 1,
  content_hash text not null,
  legacy_sha text                                  -- the canonical targets file's git sha at migration (item 3)
);

create table public.guest_grants (
  guest_profile uuid not null references public.profiles(id) on delete cascade,
  host_household uuid not null references public.households(id) on delete cascade,
  until date not null,
  primary key (guest_profile, host_household)
);
create table public.invites (
  code_hash text primary key,
  kind text not null default 'guest' check (kind = 'guest'),
  host_household uuid not null references public.households(id),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  claimed_profile uuid references public.profiles(id),
  status_until timestamptz
);
create table public.guest_logins (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  name_key text not null unique, salt text not null, hash text not null,
  created_at timestamptz not null default now()
);
create table public.ai_usage (user_id uuid not null, day date not null, calls int not null default 0, primary key (user_id, day));

-- Row level security on every client-reachable table. With no policy a table
-- is closed; the policies and the column grants arrive in the B2 file.
alter table public.households  enable row level security;   -- no policies, no grants (roster() only)
alter table public.profiles    enable row level security;
alter table public.memberships enable row level security;
alter table public.admins      enable row level security;
alter table public.roster_rev  enable row level security;
alter table public.guest_grants enable row level security;
alter table public.invites     enable row level security;
alter table public.guest_logins enable row level security;
alter table public.ai_usage    enable row level security;
alter table public.recipes     enable row level security;
alter table public.docs        enable row level security;
alter table public.plates      enable row level security;
revoke all on all tables in schema public from anon, authenticated;
revoke all on all tables in schema private from public, anon, authenticated;

-- Path to row. Mirrored in JS by app/lib/doc-scope.js (tests/doc-scope.test.js
-- runs both on one path list). House specials have opaque ids and the house is
-- bound by the path (item 7). `pantry-notes` is a house file 1.95 writes
-- (app/main.js, scan.js) that the plan's list did not name.
create function private.doc_scope(p text, out kind text, out profile_id uuid, out household_id uuid)
language plpgsql stable security definer set search_path = '' as $$
declare m text[]; rest text; owner_slug text;
  seg constant text := '[a-z0-9][a-z0-9-]{0,80}';
begin
  if p is null or p !~ '^[A-Za-z0-9][A-Za-z0-9/_.-]{0,200}\.json$' or p ~ '\.\.|//' then raise exception 'mise_bad_path'; end if;
  m := regexp_match(p, '^households/(' || seg || ')/(events|ledger|pantry|pantry-notes|waste|household|prices|pins)\.json$');
  if m is not null then
    select h.id into household_id from public.households h where h.slug = m[1];
    if household_id is null then raise exception 'mise_bad_path'; end if;
    kind := m[2]; return;
  end if;
  m := regexp_match(p, '^households/(' || seg || ')/recipes/(house-[0-9a-f]{12})\.json$');   -- item 7: opaque id
  if m is not null then
    select h.id into household_id from public.households h where h.slug = m[1];
    if household_id is null then raise exception 'mise_bad_path'; end if;
    kind := 'house_recipe'; return;
  end if;
  if p ~ ('^philosophies/' || seg || '\.json$') then kind := 'global'; return; end if;
  m := regexp_match(p, '^profiles/(' || seg || ')/(.+)$');
  if m is not null then owner_slug := m[1]; rest := m[2];
  elsif p ~ '^(fitness|health)/' then raise exception 'mise_bad_path';
  elsif p ~ '^(plans/|profile/|shopping\.json$|occasions\.json$|pantry\.json$)' then
    select s.value into owner_slug from private.settings s where s.key = 'root_profile'; rest := p;
  else raise exception 'mise_bad_path'; end if;
  select pr.id into profile_id from public.profiles pr where pr.slug = owner_slug;
  if profile_id is null then raise exception 'mise_bad_path'; end if;
  kind := case
    when rest in ('profile/targets.json', 'fitness/targets.json') then 'targets'
    when rest ~ '^(fitness|health)/' then 'health'
    when rest ~ '^plans/[0-9]{4}-W[0-9]{2}\.json$' then 'plan'
    when rest = 'shopping.json' then 'shopping'
    when rest = 'occasions.json' then 'occasions'
    when rest = 'pantry.json' then 'pantry'
    when rest ~ ('^recipes/' || seg || '\.json$') then 'own_recipe'
  end;
  if kind is null then raise exception 'mise_bad_path'; end if;
end $$;

-- Helpers, used inside policies as (select ...).
create function private.my_profile() returns uuid language sql stable security definer set search_path = '' as
$$ select id from public.profiles where user_id = auth.uid() $$;
create function private.is_admin() returns boolean language sql stable security definer set search_path = '' as
$$ select exists (select 1 from public.admins where user_id = auth.uid()) $$;
create function private.my_households() returns uuid[] language sql stable security definer set search_path = '' as
$$ select coalesce(array_agg(m.household_id), '{}') from public.memberships m
   join public.profiles p on p.id = m.profile_id where p.user_id = auth.uid() $$;
create function private.houses_of(pid uuid) returns uuid[] language sql stable security definer set search_path = '' as
$$ select coalesce(array_agg(household_id), '{}') from public.memberships where profile_id = pid $$;
create function private.housemates() returns uuid[] language sql stable security definer set search_path = '' as
$$ select coalesce(array_agg(distinct b.profile_id), '{}') from public.memberships a
   join public.memberships b using (household_id) where a.profile_id = (select private.my_profile()) $$;
create function private.visible_guests() returns uuid[] language sql stable security definer set search_path = '' as
$$ select coalesce(array_agg(g.guest_profile), '{}') from public.guest_grants g
   where g.until >= current_date and g.host_household = any ((select private.my_households())::uuid[]) $$;

-- Whole-word, audience-aware name guard (ENG 4, RT N4). houses = null means
-- "everyone" (the bank, the global files): every term applies.
create function private.guard_hit(d jsonb, houses uuid[]) returns boolean language sql stable security definer set search_path = '' as
$$ select exists (select 1 from private.guard_terms g
     where (houses is null or g.hidden_from = any (houses))
       and lower(d::text) ~ ('(^|[^a-z0-9])' || g.term || '([^a-z0-9]|$)')) $$;

-- Who can read a docs row, as an array of households (for the guard).
-- null = owner or admin only (targets, health) or everyone (global); the
-- trigger treats global as everyone.
create function private.audience(s_kind text, s_profile uuid, s_house uuid) returns uuid[] language sql stable security definer set search_path = '' as
$$ select case
     when s_house is not null then array[s_house]
     when s_kind in ('plan','shopping','occasions','pantry','own_recipe') then private.houses_of(s_profile)
     else null end $$;

-- The houses that can read a person's plate: their own houses, plus every
-- house that holds a guest grant for them (a guest belongs to no house).
create function private.plate_audience(pid uuid) returns uuid[] language sql stable security definer set search_path = '' as
$$ select private.houses_of(pid) || coalesce((select array_agg(g.host_household) from public.guest_grants g
     where g.guest_profile = pid), '{}') $$;

-- Triggers: rev bumps on docs, recipes and plates (item 10); plates from either
-- targets path (item 13). They fire for every role, service_role and the
-- migration included (item 8).
create function private.docs_before() returns trigger language plpgsql security definer set search_path = '' as $$
declare s record; aud uuid[];
begin
  if tg_op = 'INSERT' then
    s := private.doc_scope(new.path);
    new.kind := s.kind; new.profile_id := s.profile_id; new.household_id := s.household_id; new.rev := 1;
  else
    new.path := old.path; new.doc_id := old.doc_id; new.kind := old.kind;
    new.profile_id := old.profile_id; new.household_id := old.household_id;
    new.legacy_sha := old.legacy_sha; new.rev := old.rev + 1;
    -- ENG L2-2: only the owner may drop keys from a targets row. Enforced here,
    -- not only in write_doc, so a direct table write cannot bypass it. A
    -- session-less write (the migration, svc) is exempt.
    if new.kind = 'targets' and auth.uid() is not null
       and new.profile_id is distinct from private.my_profile()
       and exists (select 1 from jsonb_object_keys(old.data) k where not (new.data ? k)) then
      raise exception 'mise_forbidden' using errcode = 'P0403';
    end if;
  end if;
  aud := private.audience(new.kind, new.profile_id, new.household_id);
  if (aud is not null and private.guard_hit(new.data, aud))
     or (new.kind = 'global' and private.guard_hit(new.data, null)) then
    raise exception 'mise_name_guard' using errcode = 'P0422';
  end if;
  new.updated_at := now(); new.updated_by := auth.uid();
  return new;
end $$;
create trigger docs_before before insert or update on public.docs for each row execute function private.docs_before();

create function private.recipes_before() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if private.guard_hit(new.data, null) then raise exception 'mise_name_guard' using errcode = 'P0422'; end if;
  if tg_op = 'INSERT' then new.rev := 1;
  else new.rev := old.rev + 1; new.doc_id := old.doc_id; new.legacy_sha := old.legacy_sha; end if;
  new.updated_at := now(); new.updated_by := auth.uid();
  return new;
end $$;
create trigger recipes_before before insert or update on public.recipes for each row execute function private.recipes_before();

create function private.plates_before() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.content_hash := md5(new.data::text);
  if tg_op = 'INSERT' then new.rev := 1;
  else new.rev := old.rev + 1; new.legacy_sha := old.legacy_sha; end if;
  return new;
end $$;
create trigger plates_before before insert or update on public.plates for each row execute function private.plates_before();

-- Any targets write (canonical OR mirror, by a phone OR by svc or the
-- migration) refreshes the plate; an unchanged projection does not bump the
-- plate (no false "inputs changed").
create function private.targets_after() returns trigger language plpgsql security definer set search_path = '' as $$
declare v jsonb := private.plate_of(new.data);
begin
  if private.guard_hit(v, private.plate_audience(new.profile_id)) then
    raise exception 'mise_name_guard' using errcode = 'P0422';
  end if;
  insert into public.plates (profile_id, data, content_hash, legacy_sha)
    values (new.profile_id, v, '', case when new.path like '%profile/targets.json' and new.rev = 1 then new.legacy_sha end)
    on conflict (profile_id) do update set data = excluded.data
    where public.plates.data is distinct from excluded.data;
  return null;
end $$;
create trigger targets_after after insert or update on public.docs
  for each row when (new.kind = 'targets') execute function private.targets_after();

revoke execute on all functions in schema private, svc from public, anon;
grant execute on all functions in schema private to authenticated;
